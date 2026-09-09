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

export const PROGRESS_SELECTION_RECOVERY_REASON = 'guest_progress_recovery_required' as const;

/**
 * The transfer cannot continue on its own. Its evidence is missing, changed, or points at
 * another account, so no retry can make the next step safe. The records stay as they are for a
 * reviewed repair. This is never a retry.
 */
export class GuestProgressRecoveryRequiredError extends Error {
    readonly statusCode = 409;
    readonly reason = PROGRESS_SELECTION_RECOVERY_REASON;

    constructor(message = 'This progress transfer needs support before it can be retried.') {
        super(message);
        this.name = 'GuestProgressRecoveryRequiredError';
    }
}
