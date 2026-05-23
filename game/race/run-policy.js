import { TRACK_MODE_DAILY_GP } from '../config.js?v=1.91';

function createWinData(state, checkpointCount, extra = {}) {
    return Object.freeze({
        lapTime: state.currentTime,
        trackKey: state.currentTrackKey,
        runId: state.activeRunId,
        checkpointCount,
        completedCheckpointCount: state.nextCheckpointIndex,
        ...extra
    });
}

function createCrashBudgetWinData(state, challengeRun, checkpointCount) {
    return Object.freeze({
        lapTime: challengeRun.elapsedTime || 0,
        trackKey: state.currentTrackKey,
        runId: state.activeRunId,
        checkpointCount,
        completedCheckpointCount: state.nextCheckpointIndex,
        completedLaps: challengeRun.completedLaps || 0,
        crashCount: challengeRun.crashCount,
        challengeEndedOnCrash: true
    });
}

export function createRunPolicy({
    challengeRun = null
} = {}) {
    const objectiveType = challengeRun?.objectiveType || 'single_lap_fastest';
    return {
        id: `daily:${objectiveType}`,
        modeKey: TRACK_MODE_DAILY_GP,
        isDaily: true,
        objectiveType,
        requiredLaps: Math.max(1, Math.trunc(challengeRun?.requiredLaps || 1)),
        maxCrashes: challengeRun?.maxCrashes ?? null,
        bestResultComparator: objectiveType === 'finish_with_crash_budget'
            ? 'laps-then-time'
            : 'time'
    };
}

export function resolveRunPolicy(state) {
    return state?.currentRunPolicy || createRunPolicy({
        challengeRun: state?.currentChallengeRun || null
    });
}

export function handleFinishCrossing(state, policy, checkpointCount) {
    const challengeRun = state.currentChallengeRun || null;

    const completedLapTime = policy.objectiveType === 'finish_with_crash_budget'
        ? state.currentTime
        : state.currentTime - (Number.isFinite(challengeRun?.lastLapAt) ? challengeRun.lastLapAt : 0);

    if (challengeRun) {
        if (policy.objectiveType === 'finish_with_crash_budget') {
            challengeRun.elapsedTime = (challengeRun.elapsedTime || 0) + completedLapTime;
            state.currentTime = 0;
        } else {
            challengeRun.lastLapAt = state.currentTime;
        }
        challengeRun.completedLaps = (challengeRun.completedLaps || 0) + 1;
    }

    const result = {
        challengeLapCompleted: true,
        challengeCompletedLapTime: completedLapTime,
        challengeProgressLaps: challengeRun?.completedLaps || 1
    };
    if (
        policy.objectiveType !== 'finish_with_crash_budget'
        && (challengeRun?.completedLaps || 1) >= policy.requiredLaps
    ) {
        state.status = 'won';
        result.winTriggered = true;
        result.winData = createWinData(state, checkpointCount, {
            completedLaps: challengeRun?.completedLaps || 1,
            crashCount: challengeRun?.crashCount || 0
        });
    }
    return result;

}

export function handleHardCrash(state, policy, checkpointCount) {
    const challengeRun = state.currentChallengeRun || null;

    if (challengeRun && policy.objectiveType === 'finish_with_crash_budget') {
        challengeRun.crashCount = (challengeRun.crashCount || 0) + 1;
        challengeRun.elapsedTime = (challengeRun.elapsedTime || 0) + state.currentTime;
        if (
            policy.maxCrashes !== null
            && policy.maxCrashes !== undefined
            && challengeRun.crashCount >= policy.maxCrashes
        ) {
            state.status = 'won';
            return {
                winTriggered: true,
                winData: createCrashBudgetWinData(state, challengeRun, checkpointCount),
                challengeCrashCount: challengeRun.crashCount
            };
        }

        state.currentTime = 0;
        return {
            challengeCrashReset: true,
            challengeCrashCount: challengeRun.crashCount
        };
    }

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
