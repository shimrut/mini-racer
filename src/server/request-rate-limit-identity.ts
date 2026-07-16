import { createHash } from 'node:crypto';

function normalizeContextIdentity(value: unknown): string | null {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

export function createRequestRateLimitIdentity({
    loid,
    userId,
}: {
    loid?: unknown;
    userId?: unknown;
}): string | null {
    const normalizedLoid = normalizeContextIdentity(loid);
    const normalizedUserId = normalizeContextIdentity(userId);
    const source = normalizedLoid
        ? `loid:${normalizedLoid}`
        : normalizedUserId
            ? `user:${normalizedUserId}`
            : null;

    if (!source) {
        return null;
    }

    return createHash('sha256')
        .update(`mini-racer:daily-submit:v1:${source}`, 'utf8')
        .digest('base64url');
}
