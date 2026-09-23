import { describe, expect, it } from 'vitest';
import { resolveConfig } from 'vite';

describe('Mapmaker Vite configuration', () => {
    it('does not watch track data as a config dependency', async () => {
        const config = await resolveConfig({
            configFile: new URL('../vite.mapmaker.config.js', import.meta.url).pathname,
        }, 'serve');
        const dependencies = config.configFileDependencies;

        expect(dependencies.some((path) => path.endsWith('/game/track/catalog.js'))).toBe(false);
        expect(dependencies.some((path) => path.endsWith('/game/track/tracks.js'))).toBe(false);
        expect(dependencies.some((path) => path.endsWith('/game/medals/medal-times.json'))).toBe(false);
    });
});
