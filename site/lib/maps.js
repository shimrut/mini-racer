import { isValidDraft } from '../../tools/mapmaker/edit-history.js';
import { normalizeMedalRow } from '../../tools/mapmaker/medal-times.js';
import { isValidTrackKey } from '../../tools/mapmaker/track-source.js';
import { LEGACY_OWNER, isWorkspaceId } from './gate.js';

// Cloud maps: Mapmaker drafts saved online, one KV entry for each track key.
const MAP_PREFIX = 'map:';
export const MAX_MAP_BYTES = 2 * 1024 * 1024;

export class MapError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

function mapPrefix(ownerId) {
    if (!isWorkspaceId(ownerId)) throw new MapError('The Mapmaker is locked. Reload and enter your password.', 401);
    return ownerId === LEGACY_OWNER ? MAP_PREFIX : `workspace-map:${ownerId}:`;
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
export async function listMaps(kv, ownerId) {
    const prefix = mapPrefix(ownerId);
    const maps = [];
    let cursor;
    do {
        const page = await kv.list({ prefix, cursor });
        const values = await Promise.all(page.keys.map((key) => kv.get(key.name, 'json')));
        maps.push(...values.filter(Boolean));
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return maps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Local imports include revoked workspaces too. Identity comes from the KV key,
// never fields supplied when a map was saved.
export async function listAllMaps(kv) {
    const maps = [];
    for (const prefix of [MAP_PREFIX, 'workspace-map:']) {
        let cursor;
        do {
            const page = await kv.list({ prefix, cursor });
            await Promise.all(page.keys.map(async ({ name }) => {
                const parts = prefix === MAP_PREFIX
                    ? [LEGACY_OWNER, name.slice(MAP_PREFIX.length)]
                    : name.slice(prefix.length).split(':');
                const [workspaceId, trackKey] = parts;
                if (parts.length !== 2 || !isWorkspaceId(workspaceId) || !isValidTrackKey(trackKey)
                    || (prefix !== MAP_PREFIX && workspaceId === LEGACY_OWNER)) return;
                const map = await kv.get(name, 'json');
                if (map) maps.push({ ...map, trackKey, workspaceId, cloudId: `${workspaceId}:${trackKey}` });
            }));
            cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
    }
    return maps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// replaceKey is the map's earlier key, when the track was renamed since.
export async function saveMap(kv, trackKey, body, ownerId) {
    const prefix = mapPrefix(ownerId);
    const map = normalizeCloudMap(trackKey, body);
    await kv.put(prefix + trackKey, JSON.stringify(map));
    if (typeof body.replaceKey === 'string' && body.replaceKey !== trackKey) {
        await kv.delete(prefix + body.replaceKey);
    }
    return map;
}

export function deleteMap(kv, trackKey, ownerId) {
    if (!isValidTrackKey(trackKey)) throw new MapError('The cloud map key is not valid.');
    return kv.delete(mapPrefix(ownerId) + trackKey);
}
