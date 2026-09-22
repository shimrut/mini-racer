import { gzipSync } from 'node:zlib';

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
