/**
 * The list of GitLab instances the user has set up.
 *
 * Kept in its own file next to config.cson rather than in the package settings,
 * for two reasons: it holds an encrypted token, and it is a list rather than a
 * single value - the user works against gitlab.com and a self-hosted instance
 * at the same time, and Pulsar's settings UI cannot edit a list of objects.
 *
 * The file is 0600. Even with the token encrypted, the CA paths and instance
 * URLs are nobody else's business.
 */

const fs = require('fs');
const path = require('path');
const { Emitter } = require('atom');
const secrets = require('./secrets');
const { GitLabClient } = require('./gitlab/client');
const { clearAgentCache } = require('./gitlab/http');
const { parseRemote, hostMatches } = require('./git-remote');

const STATE_FILE = 'gitlab-pipelines.json';
const FILE_VERSION = 1;

function stateFilePath () {
  const home = (typeof atom !== 'undefined' && atom.getConfigDirPath)
    ? atom.getConfigDirPath()
    : path.join(require('os').homedir(), '.pulsar');
  return path.join(home, STATE_FILE);
}

function newId () {
  return `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

class ConnectionStore {
  constructor ({ filePath = null } = {}) {
    this.filePath = filePath || stateFilePath();
    this.emitter = new Emitter();
    this.connections = [];
    this.clients = new Map();
    this.load();
  }

  onDidChange (callback) {
    return this.emitter.on('did-change', callback);
  }

  load () {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.connections = Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        atomWarn(`Could not read ${this.filePath}: ${err.message}. Starting with no connections.`);
      }
      this.connections = [];
    }
    return this.connections;
  }

  save () {
    const payload = JSON.stringify({ version: FILE_VERSION, connections: this.connections }, null, 2);
    // Write with the restrictive mode set at create time, so there is never a
    // moment where the file exists world-readable.
    fs.writeFileSync(this.filePath, payload, { mode: 0o600 });
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch (err) {
      // A filesystem that cannot do modes. Nothing useful to do about it.
    }
    this.emitter.emit('did-change', this.connections);
  }

  all () {
    return this.connections.slice();
  }

  get (id) {
    return this.connections.find((connection) => connection.id === id) || null;
  }

  getByName (name) {
    return this.connections.find((connection) => connection.name === name) || null;
  }

  /**
   * @param {object} input - {name, baseUrl, tokenSource, token, envVar, scope, tls}
   */
  add (input) {
    const baseUrl = normaliseBaseUrl(input.baseUrl);
    const host = new URL(baseUrl).hostname;
    const source = input.tokenSource || secrets.bestAvailableSource(host) || 'plain';
    const connection = {
      id: newId(),
      name: input.name || host,
      baseUrl,
      scope: input.scope || 'api',
      tls: cleanTls(input.tls),
      token: secrets.makeTokenRecord(source, { token: input.token, envVar: input.envVar })
    };
    this.connections.push(connection);
    this.save();
    return connection;
  }

  update (id, changes) {
    const connection = this.get(id);
    if (!connection) throw new Error(`No connection with id ${id}.`);
    if (changes.baseUrl) connection.baseUrl = normaliseBaseUrl(changes.baseUrl);
    if (changes.name) connection.name = changes.name;
    if (changes.scope) connection.scope = changes.scope;
    if (changes.tls !== undefined) connection.tls = cleanTls(changes.tls);
    if (changes.tokenSource) {
      const host = new URL(connection.baseUrl).hostname;
      connection.token = secrets.makeTokenRecord(changes.tokenSource, {
        token: changes.token,
        envVar: changes.envVar
      });
      void host;
    }
    this.clients.delete(id);
    clearAgentCache();
    this.save();
    return connection;
  }

  remove (id) {
    const before = this.connections.length;
    this.connections = this.connections.filter((connection) => connection.id !== id);
    this.clients.delete(id);
    if (this.connections.length !== before) this.save();
  }

  /** A client for this connection, built once and reused. */
  clientFor (id) {
    if (this.clients.has(id)) return this.clients.get(id);
    const connection = this.get(id);
    if (!connection) return null;
    const host = new URL(connection.baseUrl).hostname;
    const client = new GitLabClient(connection, () => secrets.readToken(connection.token, host));
    this.clients.set(id, client);
    return client;
  }

  /**
   * Which connection serves this git remote?
   * Matches on hostname, so a project cloned over SSH still finds the
   * connection configured with an https base URL.
   */
  findForRemote (remoteUrl) {
    const remote = parseRemote(remoteUrl);
    if (!remote) return null;
    const connection = this.connections.find((candidate) => hostMatches(remote.host, candidate.baseUrl));
    return connection ? { connection, remote } : null;
  }
}

function normaliseBaseUrl (raw) {
  let value = String(raw || '').trim();
  if (value === '') throw new Error('A GitLab URL is required.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  // Strip a trailing /api/v4 - people paste it, and we add it ourselves.
  value = value.replace(/\/+$/, '').replace(/\/api\/v4$/i, '');
  // Throws if it is not a usable URL, which is the right moment to find out.
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

function cleanTls (tls) {
  if (!tls) return {};
  const out = {};
  if (tls.caPath) out.caPath = tls.caPath;
  if (tls.certPath) out.certPath = tls.certPath;
  if (tls.keyPath) out.keyPath = tls.keyPath;
  if (tls.fingerprint) out.fingerprint = String(tls.fingerprint).trim();
  if (tls.rejectUnauthorized === false) out.rejectUnauthorized = false;
  return out;
}

function atomWarn (message) {
  if (typeof atom !== 'undefined' && atom.notifications) {
    atom.notifications.addWarning('GitLab Pipelines', { description: message });
  } else {
    process.stderr.write(`${message}\n`);
  }
}

module.exports = { ConnectionStore, normaliseBaseUrl, stateFilePath };
