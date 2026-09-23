import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCarAssetUrlCandidates, PLAYER_SELECTABLE_CAR_ASSETS, STOCK_CAR_ASSET_NAME } from '../game/car/sprite.js';
import { EXTRA_CAR_ASSETS } from '../game/car/car-unlock-policy.js';

// Every page link must point at a real file, wherever the page lives. A broken link does not
// fail the build: the player sees a missing style, font, or car.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const devvitConfig = JSON.parse(readFileSync(path.join(ROOT, 'devvit.json'), 'utf8'));
const entryPages = Object.values(devvitConfig.post.entrypoints).map((entry) => entry.entry);

function isLocalLink(value) {
    return value
        && !/^(?:[a-z]+:|\/\/|#|data:)/i.test(value)
        && !value.startsWith('${');
}

function stripQuery(value) {
    return value.split(/[?#]/)[0];
}

// A root-based link ("/x") points at the site root: the page folder or the public folder.
function resolveLink(fromFile, link) {
    const clean = stripQuery(link);
    if (clean.startsWith('/')) {
        return [path.join(ROOT, clean), path.join(PUBLIC_DIR, clean)];
    }
    return [path.resolve(path.dirname(fromFile), clean)];
}

function brokenLinks(fromFile, links) {
    return links
        .filter(isLocalLink)
        .filter((link) => !resolveLink(fromFile, link).some((candidate) => existsSync(candidate)))
        .map((link) => `${path.relative(ROOT, fromFile)} -> ${link}`);
}

function htmlLinks(html) {
    return [...html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function cssLinks(css) {
    const links = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]);
    const bareImports = [...css.matchAll(/@import\s+["']([^"']+)["']/g)].map((match) => match[1]);
    return [...links, ...bareImports];
}

function collectStylesheetProblems(cssFile, seen = new Set()) {
    if (seen.has(cssFile)) return [];
    seen.add(cssFile);
    const links = cssLinks(readFileSync(cssFile, 'utf8'));
    const problems = brokenLinks(cssFile, links);
    for (const link of links.filter(isLocalLink)) {
        const target = resolveLink(cssFile, link).find((candidate) => existsSync(candidate));
        if (target && target.endsWith('.css')) problems.push(...collectStylesheetProblems(target, seen));
    }
    return problems;
}

describe('page links', () => {
    it('lists at least one page', () => {
        expect(entryPages.length).toBeGreaterThan(0);
    });

    it.each(entryPages)('%s exists', (page) => {
        expect(existsSync(path.join(ROOT, page))).toBe(true);
    });

    it.each(entryPages)('%s links only to files that exist', (page) => {
        const pageFile = path.join(ROOT, page);
        expect(brokenLinks(pageFile, htmlLinks(readFileSync(pageFile, 'utf8')))).toEqual([]);
    });

    it.each(entryPages)('%s stylesheets link only to files that exist', (page) => {
        const pageFile = path.join(ROOT, page);
        const stylesheets = htmlLinks(readFileSync(pageFile, 'utf8'))
            .filter(isLocalLink)
            .map((link) => resolveLink(pageFile, link).find((candidate) => existsSync(candidate)))
            .filter((file) => file && file.endsWith('.css'));
        expect(stylesheets.flatMap((file) => collectStylesheetProblems(file))).toEqual([]);
    });
});

describe('car picture links', () => {
    const carAssets = [...new Set([
        STOCK_CAR_ASSET_NAME,
        ...PLAYER_SELECTABLE_CAR_ASSETS,
        ...Object.values(EXTRA_CAR_ASSETS),
    ])];

    it.each(carAssets)('%s loads from the site root on any page', (assetName) => {
        const [primary] = getCarAssetUrlCandidates(assetName);
        expect(primary.startsWith('/')).toBe(true);
        expect(existsSync(path.join(PUBLIC_DIR, primary))).toBe(true);
    });
});
