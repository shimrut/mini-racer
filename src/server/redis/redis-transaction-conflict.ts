export function isRedisTransactionConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const { message, details } = error as { message?: unknown; details?: unknown };
    return [message, details].some(
        (text) => typeof text === 'string' && text.includes('redis: transaction failed'),
    );
}
