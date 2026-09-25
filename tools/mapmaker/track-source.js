import { CONFIG } from '../../game/config.js';
import { clamp } from '../geometry.js';
import { getStoredTrackGroundKey } from '../../game/track/grounds.js';

const MIN_DRAW_WIDTH = 1.5;
const MAX_DRAW_WIDTH = 20;
export const LINE_BUILD_CAR_UNITS = 7;
export const DEFAULT_DRAW_WIDTH = LINE_BUILD_CAR_UNITS * CONFIG.carRadius * 2;
const MIN_LINE_SMOOTHING = 0;
const MAX_LINE_SMOOTHING = 1;
const TRACK_KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_TRACK_KEYS = new Set([
    'await',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'implements',
    'import',
    'in',
    'instanceof',
    'interface',
    'let',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'return',
    'static',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    'yield',
]);

export function formatTrackNumber(value) {
    if (!Number.isFinite(value)) {
        return '0';
    }
    const rounded = Math.round(value * 1000) / 1000;
    if (Math.abs(rounded - Math.round(rounded)) < 0.000001) {
        return String(Math.round(rounded));
    }
    return rounded.toFixed(3).replace(/\.?0+$/, '');
}

function pointSource(point) {
    return `Point(${formatTrackNumber(point.x)}, ${formatTrackNumber(point.y)})`;
}

function toKebabCase(value) {
    return String(value)
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_$]+/g, '-')
        .replace(/[^A-Za-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-')
        .toLowerCase();
}

export function isValidTrackKey(value) {
    return TRACK_KEY_RE.test(value) && !RESERVED_TRACK_KEYS.has(value);
}

export function getTrackModuleFilename(trackKey) {
    if (!isValidTrackKey(trackKey)) {
        throw new Error('Track key must be a valid non-reserved JavaScript identifier.');
    }
    const slug = toKebabCase(trackKey);
    if (!slug) {
        throw new Error('Track key must produce a valid module filename.');
    }
    return `${slug}.js`;
}

export function generateTrackGeometrySource(track, indent = '') {
    const lines = [];
    lines.push(`${indent}{`);
    if (track.cornerRadius !== undefined) {
        lines.push(`${indent}    cornerRadius: ${formatTrackNumber(track.cornerRadius)},`);
    }
    if (track.drawWidth !== undefined) {
        const drawWidth = clamp(
            Number(track.drawWidth) || DEFAULT_DRAW_WIDTH,
            MIN_DRAW_WIDTH,
            MAX_DRAW_WIDTH
        );
        lines.push(`${indent}    drawWidth: ${formatTrackNumber(drawWidth)},`);
    }
    if (track.lineSmoothing !== undefined) {
        const lineSmoothing = clamp(
            Number(track.lineSmoothing) || 0,
            MIN_LINE_SMOOTHING,
            MAX_LINE_SMOOTHING
        );
        lines.push(`${indent}    lineSmoothing: ${formatTrackNumber(lineSmoothing)},`);
    }
    const groundKey = getStoredTrackGroundKey(track);
    if (groundKey !== null) {
        lines.push(`${indent}    ground: '${groundKey}',`);
    }
    lines.push(`${indent}    outer: [`);
    track.outer.forEach((point, index) => {
        lines.push(`${indent}        ${pointSource(point)}${index === track.outer.length - 1 ? '' : ','}`);
    });
    lines.push(`${indent}    ],`);
    lines.push(`${indent}    inner: [`);
    track.inner.forEach((point, index) => {
        lines.push(`${indent}        ${pointSource(point)}${index === track.inner.length - 1 ? '' : ','}`);
    });
    lines.push(`${indent}    ],`);
    lines.push(`${indent}    startLine: { p1: ${pointSource(track.startLine.p1)}, p2: ${pointSource(track.startLine.p2)} },`);
    lines.push(`${indent}    startPos: ${pointSource(track.startPos)},`);
    lines.push(`${indent}    startAngle: ${formatTrackNumber(track.startAngle ?? 0)},`);
    lines.push(`${indent}    checkpoints: [`);
    track.checkpoints.forEach((checkpoint, index) => {
        const comma = index === track.checkpoints.length - 1 ? '' : ',';
        lines.push(`${indent}        { p1: ${pointSource(checkpoint.p1)}, p2: ${pointSource(checkpoint.p2)} }${comma}`);
    });
    lines.push(`${indent}    ]`);
    lines.push(`${indent}}`);
    return lines.join('\n');
}

export function generateTrackModuleSource(track) {
    return [
        "import { Point } from '../geometry.js';",
        '',
        `export default ${generateTrackGeometrySource(track)};`,
        ''
    ].join('\n');
}

export function generateTrackIntegrationSnippet(trackKey, trackName) {
    const filename = getTrackModuleFilename(trackKey);
    const importName = `${trackKey}Geometry`;
    return [
        '// TRACK_CATALOG metadata',
        `${trackKey}: { name: ${JSON.stringify(trackName)} },`,
        '',
        '// tracks.js static import',
        `import ${importName} from './definitions/${filename}';`,
        '',
        '// tracks.js geometry registry',
        `${trackKey}: ${importName},`
    ].join('\n');
}
