import { describe, expect, it } from 'vitest';
import {
    MAX_FAILURES,
    PASSCODE_HEADER,
    OWNER_HEADER,
    LEGACY_OWNER,
    SESSION_COOKIE,
    checkPasscode,
    createSession,
    isGatedPath,
    isValidSession,
    readCookie,
    readWorkspaces,
    safeEqual,
} from '../site/lib/gate.js';
import { listMaps, normalizeCloudMap, readMapBody, saveMap } from '../site/lib/maps.js';
import { onRequest } from '../site/functions/_middleware.js';
import { onRequestGet } from '../site/functions/api/maps/index.js';
import { onRequestPut, onRequestDelete } from '../site/functions/api/maps/[key].js';
import { TRACKS } from '../game/track/tracks.js';
import { TRACK_GROUND_KEYS } from '../game/track/grounds.js';

const PASSCODE = '482913';
const ORIGIN = 'https://miniracer.club';

function createKv(pageSize = Infinity) {
    const store = new Map();
    const listRequests = [];
    return {
        store,
        listRequests,
        async get(key, type) {
            if (!store.has(key)) return null;
            return type === 'json' ? JSON.parse(store.get(key)) : store.get(key);
        },
        async put(key, value) { store.set(key, value); },
        async delete(key) { store.delete(key); },
        async list({ prefix, cursor }) {
            listRequests.push({ prefix, cursor });
            const names = [...store.keys()].filter((name) => name.startsWith(prefix)).sort();
            const start = Number(cursor ?? 0);
            const end = Math.min(start + pageSize, names.length);
            return {
                keys: names.slice(start, end).map((name) => ({ name })),
                list_complete: end >= names.length,
                cursor: end >= names.length ? '' : String(end),
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

function runApi(req, env) {
    const context = {
        request: req,
        env,
        data: {},
        params: { key: decodeURIComponent(new URL(req.url).pathname.split('/').pop()) },
        async next() {
            if (new URL(req.url).pathname === '/api/maps' && req.method === 'GET') return onRequestGet(context);
            if (req.method === 'PUT') return onRequestPut(context);
            if (req.method === 'DELETE') return onRequestDelete(context);
            return new Response('asset');
        },
    };
    return onRequest(context);
}

async function login(env, passcode) {
    const form = new FormData();
    form.set('passcode', passcode);
    const response = await run(request('/mapmaker/unlock', { method: 'POST', body: form }), env);
    expect(response.status).toBe(303);
    return response.headers.get('Set-Cookie').split(';')[0];
}

async function putMap(env, cookie, key, body = {}) {
    return runApi(request(`/api/maps/${key}`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ track: sampleTrack(), ...body }),
    }), env);
}

async function mapsFor(env, cookie) {
    const response = await runApi(request('/api/maps', { headers: { Cookie: cookie } }), env);
    expect(response.status).toBe(200);
    return (await response.json()).maps;
}

async function legacyToken(passcode, expires) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(passcode), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`mapmaker-session:${expires}`)));
    return `${expires}.${btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
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
        const [version, owner, expires, signature] = token.split('.');
        expect(await isValidSession(`${version}.${owner}.${Number(expires) + 1}.${signature}`, PASSCODE, now)).toBe(false);
        expect(await isValidSession(`${token}.extra`, PASSCODE, now)).toBe(false);
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
        expect(page.headers.get('Cache-Control')).toBe('private, no-store');
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
        await saveMap(kv, 'firstName', { track }, LEGACY_OWNER);
        await saveMap(kv, 'other', { track }, LEGACY_OWNER);
        await saveMap(kv, 'secondName', { track, replaceKey: 'firstName' }, LEGACY_OWNER);
        const maps = await listMaps(kv, LEGACY_OWNER);
        expect(maps.map((map) => map.trackKey).sort()).toEqual(['other', 'secondName']);
        expect(maps[0].updatedAt >= maps[1].updatedAt).toBe(true);
    });
});

describe('cloud map password workspaces through middleware and routes', () => {
    function sharedEnv() {
        return { ...createEnv(), MAPMAKER_PASSCODES: JSON.stringify({ alice: 'alice-password', bob: 'bob-password' }) };
    }

    it('offers every ground only to the original password workspace', async () => {
        const env = sharedEnv();
        const legacy = await login(env, PASSCODE);
        const alice = await login(env, 'alice-password');
        const admin = await run(request('/api/session', { headers: { Cookie: legacy } }), env);
        expect((await admin.json()).groundKeys).toEqual(TRACK_GROUND_KEYS);
        const issued = await run(request('/api/session?owner=legacy', { headers: { Cookie: alice } }), env);
        expect((await issued.json()).groundKeys).toEqual(['tarmac']);
        const importSession = await run(request('/api/session', { headers: { Cookie: legacy, [PASSCODE_HEADER]: 'bob-password' } }), env);
        expect((await importSession.json()).groundKeys).toEqual(['tarmac']);
    });

    it('isolates identical track keys and preserves the legacy list only for its original password', async () => {
        const env = sharedEnv();
        await saveMap(env.MAPMAKER_KV, 'existing', { track: sampleTrack() }, LEGACY_OWNER);
        const alice = await login(env, 'alice-password');
        const bob = await login(env, 'bob-password');
        const legacy = await login(env, PASSCODE);
        expect((await putMap(env, alice, 'sameName', { track: { ...sampleTrack(), name: 'Alice map' } })).status).toBe(200);
        expect((await putMap(env, bob, 'sameName', { track: { ...sampleTrack(), name: 'Bob map' } })).status).toBe(200);
        expect((await mapsFor(env, alice)).map((map) => map.track.name)).toEqual(['Alice map']);
        expect((await mapsFor(env, bob)).map((map) => map.track.name)).toEqual(['Bob map']);
        expect((await mapsFor(env, legacy)).map((map) => map.trackKey)).toEqual(['existing']);
    });

    it('lists every saved workspace for the original local-import password, including revoked workspaces', async () => {
        const env = { ...sharedEnv(), MAPMAKER_KV: createKv(1) };
        await saveMap(env.MAPMAKER_KV, 'sameName', { track: { ...sampleTrack(), name: 'Original map' } }, LEGACY_OWNER);
        await saveMap(env.MAPMAKER_KV, 'sameName', { track: { ...sampleTrack(), name: 'Alice map' } }, 'alice');
        await saveMap(env.MAPMAKER_KV, 'second', { track: sampleTrack() }, 'alice');
        await saveMap(env.MAPMAKER_KV, 'sameName', { track: { ...sampleTrack(), name: 'Bob map' } }, 'bob');
        env.MAPMAKER_PASSCODES = JSON.stringify({ alice: 'alice-password' });
        const response = await runApi(request('/api/maps?scope=all', { headers: { [PASSCODE_HEADER]: PASSCODE } }), env);
        expect(response.status).toBe(200);
        const maps = (await response.json()).maps;
        expect(maps.map((map) => map.cloudId).sort()).toEqual(['alice:sameName', 'alice:second', 'bob:sameName', 'legacy:sameName']);
        expect(maps.filter((map) => map.trackKey === 'sameName').map((map) => map.track.name).sort()).toEqual(['Alice map', 'Bob map', 'Original map']);
        expect(maps.map((map) => map.workspaceId).sort()).toEqual(['alice', 'alice', 'bob', 'legacy']);
        expect(maps.every((map, index) => index === 0 || maps[index - 1].updatedAt >= map.updatedAt)).toBe(true);
        expect(env.MAPMAKER_KV.listRequests).toEqual([
            { prefix: 'map:', cursor: undefined },
            { prefix: 'workspace-map:', cursor: undefined },
            { prefix: 'workspace-map:', cursor: '1' },
            { prefix: 'workspace-map:', cursor: '2' },
        ]);
        expect((await mapsFor(env, await login(env, PASSCODE))).map((map) => map.track.name)).toEqual(['Original map']);
    });

    it('derives import identities from valid storage keys rather than stored identity fields', async () => {
        const env = sharedEnv();
        const map = normalizeCloudMap('differentStoredKey', { track: sampleTrack() });
        await env.MAPMAKER_KV.put('workspace-map:alice:realKey', JSON.stringify({ ...map, workspaceId: 'bob', cloudId: 'bob:victim' }));
        for (const key of ['map:bad-key', 'workspace-map:alice:bad-key', 'workspace-map:bad/id:goodKey', 'workspace-map:alice:extra:goodKey', 'workspace-map:legacy:goodKey']) {
            await env.MAPMAKER_KV.put(key, JSON.stringify(map));
        }
        const response = await runApi(request('/api/maps?scope=all', { headers: { [PASSCODE_HEADER]: PASSCODE } }), env);
        expect((await response.json()).maps).toEqual([{ ...map, trackKey: 'realKey', workspaceId: 'alice', cloudId: 'alice:realKey' }]);
    });

    it('does not give website cookies or issued passwords an all-workspace import view', async () => {
        const env = sharedEnv();
        const legacy = await login(env, PASSCODE);
        const alice = await login(env, 'alice-password');
        await putMap(env, alice, 'privateMap');
        for (const headers of [
            { Cookie: legacy },
            { Cookie: alice },
            { [PASSCODE_HEADER]: 'alice-password' },
            { Cookie: legacy, [PASSCODE_HEADER]: 'alice-password' },
        ]) {
            for (const [path, method] of [['/api/maps?scope=all', 'GET'], ['/api/maps/privateMap?scope=all&workspace=alice', 'DELETE']]) {
                expect((await runApi(request(path, { method, headers }), env)).status).toBe(403);
            }
        }
        expect((await mapsFor(env, alice)).map((map) => map.trackKey)).toEqual(['privateMap']);
    });

    it('deletes only the selected workspace copy during a local import', async () => {
        const env = sharedEnv();
        for (const owner of [LEGACY_OWNER, 'alice', 'bob']) {
            await saveMap(env.MAPMAKER_KV, 'sameName', { track: sampleTrack() }, owner);
        }
        env.MAPMAKER_PASSCODES = JSON.stringify({ alice: 'alice-password' });
        const headers = { [PASSCODE_HEADER]: PASSCODE };
        const response = await runApi(request('/api/maps/sameName?scope=all&workspace=bob', { method: 'DELETE', headers }), env);
        expect(response.status).toBe(200);
        expect(env.MAPMAKER_KV.store.has('workspace-map:bob:sameName')).toBe(false);
        expect(env.MAPMAKER_KV.store.has('workspace-map:alice:sameName')).toBe(true);
        expect(env.MAPMAKER_KV.store.has('map:sameName')).toBe(true);
        const legacy = await runApi(request('/api/maps/sameName?scope=all&workspace=legacy', { method: 'DELETE', headers }), env);
        expect(legacy.status).toBe(200);
        expect(env.MAPMAKER_KV.store.has('map:sameName')).toBe(false);
        expect(env.MAPMAKER_KV.store.has('workspace-map:alice:sameName')).toBe(true);
    });

    it('rejects invalid import deletions and prevents all-workspace writes', async () => {
        const env = sharedEnv();
        await saveMap(env.MAPMAKER_KV, 'goodKey', { track: sampleTrack() }, 'alice');
        const headers = { [PASSCODE_HEADER]: PASSCODE };
        for (const path of [
            '/api/maps/goodKey?scope=all',
            '/api/maps/goodKey?scope=all&workspace=alice%3Abob',
            '/api/maps/goodKey?scope=all&workspace=alice%2Fbob',
            '/api/maps/bad-key?scope=all&workspace=alice',
        ]) {
            expect((await runApi(request(path, { method: 'DELETE', headers }), env)).status).toBe(400);
        }
        const put = await runApi(request('/api/maps/goodKey?scope=all&workspace=alice', {
            method: 'PUT', headers, body: JSON.stringify({ track: sampleTrack() }),
        }), env);
        expect(put.status).toBe(405);
        expect(env.MAPMAKER_KV.store.size).toBe(1);
    });

    it('scopes rename, replaceKey and deletion to the authenticated workspace', async () => {
        const env = sharedEnv();
        const alice = await login(env, 'alice-password');
        const bob = await login(env, 'bob-password');
        await putMap(env, alice, 'sameName');
        await putMap(env, bob, 'sameName');
        const renamed = await putMap(env, alice, 'renamed', { replaceKey: 'sameName', ownerId: 'bob' });
        expect(renamed.status).toBe(200);
        expect((await mapsFor(env, alice)).map((map) => map.trackKey)).toEqual(['renamed']);
        expect((await mapsFor(env, bob)).map((map) => map.trackKey)).toEqual(['sameName']);
        const removed = await runApi(request('/api/maps/sameName?owner=bob', { method: 'DELETE', headers: { Cookie: alice } }), env);
        expect(removed.status).toBe(200);
        expect((await mapsFor(env, bob)).map((map) => map.trackKey)).toEqual(['sameName']);
        await runApi(request('/api/maps/renamed', { method: 'DELETE', headers: { Cookie: alice } }), env);
        expect(await mapsFor(env, alice)).toEqual([]);
    });

    it('does not accept a caller-supplied workspace in a body, URL or escaped replacement key', async () => {
        const env = sharedEnv();
        const alice = await login(env, 'alice-password');
        const bob = await login(env, 'bob-password');
        await putMap(env, bob, 'victim');
        await putMap(env, alice, 'ownMap', { owner: 'bob', replaceKey: 'workspace-map:bob:victim' });
        await runApi(request('/api/maps/workspace-map%3Abob%3Avictim?ownerId=bob', { method: 'DELETE', headers: { Cookie: alice } }), env);
        const list = await runApi(request('/api/maps?owner=bob', { headers: { Cookie: alice, 'X-Owner': 'bob' } }), env);
        expect((await list.json()).maps.map((map) => map.trackKey)).toEqual(['ownMap']);
        expect((await mapsFor(env, bob)).map((map) => map.trackKey)).toEqual(['victim']);
    });

    it('uses an explicit import password before a cookie and rejects a wrong explicit password', async () => {
        const env = sharedEnv();
        const alice = await login(env, 'alice-password');
        const bob = await login(env, 'bob-password');
        await putMap(env, bob, 'bobMap');
        const response = await runApi(request('/api/maps', { headers: { Cookie: alice, [PASSCODE_HEADER]: 'bob-password' } }), env);
        expect((await response.json()).maps.map((map) => map.trackKey)).toEqual(['bobMap']);
        const wrong = await runApi(request('/api/maps', { headers: { Cookie: alice, [PASSCODE_HEADER]: 'wrong' } }), env);
        expect(wrong.status).toBe(401);
    });

    it('keeps sessions bound to their signed owner, including tampered and legacy cookies', async () => {
        const env = sharedEnv();
        const alice = await login(env, 'alice-password');
        const tampered = alice.replace('v2.alice.', 'v2.bob.');
        expect((await runApi(request('/api/maps', { headers: { Cookie: tampered } }), env)).status).toBe(401);
        const token = await legacyToken(PASSCODE, Date.now() + 60_000);
        const oldCookie = `${SESSION_COOKIE}=${token}`;
        await saveMap(env.MAPMAKER_KV, 'oldMap', { track: sampleTrack() }, LEGACY_OWNER);
        expect((await mapsFor(env, oldCookie)).map((map) => map.trackKey)).toEqual(['oldMap']);
        const namedOnly = { ...env, MAPMAKER_PASSCODE: undefined, MAPMAKER_PASSCODES: JSON.stringify({ alice: PASSCODE }) };
        expect((await runApi(request('/api/maps', { headers: { Cookie: oldCookie } }), namedOnly)).status).toBe(401);
        expect(await mapsFor(namedOnly, await login(namedOnly, PASSCODE))).toEqual([]);
    });

    it('preserves workspace maps across password rotation and invalidates rotated or revoked sessions', async () => {
        const env = sharedEnv();
        const alice = await login(env, 'alice-password');
        await putMap(env, alice, 'aliceMap');
        const before = await run(request('/api/session', { headers: { Cookie: alice } }), env);
        const originalOwner = (await before.json()).ownerId;
        env.MAPMAKER_PASSCODES = JSON.stringify({ alice: 'new-alice-password', bob: 'bob-password' });
        expect((await runApi(request('/api/maps', { headers: { Cookie: alice } }), env)).status).toBe(401);
        const newCookie = await login(env, 'new-alice-password');
        expect((await mapsFor(env, newCookie)).map((map) => map.trackKey)).toEqual(['aliceMap']);
        const after = await run(request('/api/session', { headers: { Cookie: newCookie } }), env);
        expect((await after.json()).ownerId).toBe(originalOwner);
        env.MAPMAKER_PASSCODES = JSON.stringify({ bob: 'bob-password' });
        expect((await runApi(request('/api/maps', { headers: { Cookie: newCookie } }), env)).status).toBe(401);
    });

    it('fences an old tab after another password changes the shared browser cookie', async () => {
        const env = sharedEnv();
        const alice = await login(env, 'alice-password');
        const bob = await login(env, 'bob-password');
        const session = await run(request('/api/session', { headers: { Cookie: alice } }), env);
        const ownerId = (await session.json()).ownerId;
        expect(ownerId).toMatch(/^[a-f0-9]{64}$/);
        for (const method of ['GET', 'PUT', 'DELETE']) {
            const response = await runApi(request(method === 'GET' ? '/api/maps' : '/api/maps/mapFromOldTab', {
                method,
                headers: { Cookie: bob, [OWNER_HEADER]: ownerId },
                ...(method === 'PUT' ? { body: JSON.stringify({ track: sampleTrack() }) } : {}),
            }), env);
            expect(response.status).toBe(409);
        }
        expect(await mapsFor(env, bob)).toEqual([]);
        expect((await putMap(env, alice, 'correctSession')).status).toBe(200);
        const matching = await runApi(request('/api/maps', { headers: { Cookie: alice, [OWNER_HEADER]: ownerId } }), env);
        expect(matching.status).toBe(200);
    });

    it('clears a browser session when switching passwords', async () => {
        const response = await run(request('/api/session', { method: 'DELETE' }), sharedEnv());
        expect(response.status).toBe(204);
        expect(response.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE}=;`);
        expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
        expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    });

    it('requires authenticated middleware context even when handlers are called directly', async () => {
        const env = sharedEnv();
        expect((await onRequestGet({ env })).status).toBe(401);
        expect((await onRequestDelete({ env, params: { key: 'any' } })).status).toBe(401);
        expect((await onRequestPut({ env, params: { key: 'any' }, request: request('/api/maps/any', { method: 'PUT', body: JSON.stringify({ track: sampleTrack() }) }) })).status).toBe(401);
        expect(env.MAPMAKER_KV.store.size).toBe(0);
    });

    it('keeps every pagination request inside its workspace prefix', async () => {
        const env = { ...sharedEnv(), MAPMAKER_KV: createKv(1) };
        const alice = await login(env, 'alice-password');
        const bob = await login(env, 'bob-password');
        await putMap(env, alice, 'first');
        await putMap(env, alice, 'second');
        await putMap(env, alice, 'third');
        await putMap(env, bob, 'foreign');
        expect((await mapsFor(env, alice)).map((map) => map.trackKey).sort()).toEqual(['first', 'second', 'third']);
        expect(env.MAPMAKER_KV.listRequests).toEqual([
            { prefix: 'workspace-map:alice:', cursor: undefined },
            { prefix: 'workspace-map:alice:', cursor: '1' },
            { prefix: 'workspace-map:alice:', cursor: '2' },
        ]);
    });

    it.each([
        '{',
        '[]',
        'null',
        '{"alice":42}',
        '{"alice":""}',
        '{"bad:id":"a"}',
        '{"legacy":"a"}',
        '{"alice":"a","alice":"b"}',
        '{"alice":"a","\\u0061lice":"b"}',
        '{"alice":"same","bob":"same"}',
        `{"alice":"${PASSCODE}"}`,
    ])('fails closed for malformed or ambiguous password configuration %s', async (config) => {
        const env = { ...createEnv(), MAPMAKER_PASSCODES: config };
        expect(() => readWorkspaces(env)).toThrow();
        const response = await run(request('/api/maps', { headers: { [PASSCODE_HEADER]: PASSCODE } }), env);
        expect(response.status).toBe(503);
        expect(env.MAPMAKER_KV.store.size).toBe(0);
    });

    it('accepts string passwords containing JSON punctuation without mistaking it for a second workspace', () => {
        const complex = 'a", "bob": "b';
        const env = { ...createEnv(), MAPMAKER_PASSCODES: JSON.stringify({ alice: complex }) };
        expect(readWorkspaces(env).get('alice')).toBe(complex);
    });
});
