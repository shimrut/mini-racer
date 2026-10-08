import { describe, expect, it } from 'vitest';
import { postFallbackTexts } from '../src/server/posts/post-fallback-texts.ts';

// Pins which texts the reader finds in old post shapes, and their order.
describe('post fallback texts', () => {
    it('reads nothing from a value that is not a post', () => {
        expect(postFallbackTexts(null)).toEqual([]);
        expect(postFallbackTexts('body')).toEqual([]);
        expect(postFallbackTexts(['body'])).toEqual([]);
    });

    it('reads the post text fields in a fixed order, then toJSON', () => {
        expect(postFallbackTexts({
            toJSON: () => ({ selftext: 'from toJSON' }),
            richtextFallback: 'richtext',
            textFallback: 'text fallback',
            selftext: 'selftext',
            body: 'body',
        })).toEqual(['body', 'selftext', 'text fallback', 'richtext', 'from toJSON']);
    });

    it('reads nested text keys, arrays and JSON inside a string', () => {
        expect(postFallbackTexts({ textFallback: { text: 'T' } })).toEqual(['T']);
        expect(postFallbackTexts({
            richtextFallback: { markdown: 'M', raw: { value: 'V' }, body: ['A', { selftext: 'S' }] },
        })).toEqual(['M', 'V', 'A', 'S']);
        expect(postFallbackTexts({ selftext: JSON.stringify({ text: 'A' }) }))
            .toEqual(['{"text":"A"}', 'A']);
        expect(postFallbackTexts({ body: '  ["A", {"markdown": "B"}]' }))
            .toEqual(['  ["A", {"markdown": "B"}]', 'A', 'B']);
        expect(postFallbackTexts({ body: JSON.stringify(JSON.stringify('quoted')) }))
            .toEqual(['"\\"quoted\\""', '"quoted"', 'quoted']);
    });

    it('keeps each text once, and skips empty text, bad JSON and other keys', () => {
        expect(postFallbackTexts({ body: 'same', selftext: 'same', textFallback: { text: 'same' } }))
            .toEqual(['same']);
        expect(postFallbackTexts({ body: '', selftext: { text: '' } })).toEqual([]);
        expect(postFallbackTexts({ body: '{not json' })).toEqual(['{not json']);
        expect(postFallbackTexts({ title: 'title', body: { title: 'nested title', id: 7 } })).toEqual([]);
    });

    it('stops five levels below a post field', () => {
        expect(postFallbackTexts({ body: { text: { text: { text: { text: 'four' } } } } }))
            .toEqual(['four']);
        expect(postFallbackTexts({ body: { text: { text: { text: { text: { text: 'five' } } } } } }))
            .toEqual([]);
    });

    it('keeps the field texts when toJSON throws or is not a function', () => {
        expect(postFallbackTexts({
            body: 'body',
            toJSON: () => { throw new Error('No JSON.'); },
        })).toEqual(['body']);
        expect(postFallbackTexts({ body: 'body', toJSON: { selftext: 'ignored' } })).toEqual(['body']);
    });
});
