import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    LP_TRACK_HEIGHT,
    LP_TRACK_WIDTH,
    generateLpTrackAsset,
    getLpTrackAbsolutePath,
} from '../tools/generate-lp-assets.js';

describe('generate-lp-assets', () => {
    /** @type {string | null} */
    let tempRoot = null;

    afterEach(() => {
        if (tempRoot) {
            rmSync(tempRoot, { recursive: true, force: true });
            tempRoot = null;
        }
    });

    it('writes a JPEG using the custom-post preview track renderer', async () => {
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
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);

        const { loadImage } = await import('@napi-rs/canvas');
        const image = await loadImage(bytes);
        expect(image.width).toBe(LP_TRACK_WIDTH);
        expect(image.height).toBe(LP_TRACK_HEIGHT);
    });
});
