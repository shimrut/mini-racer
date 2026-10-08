import { randomUUID } from 'node:crypto';
import { redis } from '@devvit/web/server';
import { redisKeyPart } from '../redis/redis-names.js';
import {
    assertCommunityTrackPublishable,
    communityTrackSignature,
    normalizeCommunityDraft,
    CommunityMapInputError,
    type CommunityTrack,
    type Point,
} from './community-map-validation.js';

type Draft = {
    track: CommunityTrack;
    draftLoop: Point[];
    updatedAt: string;
    revision: number;
    geometrySignature: string;
    publicationId: string;
};

type MapRecord = {
    id: string;
    subredditName: string;
    name: string;
    authorName: string;
    publishedAt: string;
    track: CommunityTrack;
    version: 1;
    laps: 1;
};

export type CommunityMapSummary = Pick<MapRecord, 'id' | 'name' | 'authorName' | 'publishedAt'> & {
    status?: 'published' | 'unpublished';
};

const PAGE_SIZE = 20;
const MAX_MAPS_PER_SUBREDDIT = 250;
const ID_RE = /^[0-9a-f-]{36}$/;

function scope(subredditName: string): string {
    return redisKeyPart(subredditName);
}

function draftKey(subredditName: string, username: string): string {
    return `dailygp:community:draft:v1:${scope(subredditName)}:${redisKeyPart(username)}`;
}

function mapKey(id: string): string {
    return `dailygp:community:map:v1:${id}`;
}

function statusKey(id: string): string {
    return `dailygp:community:status:v1:${id}`;
}

function allIndexKey(subredditName: string): string {
    return `dailygp:community:all:v1:${scope(subredditName)}`;
}

function publishedIndexKey(subredditName: string): string {
    return `dailygp:community:published:v1:${scope(subredditName)}`;
}

function parseJson<T>(raw: string | null | undefined): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

function summary(record: MapRecord, status?: 'published' | 'unpublished'): CommunityMapSummary {
    return {
        id: record.id,
        name: record.name,
        authorName: record.authorName,
        publishedAt: record.publishedAt,
        ...(status ? { status } : {}),
    };
}

async function readRecord(subredditName: string, id: string): Promise<MapRecord | null> {
    if (!ID_RE.test(id)) return null;
    const record = parseJson<MapRecord>(await redis.get(mapKey(id)));
    return typeof record?.subredditName === 'string'
        && record.subredditName.toLowerCase() === subredditName.toLowerCase()
        && record.version === 1 ? record : null;
}

export async function readCommunityDraft(subredditName: string, username: string): Promise<Draft | null> {
    return parseJson<Draft>(await redis.get(draftKey(subredditName, username)));
}

export async function saveCommunityDraft(
    subredditName: string,
    username: string,
    input: unknown,
): Promise<Draft> {
    const { track, draftLoop } = normalizeCommunityDraft(input);
    const previous = await readCommunityDraft(subredditName, username);
    const geometrySignature = communityTrackSignature(track);
    const draft: Draft = {
        track,
        draftLoop,
        updatedAt: new Date().toISOString(),
        revision: (previous?.revision ?? 0) + 1,
        geometrySignature,
        publicationId: previous?.geometrySignature === geometrySignature && previous.publicationId
            ? previous.publicationId : randomUUID(),
    };
    await redis.set(draftKey(subredditName, username), JSON.stringify(draft));
    return draft;
}

export async function publishCommunityDraft(
    subredditName: string,
    username: string,
    completedLapSignature: unknown,
): Promise<{ map: MapRecord & { status: 'published' | 'unpublished' } }> {
    const draft = await readCommunityDraft(subredditName, username);
    if (!draft) throw new CommunityMapInputError('Save a draft before publishing.');
    if (typeof completedLapSignature !== 'string'
        || completedLapSignature !== draft.geometrySignature) {
        throw new CommunityMapInputError('Complete a Test Drive lap on the current saved map before publishing.');
    }
    // Reparse the stored snapshot in case older or malformed data reached Redis.
    const { track, draftLoop } = normalizeCommunityDraft(draft);
    if (draftLoop.length) {
        throw new CommunityMapInputError('Finish drawing the road before publishing.');
    }
    assertCommunityTrackPublishable(track);
    const existing = await readRecord(subredditName, draft.publicationId);
    if (!existing && await redis.zCard(allIndexKey(subredditName)) >= MAX_MAPS_PER_SUBREDDIT) {
        throw new CommunityMapInputError('This community has reached its map limit.');
    }
    const now = new Date();
    const record: MapRecord = {
        id: draft.publicationId,
        subredditName,
        name: track.name,
        authorName: username,
        publishedAt: now.toISOString(),
        track,
        version: 1,
        laps: 1,
    };
    // A draft owns one publication ID; retries complete the same record without replacing its first snapshot.
    await redis.set(mapKey(record.id), JSON.stringify(record), { nx: true });
    const saved = await readRecord(subredditName, record.id);
    if (!saved) throw new Error('Published map could not be read back.');
    await redis.set(statusKey(saved.id), 'published', { nx: true });
    const status = await redis.get(statusKey(saved.id));
    const score = Date.parse(saved.publishedAt);
    await redis.zAdd(allIndexKey(subredditName), { member: saved.id, score });
    if (status === 'published') {
        await redis.zAdd(publishedIndexKey(subredditName), { member: saved.id, score });
    }
    return { map: { ...saved, status: status === 'unpublished' ? 'unpublished' : 'published' } };
}

export async function readPublicCommunityMap(subredditName: string, id: string) {
    const record = await readRecord(subredditName, id);
    if (!record || await redis.get(statusKey(id)) !== 'published') return null;
    return { ...summary(record), track: record.track };
}

export async function changeCommunityMapStatus(
    subredditName: string,
    id: string,
    status: unknown,
): Promise<CommunityMapSummary | null> {
    if (status !== 'published' && status !== 'unpublished') {
        throw new CommunityMapInputError('Status must be published or unpublished.');
    }
    const record = await readRecord(subredditName, id);
    if (!record) return null;
    await redis.set(statusKey(id), status);
    if (status === 'published') {
        await redis.zAdd(publishedIndexKey(subredditName), {
            member: id,
            score: Date.parse(record.publishedAt),
        });
    } else {
        await redis.zRem(publishedIndexKey(subredditName), [id]);
    }
    return summary(record, status);
}

function decodeCursor(cursor: unknown): number {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/.test(cursor)) {
        throw new CommunityMapInputError('Invalid map page cursor.');
    }
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const offset = Number(decoded);
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_MAPS_PER_SUBREDDIT) {
        throw new CommunityMapInputError('Invalid map page cursor.');
    }
    return offset;
}

function encodeCursor(offset: number): string {
    return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export async function listCommunityMaps(
    subredditName: string,
    cursor: unknown,
    includeUnpublished = false,
): Promise<{ maps: CommunityMapSummary[]; nextCursor: string | null }> {
    const offset = decodeCursor(cursor);
    const indexKey = includeUnpublished
        ? allIndexKey(subredditName)
        : publishedIndexKey(subredditName);
    const rows = await redis.zRange(indexKey, offset, offset + PAGE_SIZE, {
        by: 'rank',
        reverse: true,
    });
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    const maps: CommunityMapSummary[] = [];
    for (const row of page) {
        const record = await readRecord(subredditName, row.member);
        if (!record) continue;
        const status = await redis.get(statusKey(record.id));
        if (status !== 'published' && status !== 'unpublished') continue;
        if (!includeUnpublished && status !== 'published') continue;
        maps.push(summary(record, includeUnpublished ? status : undefined));
    }
    return {
        maps,
        nextCursor: hasMore ? encodeCursor(offset + PAGE_SIZE) : null,
    };
}
