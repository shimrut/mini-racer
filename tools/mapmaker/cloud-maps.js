// The online Mapmaker at miniracer.club/mapmaker is built with the 'online' mode
// (tools/build-site.js). It saves maps to the cloud instead of the repository.
export const MAPMAKER_ONLINE = import.meta.env?.MODE === 'online';

// Online, the page calls the cloud maps API itself; the unlock cookie lets it
// in. The local Mapmaker asks its Vite server, which adds the passcode from
// .env.local (tools/mapmaker/vite-track-authoring-plugin.js).
async function requestCloudMaps(method, key = '', body = undefined) {
    const response = MAPMAKER_ONLINE
        ? await fetch(`/api/maps${key ? `/${key}` : ''}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        })
        : await fetch('/__mapmaker/cloud-maps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ method, key }),
        });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || `Cloud maps failed with status ${response.status}.`);
    }
    return result;
}

// Newest first. Each map: { trackKey, originalTrackKey, track, draftLoop, medalRow, updatedAt }.
export async function listCloudMaps() {
    return (await requestCloudMaps('GET')).maps ?? [];
}

// Online only.
export function saveCloudMap(map) {
    return requestCloudMaps('PUT', map.trackKey, map);
}

export function deleteCloudMap(key) {
    return requestCloudMaps('DELETE', key);
}
