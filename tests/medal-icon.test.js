import { describe, expect, it, vi } from 'vitest';
import { createMedalIconSvg } from '../game/medals/medal-icon.js';

function createMockElement(tagName, namespace = null) {
    const children = [];
    const attributes = {};
    const mockEl = {
        tagName,
        namespace,
        children,
        attributes,
        dataset: {},
        className: '',
        classList: {
            classes: new Set(),
            add(cls) {
                this.classes.add(cls);
                mockEl.className = Array.from(this.classes).join(' ');
                mockEl.attributes['class'] = mockEl.className;
            },
            remove(cls) {
                this.classes.delete(cls);
                mockEl.className = Array.from(this.classes).join(' ');
                mockEl.attributes['class'] = mockEl.className;
            }
        },
        setAttribute(name, val) {
            this.attributes[name] = String(val);
            if (name === 'class') {
                this.className = String(val);
                this.classList.classes = new Set(String(val).split(/\s+/));
            }
        },
        getAttribute(name) {
            return this.attributes[name] || null;
        },
        appendChild(child) {
            children.push(child);
            return child;
        },
        append(...nodes) {
            children.push(...nodes);
        },
        querySelector(selector) {
            if (selector.startsWith('.')) {
                const cls = selector.slice(1);
                return children.find(c => c.classList?.classes?.has(cls) || c.className?.includes(cls)) || null;
            }
            if (selector.startsWith('linearGradient')) {
                return children.find(c => c.tagName === 'linearGradient') || null;
            }
            return null;
        },
        cloneNode(deep = false) {
            const clone = createMockElement(tagName, namespace);
            for (const [name, value] of Object.entries(attributes)) {
                if (typeof value === 'function') continue;
                clone.setAttribute(name, value);
            }
            clone.className = this.className;
            clone.textContent = this.textContent;
            clone.dataset = { ...this.dataset };
            if (deep) {
                for (const child of children) {
                    clone.appendChild(child.cloneNode ? child.cloneNode(true) : child);
                }
            }
            return clone;
        },
        remove() {
        }
    };
    attributes[Symbol.iterator] = function* iterateAttributes() {
        for (const [name, value] of Object.entries(attributes)) {
            if (name === Symbol.iterator.toString() || typeof value === 'function') continue;
            yield { name, value };
        }
    };
    return mockEl;
}

function findAll(node, predicate, matches = []) {
    if (predicate(node)) matches.push(node);
    for (const child of node.children || []) {
        findAll(child, predicate, matches);
    }
    return matches;
}

describe('medal-icon', () => {
    it('shows MR emblem on all standard medal tiers', () => {
        const originalDocument = global.document;
        global.document = {
            createElement: vi.fn((tag) => createMockElement(tag)),
            createElementNS: vi.fn((ns, tag) => createMockElement(tag, ns))
        };

        try {
            for (const tier of ['bronze', 'silver', 'gold', 'author', 'personal-best', 'challenge']) {
                const icon = createMedalIconSvg(tier);
                const svg = icon.children[0];
                const emblem = svg.children.find(c => c.className === 'medal-svg__emblem-text');
                expect(emblem, tier).toBeDefined();
                expect(emblem.textContent, tier).toBe('MR');
                expect(svg.children.find(c => c.className === 'medal-svg__label'), tier).toBeUndefined();
            }
            const challenge = createMedalIconSvg('challenge');
            expect(challenge.getAttribute('aria-label')).toBe('Challenge beaten');
            expect(challenge.dataset.tier).toBe('challenge');
            const challengeCaption = challenge.children[0].children.find(
                (c) => c.className === 'medal-svg__tier-caption',
            );
            expect(challengeCaption?.textContent).toBe('beat');
        } finally {
            global.document = originalDocument;
        }
    });

    it('keeps cloned gradient references pointed at cloned defs', () => {
        const originalDocument = global.document;
        global.document = {
            createElement: vi.fn((tag) => createMockElement(tag)),
            createElementNS: vi.fn((ns, tag) => createMockElement(tag, ns))
        };

        try {
            createMedalIconSvg('gold');
            const icon = createMedalIconSvg('gold');
            const svg = icon.children[0];
            const defs = svg.children.find((child) => child.tagName === 'defs');
            const gradientIds = new Set(findAll(defs, (node) => node.getAttribute?.('id')).map((node) => node.getAttribute('id')));
            const fillRefs = findAll(svg, (node) => /^url\(#.+\)$/.test(node.getAttribute?.('fill') || ''))
                .map((node) => node.getAttribute('fill').slice(5, -1));

            expect(fillRefs.length).toBeGreaterThan(0);
            for (const ref of fillRefs) {
                expect(gradientIds.has(ref)).toBe(true);
            }
        } finally {
            global.document = originalDocument;
        }
    });
});
