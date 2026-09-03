/**
 * Turning a git remote URL into "which GitLab host, which project".
 *
 * Handles the three shapes a GitLab remote actually comes in:
 *   git@gitlab.com:group/sub/project.git
 *   ssh://git@git.sds.lab:2222/group/sub/project.git
 *   https://git.sds.lab/group/sub/project.git
 *
 * Subgroups need no special case - they are just more slashes.
 */

const SCP_LIKE = /^([^@/]+@)?([^:/]+):(.+)$/;

// scheme://[user@]host[:port][/path]
//
// Written out by hand rather than handed to `new URL()`. Chromium's URL parser
// and Node's disagree about non-http schemes: for "ssh://git@host:22/p.git"
// Node fills in hostname and port, while Chromium leaves the host empty and
// swallows the whole authority into the path. Pulsar runs on Chromium, so
// using URL here silently mangled every ssh:// remote.
const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^:/?#]+)(?::(\d+))?(\/[^?#]*)?/i;

// Strip a trailing .git and any leading/trailing slashes off a project path.
function cleanPath (path) {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
}

/**
 * @param {string} remoteUrl
 * @returns {{host: string, port: (number|null), projectPath: string, protocol: string}|null}
 */
function parseRemote (remoteUrl) {
  if (typeof remoteUrl !== 'string') return null;
  const url = remoteUrl.trim();
  if (url === '') return null;

  const schemeMatch = url.match(SCHEME_URL);
  if (schemeMatch) {
    const [, protocol, host, port, path] = schemeMatch;
    const projectPath = cleanPath(path || '');
    if (projectPath === '') return null;
    return {
      host,
      port: port === undefined ? null : Number(port),
      projectPath,
      protocol: protocol.toLowerCase()
    };
  }

  // scp-style: user@host:group/project.git
  const match = url.match(SCP_LIKE);
  if (match) {
    const projectPath = cleanPath(match[3]);
    if (projectPath === '') return null;
    return {
      host: match[2],
      port: null,
      projectPath,
      protocol: 'ssh'
    };
  }

  return null;
}

/**
 * The API wants the project path URL-encoded whole, slashes included:
 * group/sub/project -> group%2Fsub%2Fproject
 * A path left with real slashes routes somewhere else entirely and 404s.
 */
function encodeProjectPath (projectPath) {
  return encodeURIComponent(projectPath);
}

/** Do two hosts refer to the same GitLab? Compares host only, case-insensitively. */
function hostMatches (remoteHost, baseUrl) {
  if (!remoteHost || !baseUrl) return false;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (err) {
    return false;
  }
  return parsed.hostname.toLowerCase() === String(remoteHost).toLowerCase();
}

module.exports = { parseRemote, encodeProjectPath, hostMatches, cleanPath };
