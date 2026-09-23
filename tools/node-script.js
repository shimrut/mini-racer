import { pathToFileURL } from 'node:url';
import { Path2D as NodePath2D } from '@napi-rs/canvas';

export function ensurePath2D() {
    if (typeof globalThis.Path2D === 'undefined') {
        globalThis.Path2D = NodePath2D;
    }
}

export function isMainModule(moduleUrl) {
    const entry = process.argv[1];
    if (!entry) return false;
    return moduleUrl === pathToFileURL(entry).href;
}
