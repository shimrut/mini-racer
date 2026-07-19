import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRequestRateLimitIdentity } from "../src/server/request-rate-limit-identity.ts";

function expectedIdentity(source) {
  return createHash("sha256")
    .update(`mini-racer:daily-submit:v1:${source}`, "utf8")
    .digest("base64url");
}

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
    expect(first).toBe(expectedIdentity("loid:persistent-loid"));
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain("persistent-loid");
  });

  it("falls back to the Reddit user ID when LOID is unavailable", () => {
    const fromUser = createRequestRateLimitIdentity({ userId: " t2_signed_in " });
    expect(fromUser).toBe(createRequestRateLimitIdentity({ userId: "t2_signed_in" }));
    expect(fromUser).toBe(expectedIdentity("user:t2_signed_in"));
    expect(fromUser).not.toBeNull();
    expect(fromUser).not.toBe(
      createRequestRateLimitIdentity({ loid: "t2_signed_in" }),
    );
  });

  it("returns null when Reddit provides no stable request identity", () => {
    expect(createRequestRateLimitIdentity({ loid: " ", userId: null })).toBeNull();
    expect(createRequestRateLimitIdentity({ loid: "\t", userId: "  " })).toBeNull();
    expect(createRequestRateLimitIdentity({})).toBeNull();
  });

  it("keeps LOID and user namespaces distinct for the same raw id", () => {
    expect(createRequestRateLimitIdentity({ loid: "same-id" })).toBe(
      expectedIdentity("loid:same-id"),
    );
    expect(createRequestRateLimitIdentity({ userId: "same-id" })).toBe(
      expectedIdentity("user:same-id"),
    );
    expect(createRequestRateLimitIdentity({ loid: "same-id" })).not.toBe(
      createRequestRateLimitIdentity({ userId: "same-id" }),
    );
  });
});
