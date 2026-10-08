import { isFinitePoint } from '../geometry.js';

// Draw's road line and width, saved beside the track for the Creator only; limits match the server.
export const MAX_ROAD_LINE_POINTS = 160;
const MIN_ROAD_LINE_WIDTH = 1.5;
const MAX_ROAD_LINE_WIDTH = 20;
const MAX_CORNER_RADIUS = 20;

function isValidWidth(width) {
    return Number.isFinite(width) && width >= MIN_ROAD_LINE_WIDTH && width <= MAX_ROAD_LINE_WIDTH;
}

// A bend can keep its own rounding and width up to the next bend.
function isValidBend(point) {
    return isFinitePoint(point)
        && (point.cornerRadius === undefined
            || (Number.isFinite(point.cornerRadius) && point.cornerRadius >= 0 && point.cornerRadius <= MAX_CORNER_RADIUS))
        && (point.width === undefined || isValidWidth(point.width));
}

export function isValidRoadLine(roadLine) {
    return Boolean(roadLine) && typeof roadLine === 'object'
        && Array.isArray(roadLine.points)
        && roadLine.points.length >= 3 && roadLine.points.length <= MAX_ROAD_LINE_POINTS
        && roadLine.points.every(isValidBend)
        && isValidWidth(roadLine.width);
}

// The drawn points, moved by the same offset as the walls they built.
export function buildRoadLine(points, offset, width) {
    const roadLine = {
        points: (points ?? []).map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })),
        width,
    };
    return isValidRoadLine(roadLine) ? roadLine : null;
}

// The track as the server stores it, and its road line beside it.
export function splitRoadLine(track) {
    if (!track) return { track, roadLine: null };
    const { roadLine, ...shape } = track;
    return { track: shape, roadLine: isValidRoadLine(roadLine) ? roadLine : null };
}

export function withRoadLine(track, roadLine) {
    if (!track) return track;
    const shape = splitRoadLine(track).track;
    return isValidRoadLine(roadLine) ? { ...shape, roadLine } : shape;
}
