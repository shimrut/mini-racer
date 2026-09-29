import { describe, expect, it } from 'vitest';
import { CONFIG } from '../game/config.js';
import {
    DEFAULT_DRAW_WIDTH,
    LINE_BUILD_CAR_UNITS,
    formatTrackNumber,
    generateTrackModuleSource,
    getTrackModuleFilename,
    isValidTrackKey,
    trackKeyFromName
} from '../tools/mapmaker/track-source.js';

const TRACK = {
    name: 'Test Circuit',
    cornerRadius: 3.1254,
    outer: [
        { x: 1, y: 2 },
        { x: 10.25, y: 2 },
        { x: 10.25, y: 8.5 }
    ],
    inner: [
        { x: 3, y: 4 },
        { x: 8, y: 4 },
        { x: 8, y: 6 }
    ],
    startLine: {
        p1: { x: 4, y: 2 },
        p2: { x: 4, y: 4 }
    },
    startPos: { x: 3.5, y: 3 },
    startAngle: 0.125,
    checkpoints: [
        {
            p1: { x: 9, y: 3 },
            p2: { x: 7.5, y: 4.5 }
        }
    ]
};

describe('Mapmaker track source serializer', () => {
    it('keeps Line Build width at exactly 7 car-widths', () => {
        expect(LINE_BUILD_CAR_UNITS).toBe(7);
        expect(DEFAULT_DRAW_WIDTH).toBe(LINE_BUILD_CAR_UNITS * CONFIG.carRadius * 2);
        expect(formatTrackNumber(DEFAULT_DRAW_WIDTH)).toBe('3.85');
        expect(DEFAULT_DRAW_WIDTH / (CONFIG.carRadius * 2)).toBe(7);
    });

    it('formats stable compact coordinate values', () => {
        expect(formatTrackNumber(3)).toBe('3');
        expect(formatTrackNumber(3.1254)).toBe('3.125');
        expect(formatTrackNumber(Number.NaN)).toBe('0');
    });

    it('creates a kebab-case module filename from the track key', () => {
        expect(getTrackModuleFilename('sunlitTemple')).toBe('sunlit-temple.js');
        expect(getTrackModuleFilename('GPFinaleTrack')).toBe('gp-finale-track.js');
        expect(isValidTrackKey('newCircuit')).toBe(true);
        expect(isValidTrackKey('class')).toBe(false);
        expect(() => getTrackModuleFilename('class')).toThrow(/non-reserved/);
    });

    it('derives a camelCase track key from the display name', () => {
        expect(trackKeyFromName('Spade Kingdom')).toBe('spadeKingdom');
        expect(trackKeyFromName('spade-kingdom')).toBe('spadeKingdom');
        expect(trackKeyFromName("King's Cup")).toBe('kingsCup');
        expect(trackKeyFromName('Number 5')).toBe('number5');
        expect(trackKeyFromName('3rd Street')).toBe('t3rdStreet');
        expect(trackKeyFromName('   ')).toBe('');
        expect(isValidTrackKey(trackKeyFromName('Class'))).toBe(false);
    });

    it('emits a default-exported geometry-only module', () => {
        const source = generateTrackModuleSource(TRACK);

        expect(source).toContain("import { Point } from '../geometry.js';");
        expect(source).toContain('export default {');
        expect(source).toContain('cornerRadius: 3.125,');
        expect(source).toContain('Point(10.25, 8.5)');
        expect(source).toContain('startAngle: 0.125,');
        expect(source).not.toContain('Test Circuit');
        expect(source).not.toContain('TRACK_KEY');
    });

    it('never writes draw width or line smoothing', () => {
        const withLegacyFields = generateTrackModuleSource({
            ...TRACK,
            drawWidth: 5,
            lineSmoothing: 0.35,
        });
        const withoutCorner = generateTrackModuleSource({
            ...TRACK,
            cornerRadius: undefined,
        });

        expect(withLegacyFields).not.toContain('drawWidth:');
        expect(withLegacyFields).not.toContain('lineSmoothing:');
        expect(withoutCorner).not.toContain('cornerRadius:');
    });

    it('writes a non-tarmac ground and omits tarmac', () => {
        const dirtSource = generateTrackModuleSource({ ...TRACK, ground: 'dirt' });
        expect(dirtSource).toContain("    ground: 'dirt',\n    outer: [");

        expect(generateTrackModuleSource(TRACK)).not.toContain('ground:');
        expect(generateTrackModuleSource({ ...TRACK, ground: 'tarmac' })).not.toContain('ground:');
        expect(generateTrackModuleSource({ ...TRACK, ground: "x', evil: '" })).not.toContain('ground:');
    });
});
