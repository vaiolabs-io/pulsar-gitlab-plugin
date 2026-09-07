/**
 * A job's log, in the centre pane.
 *
 * Not a TextEditor. An editor cannot render ANSI colour, cannot fold GitLab's
 * section markers, and cannot live anywhere but the centre anyway. Our own DOM
 * does all three.
 *
 * The tail loop is deliberately conservative: it only runs while this tab is
 * open and the job is unfinished, and it stops itself the moment the job
 * reaches a final status. A forgotten 3-second log tail is the easiest way to
 * burn a rate limit budget.
 */

const { Emitter } = require('atom');
const { StringDecoder } = require('string_decoder');
const { renderLine, parseLines, stripAnsi, emptyStyle, hasTimestampPrefix } = require('../ansi');
const { Poller } = require('../poller');

const LOG_URI_PREFIX = 'gitlab-pipelines://job/';
const TAIL_INTERVAL_MS = 3000;
const MAX_RENDERED_LINES = 50000;

function logUriFor (connectionId, projectId, jobId) {
  return `${LOG_URI_PREFIX}${connectionId}/${projectId}/${jobId}`;
}

function parseLogUri (uri) {
  if (!uri || !uri.startsWith(LOG_URI_PREFIX)) return null;
  const [connectionId, projectId, jobId] = uri.slice(LOG_URI_PREFIX.length).split('/');
  if (!connectionId || !projectId || !jobId) return null;
  return { connectionId, projectId: Number(projectId) || projectId, jobId: Number(jobId) || jobId };
}

function el (tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

class JobLogView {
  /**
   * @param {object} options
   * @param {object} options.client - a GitLabClient
   * @param {number} options.projectId
   * @param {object} options.job - {id, name, status, ...}
   * @param {string} options.connectionId
   */
  constructor ({ client, projectId, job, connectionId, baseUrl = null }) {
    this.client = client;
    this.projectId = projectId;
    this.job = job;
    this.connectionId = connectionId;
    this.baseUrl = baseUrl;
    this.emitter = new Emitter();

    this.bytesSeen = 0;
    this.etag = null;
    this.rawText = '';
    this.style = emptyStyle();
    this.lineCount = 0;
    this.follow = true;
    this.openSection = null;

    // Whether this job's log carries timestamps is settled by the first line
    // and holds for the whole log, so it is decided once and remembered - the
    // second chunk of a tail has no first line to look at.
    this.hasTimestamps = null;

    // A chunk ends wherever the byte count landed, which is usually the middle
    // of a line. Hold that tail back until the rest of it arrives, or a long
    // line gets rendered as two.
    this.pending = '';

    // Decodes bytes to text across polls, so a character split between two
    // chunks survives instead of turning into a replacement character.
    this.decoder = new StringDecoder('utf8');

    this.build();
    this.startTail();
  }

  // ---- workspace item contract -----------------------------------------

  getTitle () { return `${this.job.name} · log`; }
  getLongTitle () { return `GitLab job ${this.job.name} (#${this.job.id})`; }
  getURI () { return logUriFor(this.connectionId, this.projectId, this.job.id); }
  getIconName () { return 'terminal'; }
  getDefaultLocation () { return 'center'; }
  getAllowedLocations () { return ['center']; }
  getElement () { return this.element; }
  isPermanentDockItem () { return false; }

  serialize () { return null; }

  destroy () {
    this.stopTail();
    this.emitter.dispose();
    if (this.element && this.element.parentNode) this.element.remove();
  }

  onDidDestroy (callback) { return this.emitter.on('did-destroy', callback); }

  // ---- construction -----------------------------------------------------

  build () {
    this.element = el('div', 'gitlab-job-log');

    const toolbar = el('div', 'gl-log-toolbar');
    this.statusEl = el('span', 'gl-log-status');
    toolbar.appendChild(this.statusEl);

    const spacer = el('span', 'gl-log-spacer');
    toolbar.appendChild(spacer);

    this.followButton = el('button', 'btn btn-sm icon icon-arrow-down', ' Follow');
    this.followButton.title = 'Keep scrolling to the newest output';
    this.followButton.addEventListener('click', () => {
      this.follow = !this.follow;
      this.updateFollowButton();
      if (this.follow) this.scrollToBottom();
    });
    toolbar.appendChild(this.followButton);

    const copyButton = el('button', 'btn btn-sm icon icon-clippy', ' Copy');
    copyButton.title = 'Copy the whole log, without the colour codes';
    copyButton.addEventListener('click', () => {
      atom.clipboard.write(stripAnsi(this.rawText));
      atom.notifications.addSuccess('Job log copied.');
    });
    toolbar.appendChild(copyButton);

    const saveButton = el('button', 'btn btn-sm icon icon-desktop-download', ' Save');
    saveButton.title = 'Save the raw log to a file';
    saveButton.addEventListener('click', () => this.saveRaw());
    toolbar.appendChild(saveButton);

    this.element.appendChild(toolbar);

    this.outputEl = el('pre', 'gl-log-output');
    this.outputEl.addEventListener('scroll', () => {
      // Turn following off as soon as the user scrolls up, and back on when
      // they return to the bottom. Fighting the user's scroll is the single
      // most annoying thing a log viewer can do.
      const atBottom = this.outputEl.scrollTop + this.outputEl.clientHeight >= this.outputEl.scrollHeight - 24;
      if (this.follow !== atBottom) {
        this.follow = atBottom;
        this.updateFollowButton();
      }
    });
    this.element.appendChild(this.outputEl);

    this.updateFollowButton();
    this.setStatus(this.job.status);
  }

  updateFollowButton () {
    this.followButton.className = `btn btn-sm icon icon-arrow-down${this.follow ? ' selected' : ''}`;
  }

  setStatus (status) {
    this.job.status = status;
    this.statusEl.textContent = `${this.job.name} — ${status}`;
    this.statusEl.className = `gl-log-status gl-log-status-${status}`;
  }

  // ---- the tail ---------------------------------------------------------

  startTail () {
    // requireFocus is false here: the user opened this tab to watch it, and a
    // log that freezes the moment you alt-tab to read the code is useless.
    this.poller = new Poller({
      intervalMs: TAIL_INTERVAL_MS,
      baseUrl: this.baseUrl,
      requireFocus: false,
      task: () => this.fetchMore(),
      onError: (err) => this.showError(err)
    });
    this.poller.start();
  }

  stopTail () {
    if (this.poller) {
      this.poller.dispose();
      this.poller = null;
    }
  }

  async fetchMore () {
    const result = await this.client.getJobLog(this.projectId, this.job.id, {
      offset: this.bytesSeen,
      etag: this.etag,
      decoder: this.decoder
    });
    this.etag = result.etag || this.etag;

    if (result.text.length > 0) {
      this.append(result.text);
      this.bytesSeen = result.totalBytes;
    } else if (result.totalBytes > this.bytesSeen) {
      this.bytesSeen = result.totalBytes;
    }

    // Nothing new? Check once whether the job is done, and if it is, stop.
    // That one extra call is what keeps a finished job from being polled
    // forever at three-second intervals.
    if (result.unchanged) {
      const job = await this.client.call('GET', `/projects/${this.projectId}/jobs/${this.job.id}`);
      const status = job.body && job.body.status;
      if (status) this.setStatus(status);
      const finished = ['success', 'failed', 'canceled', 'skipped', 'manual'].includes(status);
      if (finished) {
        this.stopTail();
        // No more polls are coming, so any half-line still held back is the
        // end of the log rather than a fragment. Show it.
        if (this.pending !== '') this.append('', { final: true });
        this.statusEl.textContent = `${this.job.name} — ${status} (log complete)`;
      }
    }
  }

  showError (err) {
    const line = el('div', 'gl-log-line gl-log-error', `[gitlab-pipelines] ${err.message}`);
    this.outputEl.appendChild(line);
    if (this.follow) this.scrollToBottom();
  }

  /**
   * Append new text, rendering colour and folding sections.
   * Only the new chunk is parsed and appended - re-rendering the whole log
   * every three seconds would be quadratic and would flicker.
   */
  append (chunk, { final = false } = {}) {
    this.rawText += chunk;

    const text = this.pending + chunk;
    if (this.hasTimestamps === null) this.hasTimestamps = hasTimestampPrefix(text);

    // Everything up to the last newline is complete; the remainder waits for
    // the next poll. When the log is finished there is no next poll, so the
    // remainder is all there is going to be and has to be flushed.
    let body = text;
    if (!final) {
      const cut = text.lastIndexOf('\n');
      if (cut === -1) { this.pending = text; return; }
      body = text.slice(0, cut);
      this.pending = text.slice(cut + 1);
    } else {
      this.pending = '';
    }

    const fragment = document.createDocumentFragment();

    for (const item of parseLines(body, { timestamps: this.hasTimestamps })) {
      if (item.type === 'section-start') {
        const section = el('details', 'gl-log-section');
        // GitLab marks the noisy ones [collapsed=true]; honour that, so the
        // log opens on the part the user came to read.
        section.open = !item.collapsed;
        const summary = el('summary', 'gl-log-section-summary', item.text || item.name);
        section.appendChild(summary);
        const body = el('div', 'gl-log-section-body');
        section.appendChild(body);
        fragment.appendChild(section);
        this.openSection = body;
        continue;
      }
      if (item.type === 'section-end') {
        this.openSection = null;
        continue;
      }

      const rendered = renderLine(item.text, this.style);
      this.style = rendered.style;
      const lineEl = el('div', 'gl-log-line');
      lineEl.appendChild(rendered.node);
      if (this.openSection) this.openSection.appendChild(lineEl);
      else fragment.appendChild(lineEl);
      this.lineCount += 1;
    }

    this.outputEl.appendChild(fragment);
    this.trimIfHuge();
    if (this.follow) this.scrollToBottom();
  }

  /** How many log lines a node accounts for - a section holds many. */
  renderedLinesIn (node) {
    if (!node || !node.classList) return 1;
    if (node.classList.contains('gl-log-line')) return 1;
    if (!node.querySelectorAll) return 1;
    return Math.max(1, node.querySelectorAll('.gl-log-line').length);
  }

  /**
   * A job log can legally reach 100 MB. Past a certain point the DOM is the
   * bottleneck, not the network, so drop the oldest lines and say so. The full
   * text is still in memory for Copy and Save.
   */
  trimIfHuge () {
    if (this.lineCount <= MAX_RENDERED_LINES) return;
    const excess = this.lineCount - MAX_RENDERED_LINES;
    let removed = 0;
    while (removed < excess && this.outputEl.firstChild) {
      const first = this.outputEl.firstChild;
      let victim = first;
      if (first.classList && first.classList.contains('gl-log-truncated')) {
        if (!this.outputEl.children[1]) break;
        victim = this.outputEl.children[1];
      }
      // A section is one child holding many lines. Counting it as one removal
      // let lineCount drift upwards until the loop started eating the log far
      // faster than it should.
      removed += this.renderedLinesIn(victim);
      // If the section we are still appending into is the thing being removed,
      // let go of it. Appending to a detached node loses the lines silently,
      // which is the worst way for a log viewer to fail.
      if (this.openSection && victim.contains(this.openSection)) this.openSection = null;
      victim.remove();
    }
    this.lineCount -= removed;
    if (!this.outputEl.querySelector('.gl-log-truncated')) {
      const notice = el('div', 'gl-log-line gl-log-truncated',
        'Earlier output trimmed to keep the editor responsive. Use Save to get the whole log.');
      this.outputEl.insertBefore(notice, this.outputEl.firstChild);
    }
  }

  scrollToBottom () {
    this.outputEl.scrollTop = this.outputEl.scrollHeight;
  }

  async saveRaw () {
    const suggested = `gitlab-job-${this.job.id}.log`;
    const { filePath, canceled } = await atom.applicationDelegate.showSaveDialog({ defaultPath: suggested });
    if (canceled || !filePath) return;
    try {
      require('fs').writeFileSync(filePath, this.rawText, 'utf8');
      atom.notifications.addSuccess(`Saved to ${filePath}`);
    } catch (err) {
      atom.notifications.addError('Could not save the log.', { detail: err.message });
    }
  }
}

module.exports = { JobLogView, logUriFor, parseLogUri, LOG_URI_PREFIX, MAX_RENDERED_LINES };
