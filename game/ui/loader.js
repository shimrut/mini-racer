// Matches the --dur-base CSS fade.
const LOADER_FADE_MS = 160;

export class LoadingScreen {
  constructor() {
    this.element = document.getElementById("loading-screen");
    this.statusText = document.getElementById("loader-status");
    this.retryButton = document.getElementById("loader-retry");
    this.activeClass = "loading-active";
    this.failedClass = "loader-failed";
    this.isComplete = false;
  }

  begin(label) {
    this.isComplete = false;
    this.clearError();
    this.element?.setAttribute("aria-valuenow", "0");
    document.body.classList.add(this.activeClass);
    this.setStatus(label);
  }

  setStatus(status) {
    if (this.isComplete || !status) return;
    if (this.statusText) this.statusText.textContent = status;
    this.element?.setAttribute("aria-valuetext", status);
  }

  update(_percent, status) {
    this.setStatus(status);
  }

  showPhase({ label } = {}) {
    this.setStatus(label);
  }

  showError(message, onRetry) {
    if (this.isComplete) return;
    this.setStatus(message);
    this.element?.classList?.add(this.failedClass);
    this.element?.setAttribute("aria-busy", "false");
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
    this.element?.setAttribute("aria-busy", "true");
    if (this.retryButton) this.retryButton.hidden = true;
  }

  async dismiss() {
    if (this.isComplete) return;
    this.setStatus("Ready!");
    this.isComplete = true;
    this.element?.setAttribute("aria-busy", "false");
    this.element?.setAttribute("aria-valuenow", "100");
    document.body.classList.remove(this.activeClass);
    await new Promise((resolve) => setTimeout(resolve, LOADER_FADE_MS));
  }
}
