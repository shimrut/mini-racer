import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { context, redis } from '@devvit/web/server';

// Playtest only: logs each Redis transport failure with the calls and requests in flight at that moment.

// Playtest uploads add a fourth number to the version (2.5.3.286); a published version has three.
const PLAYTEST_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
// gRPC UNAVAILABLE: the stream was refused, the connection was reset, or no connection was made.
const GRPC_UNAVAILABLE = 14;
const HOUR_MS = 60 * 60 * 1000;
const LISTED_CALLS = 20;

type Call = { name: string; route: string | null; startedAt: number; callsAtSend: number };

type HourStats = {
    startedAt: number;
    requests: number;
    calls: number;
    peakCalls: number;
    peakRequests: number;
    failures: number;
};

export function isPlaytestVersion(version: unknown): boolean {
    return typeof version === 'string' && PLAYTEST_VERSION.test(version);
}

function readAppVersion(): unknown {
    try {
        return context.appVersion;
    } catch (_error) {
        return null;
    }
}

function isTransportFailure(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === GRPC_UNAVAILABLE;
}

function newHour(startedAt: number): HourStats {
    return { startedAt, requests: 0, calls: 0, peakCalls: 0, peakRequests: 0, failures: 0 };
}

export function createPlaytestRedisTrace({
    client = redis,
    readVersion = readAppVersion,
    now = Date.now,
    warn = console.warn,
    log = console.log,
}: {
    client?: object;
    readVersion?: () => unknown;
    now?: () => number;
    warn?: (message: string) => void;
    log?: (message: string) => void;
} = {}) {
    const processId = randomUUID().slice(0, 8);
    const processStartedAt = now();
    const routes = new AsyncLocalStorage<string>();
    const calls = new Set<Call>();
    const requests = new Map<number, { route: string; startedAt: number }>();
    let installed = false;
    let nextRequestId = 0;
    let served = 0;
    let hour = newHour(processStartedAt);

    function processLabel(time: number) {
        return { id: processId, ageS: Math.round((time - processStartedAt) / 1000), served };
    }

    function report(call: Call, error: unknown): void {
        const time = now();
        hour.failures += 1;
        warn(`Playtest Redis failure: ${JSON.stringify({
            call: call.name,
            route: call.route,
            error: String((error as { message?: unknown } | null)?.message ?? error).split('\n')[0],
            waitedMs: time - call.startedAt,
            callsAtSend: call.callsAtSend,
            callsNow: calls.size,
            otherCalls: [...calls].filter((other) => other !== call).slice(0, LISTED_CALLS)
                .map((other) => `${other.name} ${time - other.startedAt}ms`),
            requests: [...requests.values()].map((request) => `${request.route} ${time - request.startedAt}ms`),
            process: processLabel(time),
            hour: { calls: hour.calls, peakCalls: hour.peakCalls, peakRequests: hour.peakRequests },
        })}`);
    }

    function track(name: string, run: () => unknown): unknown {
        const result = run();
        if (!(result instanceof Promise)) return result;
        const call: Call = { name, route: routes.getStore() ?? null, startedAt: now(), callsAtSend: calls.size + 1 };
        calls.add(call);
        hour.calls += 1;
        hour.peakCalls = Math.max(hour.peakCalls, calls.size);
        return result.then((value) => {
            calls.delete(call);
            return value;
        }, (error) => {
            if (isTransportFailure(error)) report(call, error);
            calls.delete(call);
            throw error;
        });
    }

    // Replaces each method on this object with a counted copy; a client's transaction is counted too.
    function wrap(target: object, prefix: string): void {
        const prototype = Object.getPrototypeOf(target);
        if (!prototype || prototype === Object.prototype) return;
        for (const name of Object.getOwnPropertyNames(prototype)) {
            const original = Object.getOwnPropertyDescriptor(prototype, name)?.value;
            if (name === 'constructor' || typeof original !== 'function') continue;
            Object.defineProperty(target, name, {
                configurable: true,
                writable: true,
                value: (...args: unknown[]) => track(`${prefix}${name}`, () => {
                    const result = original.apply(target, args);
                    if (prefix || name !== 'watch' || !(result instanceof Promise)) return result;
                    return result.then((transaction: object) => {
                        wrap(transaction, 'tx.');
                        return transaction;
                    });
                }),
            });
        }
    }

    return function playtestRedisTrace(req: Request, res: Response, next: NextFunction): void {
        if (!isPlaytestVersion(readVersion())) {
            next();
            return;
        }
        if (!installed) {
            installed = true;
            wrap(client, '');
        }
        const time = now();
        if (time - hour.startedAt >= HOUR_MS) {
            log(`Playtest Redis hour: ${JSON.stringify({
                process: processLabel(time),
                requests: hour.requests,
                calls: hour.calls,
                peakCalls: hour.peakCalls,
                peakRequests: hour.peakRequests,
                failures: hour.failures,
            })}`);
            hour = newHour(time);
        }
        const id = nextRequestId;
        nextRequestId += 1;
        const route = `${req.method} ${req.path}`;
        requests.set(id, { route, startedAt: time });
        served += 1;
        hour.requests += 1;
        hour.peakRequests = Math.max(hour.peakRequests, requests.size);
        res.on('close', () => requests.delete(id));
        routes.run(route, next);
    };
}
