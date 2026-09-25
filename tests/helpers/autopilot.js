import { CONFIG } from '../../game/config.js';
import { updateSimulation } from '../../game/race/simulation.js';
import { createRunPolicy } from '../../game/race/run-policy.js';
import { buildCollisionRuntime, buildTrackGeometry } from '../../game/track/runtime.js';

const CENTERLINE_SAMPLES = 400;

function createWriteOnlyBuffer() {
    let lastSlot = null;
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

function closestPointOnPolygon(point, polygon) {
    let closest = null;
    let closestDistance = Infinity;
    for (let index = 0; index < polygon.length; index++) {
        const start = polygon[index];
        const end = polygon[(index + 1) % polygon.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSq = dx * dx + dy * dy;
        const rawParam = lengthSq > 0
            ? ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq
            : 0;
        const param = Math.max(0, Math.min(1, rawParam));
        const candidate = { x: start.x + param * dx, y: start.y + param * dy };
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        if (distance < closestDistance) {
            closestDistance = distance;
            closest = candidate;
        }
    }
    return closest;
}

function buildCenterline(track) {
    const { outer, inner } = buildTrackGeometry(track);
    const points = [];
    for (let sample = 0; sample < CENTERLINE_SAMPLES; sample++) {
        const position = (sample / CENTERLINE_SAMPLES) * outer.length;
        const index = Math.floor(position);
        const start = outer[index];
        const end = outer[(index + 1) % outer.length];
        const fraction = position - index;
        const outerPoint = {
            x: start.x + (end.x - start.x) * fraction,
            y: start.y + (end.y - start.y) * fraction,
        };
        const innerPoint = closestPointOnPolygon(outerPoint, inner);
        points.push({
            x: (outerPoint.x + innerPoint.x) / 2,
            y: (outerPoint.y + innerPoint.y) / 2,
        });
    }
    return points;
}

function findNearestIndex(points, position) {
    let nearestIndex = 0;
    let nearestDistanceSq = Infinity;
    for (let index = 0; index < points.length; index++) {
        const dx = points[index].x - position.x;
        const dy = points[index].y - position.y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < nearestDistanceSq) {
            nearestDistanceSq = distanceSq;
            nearestIndex = index;
        }
    }
    return nearestIndex;
}

export function createReplaySimulationState(track, { trackKey = 'autopilot', laps = 1 } = {}) {
    const challengeRun = {
        objectiveType: laps > 1 ? 'multi_lap_total' : 'single_lap_fastest',
        requiredLaps: laps,
        rulesRevision: 1,
        completedLaps: 0,
        lastLapAt: 0,
    };
    const collisionRuntime = buildCollisionRuntime(buildTrackGeometry(track));
    return {
        collisionSegments: collisionRuntime.collisionSegments,
        state: {
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
            currentTrackKey: trackKey,
            activeRunId: 'autopilot',
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
        },
    };
}

// Steers toward a point a few samples ahead on the track centerline, and
// records the key presses as a scoreboard replay.
export function driveAutopilot(track, {
    laps = 1,
    lookAhead = 6,
    deadZone = 0.08,
    maxFrames = 2500 * laps,
    config = { ...CONFIG },
} = {}) {
    const centerline = buildCenterline(track);
    const startIndex = findNearestIndex(centerline, track.startPos);
    const ahead = centerline[(startIndex + 3) % centerline.length];
    const heading = { x: Math.cos(track.startAngle), y: Math.sin(track.startAngle) };
    const direction = (
        (ahead.x - track.startPos.x) * heading.x + (ahead.y - track.startPos.y) * heading.y
    ) > 0 ? 1 : -1;

    const { state, collisionSegments } = createReplaySimulationState(track, { laps });
    const inputs = [];
    let winData = null;
    let wallImpacts = 0;
    let frames = 0;

    while (frames < maxFrames) {
        const nearest = findNearestIndex(centerline, state.pos);
        const targetIndex = (
            nearest + direction * lookAhead + centerline.length
        ) % centerline.length;
        const target = centerline[targetIndex];
        const wanted = Math.atan2(target.y - state.pos.y, target.x - state.pos.x);
        const rawDelta = wanted - state.angle;
        const delta = Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta));
        const left = delta < -deadZone;
        const right = delta > deadZone;

        state.keys.left = left;
        state.keys.right = right;
        const last = inputs[inputs.length - 1];
        if (last && last.left === left && last.right === right) {
            last.frames += 1;
        } else {
            inputs.push({ frames: 1, left, right, relaunchDelay: false });
        }
        frames += 1;

        const events = updateSimulation(state, config.fixedDt, config, track, collisionSegments);
        if (events.wallImpact) wallImpacts += 1;
        if (events.winTriggered) {
            winData = events.winData;
            break;
        }
    }

    return {
        winData,
        wallImpacts,
        frames,
        state,
        replay: { rulesRevision: 1, targetLapNumber: laps, inputs },
    };
}
