import { vi } from 'vitest';

// One shared test Redis; WATCH sees strings and hashes, and queued writes apply only after the ownership check.
export function installTrackRedisTransactions(redis, strings, hashes) {
    const observe = (key) => JSON.stringify([strings.get(key), [...(hashes.get(key) ?? new Map())]]);
    redis.watch = vi.fn(async (...keys) => {
        const watched = new Map(keys.map((key) => [key, observe(key)]));
        const commands = [];
        const transaction = {
            commands,
            multi: vi.fn(async () => {}),
            unwatch: vi.fn(async () => {}),
            discard: vi.fn(async () => {}),
            exec: vi.fn(async () => {
                if ([...watched].some(([key, before]) => observe(key) !== before)) return [];
                const results = [];
                for (const [method, args] of commands) results.push(await redis[method](...args));
                return results;
            }),
        };
        for (const method of ['set', 'del', 'hSet', 'hSetNX', 'hDel', 'incrBy', 'expire']) {
            transaction[method] = vi.fn(async (...args) => { commands.push([method, args]); });
        }
        return transaction;
    });
}
