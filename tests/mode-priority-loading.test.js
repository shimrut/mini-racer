import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RealTimeRacer } from '../game/engine.js';
import {
    clearClientTrackRegistryForTests,
    getLoadedClientTrack,
    loadClientTrack,
} from '../game/track/client-registry.js';
import { loadModeRuntime, clearModeRuntimeCacheForTests } from '../game/modes/runtime-loader.js';
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
});
