import { redis } from '@devvit/redis';
import { reddit } from '@devvit/web/server';

export type SubmittedUserComment = {
    id?: string;
    url?: string;
    authorName?: string;
};

export type UserCommentRecord = {
    commentId?: string;
    commentUrl?: string;
    commentText: string;
    username: string;
    createdAt: string;
    postedAt?: string;
    authorName?: string;
};

export type UserCommentOutcome =
    | { status: 'already'; record: UserCommentRecord }
    | { status: 'posted'; record: UserCommentRecord }
    | { status: 'posted_without_link'; record: UserCommentRecord }
    | { status: 'unconfirmed' }
    | { status: 'lock_lost' };

const COMMENT_WALK_LIMIT = 100;
const COMMENT_WALK_PAGE_SIZE = 25;

// Reddit reports comment times in whole seconds.
const COMMENT_CLOCK_SLACK_MS = 1000;

// Other errors may have posted the comment.
const REFUSAL_MESSAGES = [
    'this user account is not valid',
    'failed to mint',
];

function refusedBeforePosting(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return REFUSAL_MESSAGES.some((refusal) => message.toLowerCase().includes(refusal));
}

export async function readUserCommentRecord(key: string): Promise<UserCommentRecord | null> {
    return parseUserCommentRecord(await redis.get(key));
}

export function parseUserCommentRecord(raw: string | null): UserCommentRecord | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<UserCommentRecord>;
        if (typeof parsed?.commentText !== 'string' || typeof parsed?.username !== 'string') {
            return null;
        }
        return {
            ...parsed,
            createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
        } as UserCommentRecord;
    } catch {
        return null;
    }
}

export async function writeUserCommentRecord(
    key: string,
    ttlSeconds: number,
    record: UserCommentRecord,
): Promise<void> {
    await redis.set(key, JSON.stringify(record), {
        expiration: new Date(Date.now() + ttlSeconds * 1000),
    });
}

function createdAtMs(comment: { createdAt?: unknown }): number {
    const createdAt = comment.createdAt;
    if (createdAt instanceof Date) return createdAt.getTime();
    if (typeof createdAt === 'string' || typeof createdAt === 'number') {
        return new Date(createdAt).getTime();
    }
    return NaN;
}

async function findPostedComment({
    postId,
    parentId,
    username,
    text,
    sinceMs,
}: {
    postId: `t3_${string}`;
    parentId?: `t1_${string}`;
    username: string;
    text: string;
    sinceMs: number;
}): Promise<
    { status: 'found'; comment: SubmittedUserComment } | { status: 'absent' } | { status: 'unknown' }
> {
    let comments;
    try {
        const listing = await reddit.getComments({
            postId,
            commentId: parentId,
            sort: 'new',
            limit: COMMENT_WALK_LIMIT,
            pageSize: COMMENT_WALK_PAGE_SIZE,
        });
        comments = await listing.all();
    } catch (error) {
        console.error('A comment thread could not be read:', error);
        return { status: 'unknown' };
    }
    const author = username.trim().toLowerCase();
    const wanted = text.trim();
    const bound = sinceMs - COMMENT_CLOCK_SLACK_MS;
    const found = comments.find((comment) => (
        comment.authorName?.trim().toLowerCase() === author
        && comment.body?.trim() === wanted
        && createdAtMs(comment) >= bound
    ));
    if (found) return { status: 'found', comment: found };
    const walkedPastTheClaim = comments.some((comment) => createdAtMs(comment) < bound);
    if (walkedPastTheClaim || comments.length < COMMENT_WALK_LIMIT) return { status: 'absent' };
    return { status: 'unknown' };
}

function isUserCommentId(value: unknown): value is `t1_${string}` {
    return typeof value === 'string' && value.startsWith('t1_');
}

function sameAuthor(one: string, other: string): boolean {
    return one.trim().toLowerCase() === other.trim().toLowerCase();
}

async function recordPublication({
    key,
    ttlSeconds,
    claim,
    comment,
    fallbackCommentUrl,
}: {
    key: string;
    ttlSeconds: number;
    claim: UserCommentRecord;
    comment: SubmittedUserComment;
    fallbackCommentUrl?: string;
}): Promise<UserCommentRecord> {
    const authorName = typeof comment?.authorName === 'string' ? comment.authorName : '';
    const published: UserCommentRecord = {
        ...claim,
        postedAt: new Date().toISOString(),
        authorName,
    };
    const commentId = comment?.id;
    if (isUserCommentId(commentId) && sameAuthor(authorName, claim.username)) {
        published.commentId = commentId;
        published.commentUrl = typeof comment?.url === 'string' ? comment.url : fallbackCommentUrl;
    }
    await writeUserCommentRecord(key, ttlSeconds, published).catch((error: unknown) => {
        console.error('A posted comment could not be recorded:', error);
    });
    return published;
}

function publicationOutcome(record: UserCommentRecord): UserCommentOutcome {
    return record.commentId
        ? { status: 'posted', record }
        : { status: 'posted_without_link', record };
}

// Reddit may post and still throw.
export async function submitUserComment({
    postId,
    parentId,
    username,
    text,
    record,
    fallbackCommentUrl,
    confirmOwnership,
}: {
    postId: `t3_${string}`;
    parentId?: `t1_${string}`;
    username: string;
    text: string;
    record: { key: string; ttlSeconds: number; stored: UserCommentRecord | null };
    fallbackCommentUrl?: string;
    confirmOwnership: () => Promise<boolean>;
}): Promise<UserCommentOutcome> {
    const stored = record.stored;
    if (stored?.commentId) return { status: 'already', record: stored };
    if (stored?.postedAt) {
        const live = await findPostedComment({
            postId,
            parentId,
            username,
            text: stored.commentText,
            sinceMs: Date.parse(stored.createdAt) || 0,
        });
        if (live.status === 'found' && isUserCommentId(live.comment.id)) {
            const completed: UserCommentRecord = {
                ...stored,
                commentId: live.comment.id,
                commentUrl: typeof live.comment.url === 'string'
                    ? live.comment.url
                    : fallbackCommentUrl,
            };
            await writeUserCommentRecord(record.key, record.ttlSeconds, completed)
                .catch((error: unknown) => {
                    console.error('A live comment could not be recorded:', error);
                });
            return { status: 'already', record: completed };
        }
        return { status: 'posted_without_link', record: stored };
    }
    if (stored) {
        const earlier = await findPostedComment({
            postId,
            parentId,
            username,
            text: stored.commentText,
            sinceMs: Date.parse(stored.createdAt) || 0,
        });
        if (earlier.status === 'unknown') return { status: 'unconfirmed' };
        if (earlier.status === 'found') {
            const live: UserCommentRecord = {
                ...stored,
                commentId: earlier.comment.id,
                commentUrl: earlier.comment.url,
            };
            await writeUserCommentRecord(record.key, record.ttlSeconds, live)
                .catch((error: unknown) => {
                    console.error('A live comment could not be recorded:', error);
                });
            return { status: 'already', record: live };
        }
    }
    if (!await confirmOwnership()) return { status: 'lock_lost' };
    const claimedAt = new Date();
    const claim: UserCommentRecord = {
        commentText: text,
        username,
        createdAt: claimedAt.toISOString(),
    };
    await writeUserCommentRecord(record.key, record.ttlSeconds, claim);
    try {
        const comment = await reddit.submitComment({ id: parentId ?? postId, text, runAs: 'USER' });
        const authorName = typeof comment?.authorName === 'string' ? comment.authorName : '';
        if (authorName.trim() && !sameAuthor(authorName, username)) {
            const remove = (comment as { delete?: () => Promise<void> }).delete;
            if (typeof remove === 'function') {
                try {
                    await remove.call(comment);
                    await redis.del(record.key).catch((error: unknown) => {
                        console.error('A refused comment could not clear its record:', error);
                    });
                    return {
                        status: 'posted_without_link',
                        record: { ...claim, authorName },
                    };
                } catch (error) {
                    console.error('A comment posted under another name could not be removed:', error);
                }
            }
        }
        return publicationOutcome(await recordPublication({
            key: record.key,
            ttlSeconds: record.ttlSeconds,
            claim,
            comment,
            fallbackCommentUrl,
        }));
    } catch (submitError) {
        if (refusedBeforePosting(submitError)) {
            await redis.del(record.key).catch((error: unknown) => {
                console.error('A refused comment could not clear its record:', error);
            });
            throw submitError;
        }
        const posted = await findPostedComment({
            postId,
            parentId,
            username,
            text,
            sinceMs: claimedAt.getTime(),
        });
        if (posted.status === 'found') {
            console.warn('Comment submit failed, but the comment is live:', submitError);
            return publicationOutcome(await recordPublication({
                key: record.key,
                ttlSeconds: record.ttlSeconds,
                claim,
                comment: posted.comment,
                fallbackCommentUrl,
            }));
        }
        console.error('Comment submit failed and the thread shows no comment from it:', submitError);
        return { status: 'unconfirmed' };
    }
}
