/**
 * The thing that asks GitLab "what now?" on a timer.
 *
 * Three rules, all of them there to keep us inside a self-hosted instance's
 * default budget of 120 requests a minute:
 *
 *   1. Skip the tick entirely when the Pulsar window is not focused. Chromium
 *      throttles timers in a hidden window anyway, so fighting it would only
 *      waste requests; skipping and catching up on focus is what the official
 *      GitLab editor extension does.
 *   2. Back off on failure - 30s, 60s, 120s, then hold at 300s - and reset the
 *      moment a request succeeds. A VPN dropping should go quiet, not produce
 *      one error notification every half minute.
 *   3. A 429 suspends every poller pointed at that host, not just the one that
 *      got throttled. Being told to slow down and then having four other timers
 *      keep firing is how you get banned rather than throttled.
 */

const { Disposable, CompositeDisposable } = require('atom');

const DEFAULT_INTERVAL_MS = 30000;
const BACKOFF_LADDER_MS = [30000, 60000, 120000, 300000];

// host -> unix ms until which nothing may talk to that host.
const suspendedHosts = new Map();

function hostOf (baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch (err) {
    return String(baseUrl);
  }
}

function suspendHost (baseUrl, seconds) {
  const until = Date.now() + Math.max(1, seconds) * 1000;
  const host = hostOf(baseUrl);
  const existing = suspendedHosts.get(host) || 0;
  suspendedHosts.set(host, Math.max(existing, until));
}

function hostSuspendedFor (baseUrl) {
  const until = suspendedHosts.get(hostOf(baseUrl));
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    suspendedHosts.delete(hostOf(baseUrl));
    return 0;
  }
  return remaining;
}

function clearSuspensions () {
  suspendedHosts.clear();
}

class Poller {
  /**
   * @param {object} options
   * @param {function(): Promise} options.task - one round of work
   * @param {number} [options.intervalMs]
   * @param {string} [options.baseUrl] - which host this poller talks to
   * @param {function(Error): void} [options.onError]
   * @param {function(string): void} [options.onStateChange] - 'idle'|'polling'|'offline'|'stopped'
   * @param {boolean} [options.requireFocus] - false for a log tail the user is watching
   */
  constructor ({ task, intervalMs = DEFAULT_INTERVAL_MS, baseUrl = null, onError = null, onStateChange = null, requireFocus = true } = {}) {
    this.task = task;
    this.baseIntervalMs = intervalMs;
    this.baseUrl = baseUrl;
    this.onError = onError;
    this.onStateChange = onStateChange;
    this.requireFocus = requireFocus;

    this.timer = null;
    this.running = false;
    this.inFlight = false;
    this.failureCount = 0;
    this.lastRunAt = 0;
    this.state = 'stopped';
    this.subscriptions = new CompositeDisposable();

    // Catch up as soon as the user comes back, so the view is not stale for up
    // to a whole interval after they switch to the window.
    this.handleFocus = () => {
      if (!this.running) return;
      if (Date.now() - this.lastRunAt >= this.currentIntervalMs()) this.runNow();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.handleFocus);
      this.subscriptions.add(new Disposable(() => window.removeEventListener('focus', this.handleFocus)));
    }
  }

  currentIntervalMs () {
    if (this.failureCount === 0) return this.baseIntervalMs;
    const index = Math.min(this.failureCount - 1, BACKOFF_LADDER_MS.length - 1);
    return Math.max(this.baseIntervalMs, BACKOFF_LADDER_MS[index]);
  }

  setState (state) {
    if (this.state === state) return;
    this.state = state;
    if (this.onStateChange) this.onStateChange(state);
  }

  start () {
    if (this.running) return;
    this.running = true;
    this.setState('idle');
    this.schedule(0);
  }

  stop () {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setState('stopped');
  }

  dispose () {
    this.stop();
    this.subscriptions.dispose();
  }

  /**
   * A chain of setTimeout rather than one setInterval. With setInterval, a slow
   * request means the next tick fires while the previous one is still open and
   * they pile up; this way the next tick is only scheduled once the last one
   * finished.
   */
  schedule (delayMs) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delayMs);
  }

  windowIsFocused () {
    if (!this.requireFocus) return true;
    if (typeof document === 'undefined') return true;
    return document.hasFocus();
  }

  async tick () {
    if (!this.running) return;
    if (this.inFlight) {
      this.schedule(this.currentIntervalMs());
      return;
    }

    // Someone told us to slow down. Wait exactly as long as they asked.
    const suspendedFor = this.baseUrl ? hostSuspendedFor(this.baseUrl) : 0;
    if (suspendedFor > 0) {
      this.setState('idle');
      this.schedule(suspendedFor + 250);
      return;
    }

    if (!this.windowIsFocused()) {
      // Check again in a second - cheap, and it means we start within a second
      // of the user coming back even if the focus event was missed.
      this.schedule(1000);
      return;
    }

    this.inFlight = true;
    this.setState('polling');
    try {
      await this.task();
      this.failureCount = 0;
      this.lastRunAt = Date.now();
      this.setState('idle');
    } catch (err) {
      this.lastRunAt = Date.now();
      this.failureCount += 1;
      if (err && err.status === 429 && this.baseUrl) {
        suspendHost(this.baseUrl, err.retryAfter || 60);
      }
      this.setState('offline');
      if (this.onError) this.onError(err, this.failureCount);
    } finally {
      this.inFlight = false;
      this.schedule(this.currentIntervalMs());
    }
  }

  /** Run right now, then carry on from there. */
  runNow () {
    if (!this.running) return Promise.resolve();
    this.schedule(0);
    return Promise.resolve();
  }

  /** Change the cadence without losing the backoff state. */
  setInterval (intervalMs) {
    this.baseIntervalMs = intervalMs;
    if (this.running) this.schedule(this.currentIntervalMs());
  }
}

module.exports = { Poller, suspendHost, hostSuspendedFor, clearSuspensions, DEFAULT_INTERVAL_MS };
