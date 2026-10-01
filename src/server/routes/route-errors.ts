import type { Response } from 'express';
import { TrackPlacementRetryError } from '../tracks/track-placement-lock.js';

// A request that cannot know which track layout is live answers 503 with the
// retry message, so the game offers Retry. Any other error keeps the route's
// own 500 answer.
export function sendFailure(res: Response, error: unknown, body: Record<string, unknown>): void {
    if (error instanceof TrackPlacementRetryError) {
        res.status(503).json({ ...body, error: error.message });
        return;
    }
    res.status(500).json(body);
}
