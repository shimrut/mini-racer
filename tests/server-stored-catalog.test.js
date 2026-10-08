import { installTrackRedisTransactions } from './helpers/track-redis-transactions.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import smallSteps from '../game/track/definitions/small-steps.js';

const TRACK_REVISION_KEY = 'dailygp:tracks:v1:revision';
const SERIES_REVISION_KEY = 'dailygp:campaign:series:v1:revision';
const TRACK_INDEX_KEY = 'dailygp:tracks:v1:index';
const SERIES_INDEX_KEY = 'dailygp:campaign:series:v1:index';
const trackRecordKey = (key) => `dailygp:tracks:v1:track:${key}`;

const strings = new Map();
const hashes = new Map();
const mockContext = { subredditId: 't5_one' };
const faults = { mGet: 0, bumpOnIndexRead: false };
const holds = [];

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

// Holds the next matching call; captureFirst reads Redis first and answers late.
function hold(method, match, { captureFirst = false } = {}) {
    const entry = { method, match, captureFirst, reached: deferred(), release: deferred() };
    holds.push(entry);
    return { reached: entry.reached.promise, release: () => entry.release.resolve() };
}

async function held(method, args, read) {
    const index = holds.findIndex((entry) => entry.method === method && entry.match(...args));
    if (index < 0) return read();
    const [entry] = holds.splice(index, 1);
    const early = entry.captureFirst ? read() : null;
    entry.reached.resolve();
    await entry.release.promise;
    return entry.captureFirst ? early : read();
}

const readMany = (keys) => keys.map((key) => strings.get(key) ?? null);
const known = {
    get: async (key) => strings.get(key) ?? null,
    set: async (key, value, options) => {
        if (options?.nx && strings.has(key)) return '';
        strings.set(key, value);
        return 'OK';
    },
    del: async (...keys) => {
        keys.flat().forEach((key) => strings.delete(key));
        return 1;
    },
    mGet: vi.fn(async (keys) => {
        if (faults.mGet > 0) {
            faults.mGet -= 1;
            throw new Error('redis: mGet timed out');
        }
        return held('mGet', [keys], () => readMany(keys));
    }),
    incrBy: async (key, value) => {
        const next = Number(strings.get(key) ?? 0) + value;
        strings.set(key, String(next));
        return next;
    },
    hGet: async (key, field) => hashes.get(key)?.get(field) ?? null,
    hMGet: async (key, fields) => fields.map((field) => hashes.get(key)?.get(field) ?? null),
    hScan: async () => ({ cursor: 0, fieldValues: [] }),
    zRange: async () => [],
    zCard: async () => 0,
    hGetAll: async (key) => {
        const values = await held('hGetAll', [key], () => Object.fromEntries(hashes.get(key) ?? new Map()));
        if (faults.bumpOnIndexRead && key === TRACK_INDEX_KEY) {
            strings.set(TRACK_REVISION_KEY, String(Number(strings.get(TRACK_REVISION_KEY) ?? 0) + 1));
        }
        return values;
    },
    hSet: async (key, fields) => {
        const hash = hashes.get(key) ?? new Map();
        Object.entries(fields).forEach(([field, value]) => hash.set(field, value));
        hashes.set(key, hash);
        return 1;
    },
    hDel: async (key, fields) => {
        fields.forEach((field) => hashes.get(key)?.delete(field));
        return 1;
    },
    hScan: async () => ({ cursor: 0, fieldValues: [] }),
    expire: async () => true,
};
const mockRedis = new Proxy(known, { get: (target, name) => target[name] ?? (async () => null) });

installTrackRedisTransactions(mockRedis, strings, hashes);

vi.mock('@devvit/redis', () => ({ redis: mockRedis, redisCompressed: mockRedis }));
vi.mock('@devvit/web/server', () => ({
    redis: mockRedis, context: mockContext, cache: async (source) => source(),
}));
vi.mock('../src/server/competition/replay-validator.js', () => ({
    validateDailyGpReplayDetailed: vi.fn(),
}));

const catalog = await import('../src/server/tracks/stored-catalog.ts');
const tracks = await import('../src/server/tracks/track-store.ts');
const series = await import('../src/server/campaign/series-store.ts');
const { registerCompetitionRoutes } = await import('../src/server/routes/competition-routes.ts');
const { TRACKS } = await import('../game/track/tracks.js');
const daily = await import('../src/server/daily/daily-gp-store.ts');
const player = await import('../src/server/player/player-account-store.ts');
const { validateDailyGpReplayDetailed } = await import('../src/server/competition/replay-validator.ts');

const medalRow = { author: 9.1, gold: 9.4, silver: 9.7, bronze: 10.1 };

async function saveTrack(key, name, options = {}) {
    return tracks.saveStoredTrack(key, { track: { ...smallSteps, name }, medalRow }, { username: 'ModOne', ...options });
}

function placed(keys) {
    return tracks.describePlacedStoredTracks(keys).map((entry) => entry.key);
}

function publishedSeriesIds() {
    return series.resolveStoredSeriesForRequest().map((entry) => entry.id);
}

function coldCache() {
    tracks.clearStoredTrackCacheForTests();
    series.clearStoredSeriesCacheForTests();
}

beforeEach(() => {
    strings.clear();
    hashes.clear();
    holds.length = 0;
    faults.mGet = 0;
    faults.bumpOnIndexRead = false;
    known.mGet.mockClear();
    validateDailyGpReplayDetailed.mockReset();
    mockContext.subredditId = 't5_one';
    coldCache();
    tracks.installStoredTrackResolver();
    series.installStoredSeriesResolver();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the stored catalog', () => {
    it('loads the track list and the series, and a request loads the tracks it names', async () => {
        await saveTrack('nightOne', 'Night One');
        await catalog.ensureStoredCatalogLoaded();
        expect('nightOne' in TRACKS).toBe(true);
        expect(known.mGet.mock.calls.some(([keys]) => keys.includes(trackRecordKey('nightOne')))).toBe(false);
        await catalog.loadStoredTracks(['nightOne']);
        expect(TRACKS.nightOne.name).toBe('Night One');
    });

    it('loads only challenge page tracks before reading their stored names on a cold server', async () => {
        await saveTrack('countryRoad', 'Stored Country Road', { origin: 'migrated' });
        await saveTrack('safariCircuit', 'Stored Safari Circuit', { origin: 'migrated' });
        await saveTrack('nightOne', 'Not On This Page');
        coldCache();
        await catalog.ensureStoredCatalogLoaded();
        expect(() => TRACKS.countryRoad).toThrow(tracks.StoredTrackNotLoadedError);

        const { getChallengeAnalyticsPage } = await import('../src/server/moderator/challenge-analytics-store.ts');
        const { challengeAnalyticsMigrationKeys } = await import('../src/server/moderator/challenge-analytics-migration.ts');
        await known.set(challengeAnalyticsMigrationKeys('MiniRacer').complete, '1');
        vi.spyOn(known, 'zRange').mockResolvedValueOnce([
            { member: 'countryRoad', score: 0 }, { member: 'safariCircuit', score: 0 },
        ]);
        known.mGet.mockClear();

        const page = await tracks.runWithPinnedStoredTracks(() => getChallengeAnalyticsPage('MiniRacer', 0));
        expect(page.items.map((item) => item.trackName)).toEqual([
            'Stored Country Road', 'Stored Safari Circuit',
        ]);
        expect(known.mGet.mock.calls).toEqual([[[
            trackRecordKey('countryRoad'), trackRecordKey('safariCircuit'),
        ]]]);
        expect(() => TRACKS.nightOne).toThrow(tracks.StoredTrackNotLoadedError);
    });

    it('initializes an empty install, then reads only the two revisions', async () => {
        await catalog.ensureStoredCatalogLoaded();
        expect(tracks.readStoredTrackCacheRevision('t5_one')).toBe('0');
        expect(series.readStoredSeriesCacheRevision('t5_one')).toBe('0');
        known.mGet.mockClear();
        await catalog.ensureStoredCatalogLoaded();
        expect(known.mGet.mock.calls).toEqual([[[TRACK_REVISION_KEY, SERIES_REVISION_KEY]]]);
    });

    it('keeps each install separate', async () => {
        await saveTrack('nightOne', 'Night One');
        await catalog.ensureStoredCatalogLoaded();
        mockContext.subredditId = 't5_two';
        expect(TRACKS.nightOne).toBeUndefined();
        expect(tracks.readStoredTrackCacheRevision('t5_two')).toBeNull();
    });

    it.each([
        ['the newer load finishes first', true],
        ['the older load finishes first', false],
    ])('never publishes an older picture from equal starting revisions: %s', async (_label, newerFirst) => {
        // Two loads at revision 1: one keeps the old list, the other reads after a save and a Daily lock.
        await tracks.saveStoredTrack('smallSteps', { track: { ...smallSteps, name: 'Small Steps' }, medalRow }, {
            username: 'ModOne', origin: 'migrated', trusted: true,
        });
        const slowRecords = hold('hGetAll', (key) => key === TRACK_INDEX_KEY, { captureFirst: true });
        const loadA = catalog.ensureStoredCatalogLoaded();
        await slowRecords.reached;
        const slowIndex = hold('hGetAll', (key) => key === TRACK_INDEX_KEY);
        const loadB = catalog.ensureStoredCatalogLoaded();
        await slowIndex.reached;

        await tracks.saveStoredTrack('smallSteps', {
            track: { ...smallSteps, name: 'Small Steps Edit', cornerRadius: 3 }, medalRow,
        }, { username: 'ModOne', baseRevision: 1 });
        expect(await tracks.lockStoredTrack('smallSteps', 'daily')).toBe(true);

        if (newerFirst) {
            slowIndex.release();
            await loadB;
            slowRecords.release();
            await loadA;
        } else {
            slowRecords.release();
            await loadA;
            slowIndex.release();
            await loadB;
        }

        await catalog.loadStoredTracks(['smallSteps']);
        expect(placed(['smallSteps'])).toEqual(['smallSteps']);
        expect(TRACKS.smallSteps.name).toBe('Small Steps Edit');
        expect(TRACKS.smallSteps.cornerRadius).toBe(3);
    });

    it('reads again when a save lands during the reads', async () => {
        await saveTrack('nightOne', 'Night One');
        const slowRecords = hold('hGetAll', (key) => key === TRACK_INDEX_KEY, { captureFirst: true });
        const load = catalog.ensureStoredCatalogLoaded();
        await slowRecords.reached;
        await saveTrack('nightTwo', 'Night Two');
        slowRecords.release();
        await load;
        await catalog.loadStoredTracks(['nightOne', 'nightTwo']);
        expect(TRACKS.nightOne.name).toBe('Night One');
        expect(TRACKS.nightTwo.name).toBe('Night Two');
    });

    it('never shows a live series before its tracks are placed', async () => {
        await saveTrack('nightOne', 'Night One');
        await saveTrack('nightTwo', 'Night Two');
        // A series names only tracks that the game can look up.
        await catalog.ensureStoredCatalogLoaded();
        await series.saveStoredSeries('night-v1', {
            name: 'Night Races',
            ground: 'tarmac',
            stages: [
                { trackKey: 'nightOne', laps: 1, requiredMedals: 0 },
                { trackKey: 'nightTwo', laps: 2, requiredMedals: 1 },
            ],
        }, { username: 'ModOne' });
        coldCache();
        const slowSeries = hold('hGetAll', (key) => key === SERIES_INDEX_KEY);
        const load = catalog.ensureStoredCatalogLoaded();
        await slowSeries.reached;
        // The tracks are read; the publication lands before the series read.
        await series.publishStoredSeries('night-v1', { username: 'ModOne', baseRevision: 1 });
        expect(publishedSeriesIds()).toEqual([]);
        slowSeries.release();
        await load;
        expect(publishedSeriesIds()).toContain('night-v1');
        await catalog.loadStoredTracks(['nightOne', 'nightTwo']);
        expect(placed(['nightOne', 'nightTwo'])).toEqual(['nightOne', 'nightTwo']);
    });

    it('keeps the newer cache when an older verified load finishes last', async () => {
        await saveTrack('nightOne', 'Night One');
        let revisionReads = 0;
        const lateFinish = hold('mGet', (keys) => keys[0] === TRACK_REVISION_KEY && ++revisionReads === 2,
            { captureFirst: true });
        const older = catalog.ensureStoredCatalogLoaded();
        await lateFinish.reached;
        await saveTrack('nightTwo', 'Night Two');
        await catalog.ensureStoredCatalogLoaded();
        lateFinish.release();
        await older;
        await catalog.loadStoredTracks(['nightTwo']);
        expect(TRACKS.nightTwo.name).toBe('Night Two');
        expect(tracks.readStoredTrackCacheRevision('t5_one')).toBe('2');
    });

    it('retries a failed read', async () => {
        await saveTrack('nightOne', 'Night One');
        faults.mGet = 1;
        await catalog.ensureStoredCatalogLoaded();
        await catalog.loadStoredTracks(['nightOne']);
        expect(TRACKS.nightOne.name).toBe('Night One');
    });

    it('fails after three unstable reads, and keeps the earlier cache', async () => {
        await saveTrack('nightOne', 'Night One');
        await catalog.ensureStoredCatalogLoaded();
        await catalog.loadStoredTracks(['nightOne']);
        await saveTrack('nightTwo', 'Night Two');
        faults.bumpOnIndexRead = true;
        await expect(catalog.ensureStoredCatalogLoaded()).rejects.toBeInstanceOf(catalog.StoredCatalogUnavailableError);
        expect(TRACKS.nightOne.name).toBe('Night One');
        expect(TRACKS.nightTwo).toBeUndefined();
    });

    it('fails after three failed reads on a warm process, and keeps the earlier cache', async () => {
        await saveTrack('nightOne', 'Night One');
        await catalog.ensureStoredCatalogLoaded();
        await catalog.loadStoredTracks(['nightOne']);
        await saveTrack('nightTwo', 'Night Two');
        faults.mGet = 10;
        await expect(catalog.ensureStoredCatalogLoaded()).rejects.toBeInstanceOf(catalog.StoredCatalogUnavailableError);
        expect(TRACKS.nightOne.name).toBe('Night One');
        expect(TRACKS.nightTwo).toBeUndefined();
    });

    it('never reads a broken revision as an empty catalog', async () => {
        await saveTrack('nightOne', 'Night One');
        strings.set(SERIES_REVISION_KEY, 'not-a-number');
        await expect(catalog.ensureStoredCatalogLoaded()).rejects.toBeInstanceOf(catalog.StoredCatalogUnavailableError);
        expect(tracks.readStoredTrackCacheRevision('t5_one')).toBeNull();
    });
});

describe('Daily answers confirm the catalog after they know their track', () => {
    function responseRecorder() {
        const response = {
            statusCode: null,
            body: null,
            status(code) { response.statusCode = code; return response; },
            json(body) { response.body = body; return response; },
        };
        return response;
    }

    function dailyHandlers({ postBound = null } = {}) {
        const handlers = {};
        const challenge = { id: 'daily-gp-2026-10-01', trackKey: 'nightOne' };
        registerCompetitionRoutes({
            get: (path, handler) => { handlers[path] = handler; },
            post: () => {},
        }, {
            getRequestUsername: () => null,
            getRequestRateLimitIdentity: () => null,
            getPostBoundDailyGpChallenge: async () => postBound,
            getServerDailyGpChallenge: async () => challenge,
            getServerDailyGpPlaylist: async () => [challenge],
            getServerDailyGpSnapshot: vi.fn(),
            submitServerDailyGpRun: vi.fn(),
            isDailyGpChallengePlayable: () => true,
            refreshStoredCatalog: catalog.reloadPinnedCatalog,
            loadStoredTracks: catalog.loadStoredTracks,
            describeStoredTracks: tracks.describePlacedStoredTracks,
        });
        return handlers;
    }

    async function placedByAnotherServer() {
        await saveTrack('nightOne', 'Night One');
        // This server's request began before the Daily was placed.
        await catalog.ensureStoredCatalogLoaded();
        await catalog.loadStoredTracks(['nightOne']);
        expect(await tracks.lockStoredTrack('nightOne', 'daily')).toBe(true);
        expect(placed(['nightOne'])).toEqual([]);
    }

    it('carries the track that another server placed after the request began', async () => {
        await placedByAnotherServer();
        const active = responseRecorder();
        await dailyHandlers()['/api/daily/active']({}, active);
        expect(active.statusCode).toBe(200);
        expect(active.body.storedTracks.map((entry) => entry.key)).toEqual(['nightOne']);
    });

    it('confirms the playlist and a post-bound Daily the same way', async () => {
        await placedByAnotherServer();
        const playlist = responseRecorder();
        await dailyHandlers()['/api/daily/playlist']({}, playlist);
        expect(playlist.body.storedTracks.map((entry) => entry.key)).toEqual(['nightOne']);

        coldCache();
        await catalog.ensureStoredCatalogLoaded();
        const bound = responseRecorder();
        await dailyHandlers({ postBound: { id: 'daily-gp-2026-10-01', trackKey: 'nightOne' } })['/api/daily/active']({}, bound);
        expect(bound.body.storedTracks.map((entry) => entry.key)).toEqual(['nightOne']);
    });

    it('answers 503 when the confirmation cannot read', async () => {
        await placedByAnotherServer();
        faults.mGet = 10;
        const active = responseRecorder();
        await dailyHandlers()['/api/daily/active']({}, active);
        expect(active.statusCode).toBe(503);
        expect(active.body).toEqual({ error: 'The tracks could not load. Try again.' });
    });
});

describe('Daily geometry boundaries', () => {
    function dailyContract(offset, trackKey, overrides = {}) {
        const day = Math.floor(Date.now() / 86_400_000) - offset;
        const startsAt = new Date(day * 86_400_000).toISOString();
        const challengeDate = startsAt.slice(0, 10);
        return {
            id: `daily-gp-${challengeDate}`,
            challengeDate,
            trackKey,
            startsAt,
            endsAt: new Date((day + 1) * 86_400_000).toISOString(),
            availableUntil: new Date((day + 7) * 86_400_000).toISOString(),
            ...overrides,
        };
    }

    async function writeChallenge(challenge) {
        await known.hSet('dailygp:challenges', { [challenge.id]: JSON.stringify(challenge) });
    }

    async function withCatalogPin(callback) {
        await catalog.ensureStoredCatalogLoaded();
        return series.runWithPinnedStoredSeries(() => tracks.runWithPinnedStoredTracks(callback));
    }

    it('discovers a custom Daily published after the middleware catalog pin', async () => {
        await withCatalogPin(async () => {
            await saveTrack('nightOne', 'Night One');
            await tracks.lockStoredTrack('nightOne', 'daily');
            const challenge = dailyContract(0, 'nightOne');
            await writeChallenge(challenge);
            expect(daily.parseStoredChallenge(JSON.stringify(challenge))).toBeNull();

            await expect(daily.getServerDailyGpChallengeById(challenge.id)).resolves.toMatchObject(challenge);

            expect(TRACKS.nightOne.name).toBe('Night One');
            expect(placed(['nightOne'])).toEqual(['nightOne']);
        });
    });

    it('validates a Daily submission with the override placed after the middleware pin', async () => {
        await tracks.saveStoredTrack('smallSteps', {
            track: { ...smallSteps, name: 'Placed Small Steps', cornerRadius: 3 }, medalRow,
        }, { username: 'ModOne', origin: 'migrated', trusted: true });
        await withCatalogPin(async () => {
            await catalog.loadStoredTracks(['smallSteps']);
            expect(placed(['smallSteps'])).toEqual([]);
            await tracks.lockStoredTrack('smallSteps', 'daily');
            const challenge = dailyContract(0, 'smallSteps');
            await writeChallenge(challenge);
            let validatedTrack;
            validateDailyGpReplayDetailed.mockImplementation(() => {
                validatedTrack = TRACKS.smallSteps;
                return { ok: false, failure: { reason: 'no_finish' } };
            });

            const reply = await daily.submitServerDailyGpRun({
                challengeId: challenge.id, trackKey: 'smallSteps', redditUsername: 'RacerOne', replay: {},
            });

            expect(reply.status).toBe(422);
            expect(reply.body.reason).toBe('no_finish');
            expect(validatedTrack.name).toBe('Placed Small Steps');
            expect(validatedTrack.cornerRadius).toBe(3);
            expect(validateDailyGpReplayDetailed).toHaveBeenCalledOnce();
        });
    });

    it('refuses to validate a Daily replay when its indexed definition is unavailable', async () => {
        await saveTrack('nightOne', 'Night One');
        await tracks.lockStoredTrack('nightOne', 'daily');
        const challenge = dailyContract(0, 'nightOne');
        await writeChallenge(challenge);
        strings.delete(trackRecordKey('nightOne'));
        coldCache();
        await withCatalogPin(async () => {
            await expect(daily.submitServerDailyGpRun({
                challengeId: challenge.id, trackKey: 'nightOne', redditUsername: 'RacerOne', replay: {},
            })).rejects.toBeInstanceOf(catalog.StoredCatalogUnavailableError);
            expect(validateDailyGpReplayDetailed).not.toHaveBeenCalled();
        });
    });

    it('confirms an already loaded Daily contract before snapshot geometry is read', async () => {
        await withCatalogPin(async () => {
            await saveTrack('nightOne', 'Night One');
            await tracks.lockStoredTrack('nightOne', 'daily');
            const challenge = daily.parseStoredChallenge(JSON.stringify(dailyContract(0, 'circuit')));
            challenge.trackKey = 'nightOne';

            const snapshot = await daily.getServerDailyGpSnapshot({
                challengeId: challenge.id, loadedChallenge: challenge,
            });

            expect(snapshot).toMatchObject({ topRows: [], objectiveType: challenge.objectiveType });
            expect(TRACKS.nightOne.name).toBe('Night One');
            expect(placed(['nightOne'])).toEqual(['nightOne']);
        });
    });

    it('hydrates requested PB days without reading unrelated missing track records', async () => {
        await saveTrack('nightOne', 'Night One');
        await tracks.lockStoredTrack('nightOne', 'daily');
        await saveTrack('nightTwo', 'Night Two');
        await tracks.lockStoredTrack('nightTwo', 'daily');
        const requested = dailyContract(1, 'nightOne');
        await writeChallenge(dailyContract(0, 'nightTwo'));
        await writeChallenge(requested);
        // The current day is still indexed, but its definition is unavailable.
        strings.delete(trackRecordKey('nightTwo'));
        coldCache();
        await withCatalogPin(async () => {
            known.mGet.mockClear();

            const reply = await player.getServerPlayerTrackPbSummaries({
                redditUsername: 'RacerOne', challengeIds: [requested.id, requested.id, 'daily-gp-1999-01-01'],
            });

            expect(reply).toEqual({
                playerId: 'reddit:racerone', trackPbs: { [requested.id]: null, 'daily-gp-1999-01-01': null },
            });
            expect(TRACKS.nightOne.name).toBe('Night One');
            const recordReads = known.mGet.mock.calls.flatMap(([keys]) => keys.filter((key) => key.includes(':track:')));
            expect(recordReads).toEqual([trackRecordKey('nightOne')]);
        });
    });

    it('confirms a requested PB custom key learned after the middleware pin', async () => {
        await withCatalogPin(async () => {
            await saveTrack('nightOne', 'Night One');
            await tracks.lockStoredTrack('nightOne', 'daily');
            const requested = dailyContract(1, 'nightOne');
            await writeChallenge(requested);
            known.mGet.mockClear();

            const reply = await player.getServerPlayerTrackPbSummaries({
                redditUsername: 'RacerOne', challengeIds: [requested.id],
            });

            expect(reply.trackPbs).toEqual({ [requested.id]: null });
            expect(TRACKS.nightOne.name).toBe('Night One');
            expect(known.mGet.mock.calls.flatMap(([keys]) => keys.filter((key) => key.includes(':track:'))))
                .toEqual([trackRecordKey('nightOne')]);
            expect(hashes.get('dailygp:challenges').size).toBe(1);
        });
    });

    it('keeps PB requests inside the canonical playlist and availability window', async () => {
        const expired = dailyContract(1, 'nightOne', { availableUntil: new Date(Date.now() - 1).toISOString() });
        const offPlaylist = dailyContract(8, 'nightOne', {
            availableUntil: new Date(Date.now() + 86_400_000).toISOString(),
        });
        await writeChallenge(dailyContract(0, 'circuit'));
        await writeChallenge(expired);
        await writeChallenge(offPlaylist);
        await withCatalogPin(async () => {
            known.mGet.mockClear();

            const reply = await player.getServerPlayerTrackPbSummaries({
                redditUsername: 'RacerOne', challengeIds: [expired.id, offPlaylist.id],
            });

            expect(reply.trackPbs).toEqual({ [expired.id]: null, [offPlaylist.id]: null });
            expect(known.mGet.mock.calls.flatMap(([keys]) => keys.filter((key) => key.includes(':track:')))).toEqual([]);
        });
    });
});
