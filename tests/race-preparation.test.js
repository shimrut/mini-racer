import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const assets = vi.hoisted(() => ({
    getTrackRuntimeAsset: vi.fn((trackKey) => ({ kind: 'runtime', trackKey })),
    getTrackCanvasAsset: vi.fn((trackKey) => ({ kind: 'canvas', trackKey, canvas: {}, origin: { x: 0, y: 0 } })),
}));
vi.mock('../game/track/assets.js', () => assets);

const service = vi.hoisted(() => ({
    ensureStoredTracks: vi.fn(async () => {}),
}));
vi.mock('../game/track/stored-track-service.js', () => service);

const { createRacePreparation, PREPARATION_SLOTS } = await import('../game/track/race-preparation.js');
const { loadClientTrack } = await import('../game/track/client-registry.js');
const { registerStoredTrack, clearStoredTracksForTests } = await import('../game/track/stored-tracks.js');

function preparation(options = {}) {
    return createRacePreparation({
        getAssetOptions: () => ({ qualityLevel: 1, frameSkip: 0 }),
        ...options,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

afterEach(() => {
    clearStoredTracksForTests();
});

describe('race preparation', () => {
    it('confirms, loads and builds a track once, and keeps the built parts', async () => {
        const races = preparation();
        const record = await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps' });

        expect(service.ensureStoredTracks).toHaveBeenCalledWith(['smallSteps'], { requireConfirmation: true });
        expect(record).toMatchObject({
            trackKey: 'smallSteps',
            runtime: { kind: 'runtime' },
            canvasAsset: { kind: 'canvas' },
        });
        expect(races.isReady('smallSteps')).toBe(true);
        expect(races.findRecord('smallSteps')).toBe(record);
    });

    it('shares a target between slots instead of building it again', async () => {
        const races = preparation();
        const first = await races.prepare(PREPARATION_SLOTS.DAILY, { trackKey: 'smallSteps' });
        const second = await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps' });

        expect(second).toBe(first);
        expect(assets.getTrackCanvasAsset).toHaveBeenCalledTimes(1);
    });

    it('keeps a record whose parts left the asset caches', async () => {
        const races = preparation();
        const record = await races.prepare(PREPARATION_SLOTS.DAILY, { trackKey: 'smallSteps' });
        // Other tracks fill the caches; a new lookup would build new parts.
        assets.getTrackCanvasAsset.mockReturnValue({ kind: 'rebuilt' });
        for (const trackKey of ['numberOne', 'numberTwo', 'numberThree']) {
            await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey });
        }

        expect(races.findRecord('smallSteps')).toBe(record);
        expect(races.findRecord('smallSteps').canvasAsset.kind).toBe('canvas');
        assets.getTrackCanvasAsset.mockReset();
        assets.getTrackCanvasAsset.mockImplementation((trackKey) => ({ kind: 'canvas', trackKey, canvas: {}, origin: { x: 0, y: 0 } }));
    });

    it('drops a late answer for an older target of the same slot', async () => {
        const races = preparation();
        let releaseConfirm;
        service.ensureStoredTracks.mockImplementationOnce(() => new Promise((resolve) => {
            releaseConfirm = resolve;
        }));
        const older = races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'numberOne' });
        const newer = await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'numberTwo' });
        releaseConfirm();

        expect(await older).toBeNull();
        expect(newer.trackKey).toBe('numberTwo');
        expect(races.getSlotState(PREPARATION_SLOTS.SELECTED)).toMatchObject({ trackKey: 'numberTwo', ready: true });
        expect(races.isReady('numberOne')).toBe(false);
    });

    it('reports a failed confirmation, and prepares again on retry', async () => {
        const races = preparation();
        service.ensureStoredTracks.mockRejectedValueOnce(new Error('The track layout could not be confirmed. Retry before racing.'));

        await expect(races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps' }))
            .rejects.toThrow('Retry before racing');
        expect(races.getSlotState(PREPARATION_SLOTS.SELECTED)).toMatchObject({ ready: false });
        expect(races.getSlotState(PREPARATION_SLOTS.SELECTED).error).toBeInstanceOf(Error);
        expect(races.isReady('smallSteps')).toBe(false);

        await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps' });
        expect(races.isReady('smallSteps')).toBe(true);
    });

    it('skips the server check when the target needs none', async () => {
        const races = preparation({ needsConfirmation: () => false });
        await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps' });
        expect(service.ensureStoredTracks).not.toHaveBeenCalled();
    });

    it('stops being ready when the confirmed layout changes', async () => {
        const races = preparation();
        await races.prepare(PREPARATION_SLOTS.DAILY, { trackKey: 'smallSteps' });
        const app = await loadClientTrack('smallSteps');
        registerStoredTrack({
            key: 'smallSteps',
            name: app.name,
            ground: 'tarmac',
            medalRow: null,
            track: { ...app, startAngle: app.startAngle + 1 },
        });

        expect(races.isReady('smallSteps')).toBe(false);
        expect(races.getSlotState(PREPARATION_SLOTS.DAILY).ready).toBe(false);
    });

    it('waits before the build, and stops it when the caller says so', async () => {
        const races = preparation();
        let stillWanted = true;
        const beforeBuild = vi.fn(async () => stillWanted);
        await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps', beforeBuild });
        expect(beforeBuild).toHaveBeenCalledTimes(1);
        expect(races.isReady('smallSteps')).toBe(true);

        stillWanted = false;
        expect(await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'numberOne', beforeBuild })).toBeNull();
        expect(races.isReady('numberOne')).toBe(false);
        expect(assets.getTrackCanvasAsset).toHaveBeenCalledTimes(1);
        expect(races.getSlotState(PREPARATION_SLOTS.SELECTED)).toBeNull();
    });

    it('tells its listeners when a target becomes ready', async () => {
        const races = preparation();
        const listener = vi.fn();
        races.subscribe(listener);
        await races.prepare(PREPARATION_SLOTS.SELECTED, { trackKey: 'smallSteps' });
        expect(listener).toHaveBeenCalled();
        expect(races.getSlotState(PREPARATION_SLOTS.SELECTED).ready).toBe(true);
    });
});
