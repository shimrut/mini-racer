import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';
import { dailyChallengeEngineMethods } from '../game/daily-challenge/engine-methods.js';
import { challengeRunEngineMethods } from '../game/challenge-run/engine-methods.js';
import {
    clearClientTrackRegistryForTests,
    getLoadedClientTrack,
    loadClientTrack,
    waitForClientTrackDefinition,
} from '../game/track/client-registry.js';
import { loadModeRuntime, clearModeRuntimeCacheForTests, createModeRuntimeController } from '../game/modes/runtime-loader.js';
import {
    selectModeCriticalStartupPromises,
    selectModeSecondaryStartupTasks,
} from '../game/startup/coordinator.js';

describe('mode-priority startup', () => {
    it('starts mode loading after the entry module can finish evaluating', () => {
        const entrySource = readFileSync(new URL('../game/index.js', import.meta.url), 'utf8');

        expect(entrySource).toContain('async function startGame()');
        expect(entrySource).toContain('void startGame().catch(');
        expect(entrySource).not.toMatch(/^await ensureModeRuntime/m);
        expect(entrySource).not.toMatch(/^const initialTrack = await loadClientTrack/m);
    });

    it('builds the initial track canvas before resolving track readiness', () => {
        const engineSource = readFileSync(new URL('../game/engine.js', import.meta.url), 'utf8');
        const dailySource = readFileSync(
            new URL('../game/daily-challenge/engine-methods.js', import.meta.url),
            'utf8',
        );
        const campaignSource = readFileSync(
            new URL('../game/campaign/engine-methods.js', import.meta.url),
            'utf8',
        );

        expect(engineSource).toContain(
            'this.trackReadyPromise = this.loadTrack(DEFAULT_TRACK_KEY, {',
        );
        expect(engineSource).not.toContain('this.trackReadyPromise = Promise.resolve();');
        expect(engineSource).toContain(
            'invokeModeMethod("challenge", "previewHeadToHead"',
        );
        expect(engineSource).toContain(
            'invokeModeMethod("challenge", "confirmHeadToHead"',
        );
        expect(dailySource).toContain(
            '&& (challenge.trackKey !== this.currentTrackKey || !this.trackCanvas)',
        );
        expect(campaignSource).toContain(
            'if (stage.trackKey !== this.currentTrackKey || !this.trackCanvas)',
        );
    });

    it('loads only the requested client track and reuses its geometry', async () => {
        clearClientTrackRegistryForTests();
        expect(getLoadedClientTrack('numberZero')).toBe(null);

        const [first, second] = await Promise.all([
            loadClientTrack('numberZero'),
            loadClientTrack('numberZero'),
        ]);

        expect(first).toBe(second);
        expect(first.name).toBe('Number Zero');
        expect(first.outer.length).toBeGreaterThan(0);
        expect(getLoadedClientTrack('numberZero')).toBe(first);
        expect(getLoadedClientTrack('numberOne')).toBe(null);
        expect(await loadClientTrack('missingTrack')).toBe(null);
    });

    it('bounds a stalled client track definition load', async () => {
        vi.useFakeTimers();
        try {
            const stalled = waitForClientTrackDefinition(
                new Promise(() => {}),
                'numberZero',
                25,
            );
            const rejection = expect(stalled).rejects.toThrow(
                'Timed out loading the numberZero track.',
            );

            await vi.advanceTimersByTimeAsync(25);
            await rejection;
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps each mode gate focused on its race-ready dependencies', () => {
        const values = {
            playerHistory: Promise.resolve('profile'),
            carAsset: Promise.resolve('car'),
            trackReady: Promise.resolve('track'),
            dailyChallenge: Promise.resolve('daily'),
            personalBestGhost: Promise.resolve('ghost'),
            campaignLaunch: Promise.resolve('campaign'),
            challengeLobby: Promise.resolve('challenge'),
        };

        expect(selectModeCriticalStartupPromises('daily', values)).toEqual([
            values.playerHistory,
            values.dailyChallenge,
            values.personalBestGhost,
            values.carAsset,
            values.trackReady,
        ]);
        expect(selectModeCriticalStartupPromises('campaign', values)).toEqual([
            values.playerHistory,
            values.campaignLaunch,
            values.carAsset,
            values.trackReady,
        ]);
        expect(selectModeCriticalStartupPromises('challenge', values)).toEqual([
            values.challengeLobby,
            values.carAsset,
            values.trackReady,
        ]);
    });

    it('defers the other mode runtimes until the selected lobby is ready', () => {
        expect(selectModeSecondaryStartupTasks('daily')).toEqual(['campaign']);
        expect(selectModeSecondaryStartupTasks('campaign')).toEqual(['daily']);
        expect(selectModeSecondaryStartupTasks('challenge')).toEqual(['daily', 'campaign']);
    });

    it('loads mode code independently of the selected mode', async () => {
        clearModeRuntimeCacheForTests();
        const challenge = await loadModeRuntime('challenge');
        const campaign = await loadModeRuntime('campaign');

        expect(challenge.methods.loadChallengeLobby).toBeTypeOf('function');
        expect(challenge.methods.startHeadToHead).toBeTypeOf('function');
        expect(challenge.methods.showCampaignLobby).toBeUndefined();
        expect(campaign.methods.prepareInitialCampaignLaunch).toBeTypeOf('function');
        expect(campaign.methods.loadChallengeLobby).toBeUndefined();
    });

    it('keeps Daily overrides on the prototype after Campaign warmup', async () => {
        clearModeRuntimeCacheForTests();
        const controller = createModeRuntimeController(RealTimeRacer);
        await controller.ensure('daily');
        expect(RealTimeRacer.prototype.applyDailyChallenge)
            .toBe(dailyChallengeEngineMethods.applyDailyChallenge);
        await controller.prefetch('campaign');
        expect(RealTimeRacer.prototype.applyDailyChallenge)
            .toBe(dailyChallengeEngineMethods.applyDailyChallenge);
        controller.clearForTests();
    });

    it('re-applies the active mode after installing a different warmed runtime', async () => {
        clearModeRuntimeCacheForTests();
        const controller = createModeRuntimeController(RealTimeRacer);
        await controller.ensure('daily', 'daily', 'daily');
        await controller.ensure('campaign', 'daily', 'daily');
        expect(RealTimeRacer.prototype.applyDailyChallenge)
            .toBe(dailyChallengeEngineMethods.applyDailyChallenge);
        expect(RealTimeRacer.prototype.applyDailyChallenge)
            .not.toBe(challengeRunEngineMethods.applyDailyChallenge);
        controller.clearForTests();
    });

    it('leaves Campaign installed when switching away from Daily', async () => {
        clearModeRuntimeCacheForTests();
        const controller = createModeRuntimeController(RealTimeRacer);
        await controller.ensure('daily');
        await controller.ensure('campaign');
        expect(RealTimeRacer.prototype.applyDailyChallenge)
            .toBe(challengeRunEngineMethods.applyDailyChallenge);
        controller.clearForTests();
    });

    it('invokes dynamically installed mode methods with racer context and arguments', async () => {
        const racer = Object.create(RealTimeRacer.prototype);
        racer.ensureModeRuntime = vi.fn(async (mode) => {
            racer.startSelectedMode = function (...args) {
                return { context: this, mode, args };
            };
        });
        const options = { retry: true };

        const result = await racer.invokeModeMethod(
            'campaign',
            'startSelectedMode',
            'numberZero',
            options,
        );

        expect(racer.ensureModeRuntime).toHaveBeenCalledWith('campaign');
        expect(result).toEqual({
            context: racer,
            mode: 'campaign',
            args: ['numberZero', options],
        });
    });

    it('installs the selected mode when switching lobbies', async () => {
        const racer = Object.create(RealTimeRacer.prototype);
        racer.installModeRuntime = vi.fn(async () => {});
        racer.ensureModeRuntime = vi.fn(async () => {});
        racer.showCampaignLobby = vi.fn();

        await racer.activateMode('campaign');

        expect(racer.installModeRuntime).toHaveBeenCalledWith('campaign');
        expect(racer.ensureModeRuntime).not.toHaveBeenCalled();
        expect(racer.showCampaignLobby).toHaveBeenCalled();
    });

    it('loads Head to Head share helpers without replacing Daily handlers', async () => {
        clearModeRuntimeCacheForTests();
        const controller = createModeRuntimeController(RealTimeRacer);
        const racer = Object.create(RealTimeRacer.prototype);
        racer.activeRaceMode = 'daily';
        racer.launchTarget = { mode: 'daily' };
        racer.ensureModeRuntime = (mode) => controller.ensure(
            mode,
            racer.activeRaceMode,
            racer.launchTarget.mode,
        );

        await racer.ensureModeRuntime('daily');
        await racer.ensureModeRuntime('challenge');

        expect(typeof racer.previewHeadToHead).toBe('function');
        expect(typeof racer.confirmHeadToHead).toBe('function');
        expect(RealTimeRacer.prototype.applyDailyChallenge)
            .toBe(dailyChallengeEngineMethods.applyDailyChallenge);
        controller.clearForTests();
    });
});
