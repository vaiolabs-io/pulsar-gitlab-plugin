const { StatusTile } = require('../lib/views/status-tile');

describe('the status bar tile', () => {
  let tile, clicks;

  beforeEach(() => {
    clicks = 0;
    tile = new StatusTile({ onClick: () => { clicks += 1; } });
  });

  afterEach(() => tile.destroy());

  describe('nothing to report', () => {
    it('stays on screen instead of vanishing', () => {
      tile.setInactive('No GitLab remote in this project.');
      expect(tile.element.style.display).toBe('');
    });

    it('says which kind of nothing it is', () => {
      tile.setInactive('No GitLab connection yet - click to add one.');
      expect(tile.element.title).toBe('No GitLab connection yet - click to add one.');
    });

    it('falls back to a sensible reason', () => {
      tile.setInactive();
      expect(tile.element.title).toBe('No GitLab remote in this project.');
    });

    it('is subdued, so it does not read as a live status', () => {
      tile.setInactive();
      expect(tile.element.classList.contains('gl-status-inactive')).toBe(true);
      expect(tile.iconEl.className).toContain('text-subtle');
    });

    it('is still clickable, because the panel is where you fix it', () => {
      tile.setInactive();
      tile.element.click();
      expect(clicks).toBe(1);
    });

    it('drops the subdued look once there is a pipeline again', () => {
      tile.setInactive();
      tile.setPipeline({ status: 'SUCCESS', iid: 7, ref: 'main' });
      expect(tile.element.classList.contains('gl-status-inactive')).toBe(false);
    });
  });

  describe('the showStatusBar setting', () => {
    it('hides the tile when turned off', () => {
      tile.setVisible(false);
      expect(tile.element.style.display).toBe('none');
    });

    it('brings it back when turned on', () => {
      tile.setVisible(false);
      tile.setVisible(true);
      expect(tile.element.style.display).toBe('');
    });

    // The regression: every setter used to write display = '', so the next
    // poll put the tile back on screen after the user had switched it off.
    it('stays hidden through a repaint', () => {
      tile.setVisible(false);
      tile.setPipeline({ status: 'RUNNING', iid: 12, ref: 'main' });
      expect(tile.element.style.display).toBe('none');
      tile.setIdle();
      expect(tile.element.style.display).toBe('none');
      tile.setInactive();
      expect(tile.element.style.display).toBe('none');
      tile.setOffline('boom');
      expect(tile.element.style.display).toBe('none');
    });
  });

  describe('reporting a pipeline', () => {
    it('shows the pipeline number and keeps the status colour', () => {
      tile.setPipeline({ status: 'SUCCESS', iid: 42, ref: 'main' });
      expect(tile.textEl.textContent).toContain('#42');
      expect(tile.iconEl.className).toContain('icon-');
      expect(tile.element.title).toContain('#42');
    });

    it('falls back to idle when there is no pipeline', () => {
      tile.setPipeline(null);
      expect(tile.textEl.textContent).toBe(' GitLab');
    });
  });

  describe('offline', () => {
    it('is subdued and carries the reason', () => {
      tile.setOffline('Cannot reach https://git.example');
      expect(tile.element.classList.contains('gl-status-inactive')).toBe(true);
      expect(tile.element.title).toBe('Cannot reach https://git.example');
      expect(tile.element.style.display).toBe('');
    });
  });
});
