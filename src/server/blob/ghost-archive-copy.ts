import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { PbGhostArchiveRef } from '../competition/pb-ghost-archive-ref.js';
import { storedRunGhost } from '../competition/pb-ghost-pack.js';
import type { PbGhostTrace } from '../competition/pb-ghost-trace.js';
import { encodeRedisCompressedValue } from '../redis/redis-compressed-value.js';
import { BlobDeadlineError, type BlobSession } from './blob-store.js';

// A moved ghost: blob storage holds the full row text; Redis keeps a stub with every other field and a reference.

const DAILY_BLOB_PREFIX = 'daily-ghosts/v1';
const CAMPAIGN_BLOB_PREFIX = 'campaign-ghosts/v1';
const DAILY_PB_HASH_PREFIX = 'dailygp:challenge-pbs:';
const CAMPAIGN_PB_HASH = /^campaign:(.+):pbs:([^:]+)$/;
// A ghost row is a few kilobytes; a bigger copy is not one of ours.
const COPY_MAX_BYTES = 1024 * 1024;

export function sha256Hex(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function dailyGhostBlobPrefix(challengeId: string): string {
    return `${DAILY_BLOB_PREFIX}/${challengeId}/`;
}

export function dailyGhostBlobKey(challengeId: string, field: string, sha256: string): string {
    return `${dailyGhostBlobPrefix(challengeId)}${field}-${sha256.slice(0, 16)}.gz`;
}

export const CAMPAIGN_GHOST_BLOB_ROOT = `${CAMPAIGN_BLOB_PREFIX}/`;

// The blob folder of one board's moved ghosts, from its PB hash name; null for a board that never moves.
export function ghostBlobPrefixForBoard(pbHashKey: string): string | null {
    if (pbHashKey.startsWith(DAILY_PB_HASH_PREFIX) && pbHashKey.length > DAILY_PB_HASH_PREFIX.length) {
        return dailyGhostBlobPrefix(pbHashKey.slice(DAILY_PB_HASH_PREFIX.length));
    }
    const campaign = CAMPAIGN_PB_HASH.exec(pbHashKey);
    return campaign ? `${CAMPAIGN_BLOB_PREFIX}/${campaign[1]}/${campaign[2]}/` : null;
}

// The row left in Redis: every field kept, with the ghost replaced by the reference.
export function buildGhostStub(fullText: string, ref: PbGhostArchiveRef): string {
    const value = JSON.parse(fullText) as Record<string, unknown>;
    value.ghost = null;
    delete value.ghostPacked;
    value.ghostArchive = ref;
    return JSON.stringify(value);
}

export type ArchivedCopyCheck =
    | { ok: true; fullText: string; ghost: PbGhostTrace }
    | { ok: false; code: 'missing' | 'mismatch' };

// The copy is the original row only if it rebuilds the stub text as Redis holds it; needs no live content.
export function verifyArchivedCopy({
    copy,
    ref,
    stubText,
    prefix,
}: {
    copy: Uint8Array | null;
    ref: PbGhostArchiveRef;
    stubText: string;
    prefix: string;
}): ArchivedCopyCheck {
    if (copy === null) return { ok: false, code: 'missing' };
    if (!ref.key.startsWith(prefix)) return { ok: false, code: 'mismatch' };
    try {
        const fullText = gunzipSync(copy, { maxOutputLength: COPY_MAX_BYTES }).toString('utf8');
        if (sha256Hex(fullText) !== ref.sha256) return { ok: false, code: 'mismatch' };
        if (buildGhostStub(fullText, ref) !== stubText) return { ok: false, code: 'mismatch' };
        const ghost = storedRunGhost(JSON.parse(fullText) as Record<string, unknown>);
        return ghost ? { ok: true, fullText, ghost } : { ok: false, code: 'mismatch' };
    } catch (_error) {
        return { ok: false, code: 'mismatch' };
    }
}

export function ghostCopyKey(prefix: string, field: string, sha256: string): string {
    return `${prefix}${field}-${sha256.slice(0, 16)}.gz`;
}

// A ghost no bigger than its stub stays, because moving it saves nothing.
export function stubSavesSpace(raw: string, fullText: string, ref: PbGhostArchiveRef): boolean {
    const stub = encodeRedisCompressedValue(buildGhostStub(fullText, ref));
    return Buffer.byteLength(stub, 'utf8') < Buffer.byteLength(raw, 'utf8');
}

export type CopyUpload = { status: 'ok'; bytes: number } | { status: 'upload' | 'confirm' | 'deadline' };

// Uploads the full row and reads it back; only a byte-exact copy may let the ghost leave Redis.
export async function uploadAndConfirmCopy(session: BlobSession, key: string, fullText: string): Promise<CopyUpload> {
    const body = new Uint8Array(gzipSync(Buffer.from(fullText, 'utf8')));
    try {
        await session.put(key, body);
    } catch (error) {
        return { status: error instanceof BlobDeadlineError ? 'deadline' : 'upload' };
    }
    let copy: Uint8Array | null;
    try {
        copy = await session.get(key);
    } catch (error) {
        return { status: error instanceof BlobDeadlineError ? 'deadline' : 'confirm' };
    }
    try {
        return copy && gunzipSync(copy).toString('utf8') === fullText
            ? { status: 'ok', bytes: body.byteLength }
            : { status: 'confirm' };
    } catch (_error) {
        return { status: 'confirm' };
    }
}
