/**
 * Reddit reports a lost WATCH race as a gRPC error with no error type to match on, only the
 * message. Every fenced write in this app has to recognise it, so the match lives here instead
 * of being restated per store.
 */
export function isRedisTransactionConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const { message, details } = error as { message?: unknown; details?: unknown };
    return [message, details].some(
        (text) => typeof text === 'string' && text.includes('redis: transaction failed'),
    );
}
