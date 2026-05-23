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
        remove() {
            // noop
        }
    };
    return mockEl;
}

describe('medal-icon', () => {
    it('shows MR emblem on all standard medal tiers', () => {
        const originalDocument = global.document;
        global.document = {
            createElement: vi.fn((tag) => createMockElement(tag)),
            createElementNS: vi.fn((ns, tag) => createMockElement(tag, ns))
        };

        try {
            for (const tier of ['bronze', 'silver', 'gold', 'author', 'personal-best']) {
                const icon = createMedalIconSvg(tier);
                const svg = icon.children[0];
                const emblem = svg.children.find(c => c.className === 'medal-svg__emblem-text');
                expect(emblem, tier).toBeDefined();
                expect(emblem.textContent, tier).toBe('MR');
                expect(svg.children.find(c => c.className === 'medal-svg__label'), tier).toBeUndefined();
            }
        } finally {
            global.document = originalDocument;
        }
    });
});
