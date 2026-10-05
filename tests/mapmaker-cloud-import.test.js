import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudMapId, prepareCloudImport } from '../tools/mapmaker/cloud-maps.js';
import { loadDraftRecovery, saveDraftRecovery } from '../tools/mapmaker/edit-history.js';
import { mapmakerTrackAuthoringPlugin } from '../tools/mapmaker/vite-track-authoring-plugin.js';
import { TRACKS } from '../game/track/tracks.js';

afterEach(() => vi.unstubAllGlobals());

async function localCloudRequest(payload) {
    let handler;
    mapmakerTrackAuthoringPlugin({ url: 'https://miniracer.club', passcode: 'original-password' }).configureServer({
        middlewares: { use(callback) { handler = callback; } },
    });
    const request = new EventEmitter();
    request.url = '/__mapmaker/cloud-maps';
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173' };
    const response = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    const done = handler(request, response, () => { throw new Error('Unexpected next handler'); });
    request.emit('data', Buffer.from(JSON.stringify(payload)));
    request.emit('end');
    await done;
    return response;
}

describe('local Mapmaker cloud imports', () => {
    it('requests all workspaces using the server-held original password', async () => {
        const fetch = vi.fn().mockResolvedValue(Response.json({ maps: [] }));
        vi.stubGlobal('fetch', fetch);
        const result = await localCloudRequest({ method: 'GET' });
        expect(result.statusCode).toBe(200);
        const [url, options] = fetch.mock.calls[0];
        expect(url.href).toBe('https://miniracer.club/api/maps?scope=all');
        expect(options.headers['X-Mapmaker-Passcode']).toBe('original-password');
        expect(result.body).toEqual({ maps: [] });
    });

    it('deletes only the selected tester copy and supports older original-workspace drafts', async () => {
        const fetch = vi.fn().mockResolvedValue(Response.json({ deleted: 'sameName' }));
        vi.stubGlobal('fetch', fetch);
        expect((await localCloudRequest({ method: 'DELETE', key: 'creator2:sameName' })).statusCode).toBe(200);
        expect(fetch.mock.calls[0][0].href).toBe('https://miniracer.club/api/maps/sameName?scope=all&workspace=creator2');
        expect(fetch.mock.calls[0][1].method).toBe('DELETE');
        await localCloudRequest({ method: 'DELETE', key: 'sameName' });
        expect(fetch.mock.calls[1][0].searchParams.get('workspace')).toBe('legacy');
    });

    it('rejects malformed identities and cloud writes before forwarding', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        for (const payload of [
            { method: 'DELETE', key: 'creator1:sameName:extra' },
            { method: 'DELETE', key: '../creator1:sameName' },
            { method: 'DELETE', key: 'creator1:class' },
            { method: 'PUT', key: 'creator1:sameName' },
            { method: 'GET', key: 'creator1:sameName' },
            { method: 'GET', key: 'creator1:' },
        ]) expect((await localCloudRequest(payload)).statusCode).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps same-name imports distinct without replacing existing tracks or their geometry', () => {
        const geometry = structuredClone(Object.values(TRACKS)[0]);
        geometry.name = 'Same Name';
        const map = { trackKey: 'sameName', originalTrackKey: null, track: geometry, draftLoop: [], cloudId: 'creator1:sameName' };
        const tracks = { sameName: geometry, sameName2: geometry };
        const first = prepareCloudImport(map, tracks);
        expect(first.trackKey).toBe('sameName3');
        expect(first.track.name).toBe('Same Name 3');
        expect(cloudMapId(first)).toBe('creator1:sameName');
        expect(first.track).not.toBe(geometry);
        const second = prepareCloudImport({ ...map, cloudId: 'creator2:sameName' }, { ...tracks, [first.trackKey]: first.track });
        expect(second.trackKey).toBe('sameName4');
        expect(cloudMapId(second)).toBe('creator2:sameName');
        expect(geometry.name).toBe('Same Name');
    });

    it('preserves intended saved-track edits but imports a separate copy when that track is dirty', () => {
        const geometry = structuredClone(Object.values(TRACKS)[0]);
        const map = { trackKey: 'existing', originalTrackKey: 'existing', track: geometry, draftLoop: [] };
        expect(prepareCloudImport(map, { existing: geometry })).toMatchObject({ trackKey: 'existing', originalTrackKey: 'existing' });
        const draft = prepareCloudImport(map, { existing: geometry }, new Set(['existing']));
        expect(draft).toMatchObject({ trackKey: 'existing2', originalTrackKey: null, cloudId: 'existing' });
    });

    it('retains the exact tester source through browser recovery and rejects invalid source IDs', () => {
        const store = new Map();
        const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
        const draft = { trackKey: 'sameName2', originalTrackKey: null, track: structuredClone(Object.values(TRACKS)[0]), draftLoop: [], cloudKey: 'creator2:sameName' };
        expect(saveDraftRecovery(storage, { drafts: [draft] })).toBe(true);
        expect(loadDraftRecovery(storage).drafts[0].cloudKey).toBe('creator2:sameName');
        for (const cloudKey of ['creator2:sameName:extra', '../creator2:sameName', 'creator2:constructor']) {
            expect(saveDraftRecovery(storage, { drafts: [{ ...draft, cloudKey }] })).toBe(false);
        }
    });
});
