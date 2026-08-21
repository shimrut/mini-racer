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
    BIOME_NAMES,
    isBiomeName,
    pickBiomeForTrackKey,
} from '../../game/track/biomes.js';

const CATALOG_BLOCK_RE = /export const TRACK_CATALOG = \{\n[\s\S]*?\n\};/;
const CATALOG_ENTRY_RE = /^\s{4}([A-Za-z_$][A-Za-z0-9_$]*): \{ name: ("(?:[^"\\]|\\.)*")(?:, biome: ("(?:[^"\\]|\\.)*"))? \},$/gm;
const CATALOG_ENTRY_LINE_RE = /^\s{4}[A-Za-z_$][A-Za-z0-9_$]*: \{/gm;
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

function assertBiome(biome) {
    if (biome === 'random') {
        throw new Error('Biome must be a settled biome, not random. Resolve it before saving.');
    }
    if (!isBiomeName(biome)) {
        throw new Error(`Biome must be one of: ${BIOME_NAMES.join(', ')}.`);
    }
}

export function parseTrackCatalogSource(source) {
    const catalogMatch = source.match(CATALOG_BLOCK_RE);
    const scheduleMatch = source.match(SCHEDULE_BLOCK_RE);
    if (!catalogMatch || !scheduleMatch) {
        throw new Error('Track catalog source does not contain the expected catalog and schedule blocks.');
    }

    const namesByKey = {};
    const biomesByKey = {};
    for (const match of catalogMatch[0].matchAll(CATALOG_ENTRY_RE)) {
        const [, trackKey, rawName, rawBiome] = match;
        const name = JSON.parse(rawName);
        if (typeof name !== 'string' || !name.trim()) {
            throw new Error(`Catalog track ${trackKey} needs a non-empty name.`);
        }
        if (Object.prototype.hasOwnProperty.call(namesByKey, trackKey)) {
            throw new Error(`Catalog track ${trackKey} is duplicated.`);
        }
        namesByKey[trackKey] = name;
        if (rawBiome !== undefined) {
            const biome = JSON.parse(rawBiome);
            assertBiome(biome);
            biomesByKey[trackKey] = biome;
        }
    }

    // Every catalog line must parse. An entry this file cannot read would drop out
    // of catalogKeys, and the next save would rewrite catalog.js and tracks.js
    // without that track, deleting it from the game with no error.
    const entryLineCount = [...catalogMatch[0].matchAll(CATALOG_ENTRY_LINE_RE)].length;
    if (entryLineCount !== Object.keys(namesByKey).length) {
        throw new Error(
            `Track catalog has ${entryLineCount} entries but only `
            + `${Object.keys(namesByKey).length} could be read. Fix the malformed entry `
            + 'before saving, or the track it names will be dropped.'
        );
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
        biomesByKey,
        catalogKeys: Object.keys(namesByKey),
        scheduleKeys,
    };
}

function generateCatalogBlock(catalogKeys, namesByKey, biomesByKey = {}) {
    return [
        'export const TRACK_CATALOG = {',
        ...catalogKeys.map((trackKey) => {
            const biome = biomesByKey[trackKey];
            const biomeSource = biome ? `, biome: ${JSON.stringify(biome)}` : '';
            return `    ${trackKey}: { name: ${JSON.stringify(namesByKey[trackKey])}${biomeSource} },`;
        }),
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
    biome = null,
}) {
    assertTrackKey(trackKey);
    assertDestination(destination);
    // A null biome means "keep whatever the catalog already holds". Treating it as
    // a reset would let any half-landed caller quietly wipe settled biomes.
    if (biome !== null) {
        assertBiome(biome);
    }
    if (originalTrackKey !== null) {
        assertTrackKey(originalTrackKey, 'Original track key');
    }
    const normalizedName = String(trackName || '').trim();
    if (!normalizedName) {
        throw new Error('Track name cannot be empty.');
    }

    const {
        namesByKey,
        biomesByKey,
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
        if (Object.prototype.hasOwnProperty.call(biomesByKey, originalTrackKey)) {
            biomesByKey[trackKey] = biomesByKey[originalTrackKey];
            delete biomesByKey[originalTrackKey];
        }
        removedFilename = getTrackModuleFilename(originalTrackKey);
    } else if (!targetExists) {
        action = 'created';
        nextCatalogKeys.push(trackKey);
    }

    namesByKey[trackKey] = normalizedName;
    if (biome !== null) {
        biomesByKey[trackKey] = biome;
    }
    applyScheduleDestination(nextScheduleKeys, trackKey, destination);

    const orderedNamesByKey = Object.fromEntries(
        nextCatalogKeys.map((key) => [key, namesByKey[key]]),
    );
    const nextCatalogSource = catalogSource
        .replace(
            CATALOG_BLOCK_RE,
            generateCatalogBlock(nextCatalogKeys, orderedNamesByKey, biomesByKey),
        )
        .replace(SCHEDULE_BLOCK_RE, generateScheduleBlock(nextScheduleKeys));

    return {
        action,
        destination,
        biome: biomesByKey[trackKey] ?? null,
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
    biome = null,
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
        biome,
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
        biome: update.biome,
        filename: definitionFilename,
        removedFilename: update.removedFilename,
        scheduleIndex: update.scheduleIndex,
        scheduleLength: update.scheduleLength,
    };
}

/**
 * Settles a biome on every catalog entry that has none, without touching entries
 * that already do. Pure and idempotent: run it again after a batch of new tracks
 * lands and only the new ones move.
 */
export function buildCatalogBiomeBackfill({ catalogSource, pinned = {} }) {
    const {
        namesByKey,
        biomesByKey,
        catalogKeys,
        scheduleKeys,
    } = parseTrackCatalogSource(catalogSource);

    const assignments = [];
    for (const trackKey of catalogKeys) {
        if (Object.prototype.hasOwnProperty.call(biomesByKey, trackKey)) continue;
        const biome = pinned[trackKey] ?? pickBiomeForTrackKey(trackKey);
        assertBiome(biome);
        biomesByKey[trackKey] = biome;
        assignments.push({ trackKey, biome, pinned: trackKey in pinned });
    }

    const nextCatalogSource = catalogSource
        .replace(
            CATALOG_BLOCK_RE,
            generateCatalogBlock(catalogKeys, namesByKey, biomesByKey),
        )
        .replace(SCHEDULE_BLOCK_RE, generateScheduleBlock(scheduleKeys));

    return { catalogSource: nextCatalogSource, assignments };
}
