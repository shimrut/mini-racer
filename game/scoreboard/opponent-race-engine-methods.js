import { prepareLeaderboardOpponentRace } from './opponent-race-service.js';

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

/**
 * The ordinary finish action: with no rival left to chase, the run to beat is
 * the player's own, so this reads and behaves exactly like a normal race.
 * Starting the competition fresh drops the beaten opponent and restores the
 * player's own PB ghost.
 */
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
    } = {}) {
        const response = await prepareLeaderboardOpponentRace({
            mode,
            competitionId,
            entry,
        });
        if (!response?.ok) return response;

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
        guest = false,
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
        // Nothing is known about a next rival until the lookup answers, and a
        // promised rematch that resolves into something else reads as a bug.
        // Winning therefore holds the ordinary Improve and upgrades to a named
        // rival only once one is confirmed raceable.
        this.modal?.setCombinedPrimaryAction?.(
            comparison.outcome === 'won'
                ? improvePrimaryAction(this, mode, race)
                : retryOpponentPrimaryAction(this, mode),
        );

        if (guest && this.modal?.modalMsg) {
            const current = this.modal.modalMsg.textContent || '';
            this.modal.modalMsg.textContent = `${current}${current ? ' · ' : ''}Sign in to claim your Campaign rank.`;
        }
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
                // The button stays short, so who it starts belongs in the
                // accessible name — led by the visible label so voice control
                // can still address it.
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

        // A failed lookup says nothing about the standings, so the finish keeps
        // the action it already has rather than inventing a different one.
        return false;
    },
};
