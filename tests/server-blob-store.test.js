import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
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
      async send(command, options) {
        sent.push({ command, options });
        return respond(command);
      },
    },
  };
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
