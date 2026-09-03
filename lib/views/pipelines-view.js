/**
 * The dock panel: what is running, what it did, and the buttons to change that.
 *
 * Plain DOM with keyed row patching, no framework. etch is six years dead and
 * is not even reachable from a third-party package; React would mean a build
 * step for what is at most a few dozen rows. The rule that makes plain DOM fine
 * here: never rebuild the list, only patch the rows that changed. Rebuilding
 * throws away scroll position, focus and text selection every few seconds,
 * which is what makes hand-rolled polling UIs feel broken.
 */

const { Emitter } = require('atom');

const PIPELINES_URI = 'gitlab-pipelines://pipelines';

// GitLab's icon vocabulary, mapped to Pulsar's built-in Octicon names and to a
// colour class. Anything unknown renders as a neutral dot rather than throwing.
const STATUS_LOOK = {
  success: { icon: 'check', klass: 'text-success', label: 'passed' },
  failed: { icon: 'x', klass: 'text-error', label: 'failed' },
  running: { icon: 'sync', klass: 'text-info', label: 'running' },
  pending: { icon: 'clock', klass: 'text-warning', label: 'pending' },
  created: { icon: 'primitive-dot', klass: 'text-subtle', label: 'created' },
  preparing: { icon: 'clock', klass: 'text-subtle', label: 'preparing' },
  waiting_for_resource: { icon: 'clock', klass: 'text-warning', label: 'waiting for a runner' },
  waiting_for_callback: { icon: 'clock', klass: 'text-warning', label: 'waiting' },
  manual: { icon: 'playback-play', klass: 'text-warning', label: 'manual' },
  scheduled: { icon: 'calendar', klass: 'text-subtle', label: 'scheduled' },
  canceling: { icon: 'circle-slash', klass: 'text-subtle', label: 'cancelling' },
  canceled: { icon: 'circle-slash', klass: 'text-subtle', label: 'cancelled' },
  skipped: { icon: 'fold', klass: 'text-subtle', label: 'skipped' }
};

function lookOf (status) {
  // Case-tolerant on purpose. GraphQL sends pipeline and job statuses in upper
  // case and stage statuses in lower case; REST sends lower case throughout.
  // The client normalises at the edge, and this is the belt to that braces.
  const key = typeof status === 'string' ? status.toLowerCase() : status;
  return STATUS_LOOK[key] || { icon: 'primitive-dot', klass: 'text-subtle', label: status || 'unknown' };
}

function el (tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function button (label, { title = null, className = 'btn btn-sm', icon = null, onClick = null, disabled = false } = {}) {
  const node = document.createElement('button');
  node.className = icon ? `${className} icon icon-${icon}` : className;
  node.textContent = label;
  if (title) node.title = title;
  node.disabled = disabled;
  if (onClick) node.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return node;
}

/** "4m 12s", "38s", "1h 3m". Null duration renders as an empty string. */
function humanDuration (seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function humanAgo (isoString) {
  if (!isoString) return '';
  const then = Date.parse(isoString);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Set text only when it differs. Touching textContent needlessly kills selection. */
function setText (node, text) {
  const value = text === null || text === undefined ? '' : String(text);
  if (node.textContent !== value) node.textContent = value;
}

function setClass (node, className) {
  if (node.className !== className) node.className = className;
}

class PipelinesView {
  constructor (state = {}) {
    this.emitter = new Emitter();
    this.filter = state.filter || 'branch';
    this.expandedSections = new Set(state.expandedSections || ['current', 'recent']);

    this.jobRows = new Map();
    this.stageRows = new Map();
    this.pipelineRows = new Map();
    this.scheduleRows = new Map();

    // Row element -> the GitLab object it is showing. A WeakMap so a removed
    // row does not keep its pipeline data alive. Click handlers read through
    // these rather than closing over the object they were built with, which
    // would go stale on the very next poll.
    this.jobData = new WeakMap();
    this.scheduleData = new WeakMap();

    // The stage strip: one cell per stage, keyed by stage name. Tooltips are
    // held alongside so they can be disposed when a cell goes away - a tooltip
    // on a removed element is a leak Pulsar will not clean up for us.
    this.stripCells = new Map();
    this.stripData = new WeakMap();

    this.model = {
      context: null,
      connections: [],
      project: null,
      detail: null,
      pipelines: [],
      schedules: [],
      canWrite: false,
      error: null,
      status: 'idle'
    };

    this.build();
  }

  // ---- workspace item contract -----------------------------------------

  getTitle () { return 'GitLab Pipelines'; }
  getURI () { return PIPELINES_URI; }
  getIconName () { return 'git-branch'; }
  getDefaultLocation () { return 'right'; }
  getAllowedLocations () { return ['left', 'right', 'bottom']; }
  getPreferredWidth () { return 380; }
  getElement () { return this.element; }

  serialize () {
    return {
      deserializer: 'GitlabPipelinesView',
      filter: this.filter,
      expandedSections: Array.from(this.expandedSections)
    };
  }

  destroy () {
    this.disposeStripCells();
    this.emitter.dispose();
    if (this.element && this.element.parentNode) this.element.remove();
  }

  onDidRequest (callback) {
    return this.emitter.on('request', callback);
  }

  /** Every button in here funnels through one event, so main.js holds all the logic. */
  request (action, payload = {}) {
    this.emitter.emit('request', Object.assign({ action }, payload));
  }

  // ---- construction -----------------------------------------------------

  build () {
    this.element = el('div', 'gitlab-pipelines');

    // Header: where we are, and the two things you always want at hand.
    this.headerEl = el('div', 'gl-header');
    this.contextEl = el('div', 'gl-context');
    this.contextProjectEl = el('div', 'gl-context-project text-highlight');
    this.contextBranchEl = el('div', 'gl-context-branch text-subtle');
    this.contextEl.appendChild(this.contextProjectEl);
    this.contextEl.appendChild(this.contextBranchEl);

    this.headerActionsEl = el('div', 'gl-header-actions btn-group');
    this.refreshButton = button('', {
      title: 'Refresh now', icon: 'sync', className: 'btn btn-sm',
      onClick: () => this.request('refresh')
    });
    this.runButton = button('Run', {
      title: 'Run a pipeline on this branch', icon: 'playback-play',
      className: 'btn btn-sm btn-primary',
      onClick: () => this.request('run-pipeline')
    });
    this.headerActionsEl.appendChild(this.runButton);
    this.headerActionsEl.appendChild(this.refreshButton);

    this.headerEl.appendChild(this.contextEl);
    this.headerEl.appendChild(this.headerActionsEl);
    this.element.appendChild(this.headerEl);

    // A single message strip, used for errors and for "nothing set up yet".
    this.messageEl = el('div', 'gl-message');
    this.messageEl.style.display = 'none';
    this.element.appendChild(this.messageEl);

    this.bodyEl = el('div', 'gl-body');
    this.element.appendChild(this.bodyEl);

    this.currentSection = this.makeSection('current', 'Current branch');
    this.recentSection = this.makeSection('recent', 'Recent pipelines');
    this.schedulesSection = this.makeSection('schedules', 'Schedules');
    this.bodyEl.appendChild(this.currentSection.root);
    this.bodyEl.appendChild(this.recentSection.root);
    this.bodyEl.appendChild(this.schedulesSection.root);

    this.footerEl = el('div', 'gl-footer text-subtle');
    this.element.appendChild(this.footerEl);
  }

  makeSection (key, title) {
    const root = el('section', 'gl-section');
    const header = el('div', 'gl-section-header');
    const twisty = el('span', 'gl-twisty icon icon-chevron-down');
    const label = el('span', 'gl-section-title', title);
    const count = el('span', 'gl-section-count badge badge-flexible');
    const actions = el('span', 'gl-section-actions');
    header.appendChild(twisty);
    header.appendChild(label);
    header.appendChild(count);
    header.appendChild(actions);
    const content = el('div', 'gl-section-content');

    header.addEventListener('click', () => {
      if (this.expandedSections.has(key)) this.expandedSections.delete(key);
      else this.expandedSections.add(key);
      this.applyExpansion(key, twisty, content);
    });

    root.appendChild(header);
    root.appendChild(content);
    const section = { root, header, twisty, label, count, actions, content, key };
    this.applyExpansion(key, twisty, content);
    return section;
  }

  applyExpansion (key, twisty, content) {
    const open = this.expandedSections.has(key);
    content.style.display = open ? '' : 'none';
    setClass(twisty, `gl-twisty icon icon-chevron-${open ? 'down' : 'right'}`);
  }

  // ---- rendering --------------------------------------------------------

  update (model) {
    Object.assign(this.model, model);
    this.renderHeader();
    this.renderMessage();
    this.renderCurrent();
    this.renderRecent();
    this.renderSchedules();
    this.renderFooter();
  }

  renderHeader () {
    const { context, project, canWrite, status } = this.model;
    if (context) {
      setText(this.contextProjectEl, project ? project.path_with_namespace : context.projectPath);
      const parts = [];
      if (context.branch) parts.push(context.branch);
      if (context.connectionName) parts.push(context.connectionName);
      if (context.remoteName && context.remoteName !== 'origin') parts.push(`remote: ${context.remoteName}`);
      setText(this.contextBranchEl, parts.join('  ·  '));
    } else {
      setText(this.contextProjectEl, 'No GitLab project');
      setText(this.contextBranchEl, 'Open a folder whose git remote points at a GitLab you have connected.');
    }

    this.runButton.disabled = !canWrite || !context || !context.branch;
    this.runButton.title = canWrite
      ? 'Run a pipeline on this branch'
      : 'Needs a token with the "api" scope and the Developer role on this project';
    setClass(this.refreshButton, `btn btn-sm icon icon-sync${status === 'polling' ? ' gl-spinning' : ''}`);
  }

  renderMessage () {
    const { error, connections, context } = this.model;
    this.messageEl.textContent = '';

    if (error) {
      this.messageEl.style.display = '';
      setClass(this.messageEl, 'gl-message gl-message-error');
      this.messageEl.appendChild(el('span', 'icon icon-alert'));
      this.messageEl.appendChild(el('span', 'gl-message-text', error));
      return;
    }

    if (connections.length === 0) {
      this.messageEl.style.display = '';
      setClass(this.messageEl, 'gl-message gl-message-info');
      this.messageEl.appendChild(el('span', 'gl-message-text', 'No GitLab connection yet.'));
      this.messageEl.appendChild(button('Connect to GitLab', {
        className: 'btn btn-sm btn-primary', onClick: () => this.request('add-connection')
      }));
      return;
    }

    if (context && !context.connectionId) {
      this.messageEl.style.display = '';
      setClass(this.messageEl, 'gl-message gl-message-info');
      this.messageEl.appendChild(el('span', 'gl-message-text',
        `This repository points at ${context.host}, which is not one of your connections.`));
      this.messageEl.appendChild(button(`Add ${context.host}`, {
        className: 'btn btn-sm', onClick: () => this.request('add-connection', { host: context.host })
      }));
      return;
    }

    this.messageEl.style.display = 'none';
  }

  renderCurrent () {
    const detail = this.model.detail;
    const section = this.currentSection;

    if (!detail) {
      setText(section.count, '');
      if (section.content.firstChild && section.content.dataset.empty === 'true') return;
      section.content.textContent = '';
      section.content.dataset.empty = 'true';
      this.stageRows.clear();
      this.jobRows.clear();
      this.disposeStripCells();
      section.content.appendChild(el('div', 'gl-empty text-subtle',
        this.model.context && this.model.context.branch
          ? `No pipeline for ${this.model.context.branch} yet.`
          : 'Nothing to show.'));
      return;
    }
    section.content.dataset.empty = 'false';

    // The pipeline summary row lives above the stages and is rebuilt cheaply.
    if (!this.pipelineSummaryEl) {
      this.pipelineSummaryEl = el('div', 'gl-pipeline-summary');
      this.pipelineSummaryIcon = el('span', 'icon');
      this.pipelineSummaryTitle = el('span', 'gl-pipeline-title');
      this.pipelineSummaryMeta = el('span', 'gl-pipeline-meta text-subtle');
      this.pipelineSummaryActions = el('span', 'gl-pipeline-actions btn-group btn-group-sm');
      this.pipelineSummaryEl.appendChild(this.pipelineSummaryIcon);
      this.pipelineSummaryEl.appendChild(this.pipelineSummaryTitle);
      this.pipelineSummaryEl.appendChild(this.pipelineSummaryMeta);
      this.pipelineSummaryEl.appendChild(this.pipelineSummaryActions);
      section.content.textContent = '';
      section.content.appendChild(this.pipelineSummaryEl);
      this.stageStripEl = el('div', 'gl-stage-strip');
      this.stageStripEl.setAttribute('role', 'group');
      this.stageStripEl.setAttribute('aria-label', 'Pipeline stages');
      section.content.appendChild(this.stageStripEl);
      this.stagesEl = el('div', 'gl-stages');
      section.content.appendChild(this.stagesEl);
    }

    const look = lookOf(detail.status);
    setClass(this.pipelineSummaryIcon, `icon icon-${look.icon} ${look.klass}`);
    setText(this.pipelineSummaryTitle, `#${detail.iid} ${look.label}`);
    const meta = [humanDuration(detail.duration), humanAgo(detail.finishedAt || detail.startedAt)]
      .filter(Boolean).join('  ·  ');
    setText(this.pipelineSummaryMeta, meta);
    setText(section.count, detail.status);

    this.renderPipelineActions(this.pipelineSummaryActions, detail);
    this.renderStageStrip(detail);
    this.renderStages(detail);
  }

  renderPipelineActions (container, detail) {
    const canWrite = this.model.canWrite;
    // GraphQL tells us straight out whether an action is legal. Guessing from
    // the status string is how you end up offering "Cancel" on a finished
    // pipeline and showing the user a 400.
    const wanted = [];
    if (canWrite && detail.cancelable) wanted.push(['cancel', 'Cancel', 'circle-slash']);
    if (canWrite && detail.retryable) wanted.push(['retry', 'Retry', 'sync']);
    wanted.push(['open', 'Open in GitLab', 'link-external']);

    const signature = wanted.map((item) => item[0]).join(',');
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    container.textContent = '';

    for (const [action, label, icon] of wanted) {
      container.appendChild(button('', {
        title: label, icon, className: 'btn btn-sm',
        onClick: () => this.request(`pipeline-${action}`, { pipelineId: detail.iid, pipeline: detail })
      }));
    }
  }

  /**
   * The stage strip: one dot per stage, left to right, in the order GitLab
   * runs them. It answers "where is this pipeline up to" without reading the
   * list underneath, which is the whole point of the old Atom packages' status
   * display.
   *
   * Each dot carries the stage's own glyph, not just a colour, so it is still
   * readable without colour vision and in a high-contrast theme.
   */
  renderStageStrip (detail) {
    const stages = (detail.stages && detail.stages.nodes) || [];
    const seen = new Set();

    stages.forEach((stage, index) => {
      seen.add(stage.name);
      let cell = this.stripCells.get(stage.name);
      if (!cell) {
        cell = this.buildStripCell(stage.name);
        this.stripCells.set(stage.name, cell);
        this.stageStripEl.appendChild(cell.root);
      }
      // Stages can be added or reordered between polls; keep display order
      // matching GitLab's run order.
      if (this.stageStripEl.children[index] !== cell.root) {
        this.stageStripEl.insertBefore(cell.root, this.stageStripEl.children[index] || null);
      }
      this.patchStripCell(cell, stage);
    });

    for (const [name, cell] of this.stripCells) {
      if (!seen.has(name)) {
        this.destroyStripCell(cell);
        this.stripCells.delete(name);
      }
    }
  }

  buildStripCell (stageName) {
    const root = document.createElement('button');
    root.className = 'gl-strip-stage';
    const dot = el('span', 'gl-strip-dot');
    const name = el('span', 'gl-strip-name');
    root.appendChild(dot);
    root.appendChild(name);
    root.addEventListener('click', (event) => {
      event.preventDefault();
      this.scrollToStage(stageName);
    });

    // Added once and disposed once. The title is a function, so it is read
    // fresh on every hover - a stage going from running to failed needs no
    // tooltip churn, and there is no window where a dispose/re-add could drop
    // the tooltip mid-hover.
    //
    // html:false is not optional. atom.tooltips.add defaults to html TRUE and
    // assigns the title straight to innerHTML with no sanitising, and this
    // title contains a stage name, which is text a GitLab server sent us.
    const tooltip = atom.tooltips.add(root, {
      html: false,
      placement: 'top',
      delay: { show: 300, hide: 80 },
      title: () => {
        const stage = this.stripData.get(root);
        return stage ? this.stripSummary(stage) : stageName;
      }
    });

    return { root, dot, name, tooltip };
  }

  /** One line of plain text: what this stage is and how far through it is. */
  stripSummary (stage) {
    const look = lookOf(stage.status);
    const jobs = (stage.jobs && stage.jobs.nodes) || [];
    const done = jobs.filter((job) => ['success', 'failed', 'canceled', 'skipped'].includes(job.status)).length;
    return jobs.length > 0
      ? `${stage.name} - ${look.label} (${done}/${jobs.length} jobs)`
      : `${stage.name} - ${look.label}`;
  }

  patchStripCell (cell, stage) {
    // Read the stage through the map rather than closing over it: the object
    // is replaced wholesale on every poll, and a closure would pin the first
    // one forever.
    this.stripData.set(cell.root, stage);

    const look = lookOf(stage.status);
    setClass(cell.dot, `gl-strip-dot icon icon-${look.icon} ${look.klass}`);
    setText(cell.name, stage.name);
    setClass(cell.root, `gl-strip-stage gl-strip-${stage.status}`);

    // Screen readers get the same sentence the tooltip shows.
    const summary = this.stripSummary(stage);
    if (cell.root.getAttribute('aria-label') !== summary) {
      cell.root.setAttribute('aria-label', summary);
    }
  }

  destroyStripCell (cell) {
    // Dispose before the element leaves the DOM. atom.tooltips keeps a strong
    // reference to the target in a plain Map and registers a window resize
    // listener per tooltip; removing the element alone leaks both, and a
    // tooltip showing at that moment would stay on screen.
    if (cell.tooltip) cell.tooltip.dispose();
    cell.tooltip = null;
    cell.root.remove();
  }

  disposeStripCells () {
    for (const cell of this.stripCells.values()) this.destroyStripCell(cell);
    this.stripCells.clear();
  }

  /**
   * Jump to a stage in the list below. Also opens the section if the user had
   * collapsed it - otherwise clicking a dot appears to do nothing.
   */
  scrollToStage (name) {
    if (!this.expandedSections.has('current')) {
      this.expandedSections.add('current');
      this.applyExpansion('current', this.currentSection.twisty, this.currentSection.content);
    }
    const row = this.stageRows.get(name);
    if (!row) return;
    row.root.scrollIntoView({ block: 'nearest' });
    // A brief highlight, because a scroll inside a short list can move nothing
    // and leave the user wondering whether the click registered.
    row.root.classList.add('gl-stage-flash');
    setTimeout(() => row.root.classList.remove('gl-stage-flash'), 1200);
  }

  renderStages (detail) {
    const stages = (detail.stages && detail.stages.nodes) || [];
    const seenStages = new Set();

    stages.forEach((stage, index) => {
      seenStages.add(stage.name);
      let row = this.stageRows.get(stage.name);
      if (!row) {
        row = this.buildStageRow(stage);
        this.stageRows.set(stage.name, row);
        this.stagesEl.appendChild(row.root);
      }
      // Keep display order matching GitLab's stage order.
      if (this.stagesEl.children[index] !== row.root) {
        this.stagesEl.insertBefore(row.root, this.stagesEl.children[index] || null);
      }
      this.patchStageRow(row, stage);
    });

    for (const [name, row] of this.stageRows) {
      if (!seenStages.has(name)) {
        row.root.remove();
        this.stageRows.delete(name);
      }
    }

    // Jobs that no longer exist anywhere in the pipeline.
    const liveJobIds = new Set();
    for (const stage of stages) {
      for (const job of (stage.jobs && stage.jobs.nodes) || []) liveJobIds.add(job.id);
    }
    for (const [id, row] of this.jobRows) {
      if (!liveJobIds.has(id)) {
        row.root.remove();
        this.jobRows.delete(id);
      }
    }
  }

  buildStageRow (stage) {
    const root = el('div', 'gl-stage');
    const header = el('div', 'gl-stage-header');
    const icon = el('span', 'icon');
    const name = el('span', 'gl-stage-name');
    header.appendChild(icon);
    header.appendChild(name);
    const jobs = el('div', 'gl-stage-jobs');
    root.appendChild(header);
    root.appendChild(jobs);
    return { root, header, icon, name, jobs };
  }

  patchStageRow (row, stage) {
    const look = lookOf(stage.status);
    setClass(row.icon, `icon icon-${look.icon} ${look.klass}`);
    setText(row.name, stage.name);

    const jobs = (stage.jobs && stage.jobs.nodes) || [];
    jobs.forEach((job, index) => {
      let jobRow = this.jobRows.get(job.id);
      if (!jobRow) {
        jobRow = this.buildJobRow(job);
        this.jobRows.set(job.id, jobRow);
        row.jobs.appendChild(jobRow.root);
      }
      if (jobRow.root.parentNode !== row.jobs) row.jobs.appendChild(jobRow.root);
      if (row.jobs.children[index] !== jobRow.root) {
        row.jobs.insertBefore(jobRow.root, row.jobs.children[index] || null);
      }
      this.patchJobRow(jobRow, job);
    });
  }

  buildJobRow (job) {
    const root = el('div', 'gl-job');
    const icon = el('span', 'icon');
    const name = el('span', 'gl-job-name');
    const meta = el('span', 'gl-job-meta text-subtle');
    const actions = el('span', 'gl-job-actions btn-group btn-group-sm');
    root.appendChild(icon);
    root.appendChild(name);
    root.appendChild(meta);
    root.appendChild(actions);
    root.addEventListener('click', () => this.request('open-log', { job: this.jobData.get(root) }));
    return { root, icon, name, meta, actions };
  }

  patchJobRow (row, job) {
    this.jobData.set(row.root, job);

    const look = lookOf(job.status);
    setClass(row.icon, `icon icon-${look.icon} ${look.klass}`);
    setText(row.name, job.name);

    const bits = [];
    if (job.duration) bits.push(humanDuration(job.duration));
    if (job.allowFailure && job.status === 'failed') bits.push('allowed to fail');
    setText(row.meta, bits.join('  ·  '));
    setClass(row.root, `gl-job gl-job-${job.status}${job.allowFailure ? ' gl-job-allow-failure' : ''}`);

    // Same rule as the pipeline: the flags come from GitLab, we do not guess.
    const canWrite = this.model.canWrite;
    const wanted = [];
    if (canWrite && job.playable && job.status === 'manual') wanted.push(['play', 'Run this job', 'playback-play']);
    if (canWrite && job.cancelable) wanted.push(['cancel', 'Cancel this job', 'circle-slash']);
    if (canWrite && job.retryable) wanted.push(['retry', 'Retry this job', 'sync']);

    const signature = wanted.map((item) => item[0]).join(',');
    if (row.actions.dataset.signature === signature) return;
    row.actions.dataset.signature = signature;
    row.actions.textContent = '';
    for (const [action, label, icon] of wanted) {
      row.actions.appendChild(button('', {
        title: label, icon, className: 'btn btn-sm',
        onClick: () => this.request(`job-${action}`, { job })
      }));
    }
  }

  renderRecent () {
    const section = this.recentSection;
    const pipelines = this.model.pipelines || [];
    setText(section.count, pipelines.length > 0 ? String(pipelines.length) : '');

    if (pipelines.length === 0) {
      if (section.content.dataset.empty !== 'true') {
        section.content.textContent = '';
        section.content.dataset.empty = 'true';
        this.pipelineRows.clear();
        section.content.appendChild(el('div', 'gl-empty text-subtle', 'No pipelines yet.'));
      }
      return;
    }
    if (section.content.dataset.empty === 'true') {
      section.content.textContent = '';
      section.content.dataset.empty = 'false';
    }

    const seen = new Set();
    pipelines.forEach((pipeline, index) => {
      seen.add(pipeline.id);
      let row = this.pipelineRows.get(pipeline.id);
      if (!row) {
        row = this.buildPipelineRow();
        this.pipelineRows.set(pipeline.id, row);
        section.content.appendChild(row.root);
      }
      if (section.content.children[index] !== row.root) {
        section.content.insertBefore(row.root, section.content.children[index] || null);
      }
      this.patchPipelineRow(row, pipeline);
    });

    for (const [id, row] of this.pipelineRows) {
      if (!seen.has(id)) {
        row.root.remove();
        this.pipelineRows.delete(id);
      }
    }
  }

  buildPipelineRow () {
    const root = el('div', 'gl-pipeline-row');
    const icon = el('span', 'icon');
    const title = el('span', 'gl-pipeline-row-title');
    const ref = el('span', 'gl-pipeline-row-ref text-subtle');
    const when = el('span', 'gl-pipeline-row-when text-subtle');
    root.appendChild(icon);
    root.appendChild(title);
    root.appendChild(ref);
    root.appendChild(when);
    return { root, icon, title, ref, when };
  }

  patchPipelineRow (row, pipeline) {
    const look = lookOf(pipeline.status);
    setClass(row.icon, `icon icon-${look.icon} ${look.klass}`);
    setText(row.title, `#${pipeline.iid || pipeline.id}`);
    setText(row.ref, pipeline.ref || '');
    setText(row.when, humanAgo(pipeline.updated_at || pipeline.created_at));
    row.root.title = `${look.label} · ${pipeline.ref || ''}`;
    if (row.root.dataset.pipelineId !== String(pipeline.id)) {
      row.root.dataset.pipelineId = String(pipeline.id);
      row.root.onclick = () => this.request('select-pipeline', { pipeline });
    }
  }

  renderSchedules () {
    const section = this.schedulesSection;
    const schedules = this.model.schedules || [];
    setText(section.count, schedules.length > 0 ? String(schedules.length) : '');

    if (schedules.length === 0) {
      if (section.content.dataset.empty !== 'true') {
        section.content.textContent = '';
        section.content.dataset.empty = 'true';
        this.scheduleRows.clear();
        section.content.appendChild(el('div', 'gl-empty text-subtle', 'No pipeline schedules.'));
      }
      return;
    }
    if (section.content.dataset.empty === 'true') {
      section.content.textContent = '';
      section.content.dataset.empty = 'false';
    }

    const seen = new Set();
    schedules.forEach((schedule) => {
      seen.add(schedule.id);
      let row = this.scheduleRows.get(schedule.id);
      if (!row) {
        row = this.buildScheduleRow();
        this.scheduleRows.set(schedule.id, row);
        section.content.appendChild(row.root);
      }
      this.patchScheduleRow(row, schedule);
    });

    for (const [id, row] of this.scheduleRows) {
      if (!seen.has(id)) {
        row.root.remove();
        this.scheduleRows.delete(id);
      }
    }
  }

  buildScheduleRow () {
    const root = el('div', 'gl-schedule');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'input-toggle';
    const body = el('span', 'gl-schedule-body');
    const description = el('span', 'gl-schedule-description');
    const meta = el('span', 'gl-schedule-meta text-subtle');
    body.appendChild(description);
    body.appendChild(meta);
    const actions = el('span', 'gl-schedule-actions btn-group btn-group-sm');
    root.appendChild(toggle);
    root.appendChild(body);
    root.appendChild(actions);
    return { root, toggle, description, meta, actions };
  }

  patchScheduleRow (row, schedule) {
    setText(row.description, schedule.description || `Schedule ${schedule.id}`);
    const bits = [schedule.cron, schedule.ref].filter(Boolean);
    if (schedule.next_run_at) bits.push(`next ${humanAgo(schedule.next_run_at).replace(' ago', ' from now')}`);
    setText(row.meta, bits.join('  ·  '));

    if (row.toggle.checked !== Boolean(schedule.active)) row.toggle.checked = Boolean(schedule.active);
    row.toggle.disabled = !this.model.canWrite;
    row.toggle.title = this.model.canWrite
      ? (schedule.active ? 'Turn this schedule off' : 'Turn this schedule on')
      : 'Needs a token with the "api" scope';
    row.toggle.onchange = () => this.request('schedule-toggle', { schedule, active: row.toggle.checked });

    this.scheduleData.set(row.root, schedule);
    if (row.actions.dataset.built !== 'true') {
      row.actions.dataset.built = 'true';
      row.actions.appendChild(button('', {
        title: 'Run this schedule now', icon: 'playback-play', className: 'btn btn-sm',
        onClick: () => this.request('schedule-run', { schedule: this.scheduleData.get(row.root) })
      }));
    }
    setClass(row.root, `gl-schedule${schedule.active ? '' : ' gl-schedule-off'}`);
  }

  renderFooter () {
    const { status, project } = this.model;
    const bits = [];
    if (status === 'offline') bits.push('offline - retrying');
    else if (status === 'polling') bits.push('checking...');
    if (project && !this.model.canWrite) bits.push('read-only');
    setText(this.footerEl, bits.join('  ·  '));
  }
}

module.exports = { PipelinesView, PIPELINES_URI, lookOf, humanDuration, humanAgo };
