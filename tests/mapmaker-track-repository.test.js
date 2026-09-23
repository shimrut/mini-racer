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
    applyTrackRepositoryRemoval,
    buildTrackRepositoryRemoval,
    buildTrackRepositoryUpdate,
    parseTrackCatalogSource,
} from '../tools/mapmaker/track-repository.js';

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

const REMOVABLE_SOURCE = CATALOG_SOURCE
    .replace('    numberZero: { name: "Number Zero" },',
        '    numberZero: { name: "Number Zero" },\n    newHarborRun: { name: "New Harbor Run" },')
    .replace("    'sunlitTemple',", "    'sunlitTemple',\n    'newHarborRun',");
const CAMPAIGN_SOURCE = "const STAGE_DEFINITIONS = [['00', 'numberZero', 2, 0]];";
const HISTORY_SOURCE = "export const PUBLISHED_DAILY_GP_TRACKS_BY_DATE = { '2026-06-02': 'albertGardens' };";

function buildRemoval(catalogSource, trackKey) {
    return buildTrackRepositoryRemoval({
        catalogSource,
        trackKey,
        campaignSource: CAMPAIGN_SOURCE,
        publishedHistorySource: HISTORY_SOURCE,
    });
}

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

    it('removes a track from the catalog, schedule, and registry', () => {
        const removal = buildRemoval(REMOVABLE_SOURCE, 'newHarborRun');
        const parsed = parseTrackCatalogSource(removal.catalogSource);

        expect(removal.filename).toBe('new-harbor-run.js');
        expect(parsed.catalogKeys).toEqual(['circuit', 'sunlitTemple', 'numberZero']);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(removal.tracksSource).not.toContain('newHarborRun');
        expect(removal.tracksSource).toContain('numberZero');
    });

    it('refuses removal of the default, Campaign, and known published tracks', () => {
        expect(() => buildRemoval(CATALOG_SOURCE, 'circuit')).toThrow('default track');
        expect(() => buildRemoval(CATALOG_SOURCE, 'numberZero')).toThrow('Campaign stage');

        const publishedSource = CATALOG_SOURCE.replace(
            '    sunlitTemple: { name: "Sunlit Temple" },',
            '    albertGardens: { name: "Albert Gardens" },',
        ).replace("    'sunlitTemple',", "    'albertGardens',");
        expect(() => buildRemoval(publishedSource, 'albertGardens'))
            .toThrow('published Daily GP history');
    });

    it('refuses removal when another track uses the same definition filename', () => {
        const collidingSource = REMOVABLE_SOURCE.replace(
            '    newHarborRun: { name: "New Harbor Run" },',
            '    newHarborRun: { name: "New Harbor Run" },\n    new_harbor_run: { name: "Other Harbor Run" },',
        );
        expect(() => buildRemoval(collidingSource, 'newHarborRun'))
            .toThrow('another track shares new-harbor-run.js');
    });

    it('deletes only the selected definition and medal row after updating integration', () => {
        const root = mkdtempSync(join(tmpdir(), 'dailygp-mapmaker-remove-'));
        temporaryRoots.push(root);
        const trackRoot = join(root, 'game/track');
        const definitionsRoot = join(trackRoot, 'definitions');
        const medalsRoot = join(root, 'game/medals');
        const campaignRoot = join(root, 'game/campaign');
        const sharedRoot = join(root, 'game/shared');
        mkdirSync(definitionsRoot, { recursive: true });
        mkdirSync(medalsRoot, { recursive: true });
        mkdirSync(campaignRoot, { recursive: true });
        mkdirSync(sharedRoot, { recursive: true });
        writeFileSync(join(trackRoot, 'catalog.js'), REMOVABLE_SOURCE);
        writeFileSync(join(trackRoot, 'tracks.js'), '// old registry\n');
        writeFileSync(join(definitionsRoot, 'new-harbor-run.js'), '// selected\n');
        writeFileSync(join(definitionsRoot, 'circuit.js'), '// retained\n');
        writeFileSync(join(medalsRoot, 'medal-times.json'), JSON.stringify({
            circuit: { gold: 5 },
            newHarborRun: { gold: 9 },
        }, null, 2));
        writeFileSync(join(campaignRoot, 'manifest.js'), CAMPAIGN_SOURCE);
        writeFileSync(join(sharedRoot, 'daily-gp-history-backfill.js'), HISTORY_SOURCE);

        const result = applyTrackRepositoryRemoval({ rootDir: root, trackKey: 'newHarborRun' });

        expect(result).toMatchObject({ action: 'removed', filename: 'new-harbor-run.js' });
        expect(existsSync(join(definitionsRoot, 'new-harbor-run.js'))).toBe(false);
        expect(readFileSync(join(definitionsRoot, 'circuit.js'), 'utf8')).toBe('// retained\n');
        expect(parseTrackCatalogSource(readFileSync(join(trackRoot, 'catalog.js'), 'utf8')).catalogKeys)
            .toEqual(['circuit', 'sunlitTemple', 'numberZero']);
        expect(readFileSync(join(trackRoot, 'tracks.js'), 'utf8')).not.toContain('newHarborRun');
        expect(JSON.parse(readFileSync(join(medalsRoot, 'medal-times.json'), 'utf8')))
            .toEqual({ circuit: { gold: 5 } });
    });
});
