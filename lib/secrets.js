/**
 * Where the GitLab token lives.
 *
 * Not in config.cson. Anything in a package's configSchema is written to
 * ~/.pulsar/config.cson in the clear, and a GitLab token with the "api" scope
 * is the user's whole GitLab account. Both of the old Atom GitLab packages did
 * exactly that; we are not repeating it.
 *
 * Four sources, tried in the order the user chose per connection:
 *
 *   keyring   Electron's safeStorage encrypts the token with a key held by the
 *             OS keyring (GNOME Keyring / KWallet on Linux). We store the
 *             ciphertext in our own state file. This is the default.
 *   env       Read from an environment variable. Nothing is stored at all.
 *   glab      Read from the official GitLab CLI's config, so a user who has
 *             already run `glab auth login` never types a token here.
 *   plain     Last resort, stored base64-obscured in a 0600 file, with a
 *             warning. Only reachable if the user explicitly picks it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let cachedSafeStorage;
// Results of the two keyring probes. Cached because reaching safeStorage goes
// through @electron/remote, and every single property access on that is a
// synchronous IPC round trip that blocks the editor's UI thread. The answer
// cannot change while Pulsar is running, so ask once.
let cachedAvailable;
let cachedBackend;

/**
 * Get at Electron's safeStorage from a renderer.
 *
 * safeStorage is a main-process API; @electron/remote proxies it over IPC, and
 * Pulsar 1.132 enables remote for every window with no module filter.
 *
 * Two routes work, measured on Pulsar 1.132.1, and the order matters:
 *
 *   1. Our own pinned @electron/remote. A third-party package cannot reach
 *      Pulsar's bundled copy (pulsar-edit/pulsar#1372), which is why it is in
 *      our dependencies. Pure JS, so no native rebuild on an Electron bump.
 *   2. require('electron').remote - Pulsar still shims this, but it is
 *      deprecated and prints a warning, and #1372 is milestoned for 1.133.0.
 *      Kept as a fallback in case the pinned copy fails to load.
 */
function safeStorage () {
  if (cachedSafeStorage !== undefined) return cachedSafeStorage;
  cachedSafeStorage = null;
  const attempts = [
    () => require('@electron/remote').safeStorage,
    () => require('electron').remote.safeStorage,
    () => require('electron').safeStorage
  ];
  for (const attempt of attempts) {
    try {
      const candidate = attempt();
      if (candidate && typeof candidate.isEncryptionAvailable === 'function') {
        cachedSafeStorage = candidate;
        break;
      }
    } catch (err) {
      // Try the next one.
    }
  }
  return cachedSafeStorage;
}

/**
 * True when the OS gave us a real keyring to encrypt against.
 *
 * On Linux this is false if no keyring daemon is running, in which case
 * Electron would fall back to a hardcoded key - which is not encryption in any
 * useful sense, so we treat it as unavailable and say so.
 */
function keyringAvailable () {
  if (cachedAvailable !== undefined) return cachedAvailable;
  cachedAvailable = probeAvailable();
  return cachedAvailable;
}

function probeAvailable () {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    if (!storage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && typeof storage.getSelectedStorageBackend === 'function') {
      const backend = storage.getSelectedStorageBackend();
      return backend !== 'basic_text' && backend !== 'unknown';
    }
    return true;
  } catch (err) {
    return false;
  }
}

function keyringBackendName () {
  if (cachedBackend !== undefined) return cachedBackend;
  cachedBackend = probeBackend();
  return cachedBackend;
}

function probeBackend () {
  const storage = safeStorage();
  if (!storage) return 'unavailable';
  try {
    if (typeof storage.getSelectedStorageBackend === 'function') {
      return storage.getSelectedStorageBackend();
    }
    return storage.isEncryptionAvailable() ? 'os' : 'unavailable';
  } catch (err) {
    return 'unavailable';
  }
}

function encryptToKeyring (token) {
  const storage = safeStorage();
  if (!storage) throw new Error('No OS keyring is available to encrypt the token.');
  // encryptString hands back a Buffer in the main process, but @electron/remote
  // structured-clones it across, so what arrives here is a plain Uint8Array.
  // Uint8Array.toString() ignores its argument and would give us "12,84,9,..."
  // instead of base64. Wrap it before encoding.
  return Buffer.from(storage.encryptString(token)).toString('base64');
}

function decryptFromKeyring (blob) {
  const storage = safeStorage();
  if (!storage) throw new Error('No OS keyring is available to decrypt the token.');
  return storage.decryptString(Buffer.from(blob, 'base64'));
}

// ---- the other three sources ---------------------------------------------

function fromEnv (variableName) {
  const name = variableName || 'GITLAB_TOKEN';
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set, or Pulsar was started before it was. Restart Pulsar from a shell where it is set.`);
  }
  return value.trim();
}

function glabConfigPath () {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'glab-cli', 'config.yml');
}

function legacyGlabConfigPath () {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'glab', 'config.yml');
}

/**
 * Pull a token out of the GitLab CLI's config for one host.
 *
 * The file is small YAML with a hosts: map. We read it with a narrow parser
 * rather than pulling in a YAML dependency for eight lines of nesting.
 */
function fromGlab (host) {
  const candidates = [glabConfigPath(), legacyGlabConfigPath()];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    throw new Error('No GitLab CLI config found. Run `glab auth login` first, or pick a different token source.');
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inHosts = false;
  let currentHost = null;
  let hostIndent = null;

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inHosts = line.trim().startsWith('hosts:');
      currentHost = null;
      continue;
    }
    if (!inHosts) continue;

    const match = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;

    if (hostIndent === null || indent === hostIndent) {
      if (rawValue === '') {
        hostIndent = indent;
        currentHost = key.trim();
        continue;
      }
    }
    if (currentHost === host && key.trim() === 'token' && rawValue !== '') {
      return rawValue.trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error(`The GitLab CLI has no token for ${host}. Run \`glab auth login --hostname ${host}\`, or pick a different token source.`);
}

// ---- the public shape -----------------------------------------------------

/**
 * Turn a stored token record into the actual token string.
 * @param {{source: string, blob?: string, envVar?: string}} record
 * @param {string} host - used by the glab lookup
 */
async function readToken (record, host) {
  if (!record || !record.source) throw new Error('No token is configured for this connection.');
  switch (record.source) {
    case 'keyring':
      return decryptFromKeyring(record.blob);
    case 'env':
      return fromEnv(record.envVar);
    case 'glab':
      return fromGlab(host);
    case 'plain':
      return Buffer.from(record.blob || '', 'base64').toString('utf8');
    default:
      throw new Error(`Unknown token source "${record.source}".`);
  }
}

/**
 * Build the record to store. Only 'keyring' and 'plain' actually hold the
 * token; the other two hold a pointer to where it lives.
 */
function makeTokenRecord (source, { token = null, envVar = null } = {}) {
  switch (source) {
    case 'keyring':
      return { source: 'keyring', blob: encryptToKeyring(token) };
    case 'env':
      return { source: 'env', envVar: envVar || 'GITLAB_TOKEN' };
    case 'glab':
      return { source: 'glab' };
    case 'plain':
      return { source: 'plain', blob: Buffer.from(token, 'utf8').toString('base64') };
    default:
      throw new Error(`Unknown token source "${source}".`);
  }
}

/**
 * Which source to use when the user has not picked one.
 * Prefer the keyring; fall back to whatever needs no typing; refuse to
 * silently choose plaintext.
 */
function bestAvailableSource (host) {
  if (keyringAvailable()) return 'keyring';
  try {
    fromGlab(host);
    return 'glab';
  } catch (err) {
    // no glab token for this host
  }
  if (process.env.GITLAB_TOKEN) return 'env';
  return null;
}

/** Never let a token reach a log line or a notification body. */
function redact (text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\bglpat-[A-Za-z0-9_-]{6,}/g, 'glpat-***')
    .replace(/\bgl[a-z]{2,}-[A-Za-z0-9_-]{20,}/g, '***')
    .replace(/(Bearer|PRIVATE-TOKEN:?)\s+\S+/gi, '$1 ***');
}

/**
 * Ask the keyring its two questions now, off the startup path, so the first
 * time a user opens the connection dialog it is already answered. Safe to call
 * more than once; everything after the first is free.
 */
function warmUp () {
  keyringAvailable();
  keyringBackendName();
}

module.exports = {
  warmUp,
  readToken,
  makeTokenRecord,
  keyringAvailable,
  keyringBackendName,
  bestAvailableSource,
  fromGlab,
  fromEnv,
  glabConfigPath,
  redact
};
