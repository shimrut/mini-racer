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

            // Identity is an essential in every mode. The car starts with graphics
            // but does not have to finish before the splash can hide.
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

    it('starts the car before the contract round trips the track key waits on', async () => {
        const calls = [];
        const racer = createRacer('campaign', 'signed-in', calls);

        const graphics = racer.loadStartupGraphics('campaign');

        // Local preferences name the car, so it has nothing to learn from identity or the
        // campaign bootstrap and must not spend their round trips waiting.
        expect(calls).toEqual(['car']);

        await graphics;
        expect(calls).toEqual([
            'car',
            'profile:signed-in',
            'campaign-contract',
            'track:campaign-track',
        ]);
    });

    it('does not hold Daily graphics on a car image that has not arrived', async () => {
        const racer = createRacer('daily', 'signed-in', []);
        racer.syncCarSpriteAsset = vi.fn(() => new Promise(() => {}));

        await racer.loadStartupGraphics('daily');
    });

    it('does not hold Daily race data on a ghost that has not arrived', async () => {
        const racer = createRacer('daily', 'signed-in', []);
        racer.loadInitialPersonalBestGhostAsset = vi.fn(() => new Promise(() => {}));

        await racer.loadStartupRaceData('daily');
        expect(racer.loadInitialPersonalBestGhostAsset).toHaveBeenCalledTimes(1);
    });

    it('starts the Campaign ghost after the stage is known without waiting for it', async () => {
        const racer = createRacer('campaign', 'signed-in', []);
        racer.loadInitialCampaignPersonalBest = vi.fn(() => new Promise(() => {}));

        await racer.loadStartupRaceData('campaign');
        expect(racer.loadInitialCampaignPersonalBest).toHaveBeenCalledTimes(1);
    });
});
