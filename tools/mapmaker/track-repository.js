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

function assertTrackKey(trackKey, label = 'Track key') {
    if (!isValidTrackKey(trackKey)) {
        throw new Error(`${label} must be a valid non-reserved JavaScript identifier.`);
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

    const catalogKeys = Object.keys(namesByKey);
    if (JSON.stringify(catalogKeys) !== JSON.stringify(scheduleKeys)) {
        throw new Error('Track catalog entries and schedule order are out of sync.');
    }

    return { namesByKey, scheduleKeys };
}

function generateCatalogBlock(scheduleKeys, namesByKey) {
    return [
        'export const TRACK_CATALOG = {',
        ...scheduleKeys.map((trackKey) => (
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

export function generateTracksRegistrySource(scheduleKeys) {
    return [
        ...scheduleKeys.map((trackKey) => (
            `import ${trackKey} from './definitions/${getTrackModuleFilename(trackKey)}';`
        )),
        "import { TRACK_CATALOG, getTrackName } from './catalog.js';",
        '',
        'const TRACK_GEOMETRY = {',
        ...scheduleKeys.map((trackKey) => `    ${trackKey},`),
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

export function buildTrackRepositoryUpdate({
    catalogSource,
    trackKey,
    originalTrackKey = null,
    trackName,
}) {
    assertTrackKey(trackKey);
    if (originalTrackKey !== null) {
        assertTrackKey(originalTrackKey, 'Original track key');
    }
    const normalizedName = String(trackName || '').trim();
    if (!normalizedName) {
        throw new Error('Track name cannot be empty.');
    }

    const { namesByKey, scheduleKeys } = parseTrackCatalogSource(catalogSource);
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
    let scheduleIndex = scheduleKeys.indexOf(trackKey);
    let removedFilename = null;

    if (isRename) {
        action = 'renamed';
        scheduleIndex = scheduleKeys.indexOf(originalTrackKey);
        scheduleKeys[scheduleIndex] = trackKey;
        delete namesByKey[originalTrackKey];
        removedFilename = getTrackModuleFilename(originalTrackKey);
    } else if (!targetExists) {
        action = 'created';
        scheduleKeys.push(trackKey);
        scheduleIndex = scheduleKeys.length - 1;
    }

    namesByKey[trackKey] = normalizedName;
    const orderedNamesByKey = Object.fromEntries(
        scheduleKeys.map((key) => [key, namesByKey[key]]),
    );
    const nextCatalogSource = catalogSource
        .replace(CATALOG_BLOCK_RE, generateCatalogBlock(scheduleKeys, orderedNamesByKey))
        .replace(SCHEDULE_BLOCK_RE, generateScheduleBlock(scheduleKeys));

    return {
        action,
        scheduleIndex,
        scheduleLength: scheduleKeys.length,
        filename: getTrackModuleFilename(trackKey),
        removedFilename,
        catalogSource: nextCatalogSource,
        tracksSource: generateTracksRegistrySource(scheduleKeys),
    };
}

export function applyTrackRepositoryUpdate({
    rootDir,
    trackKey,
    originalTrackKey = null,
    trackName,
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
    });
    const definitionPath = join(definitionsPath, update.filename);
    const isExistingTarget = originalTrackKey === trackKey;

    if (!isExistingTarget && existsSync(definitionPath)) {
        throw new Error(`${update.filename} already exists but is not integrated in the selected track.`);
    }
    if (update.removedFilename) {
        const oldDefinitionPath = join(definitionsPath, update.removedFilename);
        if (!existsSync(oldDefinitionPath)) {
            throw new Error(`Cannot rename because ${update.removedFilename} does not exist.`);
        }
    }

    mkdirSync(definitionsPath, { recursive: true });
    writeFileSync(definitionPath, generateTrackModuleSource(track), 'utf8');
    writeFileSync(catalogPath, update.catalogSource, 'utf8');
    writeFileSync(tracksPath, update.tracksSource, 'utf8');

    if (update.removedFilename) {
        rmSync(join(definitionsPath, update.removedFilename));
    }

    return {
        action: update.action,
        filename: update.filename,
        removedFilename: update.removedFilename,
        scheduleIndex: update.scheduleIndex,
        scheduleLength: update.scheduleLength,
    };
}
