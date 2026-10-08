import { isRecord } from '../shared/value-guards.js';

// Keys that can hold an old post's replay text, in the order the readers try them.
const FALLBACK_TEXT_KEYS = [
    'text',
    'markdown',
    'raw',
    'value',
    'body',
    'selftext',
    'textFallback',
    'richtextFallback',
] as const;

function collectFallbackTexts(value: unknown, texts: string[], depth = 0): void {
    if (depth > 4) return;
    if (typeof value === 'string') {
        if (value && !texts.includes(value)) texts.push(value);
        const first = value.trimStart()[0];
        if (first === '{' || first === '[' || first === '"') {
            try {
                collectFallbackTexts(JSON.parse(value), texts, depth + 1);
            } catch {
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectFallbackTexts(item, texts, depth + 1);
        return;
    }
    if (!isRecord(value)) return;
    for (const key of FALLBACK_TEXT_KEYS) {
        if (key in value) collectFallbackTexts(value[key], texts, depth + 1);
    }
}

export function postFallbackTexts(post: unknown): string[] {
    if (!isRecord(post)) return [];
    const texts: string[] = [];
    for (const key of ['body', 'selftext', 'textFallback', 'richtextFallback'] as const) {
        collectFallbackTexts(post[key], texts);
    }
    if (typeof post.toJSON === 'function') {
        try {
            collectFallbackTexts((post as { toJSON: () => unknown }).toJSON(), texts);
        } catch {
        }
    }
    return texts;
}
