const { JobsTile, countJobs } = require('../lib/views/jobs-tile');

function detailOf (...statuses) {
  return {
    stages: {
      nodes: [{ jobs: { nodes: statuses.map((status, i) => ({ id: i, status })) } }]
    }
  };
}

describe('the job progress tile', () => {
  describe('counting', () => {
    it('counts nothing when there is no detail', () => {
      expect(countJobs(null)).toEqual({ total: 0, done: 0, failed: 0, running: 0 });
      expect(countJobs({})).toEqual({ total: 0, done: 0, failed: 0, running: 0 });
    });

    it('counts a mixed pipeline', () => {
      const counts = countJobs(detailOf('success', 'success', 'running', 'created'));
      expect(counts).toEqual({ total: 4, done: 2, failed: 0, running: 1 });
    });

    // A failed job is finished as well as failed. Counting it only as failed
    // would leave the progress stuck below the total for ever.
    it('treats a failed job as finished too', () => {
      const counts = countJobs(detailOf('success', 'failed'));
      expect(counts.total).toBe(2);
      expect(counts.done).toBe(2);
      expect(counts.failed).toBe(1);
    });

    it('does not count a manual job as finished - it is waiting on a person', () => {
      const counts = countJobs(detailOf('success', 'manual'));
      expect(counts.done).toBe(1);
      expect(counts.total).toBe(2);
    });

    it('counts cancelled and skipped as finished', () => {
      const counts = countJobs(detailOf('canceled', 'skipped'));
      expect(counts.done).toBe(2);
      expect(counts.failed).toBe(0);
    });

    // GraphQL sends upper case, REST lower. Same trap that broke 0.1.1.
    it('does not care about the casing GitLab used', () => {
      expect(countJobs(detailOf('SUCCESS', 'FAILED', 'RUNNING')))
        .toEqual({ total: 3, done: 2, failed: 1, running: 1 });
    });

    it('adds up across several stages', () => {
      const detail = {
        stages: {
          nodes: [
            { jobs: { nodes: [{ status: 'success' }, { status: 'success' }] } },
            { jobs: { nodes: [{ status: 'running' }] } },
            { jobs: {} }
          ]
        }
      };
      expect(countJobs(detail)).toEqual({ total: 3, done: 2, failed: 0, running: 1 });
    });
  });

  describe('drawing', () => {
    let tile, clicks;

    beforeEach(() => {
      clicks = 0;
      tile = new JobsTile({ onClick: () => { clicks += 1; } });
    });

    afterEach(() => tile.destroy());

    it('shows finished over total', () => {
      tile.setPipeline(detailOf('success', 'success', 'running'));
      expect(tile.textEl.textContent).toBe(' 2/3 jobs');
    });

    it('calls out failures in the text, not just the tooltip', () => {
      tile.setPipeline(detailOf('success', 'failed', 'failed'));
      expect(tile.textEl.textContent).toBe(' 3/3 jobs, 2 failed');
      expect(tile.iconEl.className).toContain('text-error');
    });

    it('goes green only when everything finished cleanly', () => {
      tile.setPipeline(detailOf('success', 'success'));
      expect(tile.iconEl.className).toContain('text-success');
    });

    it('shows running while anything is still going', () => {
      tile.setPipeline(detailOf('success', 'running'));
      expect(tile.iconEl.className).toContain('text-info');
    });

    it('falls back to idle when the pipeline has no jobs', () => {
      tile.setPipeline(detailOf());
      expect(tile.textEl.textContent).toBe(' no jobs');
    });

    it('is clickable', () => {
      tile.element.click();
      expect(clicks).toBe(1);
    });

    it('is subdued when there is nothing to report', () => {
      tile.setInactive('No GitLab remote in this project.');
      expect(tile.element.classList.contains('gl-status-inactive')).toBe(true);
      expect(tile.element.title).toBe('No GitLab remote in this project.');
      expect(tile.element.style.display).toBe('');
    });

    // Same rule as the pipeline light: only the setting writes display.
    it('stays hidden through a repaint', () => {
      tile.setVisible(false);
      tile.setPipeline(detailOf('success'));
      expect(tile.element.style.display).toBe('none');
      tile.setInactive();
      expect(tile.element.style.display).toBe('none');
      tile.setOffline('boom');
      expect(tile.element.style.display).toBe('none');
    });
  });
});
