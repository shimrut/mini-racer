import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The race picture is built for real in the game; here a stand-in records
// which track it was built for.
vi.mock('../game/track/assets.js', () => ({
    getTrackRuntimeAsset: vi.fn((trackKey) => ({
        trackKey,
        outer: [],
        inner: [],
        collisionSegments: [],
        collisionHash: new Map(),
    })),
    getTrackCanvasAsset: vi.fn((trackKey) => ({ canvas: { trackKey }, origin: { x: 0, y: 0 } })),
    getTrackPreviewGeometry: vi.fn(() => ({ outer: [], inner: [] })),
}));

const { trackEngineMethods } = await import('../game/track/engine-methods.js');
const { raceEngineMethods } = await import('../game/race/engine-methods.js');
const { dailyChallengeEngineMethods } = await import('../game/daily-challenge/engine-methods.js');
const { PREPARATION_SLOTS } = await import('../game/track/race-preparation.js');
const { clearStoredTrackChecksForTests } = await import('../game/track/stored-track-service.js');
const { loadClientTrack } = await import('../game/track/client-registry.js');

let originalDocument;

beforeEach(() => {
    originalDocument = globalThis.document;
    globalThis.document = { activeElement: null };
    clearStoredTrackChecksForTests();
});

afterEach(() => {
    globalThis.document = originalDocument;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// A hosted page: not localhost, so every layout needs the server's answer.
function stubHostedWindow() {
    vi.stubGlobal('window', {
        location: { hostname: 'reddit.example', pathname: '/game.html' },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
}

async function lobbyEngine(calls) {
    const previous = await loadClientTrack('numberOne');
    return {
        ...trackEngineMethods,
        ...raceEngineMethods,
        handleStartDailyChallenge: dailyChallengeEngineMethods.handleStartDailyChallenge,
        status: 'ready',
        trackLoadRequestId: 0,
        currentTrackKey: 'numberOne',
        currentTrack: previous,
        trackCanvas: { trackKey: 'numberOne' },
        activeGeometry: {},
        particles: [],
        camera: { x: 0, y: 0 },
        zoom: 1,
        viewportWidth: 100,
        viewportHeight: 100,
        pendingStartFrame: null,
        activeRunId: 0,
        skidMarks: { clear() {} },
        routeTrace: { clear() {} },
        runHistory: { clear() {} },
        pbGhost: { clearTrack() {}, clearPrepared() {} },
        hud: { setBestTime() {}, setGround() {}, setPauseVisible() {}, resetCountdown() {}, resetHud() {} },
        clearTimers() {},
        clearSteeringInput() {},
        clearDailyChallengeRun() {},
        clearRaceComparisonTarget() {},
        syncCurrentRunPolicy() {},
        requestRender() {},
        applyDailyChallenge() {},
        resize({ render } = {}) {
            if (render) calls.push(`draw:${this.trackCanvas?.trackKey}`);
        },
        modal: { closeModal: () => calls.push('closeModal') },
        startOverlay: {
            hideStartOverlay: () => calls.push('hideLobby'),
            showStartOverlay: () => calls.push('showLobby'),
            beginRaceStartTransition: () => {
                calls.push('lobbyFade');
                return Promise.resolve();
            },
        },
        startSequence: () => calls.push('countdown'),
        lobbyUi: { clearRaceStartError() {}, setRaceStartError: vi.fn(), setStartTrackReady() {} },
    };
}

describe('an instant race start', () => {
    it('starts a prepared track with no request, and draws it before the lobby leaves', async () => {
        stubHostedWindow();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tracks: [] }) })));
        const calls = [];
        const engine = await lobbyEngine(calls);
        const challenge = { id: 'day-2', trackKey: 'smallSteps' };
        await engine.prepareRaceTrack(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps', challenge });
        expect(fetch).toHaveBeenCalledTimes(1);
        fetch.mockClear();

        await engine.handleStartDailyChallenge(challenge);

        expect(fetch).not.toHaveBeenCalled();
        expect(engine.currentTrackKey).toBe('smallSteps');
        expect(calls).not.toContain('hideLobby');
        expect(calls).toEqual(['draw:smallSteps', 'closeModal', 'lobbyFade', 'countdown']);
    });

    it('prepares a track that is not ready before it starts, while the lobby stays', async () => {
        stubHostedWindow();
        let answer;
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
            answer = () => resolve({ ok: true, json: async () => ({ tracks: [] }) });
        })));
        const calls = [];
        const engine = await lobbyEngine(calls);
        const challenge = { id: 'day-3', trackKey: 'smallSteps' };

        const start = engine.handleStartDailyChallenge(challenge);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toEqual([]);
        expect(engine.currentTrackKey).toBe('numberOne');

        answer();
        await start;
        expect(calls).toEqual(['draw:smallSteps', 'closeModal', 'lobbyFade', 'countdown']);
    });

    it('never starts a race when its track cannot be confirmed', async () => {
        stubHostedWindow();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const calls = [];
        const engine = await lobbyEngine(calls);

        await engine.handleStartDailyChallenge({ id: 'day-4', trackKey: 'smallSteps' });

        expect(calls).not.toContain('countdown');
        expect(engine.currentTrackKey).toBe('numberOne');
        expect(engine.lobbyUi.setRaceStartError).toHaveBeenCalledWith('daily', expect.stringContaining('Retry'));
    });

    it('treats the installed track as ready only when its layout is confirmed', async () => {
        stubHostedWindow();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tracks: [] }) })));
        const engine = await lobbyEngine([]);
        expect(engine.isRaceTrackReady('numberOne')).toBe(false);

        const { ensureStoredTracks } = await import('../game/track/stored-track-service.js');
        await ensureStoredTracks(['numberOne'], { requireConfirmation: true });
        expect(engine.isRaceTrackReady('numberOne')).toBe(true);
    });
});
