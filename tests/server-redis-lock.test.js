import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@devvit/redis', () => ({ redis: {} }));

const {
    acquireRedisLock,
    releaseRedisLock,
    renewRedisLock,
    startRedisLockLeaseRenewal,
} = await import('../src/server/redis-lock.ts');

function createVersionedRedis() {
    const values = new Map();
    const expirations = new Map();
    const versions = new Map();
    let beforeExec = null;
    let execCalls = 0;
    let blockedExec = null;

    const bump = (key) => versions.set(key, (versions.get(key) || 0) + 1);
    const client = {
        values,
        expirations,
        get execCalls() { return execCalls; },
        setBeforeExec(callback) { beforeExec = callback; },
        blockNextExec(promise) { blockedExec = promise; },
        touch(key) { bump(key); },
        async get(key) { return values.get(key) ?? null; },
        async set(key, value, options = {}) {
            if (options.nx && values.has(key)) return '';
            values.set(key, value);
            if (options.expiration) expirations.set(key, options.expiration.getTime());
            bump(key);
            return 'OK';
        },
        async del(key) {
            values.delete(key);
            expirations.delete(key);
            bump(key);
            return 1;
        },
        async expire(key, seconds) {
            expirations.set(key, Date.now() + seconds * 1000);
            bump(key);
            return 1;
        },
        async watch(key) {
            const watchedVersion = versions.get(key) || 0;
            const commands = [];
            return {
                async multi() {},
                async unwatch() {},
                async del(...args) { commands.push(() => client.del(...args)); },
                async expire(...args) { commands.push(() => client.expire(...args)); },
                async exec() {
                    execCalls += 1;
                    if (blockedExec) {
                        const pending = blockedExec;
                        blockedExec = null;
                        await pending;
                    }
                    if (beforeExec) beforeExec(execCalls, key);
                    if ((versions.get(key) || 0) !== watchedVersion) return [];
                    const results = [];
                    for (const command of commands) results.push(await command());
                    return results;
                },
            };
        },
    };
    return client;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('owned Redis locks', () => {
    it('acquires a lock with NX and returns null when the key already exists', async () => {
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 30_000, client);
        expect(lock).toMatchObject({ key: 'lock', ttlMs: 30_000 });
        expect(lock.value).toEqual(expect.any(String));
        expect(await client.get('lock')).toBe(lock.value);

        const raced = await acquireRedisLock('lock', 30_000, client);
        expect(raced).toBeNull();
    });

    it('releases null locks without touching Redis', async () => {
        const client = createVersionedRedis();
        await expect(releaseRedisLock(null, client)).resolves.toBe(false);
        expect(client.execCalls).toBe(0);
    });

    it('renews an owned lock and extends its expiration', async () => {
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 2_500, client);
        const before = client.expirations.get('lock');

        await expect(renewRedisLock(lock, client)).resolves.toBe(true);
        expect(client.expirations.get('lock')).toBeGreaterThan(before);
        expect(await client.get('lock')).toBe(lock.value);
    });

    it('never releases or renews a successor lock', async () => {
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 30_000, client);
        const successorExpiration = Date.now() + 90_000;
        await client.set('lock', 'successor', { expiration: new Date(successorExpiration) });

        await expect(releaseRedisLock(lock, client)).resolves.toBe(false);
        await expect(renewRedisLock(lock, client)).resolves.toBe(false);
        expect(await client.get('lock')).toBe('successor');
        expect(client.expirations.get('lock')).toBe(successorExpiration);
    });

    it('aborts when ownership changes after observation and before EXEC', async () => {
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 30_000, client);
        client.setBeforeExec((call) => {
            if (call === 1) void client.set('lock', 'successor');
        });

        await expect(releaseRedisLock(lock, client)).resolves.toBe(false);
        expect(await client.get('lock')).toBe('successor');
    });

    it('retries conflicts only while the same owner remains', async () => {
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 30_000, client);
        client.setBeforeExec((call, key) => {
            if (call === 1) client.touch(key);
        });

        await expect(releaseRedisLock(lock, client)).resolves.toBe(true);
        expect(client.execCalls).toBe(2);
        expect(await client.get('lock')).toBeNull();
    });

    it('leaves TTL recovery intact after the bounded conflict retries', async () => {
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 30_000, client);
        client.setBeforeExec((_call, key) => client.touch(key));

        await expect(releaseRedisLock(lock, client)).resolves.toBe(false);
        expect(client.execCalls).toBe(3);
        expect(await client.get('lock')).toBe(lock.value);
    });

    it('serializes heartbeat renewal and waits for it during stop', async () => {
        vi.useFakeTimers();
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 30_000, client);
        let finishRenewal;
        client.blockNextExec(new Promise((resolve) => { finishRenewal = resolve; }));
        const lease = startRedisLockLeaseRenewal(lock, 10_000, client);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(client.execCalls).toBe(1);
        let stopped = false;
        const stopping = lease.stop().then(() => { stopped = true; });
        await Promise.resolve();
        expect(stopped).toBe(false);
        finishRenewal();
        await stopping;
        expect(stopped).toBe(true);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(client.execCalls).toBe(1);
    });

    it('marks the lease unowned when renewal fails and confirmOwnership observes the loss', async () => {
        vi.useFakeTimers();
        const client = createVersionedRedis();
        const lock = await acquireRedisLock('lock', 30_000, client);
        const lease = startRedisLockLeaseRenewal(lock, 1_000, client);

        await client.set('lock', 'successor');
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();

        expect(lease.isOwned()).toBe(false);
        await expect(lease.confirmOwnership()).resolves.toBe(false);
        await lease.stop();
    });
});
