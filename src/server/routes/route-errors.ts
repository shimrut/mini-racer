import type { Response } from 'express';
import { TrackPlacementRetryError } from '../tracks/track-placement-lock.js';

// An unknown live layout answers 503 so the game offers Retry; other errors keep the route's 500.
export function sendFailure(res: Response, error: unknown, body: Record<string, unknown>): void {
    if (error instanceof TrackPlacementRetryError) {
        res.status(503).json({ ...body, error: error.message });
        return;
    }
    res.status(500).json(body);
}
