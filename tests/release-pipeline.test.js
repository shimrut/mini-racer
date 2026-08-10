import { readFileSync } from 'node:fs';
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

describe('release pipeline', () => {
    it('keeps the cache-busting production build authoritative for Devvit releases', () => {
        const buildScript = packageJson.scripts.build;
        const viteBuildIndex = buildScript.indexOf('vite build');
        const cacheBustIndex = buildScript.indexOf('node tools/bust-client-asset-cache.js');

        expect(devvitConfig.scripts.build).toBe('npm run build');
        expect(viteBuildIndex).toBeGreaterThanOrEqual(0);
        expect(cacheBustIndex).toBeGreaterThan(viteBuildIndex);
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
