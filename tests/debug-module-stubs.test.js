import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEBUG_MODULE_STUBS } from '../tools/debug-module-stubs.js';

describe('debug module stubs', () => {
    it.each(DEBUG_MODULE_STUBS)('$suffix has a stub covering every export', async (entry) => {
        const real = await import(pathToFileURL(entry.modulePath).href);
        const stub = await import(pathToFileURL(entry.stubPath).href);

        const missing = Object.keys(real).filter((name) => !(name in stub));
        expect(missing, `${entry.stub} is missing exports used by the build`).toEqual([]);
    });

    it.each(DEBUG_MODULE_STUBS)('$suffix keeps its stub free of debug code', (entry) => {
        const source = readFileSync(entry.stubPath, 'utf8');

        expect(source).not.toMatch(/(window|globalThis)\s*\.\s*\w+\s*=/);
        expect(source).not.toMatch(/localStorage|URLSearchParams/);
    });

    it('keeps the debug globals out of every module that always ships', () => {
        const shipped = ['game/engine.js', 'pages/campaign.js', 'pages/head-to-head.js', 'pages/head-to-head-accept.js'];
        for (const file of shipped) {
            const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
            expect(source, `${file} must not assign debug globals`).not.toMatch(
                /(window|globalThis)\.(render_game_to_text|advanceTime|__RACER_DEBUG__|__PB_GHOST_SIZE_DEBUG__)\s*=/,
            );
        }
    });
});
