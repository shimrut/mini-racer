import { KPH_PER_WORLD_UNIT } from '../car/handling.js';
import { clamp } from '../shared/clamp.js';
import { getCrossingFraction, getIntersection } from '../track/geometry.js';
import {
    handleFinishCrossing,
    resolveRunPolicy
} from './run-policy.js';

/** End-of-step clock is `currentTime`; crossing happened `fraction` through this `dt`. */
export function crossingTimeSec(currentTime, dt, fraction) {
    const t = Math.min(1, Math.max(0, Number(fraction)));
    if (!Number.isFinite(t) || !Number.isFinite(currentTime) || !Number.isFinite(dt)) {
        return currentTime;
    }
    return currentTime - dt + t * dt;
}

const _nextPos = { x: 0, y: 0 };
const _events = {
    winTriggered: false,
    winData: null,
    challengeLapCompleted: false,
    challengeCompletedLapTime: null,
    challengeElapsedTime: null,
    challengeProgressLaps: 0,
    challengeRequiredLaps: 0,
    challengeIsFinalLap: false,
    challengeFailed: false,
    challengeFailureReason: null,
    wallImpact: null,
    crashImpact: null,
    crashEndedRun: false,
    checkpointPassed: null
};

function resetEvents() {
    _events.winTriggered = false;
    _events.winData = null;
    _events.challengeLapCompleted = false;
    _events.challengeCompletedLapTime = null;
    _events.challengeElapsedTime = null;
    _events.challengeProgressLaps = 0;
    _events.challengeRequiredLaps = 0;
    _events.challengeIsFinalLap = false;
    _events.challengeFailed = false;
    _events.challengeFailureReason = null;
    _events.wallImpact = null;
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

const CONTACT_EPSILON = 1e-9;
const MAX_CONTACT_RESOLUTION_PASSES = 12;

function getClosestPointOnSegment(point, segment) {
    const ax = point.x - segment.start.x;
    const ay = point.y - segment.start.y;
    const rawParam = segment.lenSq > 0
        ? (ax * segment.dx + ay * segment.dy) / segment.lenSq
        : 0;
    const param = clamp(rawParam, 0, 1);
    return {
        x: segment.start.x + param * segment.dx,
        y: segment.start.y + param * segment.dy,
        param
    };
}

function createSegment(start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    return { start, end, dx, dy, lenSq: dx * dx + dy * dy };
}

function createCarAxis(center, angle, halfLength) {
    const x = Math.cos(angle) * halfLength;
    const y = Math.sin(angle) * halfLength;
    return createSegment(
        { x: center.x - x, y: center.y - y },
        { x: center.x + x, y: center.y + y }
    );
}

function getClosestSegmentPair(first, second) {
    const intersection = getIntersection(first.start, first.end, second.start, second.end);
    if (intersection) {
        return { first: intersection, second: intersection, distance: 0 };
    }

    const candidates = [];
    const firstStartToSecond = getClosestPointOnSegment(first.start, second);
    candidates.push({ first: first.start, second: firstStartToSecond });
    const firstEndToSecond = getClosestPointOnSegment(first.end, second);
    candidates.push({ first: first.end, second: firstEndToSecond });
    const secondStartToFirst = getClosestPointOnSegment(second.start, first);
    candidates.push({ first: secondStartToFirst, second: second.start });
    const secondEndToFirst = getClosestPointOnSegment(second.end, first);
    candidates.push({ first: secondEndToFirst, second: second.end });

    let selected = null;
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        const dx = candidate.first.x - candidate.second.x;
        const dy = candidate.first.y - candidate.second.y;
        const distanceSq = dx * dx + dy * dy;
        if (!selected || distanceSq < selected.distanceSq - CONTACT_EPSILON) {
            selected = { ...candidate, distanceSq };
        }
    }
    return { ...selected, distance: Math.sqrt(selected.distanceSq) };
}

function getSafeContactNormal(safePoint, segment, wallPoint, bodyPoint, distance) {
    if (distance > CONTACT_EPSILON) {
        let normalX = (bodyPoint.x - wallPoint.x) / distance;
        let normalY = (bodyPoint.y - wallPoint.y) / distance;
        const safeSide = (safePoint.x - wallPoint.x) * normalX + (safePoint.y - wallPoint.y) * normalY;
        if (safeSide < 0) {
            normalX *= -1;
            normalY *= -1;
        }
        return { x: normalX, y: normalY };
    }

    const segmentLength = Math.sqrt(segment.lenSq);
    const startDistance = Math.hypot(wallPoint.x - segment.start.x, wallPoint.y - segment.start.y);
    const endDistance = Math.hypot(wallPoint.x - segment.end.x, wallPoint.y - segment.end.y);
    const atEndpoint = startDistance <= 1e-7 || endDistance <= 1e-7;

    if (atEndpoint) {
        let dx = safePoint.x - wallPoint.x;
        let dy = safePoint.y - wallPoint.y;
        let length = Math.hypot(dx, dy);
        if (length < CONTACT_EPSILON) {
            dx = bodyPoint.x - wallPoint.x;
            dy = bodyPoint.y - wallPoint.y;
            length = Math.hypot(dx, dy);
        }
        if (length >= CONTACT_EPSILON) {
            return { x: dx / length, y: dy / length };
        }
    }

    if (segmentLength < CONTACT_EPSILON) return { x: 1, y: 0 };
    let normalX = -segment.dy / segmentLength;
    let normalY = segment.dx / segmentLength;
    const side = (safePoint.x - wallPoint.x) * normalX + (safePoint.y - wallPoint.y) * normalY;
    if (side < 0) {
        normalX *= -1;
        normalY *= -1;
    }
    return { x: normalX, y: normalY };
}

function getBodyPointVelocity(velocity, angularVelocity, bodyOffset) {
    return {
        x: velocity.x - angularVelocity * bodyOffset.y,
        y: velocity.y + angularVelocity * bodyOffset.x
    };
}

function buildContact({
    segment,
    segmentIndex,
    wallPoint,
    bodyAxisPoint,
    bodyAxisOffset,
    safePoint,
    distance,
    penetration,
    velocity,
    angularVelocity,
    carRadius,
    swept = false
}) {
    const normal = getSafeContactNormal(safePoint, segment, wallPoint, bodyAxisPoint, distance);
    const bodyOffset = {
        x: bodyAxisOffset.x - normal.x * carRadius,
        y: bodyAxisOffset.y - normal.y * carRadius
    };
    const contactVelocity = getBodyPointVelocity(velocity, angularVelocity, bodyOffset);
    const normalVelocity = contactVelocity.x * normal.x + contactVelocity.y * normal.y;
    return {
        segment,
        segmentIndex,
        closestPoint: wallPoint,
        wallPoint,
        bodyAxisOffset,
        bodyOffset,
        tangent: { x: -normal.y, y: normal.x },
        normal,
        distance,
        penetration,
        inwardSpeed: Math.max(0, -normalVelocity),
        swept
    };
}

function findSegmentContact({
    safeCenter,
    nextCenter,
    angle,
    velocity,
    angularVelocity,
    segment,
    segmentIndex,
    carRadius,
    halfLength,
    includeSweep
}) {
    const safeAxis = createCarAxis(safeCenter, angle, halfLength);
    const nextAxis = createCarAxis(nextCenter, angle, halfLength);
    const pair = getClosestSegmentPair(nextAxis, segment);

    if (pair.distance < carRadius) {
        let safePoint = getClosestPointOnSegment(pair.second, safeAxis);
        if (Math.hypot(safePoint.x - pair.second.x, safePoint.y - pair.second.y) < CONTACT_EPSILON) {
            safePoint = safeCenter;
        }
        return buildContact({
            segment,
            segmentIndex,
            wallPoint: pair.second,
            bodyAxisPoint: pair.first,
            bodyAxisOffset: {
                x: pair.first.x - nextCenter.x,
                y: pair.first.y - nextCenter.y
            },
            safePoint,
            distance: pair.distance,
            penetration: clamp(carRadius - pair.distance, 0, carRadius),
            velocity,
            angularVelocity,
            carRadius
        });
    }

    if (!includeSweep) return null;
    const headingX = Math.cos(angle);
    const headingY = Math.sin(angle);
    const offsets = halfLength > CONTACT_EPSILON ? [halfLength, 0, -halfLength] : [0];
    let selected = null;

    for (let offsetIndex = 0; offsetIndex < offsets.length; offsetIndex++) {
        const offset = offsets[offsetIndex];
        const bodyAxisOffset = { x: headingX * offset, y: headingY * offset };
        const start = {
            x: safeCenter.x + bodyAxisOffset.x,
            y: safeCenter.y + bodyAxisOffset.y
        };
        const end = {
            x: nextCenter.x + bodyAxisOffset.x,
            y: nextCenter.y + bodyAxisOffset.y
        };
        const intersection = getIntersection(start, end, segment.start, segment.end);
        if (!intersection) continue;
        const contact = buildContact({
            segment,
            segmentIndex,
            wallPoint: intersection,
            bodyAxisPoint: intersection,
            bodyAxisOffset,
            safePoint: start,
            distance: 0,
            penetration: carRadius,
            velocity,
            angularVelocity,
            carRadius,
            swept: true
        });
        if (!selected || isStrictlyFasterInward(contact, selected)) {
            selected = contact;
        }
    }
    return selected;
}

function isStrictlyFasterInward(contact, selected) {
    return contact.inwardSpeed > selected.inwardSpeed + CONTACT_EPSILON;
}

function selectWallContact(contacts) {
    let selected = null;
    for (let index = 0; index < contacts.length; index++) {
        const contact = contacts[index];
        if (
            !selected
            || isStrictlyFasterInward(contact, selected)
            || (
                Math.abs(contact.inwardSpeed - selected.inwardSpeed) <= CONTACT_EPSILON
                && (
                    contact.penetration > selected.penetration + CONTACT_EPSILON
                    || (
                        Math.abs(contact.penetration - selected.penetration) <= CONTACT_EPSILON
                        && contact.segmentIndex < selected.segmentIndex
                    )
                )
            )
        ) selected = contact;
    }
    return selected;
}

function selectDeepestOverlap(overlaps) {
    let deepest = overlaps[0];
    for (let index = 1; index < overlaps.length; index++) {
        const contact = overlaps[index];
        if (
            contact.penetration > deepest.penetration + CONTACT_EPSILON
            || (
                Math.abs(contact.penetration - deepest.penetration) <= CONTACT_EPSILON
                && contact.segmentIndex < deepest.segmentIndex
            )
        ) deepest = contact;
    }
    return deepest;
}

function findWallContacts({
    safeCenter,
    nextCenter,
    angle,
    velocity,
    angularVelocity,
    wallSegments,
    carRadius,
    halfLength,
    includeSweep = true
}) {
    if (!wallSegments || wallSegments.length === 0) return [];

    const contacts = [];

    for (let i = 0; i < wallSegments.length; i++) {
        const segment = wallSegments[i];
        const contact = findSegmentContact({
            safeCenter,
            nextCenter,
            angle,
            velocity,
            angularVelocity,
            segment,
            segmentIndex: i,
            carRadius,
            halfLength,
            includeSweep
        });
        if (contact) contacts.push(contact);
    }
    return contacts;
}

function resolveWallContactPosition({
    state,
    primaryContact,
    wallSegments,
    safeCenter,
    nextCenter,
    angle,
    carRadius,
    halfLength,
    padding
}) {
    state.pos.x = nextCenter.x;
    state.pos.y = nextCenter.y;
    if (primaryContact.swept) {
        state.pos.x = primaryContact.wallPoint.x
            + primaryContact.normal.x * (carRadius + padding)
            - primaryContact.bodyAxisOffset.x;
        state.pos.y = primaryContact.wallPoint.y
            + primaryContact.normal.y * (carRadius + padding)
            - primaryContact.bodyAxisOffset.y;
    }

    for (let pass = 0; pass < MAX_CONTACT_RESOLUTION_PASSES; pass++) {
        const overlaps = findWallContacts({
            safeCenter,
            nextCenter: state.pos,
            angle,
            velocity: state.velocity,
            angularVelocity: state.angularVelocity,
            wallSegments,
            carRadius,
            halfLength,
            includeSweep: false
        });
        if (overlaps.length === 0) break;
        const deepest = selectDeepestOverlap(overlaps);
        state.pos.x += deepest.normal.x * (deepest.penetration + padding);
        state.pos.y += deepest.normal.y * (deepest.penetration + padding);
    }
}

function suppressInwardContactMotion(state, contacts) {
    for (let index = 0; index < contacts.length; index++) {
        const contact = contacts[index];
        const centerNormalVelocity = state.velocity.x * contact.normal.x + state.velocity.y * contact.normal.y;
        if (centerNormalVelocity < 0) {
            state.velocity.x -= centerNormalVelocity * contact.normal.x;
            state.velocity.y -= centerNormalVelocity * contact.normal.y;
        }
        const rotationalNormalVelocity = state.angularVelocity * (
            contact.bodyOffset.x * contact.normal.y - contact.bodyOffset.y * contact.normal.x
        );
        if (rotationalNormalVelocity < 0) state.angularVelocity = 0;
    }
    state.cachedSpeed = Math.hypot(state.velocity.x, state.velocity.y);
}

function resolveWallScrape(state, contact, config) {
    if (contact.inwardSpeed <= 0) return null;

    const referenceImpactKph = Math.max(1, Number(config.wallScrapeReferenceImpactKph) || 150);
    const impactKph = contact.inwardSpeed * KPH_PER_WORLD_UNIT;
    const speedSeverity = clamp(impactKph / referenceImpactKph, 0, 1);
    const depthSeverity = clamp(contact.penetration / config.carRadius, 0, 1);
    const speedWeight = clamp(Number(config.wallScrapeSpeedSeverityWeight) || 0.8, 0, 1);
    const depthWeight = clamp(Number(config.wallScrapeDepthSeverityWeight) || 0.2, 0, 1);
    const totalWeight = Math.max(0.001, speedWeight + depthWeight);
    const severity = clamp(
        (speedSeverity * speedWeight + depthSeverity * depthWeight) / totalWeight,
        0,
        1
    );

    const centerNormalVelocity = state.velocity.x * contact.normal.x + state.velocity.y * contact.normal.y;
    const tangentX = state.velocity.x - centerNormalVelocity * contact.normal.x;
    const tangentY = state.velocity.y - centerNormalVelocity * contact.normal.y;

    const maxRetention = clamp(Number(config.wallScrapeMaxTangentialRetention) || 0.85, 0, 1);
    const minRetention = clamp(Number(config.wallScrapeMinTangentialRetention) || 0.35, 0, maxRetention);
    const tangentRetention = maxRetention + (minRetention - maxRetention) * severity;
    const minBounce = clamp(Number(config.wallScrapeMinBounce) || 0.05, 0, 1);
    const maxBounce = clamp(Number(config.wallScrapeMaxBounce) || 0.15, minBounce, 1);
    const bounce = minBounce + (maxBounce - minBounce) * severity;
    const outwardSpeed = Math.max(0, centerNormalVelocity, contact.inwardSpeed * bounce);

    state.velocity.x = tangentX * tangentRetention + contact.normal.x * outwardSpeed;
    state.velocity.y = tangentY * tangentRetention + contact.normal.y * outwardSpeed;
    const rotationalNormalVelocity = state.angularVelocity * (
        contact.bodyOffset.x * contact.normal.y - contact.bodyOffset.y * contact.normal.x
    );
    if (rotationalNormalVelocity < 0) state.angularVelocity = 0;
    state.cachedSpeed = Math.hypot(state.velocity.x, state.velocity.y);
    state.wallImpactCooldownRemaining = Math.max(0, Number(config.wallImpactCooldownSec) || 0.12);

    return { impactKph, severity };
}

function getCollisionCandidates(p1, p2, collisionData, collisionExtent) {
    if (!collisionData) return [];
    if (Array.isArray(collisionData)) return collisionData;
    if (!collisionData.cells || !collisionData.segments) return [];

    const expandedMinX = Math.min(p1.x, p2.x) - collisionExtent;
    const expandedMaxX = Math.max(p1.x, p2.x) + collisionExtent;
    const expandedMinY = Math.min(p1.y, p2.y) - collisionExtent;
    const expandedMaxY = Math.max(p1.y, p2.y) + collisionExtent;
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

const SKID_MARK_MIN_SLIP_RATIO = 0.28;
const SKID_MARK_MIN_SPEED = 2.5;

/** World-space rear axle (skid / trail anchor) from car center `pos` and `angle`. */
export {
    CONTACT_EPSILON,
    createSegment,
    getBodyPointVelocity,
    getClosestSegmentPair,
    getCollisionCandidates,
    getSafeContactNormal,
    isStrictlyFasterInward,
    resolveWallScrape,
    selectWallContact,
    selectDeepestOverlap,
    suppressInwardContactMotion
};

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
        state.wallImpactCooldownRemaining = Math.max(
            0,
            (Number(state.wallImpactCooldownRemaining) || 0) - dt
        );
        state.wallContactReleaseRemaining = Math.max(
            0,
            (Number(state.wallContactReleaseRemaining) || 0) - dt
        );
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
            // Apply a continuous speed penalty curve based on tire slip.
            // This replaces the binary slipSpeedGateClamp to ensure all steering inputs
            // (analog sticks and digital taps) are penalized fairly and smoothly.
            const slipPenaltyFactor = 1.08;
            const slipPenalty = Math.min(1, (tractionSlipRatio ** 2) * slipPenaltyFactor);
            allowedSpeed = safeMaxSpeed * (1 - slipPenalty);
            
            // Clean up old state property to prevent any residual bugs
            if (typeof state.slipSpeedGateClamp !== 'undefined') {
                delete state.slipSpeedGateClamp;
            }
            if (state.cachedSpeed > allowedSpeed) {
                const speedScale = allowedSpeed / state.cachedSpeed;
                state.velocity.x *= speedScale;
                state.velocity.y *= speedScale;
            }

            state.cachedSpeed = Math.sqrt(state.velocity.x ** 2 + state.velocity.y ** 2);

            _nextPos.x = state.pos.x + state.velocity.x * dt;
            _nextPos.y = state.pos.y + state.velocity.y * dt;

            const carRadius = Math.max(0.001, Number(config.carRadius) || 0.275);
            const halfLength = Math.max(0, Number(config.carCollisionHalfLength) || 0);
            const safeCenter = { x: state.pos.x, y: state.pos.y };
            const candidateSegments = getCollisionCandidates(
                safeCenter,
                _nextPos,
                state.collisionHash || collisionSegments,
                carRadius + halfLength
            );
            const wallContacts = findWallContacts({
                safeCenter,
                nextCenter: _nextPos,
                angle: state.angle,
                velocity: state.velocity,
                angularVelocity: state.angularVelocity,
                wallSegments: candidateSegments,
                carRadius,
                halfLength
            });
            const wallContact = selectWallContact(wallContacts);

            const checkpoints = currentTrack.checkpoints || [];
            if (state.nextCheckpointIndex < checkpoints.length) {
                const cp = checkpoints[state.nextCheckpointIndex];
                const checkpointFraction = getCrossingFraction(state.pos, _nextPos, cp.p1, cp.p2);
                if (checkpointFraction !== null) {
                    if (!Array.isArray(state.lapCheckpointTimesSec)) {
                        state.lapCheckpointTimesSec = [];
                    }
                    const splitTimeSec = crossingTimeSec(state.currentTime, dt, checkpointFraction);
                    state.lapCheckpointTimesSec.push(splitTimeSec);
                    state.nextCheckpointIndex++;
                    _events.checkpointPassed = {
                        index: state.lapCheckpointTimesSec.length - 1,
                        splitTimeSec
                    };
                }
            }

            const finishFraction = currentTrack.startLine
                ? getCrossingFraction(
                    state.pos,
                    _nextPos,
                    currentTrack.startLine.p1,
                    currentTrack.startLine.p2
                )
                : null;
            const crossedFinish = finishFraction !== null;
            const allPassed = checkpoints.length === 0 || state.nextCheckpointIndex >= checkpoints.length;
            if (crossedFinish) {
                if (allPassed && state.currentTime >= 2.0) {
                    const finishTimeSec = crossingTimeSec(state.currentTime, dt, finishFraction);
                    Object.assign(
                        _events,
                        handleFinishCrossing(state, runPolicy, checkpoints.length, finishTimeSec)
                    );
                }
                state.nextCheckpointIndex = 0;
            }

            if (wallContact) {
                const padding = Math.max(0, Number(config.wallContactPadding) || 0.001);
                resolveWallContactPosition({
                    state,
                    primaryContact: wallContact,
                    wallSegments: candidateSegments,
                    safeCenter,
                    nextCenter: _nextPos,
                    angle: state.angle,
                    carRadius,
                    halfLength,
                    padding
                });
                if (state.status === 'won') {
                    // A valid finish takes precedence over collision penalties and feedback.
                } else {
                    const suppressRepeat = Boolean(state.wallContactActive)
                        || Number(state.wallImpactCooldownRemaining) > 0;
                    const scrape = suppressRepeat ? null : resolveWallScrape(state, wallContact, config);
                    if (suppressRepeat) suppressInwardContactMotion(state, wallContacts);
                    if (scrape) {
                        _events.wallImpact = {
                            kind: 'scrape',
                            impactKph: Math.round(scrape.impactKph),
                            severity: scrape.severity
                        };
                        const particleCount = state.frameSkip > 0 ? 2 : 3;
                        const scrapeSparks = createSparkParticles(state.pos, particleCount * 5, config.sparkColor);
                        for (let j = 0; j < scrapeSparks.length; j++) state.particles.push(scrapeSparks[j]);
                    }
                }
                state.wallContactActive = true;
                state.wallContactReleaseRemaining = Math.max(
                    0,
                    Number(config.wallContactReleaseSec) || 0.12
                );
            } else {
                state.pos.x = _nextPos.x;
                state.pos.y = _nextPos.y;
                if (state.wallContactReleaseRemaining <= 0) {
                    state.wallContactActive = false;
                }
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

            if (state.routeTraceStrokeStyle !== null) {
                state.trailTimer += dt;
                const traceInterval = (state.frameSkip > 0 || state.qualityLevel > 0) ? 0.08 : 0.05;
                if (state.trailTimer > traceInterval) {
                    const slot = state.routeTrace.write();
                    slot.x = rearX;
                    slot.y = rearY;
                    state.trailTimer %= traceInterval;
                }
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
