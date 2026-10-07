import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { HttpResponse } from "@smithy/protocol-http";
import {
  BlobCallTimeoutError,
  BlobDeadlineError,
  BlobListTokenRejectedError,
  createBlobSession,
  createDevvitBlobStore,
} from "../src/server/blob/blob-store.ts";
import { createBlobTestStore } from "./helpers/blob-test-store.js";

function fakeS3(respond) {
  const sent = [];
  return {
    sent,
    client: {
      // The parts of the SDK's config the store sets.
      config: { requestHandler: { handle: async () => ({}) } },
      async send(command, options) {
        sent.push({ command, options });
        return respond(command);
      },
    },
  };
}

// An S3 client made as Devvit makes it: the SDK's own client with its retry
// and signing steps, a step that fills in the bucket, and a request handler
// that answers each request with `status` and keeps the request.
function devvitLikeClient(status, requests, clock = null) {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "id", secretAccessKey: "secret", sessionToken: "token" },
    requestHandler: {
      async handle(request) {
        requests.push({ request, at: clock?.now() ?? Date.now() });
        return {
          response: new HttpResponse({
            statusCode: status,
            headers: { "content-type": "application/xml" },
            body: Readable.from([status === 200 ? "" : "<Error><Code>InternalError</Code><Message>x</Message></Error>"]),
          }),
        };
      },
    },
  });
  client.middlewareStack.add((next) => async (args) => {
    args.input.Bucket = "bucket";
    return next(args);
  }, { step: "initialize", name: "BucketFill" });
  return client;
}

function header(request, name) {
  const found = Object.entries(request.headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

describe("Devvit blob store", () => {
  it("makes one client for the request and sends each command with its abort signal", async () => {
    const s3 = fakeS3((command) => {
      if (command instanceof GetObjectCommand) {
        return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      }
      return {};
    });
    const makeClient = vi.fn(async () => s3.client);
    const store = createDevvitBlobStore(makeClient);
    const signal = new AbortController().signal;

    await store.put("a/b.gz", new Uint8Array([9]), signal);
    const bytes = await store.get("a/b.gz", signal);
    await store.delete("a/b.gz", signal);

    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(s3.sent.map(({ command }) => command.constructor)).toEqual([
      PutObjectCommand,
      GetObjectCommand,
      DeleteObjectCommand,
    ]);
    expect(s3.sent[0].command.input).toMatchObject({
      Key: "a/b.gz",
      ContentType: "application/gzip",
    });
    expect(s3.sent.every(({ options }) => options.abortSignal === signal)).toBe(true);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("reads a missing object as null", async () => {
    const s3 = fakeS3(() => {
      throw Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    });
    const store = createDevvitBlobStore(async () => s3.client);
    await expect(store.get("gone.gz", new AbortController().signal)).resolves.toBeNull();
  });

  it("lists one page with its next token, and only a truncated page has one", async () => {
    const pages = [
      {
        Contents: [{ Key: "p/a", Size: 10, LastModified: new Date(1000) }],
        IsTruncated: true,
        NextContinuationToken: "next",
      },
      { Contents: [{ Key: "p/b", Size: 20, LastModified: new Date(2000) }], IsTruncated: false },
    ];
    const s3 = fakeS3(() => pages.shift());
    const store = createDevvitBlobStore(async () => s3.client);
    const signal = new AbortController().signal;

    const first = await store.list("p/", null, 200, signal);
    const second = await store.list("p/", first.nextToken, 200, signal);

    expect(first).toEqual({ objects: [{ key: "p/a", size: 10, lastModifiedMs: 1000 }], nextToken: "next" });
    expect(second).toEqual({ objects: [{ key: "p/b", size: 20, lastModifiedMs: 2000 }], nextToken: null });
    expect(s3.sent[0].command).toBeInstanceOf(ListObjectsV2Command);
    expect(s3.sent[0].command.input).toEqual({ Bucket: "", Prefix: "p/", MaxKeys: 200 });
    expect(s3.sent[1].command.input.ContinuationToken).toBe("next");
  });

  it("reports a refused listing token so the listing can start again", async () => {
    const s3 = fakeS3(() => {
      throw Object.assign(new Error("bad token"), { name: "InvalidArgument", $metadata: { httpStatusCode: 400 } });
    });
    const store = createDevvitBlobStore(async () => s3.client);
    await expect(store.list("p/", "old", 200, new AbortController().signal))
      .rejects.toBeInstanceOf(BlobListTokenRejectedError);
  });
});

describe("Devvit S3 client in the store", () => {
  it("sends a failed call once", async () => {
    const requests = [];
    const store = createDevvitBlobStore(async () => devvitLikeClient(500, requests));

    for (const key of ["a.gz", "b.gz", "c.gz"]) {
      await expect(store.put(key, new Uint8Array([1]), new AbortController().signal)).rejects.toThrow();
    }

    expect(requests).toHaveLength(3);
  });

  it("still signs each request, and says it is the only attempt", async () => {
    const requests = [];
    const store = createDevvitBlobStore(async () => devvitLikeClient(200, requests));

    await store.put("a.gz", new Uint8Array([1]), new AbortController().signal);

    expect(requests).toHaveLength(1);
    expect(header(requests[0].request, "authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=id\//);
    expect(header(requests[0].request, "amz-sdk-request")).toBe("attempt=1; max=1");
  });

  it("sends at most 40 requests in any second, on a clock whose waits end early or late", async () => {
    // A virtual clock: time moves only when nothing else can run, to the
    // earliest wait. Waits end up to 2 ms early or 5 ms late.
    const jitter = [-2, 5, 0, -1, 3, -2, 1, 4];
    let nowMs = 0;
    let turn = 0;
    const timers = [];
    const clock = {
      now: () => nowMs,
      sleep: (ms) => new Promise((resolve) => {
        timers.push({ at: nowMs + Math.max(0, ms + jitter[turn++ % jitter.length]), resolve });
      }),
    };
    const requests = [];
    const store = createDevvitBlobStore(async () => devvitLikeClient(200, requests, clock), { clock });

    let finished = false;
    const all = Promise.all(Array.from({ length: 120 }, (_value, index) => (
      store.put(`k${index}.gz`, new Uint8Array([1]), new AbortController().signal)
    ))).then(() => { finished = true; });
    for (let step = 0; step < 10_000 && !finished; step += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!timers.length) continue;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      nowMs = Math.max(nowMs, next.at);
      next.resolve();
    }
    await all;

    const times = requests.map(({ at }) => at).sort((a, b) => a - b);
    expect(times).toHaveLength(120);
    expect(times.at(-1)).toBeGreaterThan(2000);
    for (const start of times) {
      expect(times.filter((at) => at >= start && at <= start + 1000).length).toBeLessThanOrEqual(40);
    }
  });

  it("sends nothing for a call aborted while it waits at the limit", async () => {
    const waits = [];
    const clock = { now: () => 0, sleep: () => new Promise((resolve) => waits.push(resolve)) };
    const requests = [];
    const store = createDevvitBlobStore(async () => devvitLikeClient(200, requests, clock), {
      clock,
      maxRequestsPerSecond: 1,
    });
    await store.put("a.gz", new Uint8Array([1]), new AbortController().signal);
    const controller = new AbortController();
    const waiting = store.put("b.gz", new Uint8Array([1]), controller.signal);
    await vi.waitFor(() => expect(waits).toHaveLength(1));

    controller.abort();
    waits[0]();

    await expect(waiting).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});

describe("blob session", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps calls at the rate limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const blobs = createBlobTestStore();
    const starts = [];
    const store = {
      ...blobs.store,
      async put(key, body, signal) {
        starts.push(Date.now());
        return blobs.store.put(key, body, signal);
      },
    };
    const session = createBlobSession({ store, deadlineMs: 60_000, maxCallsPerSecond: 40 });

    const done = Promise.all([0, 1, 2, 3].map((index) => session.put(`k${index}`, new Uint8Array([index]))));
    await vi.advanceTimersByTimeAsync(200);
    await done;

    expect(starts).toEqual([0, 25, 50, 75]);
  });

  it("aborts a call that runs past its time limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const blobs = createBlobTestStore();
    blobs.faults.put = "stall";
    const session = createBlobSession({ store: blobs.store, deadlineMs: 60_000, callTimeoutMs: 4_000 });

    const result = session.put("k", new Uint8Array([1])).catch((error) => error);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await result).toBeInstanceOf(BlobCallTimeoutError);
    expect(Date.now()).toBe(4_000);
  });

  it("starts no call that could end after the deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const blobs = createBlobTestStore();
    const session = createBlobSession({ store: blobs.store, deadlineMs: 13_000, callTimeoutMs: 4_000 });

    expect(session.hasTimeFor(1)).toBe(false);
    await expect(session.put("k", new Uint8Array([1]))).rejects.toBeInstanceOf(BlobDeadlineError);
    expect(blobs.count("put")).toBe(0);
  });
});
