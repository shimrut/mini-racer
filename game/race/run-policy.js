function createWinData(state, checkpointCount, extra = {}) {
    const { lapTime: lapTimeOverride, ...rest } = extra;
    return Object.freeze({
        lapTime: Number.isFinite(lapTimeOverride) ? lapTimeOverride : state.currentTime,
        trackKey: state.currentTrackKey,
        runId: state.activeRunId,
        checkpointCount,
        completedCheckpointCount: state.nextCheckpointIndex,
        ...rest
    });
}

export function createRunPolicy({
    challengeRun = null,
    mode = 'daily',
} = {}) {
    const objectiveType = challengeRun?.objectiveType || 'single_lap_fastest';
    const requiredLaps = Math.max(1, Math.trunc(challengeRun?.requiredLaps || 1));
    return {
        id: `${mode}:${objectiveType}`,
        objectiveType,
        requiredLaps,
        rulesRevision: Number.isInteger(challengeRun?.rulesRevision)
            ? Math.max(0, challengeRun.rulesRevision)
            : 0,
    };
}

export function resolveRunPolicy(state) {
    return state?.currentRunPolicy || createRunPolicy({
        challengeRun: state?.currentChallengeRun || null,
        mode: state?.activeRaceMode || 'daily',
    });
}

export function handleFinishCrossing(state, policy, checkpointCount, crossingTimeSec) {
    const challengeRun = state.currentChallengeRun || null;
    const finishTime = Number.isFinite(crossingTimeSec) ? crossingTimeSec : state.currentTime;

    const completedLapTime = finishTime - (Number.isFinite(challengeRun?.lastLapAt) ? challengeRun.lastLapAt : 0);

    if (challengeRun) {
        challengeRun.lastLapAt = finishTime;
        challengeRun.completedLaps = (challengeRun.completedLaps || 0) + 1;
    }

    const result = {
        challengeLapCompleted: true,
        challengeCompletedLapTime: completedLapTime,
        challengeElapsedTime: finishTime,
        challengeProgressLaps: challengeRun?.completedLaps || 1,
        challengeRequiredLaps: policy.requiredLaps,
        challengeIsFinalLap: (challengeRun?.completedLaps || 1) >= policy.requiredLaps,
    };
    if (result.challengeIsFinalLap) {
        state.status = 'won';
        result.winTriggered = true;
        result.winData = createWinData(state, checkpointCount, {
            lapTime: finishTime,
            completedLaps: challengeRun?.completedLaps || 1,
        });
    }
    return result;

}

export function handleHardCrash(state, policy, checkpointCount) {
    const challengeRun = state.currentChallengeRun || null;

    if (state.status === 'won') {
        return {};
    }
    state.status = 'crashed';
    const result = { crashEndedRun: true };
    if (challengeRun) {
        result.challengeFailed = true;
        result.challengeFailureReason = 'Crash ended the challenge';
    }
    return result;
}
