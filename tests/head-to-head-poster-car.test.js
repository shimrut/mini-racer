import { describe, expect, it, vi } from 'vitest';

const carImage = { width: 8, height: 8 };

vi.mock('../game/track/poster-car.js', async () => {
    const actual = await vi.importActual('../game/track/poster-car.js');
    return {
        ...actual,
        loadPosterCar: () => Promise.resolve(carImage),
    };
});

vi.mock('../game/track/preview-renderer.js', () => ({
    renderTrackPreviewCanvas: vi.fn(),
}));

const { renderTrackPreviewCanvas } = await import('../game/track/preview-renderer.js');
const { bootHeadToHead } = await import('../head-to-head.js');

describe('head to head poster car', () => {
    it('draws the stock car at the back of the dash once the picture loads', async () => {
        const canvas = {
            width: 0,
            height: 0,
            getBoundingClientRect: () => ({ width: 320, height: 200 }),
        };
        const documentRef = {
            body: {
                setAttribute() {},
                removeAttribute() {},
            },
            getElementById(id) {
                return id === 'challenge-track' ? canvas : null;
            },
        };
        globalThis.requestAnimationFrame = () => 1;
        globalThis.cancelAnimationFrame = () => {};

        bootHeadToHead(documentRef, {
            devvit: {
                context: {
                    postData: {
                        postType: 'head-to-head',
                        challengeId: 'challenge-1',
                        trackKey: 'numberThree',
                        lapCount: 1,
                        targetTimeMs: 12_600,
                        challengerUsername: 'RaceFan',
                    },
                },
            },
        });
        await Promise.resolve();

        expect(renderTrackPreviewCanvas).toHaveBeenLastCalledWith(canvas, expect.objectContaining({
            schematicCarImage: carImage,
            schematicCarTravel: 0,
            schematicReserveCarSlot: true,
            showSchematicCarTrail: true,
            hideSchematicStartArrow: true,
        }));
    });
});
