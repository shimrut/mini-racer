import { describe, expect, it } from 'vitest';
import {
    clearPendingMedalText,
    copyPendingMedalText,
    hasPendingMedalText,
    medalFieldText,
    movePendingMedalText,
    readPendingMedalText,
    setPendingMedalText,
} from '../tools/mapmaker/pending-medal-text.js';

describe('typed medal text', () => {
    it('keeps blank and partial text for each track and medal', () => {
        const pending = new Map();
        setPendingMedalText(pending, 'nightLoop', 'gold', '');
        setPendingMedalText(pending, 'nightLoop', 'silver', '1');
        setPendingMedalText(pending, 'dayLoop', 'gold', '13');
        expect(readPendingMedalText(pending, 'nightLoop', 'gold')).toBe('');
        expect(readPendingMedalText(pending, 'nightLoop', 'silver')).toBe('1');
        expect(readPendingMedalText(pending, 'dayLoop', 'gold')).toBe('13');
        expect(readPendingMedalText(pending, 'dayLoop', 'silver')).toBeUndefined();
        expect(hasPendingMedalText(pending, 'nightLoop')).toBe(true);
        expect(hasPendingMedalText(pending, 'otherLoop')).toBe(false);
    });

    it('shows the typed text, else the medal time', () => {
        expect(medalFieldText('', 12)).toBe('');
        expect(medalFieldText('1', 12)).toBe('1');
        expect(medalFieldText(undefined, 12)).toBe('12.00');
        expect(medalFieldText(undefined, 0)).toBe('');
        expect(medalFieldText(undefined, undefined)).toBe('');
    });

    it('clears some medals or a whole track, and moves with a renamed track', () => {
        const pending = new Map();
        setPendingMedalText(pending, 'nightLoop', 'gold', '13');
        setPendingMedalText(pending, 'nightLoop', 'author', '');
        clearPendingMedalText(pending, 'nightLoop', ['author']);
        expect(readPendingMedalText(pending, 'nightLoop', 'author')).toBeUndefined();
        expect(readPendingMedalText(pending, 'nightLoop', 'gold')).toBe('13');
        const copy = copyPendingMedalText(pending, 'nightLoop');
        movePendingMedalText(pending, 'nightLoop', 'nightRun');
        expect(hasPendingMedalText(pending, 'nightLoop')).toBe(false);
        expect(readPendingMedalText(pending, 'nightRun', 'gold')).toBe('13');
        clearPendingMedalText(pending, 'nightRun');
        expect(hasPendingMedalText(pending, 'nightRun')).toBe(false);
        expect(copy.get('gold')).toBe('13');
        clearPendingMedalText(pending, 'nightLoop', ['gold']);
        expect(pending.size).toBe(0);
    });
});
