/**
 * Wiring. Everything that decides *what happens* lives here; the views only
 * draw and raise events, and the client only talks HTTP.
 *
 * Two rules this file exists to keep:
 *   - activate() does no network and no file reading. It registers things and
 *     returns. Anything slower is kicked off when the panel is first opened.
 *   - every subscription, timer and tile is disposed in deactivate(), because
 *     a leaked poll timer means the next window reload polls GitLab twice as
 *     often, and the one after that four times.
 */

const { CompositeDisposable, Disposable } = require('atom');

const { PipelinesView, PIPELINES_URI } = require('./views/pipelines-view');
const { JobLogView, logUriFor, parseLogUri, LOG_URI_PREFIX } = require('./views/job-log-view');
const { StatusTile } = require('./views/status-tile');
const { ConnectionDialog } = require('./views/connection-dialog');
const { ConnectionStore } = require('./connections');
const { ProjectContext } = require('./project-context');
const { Poller } = require('./poller');
const { GitLabClient } = require('./gitlab/client');
const secrets = require('./secrets');

const POLL_INTERVAL_MS = 30000;

module.exports = {
  activate (state) {
    this.subscriptions = new CompositeDisposable();
    this.view = null;
    this.statusTile = null;
    this.statusBarTile = null;
    this.poller = null;
    this.connections = null;
    this.context = null;
    this.lastNotifiedStatus = new Map();
    this.serializedViewState = (state && state.view) || null;

    this.subscriptions.add(
      atom.workspace.addOpener((uri) => this.openerFor(uri)),

      atom.commands.add('atom-workspace', {
        'gitlab-pipelines:toggle': () => this.togglePanel(),
        'gitlab-pipelines:refresh': () => this.refresh({ force: true }),
        'gitlab-pipelines:add-connection': () => this.addConnection(),
        'gitlab-pipelines:manage-connections': () => this.manageConnections(),
        'gitlab-pipelines:run-pipeline': () => this.runPipeline(),
        'gitlab-pipelines:lint-ci-config': () => this.lintCurrentFile(),
        'gitlab-pipelines:schedules': () => this.togglePanel()
      }),

      atom.config.onDidChange('gitlab-pipelines.gitRemoteName', () => {
        if (this.context) this.context.refresh();
      }),

      // The poll timer is not a Pulsar subscription, so it has to be tied to
      // one by hand. Without this line, changing a setting that restarts
      // polling leaks the previous timer and the request rate creeps up.
      new Disposable(() => this.stopPolling())
    );

    // Asking the OS keyring whether it exists is a synchronous IPC hop, and
    // the first one is slow. Do it just after startup rather than inside
    // activate(), so it costs the user nothing and the connection dialog opens
    // instantly when they get there.
    this.warmUpTimer = setTimeout(() => {
      this.warmUpTimer = null;
      try {
        secrets.warmUp();
      } catch (err) {
        // A machine with no keyring at all. Handled where it matters.
      }
    }, 0);
    this.subscriptions.add(new Disposable(() => {
      if (this.warmUpTimer) clearTimeout(this.warmUpTimer);
      this.warmUpTimer = null;
    }));
  },

  deactivate () {
    this.stopPolling();
    if (this.statusBarTile) {
      this.statusBarTile.destroy();
      this.statusBarTile = null;
    }
    if (this.statusTile) {
      this.statusTile.destroy();
      this.statusTile = null;
    }
    if (this.context) {
      this.context.dispose();
      this.context = null;
    }
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.subscriptions.dispose();
    this.subscriptions = null;
  },

  serialize () {
    return { view: this.view ? this.view.serialize() : this.serializedViewState };
  },

  deserializePipelinesView (state) {
    this.serializedViewState = state;
    return this.getView(state);
  },

  // ---- lazy set-up ------------------------------------------------------

  /**
   * Everything expensive happens here rather than in activate(): reading the
   * connection file, hooking git repositories, starting the timer.
   */
  ensureStarted () {
    if (this.connections) return;
    this.connections = new ConnectionStore();
    this.context = new ProjectContext(this.connections);
    this.subscriptions.add(
      this.context.onDidChange(() => this.refresh({ force: true })),
      this.connections.onDidChange(() => this.refresh({ force: true }))
    );
    this.startPolling();
  },

  getView (state = null) {
    if (this.view) return this.view;
    this.ensureStarted();
    this.view = new PipelinesView(state || this.serializedViewState || {});
    this.subscriptions.add(this.view.onDidRequest((event) => this.handleViewRequest(event)));
    this.refresh({ force: true });
    return this.view;
  },

  openerFor (uri) {
    if (uri === PIPELINES_URI) return this.getView();
    if (uri && uri.startsWith(LOG_URI_PREFIX)) {
      const parsed = parseLogUri(uri);
      if (!parsed) return undefined;
      this.ensureStarted();
      const client = this.connections.clientFor(parsed.connectionId);
      const connection = this.connections.get(parsed.connectionId);
      if (!client || !connection) return undefined;
      return new JobLogView({
        client,
        connectionId: parsed.connectionId,
        projectId: parsed.projectId,
        job: { id: parsed.jobId, name: `Job ${parsed.jobId}`, status: 'running' },
        baseUrl: connection.baseUrl
      });
    }
    return undefined;
  },

  togglePanel () {
    this.ensureStarted();
    return atom.workspace.toggle(PIPELINES_URI);
  },

  consumeStatusBar (statusBar) {
    this.statusTile = new StatusTile({ onClick: () => this.togglePanel() });
    this.statusBarTile = statusBar.addRightTile({ item: this.statusTile.element, priority: 150 });

    // Honour the setting. It shipped in 0.1.0 declared in configSchema and
    // asserted in a spec, but nothing read it - so toggling it did nothing.
    this.subscriptions.add(atom.config.observe('gitlab-pipelines.showStatusBar', (show) => {
      if (!this.statusTile) return;
      this.statusTile.setVisible(show);

      // A status light that nothing feeds is just a decoration. The stores and
      // the poll timer used to come up only from getView() and the commands,
      // so until you opened the panel once the tile sat on its constructor's
      // idle state for ever - which looked exactly like a broken package.
      //
      // This is still not activate(): that path does no network or file work,
      // and specs hold it to that. Consuming the status bar means the user has
      // somewhere to show a live status and has left it switched on, which is
      // the point at which starting is what they asked for.
      if (show) {
        this.ensureStarted();
        this.refresh({ force: true });
      }
    }));
    // A Tile is not a Disposable, so it would never be cleaned up by the
    // CompositeDisposable on its own. Hand one back that does it.
    return new Disposable(() => {
      if (this.statusBarTile) this.statusBarTile.destroy();
      this.statusBarTile = null;
    });
  },

  // ---- polling ----------------------------------------------------------

  startPolling () {
    if (this.poller) return;
    this.poller = new Poller({
      intervalMs: POLL_INTERVAL_MS,
      task: () => this.refresh(),
      onStateChange: (state) => {
        if (this.view) this.view.update({ status: state });
        if (state === 'offline' && this.statusTile) this.statusTile.setOffline();
      },
      onError: (err, failures) => this.handlePollError(err, failures)
    });
    this.poller.start();
  },

  stopPolling () {
    if (this.poller) {
      this.poller.dispose();
      this.poller = null;
    }
  },

  /**
   * A failing poll must not produce a notification every time round. The first
   * failure is worth telling the user about only when it is something they can
   * fix - an expired token. Everything else goes quiet in the status bar and
   * keeps retrying with a growing gap.
   */
  handlePollError (err, failures) {
    if (this.view) this.view.update({ error: secrets.redact(err.message), status: 'offline' });
    if (this.statusTile) this.statusTile.setOffline(err.message);

    if (err.status === 401 && failures === 1) {
      this.stopPolling();
      atom.notifications.addError('GitLab token rejected', {
        description: err.message,
        dismissable: true,
        buttons: [{
          text: 'Reconnect',
          onDidClick: () => this.manageConnections()
        }]
      });
    }
  },

  // ---- the refresh cycle ------------------------------------------------

  async refresh ({ force = false } = {}) {
    this.ensureStarted();
    if (!this.view && !this.statusTile) return;

    const context = this.context.get();
    const baseModel = {
      context,
      connections: this.connections.all(),
      error: null
    };

    if (!context || !context.connectionId) {
      if (this.view) {
        this.view.update(Object.assign(baseModel, {
          project: null, detail: null, pipelines: [], schedules: [], canWrite: false
        }));
      }
      // Say which kind of "nothing" this is. Hiding the tile here made a
      // window with no GitLab project look exactly like a broken package.
      if (this.statusTile) {
        const configured = this.connections ? this.connections.all().length : 0;
        this.statusTile.setInactive(
          configured === 0
            ? 'No GitLab connection yet - click to add one.'
            : 'No GitLab remote in this project.'
        );
      }
      return;
    }

    const client = this.connections.clientFor(context.connectionId);
    if (!client) return;

    // One /version call per connection, ever. It decides which optional API
    // features we may use, and it is how a wrong URL is told apart from a
    // wrong token.
    if (!client.version) await client.checkConnection();

    const project = await this.context.resolveProject(context);
    if (!project) return;

    const canWrite = GitLabClient.canWrite(project) && client.connection.scope !== 'read_api';

    const [detail, list, schedules] = await Promise.all([
      this.loadDetail(client, context, project),
      client.listPipelines(project.id, { perPage: 10 }),
      this.loadSchedules(client, project)
    ]);

    if (this.view) {
      this.view.update(Object.assign(baseModel, {
        project,
        detail,
        pipelines: list.pipelines,
        schedules,
        canWrite
      }));
    }

    if (this.statusTile) {
      if (detail) this.statusTile.setPipeline(detail);
      else this.statusTile.setIdle();
    }

    this.maybeNotify(context, detail);
  },

  /**
   * The pipeline for the current branch, with its stages and jobs.
   *
   * GraphQL first: one request, the stages come back in the right order, and
   * it carries the playable/retryable/cancelable flags that decide which
   * buttons to show. REST cannot do any of those three. When GraphQL fails -
   * an older self-hosted instance missing one field fails the whole query -
   * fall back to REST and synthesise the flags from the status.
   */
  async loadDetail (client, context, project) {
    if (!context.branch) return null;
    const latest = await client.latestPipeline(project.id, context.branch);
    if (!latest) return null;

    const detail = await client.pipelineDetail(project.path_with_namespace, latest.iid);
    if (detail) return detail;

    const jobs = await client.listJobs(project.id, latest.id);
    return restDetailShape(latest, jobs);
  },

  async loadSchedules (client, project) {
    try {
      return await client.listSchedules(project.id);
    } catch (err) {
      // Schedules are not worth failing the whole refresh over - a Guest can
      // see pipelines but not schedules.
      return [];
    }
  },

  /**
   * Tell the user when a pipeline they are watching finishes, but only on the
   * transition, and only once. Off by default, like the official extension:
   * an editor that pops a toast every time a colleague pushes is a nuisance.
   */
  maybeNotify (context, detail) {
    if (!detail) return;
    const mode = atom.config.get('gitlab-pipelines.notifications');
    if (mode === 'never') return;

    const key = `${context.connectionId}:${context.projectPath}:${detail.iid}`;
    const previous = this.lastNotifiedStatus.get(key);
    const status = detail.status;
    this.lastNotifiedStatus.set(key, status);

    if (previous === undefined || previous === status) return;
    const finished = ['success', 'failed', 'canceled'].includes(status);
    if (!finished) return;
    if (mode === 'failure' && status !== 'failed') return;

    const title = `Pipeline #${detail.iid} ${status === 'success' ? 'passed' : status}`;
    const options = {
      description: `${context.projectPath} · ${detail.ref || context.branch}`,
      dismissable: status === 'failed'
    };
    if (status === 'failed') atom.notifications.addError(title, options);
    else atom.notifications.addSuccess(title, options);
  },

  // ---- actions ----------------------------------------------------------

  async handleViewRequest (event) {
    try {
      switch (event.action) {
        case 'refresh': return await this.refresh({ force: true });
        case 'add-connection': return await this.addConnection(event.host);
        case 'run-pipeline': return await this.runPipeline();
        case 'pipeline-cancel': return await this.pipelineAction('cancel', event.pipeline);
        case 'pipeline-retry': return await this.pipelineAction('retry', event.pipeline);
        case 'pipeline-open': return this.openInBrowser(event.pipeline);
        case 'select-pipeline': return this.openInBrowser(event.pipeline);
        case 'job-play': return await this.jobAction('play', event.job);
        case 'job-retry': return await this.jobAction('retry', event.job);
        case 'job-cancel': return await this.jobAction('cancel', event.job);
        case 'open-log': return await this.openJobLog(event.job);
        case 'schedule-toggle': return await this.toggleSchedule(event.schedule, event.active);
        case 'schedule-run': return await this.runSchedule(event.schedule);
        default: return undefined;
      }
    } catch (err) {
      this.reportError(err);
    }
  },

  reportError (err) {
    atom.notifications.addError('GitLab Pipelines', {
      description: secrets.redact(err.message || String(err)),
      dismissable: true
    });
  },

  /** The connection, project and client for whatever is on screen. */
  async currentTarget () {
    this.ensureStarted();
    const context = this.context.get();
    if (!context || !context.connectionId) {
      throw new Error('No GitLab connection matches this repository. Add one first.');
    }
    const client = this.connections.clientFor(context.connectionId);
    if (!client.version) await client.checkConnection();
    const project = await this.context.resolveProject(context);
    if (!project) throw new Error('Could not find this project on GitLab.');
    return { context, client, project };
  },

  async addConnection (host = null) {
    this.ensureStarted();
    const dialog = new ConnectionDialog({ host });
    const values = await dialog.show();
    if (!values) return;
    const connection = this.connections.add(values);
    atom.notifications.addSuccess(`Connected to ${connection.name}.`);
    this.startPolling();
    await this.refresh({ force: true });
  },

  async manageConnections () {
    this.ensureStarted();
    const all = this.connections.all();
    if (all.length === 0) return this.addConnection();
    const dialog = new ConnectionDialog({ existing: all[0] });
    const values = await dialog.show();
    if (!values) return;
    this.connections.update(all[0].id, values);
    atom.notifications.addSuccess('Connection updated.');
    await this.refresh({ force: true });
  },

  async runPipeline () {
    const { context, client, project } = await this.currentTarget();
    if (!context.branch) throw new Error('This repository is not on a branch.');
    const pipeline = await client.runPipeline(project.id, context.branch);
    atom.notifications.addSuccess(`Started pipeline #${pipeline.iid} on ${context.branch}.`, {
      buttons: [{ text: 'Open in GitLab', onDidClick: () => this.openInBrowser(pipeline) }]
    });
    await this.refresh({ force: true });
  },

  async pipelineAction (action, pipeline) {
    const { client, project } = await this.currentTarget();
    const id = pipeline.id && String(pipeline.id).startsWith('gid://')
      ? pipeline.iid
      : (pipeline.iid || pipeline.id);
    if (action === 'cancel') await client.cancelPipeline(project.id, id);
    if (action === 'retry') await client.retryPipeline(project.id, id);
    // Cancel answers 200 whatever state the pipeline was in, so the only way
    // to know what actually happened is to look again.
    await this.refresh({ force: true });
  },

  async jobAction (action, job) {
    const { client, project } = await this.currentTarget();
    const jobId = numericId(job.id);
    if (action === 'play') await client.playJob(project.id, jobId);
    if (action === 'retry') await client.retryJob(project.id, jobId);
    if (action === 'cancel') await client.cancelJob(project.id, jobId);
    await this.refresh({ force: true });
  },

  async openJobLog (job) {
    if (!job) return;
    const { context, project } = await this.currentTarget();
    const jobId = numericId(job.id);
    const uri = logUriFor(context.connectionId, project.id, jobId);

    const existing = atom.workspace.getPaneItems().find((item) => item.getURI && item.getURI() === uri);
    if (existing) {
      atom.workspace.open(uri);
      return;
    }
    const client = this.connections.clientFor(context.connectionId);
    const connection = this.connections.get(context.connectionId);
    const view = new JobLogView({
      client,
      connectionId: context.connectionId,
      projectId: project.id,
      job: { id: jobId, name: job.name || `Job ${jobId}`, status: job.status || 'running' },
      baseUrl: connection.baseUrl
    });
    const pane = atom.workspace.getActivePane();
    pane.addItem(view);
    pane.activateItem(view);
  },

  async toggleSchedule (schedule, active) {
    const { client, project } = await this.currentTarget();
    try {
      await client.setScheduleActive(project.id, schedule.id, active);
      atom.notifications.addSuccess(`Schedule "${schedule.description}" is now ${active ? 'on' : 'off'}.`);
    } catch (err) {
      if (err.status === 403) {
        // The commonest confusing failure: you can run pipelines all day and
        // still not be allowed to touch someone else's schedule.
        throw new Error(`Only the schedule's owner, a Maintainer or an Owner can turn "${schedule.description}" on or off. You can take ownership of it in GitLab if you are a Maintainer.`);
      }
      throw err;
    }
    await this.refresh({ force: true });
  },

  async runSchedule (schedule) {
    const { client, project } = await this.currentTarget();
    await client.runSchedule(project.id, schedule.id);
    atom.notifications.addSuccess(`Running "${schedule.description}" now.`);
    await this.refresh({ force: true });
  },

  /**
   * Check the .gitlab-ci.yml in the active editor.
   * Works with a read-only token, and a broken file still answers HTTP 200 -
   * validity is in the body, never the status code.
   */
  async lintCurrentFile () {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) throw new Error('Open a .gitlab-ci.yml first.');
    const filePath = editor.getPath() || '';
    if (!/\.ya?ml$/i.test(filePath) && !filePath.endsWith('.gitlab-ci.yml')) {
      const proceed = atom.confirm({
        message: 'That does not look like a CI file.',
        detailedMessage: 'Check it against GitLab anyway?',
        buttons: ['Check it', 'Cancel']
      });
      if (proceed !== 0) return;
    }

    const { client, project, context } = await this.currentTarget();
    const result = await client.lintCiConfig(project.id, editor.getText(), {
      dryRun: false, ref: context.branch
    });

    if (result.valid) {
      atom.notifications.addSuccess('CI configuration is valid.', {
        description: result.includes && result.includes.length > 0
          ? `${result.includes.length} included file(s) resolved.`
          : undefined
      });
      return;
    }
    atom.notifications.addError('CI configuration is not valid.', {
      detail: (result.errors || []).join('\n'),
      dismissable: true
    });
  },

  openInBrowser (pipeline) {
    const url = pipeline && (pipeline.web_url || pipeline.webUrl);
    if (url) {
      atom.applicationDelegate.openExternal(url);
      return;
    }
    // GraphQL gives a path rather than a URL.
    const context = this.context && this.context.get();
    const connection = context && this.connections.get(context.connectionId);
    if (connection && pipeline && pipeline.path) {
      atom.applicationDelegate.openExternal(`${connection.baseUrl}${pipeline.path}`);
    }
  }
};

/** GraphQL ids look like "gid://gitlab/Ci::Build/123". REST wants the 123. */
function numericId (id) {
  if (typeof id === 'number') return id;
  const match = String(id).match(/(\d+)$/);
  return match ? Number(match[1]) : id;
}

/**
 * Make REST results look like the GraphQL shape the view expects, so there is
 * only one rendering path. The action flags have to be guessed here, which is
 * exactly why GraphQL is preferred when it works.
 */
function restDetailShape (pipeline, jobs) {
  const byStage = new Map();
  for (const job of jobs) {
    if (!byStage.has(job.stage)) byStage.set(job.stage, []);
    byStage.get(job.stage).push({
      id: job.id,
      name: job.name,
      status: job.status,
      allowFailure: job.allow_failure,
      manualJob: job.status === 'manual',
      playable: job.status === 'manual',
      retryable: ['failed', 'success', 'canceled'].includes(job.status),
      cancelable: ['running', 'pending', 'created'].includes(job.status),
      duration: job.duration,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      failureMessage: job.failure_reason || null
    });
  }
  const stages = Array.from(byStage.entries()).map(([name, stageJobs]) => ({
    name,
    status: worstStatus(stageJobs.map((job) => job.status)),
    jobs: { nodes: stageJobs }
  }));

  return {
    id: pipeline.id,
    iid: pipeline.iid,
    status: pipeline.status,
    ref: pipeline.ref,
    sha: pipeline.sha,
    duration: pipeline.duration,
    startedAt: pipeline.started_at,
    finishedAt: pipeline.finished_at,
    cancelable: ['running', 'pending', 'created', 'waiting_for_resource', 'preparing'].includes(pipeline.status),
    retryable: ['failed', 'canceled', 'success'].includes(pipeline.status),
    stages: { nodes: stages },
    web_url: pipeline.web_url
  };
}

// Worst-first, so a stage with one failure reads as failed rather than passed.
const STATUS_RANK = ['failed', 'canceling', 'canceled', 'running', 'pending', 'manual', 'created', 'skipped', 'success'];
function worstStatus (statuses) {
  for (const candidate of STATUS_RANK) {
    if (statuses.includes(candidate)) return candidate;
  }
  return statuses[0] || 'created';
}
