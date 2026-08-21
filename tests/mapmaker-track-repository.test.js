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
    buildCatalogBiomeBackfill,
    buildTrackRepositoryUpdate,
    parseTrackCatalogSource,
} from '../tools/mapmaker/track-repository.js';
import { isBiomeName, pickBiomeForTrackKey } from '../game/track/biomes.js';

const CATALOG_SOURCE = `export const TRACK_CATALOG = {
    circuit: { name: "Classic Circuit" },
    sunlitTemple: { name: "Sunlit Temple" },
    numberZero: { name: "Number Zero" },
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

const MIXED_BIOME_CATALOG_SOURCE = CATALOG_SOURCE.replace(
    '    sunlitTemple: { name: "Sunlit Temple" },',
    '    sunlitTemple: { name: "Sunlit Temple", biome: "basalt" },',
);

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
    it('parses catalogs where the Daily schedule is a subset of the catalog', () => {
        const parsed = parseTrackCatalogSource(CATALOG_SOURCE);
        expect(parsed.catalogKeys).toEqual(['circuit', 'sunlitTemple', 'numberZero']);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(parsed.namesByKey.numberZero).toBe('Number Zero');
    });

    it('appends a new Daily track as the final catalog and schedule entry', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'newHarborRun',
            trackName: 'New Harbor Run',
            destination: 'daily',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('created');
        expect(update.destination).toBe('daily');
        expect(update.scheduleIndex).toBe(2);
        expect(parsed.scheduleKeys).toEqual([
            'circuit',
            'sunlitTemple',
            'newHarborRun',
        ]);
        expect(parsed.catalogKeys).toEqual([
            'circuit',
            'sunlitTemple',
            'numberZero',
            'newHarborRun',
        ]);
        expect(parsed.namesByKey.newHarborRun).toBe('New Harbor Run');
        expect(update.tracksSource).toContain(
            "import newHarborRun from './definitions/new-harbor-run.js';",
        );
        expect(update.tracksSource).toContain('    numberZero,');
        expect(update.tracksSource).toContain('    newHarborRun,');
    });

    it('creates a Campaign-only track without adding it to the Daily schedule', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'numberTen',
            trackName: 'Number Ten',
            destination: 'campaign',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('created');
        expect(update.destination).toBe('campaign');
        expect(update.scheduleIndex).toBe(-1);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(parsed.catalogKeys).toContain('numberTen');
        expect(parsed.namesByKey.numberTen).toBe('Number Ten');
        expect(update.tracksSource).toContain(
            "import numberTen from './definitions/number-ten.js';",
        );
    });

    it('updates an existing track without changing its schedule position', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'circuit',
            originalTrackKey: 'circuit',
            trackName: 'Classic Circuit Updated',
            destination: 'daily',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('updated');
        expect(update.scheduleIndex).toBe(0);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(parsed.catalogKeys).toEqual(['circuit', 'sunlitTemple', 'numberZero']);
        expect(parsed.namesByKey.circuit).toBe('Classic Circuit Updated');
    });

    it('can move a scheduled track to Campaign only', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'sunlitTemple',
            originalTrackKey: 'sunlitTemple',
            trackName: 'Sunlit Temple',
            destination: 'campaign',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('updated');
        expect(update.scheduleIndex).toBe(-1);
        expect(parsed.scheduleKeys).toEqual(['circuit']);
        expect(parsed.catalogKeys).toContain('sunlitTemple');
    });

    it('can add an existing Campaign-only track to the Daily schedule', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'numberZero',
            originalTrackKey: 'numberZero',
            trackName: 'Number Zero',
            destination: 'daily',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('updated');
        expect(update.scheduleIndex).toBe(2);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple', 'numberZero']);
    });

    it('renames a track in place and identifies the old module for removal', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'sunriseTemple',
            originalTrackKey: 'sunlitTemple',
            trackName: 'Sunrise Temple',
            destination: 'daily',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('renamed');
        expect(update.scheduleIndex).toBe(1);
        expect(update.removedFilename).toBe('sunlit-temple.js');
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunriseTemple']);
        expect(parsed.namesByKey).not.toHaveProperty('sunlitTemple');
        expect(parsed.catalogKeys).toContain('numberZero');
        expect(update.tracksSource).not.toContain('sunlitTemple');
        expect(update.tracksSource).toContain('numberZero');
    });

    it('renames a Campaign-only track without putting it on the Daily schedule', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'numberNil',
            originalTrackKey: 'numberZero',
            trackName: 'Number Nil',
            destination: 'campaign',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('renamed');
        expect(update.scheduleIndex).toBe(-1);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(parsed.catalogKeys).toContain('numberNil');
        expect(parsed.namesByKey).not.toHaveProperty('numberZero');
    });

    it('rejects an invalid destination', () => {
        expect(() => buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'newHarborRun',
            trackName: 'New Harbor Run',
            destination: 'challenge',
        })).toThrow('Destination must be daily or campaign.');
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
            destination: 'daily',
            track: TRACK,
        });

        expect(result).toMatchObject({
            action: 'renamed',
            destination: 'daily',
            filename: 'sunrise-temple.js',
            removedFilename: 'sunlit-temple.js',
            scheduleIndex: 1,
        });
        expect(existsSync(join(definitionsRoot, 'sunlit-temple.js'))).toBe(false);
        expect(readFileSync(join(definitionsRoot, 'sunrise-temple.js'), 'utf8'))
            .toContain('export default {');
        expect(readFileSync(join(trackRoot, 'catalog.js'), 'utf8'))
            .toContain('sunriseTemple: { name: "Sunrise Temple" },');
        expect(readFileSync(join(trackRoot, 'catalog.js'), 'utf8'))
            .toContain('numberZero: { name: "Number Zero" },');
        expect(readFileSync(join(trackRoot, 'tracks.js'), 'utf8'))
            .toContain("import sunriseTemple from './definitions/sunrise-temple.js';");
        expect(readFileSync(join(trackRoot, 'tracks.js'), 'utf8'))
            .toContain("import numberZero from './definitions/number-zero.js';");
    });
});

describe('Mapmaker catalog biomes', () => {
    it('reads catalogs that mix tracks with and without a biome', () => {
        const parsed = parseTrackCatalogSource(MIXED_BIOME_CATALOG_SOURCE);

        expect(parsed.catalogKeys).toEqual(['circuit', 'sunlitTemple', 'numberZero']);
        expect(parsed.biomesByKey).toEqual({ sunlitTemple: 'basalt' });
        expect(parsed.namesByKey.sunlitTemple).toBe('Sunlit Temple');
    });

    it('leaves a biome-less catalog byte-identical when no biome is supplied', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'circuit',
            originalTrackKey: 'circuit',
            trackName: 'Classic Circuit',
            destination: 'daily',
        });

        expect(update.catalogSource).toBe(CATALOG_SOURCE);
        expect(update.biome).toBeNull();
    });

    it('writes a settled biome into the catalog entry', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'circuit',
            originalTrackKey: 'circuit',
            trackName: 'Classic Circuit',
            destination: 'daily',
            biome: 'basalt',
        });

        expect(update.catalogSource).toContain('circuit: { name: "Classic Circuit", biome: "basalt" },');
        expect(update.biome).toBe('basalt');
    });

    it('keeps the stored biome when a save supplies none', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: MIXED_BIOME_CATALOG_SOURCE,
            trackKey: 'sunlitTemple',
            originalTrackKey: 'sunlitTemple',
            trackName: 'Sunlit Temple',
            destination: 'daily',
        });

        expect(update.catalogSource).toContain('sunlitTemple: { name: "Sunlit Temple", biome: "basalt" },');
        expect(update.biome).toBe('basalt');
    });

    it('carries the biome across a rename instead of dropping it', () => {
        const update = buildTrackRepositoryUpdate({
            catalogSource: MIXED_BIOME_CATALOG_SOURCE,
            trackKey: 'templeReborn',
            originalTrackKey: 'sunlitTemple',
            trackName: 'Temple Reborn',
            destination: 'daily',
        });

        expect(update.action).toBe('renamed');
        expect(update.catalogSource).toContain('templeReborn: { name: "Temple Reborn", biome: "basalt" },');
        expect(update.catalogSource).not.toContain('sunlitTemple');
        expect(update.biome).toBe('basalt');
    });

    it('refuses an unsettled or unknown biome', () => {
        const save = (biome) => () => buildTrackRepositoryUpdate({
            catalogSource: CATALOG_SOURCE,
            trackKey: 'circuit',
            originalTrackKey: 'circuit',
            trackName: 'Classic Circuit',
            destination: 'daily',
            biome,
        });

        expect(save('random')).toThrow(/not random/);
        expect(save('swamplands')).toThrow(/Biome must be one of/);
    });

    it('refuses a catalog entry it cannot read instead of dropping the track', () => {
        const malformed = CATALOG_SOURCE.replace(
            '    numberZero: { name: "Number Zero" },',
            '    numberZero: { name: "Number Zero", skin: "wet" },',
        );

        expect(() => parseTrackCatalogSource(malformed)).toThrow(/could be read/);
    });
});

describe('Mapmaker catalog biome backfill', () => {
    it('settles a biome on every entry that has none', () => {
        const { catalogSource, assignments } = buildCatalogBiomeBackfill({
            catalogSource: CATALOG_SOURCE,
        });

        expect(assignments.map((entry) => entry.trackKey)).toEqual([
            'circuit',
            'sunlitTemple',
            'numberZero',
        ]);
        expect(assignments.every((entry) => isBiomeName(entry.biome))).toBe(true);
        expect(parseTrackCatalogSource(catalogSource).biomesByKey).toEqual({
            circuit: pickBiomeForTrackKey('circuit'),
            sunlitTemple: pickBiomeForTrackKey('sunlitTemple'),
            numberZero: pickBiomeForTrackKey('numberZero'),
        });
    });

    it('never overwrites a biome a track already settled on', () => {
        const { catalogSource, assignments } = buildCatalogBiomeBackfill({
            catalogSource: MIXED_BIOME_CATALOG_SOURCE,
        });

        expect(assignments.map((entry) => entry.trackKey)).toEqual(['circuit', 'numberZero']);
        expect(catalogSource).toContain('sunlitTemple: { name: "Sunlit Temple", biome: "basalt" },');
    });

    it('honours pinned tracks over the hashed pick', () => {
        const { catalogSource, assignments } = buildCatalogBiomeBackfill({
            catalogSource: CATALOG_SOURCE,
            pinned: { circuit: 'basalt' },
        });

        expect(catalogSource).toContain('circuit: { name: "Classic Circuit", biome: "basalt" },');
        expect(assignments.find((entry) => entry.trackKey === 'circuit')).toEqual({
            trackKey: 'circuit',
            biome: 'basalt',
            pinned: true,
        });
    });

    it('changes nothing on a second run', () => {
        const first = buildCatalogBiomeBackfill({ catalogSource: CATALOG_SOURCE });
        const second = buildCatalogBiomeBackfill({ catalogSource: first.catalogSource });

        expect(second.catalogSource).toBe(first.catalogSource);
        expect(second.assignments).toEqual([]);
    });
});
