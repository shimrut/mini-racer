import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodeRedisCompressedValue } from '../src/server/redis-compressed-value.ts';

describe('Redis compressed transaction values', () => {
    it('matches the pinned redisCompressed envelope for compressible values', () => {
        const value = JSON.stringify({ ghost: Array.from({ length: 500 }, () => 123) });
        const encoded = encodeRedisCompressedValue(value);
        expect(encoded.startsWith('__gz:b64__:')).toBe(true);
        expect(gunzipSync(Buffer.from(encoded.slice('__gz:b64__:'.length), 'base64')).toString('utf8')).toBe(value);
    });

    it('leaves short values unwrapped', () => {
        expect(encodeRedisCompressedValue('{"ok":true}')).toBe('{"ok":true}');
    });
});
