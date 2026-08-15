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
    runInitialStartupPlan,
    selectModeSecondaryStartupTasks,
} from '../game/startup/coordinator.js';

describe('mode-priority startup', () => {
    it('starts mode loading after the entry module can finish evaluating', () => {
        const entrySource = readFileSync(new URL('../game/index.js', import.meta.url), 'utf8');

        expect(entrySource).toContain('function startGame()');
        expect(entrySource).toContain('return new RealTimeRacer({');
        expect(entrySource).not.toMatch(/^await ensureModeRuntime/m);
        expect(entrySource).not.toMatch(/^const initialTrack = await loadClientTrack/m);
        expect(entrySource).not.toContain('await modeRuntimeController.ensure(launchTarget.mode)');
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

        expect(engineSource).toContain('this.trackReadyPromise = Promise.resolve(null);');
        expect(engineSource).toContain('async resolveInitialTrackKey(mode) {');
        expect(engineSource).toContain("throw new Error(`The ${mode} launch has no playable track.`)");
        expect(engineSource).not.toContain('this.loadTrack(DEFAULT_TRACK_KEY, {\n      loadPlayerProgress: false');
        expect(engineSource).toContain('from "./head-to-head/service.js"');
        expect(engineSource.indexOf('this.startInitialModeFetches'))
            .toBeLessThan(engineSource.indexOf('runInitialStartupPlan({'));
        expect(engineSource).not.toContain(
            'invokeModeMethod("challenge", "previewHeadToHead"',
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

    it.each(['daily', 'campaign', 'challenge'])(
        'starts the %s graphics and race data together and reveals only once both finish',
        async (mode) => {
            const calls = [];
            let releaseGraphics;
            let releaseRaceData;
            const startup = runInitialStartupPlan({
                mode,
                prepareRuntime: async (selected) => calls.push(`runtime:${selected}`),
                startGraphics: () => {
                    calls.push('graphics');
                    return new Promise((resolve) => { releaseGraphics = resolve; });
                },
                startRaceData: () => {
                    calls.push('race-data');
                    return new Promise((resolve) => { releaseRaceData = resolve; });
                },
                onReady: async ({ mode: selected }) => calls.push(`ready:${selected}`),
            });

            // Both groups are in flight before either one has answered.
            await Promise.resolve();
            await Promise.resolve();
            expect(calls).toEqual([`runtime:${mode}`, 'graphics', 'race-data']);

            releaseRaceData();
            await Promise.resolve();
            expect(calls).not.toContain(`ready:${mode}`);

            releaseGraphics();
            await startup;
            expect(calls).toEqual([`runtime:${mode}`, 'graphics', 'race-data', `ready:${mode}`]);
        },
    );

    it('moves the loader through the graphics group instead of holding one number', async () => {
        const phases = [];
        let releaseGraphics;
        let reportTrackPhase;
        const startup = runInitialStartupPlan({
            mode: 'campaign',
            startGraphics: (mode, { onContractPhase, onTrackPhase } = {}) => {
                onContractPhase?.();
                reportTrackPhase = onTrackPhase;
                return new Promise((resolve) => { releaseGraphics = resolve; });
            },
            onPhase: ({ progress, label }) => phases.push([progress, label]),
        });

        await Promise.resolve();
        expect(phases).toEqual([
            [10, 'Loading Campaign…'],
            [30, 'Loading Campaign data…'],
        ]);

        // The contract answered mid-wait, so the bar has to move before the group settles.
        reportTrackPhase();
        expect(phases.at(-1)).toEqual([65, 'Preparing the track…']);

        releaseGraphics();
        await startup;
        expect(phases.map(([progress]) => progress)).toEqual([10, 30, 65, 85, 95]);
    });

    it('keeps waiting on a stalled essential instead of revealing a lobby', async () => {
        vi.useFakeTimers();
        try {
            let finishGraphics;
            const onReady = vi.fn();
            const startup = runInitialStartupPlan({
                mode: 'daily',
                startGraphics: () => new Promise((resolve) => { finishGraphics = resolve; }),
                onReady,
            });

            await vi.advanceTimersByTimeAsync(10_000);
            expect(onReady).not.toHaveBeenCalled();

            finishGraphics();
            await startup;
            expect(onReady).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports a failed essential instead of revealing a lobby', async () => {
        const failure = new Error('daily contract unavailable');
        const onReady = vi.fn();
        const onError = vi.fn();

        await expect(runInitialStartupPlan({
            mode: 'daily',
            startRaceData: () => Promise.reject(failure),
            onReady,
            onError,
        })).rejects.toThrow(failure);

        expect(onReady).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith({ mode: 'daily', error: failure });
    });

    it('holds the reveal until the graphics group has finished', async () => {
        let resolveCar;
        const onReady = vi.fn();
        const startup = runInitialStartupPlan({
            mode: 'daily',
            startGraphics: () => new Promise((resolve) => { resolveCar = resolve; }),
            onReady,
        });

        await Promise.resolve();
        expect(onReady).not.toHaveBeenCalled();

        resolveCar();
        await startup;
        expect(onReady).toHaveBeenCalledTimes(1);
    });

    it('defers the other mode runtimes until the selected lobby is ready', () => {
        const engineSource = readFileSync(new URL('../game/engine.js', import.meta.url), 'utf8');

        expect(selectModeSecondaryStartupTasks('daily')).toEqual(['campaign']);
        expect(selectModeSecondaryStartupTasks('campaign')).toEqual(['daily']);
        expect(selectModeSecondaryStartupTasks('challenge')).toEqual(['daily', 'campaign']);
        expect(engineSource.indexOf('this.startOverlay.setInteractive(true)'))
            .toBeLessThan(engineSource.indexOf('this.loadSecondaryStartupData();'));
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
});
