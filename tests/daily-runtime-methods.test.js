import { describe, expect, it } from 'vitest';
import { loadModeRuntime } from '../game/modes/runtime-loader.js';
import { challengeRunEngineMethods } from '../game/challenge-run/engine-methods.js';
import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';

describe('Daily runtime methods', () => {
    it('overrides only the shared run methods whose Daily rules differ', () => {
        const overrides = Object.keys(dailyChallengeEngineMethods)
            .filter((name) => name in challengeRunEngineMethods)
            .sort();

        expect(overrides).toEqual([
            'applyDailyChallenge',
            'applyVerifiedTrackPersonalBest',
            'clearDailyChallengeRun',
            'markTrackPersonalBestGhostPending',
            'prepareTrackPersonalBestGhost',
        ]);
    });

    it('takes every other run method from the shared set', async () => {
        const { methods } = await loadModeRuntime('daily');

        for (const [name, method] of Object.entries(challengeRunEngineMethods)) {
            if (name in dailyChallengeEngineMethods) continue;
            expect(methods[name], name).toBe(method);
        }
    });

    it('gives every race mode the shared lap handler', async () => {
        for (const mode of ['home', 'daily', 'campaign', 'challenge']) {
            const { methods } = await loadModeRuntime(mode);
            expect(methods.handleChallengeLapCompleted, mode)
                .toBe(challengeRunEngineMethods.handleChallengeLapCompleted);
        }
    });
});
