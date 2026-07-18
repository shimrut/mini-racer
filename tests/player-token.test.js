import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRedis } = vi.hoisted(() => ({
    mockRedis: {
        get: vi.fn(),
        set: vi.fn(),
    },
}));

vi.mock('@devvit/redis', () => ({
    redis: mockRedis,
}));

const {
    mintGuestPlayerToken,
    verifyGuestPlayerToken,
} = await import('../src/server/player-token.ts');

describe('guest player tokens', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRedis.get.mockResolvedValue('test-secret-value');
        mockRedis.set.mockResolvedValue('OK');
    });

    it('mints null for non-string or blank guest ids', async () => {
        await expect(mintGuestPlayerToken(null)).resolves.toBeNull();
        await expect(mintGuestPlayerToken(undefined)).resolves.toBeNull();
        await expect(mintGuestPlayerToken(42)).resolves.toBeNull();
        await expect(mintGuestPlayerToken('')).resolves.toBeNull();
        await expect(mintGuestPlayerToken('   ')).resolves.toBeNull();
        expect(mockRedis.get).not.toHaveBeenCalled();
    });

    it('trims guest ids in minted tokens and round-trips verification', async () => {
        const token = await mintGuestPlayerToken('  guest-abc  ');
        expect(token).toMatch(/^v1\.guest-abc\.[A-Za-z0-9_-]+$/);
        await expect(verifyGuestPlayerToken(token)).resolves.toBe('guest-abc');
        await expect(verifyGuestPlayerToken(`  ${token}  `)).resolves.toBe('guest-abc');
    });

    it('reuses an existing redis secret without rewriting it', async () => {
        mockRedis.get.mockResolvedValue('existing-secret');
        const token = await mintGuestPlayerToken('guest-reuse');
        expect(token).toMatch(/^v1\.guest-reuse\./);
        expect(mockRedis.set).not.toHaveBeenCalled();
        expect(mockRedis.get).toHaveBeenCalledTimes(1);
    });

    it('rejects tokens with extra segments or the wrong version even when the signature matches', async () => {
        const token = await mintGuestPlayerToken('guest-strict');
        const [, guestId, signature] = token.split('.');

        await expect(verifyGuestPlayerToken(`v1.${guestId}.${signature}.extra`)).resolves.toBeNull();
        await expect(verifyGuestPlayerToken(`v2.${guestId}.${signature}`)).resolves.toBeNull();
        await expect(verifyGuestPlayerToken(`v1.${guestId}`)).resolves.toBeNull();
    });

    it('creates a redis secret once when missing, using nx', async () => {
        mockRedis.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('created-secret');
        mockRedis.set.mockResolvedValue('OK');

        const token = await mintGuestPlayerToken('guest-new');
        expect(token).toMatch(/^v1\.guest-new\./);
        expect(mockRedis.set).toHaveBeenCalledWith(
            'dailygp:guest-player-token-secret',
            expect.any(String),
            { nx: true },
        );
        expect(mockRedis.get).toHaveBeenCalledWith('dailygp:guest-player-token-secret');
    });

    it('falls back to the locally generated secret when the post-set read is empty', async () => {
        mockRedis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        mockRedis.set.mockResolvedValue('OK');

        const token = await mintGuestPlayerToken('guest-fallback');
        expect(token).toMatch(/^v1\.guest-fallback\./);
        const createdSecret = mockRedis.set.mock.calls[0][1];
        expect(typeof createdSecret).toBe('string');
        expect(createdSecret.length).toBeGreaterThan(10);

        mockRedis.get.mockResolvedValue(createdSecret);
        await expect(verifyGuestPlayerToken(token)).resolves.toBe('guest-fallback');
    });

    it('rejects malformed verify inputs before signature checks', async () => {
        await expect(verifyGuestPlayerToken(null)).resolves.toBeNull();
        await expect(verifyGuestPlayerToken(12)).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('')).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('   ')).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('only.two')).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('a.b.c.d')).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('v2.guest-abc.sig')).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('v1..sig')).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('v1.   .sig')).resolves.toBeNull();
        await expect(verifyGuestPlayerToken('v1.guest-abc.')).resolves.toBeNull();
    });

    it('rejects wrong signatures and length-mismatched signature buffers', async () => {
        const token = await mintGuestPlayerToken('guest-sig');
        const [version, guestId, signature] = token.split('.');

        await expect(verifyGuestPlayerToken(`${version}.${guestId}.${signature}x`)).resolves.toBeNull();
        await expect(verifyGuestPlayerToken(`${version}.${guestId}.aaaa`)).resolves.toBeNull();
        await expect(verifyGuestPlayerToken(`${version}.other-guest.${signature}`)).resolves.toBeNull();
    });
});
