import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
    generateTrackModuleSource,
    getTrackModuleFilename,
    isValidTrackKey,
} from './track-source.js';
import {
    applyScheduleDestination,
    applyTrackSeriesUpdate,
    DAILY_DESTINATION,
    findTrackStage,
    moveSeriesStage,
    parseCampaignSeriesSource,
    parseTrackDestination,
    serializeCampaignSeries,
    seriesDestination,
    UNUSED_DESTINATION,
} from './campaign-series.js';
import { isCampaignSeriesLive } from '../../game/campaign/series-rules.js';
import { getMedalRowError, normalizeMedalRow, sameMedalRow } from './medal-times.js';

const CATALOG_BLOCK_RE = /export const TRACK_CATALOG = \{\n[\s\S]*?\n\};/;
const SCHEDULE_BLOCK_RE = /export const TRACK_SCHEDULE_KEYS = \[\n[\s\S]*?\n\];/;
const SERIES_FILE = 'game/campaign/series.json';
const MEDALS_FILE = 'game/medals/medal-times.json';

function assertTrackKey(trackKey, label = 'Track key') {
    if (!isValidTrackKey(trackKey)) {
        throw new Error(`${label} must be a valid non-reserved JavaScript identifier.`);
    }
}

function assertDestination(destination, seriesData = null) {
    const parsed = parseTrackDestination(destination, seriesData);
    if (!parsed) {
        throw new Error('Destination must be daily, not used, or a Campaign series.');
    }
    return parsed;
}

function parseMedalTimesSource(source) {
    const medalTimes = JSON.parse(source);
    if (!medalTimes || typeof medalTimes !== 'object' || Array.isArray(medalTimes)) {
        throw new Error('Track medal times are invalid.');
    }
    return medalTimes;
}

function serializeMedalTimes(medalTimes) {
    return `${JSON.stringify(medalTimes, null, 2)}\n`;
}

// Works out the medal row after a save. A track in a live series keeps its
// times, because players' saved medals were worked out with them.
function applyMedalTimesUpdate(medalTimes, {
    trackKey,
    originalTrackKey,
    medalRow,
    seriesStage,
}) {
    const next = { ...medalTimes };
    const previousKey = originalTrackKey ?? trackKey;
    const existing = next[previousKey] ?? null;
    if (previousKey !== trackKey) {
        delete next[previousKey];
        if (existing) next[trackKey] = existing;
    }
    if (medalRow) {
        const error = getMedalRowError(medalRow);
        if (error) throw new Error(error);
        const liveStage = seriesStage && isCampaignSeriesLive(seriesStage.series);
        if (liveStage && existing && !sameMedalRow(existing, medalRow)) {
            throw new Error(
                `${seriesStage.series.name} is live, so the medal times of ${trackKey} are fixed.`,
            );
        }
        next[trackKey] = normalizeMedalRow(medalRow);
    }
    if (seriesStage && getMedalRowError(next[trackKey])) {
        throw new Error(`A Campaign stage needs all four medal times. Set them for ${trackKey}.`);
    }
    return next;
}

export function parseTrackCatalogSource(source) {
    const catalogMatch = source.match(CATALOG_BLOCK_RE);
    const scheduleMatch = source.match(SCHEDULE_BLOCK_RE);
    if (!catalogMatch || !scheduleMatch) {
        throw new Error('Track catalog source does not contain the expected catalog and schedule blocks.');
    }

    const namesByKey = {};
    const entryRe = /^\s{4}([A-Za-z_$][A-Za-z0-9_$]*): \{ name: (.+) \},$/gm;
    for (const match of catalogMatch[0].matchAll(entryRe)) {
        const [, trackKey, rawName] = match;
        const name = JSON.parse(rawName);
        if (typeof name !== 'string' || !name.trim()) {
            throw new Error(`Catalog track ${trackKey} needs a non-empty name.`);
        }
        if (Object.prototype.hasOwnProperty.call(namesByKey, trackKey)) {
            throw new Error(`Catalog track ${trackKey} is duplicated.`);
        }
        namesByKey[trackKey] = name;
    }

    const scheduleKeys = [...scheduleMatch[0].matchAll(/^\s{4}'([^']+)',$/gm)]
        .map((match) => match[1]);
    if (scheduleKeys.length === 0) {
        throw new Error('Track schedule must contain at least one key.');
    }
    if (new Set(scheduleKeys).size !== scheduleKeys.length) {
        throw new Error('Track schedule contains duplicate keys.');
    }

    for (const trackKey of scheduleKeys) {
        if (!Object.prototype.hasOwnProperty.call(namesByKey, trackKey)) {
            throw new Error(`Schedule key ${trackKey} is missing from the catalog.`);
        }
    }

    return {
        namesByKey,
        catalogKeys: Object.keys(namesByKey),
        scheduleKeys,
    };
}

function generateCatalogBlock(catalogKeys, namesByKey) {
    return [
        'export const TRACK_CATALOG = {',
        ...catalogKeys.map((trackKey) => (
            `    ${trackKey}: { name: ${JSON.stringify(namesByKey[trackKey])} },`
        )),
        '};',
    ].join('\n');
}

function generateScheduleBlock(scheduleKeys) {
    return [
        'export const TRACK_SCHEDULE_KEYS = [',
        ...scheduleKeys.map((trackKey) => `    '${trackKey}',`),
        '];',
    ].join('\n');
}

export function generateTracksRegistrySource(catalogKeys) {
    return [
        ...catalogKeys.map((trackKey) => (
            `import ${trackKey} from './definitions/${getTrackModuleFilename(trackKey)}';`
        )),
        "import { TRACK_CATALOG } from './catalog.js';",
        "import { getStoredTrack, isStoredTrack } from './stored-tracks.js';",
        '',
        'const TRACK_GEOMETRY = {',
        ...catalogKeys.map((trackKey) => `    ${trackKey},`),
        '};',
        '',
        '// The tracks in the app, without the stored tracks.',
        'export const BUILT_IN_TRACKS = Object.fromEntries(',
        '    Object.keys(TRACK_CATALOG).map((trackKey) => [',
        '        trackKey,',
        '        { name: TRACK_CATALOG[trackKey].name, ...TRACK_GEOMETRY[trackKey] },',
        '    ]),',
        ');',
        '',
        '// Compatibility registry for existing gameplay and server consumers. A',
        '// stored track with the same key wins over the built-in one. A list of the',
        '// registry gives the built-in tracks only.',
        'export const TRACKS = new Proxy(BUILT_IN_TRACKS, {',
        '    get(target, trackKey, receiver) {',
        "        const stored = typeof trackKey === 'string' ? getStoredTrack(trackKey) : null;",
        '        return stored?.track ?? Reflect.get(target, trackKey, receiver);',
        '    },',
        '    has(target, trackKey) {',
        "        return (typeof trackKey === 'string' && isStoredTrack(trackKey))",
        '            || Reflect.has(target, trackKey);',
        '    },',
        '});',
        '',
    ].join('\n');
}

function assertSafeDefinitionFilename(filename) {
    if (
        typeof filename !== 'string'
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.js$/.test(filename)
    ) {
        throw new Error('Track definition filename is unsafe.');
    }
}

function assertPathInsideDirectory(filePath, directoryPath, label) {
    const resolvedFile = resolve(filePath);
    const resolvedDirectory = resolve(directoryPath);
    if (
        resolvedFile !== resolvedDirectory
        && !resolvedFile.startsWith(`${resolvedDirectory}/`)
    ) {
        throw new Error(`${label} must stay inside the track definitions directory.`);
    }
}

// Where a saved track is used: a series stage, the Daily schedule, or neither.
function getTrackDestination(seriesData, scheduleKeys, trackKey) {
    const stage = findTrackStage(seriesData, trackKey);
    if (stage) return seriesDestination(stage.series.id);
    return scheduleKeys.includes(trackKey) ? DAILY_DESTINATION : UNUSED_DESTINATION;
}

// Saves a track's shape, name and medal times. It never changes where the track
// is used: a new track starts as not used, and a rename keeps its place.
export function buildTrackRepositoryUpdate({
    catalogSource,
    seriesSource,
    medalsSource,
    trackKey,
    originalTrackKey = null,
    trackName,
    medalRow = null,
}) {
    assertTrackKey(trackKey);
    const seriesData = parseCampaignSeriesSource(seriesSource);
    if (originalTrackKey !== null) {
        assertTrackKey(originalTrackKey, 'Original track key');
    }
    const normalizedName = String(trackName || '').trim();
    if (!normalizedName) {
        throw new Error('Track name cannot be empty.');
    }

    const {
        namesByKey,
        catalogKeys,
        scheduleKeys,
    } = parseTrackCatalogSource(catalogSource);
    const nextCatalogKeys = [...catalogKeys];
    const nextScheduleKeys = [...scheduleKeys];
    const originalExists = originalTrackKey !== null
        && Object.prototype.hasOwnProperty.call(namesByKey, originalTrackKey);
    const targetExists = Object.prototype.hasOwnProperty.call(namesByKey, trackKey);
    const isRename = originalExists && originalTrackKey !== trackKey;

    if (originalTrackKey !== null && !originalExists) {
        throw new Error(`Original track ${originalTrackKey} is not present in the catalog.`);
    }
    if (isRename && targetExists) {
        throw new Error(`Track ${trackKey} already exists.`);
    }

    let action = 'updated';
    let removedFilename = null;

    if (isRename) {
        action = 'renamed';
        const catalogIndex = nextCatalogKeys.indexOf(originalTrackKey);
        nextCatalogKeys[catalogIndex] = trackKey;
        const scheduleIndex = nextScheduleKeys.indexOf(originalTrackKey);
        if (scheduleIndex !== -1) {
            nextScheduleKeys[scheduleIndex] = trackKey;
        }
        delete namesByKey[originalTrackKey];
        removedFilename = getTrackModuleFilename(originalTrackKey);
    } else if (!targetExists) {
        action = 'created';
        nextCatalogKeys.push(trackKey);
    }

    namesByKey[trackKey] = normalizedName;
    const destination = originalExists
        ? getTrackDestination(seriesData, scheduleKeys, originalTrackKey)
        : UNUSED_DESTINATION;
    const seriesUpdate = applyTrackSeriesUpdate(seriesData, {
        trackKey,
        originalTrackKey: originalExists ? originalTrackKey : null,
        destination,
    });
    const seriesStage = seriesUpdate.series
        ? { series: seriesUpdate.series, stageIndex: seriesUpdate.stageIndex }
        : null;
    const medalTimes = applyMedalTimesUpdate(parseMedalTimesSource(medalsSource), {
        trackKey,
        originalTrackKey: originalExists ? originalTrackKey : null,
        medalRow,
        seriesStage,
    });

    const orderedNamesByKey = Object.fromEntries(
        nextCatalogKeys.map((key) => [key, namesByKey[key]]),
    );
    const nextCatalogSource = catalogSource
        .replace(CATALOG_BLOCK_RE, generateCatalogBlock(nextCatalogKeys, orderedNamesByKey))
        .replace(SCHEDULE_BLOCK_RE, generateScheduleBlock(nextScheduleKeys));

    return {
        action,
        destination,
        scheduleIndex: nextScheduleKeys.indexOf(trackKey),
        scheduleLength: nextScheduleKeys.length,
        seriesId: seriesStage?.series.id ?? null,
        stageIndex: seriesStage?.stageIndex ?? -1,
        filename: getTrackModuleFilename(trackKey),
        removedFilename,
        catalogSource: nextCatalogSource,
        tracksSource: generateTracksRegistrySource(nextCatalogKeys),
        seriesSource: serializeCampaignSeries(seriesUpdate.data),
        medalsSource: serializeMedalTimes(medalTimes),
    };
}

function writeFilesWithRollback(files) {
    const originals = files.map(({ path }) => ({
        path,
        source: existsSync(path) ? readFileSync(path, 'utf8') : null,
    }));
    try {
        for (const { path, source } of files) writeFileSync(path, source, 'utf8');
    } catch (error) {
        for (const { path, source } of originals) {
            if (source === null) {
                if (existsSync(path)) rmSync(path);
            } else {
                writeFileSync(path, source, 'utf8');
            }
        }
        throw error;
    }
}

export function applyTrackRepositoryUpdate({
    rootDir,
    trackKey,
    originalTrackKey = null,
    trackName,
    medalRow = null,
    track,
}) {
    const resolvedRoot = resolve(rootDir);
    const catalogPath = join(resolvedRoot, 'game/track/catalog.js');
    const tracksPath = join(resolvedRoot, 'game/track/tracks.js');
    const seriesPath = join(resolvedRoot, SERIES_FILE);
    const medalsPath = join(resolvedRoot, MEDALS_FILE);
    const definitionsPath = join(resolvedRoot, 'game/track/definitions');
    const catalogSource = readFileSync(catalogPath, 'utf8');
    const update = buildTrackRepositoryUpdate({
        catalogSource,
        seriesSource: readFileSync(seriesPath, 'utf8'),
        medalsSource: readFileSync(medalsPath, 'utf8'),
        trackKey,
        originalTrackKey,
        trackName,
        medalRow,
    });
    const definitionFilename = getTrackModuleFilename(trackKey);
    assertSafeDefinitionFilename(definitionFilename);
    if (definitionFilename !== update.filename) {
        throw new Error('Track definition filename mismatch.');
    }
    const definitionPath = resolve(definitionsPath, definitionFilename);
    assertPathInsideDirectory(definitionPath, definitionsPath, definitionFilename);
    const isExistingTarget = originalTrackKey === trackKey;

    if (!isExistingTarget && existsSync(definitionPath)) {
        throw new Error(`${definitionFilename} already exists but is not integrated in the selected track.`);
    }

    let oldDefinitionPath = null;
    if (update.removedFilename) {
        assertSafeDefinitionFilename(update.removedFilename);
        if (originalTrackKey === null) {
            throw new Error('Cannot remove a definition without an original track key.');
        }
        const expectedRemovedFilename = getTrackModuleFilename(originalTrackKey);
        if (update.removedFilename !== expectedRemovedFilename) {
            throw new Error('Removed track definition filename mismatch.');
        }
        oldDefinitionPath = resolve(definitionsPath, expectedRemovedFilename);
        assertPathInsideDirectory(
            oldDefinitionPath,
            definitionsPath,
            expectedRemovedFilename,
        );
        if (!existsSync(oldDefinitionPath)) {
            throw new Error(`Cannot rename because ${expectedRemovedFilename} does not exist.`);
        }
    }

    mkdirSync(definitionsPath, { recursive: true });
    writeFilesWithRollback([
        { path: definitionPath, source: generateTrackModuleSource(track) },
        { path: catalogPath, source: update.catalogSource },
        { path: tracksPath, source: update.tracksSource },
        { path: seriesPath, source: update.seriesSource },
        { path: medalsPath, source: update.medalsSource },
    ]);

    if (oldDefinitionPath) {
        rmSync(oldDefinitionPath);
    }

    return {
        action: update.action,
        destination: update.destination,
        filename: definitionFilename,
        removedFilename: update.removedFilename,
        scheduleIndex: update.scheduleIndex,
        scheduleLength: update.scheduleLength,
        seriesId: update.seriesId,
        stageIndex: update.stageIndex,
    };
}

// Moves a stage up or down in a series that is not live.
export function applySeriesStageMove({ rootDir, seriesId, trackKey, direction }) {
    assertTrackKey(trackKey);
    const seriesPath = join(resolve(rootDir), SERIES_FILE);
    const next = moveSeriesStage(
        parseCampaignSeriesSource(readFileSync(seriesPath, 'utf8')),
        seriesId,
        trackKey,
        direction,
    );
    writeFileSync(seriesPath, serializeCampaignSeries(next), 'utf8');
    const series = next.series.find((entry) => entry.id === seriesId);
    return { seriesId, trackKeys: series.stages.map((stage) => stage.trackKey) };
}

// Sets where a saved track is used: the Daily schedule, a Campaign series, or neither.
export function buildTrackAssignment({
    catalogSource,
    seriesSource,
    medalsSource,
    trackKey,
    destination,
    laps = null,
    requiredMedals = null,
}) {
    assertTrackKey(trackKey);
    const seriesData = parseCampaignSeriesSource(seriesSource);
    const parsedDestination = assertDestination(destination, seriesData);
    const { namesByKey, scheduleKeys } = parseTrackCatalogSource(catalogSource);
    if (!Object.prototype.hasOwnProperty.call(namesByKey, trackKey)) {
        throw new Error(`Track ${trackKey} is not saved yet. Save it in the Mapmaker first.`);
    }
    const nextScheduleKeys = [...scheduleKeys];
    applyScheduleDestination(nextScheduleKeys, trackKey, parsedDestination);
    const seriesUpdate = applyTrackSeriesUpdate(seriesData, {
        trackKey,
        destination,
        laps,
        requiredMedals,
    });
    if (seriesUpdate.series && getMedalRowError(parseMedalTimesSource(medalsSource)[trackKey])) {
        throw new Error(`A Campaign stage needs all four medal times. Set them for ${trackKey} in the Mapmaker.`);
    }
    return {
        destination,
        scheduleIndex: nextScheduleKeys.indexOf(trackKey),
        seriesId: seriesUpdate.series?.id ?? null,
        stageIndex: seriesUpdate.stageIndex,
        catalogSource: catalogSource.replace(SCHEDULE_BLOCK_RE, generateScheduleBlock(nextScheduleKeys)),
        seriesSource: serializeCampaignSeries(seriesUpdate.data),
    };
}

export function applyTrackAssignment({ rootDir, ...options }) {
    const resolvedRoot = resolve(rootDir);
    const catalogPath = join(resolvedRoot, 'game/track/catalog.js');
    const seriesPath = join(resolvedRoot, SERIES_FILE);
    const update = buildTrackAssignment({
        catalogSource: readFileSync(catalogPath, 'utf8'),
        seriesSource: readFileSync(seriesPath, 'utf8'),
        medalsSource: readFileSync(join(resolvedRoot, MEDALS_FILE), 'utf8'),
        ...options,
    });
    writeFilesWithRollback([
        { path: catalogPath, source: update.catalogSource },
        { path: seriesPath, source: update.seriesSource },
    ]);
    return {
        destination: update.destination,
        scheduleIndex: update.scheduleIndex,
        seriesId: update.seriesId,
        stageIndex: update.stageIndex,
    };
}

export function buildTrackRepositoryRemoval({
    catalogSource,
    trackKey,
    seriesSource,
    publishedHistorySource,
}) {
    assertTrackKey(trackKey);
    const { namesByKey, catalogKeys, scheduleKeys } = parseTrackCatalogSource(catalogSource);
    if (!Object.prototype.hasOwnProperty.call(namesByKey, trackKey)) {
        throw new Error(`Track ${trackKey} is not present in the catalog.`);
    }
    const defaultTrackKey = catalogSource.match(/export const DEFAULT_TRACK_KEY = '([^']+)';/)?.[1];
    if (!defaultTrackKey || typeof seriesSource !== 'string' || typeof publishedHistorySource !== 'string') {
        throw new Error('Track removal dependencies could not be checked.');
    }
    if (trackKey === defaultTrackKey) {
        throw new Error('Cannot remove the default track.');
    }
    const stage = findTrackStage(parseCampaignSeriesSource(seriesSource), trackKey);
    if (stage) {
        throw new Error(
            `Cannot remove ${trackKey} because ${stage.series.name} uses it. Take it out of the series in the Campaign Planner first.`,
        );
    }
    if (publishedHistorySource.includes(`'${trackKey}'`)) {
        throw new Error(`Cannot remove ${trackKey} because published Daily GP history uses it.`);
    }

    const filename = getTrackModuleFilename(trackKey);
    if (catalogKeys.some((key) => key !== trackKey && getTrackModuleFilename(key) === filename)) {
        throw new Error(`Cannot remove ${trackKey} because another track shares ${filename}.`);
    }

    const nextCatalogKeys = catalogKeys.filter((key) => key !== trackKey);
    const nextScheduleKeys = scheduleKeys.filter((key) => key !== trackKey);
    if (nextScheduleKeys.length === 0) {
        throw new Error('Cannot remove the last Daily Challenge track.');
    }
    delete namesByKey[trackKey];

    return {
        filename,
        catalogSource: catalogSource
            .replace(CATALOG_BLOCK_RE, generateCatalogBlock(nextCatalogKeys, namesByKey))
            .replace(SCHEDULE_BLOCK_RE, generateScheduleBlock(nextScheduleKeys)),
        tracksSource: generateTracksRegistrySource(nextCatalogKeys),
        scheduleLength: nextScheduleKeys.length,
    };
}

export function applyTrackRepositoryRemoval({ rootDir, trackKey }) {
    const resolvedRoot = resolve(rootDir);
    const catalogPath = join(resolvedRoot, 'game/track/catalog.js');
    const tracksPath = join(resolvedRoot, 'game/track/tracks.js');
    const medalsPath = join(resolvedRoot, MEDALS_FILE);
    const seriesPath = join(resolvedRoot, SERIES_FILE);
    const publishedHistoryPath = join(resolvedRoot, 'game/shared/daily-gp-history-backfill.js');
    const definitionsPath = join(resolvedRoot, 'game/track/definitions');
    const catalogSource = readFileSync(catalogPath, 'utf8');
    const tracksSource = readFileSync(tracksPath, 'utf8');
    const medalsSource = readFileSync(medalsPath, 'utf8');
    const update = buildTrackRepositoryRemoval({
        catalogSource,
        trackKey,
        seriesSource: readFileSync(seriesPath, 'utf8'),
        publishedHistorySource: readFileSync(publishedHistoryPath, 'utf8'),
    });
    assertSafeDefinitionFilename(update.filename);
    const definitionPath = resolve(definitionsPath, update.filename);
    assertPathInsideDirectory(definitionPath, definitionsPath, update.filename);
    if (!existsSync(definitionPath)) {
        throw new Error(`Cannot remove ${trackKey} because ${update.filename} does not exist.`);
    }

    const medalTimes = parseMedalTimesSource(medalsSource);
    delete medalTimes[trackKey];

    try {
        writeFileSync(catalogPath, update.catalogSource, 'utf8');
        writeFileSync(tracksPath, update.tracksSource, 'utf8');
        writeFileSync(medalsPath, serializeMedalTimes(medalTimes), 'utf8');
        rmSync(definitionPath);
    } catch (error) {
        writeFileSync(catalogPath, catalogSource, 'utf8');
        writeFileSync(tracksPath, tracksSource, 'utf8');
        writeFileSync(medalsPath, medalsSource, 'utf8');
        throw error;
    }

    return {
        action: 'removed',
        filename: update.filename,
        scheduleLength: update.scheduleLength,
    };
}
