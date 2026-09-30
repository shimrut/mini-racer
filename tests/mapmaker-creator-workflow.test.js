import { describe, expect, it } from 'vitest';
import {
    clearCreatorLap,
    completedCreatorLapSignature,
    recordCreatorLap,
} from '../tools/mapmaker/creator-workflow.js';
import { trackLayoutHash } from '../tools/mapmaker/medal-times.js';

function storage() {
    const values = new Map();
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, value); },
        removeItem(key) { values.delete(key); },
    };
}

describe('moderator Creator Test Drive completion', () => {
    it('recognizes a completed lap only for the acknowledged saved layout', () => {
        const store = storage();
        const track = { name: 'Circuit', outer: [{ x: 0, y: 0 }], ground: 'dirt' };
        const signature = 'server-sha-256';
        const driven = { track, creatorSignature: signature, creatorLayoutHash: trackLayoutHash(track) };
        recordCreatorLap(store, driven, 12.345);
        expect(completedCreatorLapSignature(store, { track, geometrySignature: signature })).toBe(signature);
        expect(completedCreatorLapSignature(store, {
            track: { ...track, ground: 'snow' }, geometrySignature: signature,
        })).toBeNull();
        expect(completedCreatorLapSignature(store, { track, geometrySignature: 'another-save' })).toBeNull();
        clearCreatorLap(store);
        expect(completedCreatorLapSignature(store, { track, geometrySignature: signature })).toBeNull();
    });

    it('rejects a changed Test Drive layout or unavailable storage', () => {
        const track = { name: 'Circuit', outer: [{ x: 0, y: 0 }] };
        const driven = { track, creatorSignature: 'saved', creatorLayoutHash: trackLayoutHash(track) };
        track.outer[0].x = 2;
        expect(() => recordCreatorLap(storage(), driven, 10)).toThrow('no longer matches');
        track.outer[0].x = 0;
        expect(() => recordCreatorLap({ setItem() { throw new Error('storage unavailable'); } }, driven, 10))
            .toThrow('storage unavailable');
        expect(completedCreatorLapSignature({ getItem() { throw new Error('denied'); } }, {
            track, geometrySignature: 'saved',
        })).toBeNull();
    });
});
