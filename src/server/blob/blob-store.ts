import { newS3Client } from '@devvit/blob';
import {
    DeleteObjectCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    type S3Client,
} from '@aws-sdk/client-s3';

// Reddit's blob storage: one private S3 namespace for each install. The
// Devvit client puts the install's prefix in front of every key, and takes it
// off the keys a listing returns.

export type BlobObjectInfo = {
    key: string;
    size: number;
    lastModifiedMs: number;
};

export type BlobListPage = {
    objects: BlobObjectInfo[];
    // The token for the next page, or null after the last page.
    nextToken: string | null;
};

export type BlobStore = {
    put(key: string, body: Uint8Array, signal: AbortSignal): Promise<void>;
    // Null when the object does not exist.
    get(key: string, signal: AbortSignal): Promise<Uint8Array | null>;
    list(prefix: string, token: string | null, maxKeys: number, signal: AbortSignal): Promise<BlobListPage>;
    delete(key: string, signal: AbortSignal): Promise<void>;
};

// S3 refused a saved continuation token. The listing must start again.
export class BlobListTokenRejectedError extends Error {
    constructor() {
        super('Blob storage refused the listing token.');
        this.name = 'BlobListTokenRejectedError';
    }
}

// A call did not end inside its time limit. It was aborted.
export class BlobCallTimeoutError extends Error {
    constructor() {
        super('Blob storage call timed out.');
        this.name = 'BlobCallTimeoutError';
    }
}

// A call could not end before the request deadline, so it did not start.
export class BlobDeadlineError extends Error {
    constructor() {
        super('No time is left for a blob storage call.');
        this.name = 'BlobDeadlineError';
    }
}

function httpStatus(error: unknown): number | null {
    const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
    return typeof status === 'number' ? status : null;
}

function errorName(error: unknown): string {
    const name = (error as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : '';
}

// The store for one server request. The Devvit client must not be kept from
// one request to the next, so the client is made on first use.
export function createDevvitBlobStore(makeClient: () => Promise<S3Client> = newS3Client): BlobStore {
    let client: Promise<S3Client> | null = null;
    const s3 = () => {
        client ??= makeClient();
        return client;
    };
    return {
        async put(key, body, signal) {
            await (await s3()).send(new PutObjectCommand({
                Bucket: '',
                Key: key,
                Body: body,
                ContentType: 'application/gzip',
            }), { abortSignal: signal });
        },
        async get(key, signal) {
            try {
                const response = await (await s3()).send(
                    new GetObjectCommand({ Bucket: '', Key: key }),
                    { abortSignal: signal },
                );
                if (!response.Body) return new Uint8Array();
                return await response.Body.transformToByteArray();
            } catch (error) {
                if (errorName(error) === 'NoSuchKey' || httpStatus(error) === 404) return null;
                throw error;
            }
        },
        async list(prefix, token, maxKeys, signal) {
            try {
                const response = await (await s3()).send(new ListObjectsV2Command({
                    Bucket: '',
                    Prefix: prefix,
                    MaxKeys: maxKeys,
                    ...(token ? { ContinuationToken: token } : {}),
                }), { abortSignal: signal });
                return {
                    objects: (response.Contents ?? [])
                        .filter((entry) => typeof entry.Key === 'string')
                        .map((entry) => ({
                            key: entry.Key as string,
                            size: Number(entry.Size ?? 0),
                            lastModifiedMs: entry.LastModified ? entry.LastModified.getTime() : 0,
                        })),
                    nextToken: response.IsTruncated && response.NextContinuationToken
                        ? response.NextContinuationToken
                        : null,
                };
            } catch (error) {
                if (token && (errorName(error) === 'InvalidArgument' || httpStatus(error) === 400)) {
                    throw new BlobListTokenRejectedError();
                }
                throw error;
            }
        },
        async delete(key, signal) {
            await (await s3()).send(
                new DeleteObjectCommand({ Bucket: '', Key: key }),
                { abortSignal: signal },
            );
        },
    };
}

export type BlobClock = {
    now(): number;
    sleep(ms: number): Promise<void>;
};

export const SYSTEM_BLOB_CLOCK: BlobClock = {
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

// Every call of one request goes through a session. A session keeps calls
// under a rate, aborts a call that runs too long, and starts no call that
// could end after the request deadline.
export type BlobSession = {
    readonly callTimeoutMs: number;
    readonly deadlineMs: number;
    now(): number;
    // True while a call that starts now ends before the deadline.
    hasTimeFor(calls: number): boolean;
    put(key: string, body: Uint8Array): Promise<void>;
    get(key: string): Promise<Uint8Array | null>;
    list(prefix: string, token: string | null, maxKeys: number): Promise<BlobListPage>;
    delete(key: string): Promise<void>;
};

export function createBlobSession({
    store,
    deadlineMs,
    callTimeoutMs = 4_000,
    maxCallsPerSecond = 40,
    clock = SYSTEM_BLOB_CLOCK,
}: {
    store: BlobStore;
    deadlineMs: number;
    callTimeoutMs?: number;
    maxCallsPerSecond?: number;
    clock?: BlobClock;
}): BlobSession {
    const spacingMs = 1000 / maxCallsPerSecond;
    let nextSlotMs = 0;

    async function call<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const slotMs = Math.max(clock.now(), nextSlotMs);
        nextSlotMs = slotMs + spacingMs;
        const waitMs = slotMs - clock.now();
        if (waitMs > 0) await clock.sleep(waitMs);
        if (clock.now() + callTimeoutMs > deadlineMs) throw new BlobDeadlineError();

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new BlobCallTimeoutError());
            }, callTimeoutMs);
        });
        try {
            return await Promise.race([run(controller.signal), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        callTimeoutMs,
        deadlineMs,
        now: () => clock.now(),
        hasTimeFor: (calls) => clock.now() + calls * callTimeoutMs <= deadlineMs,
        put: (key, body) => call((signal) => store.put(key, body, signal)),
        get: (key) => call((signal) => store.get(key, signal)),
        list: (prefix, token, maxKeys) => call((signal) => store.list(prefix, token, maxKeys, signal)),
        delete: (key) => call((signal) => store.delete(key, signal)),
    };
}
