const START_POS_MIN_OFFSET = 1;
const START_POS_MAX_OFFSET = 8;

function clonePoint(point) {
    return { x: Number(point.x), y: Number(point.y) };
}

function midpoint(a, b) {
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
    };
}

function angleDelta(a, b) {
    let delta = Math.abs(a - b) % (Math.PI * 2);
    if (delta > Math.PI) {
        delta = (Math.PI * 2) - delta;
    }
    return delta;
}

/**
 * Geometry for a start/finish gate: midpoint plus the two perpendicular
 * along-track headings.
 */
export function getStartLineAxis(startLine) {
    if (!startLine?.p1 || !startLine?.p2) {
        return null;
    }
    const dx = startLine.p2.x - startLine.p1.x;
    const dy = startLine.p2.y - startLine.p1.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.000001) {
        return null;
    }
    const across = { x: dx / length, y: dy / length };
    return {
        mid: midpoint(startLine.p1, startLine.p2),
        across,
        forwardA: { x: -across.y, y: across.x },
        forwardB: { x: across.y, y: -across.x },
        length,
    };
}

export function pickStartHeading(axis, preferredAngle = null) {
    const angleA = Math.atan2(axis.forwardA.y, axis.forwardA.x);
    const angleB = Math.atan2(axis.forwardB.y, axis.forwardB.x);
    if (!Number.isFinite(preferredAngle)) {
        return angleA;
    }
    return angleDelta(angleA, preferredAngle) <= angleDelta(angleB, preferredAngle)
        ? angleA
        : angleB;
}

/**
 * Snap the car onto the start-line center axis, facing perpendicular to the
 * gate. Lateral position is always centered on the line; only the along-track
 * offset follows the seed (clamped).
 */
export function snapStartPose(seedPoint, startLine, options = {}) {
    const axis = getStartLineAxis(startLine);
    if (!axis || !seedPoint) {
        return null;
    }

    const startAngle = pickStartHeading(axis, options.preferredAngle);
    const forward = {
        x: Math.cos(startAngle),
        y: Math.sin(startAngle),
    };
    const toSeed = {
        x: seedPoint.x - axis.mid.x,
        y: seedPoint.y - axis.mid.y,
    };
    let along = (toSeed.x * forward.x) + (toSeed.y * forward.y);

    if (Math.abs(along) < START_POS_MIN_OFFSET) {
        // Keep the car clearly off the gate; prefer the seed's side, else behind.
        along = along >= 0 ? START_POS_MIN_OFFSET : -START_POS_MIN_OFFSET;
    }
    along = Math.max(-START_POS_MAX_OFFSET, Math.min(START_POS_MAX_OFFSET, along));

    return {
        startPos: {
            x: axis.mid.x + (forward.x * along),
            y: axis.mid.y + (forward.y * along),
        },
        startAngle,
        along,
    };
}

export function cloneStartPose(pose) {
    if (!pose) {
        return null;
    }
    return {
        startPos: clonePoint(pose.startPos),
        startAngle: pose.startAngle,
        along: pose.along,
    };
}
