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

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Emitter, CompositeDisposable } = require('atom');
const { parseRemote, hostMatches } = require('./git-remote');

// Remote names to try when the config file cannot be read. This used to be the
// whole story, which meant a remote called anything else was invisible - and
// "Git remote to follow" could not select one either, because it checks
// against this same list.
const FALLBACK_REMOTE_NAMES = ['upstream', 'gitlab', 'fork'];

// git itself stops at 10 levels of include nesting.
const MAX_INCLUDE_DEPTH = 10;

/**
 * Where this repository's config file lives.
 *
 * getPath() gives the .git directory, but it is not always a directory: a
 * submodule or a linked worktree has a .git *file* naming the real one. And a
 * linked worktree keeps its own HEAD while sharing config with the main
 * checkout, which is what "commondir" points at.
 */
function gitConfigPathFor (repository) {
  let gitDir;
  try {
    gitDir = repository.getPath && repository.getPath();
  } catch (err) {
    return null;
  }
  if (!gitDir) return null;

  try {
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!pointer) return null;
      gitDir = path.resolve(path.dirname(gitDir), pointer[1].trim());
    }

    const commonDirFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirFile)) {
      const common = fs.readFileSync(commonDirFile, 'utf8').trim();
      if (common) gitDir = path.resolve(gitDir, common);
    }

    return path.join(gitDir, 'config');
  } catch (err) {
    return null;
  }
}

/**
 * Read one git config file into { remotes, includes }.
 *
 * Only names and include paths - the URLs are read back through
 * getConfigValue, so git's own resolution applies rather than a second-guess
 * of its file format here. That also means insteadOf rewrites and a remote
 * with several urls are git's problem, not ours.
 *
 * @param {string} text - the contents of a git config file
 */
function scanConfig (text) {
  const remotes = [];
  const includes = [];
  let section = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;

    const header = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/);
    if (header) {
      section = { name: header[1].toLowerCase(), sub: header[2] };
      if (section.name === 'remote' && section.sub && !remotes.includes(section.sub)) {
        remotes.push(section.sub);
      }
      continue;
    }
    if (!section) continue;

    const pair = line.match(/^([A-Za-z0-9-]+)\s*=\s*(.*)$/);
    if (!pair) continue;
    if (pair[1].toLowerCase() === 'path' &&
        (section.name === 'include' || section.name === 'includeif')) {
      includes.push(pair[2].trim());
    }
  }
  return { remotes, includes };
}

/**
 * Remote names from a config file and everything it includes.
 *
 * includeIf conditions are not evaluated - the file is followed whether or not
 * its condition would match. That over-includes on purpose: a name we should
 * not have seen simply has no url when getConfigValue is asked for it and gets
 * dropped, whereas missing a name loses a remote outright.
 */
function remoteNamesIn (text, configPath = null, seen = new Set(), depth = 0) {
  const { remotes, includes } = scanConfig(text);
  if (depth >= MAX_INCLUDE_DEPTH || !configPath) return remotes;

  for (const include of includes) {
    const resolved = resolveIncludePath(include, configPath);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    let included;
    try {
      included = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      continue;
    }
    for (const name of remoteNamesIn(included, resolved, seen, depth + 1)) {
      if (!remotes.includes(name)) remotes.push(name);
    }
  }
  return remotes;
}

/** An include path is relative to the including file, and may start with ~. */
function resolveIncludePath (value, fromConfigPath) {
  if (!value) return null;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;
  return path.resolve(path.dirname(fromConfigPath), value);
}

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
  /**
   * Every remote this repository has, name to URL.
   *
   * origin goes in first so it keeps winning the "first remote whose host we
   * recognise" fallback, then the rest in the order git lists them.
   *
   * Pulsar's GitRepository has no way to enumerate remotes - the native handle
   * offers getConfigValue for a known key and nothing that lists keys - so the
   * names are read out of .git/config and each URL is then fetched through the
   * supported call.
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

    const handle = repository.repo || repository.async || null;
    if (!handle || typeof handle.getConfigValue !== 'function') return out;

    for (const name of this.remoteNamesOf(repository)) {
      if (out.has(name)) continue;
      try {
        const url = handle.getConfigValue(`remote.${name}.url`);
        if (url) out.set(name, url);
      } catch (err) {
        // named in the config but unreadable; skip it
      }
    }
    return out;
  }

  /**
   * The remote names to look up. Real ones from the config file, or the old
   * hardcoded guesses if it cannot be read - an unreadable config should cost
   * the extra remotes, not every remote.
   */
  remoteNamesOf (repository) {
    const configPath = gitConfigPathFor(repository);
    if (!configPath) return FALLBACK_REMOTE_NAMES;
    try {
      return remoteNamesIn(fs.readFileSync(configPath, 'utf8'), configPath);
    } catch (err) {
      return FALLBACK_REMOTE_NAMES;
    }
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

module.exports = { ProjectContext, remoteNamesIn, scanConfig, gitConfigPathFor };
