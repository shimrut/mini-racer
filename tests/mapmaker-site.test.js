import { describe, expect, it } from 'vitest';
import {
    MAX_FAILURES,
    PASSCODE_HEADER,
    SESSION_COOKIE,
    checkPasscode,
    createSession,
    isGatedPath,
    isValidSession,
    readCookie,
    safeEqual,
} from '../site/lib/gate.js';
import { listMaps, normalizeCloudMap, readMapBody, saveMap } from '../site/lib/maps.js';
import { onRequest } from '../site/functions/_middleware.js';
import { TRACKS } from '../game/track/tracks.js';

const PASSCODE = '482913';
const ORIGIN = 'https://miniracer.club';

function createKv() {
    const store = new Map();
    return {
        store,
        async get(key, type) {
            if (!store.has(key)) return null;
            return type === 'json' ? JSON.parse(store.get(key)) : store.get(key);
        },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
        async list({ prefix }) {
            return {
                keys: [...store.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
                list_complete: true,
            };
        },
    };
}

function createEnv() {
    return { MAPMAKER_PASSCODE: PASSCODE, MAPMAKER_KV: createKv() };
}

function request(path, init = {}) {
    return new Request(`${ORIGIN}${path}`, init);
}

function run(req, env) {
    return onRequest({ request: req, env, next: async () => new Response('asset') });
}

function sampleTrack() {
    return structuredClone(Object.values(TRACKS)[0]);
}

describe('mapmaker passcode gate', () => {
    it('guards only the Mapmaker and its API', () => {
        expect(isGatedPath('/mapmaker')).toBe(true);
        expect(isGatedPath('/mapmaker/assets/app.js')).toBe(true);
        expect(isGatedPath('/api/maps')).toBe(true);
        expect(isGatedPath('/')).toBe(false);
        expect(isGatedPath('/mapmakers')).toBe(false);
        expect(isGatedPath('/about.html')).toBe(false);
    });

    it('compares passcodes exactly', () => {
        expect(safeEqual(PASSCODE, PASSCODE)).toBe(true);
        expect(safeEqual('48291', PASSCODE)).toBe(false);
        expect(safeEqual('4829130', PASSCODE)).toBe(false);
        expect(safeEqual('', PASSCODE)).toBe(false);
    });

    it('accepts a session until it ends, and only for the same passcode', async () => {
        const now = Date.UTC(2026, 8, 29);
        const token = await createSession(PASSCODE, now);
        expect(await isValidSession(token, PASSCODE, now + 1000)).toBe(true);
        expect(await isValidSession(token, 'other-code', now + 1000)).toBe(false);
        expect(await isValidSession(token, PASSCODE, now + 31 * 24 * 60 * 60 * 1000)).toBe(false);
        const [expires, signature] = token.split('.');
        expect(await isValidSession(`${Number(expires) + 1}.${signature}`, PASSCODE, now)).toBe(false);
        expect(await isValidSession(null, PASSCODE, now)).toBe(false);
    });

    it('reads one cookie from the Cookie header', () => {
        const req = request('/mapmaker/', { headers: { Cookie: `a=1; ${SESSION_COOKIE}=x.y=; b=2` } });
        expect(readCookie(req, SESSION_COOKIE)).toBe('x.y=');
        expect(readCookie(request('/'), SESSION_COOKIE)).toBeNull();
    });

    it('locks an address out after too many wrong passcodes', async () => {
        const env = createEnv();
        const req = request('/mapmaker/unlock', { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
        for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
            expect(await checkPasscode('000000', env, req)).toBe('wrong');
        }
        expect(await checkPasscode(PASSCODE, env, req)).toBe('locked');
        const otherAddress = request('/mapmaker/unlock', { headers: { 'CF-Connecting-IP': '198.51.100.4' } });
        expect(await checkPasscode(PASSCODE, env, otherAddress)).toBe('ok');
    });
});

describe('mapmaker site middleware', () => {
    it('leaves the promo page alone', async () => {
        const response = await run(request('/about.html'), createEnv());
        expect(await response.text()).toBe('asset');
    });

    it('stays closed when no passcode is set', async () => {
        const response = await run(request('/mapmaker/'), { MAPMAKER_KV: createKv() });
        expect(response.status).toBe(503);
    });

    it('shows the unlock page instead of the Mapmaker', async () => {
        const response = await run(request('/mapmaker/'), createEnv());
        expect(response.status).toBe(401);
        expect(await response.text()).toContain('name="passcode"');
    });

    it('answers the API with an error while locked', async () => {
        const response = await run(request('/api/maps'), createEnv());
        expect(response.status).toBe(401);
        expect((await response.json()).error).toMatch(/locked/i);
    });

    it('unlocks with the right passcode and then serves the Mapmaker', async () => {
        const env = createEnv();
        const form = new FormData();
        form.set('passcode', '111111');
        const wrong = await run(request('/mapmaker/unlock', { method: 'POST', body: form }), env);
        expect(wrong.status).toBe(401);
        expect(wrong.headers.get('Set-Cookie')).toBeNull();

        form.set('passcode', PASSCODE);
        const unlocked = await run(request('/mapmaker/unlock', { method: 'POST', body: form }), env);
        expect(unlocked.status).toBe(303);
        expect(unlocked.headers.get('Location')).toBe('/mapmaker/');
        const cookie = unlocked.headers.get('Set-Cookie');
        expect(cookie).toMatch(/HttpOnly/);
        expect(cookie).toMatch(/Secure/);

        const page = await run(request('/mapmaker/', { headers: { Cookie: cookie.split(';')[0] } }), env);
        expect(await page.text()).toBe('asset');
        expect(page.headers.get('Cache-Control')).toBe('private, no-cache');
    });

    it('lets the local Mapmaker in with the passcode header', async () => {
        const env = createEnv();
        const ok = await run(request('/api/maps', { headers: { [PASSCODE_HEADER]: PASSCODE } }), env);
        expect(await ok.text()).toBe('asset');
        const wrong = await run(request('/api/maps', { headers: { [PASSCODE_HEADER]: 'nope' } }), env);
        expect(wrong.status).toBe(401);
    });
});

describe('cloud maps', () => {
    it('keeps a valid draft with its medal times', () => {
        const track = sampleTrack();
        const now = new Date('2026-09-29T10:00:00Z');
        const map = normalizeCloudMap('myTrack', {
            originalTrackKey: null,
            track,
            draftLoop: [],
            medalRow: { author: 20, gold: 20.5, silver: 21.1, bronze: 21.8 },
        }, now);
        expect(map).toEqual({
            trackKey: 'myTrack',
            originalTrackKey: null,
            track,
            draftLoop: [],
            medalRow: { author: 20, gold: 20.5, silver: 21.1, bronze: 21.8 },
            updatedAt: '2026-09-29T10:00:00.000Z',
        });
        expect(normalizeCloudMap('myTrack', { track, medalRow: { author: 20 } }).medalRow).toBeNull();
    });

    it('refuses a map that is not a valid draft', () => {
        expect(() => normalizeCloudMap('bad key', { track: sampleTrack() })).toThrow(/not valid/);
        expect(() => normalizeCloudMap('myTrack', { track: { name: 'x' } })).toThrow(/not valid/);
        expect(() => normalizeCloudMap('myTrack', null)).toThrow(/not valid/);
    });

    it('refuses a body that is too large', async () => {
        const req = request('/api/maps/x', { method: 'PUT', headers: { 'Content-Length': String(3 * 1024 * 1024) }, body: '{}' });
        await expect(readMapBody(req)).rejects.toMatchObject({ status: 413 });
    });

    it('moves a renamed map to its new key and lists the newest first', async () => {
        const kv = createKv();
        const track = sampleTrack();
        await saveMap(kv, 'firstName', { track });
        await saveMap(kv, 'other', { track });
        await saveMap(kv, 'secondName', { track, replaceKey: 'firstName' });
        const maps = await listMaps(kv);
        expect(maps.map((map) => map.trackKey).sort()).toEqual(['other', 'secondName']);
        expect(maps[0].updatedAt >= maps[1].updatedAt).toBe(true);
    });
});
