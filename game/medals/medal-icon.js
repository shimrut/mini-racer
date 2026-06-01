const MEDAL_HEX_PATH =
    'M65.5 284.3C52.8 306.5 52.8 333.7 65.5 355.8L161.7 523.9C174.5 546.3 198.4 560.1 224.2 560.1L415.8 560.1C441.6 560.1 465.5 546.3 478.3 523.9L574.5 355.8C587.2 333.6 587.2 306.4 574.5 284.3L478.3 116.2C465.5 93.8 441.6 80 415.8 80L224.2 80C198.4 80 174.5 93.8 161.7 116.2L65.5 284.3z';

/** Font Awesome Free v7.2.0 — car-burst (crash) icon path */
const CRASH_ICON_PATH =
    'M232 80.1L232 32.1C232 18.8 221.3 8.1 208 8.1C194.7 8.1 184 18.8 184 32.1L184 80.1C184 93.4 194.7 104.1 208 104.1C221.3 104.1 232 93.4 232 80.1zM32 232.1L80 232.1C93.3 232.1 104 221.4 104 208.1C104 194.8 93.3 184.1 80 184.1L32 184.1C18.7 184.1 8 194.8 8 208.1C8 221.4 18.7 232.1 32 232.1zM281.5 134.6C290.9 144 306.1 144 315.4 134.6L349.3 100.7C358.7 91.3 358.7 76.1 349.3 66.8C339.9 57.5 324.7 57.4 315.4 66.8L281.5 100.6C272.1 110 272.1 125.2 281.5 134.5zM100.5 349.6L134.4 315.7C143.8 306.3 143.8 291.1 134.4 281.8C125 272.5 109.8 272.4 100.5 281.8L66.6 315.6C57.2 325 57.2 340.2 66.6 349.5C76 358.8 91.2 358.9 100.5 349.5zM66.6 66.7C57.2 76.1 57.2 91.3 66.6 100.6L100.5 134.5C109.9 143.9 125.1 143.9 134.4 134.5C143.7 125.1 143.8 109.9 134.4 100.6L100.5 66.7C91.1 57.3 76 57.3 66.6 66.7zM352.9 239.4L505 280.2C511.4 281.9 516.1 287.5 516.8 294.1L524 368.1L292.5 306.1L335.7 245.6C339.6 240.2 346.4 237.7 352.9 239.4zM223.6 292.5L221.5 295.4C199.8 300.9 181.6 317.7 175.4 340.9C171.3 356.4 163 387.3 150.6 433.6L142.3 464.5C137.7 481.6 147.9 499.1 164.9 503.7L180.4 507.8C197.5 512.4 215 502.2 219.6 485.2L227.9 454.3L506.1 528.8L497.8 559.7C493.2 576.8 503.4 594.3 520.4 598.9L535.9 603C553 607.6 570.5 597.4 575.1 580.4C579.2 564.9 587.5 534 599.9 487.7L608.2 456.8C614.4 433.6 607.1 410 591 394.3L590.7 390.7L580.7 287.7C577.5 254.5 554 226.8 521.8 218.2L369.5 177.6C337.3 169 303.1 181.2 283.7 208.4L223.5 292.6zM272.3 350.3C283.5 353.1 292.3 361.7 295.4 372.9C298.4 384.1 295.2 396 287 404.1C278.8 412.2 266.8 415.3 255.7 412.1C244.5 409.3 235.7 400.7 232.6 389.5C229.6 378.3 232.8 366.4 241 358.3C249.2 350.2 261.2 347.1 272.3 350.3zM480.4 439.2C483.2 428 491.8 419.2 503 416.1C514.2 413.1 526.1 416.3 534.2 424.5C542.3 432.7 545.4 444.7 542.2 455.8C539.4 467 530.8 475.8 519.6 478.9C508.4 481.9 496.5 478.7 488.4 470.5C480.3 462.3 477.2 450.3 480.4 439.2z';

const MEDAL_ARIA = {
    author: 'Author medal',
    gold: 'Gold medal',
    silver: 'Silver medal',
    bronze: 'Bronze medal',
    'personal-best': 'Personal best medal',
    white: 'No medal yet',
    crash: 'Crash'
};

/** @type {Record<string, string>} */
const MEDAL_TIER_CAPTION = {
    bronze: 'bronze',
    silver: 'silver',
    gold: 'gold',
    author: 'creator',
    'personal-best': 'pb'
};

const MEDAL_CENTER_X = '320';
const MEDAL_MAIN_TEXT_Y = '300';
const MEDAL_CAPTION_Y = '398';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEX_CENTER = '320 320';
const CRASH_ICON_GRAD_ID = 'medal-crash-icon-grad';
const medalIconTemplateCache = new Map();
const MEDAL_ICON_TEMPLATE_CACHE_LIMIT = 80;
let medalIconCloneId = 0;

function walkElementTree(node, callback) {
    if (!node) return;
    callback(node);
    for (const child of Array.from(node.children || [])) {
        walkElementTree(child, callback);
    }
}

function uniquifyClonedSvgIds(root) {
    const idMap = new Map();
    const suffix = `clone-${++medalIconCloneId}`;

    walkElementTree(root, (node) => {
        const id = typeof node.getAttribute === 'function' ? node.getAttribute('id') : null;
        if (!id) return;
        const nextId = `${id}-${suffix}`;
        idMap.set(id, nextId);
        node.setAttribute('id', nextId);
    });

    if (!idMap.size) return;

    walkElementTree(root, (node) => {
        if (!node.attributes || typeof node.setAttribute !== 'function') return;
        for (const attr of Array.from(node.attributes)) {
            let nextValue = attr.value;
            for (const [oldId, nextId] of idMap) {
                nextValue = nextValue.replaceAll(`url(#${oldId})`, `url(#${nextId})`);
            }
            if (nextValue !== attr.value) {
                node.setAttribute(attr.name, nextValue);
            }
        }
    });
}

function getMedalTemplateCacheKey(tier, { className, outline, centerText, showEmblem, rowPlaceholder }) {
    return [
        tier,
        className || '',
        outline ? 'outline' : 'filled',
        centerText ?? '',
        showEmblem ? 'emblem' : 'no-emblem',
        rowPlaceholder ? 'row-placeholder' : 'standard'
    ].join('|');
}

function rememberMedalIconTemplate(key, template) {
    if (medalIconTemplateCache.has(key)) {
        medalIconTemplateCache.delete(key);
    }
    medalIconTemplateCache.set(key, template);
    while (medalIconTemplateCache.size > MEDAL_ICON_TEMPLATE_CACHE_LIMIT) {
        const oldestKey = medalIconTemplateCache.keys().next().value;
        medalIconTemplateCache.delete(oldestKey);
    }
}

function cloneCachedMedalIcon(template) {
    if (!template || typeof template.cloneNode !== 'function') return null;
    const clone = template.cloneNode(true);
    uniquifyClonedSvgIds(clone);
    return clone;
}

/**
 * Darken a hex color for inset grooves (tinted shadow, not pure black).
 * @param {string} hex
 * @param {number} [factor]
 * @returns {string}
 */
function darkenHex(hex, factor = 0.55) {
    const raw = hex.replace('#', '');
    const expanded = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
    const n = Number.parseInt(expanded, 16);
    const r = Math.round(((n >> 16) & 255) * factor);
    const g = Math.round(((n >> 8) & 255) * factor);
    const b = Math.round((n & 255) * factor);
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {number} scale
 * @returns {string}
 */
function hexScaleTransform(scale) {
    return `translate(${HEX_CENTER}) scale(${scale}) translate(-320 -320)`;
}

/** @returns {SVGSVGElement} */
function createGradient(id, type, attrs, stops) {
    const grad = document.createElementNS(SVG_NS, type === 'radial' ? 'radialGradient' : 'linearGradient');
    grad.setAttribute('id', id);
    for (const [key, val] of Object.entries(attrs)) {
        grad.setAttribute(key, val);
    }
    for (const stop of stops) {
        const s = document.createElementNS(SVG_NS, 'stop');
        s.setAttribute('offset', stop.offset);
        s.setAttribute('stop-color', stop.color);
        if (stop.opacity !== undefined) {
            s.setAttribute('stop-opacity', stop.opacity);
        }
        grad.appendChild(s);
    }
    return grad;
}

/** @returns {SVGSVGElement} */
function createCrashMedalSvg() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 640 640');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);

    const uniqueId = Math.random().toString(36).substring(2, 9);
    const borderGradId = `medal-border-grad-${uniqueId}`;
    const faceGradId = `medal-face-grad-${uniqueId}`;

    const borderStops = [
        { offset: '0%', color: '#c8d2dc' },
        { offset: '40%', color: '#4b5563' },
        { offset: '75%', color: '#9ca3af' },
        { offset: '100%', color: '#1f2937' }
    ];
    const faceStops = [
        { offset: '0%', color: '#374151' },
        { offset: '100%', color: '#111827' }
    ];

    defs.appendChild(createGradient(borderGradId, 'linear', { x1: '0%', y1: '0%', x2: '100%', y2: '100%' }, borderStops));
    defs.appendChild(createGradient(faceGradId, 'radial', { cx: '50%', cy: '40%', r: '60%' }, faceStops));

    const iconGrad = document.createElementNS(SVG_NS, 'linearGradient');
    iconGrad.setAttribute('id', CRASH_ICON_GRAD_ID);
    iconGrad.setAttribute('x1', '30%');
    iconGrad.setAttribute('y1', '15%');
    iconGrad.setAttribute('x2', '70%');
    iconGrad.setAttribute('y2', '85%');
    const stopTop = document.createElementNS(SVG_NS, 'stop');
    stopTop.setAttribute('offset', '0%');
    stopTop.setAttribute('stop-color', '#fde047');
    const stopBottom = document.createElementNS(SVG_NS, 'stop');
    stopBottom.setAttribute('offset', '100%');
    stopBottom.setAttribute('stop-color', '#ea580c');
    iconGrad.append(stopTop, stopBottom);
    defs.appendChild(iconGrad);

    // 1. Outer Border
    const outerBorder = document.createElementNS(SVG_NS, 'path');
    outerBorder.setAttribute('d', MEDAL_HEX_PATH);
    outerBorder.setAttribute('fill', `url(#${borderGradId})`);
    outerBorder.setAttribute('class', 'medal-crash__bg');
    svg.appendChild(outerBorder);

    // 2. The Groove Shadow
    const groove = document.createElementNS(SVG_NS, 'path');
    groove.setAttribute('d', MEDAL_HEX_PATH);
    groove.setAttribute('transform', 'translate(320 320) scale(0.86) translate(-320 -320)');
    groove.setAttribute('fill', 'none');
    groove.setAttribute('stroke', darkenHex(faceStops[0].color));
    groove.setAttribute('stroke-width', '22');
    svg.appendChild(groove);

    // 3. Inner Face (scaled down with subtle border groove highlight)
    const innerFace = document.createElementNS(SVG_NS, 'path');
    innerFace.setAttribute('d', MEDAL_HEX_PATH);
    innerFace.setAttribute('transform', 'translate(320 320) scale(0.84) translate(-320 -320)');
    innerFace.setAttribute('fill', `url(#${faceGradId})`);
    innerFace.setAttribute('stroke', 'rgba(255, 255, 255, 0.15)');
    innerFace.setAttribute('stroke-width', '8');
    innerFace.setAttribute('class', 'medal-svg__inner-face');
    svg.appendChild(innerFace);

    // 4. Car-burst crash icon
    const icon = document.createElementNS(SVG_NS, 'g');
    icon.setAttribute('transform', hexScaleTransform(0.58));
    const iconShape = document.createElementNS(SVG_NS, 'path');
    iconShape.setAttribute('d', CRASH_ICON_PATH);
    iconShape.setAttribute('class', 'medal-crash__icon');
    iconShape.setAttribute('fill', `url(#${CRASH_ICON_GRAD_ID})`);
    icon.appendChild(iconShape);
    svg.appendChild(icon);
    return svg;
}

/**
 * @param {{ className?: string }} [options]
 * @returns {HTMLElement}
 */
function buildCrashMedalIcon({ className = '' } = {}) {
    const el = document.createElement('span');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', MEDAL_ARIA.crash);
    el.dataset.tier = 'crash';
    const base = 'medal-svg medal-svg--crash';
    el.className = className ? `${base} ${className}` : base;
    el.appendChild(createCrashMedalSvg());
    return el;
}

/**
 * @param {'author'|'gold'|'silver'|'bronze'|'personal-best'} tier
 * @returns {string|null}
 */
function getMedalTierCaption(tier) {
    return MEDAL_TIER_CAPTION[tier] || null;
}

/**
 * @param {SVGSVGElement} svg
 * @param {string} className
 * @param {string} content
 * @param {string} y
 * @param {string|null} [emblemGradId]
 * @returns {SVGTextElement}
 */
function appendMedalSvgText(svg, className, content, y, emblemGradId = null) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', className);
    let xVal = MEDAL_CENTER_X;
    if (className === 'medal-svg__emblem-text') {
        xVal = '300';
    } else if (className === 'medal-svg__tier-caption') {
        xVal = '310';
    }
    text.setAttribute('x', xVal);
    text.setAttribute('y', y);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    if (emblemGradId) {
        text.setAttribute('fill', `url(#${emblemGradId})`);
    }
    text.textContent = content;
    svg.appendChild(text);
    return text;
}

/**
 * @param {'author'|'gold'|'silver'|'bronze'|'personal-best'} tier
 * @param {SVGSVGElement} svg
 * @param {string|null} [emblemGradId]
 */
function appendMedalTierCaption(tier, svg, emblemGradId = null) {
    const caption = getMedalTierCaption(tier);
    if (!caption) return;
    appendMedalSvgText(svg, 'medal-svg__tier-caption', caption, MEDAL_CAPTION_Y, emblemGradId);
}

const MEDAL_EMBLEM_TIERS = new Set(['bronze', 'silver', 'gold', 'author', 'personal-best']);

/**
 * @param {'author'|'gold'|'silver'|'bronze'|'personal-best'} tier
 * @param {SVGSVGElement} svg
 * @param {string|null} [emblemGradId]
 */
function appendMedalEmblemText(tier, svg, emblemGradId = null) {
    if (!MEDAL_EMBLEM_TIERS.has(tier)) return;
    appendMedalSvgText(svg, 'medal-svg__emblem-text', 'MR', MEDAL_MAIN_TEXT_Y, emblemGradId);
}

/**
 * @param {SVGSVGElement} svg
 * @param {string} label
 * @param {string|null} [emblemGradId]
 */
function appendMedalCenterTime(svg, label, emblemGradId = null) {
    appendMedalSvgText(svg, 'medal-svg__center-time', label, MEDAL_MAIN_TEXT_Y, emblemGradId);
}

/**
 * @param {'author'|'gold'|'silver'|'bronze'|'personal-best'} tier
 * @param {SVGSVGElement} svg
 * @param {{ emblemGradId?: string|null, centerText?: string|null, showEmblem?: boolean }} [options]
 */
function appendMedalCenterContent(tier, svg, { emblemGradId = null, centerText = null, showEmblem = true } = {}) {
    if (centerText != null && centerText !== '') {
        appendMedalCenterTime(svg, centerText, emblemGradId);
        return;
    }
    if (!showEmblem) return;
    appendMedalEmblemText(tier, svg, emblemGradId);
    appendMedalTierCaption(tier, svg, emblemGradId);
}

/**
 * Flat ghost hex for locked row slots (not the 3D unlocked medal).
 * @param {SVGSVGElement} svg
 */
function appendRowPlaceholderInnerFill(svg) {
    const innerFill = document.createElementNS(SVG_NS, 'path');
    innerFill.setAttribute('d', MEDAL_HEX_PATH);
    innerFill.setAttribute('transform', 'translate(320 320) scale(0.8) translate(-320 -320)');
    innerFill.setAttribute('class', 'medal-svg__placeholder-fill');
    svg.appendChild(innerFill);
}

/**
 * @param {'author'|'gold'|'silver'|'bronze'|'personal-best'|'white'|'crash'} tier
 * @param {{ className?: string, outline?: boolean, centerText?: string|null, showEmblem?: boolean, rowPlaceholder?: boolean }} [options]
 * @returns {HTMLElement}
 */
function buildMedalIcon(tier, { className = '', outline = false, centerText = null, showEmblem = true, rowPlaceholder = false } = {}) {
    const cssTier = tier === 'white' ? 'placeholder' : tier;
    const el = document.createElement('span');
    const ariaBase = MEDAL_ARIA[tier] || 'Medal';
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', ariaBase);
    el.dataset.tier = tier;
    const outlineClass = outline ? ' medal-svg--outline' : '';
    const base = `medal-svg medal-svg--${cssTier}${outlineClass}`;
    el.className = className ? `${base} ${className}` : base;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 640 640');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    // Create defs
    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);

    const uniqueId = Math.random().toString(36).substring(2, 9);
    const borderGradId = `medal-border-grad-${uniqueId}`;
    const faceGradId = `medal-face-grad-${uniqueId}`;
    const emblemGradId = `medal-emblem-grad-${uniqueId}`;

    // Define gradients based on the tier (skipped for flat row placeholders)
    let faceStops = [];
    if (tier !== 'white' && !rowPlaceholder) {
        let borderStops = [];
        let emblemStops = [];

        if (tier === 'bronze') {
            borderStops = [
                { offset: '0%', color: '#d0885f' },
                { offset: '35%', color: '#6e3d27' },
                { offset: '70%', color: '#b36f4a' },
                { offset: '100%', color: '#462212' }
            ];
            faceStops = [
                { offset: '0%', color: '#8c5234' },
                { offset: '100%', color: '#4f2814' }
            ];
            emblemStops = [
                { offset: '0%', color: '#ffd3b6' },
                { offset: '100%', color: '#a6603a' }
            ];
        } else if (tier === 'silver') {
            borderStops = [
                { offset: '0%', color: '#ffffff' },
                { offset: '30%', color: '#8a95a5' },
                { offset: '70%', color: '#d5dee9' },
                { offset: '100%', color: '#3a414c' }
            ];
            faceStops = [
                { offset: '0%', color: '#a8b4c4' },
                { offset: '100%', color: '#505b6a' }
            ];
            emblemStops = [
                { offset: '0%', color: '#ffffff' },
                { offset: '100%', color: '#9badc2' }
            ];
        } else if (tier === 'gold') {
            borderStops = [
                { offset: '0%', color: '#ffe484' },
                { offset: '30%', color: '#9a7114' },
                { offset: '70%', color: '#fcd34d' },
                { offset: '100%', color: '#583f05' }
            ];
            faceStops = [
                { offset: '0%', color: '#e5b73c' },
                { offset: '100%', color: '#7a580c' }
            ];
            emblemStops = [
                { offset: '0%', color: '#fff7c2' },
                { offset: '100%', color: '#d99e16' }
            ];
        } else if (tier === 'author') {
            borderStops = [
                { offset: '0%', color: '#ffffff' },
                { offset: '28%', color: '#c4b5fd' },
                { offset: '55%', color: '#67e8f9' },
                { offset: '100%', color: '#3730a3' }
            ];
            faceStops = [
                { offset: '0%', color: '#faf5ff' },
                { offset: '100%', color: '#4338ca' }
            ];
            emblemStops = [
                { offset: '0%', color: '#ffffff' },
                { offset: '100%', color: '#a5b4fc' }
            ];
        } else if (tier === 'personal-best') {
            borderStops = [
                { offset: '0%', color: '#34d399' },
                { offset: '50%', color: '#059669' },
                { offset: '100%', color: '#10b981' }
            ];
            faceStops = [
                { offset: '0%', color: '#059669' },
                { offset: '100%', color: '#064e3b' }
            ];
            emblemStops = [
                { offset: '0%', color: '#ffffff' },
                { offset: '100%', color: '#a7f3d0' }
            ];
        }

        defs.appendChild(createGradient(borderGradId, 'linear', { x1: '0%', y1: '0%', x2: '100%', y2: '100%' }, borderStops));
        defs.appendChild(createGradient(faceGradId, 'radial', { cx: '50%', cy: '40%', r: '60%' }, faceStops));
        defs.appendChild(createGradient(emblemGradId, 'linear', { x1: '0%', y1: '0%', x2: '0%', y2: '100%' }, emblemStops));
    }

    const grooveColor = faceStops.length ? darkenHex(faceStops[0].color) : '#000000';

    if (outline || tier === 'white') {
        if (rowPlaceholder && tier !== 'white') {
            appendRowPlaceholderInnerFill(svg);
            const shape = document.createElementNS(SVG_NS, 'path');
            shape.setAttribute('d', MEDAL_HEX_PATH);
            shape.setAttribute('class', 'medal-svg__shape');
            shape.setAttribute('fill', 'none');
            svg.appendChild(shape);
            appendMedalCenterContent(tier, svg, { emblemGradId: null, centerText, showEmblem: false });
        } else {
            const shape = document.createElementNS(SVG_NS, 'path');
            shape.setAttribute('d', MEDAL_HEX_PATH);
            shape.setAttribute('class', 'medal-svg__shape');

            if (tier === 'white') {
                shape.setAttribute('stroke', '#475569');
                shape.setAttribute('stroke-width', '16');
                shape.setAttribute('stroke-dasharray', '24 16');
                shape.setAttribute('fill', 'none');
            } else {
                shape.setAttribute('stroke', `url(#${borderGradId})`);
                shape.setAttribute('stroke-width', '24');
                shape.setAttribute('stroke-dasharray', '32 16');
                shape.setAttribute('fill', 'none');
            }
            svg.appendChild(shape);
            if (tier !== 'white' && tier !== 'crash') {
                appendMedalCenterContent(tier, svg, { emblemGradId, centerText, showEmblem });
            }
        }
    } else {
        // Filled Medal: render the gorgeous multi-layered 3D metallic style!
        
        // 1. Outer Border
        const outerBorder = document.createElementNS(SVG_NS, 'path');
        outerBorder.setAttribute('d', MEDAL_HEX_PATH);
        outerBorder.setAttribute('fill', `url(#${borderGradId})`);
        outerBorder.setAttribute('class', 'medal-svg__outer-border');
        svg.appendChild(outerBorder);

        // 2. The Groove Shadow
        const groove = document.createElementNS(SVG_NS, 'path');
        groove.setAttribute('d', MEDAL_HEX_PATH);
        groove.setAttribute('transform', 'translate(320 320) scale(0.86) translate(-320 -320)');
        groove.setAttribute('fill', 'none');
        groove.setAttribute('stroke', grooveColor);
        groove.setAttribute('stroke-width', '22');
        svg.appendChild(groove);

        // 3. Inner Face (scaled down with subtle border groove highlight)
        const innerFace = document.createElementNS(SVG_NS, 'path');
        innerFace.setAttribute('d', MEDAL_HEX_PATH);
        innerFace.setAttribute('transform', 'translate(320 320) scale(0.84) translate(-320 -320)');
        innerFace.setAttribute('fill', `url(#${faceGradId})`);
        innerFace.setAttribute('stroke', 'rgba(255, 255, 255, 0.15)');
        innerFace.setAttribute('stroke-width', '8');
        innerFace.setAttribute('class', 'medal-svg__inner-face');
        svg.appendChild(innerFace);

        // 4. Center emblem, tier caption, or unlock time
        if (tier !== 'white' && tier !== 'crash') {
            appendMedalCenterContent(tier, svg, { emblemGradId, centerText, showEmblem });
        }
    }

    el.appendChild(svg);
    return el;
}

/**
 * Combined-results crash hero.
 * @param {{ className?: string }} [options]
 * @returns {HTMLElement}

 */
export function createCrashMedalHeroIcon({ className = '' } = {}) {
    const heroClass = className
        ? `medal-svg--hero medal-pile-icon--deferred ${className}`
        : 'medal-svg--hero medal-pile-icon--deferred';
    return buildCrashMedalIcon({ className: heroClass });
}

/**
 * @param {'author'|'gold'|'silver'|'bronze'|'personal-best'|'white'|null|undefined} medal
 * @param {{ className?: string, outline?: boolean, centerText?: string|null, showEmblem?: boolean, rowPlaceholder?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function createMedalIconSvg(medal, { className = '', outline = false, centerText = null, showEmblem = true, rowPlaceholder = false } = {}) {
    const isKnownTier =
        medal === 'author'
        || medal === 'gold'
        || medal === 'silver'
        || medal === 'bronze'
        || medal === 'personal-best';
    const tier = isKnownTier ? medal : 'white';
    const options = { className, outline, centerText, showEmblem, rowPlaceholder };
    const cacheKey = getMedalTemplateCacheKey(tier, options);
    const cached = cloneCachedMedalIcon(medalIconTemplateCache.get(cacheKey));
    if (cached) return cached;

    const template = buildMedalIcon(tier, options);
    if (typeof template.cloneNode !== 'function') return template;
    rememberMedalIconTemplate(cacheKey, template);
    return cloneCachedMedalIcon(template) || buildMedalIcon(tier, options);
}
