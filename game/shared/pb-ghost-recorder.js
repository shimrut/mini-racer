import {
    PB_GHOST_ANGLE_SCALE,
    PB_GHOST_MAX_SAMPLES,
    PB_GHOST_POSITION_SCALE,
    PB_GHOST_SAMPLE_INTERVAL_MS,
    PB_GHOST_SAMPLE_RATE_HZ,
    PB_GHOST_SCHEMA_VERSION,
} from './pb-ghost-format.js';

const FULL_TURN_MILLI = Math.round(Math.PI * 2 * PB_GHOST_ANGLE_SCALE);
const HALF_TURN_MILLI = Math.round(Math.PI * PB_GHOST_ANGLE_SCALE);

function quantizePose(timeSec, position, angle) {
    if (
        !Number.isFinite(timeSec)
        || timeSec < 0
        || !Number.isFinite(position?.x)
        || !Number.isFinite(position?.y)
        || !Number.isFinite(angle)
    ) {
        return null;
    }
    return {
        timeMs: Math.max(0, Math.round(timeSec * 1000)),
        xCm: Math.round(position.x * PB_GHOST_POSITION_SCALE),
        yCm: Math.round(position.y * PB_GHOST_POSITION_SCALE),
        angleMilli: Math.round(angle * PB_GHOST_ANGLE_SCALE),
    };
}

function shortestAngleDeltaMilli(next, previous) {
    let delta = next - previous;
    while (delta > HALF_TURN_MILLI) delta -= FULL_TURN_MILLI;
    while (delta < -HALF_TURN_MILLI) delta += FULL_TURN_MILLI;
    return delta;
}

function isFiniteRawPose(pose) {
    return (
        Number.isFinite(pose.timeSec)
        && pose.timeSec >= 0
        && Number.isFinite(pose.position?.x)
        && Number.isFinite(pose.position?.y)
        && Number.isFinite(pose.angle)
    );
}

function cloneRawPose(pose) {
    return {
        timeSec: pose.timeSec,
        position: { x: pose.position.x, y: pose.position.y },
        angle: pose.angle,
    };
}

function shortestAngleDeltaRad(next, previous) {
    let delta = next - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return delta;
}

function lerpRawPoseAtTime(last, current, atTimeSec) {
    const span = current.timeSec - last.timeSec;
    if (span <= Number.EPSILON) {
        return {
            timeSec: atTimeSec,
            position: { x: current.position.x, y: current.position.y },
            angle: current.angle,
        };
    }
    const progress = Math.min(1, Math.max(0, (atTimeSec - last.timeSec) / span));
    return {
        timeSec: atTimeSec,
        position: {
            x: last.position.x + (current.position.x - last.position.x) * progress,
            y: last.position.y + (current.position.y - last.position.y) * progress,
        },
        angle: last.angle + shortestAngleDeltaRad(current.angle, last.angle) * progress,
    };
}

export function createPbGhostPoseRecorder(initialPose) {
    const sampleIntervalSec = 1 / PB_GHOST_SAMPLE_RATE_HZ;
    const poses = [];
    let nextSampleTimeSec = 0;
    let overflowed = false;
    let lastPose = isFiniteRawPose(initialPose)
        ? cloneRawPose(initialPose)
        : { timeSec: 0, position: { x: 0, y: 0 }, angle: 0 };

    function appendPose(pose, exact = false) {
        if (overflowed) return;
        const sample = quantizePose(pose.timeSec, pose.position, pose.angle);
        if (!sample) return;
        const previous = poses.at(-1);
        if (
            previous
            && previous.timeMs === sample.timeMs
            && previous.xCm === sample.xCm
            && previous.yCm === sample.yCm
            && previous.angleMilli === sample.angleMilli
        ) {
            return;
        }
        if (exact && previous?.timeMs === sample.timeMs) {
            poses[poses.length - 1] = sample;
            return;
        }
        if (poses.length >= PB_GHOST_MAX_SAMPLES) {
            overflowed = true;
            return;
        }
        poses.push(sample);
    }

    appendPose(initialPose, true);
    nextSampleTimeSec = sampleIntervalSec;

    return {
        sample(pose) {
            if (overflowed) return;
            if (!isFiniteRawPose(pose)) return;

            while (pose.timeSec + Number.EPSILON >= nextSampleTimeSec) {
                appendPose(lerpRawPoseAtTime(lastPose, pose, nextSampleTimeSec));
                nextSampleTimeSec += sampleIntervalSec;
                if (overflowed) break;
            }
            lastPose = cloneRawPose(pose);
        },
        finish(pose) {
            appendPose(pose, true);
            if (overflowed || poses.length < 2) return null;
            const finishPose = poses.at(-1);
            if (!finishPose) return null;
            const finishTimeMs = finishPose.timeMs;
            if (!Number.isSafeInteger(finishTimeMs) || finishTimeMs <= 0) return null;

            const requiredCount = Math.ceil(finishTimeMs / PB_GHOST_SAMPLE_INTERVAL_MS) + 1;
            if (requiredCount < 2 || requiredCount > PB_GHOST_MAX_SAMPLES) return null;

            const regularPoses = poses.slice(0, -1);
            while (regularPoses.length + 1 < requiredCount) {
                const padSource = regularPoses.at(-1);
                if (!padSource) return null;
                regularPoses.push({ ...padSource });
            }
            if (regularPoses.length + 1 > requiredCount) {
                regularPoses.length = requiredCount - 1;
            }
            if (regularPoses.length < 1) return null;

            const alignedPoses = [...regularPoses, finishPose];
            const originPose = alignedPoses[0];
            const deltas = [];
            let previous = originPose;
            for (let index = 1; index < alignedPoses.length; index += 1) {
                const current = alignedPoses[index];
                deltas.push(
                    current.xCm - previous.xCm,
                    current.yCm - previous.yCm,
                    shortestAngleDeltaMilli(current.angleMilli, previous.angleMilli),
                );
                previous = current;
            }
            return {
                schemaVersion: PB_GHOST_SCHEMA_VERSION,
                sampleIntervalMs: PB_GHOST_SAMPLE_INTERVAL_MS,
                finishTimeMs,
                origin: [originPose.xCm, originPose.yCm, originPose.angleMilli],
                deltas,
            };
        },
    };
}
