import { afterEach, describe, expect, it, vi } from 'vitest';

const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);

async function online() {
    vi.resetModules();
    vi.stubEnv('MODE', 'online');
    return import('../tools/mapmaker/cloud-maps.js');
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('online Mapmaker session and browser storage', () => {
    it('shows Street by default, then uses the authenticated workspace ground choices', async () => {
        const maps = await online();
        expect(maps.getCloudGroundKeys()).toEqual(['tarmac']);
        const fetch = vi.fn().mockResolvedValue(Response.json({ ownerId: alice, groundKeys: ['tarmac', 'dirt', 'snow', 'grip', 'water', 'space'] }));
        vi.stubGlobal('fetch', fetch);
        await maps.loadCloudSession();
        expect(maps.getCloudGroundKeys()).toEqual(['tarmac', 'dirt', 'snow', 'grip', 'water', 'space']);
        fetch.mockResolvedValue(Response.json({ ownerId: bob, groundKeys: ['tarmac'] }));
        await maps.loadCloudSession();
        expect(maps.getCloudGroundKeys()).toEqual(['tarmac']);
        fetch.mockResolvedValue(Response.json({ ownerId: bob, groundKeys: ['unknown'] }));
        await maps.loadCloudSession();
        expect(maps.getCloudGroundKeys()).toEqual(['tarmac']);
    });
    it('waits for identity and isolates every browser key from shared and other-owner data', async () => {
        const maps = await online();
        expect(() => maps.cloudStorageKey('draft')).toThrow(/loading/);
        const fetch = vi.fn().mockResolvedValue(Response.json({ ownerId: alice }));
        vi.stubGlobal('fetch', fetch);
        await maps.loadCloudSession();
        const aliceKey = maps.cloudStorageKey('draft');
        expect(aliceKey).toBe(`draft:workspace:${alice}`);
        fetch.mockResolvedValue(Response.json({ ownerId: bob }));
        await maps.loadCloudSession();
        expect(maps.cloudStorageKey('draft')).not.toBe(aliceKey);
        expect(maps.cloudStorageKey('draft')).not.toBe('draft');
    });

    it('pins list/save/delete to the loaded owner even after another tab switches cookies', async () => {
        const maps = await online();
        const fetch = vi.fn().mockResolvedValue(Response.json({ ownerId: alice }));
        vi.stubGlobal('fetch', fetch);
        await maps.loadCloudSession();
        fetch.mockImplementation(async () => Response.json({ error: 'Password changed.' }, { status: 409 }));
        await expect(maps.saveCloudMap({ trackKey: 'myMap' })).rejects.toThrow('Password changed.');
        await expect(maps.deleteCloudMap('myMap')).rejects.toThrow('Password changed.');
        await expect(maps.listCloudMaps()).rejects.toThrow('Password changed.');
        for (const [url, options] of fetch.mock.calls.slice(1)) {
            expect(url).toMatch(/^\/api\/maps/);
            expect(options.headers['X-Mapmaker-Owner']).toBe(alice);
            expect(options.cache).toBe('no-store');
        }
        fetch.mockResolvedValue(Response.json({ ownerId: bob }));
        await expect(maps.verifyCloudSession()).rejects.toThrow(/changed/);
        expect(maps.cloudStorageKey('draft')).toBe(`draft:workspace:${alice}`);
    });

    it('keeps the editor locked on missing or invalid identity and supports logout', async () => {
        const maps = await online();
        const fetch = vi.fn().mockResolvedValue(Response.json({ ownerId: 'other' }));
        vi.stubGlobal('fetch', fetch);
        await expect(maps.loadCloudSession()).rejects.toThrow(/locked/);
        await expect(maps.listCloudMaps()).rejects.toThrow(/loading/);
        fetch.mockResolvedValue(new Response(null, { status: 204 }));
        await maps.closeCloudSession();
        expect(fetch).toHaveBeenLastCalledWith('/api/session', { method: 'DELETE' });
    });

    it('keeps local repository browser storage and cloud-import API unchanged', async () => {
        vi.resetModules();
        vi.stubEnv('MODE', 'test');
        const maps = await import('../tools/mapmaker/cloud-maps.js');
        expect(maps.cloudStorageKey('draft')).toBe('draft');
        expect(maps.getCloudGroundKeys()).toHaveLength(6);
        const fetch = vi.fn().mockResolvedValue(Response.json({ maps: [] }));
        vi.stubGlobal('fetch', fetch);
        await expect(maps.listCloudMaps()).resolves.toEqual([]);
        expect(fetch.mock.calls[0][0]).toBe('/__mapmaker/cloud-maps');
    });
});
