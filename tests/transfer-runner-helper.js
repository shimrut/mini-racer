// The transfer passes its own fenced runner to each step. Tests that call a
// step directly get the same kind of runner, fenced by one test lock.
let nextLock = 0;

export async function createTestTransferRunner() {
  const { acquireRedisLock, createOwnedLockGroupRunner } = await import("../src/server/redis/redis-lock.ts");
  nextLock += 1;
  const key = `test:guest-transfer-lock:${nextLock}`;
  const lock = await acquireRedisLock(key, 30_000);
  if (!lock) throw new Error(`Test transfer lock is taken: ${key}`);
  return createOwnedLockGroupRunner([lock], (reason) => new Error(`Test transfer ${reason}.`));
}
