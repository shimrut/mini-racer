// Client asset/attempt identity. This is separate from the server PB fingerprint:
// names and medal metadata do not change a race, but corner smoothing does.
export function getTrackDefinitionIdentity(track) {
    if (!track) return null;
    const point = (value) => value ? [value.x, value.y] : null;
    const wall = (points) => (points || []).map((value) => [
        value.x, value.y,
        Number.isFinite(value.cornerRadius) ? Math.max(0, value.cornerRadius) : null,
    ]);
    const line = (value) => value ? [point(value.p1), point(value.p2)] : null;
    return JSON.stringify([
        track.ground || 'tarmac',
        track.cornerRadius ?? 3,
        wall(track.outer), wall(track.inner),
        line(track.startLine), point(track.startPos), track.startAngle ?? 0,
        (track.checkpoints || []).map(line),
    ]);
}
