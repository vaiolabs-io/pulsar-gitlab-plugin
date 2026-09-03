/**
 * Works out "which GitLab project and which branch am I looking at right now".
 *
 * Everything else in the package hangs off this. Get it wrong and the user is
 * looking at another repository's pipelines without realising.
 *
 * The old gitlab-integration package hardcoded the `origin` remote and its own
 * README admitted that was a problem: plenty of people push to `upstream`, or
 * have a GitHub mirror on `origin` and GitLab on a second remote. So the remote
 * is configurable, and falls back to whichever remote points at a host we have
 * a connection for.
 */

const { Emitter, CompositeDisposable } = require('atom');
const { parseRemote, hostMatches } = require('./git-remote');

class ProjectContext {
  constructor (connectionStore) {
    this.connections = connectionStore;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.current = null;
    this.projectCache = new Map();

    this.subscriptions.add(
      atom.project.onDidChangePaths(() => this.refresh()),
      atom.workspace.onDidChangeActivePaneItem(() => this.refresh()),
      this.connections.onDidChange(() => {
        this.projectCache.clear();
        this.refresh();
      })
    );

    // A branch change does not fire a project event, so watch the repositories
    // themselves. Repos can appear later, hence the re-hook on path change.
    this.hookRepositories();
    this.subscriptions.add(atom.project.onDidChangePaths(() => this.hookRepositories()));
  }

  dispose () {
    this.subscriptions.dispose();
    if (this.repoSubscriptions) this.repoSubscriptions.dispose();
  }

  onDidChange (callback) {
    return this.emitter.on('did-change', callback);
  }

  hookRepositories () {
    if (this.repoSubscriptions) this.repoSubscriptions.dispose();
    this.repoSubscriptions = new CompositeDisposable();
    for (const repo of atom.project.getRepositories()) {
      if (!repo) continue;
      this.repoSubscriptions.add(repo.onDidChangeStatuses(() => this.refresh()));
    }
  }

  /** The repository that owns the file the user is looking at, else the first one. */
  activeRepository () {
    const repositories = atom.project.getRepositories().filter(Boolean);
    if (repositories.length === 0) return null;
    if (repositories.length === 1) return repositories[0];

    const editor = atom.workspace.getActiveTextEditor();
    const filePath = editor && editor.getPath();
    if (filePath) {
      const owning = repositories.find((repo) => {
        try {
          return repo.repo && repo.getWorkingDirectory() && filePath.startsWith(repo.getWorkingDirectory());
        } catch (err) {
          return false;
        }
      });
      if (owning) return owning;
    }
    return repositories[0];
  }

  /**
   * All remotes of a repository, as name -> url.
   * Pulsar's GitRepository exposes getOriginURL() and not much else, so we read
   * the config through the underlying repo handle when it is there.
   */
  remotesOf (repository) {
    const out = new Map();
    if (!repository) return out;

    // The one remote the API definitely gives us.
    try {
      const origin = repository.getOriginURL();
      if (origin) out.set('origin', origin);
    } catch (err) {
      // no origin configured
    }

    // Anything else has to come out of git config directly.
    const handle = repository.repo || repository.async || null;
    if (handle && typeof handle.getConfigValue === 'function') {
      for (const name of ['upstream', 'gitlab', 'fork']) {
        try {
          const url = handle.getConfigValue(`remote.${name}.url`);
          if (url) out.set(name, url);
        } catch (err) {
          // remote not present
        }
      }
    }
    return out;
  }

  /**
   * Pick the remote to follow.
   * A name in the settings wins. Otherwise take the first remote whose host we
   * actually have a connection for - which is the useful default when origin
   * points at GitHub and a second remote points at GitLab.
   */
  chooseRemote (repository) {
    const remotes = this.remotesOf(repository);
    if (remotes.size === 0) return null;

    const preferred = atom.config.get('gitlab-pipelines.gitRemoteName');
    if (preferred && remotes.has(preferred)) {
      return { name: preferred, url: remotes.get(preferred) };
    }

    for (const [name, url] of remotes) {
      const parsed = parseRemote(url);
      if (!parsed) continue;
      const known = this.connections.all().some((connection) => hostMatches(parsed.host, connection.baseUrl));
      if (known) return { name, url };
    }

    const [name, url] = remotes.entries().next().value;
    return { name, url };
  }

  /**
   * Recompute the context and tell anyone listening if it actually changed.
   * "Actually changed" matters: this runs on every pane switch, and rebuilding
   * the pipeline view on every keystroke-adjacent event would be miserable.
   */
  refresh () {
    const next = this.compute();
    const before = this.current;
    const same = before && next &&
      before.connectionId === next.connectionId &&
      before.projectPath === next.projectPath &&
      before.branch === next.branch;
    if (same) return this.current;
    if (!before && !next) return null;

    this.current = next;
    this.emitter.emit('did-change', next);
    return next;
  }

  compute () {
    const repository = this.activeRepository();
    if (!repository) return null;

    const remote = this.chooseRemote(repository);
    if (!remote) return null;

    const parsed = parseRemote(remote.url);
    if (!parsed) return null;

    const match = this.connections.all().find((connection) => hostMatches(parsed.host, connection.baseUrl));

    let branch = null;
    try {
      branch = repository.getShortHead();
    } catch (err) {
      branch = null;
    }

    return {
      repositoryPath: repository.getWorkingDirectory ? repository.getWorkingDirectory() : null,
      remoteName: remote.name,
      remoteUrl: remote.url,
      host: parsed.host,
      projectPath: parsed.projectPath,
      branch,
      connectionId: match ? match.id : null,
      connectionName: match ? match.name : null
    };
  }

  get () {
    if (this.current === null) this.refresh();
    return this.current;
  }

  /**
   * Resolve the project path to GitLab's numeric id, once per project.
   * Everything downstream uses the number: it survives a rename, and there is
   * no path re-encoding left to get wrong.
   */
  async resolveProject (context) {
    if (!context || !context.connectionId) return null;
    const key = `${context.connectionId}:${context.projectPath}`;
    if (this.projectCache.has(key)) return this.projectCache.get(key);

    const client = this.connections.clientFor(context.connectionId);
    if (!client) return null;
    const project = await client.getProject(context.projectPath);
    this.projectCache.set(key, project);
    return project;
  }

  forgetProject (context) {
    if (!context) return;
    this.projectCache.delete(`${context.connectionId}:${context.projectPath}`);
  }
}

module.exports = { ProjectContext };
