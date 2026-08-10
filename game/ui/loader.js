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
    if (safePercent < this.highestProgress) return;
    this.highestProgress = safePercent;
    
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

  async dismiss() {
    if (this.isComplete) return;
    this.update(100, "Ready!");
    this.isComplete = true;

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    document.body.classList.remove(this.activeClass);
    
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
