import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { redis } from '@devvit/redis';

const GUEST_PLAYER_TOKEN_SECRET_KEY = 'dailygp:guest-player-token-secret';
const GUEST_PLAYER_TOKEN_VERSION = 'v1';

function normalizeGuestPlayerId(value: unknown): string | null {
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : null;
}

async function getGuestPlayerTokenSecret(): Promise<string> {
    const existingSecret = await redis.get(GUEST_PLAYER_TOKEN_SECRET_KEY);
    if (existingSecret) {
        return existingSecret;
    }

    const nextSecret = randomBytes(32).toString('base64url');
    await redis.set(GUEST_PLAYER_TOKEN_SECRET_KEY, nextSecret, { nx: true });
    return (await redis.get(GUEST_PLAYER_TOKEN_SECRET_KEY)) || nextSecret;
}

async function signGuestPlayerId(guestPlayerId: string): Promise<string> {
    const secret = await getGuestPlayerTokenSecret();
    return createHmac('sha256', secret)
        .update(guestPlayerId, 'utf8')
        .digest('base64url');
}

export async function mintGuestPlayerToken(guestPlayerId: unknown): Promise<string | null> {
    const normalizedGuestPlayerId = normalizeGuestPlayerId(guestPlayerId);
    if (!normalizedGuestPlayerId) {
        return null;
    }

    const signature = await signGuestPlayerId(normalizedGuestPlayerId);
    return `${GUEST_PLAYER_TOKEN_VERSION}.${normalizedGuestPlayerId}.${signature}`;
}

export async function verifyGuestPlayerToken(token: unknown): Promise<string | null> {
    if (typeof token !== 'string' || !token.trim()) {
        return null;
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3) {
        return null;
    }

    const [version, guestPlayerId, providedSignature] = parts;
    if (version !== GUEST_PLAYER_TOKEN_VERSION) {
        return null;
    }

    const normalizedGuestPlayerId = normalizeGuestPlayerId(guestPlayerId);
    if (!normalizedGuestPlayerId || !providedSignature) {
        return null;
    }

    const expectedSignature = await signGuestPlayerId(normalizedGuestPlayerId);
    const providedBuffer = Buffer.from(providedSignature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    if (providedBuffer.length !== expectedBuffer.length) {
        return null;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer)
        ? normalizedGuestPlayerId
        : null;
}
