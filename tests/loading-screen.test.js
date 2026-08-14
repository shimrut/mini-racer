import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadingScreen } from "../game/ui/loader.js";

function createLoadingScreen() {
  const element = { setAttribute: vi.fn(), style: { setProperty: vi.fn() } };
  const progressBar = { style: {} };
  const statusText = { textContent: "" };
  const nodes = {
    "loading-screen": element,
    "loader-progress-bar": progressBar,
    "loader-status": statusText,
  };

  vi.stubGlobal("document", {
    body: { classList: { remove: vi.fn() } },
    getElementById: vi.fn((id) => nodes[id] ?? null),
  });

  return { screen: new LoadingScreen(), element, progressBar, statusText };
}

describe("LoadingScreen", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps progress monotonic while showing the current ordered phase", () => {
    const { screen, progressBar, statusText } = createLoadingScreen();

    screen.update(70, "Loading Campaign...");
    screen.update(50, "Profile Loaded...");

    expect(progressBar.style.width).toBe("70%");
    expect(statusText.textContent).toBe("Profile Loaded...");
    expect(screen.highestProgress).toBe(70);

    screen.update(75, "Syncing Graphics...");

    expect(progressBar.style.width).toBe("75%");
    expect(statusText.textContent).toBe("Syncing Graphics...");
  });

  it("finishes at 100 percent when dismissed", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback) => {
      callback();
      return 1;
    });
    vi.stubGlobal("setTimeout", (callback) => {
      callback();
      return 1;
    });
    const { screen, element, progressBar, statusText } = createLoadingScreen();

    screen.update(95, "Displaying Lobby...");
    await screen.dismiss({ fadeMs: 40 });

    expect(progressBar.style.width).toBe("100%");
    expect(statusText.textContent).toBe("Ready!");
    expect(screen.isComplete).toBe(true);
    expect(element.style.setProperty).toHaveBeenCalledWith("--loader-fade-duration", "40ms");
  });
});
