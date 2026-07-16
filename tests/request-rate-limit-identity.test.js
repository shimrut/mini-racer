import { describe, expect, it } from "vitest";
import { createRequestRateLimitIdentity } from "../src/server/request-rate-limit-identity.ts";

describe("request rate-limit identity", () => {
  it("prefers LOID and returns a stable non-reversible identifier", () => {
    const first = createRequestRateLimitIdentity({
      loid: " persistent-loid ",
      userId: "t2_signed_in",
    });
    const second = createRequestRateLimitIdentity({
      loid: "persistent-loid",
      userId: "t2_different",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain("persistent-loid");
  });

  it("falls back to the Reddit user ID when LOID is unavailable", () => {
    expect(createRequestRateLimitIdentity({ userId: " t2_signed_in " })).toBe(
      createRequestRateLimitIdentity({ userId: "t2_signed_in" }),
    );
    expect(createRequestRateLimitIdentity({ userId: "t2_signed_in" })).not.toBe(
      createRequestRateLimitIdentity({ loid: "t2_signed_in" }),
    );
  });

  it("returns null when Reddit provides no stable request identity", () => {
    expect(createRequestRateLimitIdentity({ loid: " ", userId: null })).toBeNull();
  });
});
