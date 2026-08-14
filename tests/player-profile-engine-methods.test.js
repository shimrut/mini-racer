import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageMocks = vi.hoisted(() => ({
    getPlayerProgressState: vi.fn(),
}));
const preferencesMocks = vi.hoisted(() => ({
    queuePlayerPreferencesSave: vi.fn(),
}));

vi.mock('../game/storage.js', () => ({
    getPlayerProgressState: storageMocks.getPlayerProgressState,
}));
vi.mock('../game/player/preferences.js', async (importOriginal) => ({
    ...(await importOriginal()),
    queuePlayerPreferencesSave: preferencesMocks.queuePlayerPreferencesSave,
}));

import { playerProfileEngineMethods } from '../game/player/engine-methods.js';
import { buildCarUnlockSnapshot } from '../game/car/car-unlock-policy.js';
import {
    clearActivePlayerOwnerId,
    setActivePlayerOwnerId,
} from '../game/player/active-owner.js';
import {
    enqueueDailyChallengeVerification,
    resetVerificationQueueForTests,
} from '../game/scoreboard/verification-queue.js';

const UNLOCKED_CAR = 'assets/cars/mr_extra_crimson.webp';

function createEngine(overrides = {}) {
    return {
        ...playerProfileEngineMethods,
        applyCarUnlockSnapshot: vi.fn(),
        applyPersistedPlayerPreferences: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('player profile engine methods', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        const map = new Map();
        globalThis.window = {
            localStorage: {
                getItem: (key) => (map.has(key) ? map.get(key) : null),
                setItem: (key, value) => map.set(key, String(value)),
                removeItem: (key) => map.delete(key),
            },
        };
        resetVerificationQueueForTests();
        clearActivePlayerOwnerId();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        clearActivePlayerOwnerId();
        delete globalThis.window;
    });

    it('applies confirmed unlocks and preferences from an authoritative bootstrap', async () => {
        const engine = createEngine();
        const carUnlocks = buildCarUnlockSnapshot({ completedRace: true });

        await engine.applyPlayerProgressState({
            hasAnyData: true,
            isReturningPlayer: true,
            redditUsername: '  RaceFan  ',
            playerPreferences: { carSkin: UNLOCKED_CAR },
            carUnlocks,
            authoritative: true,
        });

        expect(engine.redditUsername).toBe('RaceFan');
        expect(engine.applyCarUnlockSnapshot)
            .toHaveBeenCalledWith(carUnlocks, { authoritative: true });
        expect(engine.applyPersistedPlayerPreferences)
            .toHaveBeenCalledWith({ carSkin: UNLOCKED_CAR }, { loadCar: true });
        expect(preferencesMocks.queuePlayerPreferencesSave).not.toHaveBeenCalled();
    });

    it('saves preferences only when the server confirmed it has none', async () => {
        const engine = createEngine();

        await engine.applyPlayerProgressState({ playerPreferences: null, authoritative: true });

        expect(preferencesMocks.queuePlayerPreferencesSave).toHaveBeenCalledTimes(1);
    });

    it('writes nothing back when the bootstrap never answered', async () => {
        const engine = createEngine();

        await engine.applyPlayerProgressState({
            playerPreferences: { carSkin: UNLOCKED_CAR },
            carUnlocks: null,
            authoritative: false,
        });

        expect(engine.applyCarUnlockSnapshot)
            .toHaveBeenCalledWith(null, { authoritative: false });
        expect(engine.applyPersistedPlayerPreferences).not.toHaveBeenCalled();
        expect(preferencesMocks.queuePlayerPreferencesSave).not.toHaveBeenCalled();
    });

    it('retries a failed bootstrap and applies the profile once it answers', async () => {
        const engine = createEngine();
        const carUnlocks = buildCarUnlockSnapshot({ completedRace: true });
        storageMocks.getPlayerProgressState
            .mockResolvedValueOnce({ authoritative: false })
            .mockResolvedValueOnce({ authoritative: true, carUnlocks, playerPreferences: null });

        engine.schedulePlayerProfileRecovery();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(storageMocks.getPlayerProgressState).toHaveBeenCalledTimes(1);
        expect(engine.applyCarUnlockSnapshot).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(30_000);

        expect(engine.applyCarUnlockSnapshot)
            .toHaveBeenCalledWith(carUnlocks, { authoritative: true });
        expect(engine._playerProfileRecovery).toBeNull();
    });

    it('stops asking after the third timed attempt', async () => {
        const engine = createEngine();
        storageMocks.getPlayerProgressState.mockResolvedValue({ authoritative: false });

        engine.schedulePlayerProfileRecovery();
        await vi.advanceTimersByTimeAsync(5_000 + 30_000 + 120_000 + 600_000);

        expect(storageMocks.getPlayerProgressState).toHaveBeenCalledTimes(3);
    });

    it('runs one recovery at a time', async () => {
        const engine = createEngine();
        storageMocks.getPlayerProgressState.mockResolvedValue({ authoritative: false });

        const first = engine.schedulePlayerProfileRecovery();
        const second = engine.schedulePlayerProfileRecovery();
        await vi.advanceTimersByTimeAsync(5_000);

        expect(first).not.toBeNull();
        expect(second).toBeNull();
        expect(storageMocks.getPlayerProgressState).toHaveBeenCalledTimes(1);
        engine.stopPlayerProfileRecovery();
    });

    it('starts sending claimed waiting runs once identity answers', () => {
        enqueueDailyChallengeVerification({
            challengeId: 'daily-gp-2031-08-14',
            challengeDate: '2031-08-14',
            trackKey: 'circuit',
            bestTime: 11.111,
            replay: { inputs: [{ frames: 1, left: false, right: false }] },
        });
        setActivePlayerOwnerId('guest:racer');
        const engine = createEngine({
            processVerificationQueue: vi.fn().mockResolvedValue(undefined),
            dailyChallengeUi: { refreshDailyChallengeVerificationState: vi.fn() },
            refreshCampaignVerificationOverlay: vi.fn(),
        });

        engine.claimQueuedResultsForOwner();

        expect(engine.dailyChallengeUi.refreshDailyChallengeVerificationState)
            .toHaveBeenCalledWith('daily-gp-2031-08-14');
        expect(engine.processVerificationQueue).toHaveBeenCalledTimes(1);
    });

    it('keeps chasing the profile when a recovery attempt throws', async () => {
        const engine = createEngine();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        storageMocks.getPlayerProgressState
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ authoritative: true, carUnlocks: null, playerPreferences: null });

        engine.schedulePlayerProfileRecovery();
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(30_000);

        expect(storageMocks.getPlayerProgressState).toHaveBeenCalledTimes(2);
        expect(engine._playerProfileRecovery).toBeNull();
    });
});
