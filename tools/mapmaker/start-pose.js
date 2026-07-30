const START_POS_OFFSET = 1.25;

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
 * Snap the car onto the start-line center axis, a short fixed distance behind
 * the gate, facing perpendicular with the nose toward the line.
 */
export function snapStartPose(seedPoint, startLine, options = {}) {
    const axis = getStartLineAxis(startLine);
    if (!axis || !seedPoint) {
        return null;
    }

    // Face toward the gate from the seed side so the nose points at the line.
    const towardLineX = axis.mid.x - seedPoint.x;
    const towardLineY = axis.mid.y - seedPoint.y;
    const towardLineLength = Math.hypot(towardLineX, towardLineY);
    const preferredAngle = towardLineLength > 0.000001
        ? Math.atan2(towardLineY, towardLineX)
        : options.preferredAngle;
    const startAngle = pickStartHeading(axis, preferredAngle);
    const forward = {
        x: Math.cos(startAngle),
        y: Math.sin(startAngle),
    };
    const along = -START_POS_OFFSET;

    return {
        startPos: {
            x: axis.mid.x + (forward.x * along),
            y: axis.mid.y + (forward.y * along),
        },
        startAngle,
        along,
    };
}
