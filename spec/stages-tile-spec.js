const { StagesTile, dotsFor, worstStatus, MAX_DOTS } = require('../lib/views/stages-tile');

function stages (...pairs) {
  return pairs.map(([name, status]) => ({ name, status }));
}

function detailOf (...pairs) {
  return { stages: { nodes: stages(...pairs) } };
}

describe('the status bar stage strip', () => {
  describe('picking the worst status', () => {
    it('puts a failure above everything else', () => {
      expect(worstStatus(stages(['a', 'success'], ['b', 'failed'], ['c', 'running']))).toBe('failed');
    });

    it('prefers running over success', () => {
      expect(worstStatus(stages(['a', 'success'], ['b', 'running']))).toBe('running');
    });

    it('treats an unknown status as the least severe', () => {
      expect(worstStatus(stages(['a', 'wat'], ['b', 'running']))).toBe('running');
    });

    it('copes with an empty list', () => {
      expect(worstStatus([])).toBe(null);
    });
  });

  describe('folding a long strip', () => {
    it('leaves a short strip alone', () => {
      const dots = dotsFor(stages(['build', 'success'], ['test', 'running']));
      expect(dots.length).toBe(2);
      expect(dots.every((dot) => dot.folded === false)).toBe(true);
      expect(dots[0].title).toBe('build - passed');
    });

    it('shows exactly the cap without folding', () => {
      const many = Array.from({ length: MAX_DOTS }, (_, i) => ({ name: `s${i}`, status: 'success' }));
      const dots = dotsFor(many);
      expect(dots.length).toBe(MAX_DOTS);
      expect(dots.some((dot) => dot.folded)).toBe(false);
    });

    it('folds the tail into one dot once past the cap', () => {
      const many = Array.from({ length: MAX_DOTS + 4 }, (_, i) => ({ name: `s${i}`, status: 'success' }));
      const dots = dotsFor(many);
      expect(dots.length).toBe(MAX_DOTS);
      expect(dots[MAX_DOTS - 1].folded).toBe(true);
    });

    // The point of folding: a failure hidden in the tail must still be visible
    // as a red dot, or the strip lies about the pipeline.
    it('carries the worst hidden status out to the folded dot', () => {
      const many = Array.from({ length: MAX_DOTS + 3 }, (_, i) => ({ name: `s${i}`, status: 'success' }));
      many[many.length - 1].status = 'failed';
      const dots = dotsFor(many);
      const folded = dots[dots.length - 1];
      expect(folded.folded).toBe(true);
      expect(folded.status).toBe('failed');
      expect(folded.title).toContain('4 more stages');
      expect(folded.title).toContain('worst is failed');
    });

    it('points the folded dot at the first stage it hides', () => {
      const many = Array.from({ length: MAX_DOTS + 2 }, (_, i) => ({ name: `s${i}`, status: 'success' }));
      const dots = dotsFor(many);
      expect(dots[dots.length - 1].name).toBe(`s${MAX_DOTS - 1}`);
    });
  });

  describe('telling "not run yet" from "done"', () => {
    const { notRunYet } = require('../lib/views/stages-tile');

    it('treats queued and manual stages as not run', () => {
      for (const status of ['created', 'pending', 'manual', 'scheduled', 'skipped']) {
        expect(notRunYet(status)).toBe(true);
      }
    });

    it('treats finished and running stages as run', () => {
      for (const status of ['success', 'failed', 'running', 'canceled']) {
        expect(notRunYet(status)).toBe(false);
      }
    });

    it('does not care about casing', () => {
      expect(notRunYet('MANUAL')).toBe(true);
    });
  });

  describe('drawing', () => {
    let tile, selected;

    beforeEach(() => {
      selected = [];
      tile = new StagesTile({ onSelect: (name) => selected.push(name) });
    });

    afterEach(() => tile.destroy());

    it('draws one dot per stage', () => {
      tile.setPipeline(detailOf(['build', 'success'], ['test', 'failed'], ['deploy', 'created']));
      expect(tile.element.children.length).toBe(3);
      expect(tile.element.children[1].className).toContain('text-error');
    });

    // Circles, not octicons: the class carries the shape now, so a stray
    // `icon-check` creeping back in would silently change what a dot means.
    it('draws plain circles rather than status glyphs', () => {
      tile.setPipeline(detailOf(['build', 'success']));
      expect(tile.element.children[0].className).toContain('gl-sb-stage');
      expect(tile.element.children[0].className).not.toContain('icon-');
    });

    it('draws stages that have not run as hollow circles', () => {
      tile.setPipeline(detailOf(['build', 'success'], ['deploy', 'manual']));
      expect(tile.element.children[0].className).not.toContain('gl-sb-stage-open');
      expect(tile.element.children[1].className).toContain('gl-sb-stage-open');
    });

    it('opens the panel at the stage that was clicked', () => {
      tile.setPipeline(detailOf(['build', 'success'], ['test', 'running']));
      tile.element.children[1].click();
      expect(selected).toEqual(['test']);
    });

    it('shows a single dot when nothing is running', () => {
      tile.setPipeline(detailOf());
      expect(tile.element.children.length).toBe(1);
      expect(tile.element.children[0].title).toContain('No pipeline running');
    });

    it('is subdued when there is nothing to report', () => {
      tile.setInactive('No GitLab remote in this project.');
      expect(tile.element.classList.contains('gl-status-inactive')).toBe(true);
      expect(tile.element.children[0].title).toBe('No GitLab remote in this project.');
    });

    it('drops the subdued look once a pipeline comes back', () => {
      tile.setInactive();
      tile.setPipeline(detailOf(['build', 'success']));
      expect(tile.element.classList.contains('gl-status-inactive')).toBe(false);
    });

    it('stays hidden through a repaint', () => {
      tile.setVisible(false);
      tile.setPipeline(detailOf(['build', 'success']));
      expect(tile.element.style.display).toBe('none');
      tile.setOffline('boom');
      expect(tile.element.style.display).toBe('none');
    });

    it('replaces dots rather than piling them up', () => {
      tile.setPipeline(detailOf(['a', 'success'], ['b', 'success'], ['c', 'success']));
      tile.setPipeline(detailOf(['a', 'success']));
      expect(tile.element.children.length).toBe(1);
    });
  });
});
