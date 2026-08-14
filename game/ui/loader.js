// Matches the --dur-base fade the stylesheet gives #loading-screen.
const LOADER_FADE_MS = 160;

export class LoadingScreen {
  constructor() {
    this.element = document.getElementById("loading-screen");
    this.progressBar = document.getElementById("loader-progress-bar");
    this.statusText = document.getElementById("loader-status");
    this.retryButton = document.getElementById("loader-retry");
    this.activeClass = "loading-active";
    this.failedClass = "loader-failed";
    this.isComplete = false;
  }

  update(percent, status) {
    if (this.isComplete) return;

    const safePercent = Math.min(Math.max(0, percent), 100);

    if (this.progressBar) {
      this.progressBar.style.width = `${safePercent}%`;
    }

    if (this.statusText && status) {
      this.statusText.textContent = status;
    }

    if (this.element) {
      this.element.setAttribute("aria-valuenow", Math.round(safePercent));
    }
  }

  showPhase({ progress, label } = {}) {
    this.update(progress, label);
  }

  /**
   * A failed essential leaves nothing to reveal, so the loader stays up and owns the
   * retry rather than handing the player a lobby they cannot race from.
   */
  showError(message, onRetry) {
    if (this.isComplete) return;
    if (this.statusText) this.statusText.textContent = message;
    this.element?.classList?.add(this.failedClass);
    if (!this.retryButton) return;
    this.retryButton.hidden = false;
    if (this._retryHandler) {
      this.retryButton.removeEventListener("click", this._retryHandler);
    }
    this._retryHandler = () => {
      this.clearError();
      onRetry?.();
    };
    this.retryButton.addEventListener("click", this._retryHandler);
  }

  clearError() {
    this.element?.classList?.remove(this.failedClass);
    if (this.retryButton) this.retryButton.hidden = true;
  }

  async dismiss() {
    if (this.isComplete) return;
    this.update(100, "Ready!");
    this.isComplete = true;
    document.body.classList.remove(this.activeClass);
    await new Promise((resolve) => setTimeout(resolve, LOADER_FADE_MS));
  }
}
