import { prepareLeaderboardOpponentRace } from './opponent-race-service.js';
import { GhostWatchView } from '../ghost/ghost-watch.js';
import { normalizePbGhostRecord } from '../ghost/pb-ghost.js';
import { chooseOpponentCarAsset } from '../race/engine-methods.js';
import { getTrackCanvasAsset } from '../track/assets.js';
import { getLoadedClientTrack } from '../track/client-registry.js';
import { getTrackGround } from '../track/grounds.js';
import { plainRaceChallenge, resolveRacePresentation } from '../track/race-preparation.js';

function competitionIdFor(mode, race) {
    if (mode === 'daily') return race?.id || null;
    if (mode === 'campaign') return race?.raceId || race?.id || null;
    return null;
}

function enrichTarget(mode, competitionId, target) {
    if (!target || typeof target !== 'object') return null;
    return {
        ...target,
        mode,
        competitionId,
    };
}

function improvePrimaryAction(engine, mode, race) {
    return {
        label: 'Improve',
        action: () => (mode === 'campaign'
            ? engine.startCampaignStage?.(race)
            : engine.handleStartDailyChallenge?.(race)),
    };
}

function retryOpponentPrimaryAction(engine, mode) {
    return {
        label: 'Retry',
        action: () => (mode === 'campaign'
            ? engine.restartActiveRace?.()
            : engine.restartDailyChallenge?.({ reason: 'opponent-retry' })),
    };
}

export const opponentRaceEngineMethods = {
    async prepareAndStartLeaderboardOpponent({
        mode,
        competitionId,
        entry,
        watch = false,
    } = {}) {
        const response = await prepareLeaderboardOpponentRace({
            mode,
            competitionId,
            entry,
        });
        if (!response?.ok) return response;
        if (watch) return this.watchPreparedLeaderboardOpponent(mode, response);

        const race = response.body?.race;
        const resolvedCompetitionId = competitionIdFor(mode, race) || competitionId;
        const target = enrichTarget(mode, resolvedCompetitionId, response.body?.target);
        if (!race || !target) {
            return {
                ok: false,
                status: 502,
                body: { error: 'Opponent race data was incomplete.' },
            };
        }

        this.modal?.closeModal?.();
        const started = mode === 'campaign'
            ? await this.startCampaignStageAgainstOpponent?.(race, target)
            : await this.startDailyChallengeAgainstOpponent?.(race, target);
        return started
            ? { ...response, race, target }
            : {
                ok: false,
                status: 409,
                body: { error: 'Opponent ghost could not be prepared.' },
            };
    },

    // Opens the replay of a prepared opponent's ghost. The race state does
    // not change, so the screen behind the replay stays as it was.
    async watchPreparedLeaderboardOpponent(mode, response) {
        const race = response.body?.race;
        const target = response.body?.target;
        const record = normalizePbGhostRecord({ ghost: target?.ghost });
        const trackKey = race?.trackKey;
        const failed = (error) => ({ ok: false, status: 502, body: { error } });
        if (!record || typeof trackKey !== 'string' || !trackKey) {
            return failed('This ghost could not be prepared.');
        }
        const challenge = mode === 'campaign' ? plainRaceChallenge(trackKey) : race;
        let track = getLoadedClientTrack(trackKey);
        if (!track) {
            try {
                await this.loadRaceDefinitions?.([trackKey], { challenge });
            } catch (error) {
                console.error('Could not load the track for a ghost replay:', error);
            }
            track = getLoadedClientTrack(trackKey);
        }
        if (!track) return failed('Track failed to load.');

        const presentation = resolveRacePresentation(trackKey, track, challenge);
        const trackCanvasAsset = getTrackCanvasAsset(trackKey, track, {
            qualityLevel: this.qualityLevel,
            frameSkip: this.frameSkip,
            presentation,
        });
        this.ghostWatchView?.close?.();
        const rank = Number.isInteger(Number(target.rank)) ? `#${target.rank} ` : '';
        this.ghostWatchView = new GhostWatchView({
            track,
            trackCanvasAsset,
            presentation,
            samples: record.samples,
            carAssetName: chooseOpponentCarAsset({
                playerAssetName: this.getSelectedCarAssetName?.(track),
                ground: getTrackGround(track).key,
            }),
            title: `${rank}${target.displayName || ''}`.trim(),
            turnRate: this.runtimeConfig?.turnRate,
            isCoarsePointer: this.isCoarsePointer,
            lowQuality: this.frameSkip > 0 || this.qualityLevel > 0,
            onClose: () => {
                this.ghostWatchView = null;
            },
        }).open();
        return { ...response, watching: true };
    },

    async prepareNextLeaderboardOpponent({
        mode,
        competitionId,
        benchmarkTimeMs = null,
    } = {}) {
        const response = await prepareLeaderboardOpponentRace({
            mode,
            competitionId,
            nextFasterThanMs: benchmarkTimeMs,
        });
        if (
            response?.status === 404
            && response.body?.reason === 'no_faster_opponent'
        ) {
            return { ok: true, kind: 'personal-best' };
        }
        if (!response?.ok) return { ...response, kind: 'error' };

        const race = response.body?.race;
        const resolvedCompetitionId = competitionIdFor(mode, race) || competitionId;
        const target = enrichTarget(mode, resolvedCompetitionId, response.body?.target);
        if (!race || !target) {
            return {
                ok: false,
                status: 502,
                kind: 'error',
                body: { error: 'Next opponent data was incomplete.' },
            };
        }
        return {
            ok: true,
            status: response.status,
            kind: 'opponent',
            race,
            target,
        };
    },

    async startPreparedLeaderboardOpponent(prepared) {
        if (prepared?.kind !== 'opponent' || !prepared.race || !prepared.target) {
            return false;
        }
        return prepared.target.mode === 'campaign'
            ? this.startCampaignStageAgainstOpponent?.(prepared.race, prepared.target)
            : this.startDailyChallengeAgainstOpponent?.(prepared.race, prepared.target);
    },

    configureLeaderboardOpponentFinish({
        mode,
        race,
        finalTime,
        comparison,
        waitForVerification = false,
    } = {}) {
        if (!comparison?.target || !comparison?.outcome) return;

        const competitionId = competitionIdFor(mode, race)
            || comparison.target.competitionId;
        this._leaderboardOpponentFinish = {
            mode,
            race,
            competitionId,
            benchmarkTimeMs: Math.round(Number(finalTime) * 1000),
            outcome: comparison.outcome,
        };
        this.modal?.setCombinedPrimaryAction?.(
            comparison.outcome === 'won'
                ? improvePrimaryAction(this, mode, race)
                : retryOpponentPrimaryAction(this, mode),
        );

        if (comparison.outcome !== 'won' || waitForVerification) return;
        void this.resolveLeaderboardOpponentAdvanceAfterVerification({
            mode,
            competitionId,
            benchmarkTimeMs: this._leaderboardOpponentFinish.benchmarkTimeMs,
        });
    },

    async resolveLeaderboardOpponentAdvanceAfterVerification({
        mode,
        competitionId,
        benchmarkTimeMs,
    } = {}) {
        const finish = this._leaderboardOpponentFinish;
        if (
            finish?.outcome !== 'won'
            || finish.mode !== mode
            || finish.competitionId !== competitionId
        ) {
            return false;
        }

        const prepared = await this.prepareNextLeaderboardOpponent({
            mode,
            competitionId,
            benchmarkTimeMs,
        });
        if (this._leaderboardOpponentFinish !== finish) return false;

        if (prepared?.kind === 'opponent') {
            const name = prepared.target.displayName || 'opponent';
            const rank = Number.isFinite(prepared.target.rank)
                ? `#${prepared.target.rank} `
                : '';
            this.modal?.setCombinedPrimaryAction?.({
                label: 'Next rival',
                ariaLabel: `Next rival: ${rank}${name}`,
                action: () => this.startPreparedLeaderboardOpponent(prepared),
            });
            return true;
        }
        if (prepared?.kind === 'personal-best') {
            this.modal?.setCombinedPrimaryAction?.(
                improvePrimaryAction(this, mode, finish.race),
            );
            return true;
        }

        return false;
    },
};
