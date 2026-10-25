// The transport receives the run's cancellation signal so an in-flight
// command cannot wait for a hung WebView to send a close event.
export class Cdp {
  constructor(wsUrl, { assertHealthy = () => {}, signal, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.assertHealthy = assertHealthy;
    this.signal = signal;
    this.WebSocketImpl = WebSocketImpl;
    this.failure = null;
    this.rejectConnect = null;
    this.onAbort = () => this.abort(signal.reason || new Error('Background run stopped'));
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  check() {
    if (this.failure) throw this.failure;
    this.assertHealthy();
  }

  async connect() {
    this.check();
    this.ws = new this.WebSocketImpl(this.wsUrl);
    const opened = new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      this.ws.onopen = () => { this.rejectConnect = null; resolve(); };
    });
    this.ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result);
      } catch (error) { this.abort(error); }
    };
    this.ws.onclose = () => this.abort(new Error('Owned CDP connection closed'));
    this.ws.onerror = () => this.abort(new Error('Owned CDP transport failed'));
    await opened;
    await this.send('Runtime.enable');
  }

  send(method, params = {}) {
    this.check();
    if (['Browser.setWindowBounds', 'Page.bringToFront', 'Target.activateTarget'].includes(method)) {
      return Promise.reject(new Error('Direct browser activation/window-state bypass is forbidden in background E2E'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.abort(error); }
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const desc = d.exception?.description || d.text || 'unknown';
      throw new Error(`JS 异常: ${String(desc).split('\n').slice(0, 3).join(' | ')}`);
    }
    return r.result?.value;
  }

  abort(reason) {
    if (this.failure) return;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    this.rejectConnect?.(this.failure);
    this.rejectConnect = null;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.signal?.removeEventListener('abort', this.onAbort);
    try { this.ws?.close(); } catch {}
  }

  close() { this.abort(new Error('Owned CDP connection closed')); }
}
