import { describe, expect, it } from 'vitest';
import { placeCheckpointInLongestGap, validateTrackQuality } from '../tools/mapmaker/track-quality.js';
import analogAudio from '../game/track/definitions/analog-audio.js';
import classicCircuit from '../game/track/definitions/circuit.js';
import { buildRibbonWallsFromCenterline } from '../tools/mapmaker/ribbon-walls.js';
import { buildPerpendicularLaneGate } from '../tools/mapmaker/lane-gate.js';
import { snapStartPose } from '../tools/mapmaker/start-pose.js';

function loop(inset = 5) {
    return {
        outer: [
            { x: 0, y: 0 }, { x: 20, y: 0 },
            { x: 20, y: 20 }, { x: 0, y: 20 },
        ],
        inner: [
            { x: inset, y: inset }, { x: 20 - inset, y: inset },
            { x: 20 - inset, y: 20 - inset }, { x: inset, y: 20 - inset },
        ],
        cornerRadius: 0,
        startPos: { x: 8.75, y: inset / 2 },
        startAngle: 0,
        startLine: { p1: { x: 10, y: -1 }, p2: { x: 10, y: inset + 1 } },
        checkpoints: [
            { p1: { x: 20 - inset - 1, y: 10 }, p2: { x: 21, y: 10 } },
            { p1: { x: 10, y: 20 - inset - 1 }, p2: { x: 10, y: 21 } },
            { p1: { x: -1, y: 10 }, p2: { x: inset + 1, y: 10 } },
        ],
    };
}

function codes(track) {
    return validateTrackQuality(track).issues.map((entry) => entry.code);
}

describe('Mapmaker track quality', () => {
    it('accepts a drivable loop and reports its narrowest road gap', () => {
        const result = validateTrackQuality(loop());
        expect(result.hasErrors).toBe(false);
        expect(result.issues).toEqual([]);
        expect(result.minClearance).toBeCloseTo(5);
    });

    it('places a new checkpoint across the middle of the longest stretch without a gate, in lap order', () => {
        const track = loop();
        track.checkpoints.splice(1, 1);
        const placed = placeCheckpointInLongestGap(track);
        expect(placed.index).toBe(1);
        const middle = { x: (placed.checkpoint.p1.x + placed.checkpoint.p2.x) / 2, y: (placed.checkpoint.p1.y + placed.checkpoint.p2.y) / 2 };
        expect(middle.x).toBeCloseTo(10);
        expect(middle.y).toBeCloseTo(17.5);
        track.checkpoints.splice(placed.index, 0, placed.checkpoint);
        expect(validateTrackQuality(track).issues).toEqual([]);
    });

    it('keeps each added checkpoint on the road and in order, even next to a sharp corner', () => {
        const track = structuredClone(classicCircuit);
        for (let added = 0; added < 4; added += 1) {
            const placed = placeCheckpointInLongestGap(track);
            track.checkpoints.splice(placed.index, 0, placed.checkpoint);
            expect(validateTrackQuality(track).hasErrors).toBe(false);
        }
    });

    it('places no checkpoint when the checkpoints are out of order', () => {
        const track = loop();
        track.checkpoints.reverse();
        expect(placeCheckpointInLongestGap(track)).toBeNull();
    });

    it('accepts a generated Line Build loop with snapped gates and start pose', () => {
        const centerline = [
            { x: 0, y: 0 }, { x: 15, y: 0 },
            { x: 15, y: 15 }, { x: 0, y: 15 },
        ];
        const walls = buildRibbonWallsFromCenterline(centerline, 1.925);
        const startLine = buildPerpendicularLaneGate({ x: 7.5, y: 0 }, walls.outer, walls.inner);
        const pose = snapStartPose({ x: 5, y: 0 }, startLine);
        const checkpoints = [
            { x: 15, y: 7.5 }, { x: 7.5, y: 15 }, { x: 0, y: 7.5 },
        ].map((seed) => buildPerpendicularLaneGate(seed, walls.outer, walls.inner));
        const result = validateTrackQuality({
            ...walls,
            cornerRadius: 1.5,
            startLine,
            startPos: pose.startPos,
            startAngle: pose.startAngle,
            checkpoints,
        });
        expect(result.issues).toEqual([]);
    });

    it('marks wall crossings and escaped inner walls as errors with map locations', () => {
        const crossing = loop();
        crossing.outer = [
            { x: 0, y: 0 }, { x: 20, y: 20 },
            { x: 0, y: 20 }, { x: 20, y: 0 },
        ];
        const crossingIssue = validateTrackQuality(crossing).issues.find((entry) => entry.code === 'outer-self-intersection');
        expect(crossingIssue.severity).toBe('error');
        expect(crossingIssue.hotspot).toEqual({ x: 10, y: 10 });

        const escaped = loop();
        escaped.inner[1] = { x: 22, y: 5 };
        expect(codes(escaped)).toContain('walls-cross');
    });

    it('rejects an off-road start and a gate that does not bridge the lane', () => {
        const track = loop();
        track.startPos = { x: 10, y: 10 };
        track.checkpoints[0] = { p1: { x: 18, y: 9 }, p2: { x: 19, y: 11 } };
        const result = validateTrackQuality(track);
        expect(result.hasErrors).toBe(true);
        expect(result.issues.find((entry) => entry.code === 'start-off-road')?.hotspot).toEqual(track.startPos);
        expect(codes(track)).toContain('checkpoint-1-corridor');
    });

    it('rejects a gate that stops inside the lane', () => {
        const track = loop();
        track.checkpoints[0].p1 = { x: 18, y: 10 };
        const result = validateTrackQuality(track);
        expect(result.issues.find((entry) => entry.code === 'checkpoint-1-corridor')?.severity).toBe('error');
    });

    it('detects checkpoints that the start heading reaches in the wrong order', () => {
        const track = loop();
        [track.checkpoints[0], track.checkpoints[1]] = [track.checkpoints[1], track.checkpoints[0]];
        expect(codes(track)).toContain('checkpoint-2-order');
        track.checkpoints.reverse();
        expect(codes(track)).toContain('checkpoint-2-order');

        const reversedHeading = loop();
        reversedHeading.startAngle = Math.PI;
        expect(codes(reversedHeading).some((code) => code.endsWith('-order'))).toBe(true);
    });

    it('warns about a gate with multiple wall hits without claiming the lap is impossible', () => {
        const result = validateTrackQuality(analogAudio);
        expect(result.hasErrors).toBe(false);
        expect(result.issues.find((entry) => entry.code === 'checkpoint-3-multi-hit')?.severity).toBe('warning');
    });

    it('distinguishes narrow road warnings from impassable pinches', () => {
        const narrow = loop(1);
        const warning = validateTrackQuality(narrow);
        expect(warning.issues.find((entry) => entry.code === 'road-narrow')?.severity).toBe('warning');
        expect(warning.hasErrors).toBe(false);

        const pinched = loop(0.6);
        const blocked = validateTrackQuality(pinched);
        expect(blocked.issues.find((entry) => entry.code === 'road-too-narrow')?.severity).toBe('error');
        expect(blocked.hasErrors).toBe(true);
    });

    it('handles an incomplete draft without throwing', () => {
        const result = validateTrackQuality({ outer: [], inner: [] });
        expect(result.hasErrors).toBe(true);
        expect(result.issues.map((entry) => entry.code)).toEqual(['outer-invalid', 'inner-invalid']);
    });

    it('rejects a collapsed wall even when it still has three points', () => {
        const track = loop();
        track.inner = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
        expect(codes(track)).toContain('inner-degenerate');
    });
});
