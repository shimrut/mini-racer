import { CONFIG } from '../../game/config.js';
import { updateSimulation } from '../../game/race/simulation.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../../game/track/runtime.js';
import { TRACKS } from '../../game/track/tracks.js';
import { createRunPolicy } from '../../game/race/run-policy.js';
import { getDailyChallengeRequiredLaps } from '../../game/daily-challenge/labels.js';
import type { DailyGpChallenge } from './daily-gp-model.js';
import {
    createPbGhostTraceRecorder,
    type PbGhostTrace,
} from './pb-ghost-trace.js';

export const MAX_REPLAY_FRAMES = 3_000;
export const REPLAY_FRAMES_PER_LAP = 2_500;

type ReplaySegment = {
    frames: number;
    left: boolean;
    right: boolean;
    relaunchDelay: boolean;
};

type ReplayPayload = {
    rulesRevision?: unknown;
    targetLapNumber?: unknown;
    inputs?: unknown;
};

type ReplayValidationResult = {
    bestTimeSec: number;
    bestTimeMs: number;
    completedLaps: number | null;
    checkpointTimesSec: number[] | null;
    lapCompletionTimesSec: number[] | null;
    ghost: PbGhostTrace | null;
    method: 'finish';
};

type ReplayValidationFailure = {
    reason: string;
    frameCount?: number;
    simulatedTimeSec?: number;
    checkpointIndex?: number;
    status?: string;
    position?: { x: number; y: number };
    speed?: number;
};

type ReplayValidationOutcome = {
    ok: true;
    run: ReplayValidationResult;
} | {
    ok: false;
    failure: ReplayValidationFailure;
};

function normalizeReplaySegment(raw: unknown): ReplaySegment | null {
    if (!raw || typeof raw !== 'object') return null;
    const segment = raw as Record<string, unknown>;
    const frames = Number(segment.frames);
    if (!Number.isInteger(frames) || frames < 1) return null;
    if (typeof segment.left !== 'boolean') return null;
    if (typeof segment.right !== 'boolean') return null;
    if (typeof segment.relaunchDelay !== 'boolean') return null;

    return {
        frames,
        left: segment.left,
        right: segment.right,
        relaunchDelay: segment.relaunchDelay,
    };
}

function normalizeReplayInputs(
    replay: unknown,
    maxFrames: number,
): { segments: ReplaySegment[]; frameCount: number } | ReplayValidationFailure {
    if (!replay || typeof replay !== 'object') return { reason: 'missing_replay' };
    const payload = replay as ReplayPayload;
    if (!Array.isArray(payload.inputs) || payload.inputs.length === 0) return { reason: 'missing_replay_inputs' };

    const segments: ReplaySegment[] = [];
    let frameCount = 0;
    for (const rawSegment of payload.inputs) {
        const segment = normalizeReplaySegment(rawSegment);
        if (!segment) return { reason: 'invalid_replay_segment' };
        frameCount += segment.frames;
        if (frameCount > maxFrames) return { reason: 'replay_too_long', frameCount };
        segments.push(segment);
    }
    return { segments, frameCount };
}

function createWriteOnlyBuffer() {
    let lastSlot: Record<string, unknown> | null = null;
    return {
        write() {
            lastSlot = {};
            return lastSlot;
        },
        last() {
            return lastSlot;
        },
        clear() {
            lastSlot = null;
        },
    };
}

function createSimulationState(
    challenge: DailyGpChallenge,
    track: Record<string, any>,
    requiredLaps: number,
    rulesRevision: number,
) {
    const challengeRun = {
        objectiveType: challenge.objectiveType,
        requiredLaps,
        rulesRevision,
        completedLaps: 0,
        lastLapAt: 0,
    };
    const collisionRuntime = buildCollisionRuntime(buildTrackGeometry(track));

    const state = {
        status: 'playing',
        relaunchDelayRemaining: 0,
        wallImpactCooldownRemaining: 0,
        wallContactActive: false,
        wallContactReleaseRemaining: 0,
        currentTime: 0,
        keys: { left: false, right: false },
        angle: track.startAngle,
        velocity: { x: 0, y: 0 },
        pos: { ...track.startPos },
        prevPos: { ...track.startPos },
        cachedSpeed: 0,
        angularVelocity: 0,
        nextCheckpointIndex: 0,
        currentTrackKey: challenge.trackKey,
        activeRunId: 'server-replay-validation',
        currentModeKey: 'daily',
        currentChallengeRun: challengeRun,
        currentRunPolicy: createRunPolicy({ challengeRun }),
        frameSkip: 0,
        qualityLevel: 0,
        collisionHash: collisionRuntime.collisionHash,
        particles: [],
        trailTimer: 0,
        runHistoryTimer: 0,
        lapCheckpointTimesSec: [],
        skidMarks: createWriteOnlyBuffer(),
        routeTrace: createWriteOnlyBuffer(),
        runHistory: createWriteOnlyBuffer(),
    };

    return { state, collisionSegments: collisionRuntime.collisionSegments };
}

function getStateFailureDetails(
    reason: string,
    state: Record<string, any>,
    frameCount: number,
): ReplayValidationFailure {
    return {
        reason,
        frameCount,
        simulatedTimeSec: Number.isFinite(state.currentTime)
            ? Math.round(Number(state.currentTime) * 1000) / 1000
            : undefined,
        checkpointIndex: Number.isFinite(state.nextCheckpointIndex)
            ? Math.trunc(Number(state.nextCheckpointIndex))
            : undefined,
        status: typeof state.status === 'string' ? state.status : undefined,
        position: state.pos && Number.isFinite(state.pos.x) && Number.isFinite(state.pos.y)
            ? {
                x: Math.round(Number(state.pos.x) * 1000) / 1000,
                y: Math.round(Number(state.pos.y) * 1000) / 1000,
            }
            : undefined,
        speed: Number.isFinite(state.cachedSpeed)
            ? Math.round(Number(state.cachedSpeed) * 1000) / 1000
            : undefined,
    };
}

export function validateDailyGpReplayDetailed({
    challenge,
    replay,
    track = TRACKS[challenge.trackKey],
}: {
    challenge: DailyGpChallenge;
    replay?: unknown;
    track?: Record<string, any>;
}): ReplayValidationOutcome {
    if (!challenge || !track) {
        return {
            ok: false,
            failure: { reason: 'unknown_track' },
        };
    }

    const requiredLaps = getDailyChallengeRequiredLaps(challenge);
    const challengeRulesRevision = Number.isInteger(challenge.rulesRevision)
        ? Math.max(0, Number(challenge.rulesRevision))
        : 0;
    const replayPayload = replay && typeof replay === 'object'
        ? replay as ReplayPayload
        : null;
    const replayRulesRevision = replayPayload?.rulesRevision == null
        ? 0
        : replayPayload.rulesRevision;
    if (
        !Number.isInteger(replayRulesRevision)
        || replayRulesRevision < 0
        || replayRulesRevision !== challengeRulesRevision
    ) {
        return {
            ok: false,
            failure: { reason: 'rules_revision_mismatch' },
        };
    }
    const maxReplayFrames = replayRulesRevision === 0
        ? MAX_REPLAY_FRAMES
        : REPLAY_FRAMES_PER_LAP * requiredLaps;
    const normalizedReplay = normalizeReplayInputs(replay, maxReplayFrames);
    if ('reason' in normalizedReplay) {
        return {
            ok: false,
            failure: normalizedReplay,
        };
    }
    const targetLapNumber = replayPayload?.targetLapNumber == null
        && replayRulesRevision === 0
        ? 1
        : replayPayload?.targetLapNumber;
    if (!Number.isInteger(targetLapNumber) || targetLapNumber !== requiredLaps) {
        return {
            ok: false,
            failure: { reason: 'target_lap_mismatch' },
        };
    }
    const { segments, frameCount } = normalizedReplay;

    const { state, collisionSegments } = createSimulationState(
        challenge,
        track,
        requiredLaps,
        challengeRulesRevision,
    );
    const config = { ...CONFIG };
    const fixedDt = Number(config.fixedDt) || (1 / 60);
    const ghostRecorder = createPbGhostTraceRecorder({
        timeSec: 0,
        position: state.pos,
        angle: state.angle,
    });
    const lapCompletionTimesSec: number[] = [];

    for (const segment of segments) {
        for (let frame = 0; frame < segment.frames; frame += 1) {
            if (state.status !== 'playing') {
                return {
                    ok: false,
                    failure: getStateFailureDetails('ended_before_replay_finished', state, frameCount),
                };
            }

            state.keys.left = segment.left;
            state.keys.right = segment.right;
            if (segment.relaunchDelay) {
                // Exactly fixedDt so the step decrements it to 0; a residual freezes one extra frame and shifts every later input.
                state.relaunchDelayRemaining = fixedDt;
            }

            const events = updateSimulation(
                state,
                fixedDt,
                config,
                track,
                collisionSegments,
            );
            ghostRecorder.sample({
                timeSec: state.currentTime,
                position: state.pos,
                angle: state.angle,
            });

            if (events.crashEndedRun || state.status === 'crashed') {
                return {
                    ok: false,
                    failure: getStateFailureDetails('crashed', state, frameCount),
                };
            }
            if (
                events.challengeLapCompleted
                && Number.isFinite(events.challengeElapsedTime)
            ) {
                lapCompletionTimesSec.push(Number(events.challengeElapsedTime));
            }
            if (events.winTriggered) {
                const bestTimeSec = Number(events.winData?.lapTime);
                if (!Number.isFinite(bestTimeSec)) {
                    return {
                        ok: false,
                        failure: getStateFailureDetails('missing_win_time', state, frameCount),
                    };
                }
                return {
                    ok: true,
                    run: {
                        bestTimeSec,
                        bestTimeMs: Math.round(bestTimeSec * 1000),
                        completedLaps: Number.isFinite(events.winData?.completedLaps)
                            ? Math.trunc(Number(events.winData.completedLaps))
                            : null,
                        checkpointTimesSec: Array.isArray(state.lapCheckpointTimesSec) && state.lapCheckpointTimesSec.length
                            ? state.lapCheckpointTimesSec.slice()
                            : null,
                        lapCompletionTimesSec: lapCompletionTimesSec.length === requiredLaps
                            ? lapCompletionTimesSec.slice()
                            : null,
                        ghost: ghostRecorder.finish({
                            timeSec: bestTimeSec,
                            position: state.pos,
                            angle: state.angle,
                        }),
                        method: 'finish',
                    },
                };
            }
        }
    }

    return {
        ok: false,
        failure: getStateFailureDetails('no_finish', state, frameCount),
    };
}
