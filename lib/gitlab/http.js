/**
 * The HTTP layer.
 *
 * This deliberately uses Node's `https` module rather than the browser `fetch`
 * that Pulsar's renderer also offers. Reason: fetch goes through Chromium's
 * network stack, and Chromium will not let you hand it a certificate authority
 * file. A self-hosted GitLab on a local network almost always has a private
 * certificate, so we need `https.Agent({ca: ...})`, and that only exists here.
 *
 * We never touch NODE_TLS_REJECT_UNAUTHORIZED or Electron's
 * --ignore-certificate-errors switch: both would turn certificate checking off
 * for the whole editor, not just for our requests.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_TIMEOUT_MS = 20000;

class GitLabError extends Error {
  constructor (message, { status = null, body = null, url = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'GitLabError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

// One agent per distinct TLS setup, so we are not re-reading the CA file and
// re-doing the handshake on every poll.
const agentCache = new Map();

function tlsCacheKey (tls = {}) {
  return JSON.stringify([
    tls.caPath || '',
    tls.certPath || '',
    tls.keyPath || '',
    tls.fingerprint || '',
    tls.rejectUnauthorized === false ? 0 : 1
  ]);
}

function readIfSet (path) {
  if (!path) return undefined;
  return fs.readFileSync(path);
}

/**
 * Compare a certificate's SHA-256 fingerprint against one the user pinned.
 * This is the middle option between "trust a CA file" and "trust anything":
 * the user pastes the one fingerprint their server presents.
 */
function makeIdentityChecker (fingerprint) {
  const wanted = String(fingerprint).replace(/[^a-f0-9]/gi, '').toLowerCase();
  return (host, cert) => {
    const raw = cert && cert.raw;
    if (!raw) return new Error(`Could not read the certificate from ${host}.`);
    const actual = crypto.createHash('sha256').update(raw).digest('hex');
    if (actual !== wanted) {
      return new Error(
        `Certificate for ${host} does not match the pinned fingerprint.\n` +
        `  expected ${wanted}\n  got      ${actual}`
      );
    }
    return undefined;
  };
}

function buildAgent (tls = {}) {
  const key = tlsCacheKey(tls);
  if (agentCache.has(key)) return agentCache.get(key);

  const options = { keepAlive: true, maxSockets: 6 };
  const ca = readIfSet(tls.caPath);
  const cert = readIfSet(tls.certPath);
  const certKey = readIfSet(tls.keyPath);
  if (ca) options.ca = ca;
  if (cert) options.cert = cert;
  if (certKey) options.key = certKey;
  if (tls.rejectUnauthorized === false) options.rejectUnauthorized = false;
  if (tls.fingerprint) options.checkServerIdentity = makeIdentityChecker(tls.fingerprint);

  const agent = new https.Agent(options);
  agentCache.set(key, agent);
  return agent;
}

/** Drop every cached agent. Call this when a connection's TLS settings change. */
function clearAgentCache () {
  for (const agent of agentCache.values()) {
    if (typeof agent.destroy === 'function') agent.destroy();
  }
  agentCache.clear();
}

function parseRateLimit (headers) {
  const num = (name) => {
    const raw = headers[name];
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    limit: num('ratelimit-limit'),
    remaining: num('ratelimit-remaining'),
    reset: num('ratelimit-reset'),
    retryAfter: num('retry-after')
  };
}

/**
 * One request. Resolves with {status, headers, body, rateLimit} for any HTTP
 * response - it does not throw on a 4xx, because the caller often wants to look
 * at the body (a failed CI lint is a 200 with valid:false, and a 403 on a
 * schedule toggle needs a specific message).
 * It throws only when the request never completed: DNS, TLS, timeout, socket.
 */
function request (url, { method = 'GET', headers = {}, body = null, tls = {}, timeout = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new GitLabError(`Not a usable URL: ${url}`, { url }));
      return;
    }

    const isTls = parsed.protocol === 'https:';
    const transport = isTls ? https : http;
    const payload = body === null || body === undefined
      ? null
      : (typeof body === 'string' ? body : JSON.stringify(body));

    const requestHeaders = Object.assign({
      Accept: 'application/json',
      'User-Agent': 'pulsar-gitlab-pipelines'
    }, headers);
    if (payload !== null && requestHeaders['Content-Type'] === undefined) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    if (payload !== null) {
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || (isTls ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: requestHeaders,
      timeout
    };
    if (isTls) options.agent = buildAgent(tls);

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || '';
        let parsedBody = raw.toString('utf8');
        if (contentType.includes('application/json') && parsedBody.length > 0) {
          try {
            parsedBody = JSON.parse(parsedBody);
          } catch (err) {
            // Leave it as text. A proxy or a login page can answer with
            // broken JSON, and the raw text is the more useful error.
          }
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsedBody,
          raw,
          rateLimit: parseRateLimit(res.headers),
          url
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new GitLabError(`${method} ${url} timed out after ${timeout} ms.`, { url }));
    });

    req.on('error', (err) => {
      reject(describeNetworkError(err, url));
    });

    if (signal) {
      if (signal.aborted) {
        req.destroy();
        reject(new GitLabError('Request cancelled.', { url }));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }

    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** Turn a raw Node socket/TLS error into something a person can act on. */
function describeNetworkError (err, url) {
  if (err instanceof GitLabError) return err;
  const host = (() => {
    try { return new URL(url).host; } catch (e) { return url; }
  })();

  const map = {
    ENOTFOUND: `Cannot find ${host}. Check the URL, and check you are on the network or VPN that can see it.`,
    EAI_AGAIN: `Cannot look up ${host} right now. DNS is not answering.`,
    ECONNREFUSED: `${host} refused the connection. Is GitLab running on that port?`,
    ECONNRESET: `${host} closed the connection unexpectedly.`,
    ETIMEDOUT: `${host} did not answer in time.`,
    CERT_HAS_EXPIRED: `The certificate for ${host} has expired.`,
    DEPTH_ZERO_SELF_SIGNED_CERT: `${host} uses a self-signed certificate. Point "Certificate authority file" at its CA, or pin its fingerprint, in the connection settings.`,
    SELF_SIGNED_CERT_IN_CHAIN: `${host} uses a private certificate authority. Point "Certificate authority file" at that CA in the connection settings.`,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: `Cannot verify the certificate for ${host}. It is probably signed by a private certificate authority - point "Certificate authority file" at it.`,
    ERR_TLS_CERT_ALTNAME_INVALID: `The certificate for ${host} is issued for a different name.`
  };

  const message = map[err.code] || `${err.code || 'Network error'} talking to ${host}: ${err.message}`;
  const wrapped = new GitLabError(message, { url });
  wrapped.code = err.code;
  return wrapped;
}

module.exports = { request, buildAgent, clearAgentCache, GitLabError, describeNetworkError, parseRateLimit };
