export function progressTransferPendingReply() {
    return {
        status: 503 as const,
        body: {
            accepted: false as const,
            error: 'A progress transfer is in progress. Retrying automatically.',
            reason: 'progress_transfer_pending' as const,
            retryAfterSeconds: 1,
        },
    };
}
