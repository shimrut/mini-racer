import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const serviceMocks = vi.hoisted(() => ({
    getActiveDailyChallenge: vi.fn(),
    getHeadToHead: vi.fn(),
}));

vi.mock('../game/daily-challenge/service.js', async (importOriginal) => ({
    ...await importOriginal(),
    getActiveDailyChallenge: serviceMocks.getActiveDailyChallenge,
}));

vi.mock('../game/head-to-head/service.js', async (importOriginal) => ({
    ...await importOriginal(),
    getHeadToHead: serviceMocks.getHeadToHead,
}));

import { RealTimeRacer } from '../game/engine.js';

describe('startup request overlap', () => {
    afterEach(() => {
        serviceMocks.getActiveDailyChallenge.mockReset();
        serviceMocks.getHeadToHead.mockReset();
    });

    it('starts Daily and account requests without waiting for the Daily file', () => {
        const racer = Object.create(RealTimeRacer.prototype);
        racer.launchTarget = { mode: 'daily' };
        racer.initialDailyChallengeRequestPromise = null;
        racer.loadStartupPlayer = vi.fn();
        serviceMocks.getActiveDailyChallenge.mockReturnValue(Promise.resolve({ trackKey: 'daily-track' }));

        racer.startInitialModeFetches();

        expect(racer.loadStartupPlayer).toHaveBeenCalledTimes(1);
        expect(serviceMocks.getActiveDailyChallenge).toHaveBeenCalledTimes(1);
        expect(serviceMocks.getHeadToHead).not.toHaveBeenCalled();
    });

    it('starts Head to Head and account requests without waiting for the Head to Head file', () => {
        const racer = Object.create(RealTimeRacer.prototype);
        racer.launchTarget = { mode: 'challenge', challengeId: 'h2h-1' };
        racer.initialHeadToHeadRequestPromise = null;
        racer.loadStartupPlayer = vi.fn();
        serviceMocks.getHeadToHead.mockReturnValue(Promise.resolve({ ok: true, body: {} }));

        racer.startInitialModeFetches();

        expect(racer.loadStartupPlayer).toHaveBeenCalledTimes(1);
        expect(serviceMocks.getHeadToHead).toHaveBeenCalledWith('h2h-1');
        expect(serviceMocks.getActiveDailyChallenge).not.toHaveBeenCalled();
    });

    it('starts only the account request for Campaign', () => {
        const racer = Object.create(RealTimeRacer.prototype);
        racer.launchTarget = { mode: 'campaign' };
        racer.loadStartupPlayer = vi.fn();

        racer.startInitialModeFetches();

        expect(racer.loadStartupPlayer).toHaveBeenCalledTimes(1);
        expect(serviceMocks.getActiveDailyChallenge).not.toHaveBeenCalled();
        expect(serviceMocks.getHeadToHead).not.toHaveBeenCalled();
    });

    it('starts those requests before the selected mode file is installed', () => {
        const engineSource = readFileSync(new URL('../game/engine.js', import.meta.url), 'utf8');
        expect(engineSource.indexOf('this.startInitialModeFetches'))
            .toBeLessThan(engineSource.indexOf('runInitialStartupPlan({'));
    });
});
