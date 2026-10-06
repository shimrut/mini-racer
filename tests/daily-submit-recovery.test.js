import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'reddit:daily-recovery';
const CHALLENGE = {
    id: 'daily-submit-recovery',
    trackKey: 'circuit',
    objectiveType: 'single_lap_fastest',
    availableUntil: '2099-01-01T00:00:00.000Z',
};
const REPLAY = { inputs: [{ frames: 1, left: false, right: false }] };
let queue;
let owner;
let dailyStorage;
let dailyMethods;
let scoreboardMethods;
let fetchMock;

async function loadModules() {
    vi.resetModules();
    const modules = await Promise.all([
        import('../game/scoreboard/verification-queue.js'),
        import('../game/player/active-owner.js'),
        import('../game/daily-challenge/storage.js'),
        import('../game/daily-challenge/engine-methods.js'),
        import('../game/scoreboard/engine-methods.js'),
    ]);
    [queue, owner, dailyStorage] = modules;
    dailyMethods = modules[3].dailyChallengeEngineMethods;
    scoreboardMethods = modules[4].scoreboardEngineMethods;
    owner.setActivePlayerOwnerId(OWNER);
}

function createEngine() {
    const engine = {
        ...scoreboardMethods,
        currentTrackKey: CHALLENGE.trackKey,
        currentChallengeRun: {
            challengeId: CHALLENGE.id, trackKey: CHALLENGE.trackKey,
            completedLaps: 1, recentLaps: [], bestLapSecBeforeLastLap: null,
        },
        activeDailyChallenge: CHALLENGE,
        playerProfileAuthoritative: true,
        isValidatedWinData: () => true,
        status: 'playing', cachedSpeed: 0,
        currentRunPolicy: { bestResultComparator: 'time' },
        dailyChallengeBestResult: dailyStorage.getDailyChallengeData(CHALLENGE.id),
        trackPersonalBestResult: null, bestLapTime: null,
        sessionBestLapSecByTrackKey: {}, sessionBestCheckpointTimesByTrackKey: {},
        hud: { syncHud: vi.fn(), setBestTime: vi.fn() },
        dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
        modal: {
            showModal: vi.fn(), updateModalScoreboardSnapshot: vi.fn(),
            matchesModalScoreboardContext: () => true,
        },
        leaderboards: {
            refreshDailyChallengeAfterAcceptedSubmission: vi.fn(async () => ({
                playerRank: 3, playerRankLabel: '#3', isLoading: false,
            })),
        },
        scoreboardReplay: { getPayload: () => REPLAY },
        scheduleVerificationQueueProcessing: vi.fn(),
    };
    engine.processVerificationQueue = () => {
        engine.processing = scoreboardMethods.processVerificationQueue.call(engine);
        return engine.processing;
    };
    return engine;
}

async function finish(engine, time) {
    dailyMethods.handleDailyChallengeWin.call(engine, { lapTime: time, completedLaps: 1 });
    await engine.processing;
}

describe('Daily submission recovery after a terminal failure', () => {
    beforeEach(async () => {
        const storage = new Map();
        globalThis.window = {
            location: { hostname: 'hosted.example', protocol: 'https:' },
            localStorage: {
                getItem: (key) => storage.get(key) ?? null,
                setItem: (key, value) => storage.set(key, String(value)),
                removeItem: (key) => storage.delete(key),
            },
        };
        await loadModules();
        queue.resetVerificationQueueForTests();
        fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Replay rejected' }), { status: 400 }))
            .mockImplementation(async (_url, options) => {
                const { bestTime } = JSON.parse(options.body);
                return new Response(JSON.stringify({
                    accepted: true, improved: true, bestTimeMs: bestTime * 1000,
                    completedLaps: 1, playerRank: 3, leaderboardEntryCount: 5,
                }), { status: 200 });
            });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        owner.clearActivePlayerOwnerId();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        delete globalThis.window;
    });

    it.each([
        { previousBest: null, nextTime: 11, reload: false },
        { previousBest: 12, nextTime: 11, reload: false },
        { previousBest: 12, nextTime: 10, reload: false },
        { previousBest: 12, nextTime: 11, reload: true },
    ])('submits $nextTime seconds after rejected 10 seconds (prior $previousBest, reload $reload)', async ({ previousBest, nextTime, reload }) => {
        if (previousBest !== null) dailyStorage.setDailyChallengeBestTime(CHALLENGE, previousBest, 1);
        let engine = createEngine();
        await finish(engine, 10);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(queue.getDailyChallengeVerificationEntry(CHALLENGE.id)).toMatchObject({
            bestTime: 10, verificationState: 'error', nextAttemptAt: null,
        });
        expect(engine.dailyChallengeBestResult?.bestTime ?? null).toBe(previousBest);

        if (reload) {
            await loadModules();
            expect(queue.getDailyChallengeVerificationEntry(CHALLENGE.id)?.verificationState).toBe('error');
            engine = createEngine();
        }
        await finish(engine, nextTime);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).bestTime)).toEqual([10, nextTime]);
        expect(engine.modal.showModal.mock.lastCall[2].scoreboardSnapshot).toMatchObject({
            verificationState: 'pending', submissionStage: 'submitting',
        });
        expect(engine.modal.updateModalScoreboardSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
            playerRankLabel: '#3', isLoading: false,
        }));
        expect(dailyStorage.getDailyChallengeData(CHALLENGE.id)?.bestTime).toBe(nextTime);
        expect(queue.getDailyChallengeVerificationEntry(CHALLENGE.id)).toBe(null);
    });
});
