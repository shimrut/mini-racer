import { afterEach, describe, expect, it, vi } from "vitest";
import { CarSpriteLoader } from "../game/car/sprite.js";

const OriginalImage = globalThis.Image;

function installImageMock() {
  const images = [];
  globalThis.Image = class ImageMock {
    constructor() {
      this.listeners = {};
      images.push(this);
    }

    addEventListener(type, handler) {
      this.listeners[type] = handler;
    }

    set src(value) {
      this._src = value;
    }

    get src() {
      return this._src;
    }
  };
  return images;
}

function load(loader, assetName) {
  return new Promise((resolve) => {
    loader.load(assetName, {
      onLoaded: (image) => resolve({ status: "loaded", image }),
      onError: (name) => resolve({ status: "error", name }),
      onSuperseded: (name) => resolve({ status: "superseded", name }),
    });
  });
}

afterEach(() => {
  globalThis.Image = OriginalImage;
});

describe("CarSpriteLoader selection settlement", () => {
  it("settles a superseded selection immediately and prevents it overwriting the winner", async () => {
    const images = installImageMock();
    const loader = new CarSpriteLoader();
    const firstLoaded = vi.fn();
    const firstSuperseded = vi.fn();
    const firstPromise = new Promise((resolve) => {
      loader.load("assets/cars/first.webp", {
        onLoaded: (image) => {
          firstLoaded(image);
          resolve({ status: "loaded", image });
        },
        onSuperseded: (name) => {
          firstSuperseded(name);
          resolve({ status: "superseded", name });
        },
      });
    });

    const latestPromise = load(loader, "assets/cars/latest.webp");
    await expect(firstPromise).resolves.toEqual({
      status: "superseded",
      name: "assets/cars/first.webp",
    });

    images[1].listeners.load();
    await expect(latestPromise).resolves.toEqual({
      status: "loaded",
      image: images[1],
    });
    expect(loader.currentAssetKey).toBe("assets/cars/latest.webp");

    images[0].listeners.load();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstSuperseded).toHaveBeenCalledOnce();
    expect(firstLoaded).not.toHaveBeenCalled();
    expect(loader.currentAssetKey).toBe("assets/cars/latest.webp");
  });

  it("keeps URL fallback behavior for ordinary success", async () => {
    const images = installImageMock();
    const loader = new CarSpriteLoader();
    const resultPromise = load(loader, "assets/cars/selected.webp");

    images[0].listeners.error();
    expect(images[0].src).toBe("/public/assets/cars/selected.webp");
    images[0].listeners.load();

    await expect(resultPromise).resolves.toEqual({
      status: "loaded",
      image: images[0],
    });
    expect(loader.currentAssetKey).toBe("assets/cars/selected.webp");
  });

  it("reports an ordinary error only after every URL candidate fails", async () => {
    const images = installImageMock();
    const loader = new CarSpriteLoader();
    const resultPromise = load(loader, "assets/cars/missing.webp");

    images[0].listeners.error();
    images[0].listeners.error();
    images[0].listeners.error();

    await expect(resultPromise).resolves.toEqual({
      status: "error",
      name: "assets/cars/missing.webp",
    });
    expect(loader.currentAssetKey).toBeNull();
  });
});
