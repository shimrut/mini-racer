import { gunzipSync } from 'node:zlib';

const COMPRESSION_PREFIX = '__gz:b64__:';

/** Decodes one stored value the way the live compressing client does on read. */
export function decodeCompressedValue(value) {
    return typeof value === 'string' && value.startsWith(COMPRESSION_PREFIX)
        ? gunzipSync(Buffer.from(value.slice(COMPRESSION_PREFIX.length), 'base64')).toString('utf8')
        : value;
}

/**
 * The `redisCompressed` face of one in-memory store: reads decode a `__gz:b64__:` envelope, plain
 * values pass through, and everything else -- writes included -- goes to the raw client unchanged.
 * Keeping the raw face undecoded is the point: a plain `redis.hGet` of a compressed field returns
 * the envelope on live Redis, so a test that decodes everywhere cannot see a writer/reader mismatch.
 *
 * This wrapper does not compress writes. Live `redisCompressed.hSet` does; callers that queue
 * through a transaction already encode with `encodeRedisCompressedValue`.
 */
export function asCompressedRedis(client) {
    return new Proxy(client, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            if (prop === 'hGet' || prop === 'get') {
                return async (...args) => decodeCompressedValue(await value.apply(target, args));
            }
            if (prop === 'hMGet' || prop === 'mGet') {
                return async (...args) => (await value.apply(target, args)).map(decodeCompressedValue);
            }
            return value.bind(target);
        },
    });
}
