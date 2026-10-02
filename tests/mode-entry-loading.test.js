import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function racerForEntry() {
    const racer = Object.create(RealTimeRacer.prototype);
    racer.activeRaceMode = 'home';
    racer.installModeRuntime = vi.fn(async () => {});
    racer.cancelRacePreparation = vi.fn();
    racer.loadingScreen = { begin: vi.fn(), dismiss: vi.fn(async () => {}), showError: vi.fn() };
    racer.showDailyLobby = vi.fn(() => { racer.activeRaceMode = 'daily'; });
    racer.showCampaignLobby = vi.fn(() => { racer.activeRaceMode = 'campaign'; });
    racer.setDailyChallengeLobbySummary = vi.fn();
    racer.applyCampaignLobbyBootstrap = vi.fn();
    return racer;
}

describe('mode entry definition loading', () => {
    afterEach(() => vi.restoreAllMocks());

    it('keeps the race menu behind its loader until its warmup finishes', async () => {
        const racer = racerForEntry();
        const warm = deferred();
        racer.warmRaceMode = vi.fn(() => warm.promise);
        const entry = racer.activateMode('daily');
        await Promise.resolve();
        expect(racer.activeRaceMode).toBe('home');
        expect(racer.showDailyLobby).not.toHaveBeenCalled();
        expect(racer.loadingScreen.dismiss).not.toHaveBeenCalled();

        const challenge = { id: 'today', trackKey: 'circuit' };
        warm.resolve({ challenge });
        await entry;
        expect(racer.currentDailyChallenge).toBe(challenge);
        expect(racer.showDailyLobby).toHaveBeenCalledTimes(1);
        expect(racer.loadingScreen.dismiss).toHaveBeenCalledTimes(1);
    });

    it('retries a failed mode entry without exposing unloaded race choices', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const racer = racerForEntry();
        racer.warmRaceMode = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ bootstrap: { authoritative: true }, stage: { trackKey: 'numberZero' } });
        await racer.activateMode('campaign');
        expect(racer.showCampaignLobby).not.toHaveBeenCalled();
        expect(racer.loadingScreen.dismiss).not.toHaveBeenCalled();
        const retry = racer.loadingScreen.showError.mock.calls[0][1];
        retry();
        await vi.waitFor(() => expect(racer.showCampaignLobby).toHaveBeenCalledTimes(1));
        expect(racer.applyCampaignLobbyBootstrap).toHaveBeenCalledWith(
            { authoritative: true }, { paint: false },
        );
    });

    it('does not apply a late Daily contract after a different entry wins', async () => {
        const racer = racerForEntry();
        const daily = deferred();
        racer.warmRaceMode = vi.fn((mode) => mode === 'daily' ? daily.promise : Promise.resolve({
            bootstrap: { authoritative: true }, stage: { trackKey: 'numberZero' },
        }));
        const oldEntry = racer.activateMode('daily');
        await Promise.resolve();
        await racer.activateMode('campaign');
        daily.resolve({ challenge: { id: 'late', trackKey: 'circuit' } });
        await oldEntry;
        expect(racer.activeRaceMode).toBe('campaign');
        expect(racer.currentDailyChallenge).toBeUndefined();
        expect(racer.showDailyLobby).not.toHaveBeenCalled();
    });

    it('does not install a runtime whose download finishes after the player switches modes', async () => {
        const racer = racerForEntry();
        const dailyFile = deferred();
        racer.prefetchModeRuntime = vi.fn((mode) => mode === 'daily' ? dailyFile.promise : Promise.resolve());
        racer.warmRaceMode = vi.fn(async () => ({
            bootstrap: { authoritative: true }, stage: { trackKey: 'numberZero' },
        }));
        const oldEntry = racer.activateMode('daily');
        await racer.activateMode('campaign');
        dailyFile.resolve();
        await oldEntry;
        expect(racer.installModeRuntime.mock.calls).toEqual([['campaign']]);
        expect(racer.activeRaceMode).toBe('campaign');
    });

    it('shares pending background warming without installing or selecting that mode', async () => {
        const racer = racerForEntry();
        racer.currentChallengeRun = { id: 'active-attempt' };
        racer.activeRaceMode = 'challenge';
        const pending = deferred();
        const warm = vi.fn(() => pending.promise);
        racer.prefetchModeRuntime = vi.fn(async () => ({ methods: { warmDailyRaceDefinitions: warm } }));
        const first = racer.warmRaceMode('daily');
        const second = racer.warmRaceMode('daily');
        expect(first).toBe(second);
        await Promise.resolve();
        expect(warm).toHaveBeenCalledTimes(1);
        expect(warm.mock.instances[0]).toBe(racer);
        expect(racer.installModeRuntime).not.toHaveBeenCalled();
        pending.resolve({ challenge: { id: 'today' } });
        await first;
        expect(racer.activeRaceMode).toBe('challenge');
        expect(racer.currentChallengeRun).toEqual({ id: 'active-attempt' });
        expect(racer.currentDailyChallenge).toBeUndefined();
    });
});
