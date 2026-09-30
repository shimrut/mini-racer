import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import roughCut from '../game/track/definitions/rough-cut.js';

const strings = new Map();
const sorted = new Map();
const mockRedis = {
    get: vi.fn(async (key) => strings.get(key)),
    set: vi.fn(async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    }),
    zAdd: vi.fn(async (key, row) => {
        const set = sorted.get(key) ?? new Map();
        set.set(row.member, row.score);
        sorted.set(key, set);
        return 1;
    }),
    zRem: vi.fn(async (key, members) => {
        for (const member of members) sorted.get(key)?.delete(member);
        return 1;
    }),
    zCard: vi.fn(async (key) => sorted.get(key)?.size ?? 0),
    zRange: vi.fn(async (key, start, stop, options) => {
        const rows = [...(sorted.get(key) ?? new Map())]
            .map(([member, score]) => ({ member, score }))
            .sort((a, b) => options?.reverse ? b.score - a.score : a.score - b.score);
        return rows.slice(start, stop + 1);
    }),
};

vi.mock('@devvit/web/server', () => ({ redis: mockRedis }));

const {
    readCommunityDraft,
    saveCommunityDraft,
    publishCommunityDraft,
    readPublicCommunityMap,
    changeCommunityMapStatus,
    listCommunityMaps,
} = await import('../src/server/community/community-map-store.ts');

const validTrack = { ...roughCut, name: 'Rough Cut' };

beforeEach(() => {
    strings.clear();
    sorted.clear();
    vi.clearAllMocks();
});

describe('Community map store', () => {
    it('acknowledges a bounded unfinished draft and reloads it per moderator', async () => {
        const draft = await saveCommunityDraft('MiniRacer', 'ModOne', {
            track: { ...validTrack, outer: [], inner: [] },
            draftLoop: [{ x: 4, y: 5 }],
        });
        expect(draft.revision).toBe(1);
        expect(draft.draftLoop).toEqual([{ x: 4, y: 5 }]);
        expect(await readCommunityDraft('MiniRacer', 'ModOne')).toEqual(draft);
        expect(await readCommunityDraft('MiniRacer', 'OtherMod')).toBeNull();
        expect(mockRedis.set).toHaveBeenCalled();
    });

    it('does not acknowledge a failed Redis save', async () => {
        mockRedis.set.mockRejectedValueOnce(new Error('Redis unavailable'));
        await expect(saveCommunityDraft('MiniRacer', 'ModOne', {
            track: validTrack,
        })).rejects.toThrow('Redis unavailable');
        expect(await readCommunityDraft('MiniRacer', 'ModOne')).toBeNull();
    });

    it('rejects out of bounds geometry and failed track checks at publication', async () => {
        await expect(saveCommunityDraft('MiniRacer', 'ModOne', {
            track: { ...validTrack, startPos: { x: Infinity, y: 1 } },
        })).rejects.toThrow('finite coordinates');

        const draft = await saveCommunityDraft('MiniRacer', 'ModOne', {
            track: { ...validTrack, checkpoints: [] },
        });
        await expect(publishCommunityDraft('MiniRacer', 'ModOne', draft.geometrySignature))
            .rejects.toThrow('Too few checkpoints');
        await expect(publishCommunityDraft('MiniRacer', 'ModOne', 'wrong'))
            .rejects.toThrow('Test Drive lap');
    });

    it('publishes one immutable map for repeated clicks, then hides and restores it', async () => {
        const draft = await saveCommunityDraft('MiniRacer', 'ModOne', { track: validTrack });
        const [first, retry] = await Promise.all([
            publishCommunityDraft('MiniRacer', 'ModOne', draft.geometrySignature),
            publishCommunityDraft('MiniRacer', 'ModOne', draft.geometrySignature),
        ]);
        expect(first.map.id).toBe(retry.map.id);
        expect(await listCommunityMaps('MiniRacer', null)).toMatchObject({
            maps: [{ id: first.map.id, name: 'Rough Cut' }],
            nextCursor: null,
        });
        expect((await readPublicCommunityMap('MiniRacer', first.map.id)).track).toEqual(draft.track);
        expect(await readPublicCommunityMap('OtherSub', first.map.id)).toBeNull();

        await changeCommunityMapStatus('MiniRacer', first.map.id, 'unpublished');
        expect(await readPublicCommunityMap('MiniRacer', first.map.id)).toBeNull();
        expect((await listCommunityMaps('MiniRacer', null)).maps).toEqual([]);
        expect((await listCommunityMaps('MiniRacer', null, true)).maps[0].status).toBe('unpublished');

        // A retry cannot silently republish a map that a moderator hid.
        expect((await publishCommunityDraft('MiniRacer', 'ModOne', draft.geometrySignature)).map.status)
            .toBe('unpublished');
        expect(await readPublicCommunityMap('MiniRacer', first.map.id)).toBeNull();
        await changeCommunityMapStatus('MiniRacer', first.map.id, 'published');
        expect(await readPublicCommunityMap('MiniRacer', first.map.id)).toMatchObject({ id: first.map.id });
    });

    it('pages published maps newest first and excludes unpublished records', async () => {
        const ids = Array.from({ length: 22 }, () => randomUUID());
        ids.forEach((id, index) => {
            const publishedAt = new Date(1_800_000_000_000 + index).toISOString();
            strings.set(`dailygp:community:map:v1:${id}`, JSON.stringify({
                id,
                subredditName: 'MiniRacer',
                name: `Track ${index}`,
                authorName: 'RaceMod',
                publishedAt,
                track: validTrack,
                version: 1,
                laps: 1,
            }));
            strings.set(`dailygp:community:status:v1:${id}`, index === 21 ? 'unpublished' : 'published');
        });
        sorted.set('dailygp:community:published:v1:miniracer', new Map(
            ids.slice(0, 21).map((id, index) => [id, 1_800_000_000_000 + index]),
        ));
        const first = await listCommunityMaps('MiniRacer', null);
        expect(first.maps).toHaveLength(20);
        expect(first.maps[0].id).toBe(ids[20]);
        expect(first.nextCursor).toBeTruthy();
        const second = await listCommunityMaps('MiniRacer', first.nextCursor);
        expect(second.maps.map((map) => map.id)).toEqual([ids[0]]);
        expect(second.nextCursor).toBeNull();
    });
});
