import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { encodeRedisCompressedValue } from '../src/server/redis/redis-compressed-value.ts';

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

    it('keeps values shorter than 80 characters raw even when repetitive', () => {
        const short = 'a'.repeat(79);
        expect(short.length).toBe(79);
        expect(encodeRedisCompressedValue(short)).toBe(short);
    });

    it('compresses values at or above the 80-character threshold', () => {
        const boundary = 'a'.repeat(80);
        const encoded = encodeRedisCompressedValue(boundary);
        expect(encoded.startsWith('__gz:b64__:')).toBe(true);
        expect(
            gunzipSync(Buffer.from(encoded.slice('__gz:b64__:'.length), 'base64')).toString('utf8'),
        ).toBe(boundary);
    });

    it('returns the original value when compression would grow the payload', () => {
        const incompressible = Buffer.from(
            Array.from({ length: 96 }, (_, index) => index % 251),
        ).toString('base64');
        expect(incompressible.length).toBeGreaterThanOrEqual(80);
        const compressedBody = gzipSync(incompressible).toString('base64');
        expect(`__gz:b64__:${compressedBody}`.length).toBeGreaterThanOrEqual(incompressible.length);
        expect(encodeRedisCompressedValue(incompressible)).toBe(incompressible);
    });

    it('falls back to the original value when gzip fails', async () => {
        vi.resetModules();
        vi.doMock('node:zlib', async (importOriginal) => {
            const actual = await importOriginal();
            return {
                ...actual,
                gzipSync: () => {
                    throw new Error('gzip unavailable');
                },
            };
        });
        const { encodeRedisCompressedValue: encodeWithBrokenGzip } = await import(
            '../src/server/redis/redis-compressed-value.ts'
        );
        const value = 'x'.repeat(120);
        expect(encodeWithBrokenGzip(value)).toBe(value);
        vi.doUnmock('node:zlib');
        vi.resetModules();
    });
});
