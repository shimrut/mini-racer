import { describe, expect, it, vi } from 'vitest';
import { createPlaytestRedisTrace, isPlaytestVersion } from '../src/server/redis/playtest-redis-trace.ts';

function refusal() {
    return Object.assign(new Error('14 UNAVAILABLE: Stream refused by server\n    at callErrorFromStatus'), {
        code: 14,
        details: 'Stream refused by server',
    });
}

class FakeTransaction {
    async multi() {}
    async exec() {
        throw refusal();
    }
}

class FakeClient {
    constructor() {
        this.pending = [];
    }
    get(key) {
        return new Promise((resolve) => this.pending.push(() => resolve(`value:${key}`)));
    }
    async hGet() {
        throw refusal();
    }
    async set() {
        throw Object.assign(new Error('2 UNKNOWN: redis: transaction failed'), { code: 2 });
    }
    async watch() {
        return new FakeTransaction();
    }
}

function fakeResponse() {
    const listeners = {};
    return {
        on: (event, listener) => {
            listeners[event] = listener;
        },
        close: () => listeners.close?.(),
    };
}

function setup({ version = '2.5.3.286' } = {}) {
    const client = new FakeClient();
    let time = 1_000_000;
    const warn = vi.fn();
    const log = vi.fn();
    const trace = createPlaytestRedisTrace({
        client,
        readVersion: () => version,
        now: () => time,
        warn,
        log,
    });
    const request = (path, run) => {
        const res = fakeResponse();
        let result;
        trace({ method: 'POST', path }, res, () => {
            result = run();
        });
        return { res, result };
    };
    return { client, warn, log, request, advance: (ms) => { time += ms; } };
}

function loggedFailure(warn) {
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message.startsWith('Playtest Redis failure: ')).toBe(true);
    return JSON.parse(message.slice('Playtest Redis failure: '.length));
}

describe('playtest Redis trace', () => {
    it('knows a playtest upload by its fourth version number', () => {
        expect(isPlaytestVersion('2.5.3.286')).toBe(true);
        expect(isPlaytestVersion('2.5.3')).toBe(false);
        expect(isPlaytestVersion(undefined)).toBe(false);
    });

    it('leaves the client untouched on a published version', async () => {
        const { client, warn, request } = setup({ version: '2.5.3' });
        let next = false;
        request('/internal/scheduler/raced-list-fill', () => {
            next = true;
        });
        expect(next).toBe(true);
        expect(Object.hasOwn(client, 'hGet')).toBe(false);
        await expect(client.hGet('key', 'field')).rejects.toMatchObject({ code: 14 });
        expect(warn).not.toHaveBeenCalled();
    });

    it('logs a refused call with the calls and requests in flight, then rethrows it', async () => {
        const { client, warn, request, advance } = setup();
        request('/internal/scheduler/ghost-compaction', () => client.get('state'));
        advance(40);
        const { result } = request('/internal/scheduler/raced-list-fill', () => client.hGet('ready', 'field'));
        const error = await result.catch((caught) => caught);
        expect(error).toMatchObject({ code: 14, details: 'Stream refused by server' });

        const logged = loggedFailure(warn);
        expect(logged).toMatchObject({
            call: 'hGet',
            route: 'POST /internal/scheduler/raced-list-fill',
            error: '14 UNAVAILABLE: Stream refused by server',
            waitedMs: 0,
            callsAtSend: 2,
            callsNow: 2,
            otherCalls: ['get 40ms'],
            requests: ['POST /internal/scheduler/ghost-compaction 40ms', 'POST /internal/scheduler/raced-list-fill 0ms'],
            process: { ageS: 0, served: 2 },
            hour: { calls: 2, peakCalls: 2, peakRequests: 2 },
        });
        client.pending.forEach((resolve) => resolve());
    });

    it('does not log other Redis errors', async () => {
        const { client, warn, request } = setup();
        const { result } = request('/api/run', () => client.set('key', 'value'));
        await expect(result).rejects.toMatchObject({ code: 2 });
        expect(warn).not.toHaveBeenCalled();
    });

    it('counts the calls of a transaction', async () => {
        const { client, warn, request } = setup();
        const { result } = request('/api/run', async () => {
            const transaction = await client.watch('key');
            await transaction.multi();
            return transaction.exec();
        });
        await expect(result).rejects.toMatchObject({ code: 14 });
        expect(loggedFailure(warn)).toMatchObject({ call: 'tx.exec', route: 'POST /api/run', callsAtSend: 1 });
    });

    it('drops a request from the list when its response closes', async () => {
        const { client, warn, request } = setup();
        const first = request('/internal/scheduler/daily-ghost-archive', () => {});
        first.res.close();
        const { result } = request('/internal/scheduler/raced-list-fill', () => client.hGet('ready', 'field'));
        await expect(result).rejects.toMatchObject({ code: 14 });
        expect(loggedFailure(warn).requests).toEqual(['POST /internal/scheduler/raced-list-fill 0ms']);
    });

    it('writes one summary line per hour', async () => {
        const { client, log, request, advance } = setup();
        const { result } = request('/internal/scheduler/raced-list-fill', () => client.hGet('ready', 'field'));
        await expect(result).rejects.toMatchObject({ code: 14 });
        advance(30 * 60 * 1000);
        request('/internal/scheduler/raced-list-fill', () => {});
        expect(log).not.toHaveBeenCalled();
        advance(30 * 60 * 1000);
        request('/internal/scheduler/raced-list-fill', () => {});
        expect(log).toHaveBeenCalledTimes(1);
        const [message] = log.mock.calls[0];
        expect(JSON.parse(message.slice('Playtest Redis hour: '.length))).toMatchObject({
            process: { ageS: 3600, served: 2 },
            requests: 2,
            calls: 1,
            peakCalls: 1,
            peakRequests: 2,
            failures: 1,
        });
    });
});
