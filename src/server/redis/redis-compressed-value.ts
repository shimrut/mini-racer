import { gunzipSync, gzipSync } from 'node:zlib';

// Matches the @devvit/redis compression envelope.
const REDIS_COMPRESSION_PREFIX = '__gz:b64__:';

export function encodeRedisCompressedValue(value: string): string {
    if (value.length < 80) return value;
    try {
        const compressed = `${REDIS_COMPRESSION_PREFIX}${gzipSync(value).toString('base64')}`;
        return compressed.length < value.length ? compressed : value;
    } catch (_error) {
        return value;
    }
}

// Reads a value stored through the compressing client, as the plain client
// returns it. A value without the envelope is returned as it is.
export function decodeRedisCompressedValue(value: string): string {
    if (!value.startsWith(REDIS_COMPRESSION_PREFIX)) return value;
    return gunzipSync(Buffer.from(value.slice(REDIS_COMPRESSION_PREFIX.length), 'base64')).toString('utf8');
}
