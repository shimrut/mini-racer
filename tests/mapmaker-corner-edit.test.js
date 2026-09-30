import { describe, expect, it } from 'vitest';
import { buildTrackGeometry } from '../game/track/runtime.js';
import { moveCorner, selectCorner } from '../tools/mapmaker/corner-edit.js';
import { buildRibbonWallsFromCenterline, findCornerWallGroups, fitCurvesToCorners } from '../tools/mapmaker/ribbon-walls.js';

const WIDTH = 3.85;
const loop = [
    { x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 14 }, { x: 0, y: 14 },
];

describe('Mapmaker corner editing', () => {
    it('moves a Draw corner on both walls in one operation', () => {
        const track = buildRibbonWallsFromCenterline(loop, WIDTH / 2);
        const group = findCornerWallGroups(track.outer, track.inner, WIDTH)[0];
        const selection = selectCorner(track, group.facing.path, group.facing.indices[0], WIDTH);
        expect(selection.members.length).toBeGreaterThan(2);
        const before = structuredClone(track);
        const start = selection.members.map(({ path, index }) => ({ ...track[path][index] }));
        moveCorner(track, selection, start, { x: 2, y: -1 });
        for (const { path, index } of selection.members) {
            expect(track[path][index].x).toBeCloseTo(before[path][index].x + 2);
            expect(track[path][index].y).toBeCloseTo(before[path][index].y - 1);
        }
        expect(track[group.pivot.path][group.pivot.index].x).toBeCloseTo(
            before[group.pivot.path][group.pivot.index].x + 2,
        );
    });

    it('changes one corner radius in the shared race geometry', () => {
        const drawn = buildRibbonWallsFromCenterline(loop, WIDTH / 2);
        const track = { ...fitCurvesToCorners(drawn.outer, drawn.inner, 3, WIDTH), cornerRadius: 3 };
        const group = findCornerWallGroups(track.outer, track.inner, WIDTH)[0];
        const baseline = buildTrackGeometry(track);
        track[group.pivot.path][group.pivot.index].cornerRadius = 0;
        const edited = buildTrackGeometry(track);
        const at = group.pivot.index * 6;
        expect(edited[group.pivot.path][at]).not.toEqual(baseline[group.pivot.path][at]);
        const otherPath = group.pivot.path === 'outer' ? 'inner' : 'outer';
        expect(edited[otherPath]).toEqual(baseline[otherPath]);
    });

    it('moves both walls around a hand-shaped bend without Draw corner metadata', () => {
        const outer = Array.from({ length: 32 }, (_, index) => {
            const angle = index * Math.PI * 2 / 32;
            return { x: Math.cos(angle) * 20, y: Math.sin(angle) * 20 };
        });
        const inner = outer.map(({ x, y }) => ({ x: x * 0.8, y: y * 0.8 }));
        const track = { outer, inner };
        expect(findCornerWallGroups(outer, inner, WIDTH)).toHaveLength(0);
        const selection = selectCorner(track, 'outer', 0, WIDTH);
        expect(new Set(selection.members.map(({ path }) => path))).toEqual(new Set(['outer', 'inner']));
        const start = selection.members.map(({ path, index }) => ({ ...track[path][index] }));
        moveCorner(track, selection, start, { x: 2, y: 0 });
        expect(track.outer[0].x).toBeGreaterThan(20);
        expect(track.inner[0].x).toBeGreaterThan(16);
        expect(track.outer[16].x).toBeCloseTo(-20);
    });
});
