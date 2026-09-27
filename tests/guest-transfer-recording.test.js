import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisTestDouble } from './redis-test-double.js';

// Records what today's guest transfer stores, for a table of player cases.
// Each case seeds a guest and an account, shows the choice screen, runs the
// transfer the way the game does, and records every key the transfer
// changed. A change to the transfer code must keep every recording the same.
// To record again on purpose, run this file with -u, and read the snapshot
// diff before you commit it.

const redis = new RedisTestDouble();

vi.mock('@devvit/redis', () => ({
    redis,
    redisCompressed: redis,
}));

const {
    getGuestProgressSelection,
    getServerDailyGpChallenge,
    selectGuestProgress,
} = await import('../src/server/daily/daily-gp-store.ts');
const { campaignProgressKey } = await import('../src/server/campaign/campaign-progress-key.ts');
const { recordCompletedRace, recordHeadToHeadWin } = await import('../src/server/player/car-unlock-store.ts');
const { upsertPlayerProfile } = await import('../src/server/competition/competition-identity.ts');
const { toCampaignCompetition, toDailyCompetition } = await import('../src/server/competition/competition.ts');
const { upsertPlayerTrackPersonalBest } = await import('../src/server/competition/pb-ghost-store.ts');
const { racedListKey } = await import('../src/server/player/raced-list.ts');
const { RACED_LIST_FILL_READY_KEY } = await import('../src/server/player/raced-list-fill.ts');
const { TRACKS } = await import('../game/track/tracks.js');
const {
    CAMPAIGN_NUMBERS_SERIES_ID,
    CAMPAIGN_SERIES,
    getCampaignSeriesStages,
} = await import('../game/campaign/manifest.js');

const NOW = new Date('2026-09-27T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const NUMBERS = getCampaignSeriesStages(CAMPAIGN_NUMBERS_SERIES_ID);
const OTHER_SERIES = CAMPAIGN_SERIES.find((series) => series.id !== CAMPAIGN_NUMBERS_SERIES_ID);
const OTHER_STAGE = getCampaignSeriesStages(OTHER_SERIES.id)[0];
const SETTINGS = {
    carSkin: 'assets/cars/mr_mr_red.webp',
    trailId: 'gold',
    musicEnabled: false,
    carAudioEnabled: true,
    crashAutoRestartEnabled: false,
    crashRestartDelaySec: 0.8,
    pbGhostEnabled: true,
    pausePlacement: 'timer',
    pauseOnTimerEnabled: true,
    hideHudEnabled: false,
};

// Seven playable days, the last one today, and `archived` older days.
async function seedDays(archived = 0) {
    const days = [];
    for (let back = 6 + archived; back >= 0; back -= 1) {
        vi.setSystemTime(new Date(NOW.getTime() - back * DAY_MS));
        days.push(await getServerDailyGpChallenge());
    }
    vi.setSystemTime(NOW);
    return { archived: days.slice(0, archived), playable: days.slice(archived) };
}

function entryJson(playerId, bestTimeMs, extra = {}) {
    return JSON.stringify({
        playerId,
        displayName: playerId.startsWith('guest:') ? 'Guest racer' : 'Account racer',
        bestTimeMs,
        updatedAt: NOW.toISOString(),
        ...extra,
    });
}

// Writes a board's rows the way a race save leaves them, and lists the board.
async function seedBoard(competition, track, field, playerId, {
    entryMs = null,
    rankMs = entryMs,
    pbMs = null,
    rawEntry = null,
    entryExtra = {},
} = {}) {
    if (rawEntry !== null) {
        await redis.hSet(competition.entryHashKey, { [playerId]: rawEntry });
    } else if (entryMs !== null) {
        await redis.hSet(competition.entryHashKey, {
            [playerId]: entryJson(playerId, entryMs, { trackKey: competition.trackKey, ...entryExtra }),
        });
    }
    if (rankMs !== null) await redis.zAdd(competition.leaderboardKey, { member: playerId, score: rankMs });
    if (pbMs !== null) {
        await upsertPlayerTrackPersonalBest({
            playerId,
            competition,
            track,
            bestTimeMs: pbMs,
            checkpointTimesSec: null,
            ghost: null,
            updatedAt: NOW.toISOString(),
        });
    }
    await redis.hSet(racedListKey(playerId), { [field]: '1' });
}

function seedDay(challenge, playerId, rows) {
    return seedBoard(toDailyCompetition(challenge), TRACKS[challenge.trackKey], `daily:${challenge.id}`, playerId, rows);
}

function seedStage(stage, playerId, rows) {
    return seedBoard(
        toCampaignCompetition(stage.seriesId, stage),
        TRACKS[stage.trackKey],
        `campaign:${stage.raceId}`,
        playerId,
        { ...rows, entryExtra: { completedLaps: stage.lapCount, validationMethod: 'strict-replay', ...rows.entryExtra } },
    );
}

// A Campaign progress record with one result for each [stage, time, medal].
async function seedProgress(playerId, seriesId, results, rowExtra = {}) {
    await redis.set(campaignProgressKey(playerId, seriesId), JSON.stringify({
        campaignId: seriesId,
        startedAt: '2026-09-01T09:00:00.000Z',
        resultsByRaceId: Object.fromEntries(results.map(([stage, bestTimeMs, medal]) => [stage.raceId, {
            raceId: stage.raceId,
            trackKey: stage.trackKey,
            lapCount: stage.lapCount,
            rulesRevision: stage.rulesRevision,
            bestTimeMs,
            medal,
            checkpointTimesSec: null,
            updatedAt: '2026-09-01T09:30:00.000Z',
            ...rowExtra,
        }])),
        updatedAt: '2026-09-01T09:30:00.000Z',
    }));
}

function markFillReady() {
    return redis.set(RACED_LIST_FILL_READY_KEY, JSON.stringify({ completedAt: NOW.toISOString(), boards: 1 }));
}

function readable(value) {
    if (typeof value !== 'string' || !/^[[{]/.test(value)) return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function sortedObject(map, read = (value) => value) {
    return Object.fromEntries([...map.entries()]
        .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
        .map(([key, value]) => [key, read(value)]));
}

// Every stored key, with its value and the seconds it has left.
function storedKeys() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const keys = new Set([...redis.strings.keys(), ...redis.hashes.keys(), ...redis.sortedSets.keys()]);
    const stored = new Map();
    for (const key of keys) {
        if (redis._isExpired(key)) continue;
        const value = {};
        if (redis.strings.has(key)) value.string = readable(redis.strings.get(key));
        if (redis.hashes.has(key)) value.hash = sortedObject(redis.hashes.get(key), readable);
        if (redis.sortedSets.has(key)) value.sortedSet = sortedObject(redis.sortedSets.get(key));
        const expiresAt = redis.expiresAtSeconds.get(key);
        if (Number.isFinite(expiresAt)) value.expiresInSeconds = expiresAt - nowSeconds;
        stored.set(key, value);
    }
    return stored;
}

function changedKeys(before, after) {
    const changed = {};
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
        const was = before.get(key) ?? null;
        const now = after.get(key) ?? null;
        if (JSON.stringify(was) !== JSON.stringify(now)) changed[key] = { before: was, after: now };
    }
    return changed;
}

function replyOf(error) {
    return {
        error: error?.message ?? String(error),
        reason: error?.reason ?? null,
        statusCode: error?.statusCode ?? null,
    };
}

// The choice screen, then the choice, then each "continue" the server asks for.
async function runTransfer(guestPlayerId, redditPlayerId, choice) {
    const selection = await getGuestProgressSelection({ guestPlayerId, redditPlayerId }).catch(replyOf);
    const first = await selectGuestProgress({ guestPlayerId, redditPlayerId, choice }).catch((error) => error);
    const replies = [first];
    let reply = first;
    while (reply?.reason === 'progress_selection_continue' && replies.length < 20) {
        reply = await selectGuestProgress({
            guestPlayerId,
            redditPlayerId,
            choice,
            resume: true,
            transferId: reply.transferId,
        }).catch((error) => error);
        replies.push(reply);
    }
    return {
        selection,
        replies: replies.map((item) => (item instanceof Error ? replyOf(item) : item)),
    };
}

async function record(seed, choice) {
    const guestPlayerId = 'guest:recorded';
    const redditPlayerId = 'reddit:recorded';
    await seed(guestPlayerId, redditPlayerId);
    const before = storedKeys();
    const run = await runTransfer(guestPlayerId, redditPlayerId, choice);
    return { ...run, changes: changedKeys(before, storedKeys()) };
}

// Each case seeds the guest (g) and the account (a).
const CASES = {
    'only the guest has progress': async (g) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], g, { entryMs: 31000, pbMs: 31000 });
        await seedProgress(g, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[0], 31000, 'gold']]);
        await seedDay(playable[5], g, { entryMs: 41000, pbMs: 41000 });
        await recordCompletedRace(g);
        await upsertPlayerProfile({ playerId: g, preferences: { ...SETTINGS, musicEnabled: true } });
    },
    'only the account has progress': async (g, a) => {
        const { playable } = await seedDays();
        await recordCompletedRace(g);
        await seedStage(NUMBERS[0], a, { entryMs: 30000, pbMs: 30000 });
        await seedProgress(a, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[0], 30000, 'gold']]);
        await seedDay(playable[5], a, { entryMs: 40000, pbMs: 40000 });
        await upsertPlayerProfile({ playerId: a, preferences: SETTINGS });
    },
    'both raced, the guest is faster': async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], g, { entryMs: 30000, pbMs: 30000 });
        await seedStage(NUMBERS[0], a, { entryMs: 32000, pbMs: 32000 });
        await seedProgress(g, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[0], 30000, 'gold']]);
        await seedProgress(a, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[0], 32000, 'silver']]);
        await seedDay(playable[5], g, { entryMs: 40000, pbMs: 40000 });
        await seedDay(playable[5], a, { entryMs: 42000, pbMs: 42000 });
        await recordCompletedRace(g);
        await recordHeadToHeadWin(a, 'h2h-1');
        await upsertPlayerProfile({ playerId: g, preferences: { ...SETTINGS, carSkinDirt: 'rally-orange' } });
        await upsertPlayerProfile({ playerId: a, preferences: SETTINGS });
    },
    'both raced, the account is faster': async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], g, { entryMs: 32000, pbMs: 32000 });
        await seedStage(NUMBERS[0], a, { entryMs: 30000, pbMs: 30000 });
        await seedProgress(g, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[0], 32000, 'silver']]);
        await seedProgress(a, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[0], 30000, 'gold']]);
        await seedDay(playable[5], g, { entryMs: 42000, pbMs: 42000 });
        await seedDay(playable[5], a, { entryMs: 40000, pbMs: 40000 });
    },
    'both raced with equal times': async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], g, { entryMs: 31000, pbMs: 31000 });
        await seedStage(NUMBERS[0], a, { entryMs: 31000, pbMs: 31000 });
        await seedDay(playable[5], g, { entryMs: 41000, pbMs: 41000 });
        await seedDay(playable[5], a, { entryMs: 41000, pbMs: 41000 });
    },
    'the guest holds only personal bests': async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[1], g, { pbMs: 33000 });
        await seedDay(playable[4], g, { pbMs: 43000 });
        await seedDay(playable[4], a, { entryMs: 44000, pbMs: 44000 });
    },
    "the account's ranking lost step with its entry": async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], a, { entryMs: 30000, rankMs: 35000 });
        await seedStage(NUMBERS[0], g, { entryMs: 33000 });
        await seedDay(playable[5], a, { entryMs: 40000, rankMs: 45000 });
        await seedDay(playable[5], g, { entryMs: 43000 });
    },
    'a guest row is damaged': async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], g, { rawEntry: '{ not json', rankMs: 31000 });
        await seedDay(playable[5], g, { entryMs: 41000 });
        await seedDay(playable[5], a, { entryMs: 42000 });
    },
    'the guest has old rows': async (g) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], g, { entryMs: 31000, entryExtra: { validationMethod: 'legacy-physics' } });
        await seedProgress(g, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[1], 32000, 'gold']], { rulesRevision: 0 });
        await seedDay(playable[5], g, { entryMs: 41000 });
    },
    'the guest raced another series': async (g, a) => {
        await seedDays();
        await seedStage(OTHER_STAGE, g, { entryMs: 51000, pbMs: 51000 });
        await seedProgress(g, OTHER_SERIES.id, [[OTHER_STAGE, 51000, 'bronze']]);
        await seedStage(NUMBERS[0], a, { entryMs: 30000 });
        await seedProgress(a, CAMPAIGN_NUMBERS_SERIES_ID, [[NUMBERS[0], 30000, 'gold']]);
    },
    'archived days, raced lists complete': async (g, a) => {
        const { archived, playable } = await seedDays(2);
        await seedDay(archived[0], g, { entryMs: 41000 });
        await seedDay(archived[1], a, { entryMs: 39000 });
        await seedDay(playable[5], g, { entryMs: 42000 });
        await markFillReady();
    },
    'archived days, raced lists not complete': async (g, a) => {
        const { archived, playable } = await seedDays(2);
        await seedDay(archived[0], g, { entryMs: 41000 });
        await seedDay(archived[1], a, { entryMs: 39000 });
        await seedDay(playable[5], g, { entryMs: 42000 });
    },
    'equal personal bests with different details': async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], g, { entryMs: 31000 });
        await seedStage(NUMBERS[0], a, { entryMs: 31000 });
        await seedDay(playable[5], g, { entryMs: 41000 });
        await seedDay(playable[5], a, { entryMs: 41000 });
        for (const [playerId, checkpointTimesSec, updatedAt] of [
            [g, [10.1, 20.2], '2026-09-20T10:00:00.000Z'],
            [a, [10.5, 20.9], '2026-09-21T10:00:00.000Z'],
        ]) {
            for (const [competition, track] of [
                [toCampaignCompetition(NUMBERS[0].seriesId, NUMBERS[0]), TRACKS[NUMBERS[0].trackKey]],
                [toDailyCompetition(playable[5]), TRACKS[playable[5].trackKey]],
            ]) {
                await upsertPlayerTrackPersonalBest({
                    playerId,
                    competition,
                    track,
                    bestTimeMs: competition.mode === 'daily' ? 41000 : 31000,
                    checkpointTimesSec,
                    ghost: null,
                    updatedAt,
                });
            }
        }
    },
    'the guest started a later series without results': async (g, a) => {
        await seedDays();
        await redis.set(campaignProgressKey(g, OTHER_SERIES.id), JSON.stringify({
            campaignId: OTHER_SERIES.id,
            startedAt: '2026-09-25T09:00:00.000Z',
            resultsByRaceId: {},
            updatedAt: '2026-09-25T09:00:00.000Z',
        }));
        await seedStage(NUMBERS[0], g, { entryMs: 31000 });
        await seedStage(NUMBERS[0], a, { entryMs: 30000 });
    },
    'the guest is faster on a later-series stage the account raced': async (g, a) => {
        await seedDays();
        await seedStage(OTHER_STAGE, g, { entryMs: 50000, pbMs: 50000 });
        await seedStage(OTHER_STAGE, a, { entryMs: 52000, pbMs: 52000 });
        await seedProgress(g, OTHER_SERIES.id, [[OTHER_STAGE, 50000, 'silver']]);
        await seedProgress(a, OTHER_SERIES.id, [[OTHER_STAGE, 52000, 'bronze']]);
    },
    'the guest holds a personal best where the account never raced': async (g) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[2], g, { pbMs: 34000 });
        await seedDay(playable[3], g, { pbMs: 45000 });
    },
    "the account's ranking lost step where the guest never raced": async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[1], a, { entryMs: 30000, rankMs: 36000 });
        await seedDay(playable[2], a, { entryMs: 40000, rankMs: 46000 });
        await seedStage(NUMBERS[0], g, { entryMs: 33000 });
        await seedDay(playable[5], g, { entryMs: 43000 });
    },
    'the guest has old Daily rows and an old ghost format': async (g, a) => {
        const { playable } = await seedDays();
        await seedDay(playable[5], g, { entryMs: 41000, entryExtra: { validationMethod: 'legacy-physics' } });
        await seedDay(playable[5], a, { entryMs: 42000 });
        // A real stored personal best, with the ghost format of an older version.
        await seedDay(playable[4], g, { entryMs: 43000, pbMs: 43000 });
        const board = toDailyCompetition(playable[4]);
        const field = createHash('sha256').update(g, 'utf8').digest('base64url');
        const stored = JSON.parse(await redis.hGet(board.pbHashKey, field));
        await redis.hSet(board.pbHashKey, { [field]: JSON.stringify({ ...stored, schemaVersion: 1 }) });
        await seedStage(NUMBERS[0], g, { entryMs: 31000 });
    },
    "the account's old entry lost step with its ranking": async (g, a) => {
        const { playable } = await seedDays();
        await seedStage(NUMBERS[0], a, {
            entryMs: 30000,
            rankMs: 35000,
            entryExtra: { validationMethod: 'legacy-physics' },
        });
        await seedStage(NUMBERS[0], g, { entryMs: 33000 });
        await seedDay(playable[5], g, { entryMs: 43000 });
    },
    'a long Daily history that moves in pieces': async (g, a) => {
        const { archived } = await seedDays(70);
        for (const [index, day] of archived.entries()) {
            await seedDay(day, g, { entryMs: 41000 + index });
            if (index % 3 === 0) await seedDay(day, a, { entryMs: 40500 + index * 2 });
        }
        await markFillReady();
    },
};

describe('guest transfer recordings', () => {
    beforeEach(() => {
        redis.reset();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    for (const [name, seed] of Object.entries(CASES)) {
        for (const choice of ['merge', 'account']) {
            it(`${name} (${choice})`, async () => {
                expect(await record(seed, choice)).toMatchSnapshot();
            });
        }
    }

    it('both raced, the guest is faster (a Keep guest request)', async () => {
        expect(await record(CASES['both raced, the guest is faster'], 'guest')).toMatchSnapshot();
    });

    // A transfer that stops at any saved step, and then runs again, must end
    // with the same stored data as a transfer that never stopped.
    for (const [name, choice] of [
        ['both raced, the guest is faster', 'merge'],
        ['both raced, the guest is faster', 'account'],
        ['a long Daily history that moves in pieces', 'merge'],
    ]) {
        it(`${name} (${choice}): stops at each saved step, then finishes the same`, async () => {
            const clean = await record(CASES[name], choice);
            const expected = storedKeys();
            let stops = 0;
            for (let stopAt = 1; stopAt < 40; stopAt += 1) {
                redis.reset();
                await CASES[name]('guest:recorded', 'reddit:recorded');
                redis.failTransferRecordWriteAt = stopAt;
                let run = await runTransfer('guest:recorded', 'reddit:recorded', choice);
                const stopped = redis.failTransferRecordWriteAt === null;
                redis.failTransferRecordWriteAt = null;
                if (!stopped) break;
                stops += 1;
                for (let retry = 0; retry < 10 && run.replies.at(-1)?.status !== 'completed'; retry += 1) {
                    run = await runTransfer('guest:recorded', 'reddit:recorded', choice);
                }
                expect(run.replies.at(-1)).toMatchObject({ status: 'completed' });
                expect(changedKeys(expected, storedKeys()), `stopped at saved step ${stopAt}`).toEqual({});
            }
            expect(clean.replies.at(-1)).toMatchObject({ status: 'completed' });
            expect(stops).toBeGreaterThan(2);
        });
    }
});
