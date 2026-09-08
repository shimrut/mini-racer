export const PROGRESS_SELECTION_RETRYABLE_REASON = 'progress_selection_retryable' as const;

/**
 * A transfer was unable to complete because one of its short-lived ownership
 * locks was busy, lost, or fenced by Redis. The caller can safely retry the
 * same choice because transfer checkpoints keep the source intact until the
 * corresponding domain has completed.
 */
export class GuestProgressSelectionRetryableError extends Error {
    readonly statusCode = 503;
    readonly reason = PROGRESS_SELECTION_RETRYABLE_REASON;

    constructor(message = 'Your save is busy. Wait a moment, then try again.') {
        super(message);
        this.name = 'GuestProgressSelectionRetryableError';
    }
}
