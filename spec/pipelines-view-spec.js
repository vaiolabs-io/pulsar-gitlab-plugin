const { PipelinesView, PIPELINES_URI, humanDuration, lookOf } = require('../lib/views/pipelines-view');

function pipelineDetail (overrides = {}) {
  return Object.assign({
    id: 'gid://gitlab/Ci::Pipeline/9',
    iid: 42,
    status: 'running',
    ref: 'main',
    duration: 95,
    cancelable: true,
    retryable: false,
    stages: {
      nodes: [
        {
          name: 'build',
          status: 'success',
          jobs: {
            nodes: [
              { id: 'gid://gitlab/Ci::Build/1', name: 'compile', status: 'success', duration: 30, playable: false, retryable: true, cancelable: false, allowFailure: false }
            ]
          }
        },
        {
          name: 'test',
          status: 'running',
          jobs: {
            nodes: [
              { id: 'gid://gitlab/Ci::Build/2', name: 'unit', status: 'running', duration: null, playable: false, retryable: false, cancelable: true, allowFailure: false },
              { id: 'gid://gitlab/Ci::Build/3', name: 'deploy', status: 'manual', duration: null, playable: true, retryable: false, cancelable: false, allowFailure: false }
            ]
          }
        }
      ]
    }
  }, overrides);
}

const baseModel = {
  context: { projectPath: 'team/app', branch: 'main', connectionId: 'c1', connectionName: 'lab', remoteName: 'origin', host: 'git.sds.lab' },
  connections: [{ id: 'c1', name: 'lab' }],
  project: { id: 7, path_with_namespace: 'team/app' },
  pipelines: [],
  schedules: [],
  canWrite: true,
  error: null,
  status: 'idle'
};

describe('PipelinesView', () => {
  let view;

  beforeEach(() => { view = new PipelinesView(); });
  afterEach(() => view.destroy());

  describe('the workspace item contract', () => {
    it('describes itself so Pulsar can dock it', () => {
      expect(view.getTitle()).toBe('GitLab Pipelines');
      expect(view.getURI()).toBe(PIPELINES_URI);
      expect(view.getDefaultLocation()).toBe('right');
      expect(view.getAllowedLocations()).toEqual(['left', 'right', 'bottom']);
      expect(view.getElement().tagName).toBe('DIV');
    });

    it('serializes enough to come back after a window reload', () => {
      view.expandedSections.add('schedules');
      const state = view.serialize();
      expect(state.deserializer).toBe('GitlabPipelinesView');
      const restored = new PipelinesView(state);
      expect(restored.expandedSections.has('schedules')).toBe(true);
      restored.destroy();
    });

    it('opens in the right dock, not the centre', async () => {
      const opener = atom.workspace.addOpener((uri) => (uri === PIPELINES_URI ? new PipelinesView() : undefined));
      const item = await atom.workspace.open(PIPELINES_URI);
      expect(atom.workspace.getRightDock().getPaneItems()).toContain(item);
      expect(atom.workspace.getCenter().getPaneItems().length).toBe(0);
      opener.dispose();
    });
  });

  describe('rendering a pipeline', () => {
    beforeEach(() => view.update(Object.assign({}, baseModel, { detail: pipelineDetail() })));

    it('shows the project and branch', () => {
      expect(view.contextProjectEl.textContent).toBe('team/app');
      expect(view.contextBranchEl.textContent).toContain('main');
    });

    it('renders one row per job, grouped by stage, in stage order', () => {
      const stages = view.element.querySelectorAll('.gl-stage');
      expect(stages.length).toBe(2);
      expect(stages[0].querySelector('.gl-stage-name').textContent).toBe('build');
      expect(stages[1].querySelector('.gl-stage-name').textContent).toBe('test');
      expect(view.element.querySelectorAll('.gl-job').length).toBe(3);
    });

    it('offers Cancel on a running pipeline but not Retry', () => {
      const titles = Array.from(view.pipelineSummaryActions.querySelectorAll('button')).map((b) => b.title);
      expect(titles).toContain('Cancel');
      expect(titles).not.toContain('Retry');
    });

    it('offers actions per job based on GitLab\'s own flags, not the status', () => {
      // This is the whole reason the detail pane uses GraphQL: guessing from
      // the status string offers buttons that then fail with a 400.
      const rows = view.element.querySelectorAll('.gl-job');
      const titlesFor = (row) => Array.from(row.querySelectorAll('button')).map((b) => b.title);
      expect(titlesFor(rows[0])).toEqual(['Retry this job']);
      expect(titlesFor(rows[1])).toEqual(['Cancel this job']);
      expect(titlesFor(rows[2])).toEqual(['Run this job']);
    });

    it('hides every write button when the token is read-only', () => {
      view.update({ canWrite: false });
      expect(view.element.querySelectorAll('.gl-job button').length).toBe(0);
      expect(view.runButton.disabled).toBe(true);
    });
  });

  describe('the stage strip', () => {
    beforeEach(() => view.update(Object.assign({}, baseModel, { detail: pipelineDetail() })));

    const cells = () => view.element.querySelectorAll('.gl-stage-strip .gl-strip-stage');

    it('shows one cell per stage, in the order GitLab runs them', () => {
      expect(cells().length).toBe(2);
      expect(cells()[0].querySelector('.gl-strip-name').textContent).toBe('build');
      expect(cells()[1].querySelector('.gl-strip-name').textContent).toBe('test');
    });

    it('gives each stage its own glyph, not just a colour', () => {
      // Colour alone is unreadable for a lot of people and vanishes in a
      // high-contrast theme.
      expect(cells()[0].querySelector('.gl-strip-dot').className).toContain('icon-check');
      expect(cells()[1].querySelector('.gl-strip-dot').className).toContain('icon-sync');
    });

    it('labels each stage with its job progress for screen readers and tooltips', () => {
      expect(cells()[0].getAttribute('aria-label')).toBe('build - passed (1/1 jobs)');
      expect(cells()[1].getAttribute('aria-label')).toBe('test - running (0/2 jobs)');
    });

    it('patches cells in place rather than rebuilding the strip', () => {
      const before = cells()[1];
      const next = pipelineDetail();
      next.stages.nodes[1].status = 'failed';
      view.update({ detail: next });
      expect(cells()[1]).toBe(before);
      expect(cells()[1].querySelector('.gl-strip-dot').className).toContain('icon-x');
    });

    it('adds and removes cells as the stage list changes', () => {
      const next = pipelineDetail();
      next.stages.nodes.push({ name: 'deploy', status: 'manual', jobs: { nodes: [] } });
      view.update({ detail: next });
      expect(cells().length).toBe(3);
      expect(cells()[2].querySelector('.gl-strip-name').textContent).toBe('deploy');

      const fewer = pipelineDetail();
      fewer.stages.nodes = [fewer.stages.nodes[0]];
      view.update({ detail: fewer });
      expect(cells().length).toBe(1);
    });

    it('keeps display order when GitLab reorders the stages', () => {
      const next = pipelineDetail();
      next.stages.nodes.reverse();
      view.update({ detail: next });
      expect(cells()[0].querySelector('.gl-strip-name').textContent).toBe('test');
      expect(cells()[1].querySelector('.gl-strip-name').textContent).toBe('build');
    });

    it('never lets a stage name reach a tooltip as HTML', () => {
      // atom.tooltips.add defaults to html:true and assigns straight to
      // innerHTML with no sanitising. Stage names come from a GitLab server,
      // so this has to be off.
      const added = [];
      spyOn(atom.tooltips, 'add').and.callFake((el, options) => {
        added.push(options);
        return { dispose () {} };
      });
      const fresh = new PipelinesView();
      fresh.update(Object.assign({}, baseModel, { detail: pipelineDetail() }));
      expect(added.length).toBeGreaterThan(0);
      for (const options of added) expect(options.html).toBe(false);
      fresh.destroy();
    });

    it('reads the tooltip text fresh on each hover instead of re-adding it', () => {
      // A title function means a status change needs no dispose/re-add cycle,
      // so a tooltip can never be dropped mid-hover.
      const cell = view.stripCells.get('test');
      const original = cell.tooltip;
      expect(typeof atom.tooltips.findTooltips(cell.root)[0].getTitle()).toBe('string');
      expect(atom.tooltips.findTooltips(cell.root)[0].getTitle()).toContain('running');

      const next = pipelineDetail();
      next.stages.nodes[1].status = 'failed';
      view.update({ detail: next });
      expect(view.stripCells.get('test').tooltip).toBe(original);
      expect(atom.tooltips.findTooltips(cell.root)[0].getTitle()).toContain('failed');
    });

    it('disposes a tooltip when its stage disappears', () => {
      // atom.tooltips holds the target in a plain Map and adds a window resize
      // listener per tooltip; removing the element alone leaks both.
      const cell = view.stripCells.get('test');
      let disposed = false;
      cell.tooltip = { dispose: () => { disposed = true; } };
      const fewer = pipelineDetail();
      fewer.stages.nodes = [fewer.stages.nodes[0]];
      view.update({ detail: fewer });
      expect(disposed).toBe(true);
      expect(view.stripCells.has('test')).toBe(false);
    });

    it('scrolls to the stage when a cell is clicked', () => {
      const row = view.stageRows.get('test');
      let scrolled = false;
      row.root.scrollIntoView = () => { scrolled = true; };
      cells()[1].click();
      expect(scrolled).toBe(true);
      expect(row.root.classList.contains('gl-stage-flash')).toBe(true);
    });

    it('opens the section first, so a click on a collapsed panel is not a no-op', () => {
      view.expandedSections.delete('current');
      const row = view.stageRows.get('build');
      row.root.scrollIntoView = () => {};
      cells()[0].click();
      expect(view.expandedSections.has('current')).toBe(true);
    });

    it('still draws a stage whose status GitLab only invented later', () => {
      // The bug in gitlab-integration, the package this feature is modelled on:
      // its status switch had no default, so `canceling` or `waiting_for_resource`
      // rendered an empty span - an invisible gap in the strip. GitLab has grown
      // that vocabulary twice, so unknown must stay visible and named.
      const next = pipelineDetail();
      next.stages.nodes[1].status = 'waiting_for_resource';
      view.update({ detail: next });
      const dot = cells()[1].querySelector('.gl-strip-dot');
      expect(dot.className).toContain('icon-');
      expect(cells()[1].getAttribute('aria-label')).toContain('waiting for a runner');

      const invented = pipelineDetail();
      invented.stages.nodes[1].status = 'quantum_pending_2031';
      view.update({ detail: invented });
      expect(cells()[1].querySelector('.gl-strip-dot').className).toContain('icon-primitive-dot');
      expect(cells()[1].getAttribute('aria-label')).toContain('quantum_pending_2031');
    });

    it('clears the strip when there is no pipeline', () => {
      view.update({ detail: null });
      expect(view.stripCells.size).toBe(0);
    });
  });

  describe('patching rather than rebuilding', () => {
    it('keeps the same DOM node for a job across an update', () => {
      // If the rows were rebuilt every poll, scroll position, focus and text
      // selection would be thrown away every thirty seconds.
      view.update(Object.assign({}, baseModel, { detail: pipelineDetail() }));
      const before = view.element.querySelectorAll('.gl-job')[1];
      const next = pipelineDetail();
      next.stages.nodes[1].jobs.nodes[0].status = 'success';
      next.stages.nodes[1].jobs.nodes[0].cancelable = false;
      next.stages.nodes[1].jobs.nodes[0].retryable = true;
      view.update({ detail: next });
      const after = view.element.querySelectorAll('.gl-job')[1];
      expect(after).toBe(before);
      expect(after.querySelector('.icon').className).toContain('icon-check');
    });

    it('removes rows for jobs that disappeared', () => {
      view.update(Object.assign({}, baseModel, { detail: pipelineDetail() }));
      expect(view.element.querySelectorAll('.gl-job').length).toBe(3);
      const smaller = pipelineDetail();
      smaller.stages.nodes[1].jobs.nodes = [smaller.stages.nodes[1].jobs.nodes[0]];
      view.update({ detail: smaller });
      expect(view.element.querySelectorAll('.gl-job').length).toBe(2);
    });
  });

  describe('schedules', () => {
    const schedules = [
      { id: 5, description: 'nightly build', cron: '0 2 * * *', ref: 'main', active: true },
      { id: 6, description: 'weekly deploy', cron: '0 3 * * 1', ref: 'main', active: false }
    ];

    it('shows a checkbox per schedule, reflecting active', () => {
      view.update(Object.assign({}, baseModel, { detail: null, schedules }));
      const toggles = view.element.querySelectorAll('.gl-schedule .input-toggle');
      expect(toggles.length).toBe(2);
      expect(toggles[0].checked).toBe(true);
      expect(toggles[1].checked).toBe(false);
    });

    it('raises a toggle request carrying the new state', () => {
      view.update(Object.assign({}, baseModel, { detail: null, schedules }));
      const events = [];
      view.onDidRequest((event) => events.push(event));
      const toggle = view.element.querySelectorAll('.gl-schedule .input-toggle')[1];
      toggle.checked = true;
      toggle.onchange();
      expect(events.length).toBe(1);
      expect(events[0].action).toBe('schedule-toggle');
      expect(events[0].active).toBe(true);
      expect(events[0].schedule.id).toBe(6);
    });

    it('disables the toggle for a read-only token', () => {
      view.update(Object.assign({}, baseModel, { detail: null, schedules, canWrite: false }));
      expect(view.element.querySelector('.gl-schedule .input-toggle').disabled).toBe(true);
    });
  });

  describe('when nothing is set up', () => {
    it('offers to add a connection', () => {
      view.update({ context: null, connections: [], detail: null });
      const events = [];
      view.onDidRequest((event) => events.push(event));
      const btn = view.messageEl.querySelector('button');
      expect(btn.textContent).toBe('Connect to GitLab');
      btn.click();
      expect(events[0].action).toBe('add-connection');
    });

    it('names the host when the repo points somewhere unconnected', () => {
      view.update({
        context: { host: 'git.other.lab', projectPath: 'x/y', connectionId: null },
        connections: [{ id: 'c1' }],
        detail: null
      });
      expect(view.messageEl.textContent).toContain('git.other.lab');
    });
  });

  describe('formatting', () => {
    it('writes durations the way a person would say them', () => {
      expect(humanDuration(45)).toBe('45s');
      expect(humanDuration(252)).toBe('4m 12s');
      expect(humanDuration(3780)).toBe('1h 3m');
      expect(humanDuration(null)).toBe('');
    });

    it('renders an upper-case status the same as a lower-case one', () => {
      // Belt to the client's braces: GraphQL sends job and pipeline statuses
      // upper case, stage statuses lower case.
      expect(lookOf('SUCCESS').icon).toBe(lookOf('success').icon);
      expect(lookOf('SUCCESS').label).toBe('passed');
      expect(lookOf('Manual').icon).toBe('playback-play');
    });

    it('renders an unknown status instead of throwing', () => {
      // GitLab has added statuses twice. A new one must degrade, not crash.
      const look = lookOf('some_new_status_2027');
      expect(look.label).toBe('some_new_status_2027');
      expect(look.icon).toBe('primitive-dot');
    });
  });
});
