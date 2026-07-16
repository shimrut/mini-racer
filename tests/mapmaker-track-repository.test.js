import { afterEach, describe, expect, it } from 'vitest';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyTrackRepositoryUpdate,
    buildTrackRepositoryUpdate,
    parseTrackCatalogSource,
} from '../tools/mapmaker/track-repository.js';

const CATALOG_SOURCE = `export const TRACK_CATALOG = {
    circuit: { name: "Classic Circuit" },
    sunlitTemple: { name: "Sunlit Temple" },
};

export const TRACK_SCHEDULE_KEYS = [
    'circuit',
    'sunlitTemple',
];

export const DEFAULT_TRACK_KEY = 'circuit';

export function hasTrack(trackKey) {
    return Object.prototype.hasOwnProperty.call(TRACK_CATALOG, trackKey);
}
`;

const TRACK = {
    outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
    ],
    inner: [
        { x: 2, y: 2 },
        { x: 8, y: 2 },
        { x: 8, y: 8 },
    ],
    startLine: {
        p1: { x: 1, y: 0 },
        p2: { x: 1, y: 2 },
    },
    startPos: { x: 3, y: 1 },
    startAngle: 0,
    checkpoints: [],
};

const temporaryRoots = [];

afterEach(() => {
    temporaryRoots.splice(0).forEach((root) => rmSync(root, {
        recursive: true,
        force: true,
    }));
});

describe('Mapmaker track repository integration', () => {
    it('appends a new track as the final catalog and schedule entry', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'newHarborRun',
            trackName: 'New Harbor Run',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('created');
        expect(update.scheduleIndex).toBe(2);
        expect(parsed.scheduleKeys).toEqual([
            'circuit',
            'sunlitTemple',
            'newHarborRun',
        ]);
        expect(parsed.namesByKey.newHarborRun).toBe('New Harbor Run');
        expect(update.tracksSource).toContain(
            "import newHarborRun from './definitions/new-harbor-run.js';",
        );
        expect(update.tracksSource).toContain('    newHarborRun,');
    });

    it('updates an existing track without changing its schedule position', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'circuit',
            originalTrackKey: 'circuit',
            trackName: 'Classic Circuit Updated',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('updated');
        expect(update.scheduleIndex).toBe(0);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(parsed.namesByKey.circuit).toBe('Classic Circuit Updated');
    });

    it('renames a track in place and identifies the old module for removal', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'sunriseTemple',
            originalTrackKey: 'sunlitTemple',
            trackName: 'Sunrise Temple',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('renamed');
        expect(update.scheduleIndex).toBe(1);
        expect(update.removedFilename).toBe('sunlit-temple.js');
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunriseTemple']);
        expect(parsed.namesByKey).not.toHaveProperty('sunlitTemple');
        expect(update.tracksSource).not.toContain('sunlitTemple');
    });

    it('writes all repository files and deletes the old module on rename', () => {
        const root = mkdtempSync(join(tmpdir(), 'dailygp-mapmaker-'));
        temporaryRoots.push(root);
        const trackRoot = join(root, 'game/track');
        const definitionsRoot = join(trackRoot, 'definitions');
        mkdirSync(definitionsRoot, { recursive: true });
        writeFileSync(join(trackRoot, 'catalog.js'), CATALOG_SOURCE);
        writeFileSync(join(trackRoot, 'tracks.js'), '// old registry\n');
        writeFileSync(join(definitionsRoot, 'sunlit-temple.js'), '// old definition\n');

        const result = applyTrackRepositoryUpdate({
            rootDir: root,
            trackKey: 'sunriseTemple',
            originalTrackKey: 'sunlitTemple',
            trackName: 'Sunrise Temple',
            track: TRACK,
        });

        expect(result).toMatchObject({
            action: 'renamed',
            filename: 'sunrise-temple.js',
            removedFilename: 'sunlit-temple.js',
            scheduleIndex: 1,
        });
        expect(existsSync(join(definitionsRoot, 'sunlit-temple.js'))).toBe(false);
        expect(readFileSync(join(definitionsRoot, 'sunrise-temple.js'), 'utf8'))
            .toContain('export default {');
        expect(readFileSync(join(trackRoot, 'catalog.js'), 'utf8'))
            .toContain('sunriseTemple: { name: "Sunrise Temple" },');
        expect(readFileSync(join(trackRoot, 'tracks.js'), 'utf8'))
            .toContain("import sunriseTemple from './definitions/sunrise-temple.js';");
    });
});
