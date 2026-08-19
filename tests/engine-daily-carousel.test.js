import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const playlistState = {
    cached: [],
    fetched: [],
    snapshots: new Map(),
    fetchedSnapshotIds: [],
};
let frameCallbacks = [];

function flushLobbyPaint() {
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()(0);
    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()(16);
}

vi.mock('../game/daily-challenge/service.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        cacheDailyChallengePlaylist: vi.fn((challenges) => {
            const byId = new Map(playlistState.cached.map((entry) => [entry.id, entry]));
            for (const challenge of challenges) byId.set(challenge.id, challenge);
            playlistState.cached = [...byId.values()];
            return playlistState.cached;
        }),
        getCachedDailyChallengePlaylist: vi.fn(() => playlistState.cached),
        getDailyChallengePlaylist: vi.fn(async () => {
            // The real service merges the response into the cache before it resolves.
            const byId = new Map(playlistState.cached.map((entry) => [entry.id, entry]));
            for (const entry of playlistState.fetched) byId.set(entry.id, entry);
            playlistState.cached = [...byId.values()];
            return playlistState.fetched;
        }),
        getCachedDailyChallengeSnapshot: vi.fn(
            (challengeId) => playlistState.snapshots.get(challengeId) || null,
        ),
        getDailyChallengeSnapshotIdsToFetch: vi.fn((ids) => (
            ids.filter((id) => !playlistState.snapshots.has(id))
        )),
        getDailyChallengeSnapshot: vi.fn(async ({ challengeId }) => {
            playlistState.fetchedSnapshotIds.push(challengeId);
            const snapshot = { playerRankLabel: '#7' };
            playlistState.snapshots.set(challengeId, snapshot);
            return snapshot;
        }),
    };
});

const { dailyChallengeEngineMethods } = await import(
    '../game/daily-challenge/engine-methods.js'
);
const { modeRouterEngineMethods } = await import('../game/modes/engine-methods.js');

function challenge(id, trackKey, challengeDate) {
    return {
        id,
        trackKey,
        challengeDate,
        startsAt: `${challengeDate}T00:00:00.000Z`,
        objectiveType: 'single_lap_fastest',
        skin: 'default',
    };
}

const DAY_TRACKS = ['circuit', 'sunlitTemple', 'royalPlateau', 'mistwoodSerpent'];
const CHALLENGES = DAY_TRACKS.map((trackKey, index) => challenge(
    `daily-${index}`,
    trackKey,
    `2026-07-${27 - index}`,
));

function createEngine(overrides = {}) {
    // The real rail holds the card it is on, and falls back to the first one.
    const carousel = { selectedChallengeId: null };
    const render = vi.fn((cards = [], options = {}) => {
        if (options.selectedChallengeId) {
            carousel.selectedChallengeId = options.selectedChallengeId;
            return;
        }
        carousel.selectedChallengeId ??= cards[0]?.challengeId ?? null;
    });
    const engine = {
        activeRaceMode: 'daily',
        status: 'ready',
        startButtonPending: false,
        startOverlay: { isStartOverlayVisible: () => true },
        lobbyUi: { getMode: () => 'daily' },
        prewarmDailyPlaylistTracks: vi.fn(),
        dailyCarousel: {
            render,
            selectChallenge: vi.fn(() => true),
            getSelectedChallenge: vi.fn(() => null),
            getSelectedChallengeId: vi.fn(() => carousel.selectedChallengeId),
        },
        selectedDailyChallengeId: null,
        currentDailyChallenge: null,
        trackPersonalBestByTrackKey: Object.create(null),
        trackPersonalBestResult: null,
        refreshTrackPersonalBestSummaries: vi.fn(async () => ({})),
        setDailyChallengeLobbySummary: vi.fn(),
        ...overrides,
    };
    engine.startOverlay = {
        isStartOverlayVisible: () => true,
        ...overrides.startOverlay,
    };
    engine.lobbyUi = {
        getMode: () => 'daily',
        ...overrides.lobbyUi,
    };
    engine.paintDailyCarousel = dailyChallengeEngineMethods.paintDailyCarousel.bind(engine);
    engine.dailyCarouselChallenges =
        dailyChallengeEngineMethods.dailyCarouselChallenges.bind(engine);
    engine.ensureDailyCarouselRank =
        dailyChallengeEngineMethods.ensureDailyCarouselRank.bind(engine);
    return { engine, render };
}

beforeEach(() => {
    frameCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
    }));
    playlistState.cached = [];
    playlistState.fetched = [];
    playlistState.snapshots = new Map();
    playlistState.fetchedSnapshotIds = [];
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('daily carousel engine wiring', () => {
    it('paints the cached run of days before the network answers', async () => {
        playlistState.cached = CHALLENGES.slice(0, 2);
        playlistState.fetched = CHALLENGES;
        const { engine, render } = createEngine();

        const pending = dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);

        expect(render).toHaveBeenCalledTimes(1);
        expect(render.mock.calls[0][0].map((card) => card.challengeId))
            .toEqual(['daily-0', 'daily-1']);
        expect(render.mock.calls[0][1]).toMatchObject({ loading: true });

        await pending;
        expect(render.mock.calls[1][0].map((card) => card.challengeId))
            .toEqual(CHALLENGES.map((entry) => entry.id));
    });

    it('keeps the cached run of days when the playlist answers with fewer', async () => {
        playlistState.cached = CHALLENGES;
        playlistState.fetched = [CHALLENGES[0]];
        const { engine, render } = createEngine({ selectedDailyChallengeId: 'daily-2' });

        await dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);

        const afterFetch = render.mock.calls[1];
        expect(afterFetch[0].map((card) => card.challengeId))
            .toEqual(CHALLENGES.map((entry) => entry.id));
        expect(afterFetch[1].selectedChallengeId).toBe('daily-2');
    });

    it('opens on the day the player last raced', async () => {
        playlistState.cached = CHALLENGES;
        playlistState.fetched = CHALLENGES;
        const { engine, render } = createEngine({ selectedDailyChallengeId: 'daily-2' });

        await dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);

        expect(render.mock.calls[0][1].selectedChallengeId).toBe('daily-2');
    });

    it('prefers an explicitly requested day over the remembered one', async () => {
        playlistState.cached = CHALLENGES;
        playlistState.fetched = CHALLENGES;
        const { engine, render } = createEngine({
            selectedDailyChallengeId: 'daily-2',
            currentDailyChallenge: CHALLENGES[0],
        });

        await dailyChallengeEngineMethods.refreshDailyCarousel.call(engine, {
            selectChallengeId: 'daily-3',
        });

        expect(render.mock.calls[0][1].selectedChallengeId).toBe('daily-3');
    });

    it("falls back to today's challenge on a first visit", async () => {
        playlistState.fetched = CHALLENGES;
        const { engine, render } = createEngine({ currentDailyChallenge: CHALLENGES[0] });

        await dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);

        expect(render.mock.calls[0][1].selectedChallengeId).toBe('daily-0');
    });

    it('asks for the rank of the day on screen and for no other', async () => {
        playlistState.cached = CHALLENGES;
        playlistState.fetched = CHALLENGES;
        playlistState.snapshots.set('daily-0', { playerRankLabel: '#1' });
        const { engine } = createEngine({ selectedDailyChallengeId: 'daily-2' });

        await dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);

        expect(playlistState.fetchedSnapshotIds).toEqual(['daily-2']);
    });

    it('asks for the day it opens on even when a rank is already saved', async () => {
        playlistState.cached = CHALLENGES;
        playlistState.fetched = CHALLENGES;
        playlistState.snapshots.set('daily-0', { playerRankLabel: '#1' });
        const { engine } = createEngine();

        await dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);

        expect(playlistState.fetchedSnapshotIds).toEqual(['daily-0']);
    });

    it('asks for the rank of the card a swipe settles on', () => {
        playlistState.cached = CHALLENGES;
        const { engine } = createEngine();

        dailyChallengeEngineMethods.handleDailyCarouselSettled.call(engine, {
            challenge: CHALLENGES[1],
        });

        expect(playlistState.fetchedSnapshotIds).toEqual(['daily-1']);
    });

    it('repaints the rail from the saved snapshots without asking again', () => {
        playlistState.cached = CHALLENGES;
        playlistState.snapshots.set('daily-0', { playerRankLabel: '#4' });
        const { engine, render } = createEngine();
        engine.repaintDailyCarouselFromCache =
            dailyChallengeEngineMethods.repaintDailyCarouselFromCache.bind(engine);

        engine.repaintDailyCarouselFromCache();

        expect(render.mock.calls.at(-1)[0][0]).toMatchObject({
            challengeId: 'daily-0',
            rankLabel: '#4',
            rankPending: false,
        });
        expect(playlistState.fetchedSnapshotIds).toEqual([]);
    });

    it('drops a superseded refresh so a stale playlist cannot repaint', async () => {
        playlistState.cached = CHALLENGES.slice(0, 1);
        playlistState.fetched = CHALLENGES;
        const { engine, render } = createEngine();

        const stale = dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);
        engine._dailyCarouselRenderToken += 1;
        await stale;

        expect(render).toHaveBeenCalledTimes(1);
    });

    it('survives a playlist request that fails', async () => {
        const { getDailyChallengePlaylist } = await import('../game/daily-challenge/service.js');
        getDailyChallengePlaylist.mockRejectedValueOnce(new Error('offline'));
        playlistState.cached = CHALLENGES.slice(0, 1);
        playlistState.snapshots.set('daily-0', { playerRankLabel: '#3' });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { engine, render } = createEngine();

        await dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);

        expect(render.mock.calls.at(-1)[0].map((card) => card.challengeId)).toEqual(['daily-0']);
        consoleError.mockRestore();
    });

    it('points the lobby summary at whichever card is centred', () => {
        const { engine } = createEngine();

        dailyChallengeEngineMethods.handleDailyCarouselSelect.call(engine, CHALLENGES[2]);

        expect(engine.selectedDailyChallengeId).toBe('daily-2');
        expect(engine.setDailyChallengeLobbySummary).toHaveBeenCalledWith(CHALLENGES[2]);
    });

    it('clears the lobby summary when the rail goes empty', () => {
        const setDailySelectedChallenge = vi.fn();
        const { engine } = createEngine({
            selectedDailyChallengeId: 'daily-1',
            lobbyUi: { setDailySelectedChallenge },
        });

        dailyChallengeEngineMethods.handleDailyCarouselSelect.call(engine, null);

        expect(engine.selectedDailyChallengeId).toBeNull();
        expect(setDailySelectedChallenge).toHaveBeenCalledWith(null, null);
        expect(engine.setDailyChallengeLobbySummary).toHaveBeenCalledWith(null);
    });

    it('lands on the day the standings were left on, not the one opened', () => {
        const selectChallenge = vi.fn(() => true);
        const openDailyChallengeLeaderboardForChallenge = vi.fn();
        const engine = {
            dailyCarousel: { selectChallenge },
            leaderboards: {
                openDailyChallengeLeaderboardForChallenge,
                getLastViewedDailyChallengeId: () => 'daily-3',
            },
        };
        engine.selectDailyCarouselChallenge =
            dailyChallengeEngineMethods.selectDailyCarouselChallenge.bind(engine);

        dailyChallengeEngineMethods.openDailyCarouselStandings.call(engine, CHALLENGES[0]);

        const [openedChallenge, returnMode, options] =
            openDailyChallengeLeaderboardForChallenge.mock.calls[0];
        expect(openedChallenge).toBe(CHALLENGES[0]);
        expect(returnMode).toBe('close');

        options.onClose();
        expect(selectChallenge).toHaveBeenCalledWith('daily-3');
    });

    it('falls back to the day it opened when the standings report nothing', () => {
        const selectChallenge = vi.fn(() => true);
        const openDailyChallengeLeaderboardForChallenge = vi.fn();
        const engine = {
            dailyCarousel: { selectChallenge },
            leaderboards: {
                openDailyChallengeLeaderboardForChallenge,
                getLastViewedDailyChallengeId: () => null,
            },
        };
        engine.selectDailyCarouselChallenge =
            dailyChallengeEngineMethods.selectDailyCarouselChallenge.bind(engine);

        dailyChallengeEngineMethods.openDailyCarouselStandings.call(engine, CHALLENGES[1]);
        openDailyChallengeLeaderboardForChallenge.mock.calls[0][2].onClose();

        expect(selectChallenge).toHaveBeenCalledWith('daily-1');
    });

    it('does not open standings for a card without a challenge', () => {
        const openDailyChallengeLeaderboardForChallenge = vi.fn();
        dailyChallengeEngineMethods.openDailyCarouselStandings.call(
            { leaderboards: { openDailyChallengeLeaderboardForChallenge } },
            null,
        );
        expect(openDailyChallengeLeaderboardForChallenge).not.toHaveBeenCalled();
    });

    it('shows the Daily pane before refreshing its carousel', () => {
        const refreshDailyCarousel = vi.fn();
        const engine = {
            status: 'ready',
            currentChallengeRun: null,
            startOverlay: {
                showStartOverlay: vi.fn(),
                isStartOverlayVisible: () => true,
            },
            lobbyUi: { showDaily: vi.fn(), getMode: () => 'daily' },
            reset: vi.fn(),
            refreshDailyCarousel,
        };

        modeRouterEngineMethods.showDailyLobby.call(engine, { selectChallengeId: 'daily-2' });

        expect(engine.activeRaceMode).toBe('daily');
        expect(engine.lobbyUi.showDaily).toHaveBeenCalled();
        expect(refreshDailyCarousel).not.toHaveBeenCalled();

        flushLobbyPaint();

        expect(refreshDailyCarousel).toHaveBeenCalledWith({ selectChallengeId: 'daily-2' });
    });

    it('drops the deferred Daily paint once race start is pending', () => {
        const refreshDailyCarousel = vi.fn();
        const engine = {
            status: 'ready',
            currentChallengeRun: null,
            startButtonPending: false,
            startOverlay: {
                showStartOverlay: vi.fn(),
                isStartOverlayVisible: () => true,
            },
            lobbyUi: { showDaily: vi.fn(), getMode: () => 'daily' },
            reset: vi.fn(),
            refreshDailyCarousel,
        };

        modeRouterEngineMethods.showDailyLobby.call(engine);
        frameCallbacks.shift()(0);
        engine.startButtonPending = true;
        frameCallbacks.shift()(16);

        expect(refreshDailyCarousel).not.toHaveBeenCalled();
    });

    it('does not repaint the Daily carousel after the race begins', () => {
        const { engine, render } = createEngine({ status: 'playing' });

        dailyChallengeEngineMethods.paintDailyCarousel.call(engine, CHALLENGES);

        expect(render).not.toHaveBeenCalled();
    });

    it('does not let a late Daily response repaint over a running race', async () => {
        let resolvePersonalBests;
        playlistState.cached = CHALLENGES;
        const personalBests = new Promise((resolve) => {
            resolvePersonalBests = resolve;
        });
        const { engine, render } = createEngine({
            refreshTrackPersonalBestSummaries: vi.fn(() => personalBests),
        });

        const refresh = dailyChallengeEngineMethods.refreshDailyCarousel.call(engine);
        expect(render).toHaveBeenCalledTimes(1);
        engine.status = 'playing';
        resolvePersonalBests({});
        await refresh;

        expect(render).toHaveBeenCalledTimes(1);
    });

    it('returns to the Daily pane on the day that was just raced', () => {
        const refreshDailyCarousel = vi.fn();
        const engine = {
            status: 'ready',
            activeRaceMode: 'daily',
            currentChallengeRun: null,
            selectedDailyChallengeId: 'daily-2',
            startOverlay: {
                showStartOverlay: vi.fn(),
                isStartOverlayVisible: () => true,
            },
            lobbyUi: { showDaily: vi.fn(), getMode: () => 'daily' },
            reset: vi.fn(),
            refreshDailyCarousel,
        };
        engine.showDailyLobby = modeRouterEngineMethods.showDailyLobby.bind(engine);

        modeRouterEngineMethods.returnToActiveLobby.call(engine);

        expect(refreshDailyCarousel).not.toHaveBeenCalled();
        flushLobbyPaint();
        expect(refreshDailyCarousel).toHaveBeenCalledWith({ selectChallengeId: 'daily-2' });
        expect(engine.selectedDailyChallengeId).toBe('daily-2');
    });

    it('repaints a server-confirmed medal when returning from the result sheet', () => {
        playlistState.cached = CHALLENGES;
        playlistState.fetched = CHALLENGES;
        const { engine, render } = createEngine({
            status: 'won',
            activeRaceMode: 'daily',
            activeDailyChallenge: CHALLENGES[0],
            lastPlayedDailyChallenge: CHALLENGES[0],
            currentChallengeRun: { challengeId: CHALLENGES[0].id },
            trackPersonalBestByTrackKey: {
                [CHALLENGES[0].id]: { bestTime: 1 },
            },
            startOverlay: {
                showStartOverlay: vi.fn(),
                isStartOverlayVisible: () => true,
            },
            lobbyUi: { showDaily: vi.fn(), getMode: () => 'daily' },
            reset: vi.fn(function reset() {
                this.activeDailyChallenge = null;
                this.currentChallengeRun = null;
                this.status = 'ready';
            }),
        });
        engine.refreshDailyCarousel =
            dailyChallengeEngineMethods.refreshDailyCarousel.bind(engine);
        engine.showDailyLobby = modeRouterEngineMethods.showDailyLobby.bind(engine);

        modeRouterEngineMethods.returnToActiveLobby.call(engine);
        flushLobbyPaint();

        const racedCard = render.mock.calls[0][0]
            .find((card) => card.challengeId === CHALLENGES[0].id);
        expect(racedCard).toMatchObject({ medal: 'author' });
        expect(racedCard.medalTiers.every((slot) => slot.filled)).toBe(true);
    });

    it('restores from the completed race even if hidden scroll state changed selection', () => {
        const refreshDailyCarousel = vi.fn();
        const engine = {
            status: 'finished',
            activeRaceMode: 'daily',
            activeDailyChallenge: CHALLENGES[3],
            lastPlayedDailyChallenge: CHALLENGES[3],
            selectedDailyChallengeId: 'daily-0',
            currentChallengeRun: { challengeId: 'daily-3' },
            startOverlay: {
                showStartOverlay: vi.fn(),
                isStartOverlayVisible: () => true,
            },
            lobbyUi: { showDaily: vi.fn(), getMode: () => 'daily' },
            reset: vi.fn(function reset() {
                this.activeDailyChallenge = null;
                this.currentChallengeRun = null;
                this.status = 'ready';
            }),
            refreshDailyCarousel,
        };
        engine.showDailyLobby = modeRouterEngineMethods.showDailyLobby.bind(engine);

        modeRouterEngineMethods.returnToActiveLobby.call(engine);

        expect(refreshDailyCarousel).not.toHaveBeenCalled();
        flushLobbyPaint();
        expect(refreshDailyCarousel).toHaveBeenCalledWith({
            selectChallengeId: 'daily-3',
        });
    });
});
