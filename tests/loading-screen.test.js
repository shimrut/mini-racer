import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingScreen } from "../game/ui/loader.js";

function createLoadingScreen() {
  const element = {
    setAttribute: vi.fn(),
    style: { setProperty: vi.fn() },
    classList: { add: vi.fn(), remove: vi.fn() },
  };
  const progressBar = { style: {} };
  const statusText = { textContent: "" };
  const retryButton = {
    hidden: true,
    listeners: {},
    addEventListener: vi.fn((type, handler) => { retryButton.listeners[type] = handler; }),
    removeEventListener: vi.fn((type) => { delete retryButton.listeners[type]; }),
  };
  const nodes = {
    "loading-screen": element,
    "loader-progress-bar": progressBar,
    "loader-status": statusText,
    "loader-retry": retryButton,
  };

  vi.stubGlobal("document", {
    body: { classList: { remove: vi.fn() } },
    getElementById: vi.fn((id) => nodes[id] ?? null),
  });

  return { screen: new LoadingScreen(), element, progressBar, statusText, retryButton };
}

describe("LoadingScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the phase the startup plan last reported", () => {
    const { screen, progressBar, statusText } = createLoadingScreen();

    screen.update(40, "Loading graphics...");

    expect(progressBar.style.width).toBe("40%");
    expect(statusText.textContent).toBe("Loading graphics...");

    screen.update(75, "Loading race data...");

    expect(progressBar.style.width).toBe("75%");
    expect(statusText.textContent).toBe("Loading race data...");
  });

  it("finishes at 100 percent when dismissed", async () => {
    vi.stubGlobal("setTimeout", (callback) => {
      callback();
      return 1;
    });
    const { screen, progressBar, statusText } = createLoadingScreen();

    screen.update(95, "Displaying Daily...");
    await screen.dismiss();

    expect(progressBar.style.width).toBe("100%");
    expect(statusText.textContent).toBe("Ready!");
    expect(screen.isComplete).toBe(true);
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
});
