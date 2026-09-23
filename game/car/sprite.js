import { CONFIG } from "../config.js";
import { GENERATED_PLAYER_SELECTABLE_CAR_ASSETS } from "./generated-player-selectable-car-assets.js";

export { STOCK_CAR_ASSET_NAME } from "./car-unlock-policy.js";

export const PLAYER_SELECTABLE_CAR_ASSETS = GENERATED_PLAYER_SELECTABLE_CAR_ASSETS;

export function getCarAssetUrlCandidates(assetName) {
  const primary = assetName.startsWith("public/")
    ? assetName.slice("public/".length)
    : assetName;
  return [
    primary,
    `public/${primary}`,
    `./${primary}`,
  ];
}

export function setCarAssetImageWithFallbacks(image, assetName) {
  if (!image || !assetName) return;
  const candidates = getCarAssetUrlCandidates(assetName);
  let index = 0;
  image.onerror = () => {
    index += 1;
    const next = candidates[index];
    if (!next) return;
    image.src = next;
  };
  image.src = candidates[0] || assetName;
}

export function createCarSprite() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 32;
  const x = c.getContext("2d");
  const carColor = CONFIG.carColor;
  const carAccent = CONFIG.carAccent;
  const tireColor = CONFIG.tireColor;
  x.translate(32, 16);

  x.fillStyle = tireColor;
  x.fillRect(6, -12, 10, 6);
  x.fillRect(6, 6, 10, 6);
  x.fillRect(-16, -13, 11, 7);
  x.fillRect(-16, 6, 11, 7);
  x.fillStyle = "#333";
  x.fillRect(8, -11, 4, 2);
  x.fillRect(8, 7, 4, 2);
  x.fillRect(-14, -12, 6, 2);
  x.fillRect(-14, 7, 6, 2);
  x.fillStyle = "#e2e8f0";
  x.beginPath();
  x.moveTo(18, -10);
  x.lineTo(18, 10);
  x.lineTo(14, 8);
  x.lineTo(14, -8);
  x.fill();
  x.fillStyle = carColor;
  x.beginPath();
  x.moveTo(20, 0);
  x.lineTo(6, -3);
  x.lineTo(-6, -6);
  x.lineTo(-12, -6);
  x.lineTo(-14, -2);
  x.lineTo(-14, 2);
  x.lineTo(-12, 6);
  x.lineTo(-6, 6);
  x.lineTo(6, 3);
  x.closePath();
  x.fill();
  x.fillStyle = "#000";
  x.beginPath();
  x.moveTo(0, -4);
  x.lineTo(-4, -6);
  x.lineTo(0, -6);
  x.fill();
  x.beginPath();
  x.moveTo(0, 4);
  x.lineTo(-4, 6);
  x.lineTo(0, 6);
  x.fill();
  x.fillStyle = tireColor;
  x.fillRect(-18, -10, 4, 20);
  x.fillStyle = carColor;
  x.fillRect(-18, -10, 5, 2);
  x.fillRect(-18, 8, 5, 2);
  x.fillStyle = carAccent;
  x.beginPath();
  x.arc(-4, 0, 3, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = carAccent;
  x.fillRect(-10, -1, 12, 2);
  return c;
}

export function sanitizeCarSpriteAsset(image) {
  const width = image?.naturalWidth || image?.width || 0;
  const height = image?.naturalHeight || image?.height || 0;
  if (!width || !height || typeof document === "undefined") return image;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return image;

  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  let changed = false;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;

    if (alpha < 14) {
      data[i + 3] = 0;
      changed = true;
      continue;
    }

    if (alpha >= 224) continue;

    const luminance =
      data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
    if (luminance < 168) continue;

    const edgeFactor = alpha / 255;
    data[i] = Math.round(data[i] * edgeFactor);
    data[i + 1] = Math.round(data[i + 1] * edgeFactor);
    data[i + 2] = Math.round(data[i + 2] * edgeFactor);

    if (alpha < 104) {
      data[i + 3] = Math.max(0, alpha - 24);
    }

    changed = true;
  }

  if (!changed) return image;

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export class CarSpriteLoader {
  #cache = new Map();
  #loadToken = 0;
  #inFlightAssetName = null;
  #pendingSettlers = new Map();
  #currentAssetKey = null;

  get currentAssetKey() {
    return this.#currentAssetKey;
  }

  prefetch(assetName) {
    if (!assetName) return null;
    const assetUrlCandidates = getCarAssetUrlCandidates(assetName);
    if (!assetUrlCandidates.length) return null;

    const cached = this.#cache.get(assetName);
    if (cached) return cached;

    const image = new Image();
    image.decoding = "async";
    const record = { image, status: "pending", promise: null };
    record.promise = new Promise((resolve, reject) => {
      let candidateIndex = 0;
      const tryNextCandidate = () => {
        const nextUrl = assetUrlCandidates[candidateIndex++];
        if (!nextUrl) {
          this.#cache.delete(assetName);
          reject(new Error(`Unable to load ${assetName}`));
          return;
        }
        image.src = nextUrl;
      };
      image.addEventListener(
        "load",
        () => {
          record.status = "loaded";
          resolve(image);
        },
        { once: true },
      );
      image.addEventListener(
        "error",
        () => {
          tryNextCandidate();
        },
      );
      tryNextCandidate();
    });
    this.#cache.set(assetName, record);
    return record;
  }

  load(assetName, { onLoaded, onError, onSuperseded } = {}) {
    if (!assetName) return;

    if (this.#currentAssetKey === assetName) {
      const cached = this.#cache.get(assetName);
      if (cached?.status === "loaded" && cached.image) {
        onLoaded?.(sanitizeCarSpriteAsset(cached.image));
      }
      return;
    }

    const cachedAsset = this.prefetch(assetName);
    if (!cachedAsset) return;

    const loadToken = (() => {
      if (this.#inFlightAssetName !== assetName) {
        this.#settleSuperseded(this.#loadToken);
        this.#loadToken += 1;
        this.#inFlightAssetName = assetName;
      }
      return this.#loadToken;
    })();

    let settled = false;
    const pendingSettlers = this.#pendingSettlers.get(loadToken) || new Set();
    const settleSuperseded = () => {
      if (settled) return;
      settled = true;
      onSuperseded?.(assetName);
    };
    pendingSettlers.add(settleSuperseded);
    this.#pendingSettlers.set(loadToken, pendingSettlers);

    const finish = () => {
      if (settled) return false;
      settled = true;
      pendingSettlers.delete(settleSuperseded);
      if (pendingSettlers.size === 0) {
        this.#pendingSettlers.delete(loadToken);
      }
      return true;
    };

    const apply = (image) => {
      if (loadToken !== this.#loadToken || !finish()) return;
      if (this.#inFlightAssetName === assetName) {
        this.#inFlightAssetName = null;
      }
      this.#currentAssetKey = assetName;
      onLoaded?.(sanitizeCarSpriteAsset(image));
    };

    if (cachedAsset.status === "loaded") {
      apply(cachedAsset.image);
      return;
    }

    cachedAsset.promise
      .then((image) => apply(image))
      .catch(() => {
        if (loadToken !== this.#loadToken || !finish()) return;
        if (this.#inFlightAssetName === assetName) {
          this.#inFlightAssetName = null;
        }
        this.#currentAssetKey = null;
        onError?.(assetName);
      });
  }

  #settleSuperseded(loadToken) {
    const pendingSettlers = this.#pendingSettlers.get(loadToken);
    if (!pendingSettlers) return;
    this.#pendingSettlers.delete(loadToken);
    for (const settle of pendingSettlers) settle();
  }
}
