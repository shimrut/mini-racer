const REQUEST_TIMEOUT_MS = 20_000;
let localFixture = null;

async function getJson(path) {
    const response = await fetch(path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Community maps unavailable (${response.status}).`);
    return response.json();
}

export async function getCommunityMaps(cursor = null) {
    if (localFixture) {
        const offset = cursor ? Number(cursor) || 0 : 0;
        const maps = localFixture.slice(offset, offset + 10)
            .map(({ id, name, authorName, publishedAt }) => ({ id, name, authorName, publishedAt }));
        return { maps, nextCursor: offset + 10 < localFixture.length ? String(offset + 10) : null };
    }
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return getJson(`/api/community/maps${query}`);
}

export async function getCommunityMap(id) {
    if (localFixture) {
        const map = localFixture.find((item) => item.id === id);
        if (!map) throw new Error('Community map unavailable.');
        return { map };
    }
    return getJson(`/api/community/maps/${encodeURIComponent(id)}`);
}

// Used only through local debug hooks, which are absent on Reddit hosts.
export function setCommunityMapsFixtureForLocalDebug(maps) {
    if (typeof window === 'undefined'
        || !['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)) return;
    localFixture = Array.isArray(maps) ? maps : null;
}
