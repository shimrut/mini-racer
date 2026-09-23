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

const CATALOG_BLOCK_RE = /export const TRACK_CATALOG = \{\n[\s\S]*?\n\};/;
const SCHEDULE_BLOCK_RE = /export const TRACK_SCHEDULE_KEYS = \[\n[\s\S]*?\n\];/;
const TRACK_DESTINATIONS = new Set(['daily', 'campaign']);

function assertTrackKey(trackKey, label = 'Track key') {
    if (!isValidTrackKey(trackKey)) {
        throw new Error(`${label} must be a valid non-reserved JavaScript identifier.`);
    }
}

function assertDestination(destination) {
    if (!TRACK_DESTINATIONS.has(destination)) {
        throw new Error('Destination must be daily or campaign.');
    }
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
        "import { TRACK_CATALOG, getTrackName } from './catalog.js';",
        '',
        'const TRACK_GEOMETRY = {',
        ...catalogKeys.map((trackKey) => `    ${trackKey},`),
        '};',
        '',
        '// Compatibility registry for existing gameplay and server consumers.',
        'export const TRACKS = Object.fromEntries(',
        '    Object.keys(TRACK_CATALOG).map((trackKey) => [',
        '        trackKey,',
        '        { name: getTrackName(trackKey), ...TRACK_GEOMETRY[trackKey] },',
        '    ]),',
        ');',
        '',
    ].join('\n');
}

function applyScheduleDestination(scheduleKeys, trackKey, destination) {
    const scheduleIndex = scheduleKeys.indexOf(trackKey);
    if (destination === 'daily') {
        if (scheduleIndex === -1) {
            scheduleKeys.push(trackKey);
        }
        return;
    }

    if (scheduleIndex !== -1) {
        scheduleKeys.splice(scheduleIndex, 1);
    }
    if (scheduleKeys.length === 0) {
        throw new Error('Track schedule must contain at least one key.');
    }
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

export function buildTrackRepositoryUpdate({
    catalogSource,
    trackKey,
    originalTrackKey = null,
    trackName,
    destination = 'daily',
}) {
    assertTrackKey(trackKey);
    assertDestination(destination);
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
    applyScheduleDestination(nextScheduleKeys, trackKey, destination);

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
        filename: getTrackModuleFilename(trackKey),
        removedFilename,
        catalogSource: nextCatalogSource,
        tracksSource: generateTracksRegistrySource(nextCatalogKeys),
    };
}

export function applyTrackRepositoryUpdate({
    rootDir,
    trackKey,
    originalTrackKey = null,
    trackName,
    destination = 'daily',
    track,
}) {
    const resolvedRoot = resolve(rootDir);
    const catalogPath = join(resolvedRoot, 'game/track/catalog.js');
    const tracksPath = join(resolvedRoot, 'game/track/tracks.js');
    const definitionsPath = join(resolvedRoot, 'game/track/definitions');
    const catalogSource = readFileSync(catalogPath, 'utf8');
    const update = buildTrackRepositoryUpdate({
        catalogSource,
        trackKey,
        originalTrackKey,
        trackName,
        destination,
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
    writeFileSync(definitionPath, generateTrackModuleSource(track), 'utf8');
    writeFileSync(catalogPath, update.catalogSource, 'utf8');
    writeFileSync(tracksPath, update.tracksSource, 'utf8');

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
    };
}

export function buildTrackRepositoryRemoval({
    catalogSource,
    trackKey,
    campaignSource,
    publishedHistorySource,
}) {
    assertTrackKey(trackKey);
    const { namesByKey, catalogKeys, scheduleKeys } = parseTrackCatalogSource(catalogSource);
    if (!Object.prototype.hasOwnProperty.call(namesByKey, trackKey)) {
        throw new Error(`Track ${trackKey} is not present in the catalog.`);
    }
    const defaultTrackKey = catalogSource.match(/export const DEFAULT_TRACK_KEY = '([^']+)';/)?.[1];
    if (!defaultTrackKey || typeof campaignSource !== 'string' || typeof publishedHistorySource !== 'string') {
        throw new Error('Track removal dependencies could not be checked.');
    }
    if (trackKey === defaultTrackKey) {
        throw new Error('Cannot remove the default track.');
    }
    if (campaignSource.includes(`'${trackKey}'`)) {
        throw new Error(`Cannot remove ${trackKey} because a Campaign stage uses it.`);
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
    const medalsPath = join(resolvedRoot, 'game/medals/medal-times.json');
    const campaignPath = join(resolvedRoot, 'game/campaign/manifest.js');
    const publishedHistoryPath = join(resolvedRoot, 'game/shared/daily-gp-history-backfill.js');
    const definitionsPath = join(resolvedRoot, 'game/track/definitions');
    const catalogSource = readFileSync(catalogPath, 'utf8');
    const tracksSource = readFileSync(tracksPath, 'utf8');
    const medalsSource = readFileSync(medalsPath, 'utf8');
    const update = buildTrackRepositoryRemoval({
        catalogSource,
        trackKey,
        campaignSource: readFileSync(campaignPath, 'utf8'),
        publishedHistorySource: readFileSync(publishedHistoryPath, 'utf8'),
    });
    assertSafeDefinitionFilename(update.filename);
    const definitionPath = resolve(definitionsPath, update.filename);
    assertPathInsideDirectory(definitionPath, definitionsPath, update.filename);
    if (!existsSync(definitionPath)) {
        throw new Error(`Cannot remove ${trackKey} because ${update.filename} does not exist.`);
    }

    const medalTimes = JSON.parse(medalsSource);
    if (!medalTimes || typeof medalTimes !== 'object' || Array.isArray(medalTimes)) {
        throw new Error('Track medal times are invalid.');
    }
    delete medalTimes[trackKey];

    try {
        writeFileSync(catalogPath, update.catalogSource, 'utf8');
        writeFileSync(tracksPath, update.tracksSource, 'utf8');
        writeFileSync(medalsPath, `${JSON.stringify(medalTimes, null, 2)}\n`, 'utf8');
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
