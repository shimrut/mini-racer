import { describe, expect, it } from 'vitest';
import {
    formatTrackNumber,
    generateTrackIntegrationSnippet,
    generateTrackModuleSource,
    getTrackModuleFilename,
    isValidTrackKey
} from '../tools/mapmaker/track-source.js';

const TRACK = {
    name: 'Test Circuit',
    cornerRadius: 3.1254,
    drawWidth: 5,
    lineSmoothing: 0.35,
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

    it('omits optional drawing properties when a new track does not define them', () => {
        const source = generateTrackModuleSource({
            ...TRACK,
            cornerRadius: undefined,
            drawWidth: undefined,
            lineSmoothing: undefined
        });

        expect(source).not.toContain('cornerRadius:');
        expect(source).not.toContain('drawWidth:');
        expect(source).not.toContain('lineSmoothing:');
    });

    it('emits the three integration lines needed by catalog and tracks registry', () => {
        const snippet = generateTrackIntegrationSnippet('sunlitTemple', 'Sunlit Temple');

        expect(snippet).toContain('sunlitTemple: { name: "Sunlit Temple" },');
        expect(snippet).toContain("import sunlitTempleGeometry from './definitions/sunlit-temple.js';");
        expect(snippet).toContain('sunlitTemple: sunlitTempleGeometry,');
    });

    it('uses the renamed key consistently in filenames and integration snippets', () => {
        const snippet = generateTrackIntegrationSnippet('newHarborRun', 'New Harbor Run');

        expect(getTrackModuleFilename('newHarborRun')).toBe('new-harbor-run.js');
        expect(snippet).toContain('newHarborRun: { name: "New Harbor Run" },');
        expect(snippet).toContain("import newHarborRunGeometry from './definitions/new-harbor-run.js';");
        expect(snippet).toContain('newHarborRun: newHarborRunGeometry,');
    });
});
