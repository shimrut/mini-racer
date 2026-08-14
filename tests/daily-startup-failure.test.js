import { describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
    getActiveDailyChallenge: vi.fn(),
}));

vi.mock('../game/daily-challenge/service.js', async (importOriginal) => ({
    ...await importOriginal(),
    getActiveDailyChallenge: serviceMocks.getActiveDailyChallenge,
}));

import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';

describe('direct Daily startup failure', () => {
    it('rejects the critical plan instead of preparing the Home track', async () => {
        const offline = new Error('offline');
        serviceMocks.getActiveDailyChallenge.mockRejectedValueOnce(offline);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const setDailyChallengeSummary = vi.fn();
        const syncReadyBackgroundTrack = vi.fn();

        await expect(dailyChallengeEngineMethods.loadDailyChallengeCritical.call({
            setLoadingStatus: vi.fn(),
            dailyChallengeUi: { setDailyChallengeSummary },
            syncReadyBackgroundTrack,
        }, {
            prepareTrack: false,
            loadPersonalBest: false,
            throwOnError: true,
        })).rejects.toBe(offline);

        expect(syncReadyBackgroundTrack).not.toHaveBeenCalled();
        expect(setDailyChallengeSummary).toHaveBeenCalledWith(null);
        consoleError.mockRestore();
    });
});
