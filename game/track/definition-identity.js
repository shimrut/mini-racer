// Client asset identity, apart from the PB fingerprint: names and medals do not change a race, smoothing does.
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
