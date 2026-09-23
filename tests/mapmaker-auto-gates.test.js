import { describe, expect, it } from 'vitest';
import { buildAutoGates, closedLoopLength, nearestDistanceAlongLoop } from '../tools/mapmaker/auto-gates.js';
import { buildRibbonWallsFromCenterline } from '../tools/mapmaker/ribbon-walls.js';
import { buildTrackGeometry } from '../game/track/runtime.js';
import { validateTrackQuality } from '../tools/mapmaker/track-quality.js';

const SQUARE = [
    { x: 0, y: 0 },
    { x: 28, y: 0 },
    { x: 28, y: 28 },
    { x: 0, y: 28 },
];

describe('Line Build automatic gates', () => {
    it('samples the final road and spans the actual walls', () => {
        const walls = buildRibbonWallsFromCenterline(SQUARE, 1.925);
        expect(walls.centerline.length).toBeGreaterThan(SQUARE.length);
        const gates = buildAutoGates(walls.centerline, walls.outer, walls.inner, 3.85);
        expect(gates).not.toBeNull();
        expect(gates.length).toBeCloseTo(closedLoopLength(walls.centerline), 4);
        expect(gates.checkpoints).toHaveLength(4);
        const startVector = {
            x: gates.startLine.p2.x - gates.startLine.p1.x,
            y: gates.startLine.p2.y - gates.startLine.p1.y,
        };
        const headingDot = Math.cos(gates.startAngle) * startVector.x
            + Math.sin(gates.startAngle) * startVector.y;
        expect(Math.abs(headingDot)).toBeLessThan(0.001);
        expect(validateTrackQuality({
            ...walls,
            ...gates,
            cornerRadius: 3,
        }).hasErrors).toBe(false);

        const geometry = buildTrackGeometry({ ...walls, cornerRadius: 3 });
        for (const gate of [gates.startLine, ...gates.checkpoints]) {
            const length = Math.hypot(gate.p1.x - gate.p2.x, gate.p1.y - gate.p2.y);
            expect(length).toBeGreaterThan(3.85);
            expect(length).toBeLessThan(5.6);
            for (const point of [gate.p1, gate.p2]) {
                expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
            }
        }
        expect(geometry.outer.length).toBeGreaterThan(walls.outer.length);
    });

    it('rejects a loop too short to race', () => {
        const walls = buildRibbonWallsFromCenterline(SQUARE, 1.925);
        expect(buildAutoGates(walls.centerline, walls.outer, walls.inner, 100)).toBeNull();
    });

    it('reorders checkpoints when the start heading reverses', () => {
        const walls = buildRibbonWallsFromCenterline(SQUARE, 1.925);
        const start = nearestDistanceAlongLoop(walls.centerline, { x: 14, y: 0 });
        const forward = buildAutoGates(walls.centerline, walls.outer, walls.inner, 3.85, {
            startDistance: start.distance,
            direction: 1,
        });
        const reverse = buildAutoGates(walls.centerline, walls.outer, walls.inner, 3.85, {
            startDistance: start.distance,
            direction: -1,
        });
        expect(reverse.checkpoints).toHaveLength(forward.checkpoints.length);
        for (let index = 0; index < forward.checkpoints.length; index += 1) {
            const left = reverse.checkpoints[index];
            const right = forward.checkpoints[forward.checkpoints.length - 1 - index];
            const leftMid = { x: (left.p1.x + left.p2.x) / 2, y: (left.p1.y + left.p2.y) / 2 };
            const rightMid = { x: (right.p1.x + right.p2.x) / 2, y: (right.p1.y + right.p2.y) / 2 };
            expect(Math.hypot(leftMid.x - rightMid.x, leftMid.y - rightMid.y)).toBeLessThan(0.01);
        }
        expect(validateTrackQuality({ ...walls, ...reverse, cornerRadius: 3 }).hasErrors).toBe(false);
    });
});
