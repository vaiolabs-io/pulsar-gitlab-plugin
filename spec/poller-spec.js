const { Poller, suspendHost, hostSuspendedFor, clearSuspensions } = require('../lib/poller');

function wait (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Poller', () => {
  let poller;

  beforeEach(() => {
    // Pulsar's spec environment replaces setTimeout and Date.now with a fake
    // clock. This module is all about real elapsed time, so put the real ones
    // back for the length of this file.
    jasmine.useRealClock();
    clearSuspensions();
  });

  afterEach(() => { if (poller) poller.dispose(); });

  it('runs the task immediately on start', async () => {
    let runs = 0;
    poller = new Poller({ task: async () => { runs += 1; }, intervalMs: 10000, requireFocus: false });
    poller.start();
    await wait(50);
    expect(runs).toBe(1);
  });

  it('keeps running on the interval', async () => {
    let runs = 0;
    poller = new Poller({ task: async () => { runs += 1; }, intervalMs: 30, requireFocus: false });
    poller.start();
    await wait(140);
    expect(runs).toBeGreaterThan(2);
  });

  it('stops when told to', async () => {
    let runs = 0;
    poller = new Poller({ task: async () => { runs += 1; }, intervalMs: 20, requireFocus: false });
    poller.start();
    await wait(60);
    poller.stop();
    const after = runs;
    await wait(80);
    expect(runs).toBe(after);
  });

  it('does not let a slow task pile up', async () => {
    // A setInterval would fire again while the previous request was still
    // open; the chained setTimeout cannot.
    let open = 0;
    let maxOpen = 0;
    poller = new Poller({
      intervalMs: 5,
      requireFocus: false,
      task: async () => {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        await wait(40);
        open -= 1;
      }
    });
    poller.start();
    await wait(200);
    expect(maxOpen).toBe(1);
  });

  describe('backing off', () => {
    it('widens the gap after each failure and resets on success', async () => {
      let shouldFail = true;
      poller = new Poller({
        intervalMs: 10,
        requireFocus: false,
        task: async () => { if (shouldFail) throw new Error('nope'); }
      });
      poller.start();
      await wait(60);
      expect(poller.failureCount).toBeGreaterThan(0);
      // 30s is the first rung of the ladder, well above the 10ms base.
      expect(poller.currentIntervalMs()).toBeGreaterThanOrEqual(30000);

      shouldFail = false;
      await poller.tick();
      expect(poller.failureCount).toBe(0);
      expect(poller.currentIntervalMs()).toBe(10);
    });

    it('reports the failure through onError', async () => {
      const seen = [];
      poller = new Poller({
        intervalMs: 10000,
        requireFocus: false,
        task: async () => { throw new Error('boom'); },
        onError: (err) => seen.push(err.message)
      });
      poller.start();
      await wait(50);
      expect(seen).toEqual(['boom']);
    });

    it('goes to the offline state and back', async () => {
      const states = [];
      let shouldFail = true;
      poller = new Poller({
        intervalMs: 10000,
        requireFocus: false,
        task: async () => { if (shouldFail) throw new Error('nope'); },
        onStateChange: (state) => states.push(state)
      });
      poller.start();
      await wait(50);
      expect(states).toContain('offline');
      shouldFail = false;
      await poller.tick();
      expect(states[states.length - 1]).toBe('idle');
    });
  });

  describe('rate limiting', () => {
    it('suspends every poller pointed at the same host', () => {
      // Being told to slow down and then letting four other timers keep firing
      // is how you get banned rather than throttled.
      suspendHost('https://git.sds.lab/api/v4', 30);
      expect(hostSuspendedFor('https://git.sds.lab')).toBeGreaterThan(25000);
      expect(hostSuspendedFor('https://gitlab.com')).toBe(0);
    });

    it('honours Retry-After from a 429', async () => {
      poller = new Poller({
        intervalMs: 10,
        requireFocus: false,
        baseUrl: 'https://git.sds.lab',
        task: async () => {
          const err = new Error('slow down');
          err.status = 429;
          err.retryAfter = 45;
          throw err;
        }
      });
      poller.start();
      await wait(60);
      expect(hostSuspendedFor('https://git.sds.lab')).toBeGreaterThan(40000);
    });

    it('still waits a moment when Retry-After is zero or missing', () => {
      // GitLab occasionally answers 429 with no usable Retry-After. Treating
      // that as "no wait" would spin straight back into the throttle.
      suspendHost('https://git.sds.lab', 0);
      expect(hostSuspendedFor('https://git.sds.lab')).toBeGreaterThan(0);
    });

    it('forgets the suspension once it has passed', async () => {
      suspendHost('https://git.sds.lab', 0);
      await wait(1100);
      expect(hostSuspendedFor('https://git.sds.lab')).toBe(0);
    });
  });

  describe('focus', () => {
    it('skips the tick when the window is not focused', async () => {
      let runs = 0;
      spyOn(document, 'hasFocus').and.returnValue(false);
      poller = new Poller({ task: async () => { runs += 1; }, intervalMs: 10, requireFocus: true });
      poller.start();
      await wait(80);
      expect(runs).toBe(0);
    });

    it('runs anyway when focus is not required', async () => {
      // A job log the user opened on purpose must keep tailing while they read
      // the code in another window.
      let runs = 0;
      spyOn(document, 'hasFocus').and.returnValue(false);
      poller = new Poller({ task: async () => { runs += 1; }, intervalMs: 10, requireFocus: false });
      poller.start();
      await wait(60);
      expect(runs).toBeGreaterThan(0);
    });
  });

  it('cleans its timer up on dispose', async () => {
    let runs = 0;
    poller = new Poller({ task: async () => { runs += 1; }, intervalMs: 15, requireFocus: false });
    poller.start();
    await wait(50);
    poller.dispose();
    const after = runs;
    await wait(80);
    expect(runs).toBe(after);
    poller = null;
  });
});
