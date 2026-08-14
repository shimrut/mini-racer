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
    INITIAL_LOADER_BUDGET_MS,
    INITIAL_LOADER_MAX_MS,
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
        expect(engineSource).toContain('loadDailyTrack: (challenge) => {');
        expect(engineSource).toContain('if (!challenge?.trackKey) throw new Error(');
        expect(engineSource).toContain('loadCampaignTrack: (launch) => {');
        expect(engineSource).not.toContain('this.loadTrack(DEFAULT_TRACK_KEY, {\n      loadPlayerProgress: false');
        expect(engineSource).toContain('from "./head-to-head/service.js"');
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

    it.each([
        ['daily', ['runtime:daily', 'player', 'daily', 'daily-track', 'car', 'ready:daily', 'handoff:ready']],
        ['campaign', ['runtime:campaign', 'player', 'campaign', 'campaign-track', 'car', 'ready:campaign', 'handoff:ready']],
        ['challenge', ['runtime:challenge', 'challenge', 'player', 'car', 'ready:challenge', 'handoff:ready']],
    ])('runs the %s startup plan with only its ordered dependencies', async (mode, expected) => {
        const calls = [];
        await runInitialStartupPlan({
            mode,
            prepareRuntime: async (selected) => calls.push(`runtime:${selected}`),
            loadPlayer: async () => calls.push('player'),
            loadHomeTrack: async () => calls.push('home-track'),
            loadDailyContract: async () => {
                calls.push('daily');
                return { trackKey: 'daily-track' };
            },
            loadDailyTrack: async () => calls.push('daily-track'),
            loadCampaignContract: async () => {
                calls.push('campaign');
                return { stage: { trackKey: 'campaign-track' } };
            },
            loadCampaignTrack: async () => calls.push('campaign-track'),
            loadChallenge: async () => calls.push('challenge'),
            loadCar: async () => calls.push('car'),
            onReady: async ({ mode: selected }) => calls.push(`ready:${selected}`),
            onHandoff: async ({ reason }) => calls.push(`handoff:${reason}`),
        });
        await Promise.resolve();

        expect(calls).toEqual(expected);
        expect(calls).not.toContain(mode === 'daily' ? 'campaign' : 'daily');
    });

    it('hands a stalled startup to the selected mode before one second', async () => {
        vi.useFakeTimers();
        try {
            let finishRuntime;
            const onHandoff = vi.fn();
            const startup = runInitialStartupPlan({
                mode: 'daily',
                prepareRuntime: () => new Promise((resolve) => { finishRuntime = resolve; }),
                onHandoff,
            });

            await vi.advanceTimersByTimeAsync(INITIAL_LOADER_BUDGET_MS - 1);
            expect(onHandoff).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(onHandoff).toHaveBeenCalledWith({
                mode: 'daily',
                reason: 'budget',
                fadeMs: expect.any(Number),
            });

            finishRuntime();
            await startup;
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses the absolute navigation deadline when startup begins late', async () => {
        vi.useFakeTimers();
        try {
            const onHandoff = vi.fn();
            let finishRuntime;
            const startedAtMs = performance.now() - 900;
            const startup = runInitialStartupPlan({
                mode: 'campaign',
                startedAtMs,
                prepareRuntime: () => new Promise((resolve) => { finishRuntime = resolve; }),
                onHandoff,
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(onHandoff).toHaveBeenCalledWith({
                mode: 'campaign',
                reason: 'budget',
                fadeMs: INITIAL_LOADER_MAX_MS - 900,
            });

            finishRuntime();
            await startup;
        } finally {
            vi.useRealTimers();
        }
    });

    it('restores a prepared Head to Head challenge after identity handoff', async () => {
        const readyPresentation = {
            available: true,
            canRace: true,
            canRetry: false,
            challengeLoading: false,
            trackKey: 'numberOne',
            statusMessage: '',
        };
        const racer = Object.create(RealTimeRacer.prototype);
        racer.initialChallengePresentation = readyPresentation;
        racer.initialChallengeLobbyPromise = Promise.resolve();
        racer.activeHeadToHead = { challengeId: 'h2h-1' };
        racer.hasAnyData = true;
        racer.isReturningPlayer = true;
        racer.startOverlay = {
            showStartOverlay: vi.fn(),
            setInteractive: vi.fn(),
            setReady: vi.fn(),
        };
        racer.lobbyUi = { showChallenge: vi.fn() };

        racer.showInitialModePending('challenge');
        expect(racer.lobbyUi.showChallenge).toHaveBeenLastCalledWith(expect.objectContaining({
            trackKey: 'numberOne',
            canRace: false,
            challengeLoading: true,
            statusMessage: 'Syncing player identity…',
        }));

        await racer.displayInitialModeReady('challenge');
        expect(racer.lobbyUi.showChallenge).toHaveBeenLastCalledWith(expect.objectContaining({
            trackKey: 'numberOne',
            canRace: true,
            challengeLoading: false,
        }));
        expect(racer.startOverlay.setInteractive).toHaveBeenLastCalledWith(true);
    });

    it('routes a failed direct Daily action to startup retry', () => {
        const racer = Object.create(RealTimeRacer.prototype);
        racer._initialStartupFailed = true;
        racer.launchTarget = { mode: 'daily' };
        racer.retryInitialStartup = vi.fn(() => 'retrying');
        racer.invokeModeMethod = vi.fn();

        expect(racer.handleDailyLobbyPrimaryAction()).toBe('retrying');
        expect(racer.retryInitialStartup).toHaveBeenCalledTimes(1);
        expect(racer.invokeModeMethod).not.toHaveBeenCalled();
    });

    it('does not hold mode readiness on a stalled cosmetic car image', async () => {
        let resolveCar;
        const onReady = vi.fn();
        const startup = runInitialStartupPlan({
            mode: 'daily',
            prepareRuntime: vi.fn(),
            loadPlayer: vi.fn(),
            loadDailyContract: vi.fn(() => ({ trackKey: 'numberOne' })),
            loadDailyTrack: vi.fn(),
            loadCar: vi.fn(() => new Promise((resolve) => { resolveCar = resolve; })),
            onReady,
        });

        await startup;
        expect(onReady).toHaveBeenCalledTimes(1);
        resolveCar();
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
