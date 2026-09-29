import { isValidDraft } from '../../tools/mapmaker/edit-history.js';
import { normalizeMedalRow } from '../../tools/mapmaker/medal-times.js';

// Cloud maps: Mapmaker drafts saved online, one KV entry for each track key.
const MAP_PREFIX = 'map:';
export const MAX_MAP_BYTES = 2 * 1024 * 1024;

export class MapError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// A cloud map is a draft with its medal times and the time it was saved.
// Medal times that are not all set are dropped.
export function normalizeCloudMap(trackKey, body, now = new Date()) {
    const draft = {
        trackKey,
        originalTrackKey: body?.originalTrackKey ?? null,
        track: body?.track,
        draftLoop: body?.draftLoop ?? [],
    };
    if (!isValidDraft(draft)) throw new MapError('This map cannot be saved: its data is not valid.');
    return { ...draft, medalRow: normalizeMedalRow(body.medalRow), updatedAt: now.toISOString() };
}

export async function readMapBody(request) {
    if (Number(request.headers.get('Content-Length')) > MAX_MAP_BYTES) {
        throw new MapError('This map is too large to save.', 413);
    }
    const text = await request.text();
    if (text.length > MAX_MAP_BYTES) throw new MapError('This map is too large to save.', 413);
    try {
        return JSON.parse(text);
    } catch {
        throw new MapError('This map cannot be saved: its data is not valid.');
    }
}

// Newest first.
export async function listMaps(kv) {
    const maps = [];
    let cursor;
    do {
        const page = await kv.list({ prefix: MAP_PREFIX, cursor });
        const values = await Promise.all(page.keys.map((key) => kv.get(key.name, 'json')));
        maps.push(...values.filter(Boolean));
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return maps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// replaceKey is the map's earlier key, when the track was renamed since.
export async function saveMap(kv, trackKey, body) {
    const map = normalizeCloudMap(trackKey, body);
    await kv.put(MAP_PREFIX + trackKey, JSON.stringify(map));
    if (typeof body.replaceKey === 'string' && body.replaceKey !== trackKey) {
        await kv.delete(MAP_PREFIX + body.replaceKey);
    }
    return map;
}

export function deleteMap(kv, trackKey) {
    return kv.delete(MAP_PREFIX + trackKey);
}
