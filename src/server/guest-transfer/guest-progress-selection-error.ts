export const PROGRESS_SELECTION_RETRYABLE_REASON = 'progress_selection_retryable' as const;

export class GuestProgressSelectionRetryableError extends Error {
    readonly statusCode = 503;
    readonly reason = PROGRESS_SELECTION_RETRYABLE_REASON;

    constructor(message = 'Your save is busy. Wait a moment, then try again.') {
        super(message);
        this.name = 'GuestProgressSelectionRetryableError';
    }
}

export const PROGRESS_SELECTION_RECOVERY_REASON = 'guest_progress_recovery_required' as const;

export class GuestProgressRecoveryRequiredError extends Error {
    readonly statusCode = 409;
    readonly reason = PROGRESS_SELECTION_RECOVERY_REASON;

    constructor(message = 'This progress transfer needs support before it can be retried.') {
        super(message);
        this.name = 'GuestProgressRecoveryRequiredError';
    }
}

export const PROGRESS_SELECTION_CONTINUE_REASON = 'progress_selection_continue' as const;

// A transfer with many Daily days works in pieces, one request at a time. It
// saved its position; the client resumes the same transfer at once.
export class GuestProgressSelectionContinueError extends Error {
    readonly statusCode = 503;
    readonly reason = PROGRESS_SELECTION_CONTINUE_REASON;

    constructor(readonly transferId: string) {
        super('Moving your progress. Continuing…');
        this.name = 'GuestProgressSelectionContinueError';
    }
}
