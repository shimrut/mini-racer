import { reddit } from '@devvit/web/server';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isValidPbGhostTrace, type PbGhostTrace } from './pb-ghost-trace.js';

export const DAILY_PODIUM_REPLAY_MARKER = 'Podium replay data:';
export const DAILY_PODIUM_REPLAY_FORMAT = 'MINIRACER-PODIUM-REPLAY-V1';

const COMPRESSED_PREFIX = '__gz:b64url__:';
export const DAILY_PODIUM_REPLAY_MAX_FALLBACK_CHARS = 40_000;
const MAX_PAYLOAD_CHARS = DAILY_PODIUM_REPLAY_MAX_FALLBACK_CHARS;
const MAX_DECOMPRESSED_BYTES = 384 * 1024;

export type DailyPodiumReplayGhostSlot = {
    rank: 1 | 2 | 3;
    ghost: PbGhostTrace | null;
};

export type DailyPodiumReplayEnvelope = {
    format: typeof DAILY_PODIUM_REPLAY_FORMAT;
    challengeId: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    trackFingerprint: string;
    ghosts: readonly [
        DailyPodiumReplayGhostSlot,
        DailyPodiumReplayGhostSlot,
        DailyPodiumReplayGhostSlot,
    ];
};

export type EncodedDailyPodiumReplay = {
    envelope: DailyPodiumReplayEnvelope;
    token: string;
    hash: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLapCount(value: unknown): value is 1 | 2 | 3 {
    return value === 1 || value === 2 || value === 3;
}

function isRank(value: unknown): value is 1 | 2 | 3 {
    return value === 1 || value === 2 || value === 3;
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function emptySlot(rank: 1 | 2 | 3): DailyPodiumReplayGhostSlot {
    return { rank, ghost: null };
}

export function sanitizePodiumReplayGhosts(
    slots: readonly DailyPodiumReplayGhostSlot[] | null | undefined,
): DailyPodiumReplayEnvelope['ghosts'] {
    const byRank = new Map<1 | 2 | 3, PbGhostTrace | null>();
    for (const slot of slots ?? []) {
        if (!isRank(slot?.rank) || byRank.has(slot.rank)) continue;
        byRank.set(slot.rank, isValidPbGhostTrace(slot.ghost) ? slot.ghost : null);
    }
    return [
        { rank: 1, ghost: byRank.get(1) ?? null },
        { rank: 2, ghost: byRank.get(2) ?? null },
        { rank: 3, ghost: byRank.get(3) ?? null },
    ];
}

export function podiumReplayHasGhost(
    ghosts: DailyPodiumReplayEnvelope['ghosts'],
): boolean {
    return ghosts.some((slot) => slot.ghost !== null);
}

function isPodiumReplayEnvelope(value: unknown): value is DailyPodiumReplayEnvelope {
    if (!isRecord(value)) return false;
    if (
        value.format !== DAILY_PODIUM_REPLAY_FORMAT
        || typeof value.challengeId !== 'string'
        || !value.challengeId
        || typeof value.trackKey !== 'string'
        || !value.trackKey
        || !isLapCount(value.lapCount)
        || typeof value.trackFingerprint !== 'string'
        || !value.trackFingerprint
        || !Array.isArray(value.ghosts)
        || value.ghosts.length !== 3
    ) {
        return false;
    }
    const ghosts = sanitizePodiumReplayGhosts(value.ghosts as DailyPodiumReplayGhostSlot[]);
    return ghosts.every((slot, index) => {
        const raw = value.ghosts[index];
        return isRecord(raw) && raw.rank === slot.rank;
    });
}

function encodeEnvelope(envelope: DailyPodiumReplayEnvelope): string {
    const json = JSON.stringify(envelope);
    if (!json) throw new Error('Podium replay could not be serialized.');
    const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    return `${DAILY_PODIUM_REPLAY_FORMAT}\n${COMPRESSED_PREFIX}${compressed.toString('base64url')}`;
}

export function encodeDailyPodiumReplay(input: {
    challengeId: string;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    trackFingerprint: string;
    ghosts: readonly DailyPodiumReplayGhostSlot[];
}): EncodedDailyPodiumReplay {
    const ghosts = sanitizePodiumReplayGhosts(input.ghosts);
    if (!podiumReplayHasGhost(ghosts)) {
        throw new Error('Podium replay has no verified ghosts.');
    }
    const envelope: DailyPodiumReplayEnvelope = {
        format: DAILY_PODIUM_REPLAY_FORMAT,
        challengeId: input.challengeId,
        trackKey: input.trackKey,
        lapCount: input.lapCount,
        trackFingerprint: input.trackFingerprint,
        ghosts,
    };
    const token = encodeEnvelope(envelope);
    if (token.length > MAX_PAYLOAD_CHARS) {
        throw new Error('Podium replay exceeds the Reddit text fallback limit.');
    }
    return { envelope, token, hash: sha256(token) };
}

function extractToken(text: string): string | null {
    if (typeof text !== 'string' || text.length > DAILY_PODIUM_REPLAY_MAX_FALLBACK_CHARS) return null;
    const markerIndex = text.indexOf(DAILY_PODIUM_REPLAY_MARKER);
    if (markerIndex < 0) return null;
    const payload = text.slice(markerIndex + DAILY_PODIUM_REPLAY_MARKER.length);
    const tokenPattern = new RegExp(
        `${DAILY_PODIUM_REPLAY_FORMAT}\\s*\\r?\\n(${COMPRESSED_PREFIX}[A-Za-z0-9_-]+)`,
    );
    const compressedToken = payload.match(tokenPattern)?.[1] ?? null;
    return compressedToken ? `${DAILY_PODIUM_REPLAY_FORMAT}\n${compressedToken}` : null;
}

export function decodeDailyPodiumReplay(
    text: string,
    expected: { challengeId: string; lapCount?: 1 | 2 | 3; replayDataHash?: string } | null = null,
): { decoded: EncodedDailyPodiumReplay | null; reason?: string } {
    const token = extractToken(text);
    if (!token || token.length > MAX_PAYLOAD_CHARS) {
        return { decoded: null, reason: 'replay_token_not_found' };
    }
    if (expected?.replayDataHash && expected.replayDataHash !== sha256(token)) {
        return { decoded: null, reason: 'replay_hash_mismatch' };
    }
    const encodedLine = token.split('\n')[1] || '';
    const encoded = encodedLine.slice(COMPRESSED_PREFIX.length);
    try {
        const compressed = Buffer.from(encoded, 'base64url');
        const json = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
            .toString('utf8');
        const parsed = JSON.parse(json);
        if (!isPodiumReplayEnvelope(parsed)) {
            return { decoded: null, reason: 'replay_envelope_invalid' };
        }
        const envelope: DailyPodiumReplayEnvelope = {
            ...parsed,
            ghosts: sanitizePodiumReplayGhosts(parsed.ghosts),
        };
        if (expected?.challengeId && envelope.challengeId !== expected.challengeId) {
            return { decoded: null, reason: 'replay_contract_mismatch' };
        }
        if (expected?.lapCount && envelope.lapCount !== expected.lapCount) {
            return { decoded: null, reason: 'replay_contract_mismatch' };
        }
        return { decoded: { envelope, token, hash: sha256(token) } };
    } catch {
        return { decoded: null, reason: 'replay_decompress_failed' };
    }
}

const FALLBACK_TEXT_KEYS = [
    'text',
    'markdown',
    'raw',
    'value',
    'body',
    'selftext',
    'textFallback',
    'richtextFallback',
] as const;

function collectFallbackTexts(value: unknown, texts: string[], depth = 0): void {
    if (depth > 4) return;
    if (typeof value === 'string') {
        if (value && !texts.includes(value)) texts.push(value);
        const first = value.trimStart()[0];
        if (first === '{' || first === '[' || first === '"') {
            try {
                collectFallbackTexts(JSON.parse(value), texts, depth + 1);
            } catch {
            }
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectFallbackTexts(item, texts, depth + 1);
        return;
    }
    if (!isRecord(value)) return;
    for (const key of FALLBACK_TEXT_KEYS) {
        if (key in value) collectFallbackTexts(value[key], texts, depth + 1);
    }
}

export function podiumPostFallbackTexts(post: unknown): string[] {
    if (!isRecord(post)) return [];
    const texts: string[] = [];
    for (const key of ['body', 'selftext', 'textFallback', 'richtextFallback'] as const) {
        collectFallbackTexts(post[key], texts);
    }
    if (typeof post.toJSON === 'function') {
        try {
            collectFallbackTexts((post as { toJSON: () => unknown }).toJSON(), texts);
        } catch {
        }
    }
    return texts;
}

export function resolveDailyPodiumReplayFromPost(
    post: unknown,
    postData: {
        challengeId?: unknown;
        podium?: { lapCount?: unknown };
        replayDataHash?: unknown;
    } | null,
): DailyPodiumReplayEnvelope | null {
    const challengeId = typeof postData?.challengeId === 'string' ? postData.challengeId : '';
    if (!challengeId) return null;
    const lapCount = postData?.podium?.lapCount === 2 || postData?.podium?.lapCount === 3
        ? postData.podium.lapCount
        : 1;
    const replayDataHash = typeof postData?.replayDataHash === 'string'
        ? postData.replayDataHash
        : undefined;
    const expected = { challengeId, lapCount, replayDataHash };
    for (const text of podiumPostFallbackTexts(post)) {
        const { decoded } = decodeDailyPodiumReplay(text, expected);
        if (decoded) return decoded.envelope;
    }
    return null;
}

export async function loadDailyPodiumReplayForPost(
    postId: string,
    postData: Record<string, unknown> | null,
): Promise<DailyPodiumReplayEnvelope | null> {
    if (!postId.startsWith('t3_')) return null;
    try {
        const post = await reddit.getPostById(postId as `t3_${string}`);
        return resolveDailyPodiumReplayFromPost(post, postData);
    } catch {
        return null;
    }
}
