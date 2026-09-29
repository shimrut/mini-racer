import { afterEach, describe, expect, it, vi } from 'vitest';
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
    applyTrackAssignment,
    applyTrackRepositoryUpdate,
    applyTrackRepositoryRemoval,
    buildTrackAssignment,
    buildTrackRepositoryRemoval,
    buildTrackRepositoryUpdate,
    parseTrackCatalogSource,
} from '../tools/mapmaker/track-repository.js';

// Mini Rally is held back from players; these rules need a live dirt series.
vi.mock('../game/track/live-grounds.js', () => import('./helpers/live-grounds-with-dirt.js'));

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
const MEDAL_ROW = { author: 9.5, gold: 9.74, silver: 10.02, bronze: 10.34 };

// Formula Mini stays not live until it has 2 stages. The other series are live
// from their first stage.
function seriesSource(
    numbersStages = [{ trackKey: 'numberZero', laps: 2, requiredMedals: 0 }],
    dirtStages = [],
    formulaMiniStages = [],
) {
    return `${JSON.stringify({
        series: [
            { id: 'numbered-v1', name: 'Numbers', ground: 'tarmac', stages: numbersStages },
            { id: 'dirt-v1', name: 'Dirt', ground: 'dirt', stages: dirtStages },
            { id: 'grip-v1', name: 'Formula Mini', ground: 'grip', stages: formulaMiniStages },
        ],
    }, null, 2)}\n`;
}

const FORMULA_MINI_DRAFT_SOURCE = seriesSource([], [], [{ trackKey: 'numberZero', laps: 2, requiredMedals: 0 }]);

const SERIES_SOURCE = seriesSource();
const MEDALS_SOURCE = `${JSON.stringify({ numberZero: MEDAL_ROW, circuit: MEDAL_ROW }, null, 2)}\n`;
const ALL_MEDALS_SOURCE = JSON.stringify({ numberZero: MEDAL_ROW, circuit: MEDAL_ROW, sunlitTemple: MEDAL_ROW });

function buildUpdate(options) {
    return buildTrackRepositoryUpdate({
        catalogSource: CATALOG_SOURCE,
        seriesSource: SERIES_SOURCE,
        medalsSource: MEDALS_SOURCE,
        ...options,
    });
}

function buildAssign(options) {
    return buildTrackAssignment({
        catalogSource: CATALOG_SOURCE,
        seriesSource: SERIES_SOURCE,
        medalsSource: ALL_MEDALS_SOURCE,
        ...options,
    });
}

function tenStages(prefix = 'dirtTrack') {
    return Array.from({ length: 10 }, (_, index) => ({
        trackKey: index === 0 ? 'sunlitTemple' : `${prefix}${index}`,
        laps: 1,
        requiredMedals: index === 0 ? 0 : index * 2,
    }));
}
const HISTORY_SOURCE = "export const PUBLISHED_DAILY_GP_TRACKS_BY_DATE = { '2026-06-02': 'albertGardens' };";

function buildRemoval(catalogSource, trackKey) {
    return buildTrackRepositoryRemoval({
        catalogSource,
        trackKey,
        seriesSource: SERIES_SOURCE,
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

    it('adds a new track to the catalog as not used', () => {
        const update = buildUpdate({
            trackKey: 'newHarborRun',
            trackName: 'New Harbor Run',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('created');
        expect(update.destination).toBe('none');
        expect(update.scheduleIndex).toBe(-1);
        expect(update.seriesSource).toBe(SERIES_SOURCE);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
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

    it('updates an existing track without changing where it is used', () => {
        const update = buildUpdate({
            trackKey: 'circuit',
            originalTrackKey: 'circuit',
            trackName: 'Classic Circuit Updated',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('updated');
        expect(update.destination).toBe('daily');
        expect(update.scheduleIndex).toBe(0);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(parsed.catalogKeys).toEqual(['circuit', 'sunlitTemple', 'numberZero']);
        expect(parsed.namesByKey.circuit).toBe('Classic Circuit Updated');

        const stageUpdate = buildUpdate({
            trackKey: 'numberZero',
            originalTrackKey: 'numberZero',
            trackName: 'Number Zero',
        });
        expect(stageUpdate.destination).toBe('series:numbered-v1');
        expect(stageUpdate.seriesSource).toBe(SERIES_SOURCE);
    });

    it('renames a track in place and identifies the old module for removal', () => {
        const update = buildUpdate({
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
        expect(parsed.catalogKeys).toContain('numberZero');
        expect(update.tracksSource).not.toContain('sunlitTemple');
        expect(update.tracksSource).toContain('numberZero');
    });

    it('renames a series track without putting it on the Daily schedule', () => {
        const update = buildUpdate({
            seriesSource: FORMULA_MINI_DRAFT_SOURCE,
            trackKey: 'numberNil',
            originalTrackKey: 'numberZero',
            trackName: 'Number Nil',
        });
        const parsed = parseTrackCatalogSource(update.catalogSource);

        expect(update.action).toBe('renamed');
        expect(update.scheduleIndex).toBe(-1);
        expect(parsed.scheduleKeys).toEqual(['circuit', 'sunlitTemple']);
        expect(parsed.catalogKeys).toContain('numberNil');
        expect(parsed.namesByKey).not.toHaveProperty('numberZero');
        expect(JSON.parse(update.seriesSource).series[2].stages[0].trackKey).toBe('numberNil');
        expect(JSON.parse(update.medalsSource)).toHaveProperty('numberNil');
        expect(JSON.parse(update.medalsSource)).not.toHaveProperty('numberZero');
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
        mkdirSync(join(root, 'game/campaign'), { recursive: true });
        mkdirSync(join(root, 'game/medals'), { recursive: true });
        writeFileSync(join(root, 'game/campaign/series.json'), SERIES_SOURCE);
        writeFileSync(join(root, 'game/medals/medal-times.json'), MEDALS_SOURCE);

        const result = applyTrackRepositoryUpdate({
            rootDir: root,
            trackKey: 'sunriseTemple',
            originalTrackKey: 'sunlitTemple',
            trackName: 'Sunrise Temple',
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
        expect(() => buildRemoval(CATALOG_SOURCE, 'numberZero')).toThrow('Numbers uses it');

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
        writeFileSync(join(campaignRoot, 'series.json'), SERIES_SOURCE);
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

describe('Campaign Planner track assignment', () => {
    it('puts a track on the Daily schedule after the last entry', () => {
        const update = buildAssign({ trackKey: 'numberZero', destination: 'daily', seriesSource: FORMULA_MINI_DRAFT_SOURCE });
        expect(update.scheduleIndex).toBe(2);
        expect(parseTrackCatalogSource(update.catalogSource).scheduleKeys)
            .toEqual(['circuit', 'sunlitTemple', 'numberZero']);
        expect(JSON.parse(update.seriesSource).series[2].stages).toEqual([]);
    });

    it('moves a Daily track to a series and off the schedule', () => {
        const update = buildAssign({ trackKey: 'sunlitTemple', destination: 'series:numbered-v1', laps: 3 });
        expect(update.seriesId).toBe('numbered-v1');
        expect(update.stageIndex).toBe(1);
        expect(update.scheduleIndex).toBe(-1);
        expect(parseTrackCatalogSource(update.catalogSource).scheduleKeys).toEqual(['circuit']);
        expect(JSON.parse(update.seriesSource).series[0].stages).toEqual([
            { trackKey: 'numberZero', laps: 2, requiredMedals: 0 },
            { trackKey: 'sunlitTemple', laps: 3, requiredMedals: 2 },
        ]);
    });

    it('can mark any track as not used', () => {
        const update = buildAssign({ trackKey: 'sunlitTemple', destination: 'none' });
        expect(update.scheduleIndex).toBe(-1);
        expect(parseTrackCatalogSource(update.catalogSource).scheduleKeys).toEqual(['circuit']);
        expect(() => buildAssign({ trackKey: 'circuit', destination: 'none', catalogSource: CATALOG_SOURCE
            .replace("    'sunlitTemple',\n", '') })).toThrow('at least one key');
    });

    it('rejects an unsaved track and an invalid destination', () => {
        expect(() => buildAssign({ trackKey: 'newHarborRun', destination: 'daily' }))
            .toThrow('Save it in the Mapmaker first');
        expect(() => buildAssign({ trackKey: 'circuit', destination: 'challenge' }))
            .toThrow('Destination must be daily, not used, or a Campaign series.');
        expect(() => buildAssign({ trackKey: 'circuit', destination: 'series:snow-v1' }))
            .toThrow('Destination must be daily, not used, or a Campaign series.');
    });

    it('writes the catalog and series files', () => {
        const root = mkdtempSync(join(tmpdir(), 'dailygp-planner-'));
        temporaryRoots.push(root);
        mkdirSync(join(root, 'game/track'), { recursive: true });
        mkdirSync(join(root, 'game/campaign'), { recursive: true });
        mkdirSync(join(root, 'game/medals'), { recursive: true });
        writeFileSync(join(root, 'game/track/catalog.js'), CATALOG_SOURCE);
        writeFileSync(join(root, 'game/campaign/series.json'), SERIES_SOURCE);
        writeFileSync(join(root, 'game/medals/medal-times.json'), ALL_MEDALS_SOURCE);

        const result = applyTrackAssignment({ rootDir: root, trackKey: 'sunlitTemple', destination: 'series:dirt-v1' });

        expect(result).toMatchObject({ seriesId: 'dirt-v1', stageIndex: 0, scheduleIndex: -1 });
        expect(parseTrackCatalogSource(readFileSync(join(root, 'game/track/catalog.js'), 'utf8')).scheduleKeys)
            .toEqual(['circuit']);
        expect(JSON.parse(readFileSync(join(root, 'game/campaign/series.json'), 'utf8')).series[1].stages)
            .toEqual([{ trackKey: 'sunlitTemple', laps: 1, requiredMedals: 0 }]);
    });
});

describe('Mapmaker Campaign series rules', () => {
    const liveSeries = seriesSource(
        [{ trackKey: 'numberZero', laps: 2, requiredMedals: 0 }],
        tenStages(),
    );
    const liveMedals = JSON.stringify({ numberZero: MEDAL_ROW, sunlitTemple: MEDAL_ROW, circuit: MEDAL_ROW });

    function buildLive(options) {
        return buildUpdate({ seriesSource: liveSeries, medalsSource: liveMedals, ...options });
    }

    function assignLive(options) {
        return buildAssign({ seriesSource: liveSeries, medalsSource: liveMedals, ...options });
    }

    it('adds a track after the last stage of a live series', () => {
        const update = assignLive({
            trackKey: 'circuit',
            destination: 'series:dirt-v1',
            laps: 2,
            requiredMedals: 21,
        });
        const dirt = JSON.parse(update.seriesSource).series[1];
        expect(update.stageIndex).toBe(10);
        expect(dirt.stages.at(-1)).toEqual({ trackKey: 'circuit', laps: 2, requiredMedals: 21 });
        expect(dirt.stages.slice(0, 10)).toEqual(tenStages());
    });

    it('keeps the stages of a live series fixed', () => {
        const base = { trackKey: 'sunlitTemple' };
        expect(() => assignLive({ ...base, destination: 'daily' })).toThrow('Dirt is live');
        expect(() => assignLive({ ...base, destination: 'none' })).toThrow('Dirt is live');
        expect(() => assignLive({ ...base, destination: 'series:numbered-v1' })).toThrow('Dirt is live');
        expect(() => assignLive({ ...base, destination: 'series:dirt-v1', laps: 3 })).toThrow('Dirt is live');
        expect(() => assignLive({ ...base, destination: 'series:dirt-v1', requiredMedals: 1 }))
            .toThrow('Dirt is live');
        expect(() => assignLive({ ...base, destination: 'series:dirt-v1', laps: 1, requiredMedals: 0 }))
            .not.toThrow();

        const save = { trackKey: 'sunlitTemple', originalTrackKey: 'sunlitTemple', trackName: 'Sunlit Temple' };
        expect(() => buildLive({ ...save, trackKey: 'sunsetTemple' })).toThrow('Dirt is live');
        expect(() => buildLive({ ...save, medalRow: { ...MEDAL_ROW, author: 9.4 } }))
            .toThrow('medal times of sunlitTemple are fixed');
        expect(() => buildLive(save)).not.toThrow();
    });

    it('needs all four medal times in order for a series stage', () => {
        expect(() => buildAssign({ trackKey: 'sunlitTemple', destination: 'series:dirt-v1', medalsSource: MEDALS_SOURCE }))
            .toThrow('needs all four medal times');
        expect(() => buildUpdate({
            trackKey: 'numberZero',
            originalTrackKey: 'numberZero',
            trackName: 'Number Zero',
            medalsSource: '{}',
        })).toThrow('needs all four medal times');
        expect(() => buildUpdate({
            trackKey: 'newHarborRun',
            trackName: 'New Harbor Run',
            medalRow: { ...MEDAL_ROW, gold: 9.4 },
        })).toThrow('Medal times must go up');
    });

    it('checks the medal target against its position', () => {
        const base = { trackKey: 'sunlitTemple', destination: 'series:numbered-v1' };
        expect(() => buildAssign({ ...base, requiredMedals: 0 })).toThrow('more than 0');
        expect(() => buildAssign({ ...base, requiredMedals: 4 })).toThrow('3 at most');
        expect(() => buildAssign({ ...base, requiredMedals: 3 })).not.toThrow();
        expect(() => buildAssign({ ...base, laps: 4 })).toThrow('Laps must be');
    });

    it('moves a stage in a series that is not live, and keeps each medal target in place', async () => {
        // With the current rules a series with 2 stages is live, so its order is fixed.
        // This checks the move under a rule that keeps a series hidden until 10 stages.
        vi.resetModules();
        vi.doMock('../game/campaign/series-rules.js', async (importOriginal) => ({
            ...(await importOriginal()),
            isCampaignSeriesLive: (series) => (series?.stages?.length ?? 0) >= 10,
        }));
        try {
            const { applySeriesStageMove: moveStage } = await import('../tools/mapmaker/track-repository.js');
            const root = mkdtempSync(join(tmpdir(), 'dailygp-mapmaker-series-'));
            temporaryRoots.push(root);
            mkdirSync(join(root, 'game/campaign'), { recursive: true });
            writeFileSync(join(root, 'game/campaign/series.json'), seriesSource([
                { trackKey: 'numberZero', laps: 2, requiredMedals: 0 },
                { trackKey: 'numberOne', laps: 1, requiredMedals: 2 },
                { trackKey: 'numberTwo', laps: 3, requiredMedals: 5 },
            ]));

            const result = moveStage({
                rootDir: root,
                seriesId: 'numbered-v1',
                trackKey: 'numberTwo',
                direction: -1,
            });
            expect(result.trackKeys).toEqual(['numberZero', 'numberTwo', 'numberOne']);
            expect(JSON.parse(readFileSync(join(root, 'game/campaign/series.json'), 'utf8')).series[0].stages)
                .toEqual([
                    { trackKey: 'numberZero', laps: 2, requiredMedals: 0 },
                    { trackKey: 'numberTwo', laps: 3, requiredMedals: 2 },
                    { trackKey: 'numberOne', laps: 1, requiredMedals: 5 },
                ]);

            writeFileSync(join(root, 'game/campaign/series.json'), liveSeries);
            expect(() => moveStage({
                rootDir: root,
                seriesId: 'dirt-v1',
                trackKey: 'dirtTrack3',
                direction: 1,
            })).toThrow('Dirt is live');
        } finally {
            vi.doUnmock('../game/campaign/series-rules.js');
            vi.resetModules();
        }
    });
});
