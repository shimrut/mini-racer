import { gunzipSync, gzipSync } from 'node:zlib';
import { getTrackName } from '../../game/track/catalog.js';
import {
    getHeadToHeadOrigin,
    isHeadToHeadOrigin,
    sameHeadToHeadOrigin,
    type HeadToHeadPostData,
    type HeadToHeadOrigin,
} from './head-to-head-model.js';
import { isRecord, sha256Hex } from './value-guards.js';
import { formatHeadToHeadTime } from './format-race-time.js';

export const HEAD_TO_HEAD_REPLAY_MARKER = 'Challenge replay data:';
export const HEAD_TO_HEAD_REPLAY_FORMAT = 'MINIRACER-HEAD-TO-HEAD-REPLAY-V1';

const COMPRESSED_PREFIX = '__gz:b64url__:';
const MAX_FALLBACK_CHARS = 40_000;
const MAX_PAYLOAD_CHARS = MAX_FALLBACK_CHARS;
const MAX_DECOMPRESSED_BYTES = 128 * 1024;

export type HeadToHeadReplayEnvelope = {
    format: typeof HEAD_TO_HEAD_REPLAY_FORMAT;
    challengeId: string;
    campaignId?: string;
    raceId?: string;
    origin?: HeadToHeadOrigin;
    trackKey: string;
    lapCount: 1 | 2 | 3;
    targetTimeMs: number;
    medal: HeadToHeadPostData['medal'];
    rulesRevision: number;
    trackFingerprint: string;
    createdAt: string;
    ghost: unknown;
};

export type EncodedHeadToHeadReplay = {
    envelope: HeadToHeadReplayEnvelope;
    token: string;
    hash: string;
};

export type DecodedHeadToHeadReplay = EncodedHeadToHeadReplay;

function isMedal(value: unknown): value is HeadToHeadPostData['medal'] {
    return value === null
        || value === 'author'
        || value === 'gold'
        || value === 'silver'
        || value === 'bronze';
}

function isLapCount(value: unknown): value is 1 | 2 | 3 {
    return value === 1 || value === 2 || value === 3;
}

function createEnvelope(
    postData: HeadToHeadPostData,
    ghost: unknown,
): HeadToHeadReplayEnvelope {
    const envelope: HeadToHeadReplayEnvelope = {
        format: HEAD_TO_HEAD_REPLAY_FORMAT,
        challengeId: postData.challengeId,
        trackKey: postData.trackKey,
        lapCount: postData.lapCount,
        targetTimeMs: postData.targetTimeMs,
        medal: postData.medal,
        rulesRevision: postData.rulesRevision,
        trackFingerprint: postData.trackFingerprint,
        createdAt: postData.createdAt,
        ghost,
    };
    if (postData.campaignId) envelope.campaignId = postData.campaignId;
    if (postData.raceId) envelope.raceId = postData.raceId;
    const origin = getHeadToHeadOrigin(postData);
    if (origin) envelope.origin = origin;
    return envelope;
}

function encodeEnvelope(envelope: HeadToHeadReplayEnvelope): string {
    const json = JSON.stringify(envelope);
    if (!json) throw new Error('Head to Head replay could not be serialized.');
    const compressed = gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
    return `${HEAD_TO_HEAD_REPLAY_FORMAT}\n${COMPRESSED_PREFIX}${compressed.toString('base64url')}`;
}

export function encodeHeadToHeadReplay(
    postData: HeadToHeadPostData,
    ghost: unknown,
): EncodedHeadToHeadReplay {
    const envelope = createEnvelope(postData, ghost);
    const token = encodeEnvelope(envelope);
    if (token.length > MAX_PAYLOAD_CHARS) {
        throw new Error('Head to Head replay exceeds the Reddit text fallback limit.');
    }
    return { envelope, token, hash: sha256Hex(token) };
}

export function isHeadToHeadReplayEnvelope(
    value: unknown,
): value is HeadToHeadReplayEnvelope {
    if (!isRecord(value)) return false;
    return value.format === HEAD_TO_HEAD_REPLAY_FORMAT
        && typeof value.challengeId === 'string'
        && Boolean(value.challengeId)
        && (
            isHeadToHeadOrigin(value.origin)
            || (
                typeof value.campaignId === 'string'
                && Boolean(value.campaignId)
                && typeof value.raceId === 'string'
                && Boolean(value.raceId)
            )
        )
        && typeof value.trackKey === 'string'
        && Boolean(value.trackKey)
        && isLapCount(value.lapCount)
        && Number.isSafeInteger(value.targetTimeMs)
        && Number(value.targetTimeMs) > 0
        && isMedal(value.medal)
        && Number.isSafeInteger(value.rulesRevision)
        && Number(value.rulesRevision) >= 0
        && typeof value.trackFingerprint === 'string'
        && Boolean(value.trackFingerprint)
        && typeof value.createdAt === 'string'
        && Boolean(value.createdAt)
        && value.ghost != null;
}

function sameContract(
    envelope: HeadToHeadReplayEnvelope,
    postData: HeadToHeadPostData,
): boolean {
    const expectedOrigin = getHeadToHeadOrigin(postData);
    const envelopeOrigin = getHeadToHeadOrigin(envelope);
    return envelope.challengeId === postData.challengeId
        && sameHeadToHeadOrigin(envelopeOrigin, expectedOrigin)
        && envelope.campaignId === postData.campaignId
        && envelope.raceId === postData.raceId
        && envelope.trackKey === postData.trackKey
        && envelope.lapCount === postData.lapCount
        && envelope.targetTimeMs === postData.targetTimeMs
        && envelope.medal === postData.medal
        && envelope.rulesRevision === postData.rulesRevision
        && envelope.trackFingerprint === postData.trackFingerprint
        && envelope.createdAt === postData.createdAt;
}

function contractDiff(
    envelope: HeadToHeadReplayEnvelope,
    postData: HeadToHeadPostData,
): Record<string, { envelope: unknown; postData: unknown }> {
    const expectedOrigin = getHeadToHeadOrigin(postData);
    const envelopeOrigin = getHeadToHeadOrigin(envelope);
    const fields: [string, unknown, unknown][] = [
        ['challengeId', envelope.challengeId, postData.challengeId],
        ['origin', !sameHeadToHeadOrigin(envelopeOrigin, expectedOrigin) ? JSON.stringify(envelopeOrigin) : null, !sameHeadToHeadOrigin(envelopeOrigin, expectedOrigin) ? JSON.stringify(expectedOrigin) : null],
        ['campaignId', envelope.campaignId, postData.campaignId],
        ['raceId', envelope.raceId, postData.raceId],
        ['trackKey', envelope.trackKey, postData.trackKey],
        ['lapCount', envelope.lapCount, postData.lapCount],
        ['targetTimeMs', envelope.targetTimeMs, postData.targetTimeMs],
        ['medal', envelope.medal, postData.medal],
        ['rulesRevision', envelope.rulesRevision, postData.rulesRevision],
        ['trackFingerprint', envelope.trackFingerprint, postData.trackFingerprint],
        ['createdAt', envelope.createdAt, postData.createdAt],
    ];
    const diff: Record<string, { envelope: unknown; postData: unknown }> = {};
    for (const [key, envVal, pdVal] of fields) {
        if (envVal !== pdVal) diff[key] = { envelope: envVal, postData: pdVal };
    }
    return diff;
}

function extractToken(text: string): string | null {
    if (typeof text !== 'string' || text.length > MAX_FALLBACK_CHARS) return null;
    const markerIndex = text.indexOf(HEAD_TO_HEAD_REPLAY_MARKER);
    if (markerIndex < 0) return null;
    const payload = text.slice(markerIndex + HEAD_TO_HEAD_REPLAY_MARKER.length);
    const tokenPattern = new RegExp(
        `${HEAD_TO_HEAD_REPLAY_FORMAT}\\s*\\r?\\n(${COMPRESSED_PREFIX}[A-Za-z0-9_-]+)`,
    );
    const compressedToken = payload.match(tokenPattern)?.[1] ?? null;
    return compressedToken ? `${HEAD_TO_HEAD_REPLAY_FORMAT}\n${compressedToken}` : null;
}

export function decodeHeadToHeadReplay(
    text: string,
    expectedPostData: HeadToHeadPostData | null = null,
): { decoded: DecodedHeadToHeadReplay | null; reason?: string; diff?: Record<string, unknown> } {
    const token = extractToken(text);
    if (!token || token.length > MAX_PAYLOAD_CHARS) return { decoded: null, reason: 'replay_token_not_found' };
    if (
        expectedPostData?.replayDataHash
        && expectedPostData.replayDataHash !== sha256Hex(token)
    ) return { decoded: null, reason: 'replay_hash_mismatch' };
    const encodedLine = token.split('\n')[1] || '';
    const encoded = encodedLine.slice(COMPRESSED_PREFIX.length);
    try {
        const compressed = Buffer.from(encoded, 'base64url');
        const json = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
            .toString('utf8');
        const parsed = JSON.parse(json);
        if (!isHeadToHeadReplayEnvelope(parsed)) return { decoded: null, reason: 'replay_envelope_invalid' };
        if (expectedPostData && !sameContract(parsed, expectedPostData)) {
            const diff = contractDiff(parsed, expectedPostData);
            return { decoded: null, reason: 'replay_contract_mismatch', diff };
        }
        return {
            decoded: {
                envelope: parsed,
                token,
                hash: sha256Hex(token),
            },
        };
    } catch {
        return { decoded: null, reason: 'replay_decompress_failed' };
    }
}

export function formatHeadToHeadTextFallback(
    postData: HeadToHeadPostData,
    ghost: unknown,
): string {
    const laps = postData.lapCount === 1 ? '1 lap' : `${postData.lapCount} laps`;
    const replay = encodeHeadToHeadReplay(postData, ghost);
    if (postData.replayDataHash && postData.replayDataHash !== replay.hash) {
        throw new Error('Head to Head replay hash does not match post data.');
    }
    const text = [
        `# Head to Head · ${postData.challengerUsername}`,
        '',
        `Beat **${formatHeadToHeadTime(postData.targetTimeMs)}** on **${getTrackName(postData.trackKey, postData.trackKey)}** (${laps}).`,
        '',
        'Open Mini Racer and race the frozen verified ghost.',
        '',
        HEAD_TO_HEAD_REPLAY_MARKER,
        '',
        '```text',
        replay.token,
        '```',
    ].join('\n');
    if (text.length > MAX_FALLBACK_CHARS) {
        throw new Error('Head to Head text fallback exceeds the Reddit limit.');
    }
    return text;
}
