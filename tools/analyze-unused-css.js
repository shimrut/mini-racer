import fs from 'fs';
import path from 'path';
import { readCssBundle } from '../tests/helpers/read-css-bundle.js';

// Recursively find files with given extensions
function getFiles(dir, exts) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
                results = results.concat(getFiles(filePath, exts));
            }
        } else {
            if (exts.includes(path.extname(file))) {
                results.push(filePath);
            }
        }
    });
    return results;
}

// Strip CSS comments and media query headers to avoid matching non-selectors
function cleanCSS(cssText) {
    // Remove comments
    let clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
    return clean;
}

// Extract classes and IDs from CSS
function extractSelectors(cssText) {
    const clean = cleanCSS(cssText);
    const classes = new Set();
    const ids = new Set();

    // Regex to match selectors before {
    let depth = 0;
    let currentSelectorText = '';

    for (let i = 0; i < clean.length; i++) {
        const char = clean[i];
        if (char === '{') {
            if (depth === 0) {
                const selectors = currentSelectorText.split(',');
                selectors.forEach(sel => {
                    // Find class names
                    const classMatches = sel.match(/\.[_a-zA-Z0-9-]+/g);
                    if (classMatches) {
                        classMatches.forEach(m => classes.add(m.substring(1)));
                    }
                    // Find ID names
                    const idMatches = sel.match(/#[_a-zA-Z0-9-]+/g);
                    if (idMatches) {
                        idMatches.forEach(m => ids.add(m.substring(1)));
                    }
                });
            }
            depth++;
            currentSelectorText = '';
        } else if (char === '}') {
            depth--;
        } else if (depth === 0) {
            currentSelectorText += char;
        }
    }

    return { classes: Array.from(classes), ids: Array.from(ids) };
}

function analyzeCSS(cssFileName, contentFiles, dynamicPrefixes = []) {
    const cssPath = path.resolve(cssFileName);
    if (!fs.existsSync(cssPath)) {
        console.error(`${cssFileName} not found!`);
        return null;
    }

    const cssContent = readCssBundle(cssPath);
    const { classes, ids } = extractSelectors(cssContent);

    // Read all contents
    const fileContents = contentFiles.map(file => {
        return {
            path: file,
            content: fs.readFileSync(file, 'utf8')
        };
    });

    const unusedClasses = [];
    const dynamicClasses = [];
    const usedClasses = [];

    classes.forEach(cls => {
        let exactCount = 0;
        let substringCount = 0;

        fileContents.forEach(f => {
            const exactRegex = new RegExp(`\\b${cls}\\b`);
            if (exactRegex.test(f.content)) {
                exactCount++;
            }

            dynamicPrefixes.forEach(prefix => {
                if (cls.startsWith(prefix)) {
                    if (f.content.includes(prefix)) {
                        substringCount++;
                    }
                }
            });
        });

        if (exactCount > 0) {
            usedClasses.push(cls);
        } else if (substringCount > 0) {
            dynamicClasses.push(cls);
        } else {
            unusedClasses.push(cls);
        }
    });

    const unusedIds = [];
    const dynamicIds = [];
    const usedIds = [];

    ids.forEach(id => {
        let exactCount = 0;
        let substringCount = 0;

        fileContents.forEach(f => {
            const exactRegex = new RegExp(`\\b${id}\\b`);
            if (exactRegex.test(f.content)) {
                exactCount++;
            }
        });

        if (exactCount > 0) {
            usedIds.push(id);
        } else if (substringCount > 0) {
            dynamicIds.push(id);
        } else {
            unusedIds.push(id);
        }
    });

    return {
        totalClasses: classes.length,
        totalIds: ids.length,
        classes: { used: usedClasses, unused: unusedClasses, dynamic: dynamicClasses },
        ids: { used: usedIds, unused: unusedIds, dynamic: dynamicIds }
    };
}

function runAll() {
    const reports = {};

    // 1. styles.css -> game
    console.log('Analyzing styles.css...');
    const gameFiles = [
        path.resolve('game.html'),
        ...getFiles(path.resolve('game'), ['.js'])
    ];
    reports['styles.css'] = analyzeCSS('styles.css', gameFiles, [
        'medal-svg--',
        'daily-challenge-hud--',
        'combined-rank-value--',
        'modal--',
        'speedometer--',
        'garage-tab-panel--',
        'modal-sheet-panel--'
    ]);

    // 2. preview.css -> preview page
    console.log('Analyzing preview.css...');
    const previewFiles = [
        path.resolve('preview.html'),
        path.resolve('preview.js')
    ];
    reports['preview.css'] = analyzeCSS('preview.css', previewFiles, []);

    // 3. temp_additions.css -> all (dead css check)
    console.log('Analyzing temp_additions.css...');
    const allFiles = [...gameFiles, ...previewFiles];
    reports['temp_additions.css'] = analyzeCSS('temp_additions.css', allFiles, []);

    // Print summary table
    console.log('\n========================================================================');
    console.log('CSS FILE          | TOTAL CLS | USED CLS | UNUSED CLS | DYN CLS | UNUSED IDS');
    console.log('------------------------------------------------------------------------');
    for (const [file, rep] of Object.entries(reports)) {
        if (!rep) {
            console.log(`${file.padEnd(17)} | (not found)`);
            continue;
        }
        const totalCls = String(rep.totalClasses).padEnd(9);
        const usedCls = String(rep.classes.used.length).padEnd(8);
        const unusedCls = String(rep.classes.unused.length).padEnd(10);
        const dynCls = String(rep.classes.dynamic.length).padEnd(7);
        const unusedIds = String(rep.ids.unused.length).padEnd(10);
        console.log(`${file.padEnd(17)} | ${totalCls} | ${usedCls} | ${unusedCls} | ${dynCls} | ${unusedIds}`);
    }
    console.log('========================================================================');

    // Save report to JSON
    fs.writeFileSync('unused-css-report.json', JSON.stringify(reports, null, 2));
    console.log('\nDetailed reports written to unused-css-report.json');
}

runAll();
