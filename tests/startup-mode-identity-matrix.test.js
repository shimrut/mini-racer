import { describe, expect, it, vi } from 'vitest';
import { runInitialStartupPlan } from '../game/startup/coordinator.js';

const IDENTITIES = ['signed-in', 'guest', 'guest-upgraded'];
const MODES = ['daily', 'campaign', 'challenge'];

describe('direct-mode startup identity matrix', () => {
    it.each(MODES.flatMap((mode) => IDENTITIES.map((identity) => [mode, identity]))) (
        'orders %s startup for a %s player without unrelated mode work',
        async (mode, identity) => {
            vi.useFakeTimers();
            try {
                const calls = [];
                const handoffs = [];
                const task = vi.fn((name, value = null) => async () => {
                    calls.push(name);
                    return value;
                });
                const dailyContract = task('daily-contract', { trackKey: 'daily-track' });
                const campaignContract = task('campaign-contract', {
                    stage: { raceId: 'numbered-v1-0', trackKey: 'campaign-track' },
                });
                const challengeContract = task('challenge-contract', { challengeId: 'h2h-1' });
                const loadPlayer = async ({ handoff }) => {
                    calls.push(`profile:${identity}`);
                    if (identity === 'guest-upgraded') await handoff('selection');
                    calls.push(`owner:${identity === 'guest-upgraded' ? 'signed-in' : identity}`);
                };

                await runInitialStartupPlan({
                    mode,
                    prepareRuntime: async (selectedMode) => calls.push(`runtime:${selectedMode}`),
                    loadPlayer,
                    loadDailyContract: dailyContract,
                    loadDailyTrack: task('daily-track'),
                    loadCampaignContract: campaignContract,
                    loadCampaignTrack: task('campaign-track'),
                    loadChallenge: challengeContract,
                    loadCar: task('final-car'),
                    onReady: async () => calls.push('interactive'),
                    onHandoff: async ({ reason }) => handoffs.push(reason),
                });

                expect(calls.at(-1)).toBe('interactive');
                expect(calls).toContain(`profile:${identity}`);
                expect(calls).toContain('final-car');
                expect(calls.indexOf('final-car')).toBeLessThan(calls.indexOf('interactive'));
                if (mode === 'daily') {
                    expect(calls).toContain('daily-contract');
                    expect(calls).toContain('daily-track');
                    expect(calls).not.toContain('campaign-contract');
                    expect(calls).not.toContain('challenge-contract');
                } else if (mode === 'campaign') {
                    expect(calls.indexOf(`owner:${identity === 'guest-upgraded' ? 'signed-in' : identity}`))
                        .toBeLessThan(calls.indexOf('campaign-contract'));
                    expect(calls).toContain('campaign-track');
                    expect(calls).not.toContain('daily-contract');
                    expect(calls).not.toContain('challenge-contract');
                } else {
                    expect(calls.indexOf('challenge-contract'))
                        .toBeLessThan(calls.indexOf(`profile:${identity}`));
                    expect(calls).not.toContain('daily-contract');
                    expect(calls).not.toContain('campaign-contract');
                }
                expect(handoffs).toEqual(identity === 'guest-upgraded' ? ['selection'] : ['ready']);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        },
    );
});
