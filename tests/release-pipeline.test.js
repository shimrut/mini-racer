import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateWebviewEntrypoints } from '../vite.config.js';

const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const devvitConfig = JSON.parse(
    readFileSync(new URL('../devvit.json', import.meta.url), 'utf8'),
);
const viteConfigSource = readFileSync(
    new URL('../vite.config.js', import.meta.url),
    'utf8',
);

function devvitReleaseCommands(script) {
    return script.match(/devvit\s+(?:upload|publish)\b/g) ?? [];
}

function findMacMetadata(directoryUrl) {
    return readdirSync(directoryUrl, { withFileTypes: true }).flatMap((entry) => {
        const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directoryUrl);
        if (entry.isDirectory()) {
            return findMacMetadata(entryUrl);
        }
        return entry.name === '.DS_Store' ? [entryUrl.pathname] : [];
    });
}

describe('release pipeline', () => {
    it('rejects a partial WebView bundle before upload', () => {
        const plugin = validateWebviewEntrypoints(devvitConfig.post.entrypoints);
        const context = { error(message) { throw new Error(message); } };
        const partial = { 'pages/map-creator-playtest.html': { type: 'asset' } };
        expect(() => plugin.generateBundle.handler.call(context, {}, partial))
            .toThrow(/Missing WebView entrypoints in bundle: pages\/preview\.html/);
        const complete = Object.fromEntries(Object.values(devvitConfig.post.entrypoints)
            .map(({ entry }) => [entry, { type: 'asset' }]));
        expect(() => plugin.generateBundle.handler.call(context, {}, complete)).not.toThrow();
        expect(plugin.applyToEnvironment({ name: 'server' })).toBe(false);
    });

    it('keeps Reddit user attribution enabled for result comments and challenge posts', () => {
        expect(devvitConfig.permissions.reddit.asUser).toEqual(expect.arrayContaining([
            'SUBMIT_COMMENT',
            'SUBMIT_POST',
        ]));
    });

    it('uses canonical content-hashed module filenames for Devvit releases', () => {
        const buildScript = packageJson.scripts.build;

        expect(devvitConfig.scripts.build).toBe('npm run build');
        expect(buildScript).toContain('vite build');
        expect(buildScript).not.toContain('bust-client-asset-cache');
        expect(viteConfigSource).toContain("entryFileNames: '[name]-[hash].js'");
        expect(viteConfigSource).toContain("chunkFileNames: '[name]-[hash].js'");
        expect(viteConfigSource).toContain("'[name]-[hash][extname]'");
        expect(existsSync(new URL('../tools/bust-client-asset-cache.js', import.meta.url)))
            .toBe(false);
    });

    it('keeps dynamically split mode source maps from overwriting each other', () => {
        expect(viteConfigSource).toContain("sourcemapFileNames: '[name]-[hash].js.map'");
    });

    it('keeps client source maps out of the Devvit upload folder', () => {
        expect(devvitConfig.post.dir).toBe('dist/client');
        expect(viteConfigSource).toContain("sourcemap: 'hidden'");
        expect(viteConfigSource).toContain("new URL('./dist/client-sourcemaps', import.meta.url)");
        expect(viteConfigSource).toContain('keepClientSourceMapsLocal(),');
    });

    it('keeps non-product material out of the Devvit publish source archive', () => {
        expect(devvitConfig.sourceIgnores).toEqual(expect.arrayContaining([
            '**/.DS_Store',
            '.agents/',
            '.claude/',
            '.cursor/',
            '.vscode/',
            'CHANGELOG.md',
            'FAQ.md',
            'LP/',
            'README.md',
            'assets/share/',
            'docs/',
            'stryker.config.mjs',
            'tests/',
            'tools/*',
            'vite.mapmaker.config.js',
            'vitest.config.js',
        ]));
        expect(devvitConfig.sourceIgnores).toEqual(expect.arrayContaining([
            '!tools/generate-player-car-assets.js',
            '!tools/generate-share-images.js',
        ]));
        expect(devvitConfig.sourceIgnores).not.toContain('!tools/bust-client-asset-cache.js');
    });

    it('keeps macOS metadata out of the WebView public asset tree', () => {
        expect(findMacMetadata(new URL('../public/', import.meta.url))).toEqual([]);
    });

    it('keeps deploy and launch as separate single-upload workflows', () => {
        const deployScript = packageJson.scripts.deploy;
        const launchScript = packageJson.scripts.launch;

        expect(deployScript).toBe('npm run test && devvit upload');
        expect(launchScript).toBe('npm run test && devvit publish');
        expect(launchScript).not.toContain('deploy');
        expect(launchScript).not.toContain('devvit upload');
        expect(devvitReleaseCommands(deployScript)).toEqual(['devvit upload']);
        expect(devvitReleaseCommands(launchScript)).toEqual(['devvit publish']);
    });
});
