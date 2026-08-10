#!/usr/bin/env node
// Appends content hashes to dist/client asset URLs so phones cannot keep a stale game.css / game.js.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = join(root, 'dist', 'client');
const htmlPath = join(clientDir, 'game.html');

function hashFile(fileName) {
    const bytes = readFileSync(join(clientDir, fileName));
    return createHash('md5').update(bytes).digest('hex').slice(0, 8);
}

let html = readFileSync(htmlPath, 'utf8');
const replacements = [
    ['/game.css', `/game.css?v=${hashFile('game.css')}`],
    ['/game.js', `/game.js?v=${hashFile('game.js')}`],
];

for (const [from, to] of replacements) {
    if (!html.includes(from)) {
        throw new Error(`bust-client-asset-cache: missing ${from} in game.html`);
    }
    html = html.split(from).join(to);
}

writeFileSync(htmlPath, html);
console.log(`bust-client-asset-cache: ${replacements.map(([, to]) => to).join(', ')}`);
