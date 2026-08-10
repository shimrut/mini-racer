import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    SHARE_IMAGE_HEIGHT,
    SHARE_IMAGE_MAX_BYTES,
    SHARE_IMAGE_WIDTH,
    generateMissingShareImages,
    getShareImageAbsolutePath,
} from '../tools/generate-share-images.js';

describe('generate-share-images', () => {
    let tempRoot = null;

    afterEach(() => {
        if (tempRoot) {
            rmSync(tempRoot, { recursive: true, force: true });
            tempRoot = null;
        }
    });

    it('creates a missing share JPG at 1200x630 under 1 MB', async () => {
        tempRoot = mkdtempSync(join(tmpdir(), 'mini-racer-share-'));
        const assetsRoot = join(tempRoot, 'assets');

        const { generated, skipped } = generateMissingShareImages({
            assetsRoot,
            trackKeys: ['circuit'],
        });

        expect(generated).toEqual(['circuit']);
        expect(skipped).toEqual([]);

        const outPath = getShareImageAbsolutePath('circuit', assetsRoot);
        expect(existsSync(outPath)).toBe(true);
        const bytes = readFileSync(outPath);
        expect(bytes.byteLength).toBeGreaterThan(1000);
        expect(bytes.byteLength).toBeLessThanOrEqual(SHARE_IMAGE_MAX_BYTES);
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);

        const { loadImage } = await import('@napi-rs/canvas');
        const image = await loadImage(bytes);
        expect(image.width).toBe(SHARE_IMAGE_WIDTH);
        expect(image.height).toBe(SHARE_IMAGE_HEIGHT);
    });

    it('does not overwrite an existing share JPG', () => {
        tempRoot = mkdtempSync(join(tmpdir(), 'mini-racer-share-'));
        const assetsRoot = join(tempRoot, 'assets');
        mkdirSync(join(assetsRoot, 'share'), { recursive: true });
        const outPath = getShareImageAbsolutePath('circuit', assetsRoot);
        const sentinel = Buffer.from('not-a-real-jpeg-but-present');
        writeFileSync(outPath, sentinel);

        const { generated, skipped } = generateMissingShareImages({
            assetsRoot,
            trackKeys: ['circuit'],
        });

        expect(generated).toEqual([]);
        expect(skipped).toEqual(['circuit']);
        expect(readFileSync(outPath)).toEqual(sentinel);
    });
});
