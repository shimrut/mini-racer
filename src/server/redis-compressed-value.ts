import { gzipSync } from 'node:zlib';

// Matches the pinned @devvit/redis 0.13.9 envelope; transaction clients bypass its proxy, so callers queue the encoded value directly.
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
