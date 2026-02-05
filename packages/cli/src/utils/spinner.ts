/**
 * Simple terminal spinner for slow operations.
 *
 * Features:
 * - TTY detection: silent in non-TTY environments (CI, pipes)
 * - Delayed display: spinner only appears after 100ms to avoid flicker
 * - Elapsed time: shows seconds for long operations
 *
 * Usage:
 *   const spinner = new Spinner('Querying graph...');
 *   spinner.start();
 *   await slowOperation();
 *   spinner.stop();
 *
 * IMPORTANT: Always call stop() BEFORE any console.log output.
 */
export class Spinner {
  private message: string;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private interval: ReturnType<typeof setInterval> | null = null;
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
  private frameIndex = 0;
  private startTime = 0;
  private displayDelay: number;
  private isSpinning = false;

  constructor(message: string, displayDelay = 100) {
    this.message = message;
    this.displayDelay = displayDelay;
  }

  /**
   * Start the spinner. Spinner appears only after displayDelay ms.
   * In non-TTY environments (CI, pipes), this is a no-op.
   */
  start(): void {
    // TTY check - ora pattern
    if (!process.stdout.isTTY) {
      return;
    }

    this.startTime = Date.now();

    // Defer display to avoid flicker on fast queries
    this.displayTimer = setTimeout(() => {
      this.isSpinning = true;
      this.render();

      // Animate frames at 80ms interval
      this.interval = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % this.frames.length;
        this.render();
      }, 80);
    }, this.displayDelay);
  }

  private render(): void {
    if (!this.isSpinning) return;

    const frame = this.frames[this.frameIndex];
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const timeStr = elapsed > 0 ? ` (${elapsed}s)` : '';

    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`${frame} ${this.message}${timeStr}`);
  }

  /**
   * Stop the spinner and clear the line.
   * Safe to call multiple times or if spinner never started.
   */
  stop(): void {
    // Clear deferred display timer
    if (this.displayTimer) {
      clearTimeout(this.displayTimer);
      this.displayTimer = null;
    }

    // Stop animation
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Clear line if we were displaying
    if (this.isSpinning && process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }

    this.isSpinning = false;
  }
}
