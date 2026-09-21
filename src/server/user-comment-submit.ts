import { redis } from '@devvit/redis';
import { reddit } from '@devvit/web/server';

export type SubmittedUserComment = {
    id?: string;
    url?: string;
    authorName?: string;
};

// No link and no `postedAt` means the next attempt walks the thread.
export type UserCommentRecord = {
    commentId?: string;
    commentUrl?: string;
    commentText: string;
    username: string;
    createdAt: string;
    /** Set once Reddit has accepted the comment. `createdAt` is the claim, written before it. */
    postedAt?: string;
    /** Who Reddit says wrote it. Empty when Reddit returned no name. */
    authorName?: string;
};

export type UserCommentOutcome =
    | { status: 'already'; record: UserCommentRecord }
    | { status: 'posted'; record: UserCommentRecord }
    | { status: 'posted_without_link'; record: UserCommentRecord }
    | { status: 'foreign_author' }
    | { status: 'unconfirmed' }
    | { status: 'lock_lost' };

// A longer thread answers unknown, never absent.
const COMMENT_WALK_LIMIT = 100;
const COMMENT_WALK_PAGE_SIZE = 25;

// Reddit reports comment times in whole seconds.
const COMMENT_CLOCK_SLACK_MS = 1000;

// Every other error may have posted the comment.
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

// A filled limit answers unknown, not absent.
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

// The compare every caller uses.
function sameAuthor(one: string, other: string): boolean {
    return one.trim().toLowerCase() === other.trim().toLowerCase();
}

/** A name Reddit returned that is not the player's. An empty name is not this. */
function foreignAuthor(comment: SubmittedUserComment, username: string): boolean {
    const authorName = typeof comment?.authorName === 'string' ? comment.authorName.trim() : '';
    return authorName.length > 0 && !sameAuthor(authorName, username);
}

async function discardForeignComment(comment: SubmittedUserComment): Promise<boolean> {
    const remove = (comment as { delete?: () => Promise<void> }).delete;
    if (typeof remove !== 'function') return false;
    try {
        await remove.call(comment);
        return true;
    } catch (error) {
        console.error('A comment posted under another name could not be removed:', error);
        return false;
    }
}

/**
 * Writes the publication onto the claim.
 *
 * The claim's text, player and time stay. The parser needs the first two, and a later walk
 * searches from the third, so a comment posted before it would never be found.
 *
 * The comment ID is kept only for the player's own comment. Every path that reads a stored ID
 * reads it as the player's shared result, so an app-authored comment must not carry one.
 */
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
    // The comment is live, so a failed write must not turn it into an error. The caller answers
    // from this copy, and the claim left behind still guards the result.
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

// Reddit can post a comment and still throw.
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
    /** Used when Reddit returns a comment with no URL of its own. */
    fallbackCommentUrl?: string;
    confirmOwnership: () => Promise<boolean>;
}): Promise<UserCommentOutcome> {
    const stored = record.stored;
    if (stored?.commentId) return { status: 'already', record: stored };
    // Reddit accepted this comment. Only its link is missing, so nothing below may post again.
    // This has to sit above the walk, because that walk reads an empty listing as absent.
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
        // Start the record's time here, not earlier.
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
        if (foreignAuthor(comment, username)) {
            const removed = await discardForeignComment(comment);
            if (removed) {
                await redis.del(record.key).catch((error: unknown) => {
                    console.error('A refused comment could not clear its record:', error);
                });
            } else {
                await writeUserCommentRecord(record.key, record.ttlSeconds, {
                    ...claim,
                    postedAt: new Date().toISOString(),
                    authorName: comment.authorName,
                }).catch((error: unknown) => {
                    console.error('A posted comment could not be recorded:', error);
                });
            }
            return { status: 'foreign_author' };
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
            // Nothing was posted. The record costs a walk.
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
