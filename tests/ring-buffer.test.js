import { describe, expect, it, vi } from 'vitest';
import { RingBuffer } from '../game/race/ring-buffer.js';

describe('RingBuffer', () => {
    it('pre-allocates slots once and reuses them while overwriting the oldest entry', () => {
        const factory = vi.fn(() => ({ x: 0, y: 0 }));
        const buffer = new RingBuffer(3, factory);

        expect(factory).toHaveBeenCalledTimes(3);
        expect(buffer.length).toBe(0);
        expect(buffer.last()).toBe(null);
        expect(buffer.version).toBe(0);

        const first = buffer.write();
        first.x = 1;
        first.y = 10;
        expect(buffer.version).toBe(1);

        const second = buffer.write();
        second.x = 2;
        second.y = 20;
        expect(buffer.version).toBe(2);

        const third = buffer.write();
        third.x = 3;
        third.y = 30;
        expect(buffer.version).toBe(3);

        expect(buffer.length).toBe(3);
        expect(buffer.get(0)).toBe(first);
        expect(buffer.get(1)).toBe(second);
        expect(buffer.get(2)).toBe(third);
        expect(buffer.last()).toBe(third);
        expect(buffer.toArray()).toEqual([
            { x: 1, y: 10 },
            { x: 2, y: 20 },
            { x: 3, y: 30 }
        ]);

        const overwritten = buffer.write();
        overwritten.x = 4;
        overwritten.y = 40;
        expect(buffer.version).toBe(4);

        expect(overwritten).toBe(first);
        expect(factory).toHaveBeenCalledTimes(3);
        expect(buffer.length).toBe(3);
        expect(buffer.get(0)).toBe(second);
        expect(buffer.get(1)).toBe(third);
        expect(buffer.get(2)).toBe(first);
        expect(buffer.last()).toBe(first);
        expect(buffer.toArray()).toEqual([
            { x: 2, y: 20 },
            { x: 3, y: 30 },
            { x: 4, y: 40 }
        ]);
    });

    it('clears logical contents without discarding allocated slots', () => {
        const buffer = new RingBuffer(2, () => ({ x: 0, y: 0 }));
        const first = buffer.write();
        first.x = 7;
        first.y = 8;

        buffer.clear();

        expect(buffer.length).toBe(0);
        expect(buffer.last()).toBe(null);
        expect(buffer.toArray()).toEqual([]);
        expect(buffer.version).toBe(2);

        const reused = buffer.write();
        expect(reused).toBe(first);
        expect(buffer.version).toBe(3);
    });
});
