// Creator requests; the server checks the moderator on every route.

export class CreatorRequestError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export async function creatorRequest(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
        method,
        headers: body === undefined
            ? { Accept: 'application/json' }
            : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new CreatorRequestError(result.error || `Request failed (${response.status}).`, response.status);
    }
    return result;
}

export const creatorApi = {
    listTracks: () => creatorRequest('/api/creator/tracks?full=1'),
    readTrack: (trackKey, username) => creatorRequest(`/api/creator/tracks/${encodeURIComponent(trackKey)}`
        + (username ? `?creatorUsername=${encodeURIComponent(username)}` : '')),
    saveTrack: (trackKey, body) => creatorRequest(`/api/creator/tracks/${encodeURIComponent(trackKey)}`, {
        method: 'PUT',
        body,
    }),
    deleteTrack: (trackKey, baseRevision, username) => creatorRequest(
        `/api/creator/tracks/${encodeURIComponent(trackKey)}?baseRevision=${encodeURIComponent(baseRevision)}`
            + (username ? `&creatorUsername=${encodeURIComponent(username)}` : ''),
        { method: 'DELETE' },
    ),
    readDaily: () => creatorRequest('/api/creator/daily'),
    saveDaily: (keys, baseRevision) => creatorRequest('/api/creator/daily', {
        method: 'PUT',
        body: { keys, baseRevision },
    }),
    readSeries: () => creatorRequest('/api/creator/series'),
    saveSeries: (seriesId, body) => creatorRequest(`/api/creator/series/${encodeURIComponent(seriesId)}`, {
        method: 'PUT',
        body,
    }),
    publishSeries: (seriesId, baseRevision) => creatorRequest(
        `/api/creator/series/${encodeURIComponent(seriesId)}/publish`,
        { method: 'POST', body: { baseRevision } },
    ),
    deleteSeries: (seriesId, baseRevision) => creatorRequest(
        `/api/creator/series/${encodeURIComponent(seriesId)}?baseRevision=${encodeURIComponent(baseRevision)}`,
        { method: 'DELETE' },
    ),
    readMigration: () => creatorRequest('/api/creator/migration'),
    runMigration: () => creatorRequest('/api/creator/migration', { method: 'POST' }),
    runPlayedDailyCopy: () => creatorRequest('/api/creator/migration/played-dailies', { method: 'POST' }),
    runLiveCampaignCopy: () => creatorRequest('/api/creator/migration/live-campaign', { method: 'POST' }),
    runCopyCheck: () => creatorRequest('/api/creator/migration/check', { method: 'POST' }),
    runCopyUndo: (kind) => creatorRequest(`/api/creator/migration/undo/${encodeURIComponent(kind)}`, { method: 'POST' }),
};
