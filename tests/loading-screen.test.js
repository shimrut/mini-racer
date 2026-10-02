import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingScreen } from "../game/ui/loader.js";

function createLoadingScreen() {
  const element = {
    setAttribute: vi.fn(),
    style: { setProperty: vi.fn() },
    classList: { add: vi.fn(), remove: vi.fn() },
  };
  const statusText = { textContent: "" };
  const retryButton = {
    hidden: true,
    listeners: {},
    addEventListener: vi.fn((type, handler) => { retryButton.listeners[type] = handler; }),
    removeEventListener: vi.fn((type) => { delete retryButton.listeners[type]; }),
  };
  const nodes = {
    "loading-screen": element,
    "loader-status": statusText,
    "loader-retry": retryButton,
  };

  vi.stubGlobal("document", {
    body: { classList: { add: vi.fn(), remove: vi.fn() } },
    getElementById: vi.fn((id) => nodes[id] ?? null),
  });

  return { screen: new LoadingScreen(), element, statusText, retryButton };
}

describe("LoadingScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the phase label without driving the bar from that percent", () => {
    const { screen, statusText, element } = createLoadingScreen();

    screen.showPhase({ progress: 30, label: "Loading Daily data…" });

    expect(statusText.textContent).toBe("Loading Daily data…");
    expect(element.setAttribute).toHaveBeenCalledWith("aria-valuetext", "Loading Daily data…");
    expect(document.getElementById).not.toHaveBeenCalledWith("loader-progress-bar");
  });

  it("finishes with Ready when dismissed", async () => {
    vi.stubGlobal("setTimeout", (callback) => {
      callback();
      return 1;
    });
    const { screen, statusText, element } = createLoadingScreen();

    screen.showPhase({ progress: 95, label: "Displaying Daily..." });
    await screen.dismiss();

    expect(statusText.textContent).toBe("Ready!");
    expect(screen.isComplete).toBe(true);
    expect(element.setAttribute).toHaveBeenCalledWith("aria-busy", "false");
    expect(element.setAttribute).toHaveBeenCalledWith("aria-valuenow", "100");
    expect(document.body.classList.remove).toHaveBeenCalledWith("loading-active");
  });

  it("keeps the loader up and offers a retry when an essential fails", () => {
    const { screen, element, statusText, retryButton } = createLoadingScreen();
    const onRetry = vi.fn();

    screen.showError("Could not load the game.", onRetry);

    expect(statusText.textContent).toBe("Could not load the game.");
    expect(element.classList.add).toHaveBeenCalledWith("loader-failed");
    expect(retryButton.hidden).toBe(false);
    expect(screen.isComplete).toBe(false);
    expect(document.body.classList.remove).not.toHaveBeenCalledWith("loading-active");

    retryButton.listeners.click();

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryButton.hidden).toBe(true);
    expect(element.classList.remove).toHaveBeenCalledWith("loader-failed");
  });

  it("reopens after startup and clears an earlier Retry state for mode entry", async () => {
    vi.stubGlobal("setTimeout", (callback) => { callback(); return 1; });
    const { screen, element, statusText, retryButton } = createLoadingScreen();
    screen.showError("Daily unavailable", vi.fn());
    await screen.dismiss();
    screen.begin("Loading Campaign…");

    expect(screen.isComplete).toBe(false);
    expect(statusText.textContent).toBe("Loading Campaign…");
    expect(retryButton.hidden).toBe(true);
    expect(document.body.classList.add).toHaveBeenCalledWith("loading-active");
    expect(element.setAttribute).toHaveBeenCalledWith("aria-busy", "true");
  });

  it("lets CSS own the bar crawl in one place", () => {
    const css = readFileSync(new URL("../styles/loading.css", import.meta.url), "utf8");
    const loaderSource = readFileSync(new URL("../game/ui/loader.js", import.meta.url), "utf8");

    expect(css).toContain("loaderBarCrawl");
    expect(css).toContain("loaderBarCreep");
    expect(css).toContain("--loader-bar-held");
    expect(css).toContain("prefers-reduced-motion");
    expect(loaderSource).not.toContain("progressBar");
    expect(loaderSource).not.toContain("requestAnimationFrame");
  });
});
