import { createHash } from 'node:crypto';
import { normalizeName } from './value-guards.js';

export function redisKeyPart(value: string): string {
    return encodeURIComponent(normalizeName(value));
}

export function playerFieldHash(playerId: string): string {
    return createHash('sha256').update(playerId, 'utf8').digest('base64url');
}
