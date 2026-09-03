/**
 * A GitLab client for one connection (one instance + one token).
 *
 * REST for the list views, all the write actions, and the CI lint.
 * GraphQL for the pipeline detail pane only, because REST cannot tell you the
 * stage order and cannot tell you whether a button is legal to press -
 * GraphQL's playable/retryable/cancelable flags can.
 */

const { request, GitLabError } = require('./http');
const { encodeProjectPath } = require('../git-remote');

const ACCESS = { NONE: 0, GUEST: 10, REPORTER: 20, DEVELOPER: 30, MAINTAINER: 40, OWNER: 50 };

// Every status GitLab can report, for pipelines and for jobs. Anything not in
// here is rendered as-is rather than crashing us - GitLab has grown this list
// twice already.
const TERMINAL_STATUSES = new Set(['success', 'failed', 'canceled', 'skipped', 'manual']);

function isTerminal (status) {
  return TERMINAL_STATUSES.has(normaliseStatus(status));
}

/**
 * GraphQL is inconsistent about the case of a status, and it is not a
 * cosmetic difference - every comparison downstream depends on it.
 *
 * Measured against gitlab.com on 2026-09-03:
 *   pipeline.status            "RUNNING"    <- enum, serialised as its name
 *   job.status                 "SUCCESS"    <- enum
 *   stage.status               "running"    <- plain String field
 *   detailedStatus.label       "running"
 *
 * The enums are declared `value status.upcase, ..., value: status`, so
 * graphql-ruby sends the upper-case name. REST sends lower case throughout.
 * Left alone, "SUCCESS" matches nothing: icons fall back to a grey dot and
 * `status === 'manual'` is never true, so a manual job never offers its Run
 * button. Normalise once, here at the edge, rather than defending in twenty
 * comparisons.
 */
function normaliseStatus (status) {
  return typeof status === 'string' ? status.toLowerCase() : status;
}

/** Lower-case every status in a GraphQL pipeline, in place. */
function normaliseDetail (detail) {
  if (!detail) return detail;
  detail.status = normaliseStatus(detail.status);
  const stages = (detail.stages && detail.stages.nodes) || [];
  for (const stage of stages) {
    stage.status = normaliseStatus(stage.status);
    for (const job of (stage.jobs && stage.jobs.nodes) || []) {
      job.status = normaliseStatus(job.status);
    }
  }
  return detail;
}

/** Pull a human message out of GitLab's two different error body shapes. */
function messageFromBody (body) {
  if (!body) return null;
  if (typeof body === 'string') return body.slice(0, 400);
  const raw = body.message || body.error || body.error_description;
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.join('; ');
  if (typeof raw === 'object') {
    // {"message": {"base": ["Reference not found"]}}
    return Object.entries(raw)
      .map(([field, msgs]) => (Array.isArray(msgs) ? msgs.join('; ') : String(msgs)))
      .join('; ');
  }
  return null;
}

class GitLabClient {
  /**
   * @param {object} connection - {name, baseUrl, tls:{}, scope}
   * @param {function(): Promise<string>} getToken - resolved lazily so the
   *        token is never held on this object longer than a request needs it.
   */
  constructor (connection, getToken) {
    this.connection = connection;
    this.getToken = getToken;
    this.version = null;
    this.currentUser = null;
    this.lastRateLimit = null;
    this.projectIdCache = new Map();
  }

  get apiRoot () {
    return `${String(this.connection.baseUrl).replace(/\/+$/, '')}/api/v4`;
  }

  get graphqlUrl () {
    return `${String(this.connection.baseUrl).replace(/\/+$/, '')}/api/graphql`;
  }

  async call (method, path, { query = null, body = null, expect = null, signal = null, rawText = false } = {}) {
    const token = await this.getToken();
    let url = `${this.apiRoot}${path}`;
    if (query) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) {
          for (const item of value) search.append(`${key}[]`, item);
        } else {
          search.append(key, value);
        }
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }

    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (rawText) headers.Accept = 'text/plain';

    const res = await request(url, { method, headers, body, tls: this.connection.tls || {}, signal });
    this.lastRateLimit = res.rateLimit;

    if (res.status === 429) {
      throw new GitLabError(
        'GitLab is rate limiting us. Backing off.',
        { status: 429, url, retryAfter: res.rateLimit.retryAfter || 60 }
      );
    }

    const ok = expect ? expect.includes(res.status) : res.status >= 200 && res.status < 300;
    if (!ok) throw this.explain(res, method, path);
    return res;
  }

  /**
   * Turn an HTTP failure into a sentence that says what to do about it.
   * A 403 is ambiguous between "your role is too low" and "your token is
   * read-only", so we use the scope recorded when the connection was set up.
   */
  explain (res, method, path) {
    const detail = messageFromBody(res.body);
    const readOnly = this.connection.scope === 'read_api';
    const isWrite = method !== 'GET';

    let message;
    switch (res.status) {
      case 401:
        message = `Your token for "${this.connection.name}" is not valid any more. It may have expired or been revoked - reconnect to fix it.`;
        break;
      case 403:
        if (isWrite && readOnly) {
          message = `That needs a token with the "api" scope. The token for "${this.connection.name}" is read-only, so it can look but not touch.`;
        } else if (isWrite) {
          message = `You do not have permission to do that on this project. Running and cancelling pipelines needs the Developer role; changing a schedule you do not own needs Maintainer.`;
        } else {
          message = 'GitLab refused to show that. Your token may not cover this project.';
        }
        break;
      case 404:
        message = `Not found - or your token cannot see it. Private projects look identical to missing ones over the API.`;
        break;
      case 400:
        message = detail || 'GitLab rejected that request.';
        break;
      default:
        message = detail || `GitLab answered ${res.status} for ${method} ${path}.`;
    }
    if (detail && res.status !== 400 && !message.includes(detail)) {
      message += ` (GitLab said: ${detail})`;
    }
    return new GitLabError(message, { status: res.status, body: res.body, url: res.url });
  }

  // ---- connection checks ------------------------------------------------

  /**
   * Two calls, because they fail differently and the difference is the whole
   * diagnosis: /version failing means the URL or the network is wrong,
   * /user failing after that means the token is wrong.
   */
  async checkConnection () {
    const versionRes = await this.call('GET', '/version');
    this.version = versionRes.body;
    const userRes = await this.call('GET', '/user');
    this.currentUser = userRes.body;
    return { version: this.version, user: this.currentUser };
  }

  /** "18.1.1-ee" -> [18, 1, 1]. Used to skip features an older server lacks. */
  versionParts () {
    const raw = this.version && this.version.version;
    if (!raw) return null;
    const parts = String(raw).split('-')[0].split('.').map(Number);
    return parts.every(Number.isFinite) ? parts : null;
  }

  atLeast (major, minor = 0, patch = 0) {
    const parts = this.versionParts();
    if (!parts) return false;
    const [a = 0, b = 0, c = 0] = parts;
    if (a !== major) return a > major;
    if (b !== minor) return b > minor;
    return c >= patch;
  }

  // ---- projects ---------------------------------------------------------

  async getProject (pathOrId) {
    const id = typeof pathOrId === 'number' ? pathOrId : encodeProjectPath(pathOrId);
    const res = await this.call('GET', `/projects/${id}`);
    const project = res.body;
    if (project && project.path_with_namespace) {
      // Cache the numeric id. Everything after this uses the number: it
      // survives a rename and there is no re-encoding to get wrong.
      this.projectIdCache.set(project.path_with_namespace, project.id);
    }
    return project;
  }

  /** Highest role the user holds here, counting group membership. */
  static accessLevel (project) {
    const perms = (project && project.permissions) || {};
    const direct = perms.project_access && perms.project_access.access_level;
    const group = perms.group_access && perms.group_access.access_level;
    return Math.max(direct || 0, group || 0);
  }

  static canWrite (project) {
    return GitLabClient.accessLevel(project) >= ACCESS.DEVELOPER;
  }

  // ---- pipelines: read --------------------------------------------------

  async listPipelines (projectId, { ref = null, status = null, perPage = 20, page = 1, signal = null } = {}) {
    const res = await this.call('GET', `/projects/${projectId}/pipelines`, {
      query: { ref, status, per_page: perPage, page, order_by: 'id', sort: 'desc' },
      signal
    });
    return {
      pipelines: Array.isArray(res.body) ? res.body : [],
      // x-total is absent past 10,000 rows, so never assume it is there.
      nextPage: res.headers['x-next-page'] ? Number(res.headers['x-next-page']) : null,
      total: res.headers['x-total'] ? Number(res.headers['x-total']) : null
    };
  }

  async getPipeline (projectId, pipelineId, { signal = null } = {}) {
    const res = await this.call('GET', `/projects/${projectId}/pipelines/${pipelineId}`, { signal });
    return res.body;
  }

  /** The head pipeline for a branch. Answers 403, not 404, when there is none. */
  async latestPipeline (projectId, ref, { signal = null } = {}) {
    try {
      const res = await this.call('GET', `/projects/${projectId}/pipelines/latest`, { query: { ref }, signal });
      return res.body;
    } catch (err) {
      if (err.status === 403 || err.status === 404) return null;
      throw err;
    }
  }

  async listJobs (projectId, pipelineId, { includeRetried = false, signal = null } = {}) {
    const res = await this.call('GET', `/projects/${projectId}/pipelines/${pipelineId}/jobs`, {
      query: { include_retried: includeRetried ? 'true' : null, per_page: 100 },
      signal
    });
    // GitLab returns these newest-id-first; display order wants the reverse.
    return Array.isArray(res.body) ? res.body.slice().reverse() : [];
  }

  /**
   * A job's log.
   *
   * Two ways to avoid refetching a log that has not changed:
   *
   *   - GitLab 19.0 and later accept byte_offset, so we ask for just the new
   *     bytes. Older servers ignore unknown query parameters and quietly send
   *     the whole log instead, so we only use it once we have read /version.
   *   - Everything else gets If-None-Match with the last ETag. A 304 costs
   *     almost nothing, which is what makes a 3-second tail affordable.
   */
  async getJobLog (projectId, jobId, { offset = 0, etag = null, signal = null } = {}) {
    const supportsOffset = this.atLeast(19);
    const useOffset = supportsOffset && offset > 0;
    const headers = {};
    if (etag && !useOffset) headers['If-None-Match'] = etag;

    const token = await this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    headers.Accept = 'text/plain';

    let url = `${this.apiRoot}/projects/${projectId}/jobs/${jobId}/trace`;
    if (useOffset) url += `?byte_offset=${offset}`;

    const res = await request(url, { method: 'GET', headers, tls: this.connection.tls || {}, signal });
    this.lastRateLimit = res.rateLimit;

    if (res.status === 304) return { text: '', totalBytes: offset, etag, unchanged: true };
    if (res.status === 404) return { text: '', totalBytes: offset, etag: null, unchanged: true };
    if (res.status === 429) {
      throw new GitLabError('GitLab is rate limiting us. Backing off.', {
        status: 429, url, retryAfter: res.rateLimit.retryAfter || 60
      });
    }
    if (res.status !== 200) throw this.explain(res, 'GET', `/projects/${projectId}/jobs/${jobId}/trace`);

    const nextEtag = res.headers.etag || null;
    const buffer = res.raw;

    if (useOffset) {
      // The server honoured the offset, so this is purely new bytes.
      return { text: buffer.toString('utf8'), totalBytes: offset + buffer.length, etag: nextEtag, unchanged: buffer.length === 0 };
    }

    // Whole log. Slice off what we have already shown. Slicing on the Buffer
    // rather than the string matters: a multi-byte character split across the
    // boundary would otherwise come back as a replacement character.
    const text = buffer.slice(Math.min(offset, buffer.length)).toString('utf8');
    return { text, totalBytes: buffer.length, etag: nextEtag, unchanged: text.length === 0 };
  }

  // ---- pipelines: write -------------------------------------------------

  /**
   * Run a pipeline as the user.
   *
   * Not the trigger-token route: that runs as the token's owner, needs
   * Maintainer to set up, and produces source:"trigger" pipelines that some
   * rules: blocks deliberately skip.
   */
  async runPipeline (projectId, ref, { variables = [], inputs = null, signal = null } = {}) {
    const body = { ref };
    if (variables.length > 0) {
      body.variables = variables.map((v) => ({
        key: v.key,
        value: v.value,
        variable_type: v.variableType || 'env_var'
      }));
    }
    if (inputs && this.atLeast(18, 1)) body.inputs = inputs;
    const res = await this.call('POST', `/projects/${projectId}/pipeline`, { body, signal });
    return res.body;
  }

  async retryPipeline (projectId, pipelineId) {
    const res = await this.call('POST', `/projects/${projectId}/pipelines/${pipelineId}/retry`);
    return res.body;
  }

  /** Returns 200 whatever state the pipeline was in, so refetch rather than trusting it. */
  async cancelPipeline (projectId, pipelineId) {
    const res = await this.call('POST', `/projects/${projectId}/pipelines/${pipelineId}/cancel`);
    return res.body;
  }

  async playJob (projectId, jobId, { variables = [], inputs = null } = {}) {
    const body = {};
    if (variables.length > 0) {
      body.job_variables_attributes = variables.map((v) => ({ key: v.key, value: v.value }));
    }
    if (inputs && this.atLeast(18, 10)) body.job_inputs = inputs;
    const res = await this.call('POST', `/projects/${projectId}/jobs/${jobId}/play`, { body });
    return res.body;
  }

  async retryJob (projectId, jobId) {
    const res = await this.call('POST', `/projects/${projectId}/jobs/${jobId}/retry`);
    return res.body;
  }

  async cancelJob (projectId, jobId, { force = false } = {}) {
    const res = await this.call('POST', `/projects/${projectId}/jobs/${jobId}/cancel`, {
      query: force ? { force: 'true' } : null
    });
    return res.body;
  }

  // ---- schedules: the "toggle" -----------------------------------------

  async listSchedules (projectId, { signal = null } = {}) {
    const res = await this.call('GET', `/projects/${projectId}/pipeline_schedules`, {
      query: { per_page: 100 }, signal
    });
    return Array.isArray(res.body) ? res.body : [];
  }

  /**
   * Flip a schedule on or off. One boolean is the entire feature.
   *
   * Only the schedule's owner, a Maintainer or an Owner may do this. A
   * Developer who can run pipelines all day will still get a 403 on someone
   * else's schedule - the error message says so.
   */
  async setScheduleActive (projectId, scheduleId, active) {
    const res = await this.call('PUT', `/projects/${projectId}/pipeline_schedules/${scheduleId}`, {
      body: { active: Boolean(active) }
    });
    return res.body;
  }

  async runSchedule (projectId, scheduleId) {
    const res = await this.call('POST', `/projects/${projectId}/pipeline_schedules/${scheduleId}/play`, {
      expect: [200, 201, 202]
    });
    return res.body;
  }

  async takeScheduleOwnership (projectId, scheduleId) {
    const res = await this.call('POST', `/projects/${projectId}/pipeline_schedules/${scheduleId}/take_ownership`);
    return res.body;
  }

  // ---- CI lint ----------------------------------------------------------

  /**
   * Check a .gitlab-ci.yml. Works with a read-only token.
   *
   * A broken file still answers 200 - validity lives in body.valid, never in
   * the status code.
   */
  async lintCiConfig (projectId, content, { dryRun = false, ref = null } = {}) {
    const body = { content, dry_run: dryRun, include_jobs: true };
    if (dryRun && ref) body.ref = ref;
    const res = await this.call('POST', `/projects/${projectId}/ci/lint`, { body });
    return res.body;
  }

  // ---- GraphQL ----------------------------------------------------------

  /**
   * Pipeline plus its stages and jobs, in one request and in the right order,
   * with the flags that say which buttons are legal.
   * Falls back to null on any error so the caller can use the REST path -
   * an older self-hosted instance missing one field fails the whole query.
   */
  async pipelineDetail (fullPath, pipelineIid, { signal = null } = {}) {
    const query = `query PipelineDetail($fullPath: ID!, $iid: ID!) {
  project(fullPath: $fullPath) {
    pipeline(iid: $iid) {
      id iid status complete cancelable retryable
      duration queuedDuration startedAt finishedAt failureReason
      ref sha source path
      detailedStatus { label }
      user { username avatarUrl }
      stages { nodes { name status
        jobs { nodes {
          id name status allowFailure manualJob
          playable retryable cancelable
          duration startedAt finishedAt failureMessage webPath
          detailedStatus { label }
        } } } }
    }
  }
}`;
    try {
      const token = await this.getToken();
      const res = await request(this.graphqlUrl, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: { query, variables: { fullPath, iid: String(pipelineIid) } },
        tls: this.connection.tls || {},
        signal
      });
      this.lastRateLimit = res.rateLimit;
      if (res.status !== 200 || !res.body || res.body.errors) return null;
      const project = res.body.data && res.body.data.project;
      return normaliseDetail((project && project.pipeline) || null);
    } catch (err) {
      return null;
    }
  }
}

module.exports = { GitLabClient, GitLabError, ACCESS, isTerminal, messageFromBody, normaliseStatus, normaliseDetail };
