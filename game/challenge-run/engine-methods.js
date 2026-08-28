import { getDailyChallengeData } from '../daily-challenge/storage.js';
import { isDailyChallengeStoredResultForChallenge } from '../daily-challenge/service.js';
import {
    getDailyChallengeCopyLabels,
    getDailyChallengeRequiredLaps,
} from '../daily-challenge/labels.js';
import { normalizeCheckpointTimesSec } from '../shared/checkpoint-times.js';
import { createPersonalBestPaceBaseline, getLapPaceDeltaSec } from '../ghost/pb-pace.js';
import { getMedalForRaceTime } from '../medals/medal-timing.js';
import { writeTrackLastLapMedal } from '../medals/last-lap-medal-storage.js';
import { getLoadedClientTrack } from '../track/client-registry.js';
import { buildLapRecord, pushRecentLap } from '../race/result-flow.js';

function normalizeTrackPersonalBest(record, trackKey = null, challengeId = null) {
    if (!record || typeof record !== 'object') return null;
    if (trackKey && record.trackKey && record.trackKey !== trackKey) return null;
    const bestTimeMs = Number(record.bestTimeMs);
    if (!Number.isFinite(bestTimeMs) || bestTimeMs <= 0) return null;
    return {
        challengeId,
        trackKey: record.trackKey || trackKey || null,
        bestTime: bestTimeMs / 1000,
        checkpointTimesSec: Array.isArray(record.checkpointTimesSec)
            ? record.checkpointTimesSec.slice()
            : null,
        lapCompletionTimesSec: Array.isArray(record.lapCompletionTimesSec)
            ? record.lapCompletionTimesSec.slice()
            : null,
        ghostAvailable: Boolean(record.ghostAvailable || record.ghost),
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
    };
}

function getTrackPersonalBestForChallenge(engine, challenge) {
    if (!challenge?.trackKey || !challenge?.id) return null;
    if (
        engine.trackPersonalBestResult?.challengeId === challenge.id
        && engine.trackPersonalBestResult?.trackKey === challenge.trackKey
        && Number.isFinite(engine.trackPersonalBestResult.bestTime)
    ) {
        return engine.trackPersonalBestResult;
    }
    return engine.trackPersonalBestByTrackKey?.[challenge.id] || null;
}

function getPbGhostSelectionChallengeId(engine) {
    return engine.pbGhostSelectionChallengeId
        || engine.activeDailyChallenge?.id
        || engine.currentDailyChallenge?.id
        || null;
}

function claimPbGhostSelection(engine, challengeId) {
    const normalizedId = challengeId || null;
    if (engine.pbGhostSelectionChallengeId === normalizedId) {
        return engine.pbGhostSelectionGeneration || 0;
    }
    if (normalizedId && engine.unavailablePbGhostChallengeIds?.has(normalizedId)) {
        engine.unavailablePbGhostChallengeIds.delete(normalizedId);
    }
    if (
        normalizedId
        && engine.pbGhostSelectionChallengeId == null
        && engine.preparedPbGhostChallengeId === normalizedId
    ) {
        engine.pbGhostSelectionChallengeId = normalizedId;
        engine.pbGhostSelectionGeneration = engine.pbGhostSelectionGeneration || 1;
        return engine.pbGhostSelectionGeneration;
    }
    engine.pbGhostSelectionChallengeId = normalizedId;
    engine.pbGhostSelectionGeneration = (engine.pbGhostSelectionGeneration || 0) + 1;
    engine.preparedPbGhostChallengeId = null;
    return engine.pbGhostSelectionGeneration;
}

function bumpPbGhostPrepareGeneration(engine, challengeId) {
    engine.pbGhostPrepareGenerationByChallengeId ??= Object.create(null);
    const nextGeneration = (engine.pbGhostPrepareGenerationByChallengeId[challengeId] || 0) + 1;
    engine.pbGhostPrepareGenerationByChallengeId[challengeId] = nextGeneration;
    return nextGeneration;
}

function getPendingPbGhostCandidates(engine) {
    engine.pendingPbGhostCandidateChallengeIds ??= new Set();
    return engine.pendingPbGhostCandidateChallengeIds;
}

function applyTrackPersonalBest(engine, challenge, record, { prepareGhost = false } = {}) {
    if (!challenge?.trackKey) return null;
    const personalBest = normalizeTrackPersonalBest(record, challenge.trackKey, challenge.id);
    engine.trackPersonalBestByTrackKey ??= Object.create(null);
    if (personalBest) engine.trackPersonalBestByTrackKey[challenge.id] = personalBest;
    else delete engine.trackPersonalBestByTrackKey[challenge.id];

    engine.personalBestPaceBaselineByRaceId ??= Object.create(null);
    const track = getLoadedClientTrack(challenge.trackKey);
    const paceBaseline = personalBest && track
        ? createPersonalBestPaceBaseline({
            ...record,
            bestTimeMs: Math.round(personalBest.bestTime * 1000),
            checkpointTimesSec: personalBest.checkpointTimesSec,
            lapCompletionTimesSec: personalBest.lapCompletionTimesSec,
        }, track, getDailyChallengeRequiredLaps(challenge))
        : null;
    if (paceBaseline) engine.personalBestPaceBaselineByRaceId[challenge.id] = paceBaseline;
    else delete engine.personalBestPaceBaselineByRaceId[challenge.id];

    const selectedChallengeId = engine.activeDailyChallenge?.id
        || engine.currentDailyChallenge?.id
        || null;
    if (selectedChallengeId === challenge.id) {
        engine.trackPersonalBestResult = personalBest;
        engine.bestLapTime = personalBest?.bestTime ?? null;
        if (personalBest?.bestTime && challenge.id) {
            engine.sessionBestLapSecByTrackKey ??= Object.create(null);
            engine.sessionBestLapSecByTrackKey[challenge.id] = personalBest.bestTime;
            const checkpoints = normalizeCheckpointTimesSec(
                personalBest.bestTime,
                personalBest.checkpointTimesSec,
            );
            if (checkpoints) {
                engine.sessionBestCheckpointTimesByTrackKey ??= Object.create(null);
                engine.sessionBestCheckpointTimesByTrackKey[challenge.id] = checkpoints;
            }
        }
    }

    if (prepareGhost && !engine.raceComparisonTarget) {
        if (personalBest?.ghostAvailable) engine.pbGhost?.prepare?.(record);
        else engine.pbGhost?.clearTrack?.();
    }
    return personalBest;
}

export const challengeRunEngineMethods = {
    handleChallengeLapCompleted(lapTime, {
        elapsedTimeSec = null,
        completedLaps = null,
        requiredLaps = null,
        isFinalLap = false,
    } = {}) {
        if (!this.currentChallengeRun || !Number.isFinite(lapTime)) {
            this.updateDailyChallengeHud();
            this.requestRender();
            return;
        }
        const lapNumber = Number.isInteger(completedLaps)
            ? completedLaps
            : this.currentChallengeRun.completedLaps || 0;
        const raceElapsedTime = Number.isFinite(elapsedTimeSec)
            ? elapsedTimeSec
            : this.currentTime;
        const requiredLapCount = Number.isInteger(requiredLaps)
            ? requiredLaps
            : this.currentChallengeRun.requiredLaps;
        const paceBaseline = this.getActiveRacePaceBaseline?.()
            ?? this.raceComparisonTarget
            ?? this.activePersonalBestPaceBaseline
            ?? null;
        const lapRecord = buildLapRecord(lapNumber, lapTime, null);
        lapRecord.deltaVsBest = getLapPaceDeltaSec({
            elapsedTimeSec: raceElapsedTime,
            lapNumber,
            requiredLaps: requiredLapCount,
            isFinalLap,
            paceBaseline,
        });
        pushRecentLap(this.currentChallengeRun.recentLaps, lapRecord);
        this.currentChallengeRun.bestLapSecBeforeLastLap = this.currentChallengeRun.bestLap?.time ?? null;
        if (!this.currentChallengeRun.bestLap || lapTime < this.currentChallengeRun.bestLap.time) {
            this.currentChallengeRun.bestLap = { lapNumber, time: lapTime };
        }
        if (!isFinalLap) {
            this.hud.showLapFlash({
                lapNumber,
                lapTime,
                deltaVsBest: lapRecord.deltaVsBest,
                isBest: false,
                isNewBest: false,
                completedLaps: lapNumber,
                requiredLaps: requiredLapCount,
                elapsedTimeSec: raceElapsedTime,
            });
            this._resetLapTrailAfterIntermediateLap();
        }
        this.updateDailyChallengeHud();
        this.requestRender();
    },

    beginPersonalBestGhostRunAtGo() {
        const challenge = this.activeDailyChallenge;
        const ghostActive = this.pbGhost?.beginRun?.() === true;
        this.activePersonalBestPaceBaseline = this.raceComparisonTarget
            ? null
            : (this.personalBestPaceBaselineByRaceId?.[challenge?.id] ?? null);
        const trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
        const ghostExpected = this.pbGhost?.enabled === true
            && Number.isFinite(trackPersonalBest?.bestTime);
        const noticeNeeded = ghostExpected
            && !ghostActive
            && typeof this.hud?.showGhostUnavailableNotice === 'function';
        return { ghostActive, ghostExpected, noticeNeeded };
    },

    syncTrackMedalFromChallengeBest(challenge, bestTime) {
        if (!challenge?.trackKey || !Number.isFinite(bestTime)) return null;
        const medal = getMedalForRaceTime(
            challenge.trackKey,
            Number(bestTime),
            getDailyChallengeRequiredLaps(challenge),
        );
        writeTrackLastLapMedal(challenge.trackKey, medal);
        return medal;
    },

    syncChallengeHudPrimaryStats() {
        const copyLabels = getDailyChallengeCopyLabels(this.activeDailyChallenge);
        this.hud.setHudPrimaryMetric({
            label: copyLabels.hudPrimaryLabel,
            useTimer: true,
            visible: true,
        });
        if (this.raceComparisonTarget) {
            this.hud.setComparisonTarget?.(this.raceComparisonTarget);
        } else {
            this.hud.setBestTime(this.bestLapTime, { persistToTrackCard: false });
        }
    },

    updateDailyChallengeHud() {
        if (!this.currentChallengeRun) return;
        this.syncChallengeHudPrimaryStats();
    },

    createDailyChallengeRun(challenge) {
        return {
            challengeId: challenge.id,
            trackKey: challenge.trackKey,
            objectiveType: challenge.objectiveType,
            rulesRevision: Number.isInteger(challenge.rulesRevision) ? challenge.rulesRevision : 0,
            requiredLaps: getDailyChallengeRequiredLaps(challenge),
            completedLaps: 0,
            lastLapAt: 0,
            bestLap: null,
            bestLapSecBeforeLastLap: null,
            recentLaps: [],
        };
    },

    applyDailyChallenge(challenge) {
        this.activeDailyChallenge = challenge;
        this.trackMedalBeforeLastLapWrite = null;
        this.hasTrackMedalBeforeLastLapWrite = false;
        this.currentChallengeRun = this.createDailyChallengeRun(challenge);
        this.syncCurrentRunPolicy();
        this.setRuntimeConfig(null);

        const storedRaw = getDailyChallengeData(challenge.id);
        const stored = isDailyChallengeStoredResultForChallenge(challenge, storedRaw)
            ? storedRaw
            : null;
        this.dailyChallengeBestResult = stored ? { ...stored } : null;
        const trackPersonalBest = getTrackPersonalBestForChallenge(this, challenge);
        this.trackPersonalBestResult = trackPersonalBest;
        this.bestLapTime = Number.isFinite(trackPersonalBest?.bestTime)
            ? trackPersonalBest.bestTime
            : null;
        this.syncTrackMedalFromChallengeBest(challenge, this.bestLapTime);
        if (trackPersonalBest?.bestTime && challenge.id) {
            this.sessionBestLapSecByTrackKey ??= Object.create(null);
            this.sessionBestLapSecByTrackKey[challenge.id] = trackPersonalBest.bestTime;
            const checkpoints = normalizeCheckpointTimesSec(
                trackPersonalBest.bestTime,
                trackPersonalBest.checkpointTimesSec,
            );
            if (checkpoints) {
                this.sessionBestCheckpointTimesByTrackKey ??= Object.create(null);
                this.sessionBestCheckpointTimesByTrackKey[challenge.id] = checkpoints;
            }
        }
        this.hud.setPauseVisible(false);
        this.syncChallengeHudPrimaryStats();
        this.updateDailyChallengeHud();
    },

    clearDailyChallengeRun() {
        this.trackMedalBeforeLastLapWrite = null;
        this.hasTrackMedalBeforeLastLapWrite = false;
        this.currentChallengeRun = null;
        this.activeDailyChallenge = null;
        this.dailyChallengeBestResult = null;
        this.trackPersonalBestResult = null;
        this.activePersonalBestPaceBaseline = null;
        this.pbGhost?.clearTrack?.();
        this.preparedPbGhostChallengeId = null;
        claimPbGhostSelection(this, null);
        this.syncCurrentRunPolicy();
        this.setRuntimeConfig(null);
        this.hud?.setHudPrimaryMetric?.({
            label: 'LAP',
            useTimer: true,
            visible: true,
        });
        this.hud?.setHudBestMetric?.({ visible: false });
        this.updateDailyChallengeHud();
        const lobbyChallenge = this.currentDailyChallenge;
        if (lobbyChallenge && typeof this.setDailyChallengeLobbySummary === 'function') {
            this.setDailyChallengeLobbySummary(lobbyChallenge);
        }
    },

    async prepareTrackPersonalBestGhost(challenge, { forceRefresh = false } = {}) {
        if (!challenge?.id || !challenge?.trackKey) {
            this.pbGhost?.clearTrack?.();
            this.preparedPbGhostChallengeId = null;
            return null;
        }
        const selectionGeneration = this.pbGhostSelectionChallengeId == null
            && getPbGhostSelectionChallengeId(this) === challenge.id
            ? claimPbGhostSelection(this, challenge.id)
            : (this.pbGhostSelectionGeneration || 0);
        const prepareGeneration = bumpPbGhostPrepareGeneration(this, challenge.id);
        const record = await this.pbGhostService.getForChallenge(challenge.id, { forceRefresh });
        if (
            this.pbGhostPrepareGenerationByChallengeId?.[challenge.id] !== prepareGeneration
            || getPbGhostSelectionChallengeId(this) !== challenge.id
            || (this.pbGhostSelectionGeneration || 0) !== selectionGeneration
        ) return null;
        const personalBest = applyTrackPersonalBest(this, challenge, record, { prepareGhost: true });
        if (!this.raceComparisonTarget) this.preparedPbGhostChallengeId = challenge.id;
        return personalBest;
    },

    markTrackPersonalBestGhostPending(challenge) {
        if (!challenge?.id) return false;
        getPendingPbGhostCandidates(this).add(challenge.id);
        bumpPbGhostPrepareGeneration(this, challenge.id);
        this.pbGhostService?.invalidate?.(challenge.id);
        return true;
    },

    resolveTrackPersonalBestGhostPending(challengeId) {
        return challengeId ? getPendingPbGhostCandidates(this).delete(challengeId) : false;
    },

    applyVerifiedTrackPersonalBest(challenge, record) {
        const personalBest = applyTrackPersonalBest(this, challenge, record);
        if (
            personalBest
            && (this.activeDailyChallenge?.id || this.currentDailyChallenge?.id) === challenge?.id
        ) {
            this.syncTrackMedalFromChallengeBest(challenge, personalBest.bestTime);
            this.hud?.setBestTime?.(personalBest.bestTime, { persistToTrackCard: false });
        }
        return personalBest;
    },
};

export { applyTrackPersonalBest, getTrackPersonalBestForChallenge };
