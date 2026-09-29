import { cpSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Builds site/dist for the miniracer.club Pages project: the promo page from
// LP/, the online Mapmaker with Drive Draft at /mapmaker, and the car pictures
// that Drive Draft loads from /assets/cars. site/functions guards /mapmaker.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = join(repoRoot, 'site', 'dist');
const mapmakerDist = join(dist, 'mapmaker');

rmSync(dist, { recursive: true, force: true });
cpSync(join(repoRoot, 'LP'), dist, {
    recursive: true,
    filter: (source) => !/(?:README\.md|\.DS_Store)$/.test(source),
});
cpSync(join(repoRoot, 'public', 'assets', 'cars'), join(dist, 'assets', 'cars'), { recursive: true });

await build({
    configFile: false,
    root: join(repoRoot, 'tools'),
    base: '/mapmaker/',
    mode: 'online',
    publicDir: false,
    logLevel: 'warn',
    build: {
        outDir: mapmakerDist,
        emptyOutDir: false,
        rollupOptions: {
            input: [join(repoRoot, 'tools', 'mapmaker.html'), join(repoRoot, 'tools', 'mapmaker-playtest.html')],
        },
    },
});
renameSync(join(mapmakerDist, 'mapmaker.html'), join(mapmakerDist, 'index.html'));

// Only these paths run the Functions; the promo page stays plain static files.
writeFileSync(join(dist, '_routes.json'), `${JSON.stringify({
    version: 1,
    include: ['/mapmaker', '/mapmaker/*', '/api/*'],
    exclude: [],
}, null, 4)}\n`);

console.log(`Built ${dist}`);
