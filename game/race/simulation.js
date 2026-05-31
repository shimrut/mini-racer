import { clamp, KPH_PER_WORLD_UNIT } from '../car/handling.js?v=1.91';
import { segmentsIntersect } from '../config.js?v=1.91';
import {
    handleFinishCrossing,
    handleHardCrash,
    resolveRunPolicy
} from './run-policy.js?v=1.91';

const _nextPos = { x: 0, y: 0 };
const _events = {
    winTriggered: false,
    winData: null,
    challengeLapCompleted: false,
    challengeCompletedLapTime: null,
    challengeProgressLaps: 0,
    challengeFailed: false,
    challengeFailureReason: null,
    crashImpact: null,
    crashEndedRun: false,
    checkpointPassed: null
};

function resetEvents() {
    _events.winTriggered = false;
    _events.winData = null;
    _events.challengeLapCompleted = false;
    _events.challengeCompletedLapTime = null;
    _events.challengeProgressLaps = 0;
    _events.challengeFailed = false;
    _events.challengeFailureReason = null;
    _events.crashImpact = null;
    _events.crashEndedRun = false;
    _events.checkpointPassed = null;
}

function createSparkParticles(pos, count, sparkColor) {
    const particles = [];

    for (let i = 0; i < count; i++) {
        const spread = 0.5;
        const px = pos.x + (Math.random() - 0.5) * spread;
        const py = pos.y + (Math.random() - 0.5) * spread;

        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 5;
        const pvX = Math.cos(angle) * speed;
        const pvY = Math.sin(angle) * speed;
        const life = 0.2 + Math.random() * 0.2;

        particles.push({
            x: px,
            y: py,
            vx: pvX,
            vy: pvY,
            life,
            maxLife: life,
            color: sparkColor,
            size: 2
        });
    }

    return particles;
}

function checkWallCollision(p1, p2, wallSegments, carRadius) {
    if (!wallSegments || wallSegments.length === 0) return false;

    const carRadiusSq = carRadius * carRadius;

    for (let i = 0; i < wallSegments.length; i++) {
        const segment = wallSegments[i];

        if (segmentsIntersect(p1, p2, segment.start, segment.end)) return true;

        const ax = p2.x - segment.start.x;
        const ay = p2.y - segment.start.y;
        let param = -1;
        if (segment.lenSq !== 0) {
            param = (ax * segment.dx + ay * segment.dy) / segment.lenSq;
        }

        let xx;
        let yy;
        if (param < 0) {
            xx = segment.start.x;
            yy = segment.start.y;
        } else if (param > 1) {
            xx = segment.end.x;
            yy = segment.end.y;
        } else {
            xx = segment.start.x + param * segment.dx;
            yy = segment.start.y + param * segment.dy;
        }

        const dx = p2.x - xx;
        const dy = p2.y - yy;
        if ((dx * dx + dy * dy) < carRadiusSq) {
            return true;
        }
    }

    return false;
}

function getCollisionCandidates(p1, p2, collisionData, carRadius) {
    if (!collisionData) return [];
    if (Array.isArray(collisionData)) return collisionData;
    if (!collisionData.cells || !collisionData.segments) return [];

    const expandedMinX = Math.min(p1.x, p2.x) - carRadius;
    const expandedMaxX = Math.max(p1.x, p2.x) + carRadius;
    const expandedMinY = Math.min(p1.y, p2.y) - carRadius;
    const expandedMaxY = Math.max(p1.y, p2.y) + carRadius;
    const startCellX = Math.floor(expandedMinX / collisionData.cellSize);
    const endCellX = Math.floor(expandedMaxX / collisionData.cellSize);
    const startCellY = Math.floor(expandedMinY / collisionData.cellSize);
    const endCellY = Math.floor(expandedMaxY / collisionData.cellSize);
    const stamp = ++collisionData.queryStamp;
    const candidates = collisionData.candidateSegments;
    candidates.length = 0;

    for (let cellY = startCellY; cellY <= endCellY; cellY++) {
        for (let cellX = startCellX; cellX <= endCellX; cellX++) {
            const bucket = collisionData.cells.get(`${cellX},${cellY}`);
            if (!bucket) continue;

            for (let i = 0; i < bucket.length; i++) {
                const segment = bucket[i];
                if (segment.queryStamp === stamp) continue;
                segment.queryStamp = stamp;
                candidates.push(segment);
            }
        }
    }

    return candidates.length > 0 ? candidates : collisionData.segments;
}

function checkFinishLine(p1, p2, startLine) {
    return segmentsIntersect(p1, p2, startLine.p1, startLine.p2);
}

const SKID_MARK_MIN_SLIP_RATIO = 0.28;
const SKID_MARK_MIN_SPEED = 2.5;

/** World-space rear axle (skid / trail anchor) from car center `pos` and `angle`. */
export function getCarRearAxleWorldPoint(pos, angle, config) {
    const vx = Math.cos(angle);
    const vy = Math.sin(angle);
    const rearOff = Number.isFinite(Number(config?.carRearAxleOffset))
        ? Math.max(0, Number(config.carRearAxleOffset))
        : 0;
    return {
        x: pos.x - vx * rearOff,
        y: pos.y - vy * rearOff
    };
}

export function updateSimulation(
    state, dt, config, currentTrack, collisionSegments
) {
    resetEvents();
    const runPolicy = resolveRunPolicy(state);

    if (state.status === 'playing') {
        if (state.relaunchDelayRemaining > 0) {
            state.relaunchDelayRemaining = Math.max(0, state.relaunchDelayRemaining - dt);
        } else {
            state.currentTime += dt;

            const steerInput = (state.keys.right ? 1 : 0) - (state.keys.left ? 1 : 0);
            const accel = Number(config.accel) || 0;
            const safeMaxSpeed = Math.max(0.001, (Number(config.maxSpeed) || 220) / KPH_PER_WORLD_UNIT);
            const gripBase = Math.max(0, Number(config.grip) || 0);
            const brakePower = Number(config.brakePower) || 20;
            const currentSpeed = Math.sqrt(state.velocity.x ** 2 + state.velocity.y ** 2);
            const speedRatio = clamp(currentSpeed / safeMaxSpeed, 0, 1);

            const steerTrim = Number(config.highSpeedSteerTrim);
            const steerSpeedFactor = (Number.isFinite(steerTrim) && steerTrim > 0)
                ? 1 - steerTrim * speedRatio * speedRatio
                : 1;
            const desiredAngularVelocity = steerInput * (Number(config.turnRate) || 0) * steerSpeedFactor;

            const angularResponse = Number.isFinite(Number(config.angularResponse))
                ? clamp(Number(config.angularResponse), 4, 48)
                : 14;

            state.angularVelocity = Number.isFinite(state.angularVelocity) ? state.angularVelocity : 0;
            state.angularVelocity += (desiredAngularVelocity - state.angularVelocity) * Math.min(1, angularResponse * dt);
            if (steerInput === 0) {
                state.angularVelocity *= Math.exp(-6 * dt);
            }
            state.angle += state.angularVelocity * dt;

            const headingX = Math.cos(state.angle);
            const headingY = Math.sin(state.angle);
            const sideX = -headingY;
            const sideY = headingX;

            let forwardSpeed = (
                state.velocity.x * headingX
                + state.velocity.y * headingY
            );
            let lateralSpeed = (
                state.velocity.x * sideX
                + state.velocity.y * sideY
            );
            const tractionSlipRatio = currentSpeed > 0.001
                ? clamp(Math.abs(lateralSpeed) / currentSpeed, 0, 1)
                : 0;
            const latBeforeGrip = lateralSpeed;
            const absLatForTotalCap = Math.min(Math.abs(latBeforeGrip), safeMaxSpeed);
            const longitudinalLimit = Math.sqrt(Math.max(
                0,
                safeMaxSpeed * safeMaxSpeed - absLatForTotalCap * absLatForTotalCap
            ));
            // Forward-speed drag (cornering feel), but only while forward component has
            // room under the total-speed ceiling — avoids forward-only "boost" at max |v|.
            if (accel > 0 && currentSpeed < safeMaxSpeed && forwardSpeed < longitudinalLimit) {
                // Taper acceleration from total speed (not forward/longLim). Steering yaws the
                // heading before this split, which lowers forward projection even when |v| is
                // already near max — forward/denom drag was reopening full thrust in corners.
                const dragFactor = 1 - speedRatio ** 2;
                forwardSpeed += ((accel / KPH_PER_WORLD_UNIT) * dragFactor) * dt;
            }

            if (forwardSpeed < 0) {
                forwardSpeed = Math.min(
                    0,
                    forwardSpeed + (((brakePower / KPH_PER_WORLD_UNIT)) * dt)
                );
            }



            const downforce = Number(config.downforceGrip);
            const gripFromDownforce = (Number.isFinite(downforce) && downforce > 0)
                ? gripBase * downforce * speedRatio * speedRatio
                : 0;
            const effectiveGrip = gripBase + gripFromDownforce;
            const steerGripScale = Number.isFinite(Number(config.steerGripScale))
                ? clamp(Number(config.steerGripScale), 0.05, 1.5)
                : 0.45;
            const activeGrip = Math.max(0, effectiveGrip) * (steerInput === 0 ? 1 : steerGripScale);
            lateralSpeed *= Math.exp(-activeGrip * dt);

            state.velocity.x = (headingX * forwardSpeed) + (sideX * lateralSpeed);
            state.velocity.y = (headingY * forwardSpeed) + (sideY * lateralSpeed);

            // The configured max speed is authoritative and caps the total car speed.
            state.cachedSpeed = Math.sqrt(state.velocity.x ** 2 + state.velocity.y ** 2);
            let allowedSpeed = safeMaxSpeed;
            if (steerInput !== 0) {
                const slip = tractionSlipRatio;
                if (typeof state.slipSpeedGateClamp !== 'boolean') {
                    state.slipSpeedGateClamp = false;
                }
                const slipClampOn = 0.11;
                const slipClampOff = 0.055;
                if (slip >= slipClampOn) {
                    state.slipSpeedGateClamp = true;
                } else if (slip <= slipClampOff) {
                    state.slipSpeedGateClamp = false;
                }
                if (state.slipSpeedGateClamp) {
                    allowedSpeed = Math.min(safeMaxSpeed, currentSpeed);
                }
            } else {
                state.slipSpeedGateClamp = false;
            }
            if (state.cachedSpeed > allowedSpeed) {
                const speedScale = allowedSpeed / state.cachedSpeed;
                state.velocity.x *= speedScale;
                state.velocity.y *= speedScale;
            }

            state.cachedSpeed = Math.sqrt(state.velocity.x ** 2 + state.velocity.y ** 2);

            _nextPos.x = state.pos.x + state.velocity.x * dt;
            _nextPos.y = state.pos.y + state.velocity.y * dt;

            const hitWall = checkWallCollision(
                state.pos,
                _nextPos,
                getCollisionCandidates(state.pos, _nextPos, state.collisionHash || collisionSegments, config.carRadius),
                config.carRadius
            );

            const checkpoints = currentTrack.checkpoints || [];
            if (state.nextCheckpointIndex < checkpoints.length) {
                const cp = checkpoints[state.nextCheckpointIndex];
                if (segmentsIntersect(state.pos, _nextPos, cp.p1, cp.p2)) {
                    if (!Array.isArray(state.lapCheckpointTimesSec)) {
                        state.lapCheckpointTimesSec = [];
                    }
                    state.lapCheckpointTimesSec.push(state.currentTime);
                    state.nextCheckpointIndex++;
                    _events.checkpointPassed = {
                        index: state.lapCheckpointTimesSec.length - 1,
                        splitTimeSec: state.currentTime
                    };
                }
            }

            const crossedFinish = checkFinishLine(state.pos, _nextPos, currentTrack.startLine);
            const allPassed = checkpoints.length === 0 || state.nextCheckpointIndex >= checkpoints.length;
            if (crossedFinish) {
                if (allPassed && state.currentTime >= 2.0) {
                    Object.assign(_events, handleFinishCrossing(state, runPolicy, checkpoints.length));
                }
                state.nextCheckpointIndex = 0;
            }

            if (hitWall) {
                const impact = Math.round(state.cachedSpeed * 20);
                _events.crashImpact = impact;

                if (state.cachedSpeed > config.crashSpeed) {
                    const particleCount = state.frameSkip > 0 ? 10 : 20;
                    const crashSparks = createSparkParticles(state.pos, particleCount * 5, config.sparkColor);
                    for (let j = 0; j < crashSparks.length; j++) state.particles.push(crashSparks[j]);
                    Object.assign(_events, handleHardCrash(state, runPolicy, checkpoints.length));
                } else {
                    state.velocity.x *= -0.5;
                    state.velocity.y *= -0.5;
                    state.cachedSpeed = Math.sqrt(state.velocity.x ** 2 + state.velocity.y ** 2);
                    const particleCount = state.frameSkip > 0 ? 3 : 5;
                    const bounceSparks = createSparkParticles(state.pos, particleCount * 5, config.sparkColor);
                    for (let j = 0; j < bounceSparks.length; j++) state.particles.push(bounceSparks[j]);
                }
            } else {
                state.pos.x = _nextPos.x;
                state.pos.y = _nextPos.y;
            }

            const vx = Math.cos(state.angle);
            const vy = Math.sin(state.angle);
            const { x: rearX, y: rearY } = getCarRearAxleWorldPoint(state.pos, state.angle, config);
            const sideSlip = Math.abs((-vy * state.velocity.x) + (vx * state.velocity.y));
            const slipRatio = state.cachedSpeed > 0.001 ? sideSlip / state.cachedSpeed : 0;

            if (slipRatio > SKID_MARK_MIN_SLIP_RATIO && state.cachedSpeed > SKID_MARK_MIN_SPEED) {
                const slot = state.skidMarks.write();
                slot.x = rearX;
                slot.y = rearY;
                slot.cos = vx;
                slot.sin = vy;
            }

            state.trailTimer += dt;
            const traceInterval = (state.frameSkip > 0 || state.qualityLevel > 0) ? 0.08 : 0.05;
            if (state.trailTimer > traceInterval) {
                const slot = state.routeTrace.write();
                slot.x = rearX;
                slot.y = rearY;
                state.trailTimer %= traceInterval;
            }

            state.runHistoryTimer += dt;
            if (state.runHistoryTimer >= 0.05) {
                const rx = Math.round(rearX * 1000) / 1000;
                const ry = Math.round(rearY * 1000) / 1000;
                const last = state.runHistory.last();
                if (!last || Math.abs(last.x - rx) >= 0.001 || Math.abs(last.y - ry) >= 0.001) {
                    const slot = state.runHistory.write();
                    slot.x = rx;
                    slot.y = ry;
                }
                state.runHistoryTimer %= 0.05;
            }
        }
    }

    const maxParticles = state.frameSkip > 0 ? 30 : 50;
    const particles = state.particles;
    const particleStart = Math.max(0, particles.length - maxParticles);
    let writeIdx = 0;
    for (let i = particleStart; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
        if (p.life > 0) {
            particles[writeIdx++] = p;
        }
    }
    particles.length = writeIdx;

    return _events;
}
