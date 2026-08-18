import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    LP_ICON_SIZES,
    LP_OG_HEIGHT,
    LP_OG_WIDTH,
    LP_TRACK_HEIGHT,
    LP_TRACK_WIDTH,
    generateLpMetaAssets,
    generateLpTrackAsset,
    getLpTrackAbsolutePath,
} from '../tools/generate-lp-assets.js';

describe('generate-lp-assets', () => {
    let tempRoot = null;

    afterEach(() => {
        if (tempRoot) {
            rmSync(tempRoot, { recursive: true, force: true });
            tempRoot = null;
        }
    });

    it('writes a PNG using the custom-post preview track renderer', async () => {
        tempRoot = mkdtempSync(join(tmpdir(), 'mini-racer-lp-'));
        const lpRoot = join(tempRoot, 'LP');

        const result = await generateLpTrackAsset({
            lpRoot,
            trackKey: 'circuit',
        });

        expect(result.trackKey).toBe('circuit');
        expect(result.outPath).toBe(getLpTrackAbsolutePath(lpRoot));
        expect(existsSync(result.outPath)).toBe(true);

        const bytes = readFileSync(result.outPath);
        expect(bytes.byteLength).toBeGreaterThan(1000);
        expect(bytes.subarray(0, 8)).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );

        const { loadImage } = await import('@napi-rs/canvas');
        const image = await loadImage(bytes);
        expect(image.width).toBe(LP_TRACK_WIDTH);
        expect(image.height).toBe(LP_TRACK_HEIGHT);
    });

    it('writes the social card and icons the LP head references', async () => {
        tempRoot = mkdtempSync(join(tmpdir(), 'mini-racer-lp-'));
        const lpRoot = join(tempRoot, 'LP');

        const result = await generateLpMetaAssets({ lpRoot, trackKey: 'circuit' });
        const written = new Map(result.written.map((asset) => [asset.outPath, asset]));

        const { loadImage } = await import('@napi-rs/canvas');

        const ogPath = join(lpRoot, 'og.png');
        expect(written.has(ogPath)).toBe(true);
        const og = await loadImage(readFileSync(ogPath));
        expect(og.width).toBe(LP_OG_WIDTH);
        expect(og.height).toBe(LP_OG_HEIGHT);

        for (const [name, size] of Object.entries(LP_ICON_SIZES)) {
            const iconPath = join(lpRoot, name);
            expect(existsSync(iconPath)).toBe(true);
            const icon = await loadImage(readFileSync(iconPath));
            expect(icon.width).toBe(size);
            expect(icon.height).toBe(size);
        }
    });
});
