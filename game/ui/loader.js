export class LoadingScreen {
  constructor() {
    this.element = document.getElementById("loading-screen");
    this.progressBar = document.getElementById("loader-progress-bar");
    this.statusText = document.getElementById("loader-status");
    this.activeClass = "loading-active";
    this.isComplete = false;
    this.highestProgress = 0;
  }

  update(percent, status) {
    if (this.isComplete) return;

    const safePercent = Math.min(Math.max(0, percent), 100);
    this.highestProgress = Math.max(this.highestProgress, safePercent);
    
    if (this.progressBar) {
      this.progressBar.style.width = `${this.highestProgress}%`;
    }
    
    if (this.statusText && status) {
      this.statusText.textContent = status;
    }

    if (this.element) {
      this.element.setAttribute("aria-valuenow", Math.round(this.highestProgress));
    }
  }

  showPhase({ progress, label } = {}) {
    this.update(progress, label);
  }

  async dismiss({ fadeMs = 160 } = {}) {
    if (this.isComplete) return;
    const safeFadeMs = Math.max(0, Number(fadeMs) || 0);
    this.update(100, "Ready!");
    this.isComplete = true;
    this.element?.style?.setProperty("--loader-fade-duration", `${safeFadeMs}ms`);
    document.body.classList.remove(this.activeClass);
    await new Promise((resolve) => setTimeout(resolve, safeFadeMs));
  }
}
