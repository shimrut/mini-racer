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
    racer.loadDailyRaceDefinitions = vi.fn(async () => []);
    racer.prepareInitialCampaignLaunch = vi.fn(async () => {
        calls.push('campaign-contract');
        return { stage: { raceId: 'numbered-v1-0', trackKey: 'campaign-track' } };
    });
    racer.loadChallengeLobby = vi.fn(async () => {
        calls.push('challenge-contract');
        return { challengeId: 'h2h-1' };
    });
    racer.prepareRaceTrack = vi.fn(async (slot, target) => {
        calls.push(`prepare:${slot}:${target.trackKey}`);
        return { trackKey: target.trackKey };
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

            expect(calls).toContain(`profile:${identity}`);
            expect(calls).toContain('car');
            expect(racer.loadDailyChallengeCritical.mock.calls.length
                + racer.prepareInitialCampaignLaunch.mock.calls.length
                + racer.loadChallengeLobby.mock.calls.length).toBe(1);

            if (mode === 'daily') {
                expect(calls).toContain('daily-contract');
                expect(calls.indexOf('prepare:daily:daily-track')).toBeLessThan(calls.indexOf('track:daily-track'));
                expect(racer.loadTrack).toHaveBeenCalledWith('daily-track', expect.objectContaining({
                    prepared: { trackKey: 'daily-track' },
                }));
                expect(calls).toContain('pb-ghost');
                expect(calls).not.toContain('campaign-contract');
                expect(calls).not.toContain('challenge-contract');
            } else if (mode === 'campaign') {
                expect(calls.indexOf(`profile:${identity}`))
                    .toBeLessThan(calls.indexOf('campaign-contract'));
                expect(calls).toContain('prepare:campaign:campaign-track');
                expect(calls).toContain('track:campaign-track');
                expect(calls).not.toContain('daily-contract');
                expect(calls).not.toContain('challenge-contract');
            } else {
                expect(calls).toContain('challenge-contract');
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

        expect(calls).toEqual(['car']);

        await graphics;
        expect(calls).toEqual([
            'car',
            'profile:signed-in',
            'campaign-contract',
            'prepare:campaign:campaign-track',
            'track:campaign-track',
        ]);
    });

    it('does not hold Daily graphics on a car image that has not arrived', async () => {
        const racer = createRacer('daily', 'signed-in', []);
        racer.syncCarSpriteAsset = vi.fn(() => new Promise(() => {}));

        await racer.loadStartupGraphics('daily');
    });

    it('prepares only Home graphics while its race services are pending', async () => {
        const calls = [];
        const racer = createRacer('home', 'signed-in', calls);
        racer.installModeRuntime = vi.fn(async () => null);
        racer.loadDailyChallengeCritical = vi.fn(() => new Promise(() => {}));
        racer.prepareInitialCampaignLaunch = vi.fn(() => new Promise(() => {}));

        await racer.loadStartupGraphics('home');

        expect(racer.loadDailyChallengeCritical).not.toHaveBeenCalled();
        expect(racer.prepareInitialCampaignLaunch).not.toHaveBeenCalled();
        expect(racer.prepareRaceTrack).not.toHaveBeenCalled();
        expect(racer.loadTrack).toHaveBeenCalledTimes(1);
        expect(racer.loadTrack).toHaveBeenCalledWith('circuit', expect.objectContaining({
            prepared: null,
        }));
    });

    it('finishes Home race data without consulting unavailable race services', async () => {
        const calls = [];
        const racer = createRacer('home', 'signed-in', calls);
        racer.installModeRuntime = vi.fn(async () => null);
        racer.prepareInitialCampaignLaunch = vi.fn(async () => {
            throw new Error('Campaign progress is not authoritative.');
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        racer.loadDailyChallengeCritical = vi.fn(async () => {
            throw new Error('Daily unavailable.');
        });
        await Promise.all([racer.loadStartupGraphics('home'), racer.loadStartupRaceData('home')]);

        expect(racer.loadDailyChallengeCritical).not.toHaveBeenCalled();
        expect(racer.prepareInitialCampaignLaunch).not.toHaveBeenCalled();
        expect(calls).toContain('profile:signed-in');
        expect(racer.loadTrack).toHaveBeenCalledWith('circuit', expect.any(Object));
    });

    it('fails the loader when a required track cannot be prepared', async () => {
        const racer = createRacer('daily', 'signed-in', []);
        racer.prepareRaceTrack = vi.fn(async () => {
            throw new Error('The track layout could not be confirmed. Retry before racing.');
        });

        await expect(racer.loadStartupGraphics('daily')).rejects.toThrow('Retry before racing');
        expect(racer.loadTrack).not.toHaveBeenCalled();
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
