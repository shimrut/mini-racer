import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const LOCAL_IMPORT_PATTERN = /@import\s+url\(\s*["']([^"']+)["']\s*\)\s*;/g;

export function readCssBundle(cssFileName, activeImports = new Set()) {
    const cssPath = cssFileName instanceof URL
        ? fileURLToPath(cssFileName)
        : path.resolve(cssFileName);

    if (activeImports.has(cssPath)) {
        throw new Error(`Circular CSS import detected at ${cssPath}`);
    }

    const nextActiveImports = new Set(activeImports);
    nextActiveImports.add(cssPath);

    const cssContent = fs.readFileSync(cssPath, 'utf8');
    return cssContent.replace(LOCAL_IMPORT_PATTERN, (statement, importTarget) => {
        if (/^(?:[a-z]+:|\/\/)/i.test(importTarget)) {
            return statement;
        }

        const importPath = path.resolve(path.dirname(cssPath), importTarget);
        if (!fs.existsSync(importPath)) {
            throw new Error(`CSS import not found: ${importTarget} from ${cssPath}`);
        }

        return readCssBundle(importPath, nextActiveImports);
    });
}
