import { describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';

const IDENTITIES = ['signed-in', 'guest', 'guest-upgraded'];
const MODES = ['daily', 'campaign', 'challenge'];

function createRacer(mode, identity, calls) {
    const racer = Object.create(RealTimeRacer.prototype);
    racer.launchTarget = { mode, challengeId: 'h2h-1' };
    racer.initialContractPromise = null;
    racer.loadStartupPlayer = vi.fn(async () => {
        calls.push(`profile:${identity}`);
        return null;
    });
    racer.loadDailyChallengeCritical = vi.fn(async () => {
        calls.push('daily-contract');
        return { trackKey: 'daily-track' };
    });
    racer.prepareInitialCampaignLaunch = vi.fn(async () => {
        calls.push('campaign-contract');
        return { stage: { raceId: 'numbered-v1-0', trackKey: 'campaign-track' } };
    });
    racer.loadChallengeLobby = vi.fn(async () => {
        calls.push('challenge-contract');
        return { challengeId: 'h2h-1' };
    });
    racer.loadTrack = vi.fn(async (trackKey) => calls.push(`track:${trackKey}`));
    racer.syncCarSpriteAsset = vi.fn(async () => calls.push('car'));
    racer.loadInitialPersonalBestGhostAsset = vi.fn(async () => calls.push('pb-ghost'));
    return racer;
}

describe('direct-mode startup identity matrix', () => {
    it.each(MODES.flatMap((mode) => IDENTITIES.map((identity) => [mode, identity])))(
        'loads every %s essential for a %s player without unrelated mode work',
        async (mode, identity) => {
            const calls = [];
            const racer = createRacer(mode, identity, calls);

            await Promise.all([
                racer.loadStartupGraphics(mode),
                racer.loadStartupRaceData(mode),
            ]);

            // Identity and the player's car are essentials in every mode.
            expect(calls).toContain(`profile:${identity}`);
            expect(calls).toContain('car');
            // One shared contract request, however many groups asked for it.
            expect(racer.loadDailyChallengeCritical.mock.calls.length
                + racer.prepareInitialCampaignLaunch.mock.calls.length
                + racer.loadChallengeLobby.mock.calls.length).toBe(1);

            if (mode === 'daily') {
                expect(calls).toContain('daily-contract');
                expect(calls).toContain('track:daily-track');
                expect(calls).toContain('pb-ghost');
                expect(calls).not.toContain('campaign-contract');
                expect(calls).not.toContain('challenge-contract');
            } else if (mode === 'campaign') {
                // Campaign progress picks the stage, so identity settles first.
                expect(calls.indexOf(`profile:${identity}`))
                    .toBeLessThan(calls.indexOf('campaign-contract'));
                expect(calls).toContain('track:campaign-track');
                expect(calls).not.toContain('daily-contract');
                expect(calls).not.toContain('challenge-contract');
            } else {
                expect(calls).toContain('challenge-contract');
                // Head to Head prepares its own target track and opponent ghost.
                expect(racer.loadTrack).not.toHaveBeenCalled();
                expect(calls).not.toContain('daily-contract');
                expect(calls).not.toContain('campaign-contract');
            }
        },
    );
});
