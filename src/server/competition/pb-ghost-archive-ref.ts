// Blob location of a moved ghost; the record keeps `ghost: null` and this reference (sha256 of the full text).
export type PbGhostArchiveRef = {
    v: 1;
    key: string;
    sha256: string;
};

const BLOB_KEY_MAX_BYTES = 900;

export function isPbGhostArchiveRef(value: unknown): value is PbGhostArchiveRef {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const ref = value as Partial<PbGhostArchiveRef>;
    return ref.v === 1
        && typeof ref.key === 'string'
        && ref.key.length > 0
        && Buffer.byteLength(ref.key, 'utf8') <= BLOB_KEY_MAX_BYTES
        && typeof ref.sha256 === 'string'
        && /^[0-9a-f]{64}$/.test(ref.sha256);
}

// A moved row: no ghost in Redis, only the reference to its blob copy.
export function isMovedPbRecord(record: { ghost?: unknown; ghostArchive?: unknown } | null | undefined): boolean {
    return Boolean(record && !record.ghost && isPbGhostArchiveRef(record.ghostArchive));
}
