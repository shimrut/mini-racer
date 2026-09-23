import { createHash } from 'node:crypto';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isRedditPostId(value: unknown): value is `t3_${string}` {
    return typeof value === 'string' && value.startsWith('t3_');
}

export function hasText(value: unknown): boolean {
    return typeof value === 'string' && Boolean(value.trim());
}

export function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
