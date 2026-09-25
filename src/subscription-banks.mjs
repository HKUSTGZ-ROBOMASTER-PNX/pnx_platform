export class SubscriptionBanks {
  constructor(onError, bankSize = 256, dwellMs = 250) {
    this.onError = onError;
    this.bankSize = bankSize;
    this.dwellMs = dwellMs;
    this.generation = 0;
    this.timer = null;
    this.pending = Promise.resolve();
  }

  stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async set(session, ids, rate) {
    this.stop();
    const generation = this.generation;
    const banks = Math.max(1, Math.ceil(ids.length / this.bankSize));
    const run = async (index, initial = false) => {
      if (generation !== this.generation || session.closed) return;
      const bank = ids.slice(index * this.bankSize, (index + 1) * this.bankSize);
      const operation = this.pending.then(() => {
        if (generation !== this.generation || session.closed) throw new Error('Subscription superseded');
        return session.subscribe(bank, rate);
      });
      this.pending = operation.catch(() => {});
      try { await operation; }
      catch (error) {
        if (generation === this.generation) this.onError(`采集分组 ${index + 1}/${banks}: ${error.message}`);
        if (initial) throw error;
      }
      if (generation === this.generation && !session.closed && banks > 1) {
        this.timer = setTimeout(() => { this.timer = null; void run((index + 1) % banks); }, this.dwellMs);
      }
    };
    await run(0, true);
    return { banks, bankSize: this.bankSize, dwellMs: banks > 1 ? this.dwellMs : 0 };
  }
}
