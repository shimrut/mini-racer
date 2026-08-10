import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const devvitConfig = JSON.parse(
    readFileSync(new URL('../devvit.json', import.meta.url), 'utf8'),
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
    it('keeps Reddit user attribution enabled for result comments and challenge posts', () => {
        expect(devvitConfig.permissions.reddit.asUser).toEqual(expect.arrayContaining([
            'SUBMIT_COMMENT',
            'SUBMIT_POST',
        ]));
    });

    it('keeps the cache-busting production build authoritative for Devvit releases', () => {
        const buildScript = packageJson.scripts.build;
        const viteBuildIndex = buildScript.indexOf('vite build');
        const cacheBustIndex = buildScript.indexOf('node tools/bust-client-asset-cache.js');

        expect(devvitConfig.scripts.build).toBe('npm run build');
        expect(viteBuildIndex).toBeGreaterThanOrEqual(0);
        expect(cacheBustIndex).toBeGreaterThan(viteBuildIndex);
    });

    it('keeps non-product material out of the Devvit publish source archive', () => {
        expect(devvitConfig.sourceIgnores).toEqual(expect.arrayContaining([
            '**/.DS_Store',
            '.claude/',
            'CHANGELOG.md',
            'FAQ.md',
            'IGNORE SUPABASE',
            'LP/',
            'README.md',
            'assets/share/',
            'docs/',
            'ok-let-s-plan-for-fluttering-horizon.md',
            'stryker.config.mjs',
            'tests/',
            'tools/*',
            'vite.mapmaker.config.js',
            'vitest.config.js',
        ]));
        expect(devvitConfig.sourceIgnores).toEqual(expect.arrayContaining([
            '!tools/bust-client-asset-cache.js',
            '!tools/generate-player-car-assets.js',
            '!tools/generate-share-images.js',
        ]));
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
