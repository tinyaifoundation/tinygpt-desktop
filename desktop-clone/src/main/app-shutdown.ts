/** Electron can emit before-quit more than once while windows are closing. */
export class AppShutdown {
  private pending?: Promise<void>;
  private finished = false;

  request(event: { preventDefault(): void }, cleanup: () => Promise<void>, quit: () => void): Promise<void> {
    if (this.finished) return Promise.resolve();
    event.preventDefault();
    if (this.pending) return this.pending;
    // Assign pending before invoking cleanup, which can itself close windows
    // and synchronously cause another quit request.
    this.pending = Promise.resolve().then(cleanup).then(() => {
      this.finished = true;
      quit();
    }).catch(error => {
      this.pending = undefined;
      throw error;
    });
    return this.pending;
  }
}
