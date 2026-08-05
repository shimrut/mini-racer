/**
 * Manages the global game loading screen.
 * Synchronizes the progress bar, status text, and the final reveal transition.
 */
export class LoadingScreen {
  constructor() {
    this.element = document.getElementById("loading-screen");
    this.progressBar = document.getElementById("loader-progress-bar");
    this.statusText = document.getElementById("loader-status");
    this.activeClass = "loading-active";
    this.isComplete = false;
    this.highestProgress = 0;
  }

  /**
   * Updates the visual state of the loader.
   * @param {number} percent - 0 to 100
   * @param {string} status - Human-readable status message
   */
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

  /**
   * Dismisses the loader with a smooth transition.
   * Ensures the final frame is painted before the element is removed from view.
   */
  async dismiss() {
    if (this.isComplete) return;
    this.update(100, "Ready!");
    this.isComplete = true;

    // Double frame wait to ensure browser has painted the lobby behind the loader
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    document.body.classList.remove(this.activeClass);
    
    // Optional: wait for CSS transition to finish before doing any heavy logic
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
