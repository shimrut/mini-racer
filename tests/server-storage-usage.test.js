import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const strings = new Map();
const hashes = new Map();
const sortedSets = new Map();
const failingKeys = new Set();

function refuse(key) {
    if (failingKeys.has(key)) throw new Error(`Redis refused ${key}.`);
}

const mockRedis = {
    strLen: vi.fn(async (key) => {
        refuse(key);
        return (strings.get(key) ?? '').length;
    }),
    hLen: vi.fn(async (key) => {
        refuse(key);
        return hashes.get(key)?.size ?? 0;
    }),
    hKeys: vi.fn(async (key) => {
        refuse(key);
        return [...(hashes.get(key)?.keys() ?? [])];
    }),
    hMGet: vi.fn(async (key, fields) => {
        refuse(key);
        return fields.map((field) => hashes.get(key)?.get(field) ?? null);
    }),
    zCard: vi.fn(async (key) => {
        refuse(key);
        return sortedSets.get(key)?.size ?? 0;
    }),
    zRange: vi.fn(async (key, start, stop) => {
        refuse(key);
        return [...(sortedSets.get(key) ?? new Map())]
            .map(([member, score]) => ({ member, score }))
            .slice(start, stop + 1);
    }),
};

vi.mock('@devvit/redis', () => ({ redis: mockRedis, redisCompressed: mockRedis }));
vi.mock('@devvit/web/server', () => ({
    redis: mockRedis,
    cache: vi.fn(async (source) => source()),
    context: {},
}));

const { getServerStorageUsage } = await import('../src/server/moderator/storage-usage.ts');
const { CAMPAIGN_ID } = await import('../game/campaign/manifest.js');

const SUBREDDIT = 'mini_racer';
const NOW = new Date('2026-08-22T10:00:00.000Z');
const TODAY = '2026-08-22';
const CHALLENGE_ID = `daily-gp-${TODAY}`;
const SORTED_SET_SCORE_BYTES = 8;

function playerField(playerId) {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}

function putString(key, value) {
    strings.set(key, value);
}

function putHash(key, fieldValues) {
    hashes.set(key, new Map(Object.entries(fieldValues)));
}

function putSortedSet(key, members) {
    sortedSets.set(key, new Map(Object.entries(members)));
}

function seededBytes() {
    const stringBytes = [...strings].reduce(
        (bytes, [key, value]) => bytes + key.length + value.length,
        0,
    );
    const hashBytes = [...hashes].reduce((bytes, [key, fields]) => bytes + key.length + [...fields]
        .reduce((rowBytes, [field, value]) => rowBytes + field.length + value.length, 0), 0);
    const sortedSetBytes = [...sortedSets].reduce(
        (bytes, [key, members]) => bytes + key.length
            + [...members.keys()].reduce(
                (rowBytes, member) => rowBytes + member.length + SORTED_SET_SCORE_BYTES,
                0,
            ),
        0,
    );
    return stringBytes + hashBytes + sortedSetBytes;
}

function groupById(usage, id) {
    return usage.groups.find((group) => group.id === id);
}

function seedOneDayOfRacing({ players = ['reddit:racefan', 'reddit:pitwall'] } = {}) {
    putHash(`dailygp:challenge-pbs:${CHALLENGE_ID}`, Object.fromEntries(
        players.map((playerId) => [playerField(playerId), `{"ghost":"${playerId}-trace"}`]),
    ));
    putHash(`dailygp:leaderboard:${CHALLENGE_ID}:entries`, Object.fromEntries(
        players.map((playerId) => [playerId, `{"playerId":"${playerId}","bestTimeMs":31000}`]),
    ));
    putSortedSet(
        `dailygp:leaderboard:${CHALLENGE_ID}`,
        Object.fromEntries(players.map((playerId, index) => [playerId, 31000 + index])),
    );
    putString(`dailygp:leaderboard:${CHALLENGE_ID}:standings-revision`, '7');
    putHash('dailygp:challenges', { [CHALLENGE_ID]: '{"id":"daily","trackKey":"numberOne"}' });

    putHash(`dailygp:analytics:${SUBREDDIT}:d:${TODAY}:players`, Object.fromEntries(
        players.map((playerId) => [playerId, 'n']),
    ));
    putHash(`dailygp:analytics:${SUBREDDIT}:d:${TODAY}:counters`, { 'daily:start': '4', 'daily:finish': '2' });
    putHash(`dailygp:analytics:${SUBREDDIT}:first-seen`, Object.fromEntries(
        players.map((playerId) => [playerId, TODAY]),
    ));
    putHash(`dailygp:analytics:${SUBREDDIT}:cohort-starts`, Object.fromEntries(
        players.map((playerId) => [playerId, TODAY]),
    ));

    for (const playerId of players) {
        putString(`dailygp:player-profile:${playerField(playerId)}`, `{"playerId":"${playerId}"}`);
        putString(`campaign:${CAMPAIGN_ID}:progress:${playerField(playerId)}`, '{"resultsByRaceId":{}}');
        putHash(`miniracer:car-unlocks:v1:${playerField(playerId)}`, { 'race:completed': '1' });
    }

    putString(`dailygp:post:${SUBREDDIT}:${CHALLENGE_ID}`, '{"postId":"t3_abc"}');
    putHash('miniracer:launcher-posts', { [`${SUBREDDIT}:daily`]: '{"postId":"t3_def"}' });
    return players;
}

async function measure() {
    return getServerStorageUsage({ subredditName: SUBREDDIT, now: NOW });
}

describe('server storage usage', () => {
    beforeEach(() => {
        strings.clear();
        hashes.clear();
        sortedSets.clear();
        failingKeys.clear();
        vi.clearAllMocks();
    });

    it('reports nothing when nothing is stored', async () => {
        const usage = await measure();

        expect(usage.totalBytes).toBe(0);
        expect(usage.groups.every((group) => group.bytes === 0)).toBe(true);
        expect(usage.measuredAt).toBe(NOW.toISOString());
    });

    it('adds up every key it can name, and counts each one once', async () => {
        seedOneDayOfRacing();

        const usage = await measure();

        expect(usage.totalBytes).toBe(seededBytes());
        expect(usage.groups.reduce((bytes, group) => bytes + group.bytes, 0)).toBe(usage.totalBytes);
    });

    it('files each key under the part of the game that wrote it', async () => {
        seedOneDayOfRacing();

        const usage = await measure();

        expect(groupById(usage, 'ghosts').rows).toBe(2);
        expect(groupById(usage, 'leaderboards').rows).toBe(5);
        expect(groupById(usage, 'challenges').rows).toBe(1);
        expect(groupById(usage, 'analytics').keys).toBe(4);
        expect(groupById(usage, 'players').keys).toBe(6);
        expect(groupById(usage, 'posts').keys).toBe(2);
    });

    it('names the biggest holding first', async () => {
        seedOneDayOfRacing();
        putHash(`dailygp:challenge-pbs:${CHALLENGE_ID}`, Object.fromEntries(
            Array.from({ length: 10 }, (_unused, index) => [`player-${index}`, 'x'.repeat(2000)]),
        ));

        const usage = await measure();

        expect(usage.groups[0].id).toBe('ghosts');
        expect(usage.groups.map((group) => group.bytes)).toEqual(
            [...usage.groups.map((group) => group.bytes)].sort((first, second) => second - first),
        );
    });

    it('counts rows exactly and marks a size it worked out from a sample', async () => {
        const rowValue = 'x'.repeat(500);
        putHash('dailygp:challenges', { [CHALLENGE_ID]: '{}' });
        putHash(`dailygp:challenge-pbs:${CHALLENGE_ID}`, Object.fromEntries(
            Array.from({ length: 50 }, (_unused, index) => [`ghost-${String(index).padStart(2, '0')}`, rowValue]),
        ));

        const usage = await measure();
        const ghosts = groupById(usage, 'ghosts');

        // The day-list entry belongs to the Daily challenges family.
        const dayListBytes = 'dailygp:challenges'.length + CHALLENGE_ID.length + '{}'.length;
        expect(ghosts.rows).toBe(50);
        expect(ghosts.estimated).toBe(true);
        expect(ghosts.bytes).toBe(seededBytes() - dayListBytes);
        const ghostSamples = mockRedis.hMGet.mock.calls
            .filter(([key]) => String(key).startsWith('dailygp:challenge-pbs:'));
        expect(ghostSamples).toHaveLength(1);
        expect(ghostSamples[0][1]).toHaveLength(20);
    });

    it('measures a spread of the stored Daily days and scales up to all of them', async () => {
        // 180 stored days, older than the analytics window too, one ghost each.
        const days = Array.from({ length: 180 }, (_unused, index) => (
            `daily-gp-${new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10)}`
        ));
        putHash('dailygp:challenges', Object.fromEntries(days.map((day) => [day, '{}'])));
        for (const day of days) putHash(`dailygp:challenge-pbs:${day}`, { ghost: 'trace' });

        const usage = await measure();
        const ghosts = groupById(usage, 'ghosts');

        expect(ghosts.keys).toBe(180);
        expect(ghosts.rows).toBe(180);
        expect(ghosts.estimated).toBe(true);
        const measuredBoards = mockRedis.hLen.mock.calls
            .filter(([key]) => String(key).startsWith('dailygp:challenge-pbs:'));
        expect(measuredBoards).toHaveLength(60);
    });

    it('scales the player records it sampled up to every player it knows about', async () => {
        const players = Array.from({ length: 120 }, (_unused, index) => `reddit:racer-${index}`);
        seedOneDayOfRacing({ players });

        const usage = await measure();
        const group = groupById(usage, 'players');

        expect(group.estimated).toBe(true);
        expect(group.keys).toBe(360);
        expect(group.bytes).toBeGreaterThan(0);
    });

    function seedTracks(count, recordBytes) {
        const trackKeys = Array.from({ length: count }, (_unused, index) => `track${String(index).padStart(3, '0')}`);
        for (const trackKey of trackKeys) putString(`dailygp:tracks:v1:track:${trackKey}`, 'x'.repeat(recordBytes));
        putHash('dailygp:tracks:v1:index', Object.fromEntries(trackKeys.map((trackKey) => [trackKey, '1'])));
        putString('dailygp:tracks:v1:revision', String(count));
    }

    it('counts every saved track, with the track list', async () => {
        seedTracks(3, 900);

        const usage = await measure();
        const tracks = groupById(usage, 'tracks');

        expect(tracks).toMatchObject({ label: 'Tracks', keys: 5, rows: 7, estimated: false });
        expect(tracks.bytes).toBe(seededBytes());
        expect(usage.totalBytes).toBe(seededBytes());
    });

    it('measures a spread of the saved tracks and scales up to all of them', async () => {
        seedTracks(150, 1200);

        const usage = await measure();
        const tracks = groupById(usage, 'tracks');

        expect(tracks.keys).toBe(152);
        expect(tracks.rows).toBe(301);
        expect(tracks.estimated).toBe(true);
        // Every record has the same size, so the scaled size is exact.
        expect(tracks.bytes).toBe(seededBytes());
        const measuredRecords = mockRedis.strLen.mock.calls
            .filter(([key]) => String(key).startsWith('dailygp:tracks:v1:track:'));
        expect(measuredRecords).toHaveLength(60);
    });

    it('keeps reporting when Redis refuses a key', async () => {
        seedOneDayOfRacing();
        failingKeys.add(`dailygp:challenge-pbs:${CHALLENGE_ID}`);

        const usage = await measure();

        expect(groupById(usage, 'ghosts').bytes).toBe(0);
        expect(groupById(usage, 'leaderboards').bytes).toBeGreaterThan(0);
    });
});
