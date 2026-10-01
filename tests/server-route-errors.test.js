import { describe, expect, it, vi } from 'vitest';
import { sendFailure } from '../src/server/routes/route-errors.ts';
import { TrackPlacementRetryError } from '../src/server/tracks/track-placement-lock.ts';

function response() {
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    return res;
}

describe('route failures', () => {
    it('answers a track that cannot be confirmed with 503 and the retry message', () => {
        const res = response();
        sendFailure(res, new TrackPlacementRetryError('The tracks could not load. Try again.'), {
            accepted: false,
            error: 'Daily challenge submit failed',
        });
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith({ accepted: false, error: 'The tracks could not load. Try again.' });
    });

    it('keeps the route answer for any other failure', () => {
        const res = response();
        sendFailure(res, new Error('redis: timeout'), { accepted: false, error: 'Daily challenge submit failed' });
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ accepted: false, error: 'Daily challenge submit failed' });
    });
});
