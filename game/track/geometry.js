export const Point = (x, y) => ({ x, y });

const SEGMENT_EPSILON = 1e-9;

/** Shared line-segment intersection params; avoids allocating a point on miss. */
function segmentIntersectionParams(A, B, C, D) {
    const tTop = (D.x - C.x) * (A.y - C.y) - (D.y - C.y) * (A.x - C.x);
    const uTop = (C.y - A.y) * (A.x - B.x) - (C.x - A.x) * (A.y - B.y);
    const bottom = (D.y - C.y) * (B.x - A.x) - (D.x - C.x) * (B.y - A.y);

    if (bottom === 0) return null;
    const t = tTop / bottom;
    const u = uTop / bottom;
    if (
        t >= -SEGMENT_EPSILON
        && t <= 1 + SEGMENT_EPSILON
        && u >= -SEGMENT_EPSILON
        && u <= 1 + SEGMENT_EPSILON
    ) {
        return { t, u };
    }
    return null;
}

export function segmentsIntersect(A, B, C, D) {
    return segmentIntersectionParams(A, B, C, D) !== null;
}

export function getIntersection(A, B, C, D) {
    const params = segmentIntersectionParams(A, B, C, D);
    if (!params) return null;
    return {
        x: A.x + (B.x - A.x) * params.t,
        y: A.y + (B.y - A.y) * params.t
    };
}
