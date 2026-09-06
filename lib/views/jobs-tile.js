/**
 * The second status bar light: how far through the pipeline the jobs are.
 *
 * The pipeline light next to it answers "is it green". This one answers "how
 * much is left", which is the thing you actually watch while a build runs.
 */

const DONE = new Set(['success', 'failed', 'canceled', 'skipped']);

/**
 * Count the jobs in a pipeline detail.
 *
 * Kept separate from the drawing, and exported, because the counting is the
 * only part with rules in it - a failed job is finished as well as failed, and
 * manual jobs are waiting on a person so they are not finished at all.
 *
 * @param {object} detail - a pipeline detail, GraphQL or REST-shaped
 * @returns {{total: number, done: number, failed: number, running: number}}
 */
function countJobs (detail) {
  const stages = (detail && detail.stages && detail.stages.nodes) || [];
  const counts = { total: 0, done: 0, failed: 0, running: 0 };

  for (const stage of stages) {
    for (const job of (stage.jobs && stage.jobs.nodes) || []) {
      counts.total += 1;
      // Upper case over GraphQL, lower over REST. Same belt as lookOf().
      const status = typeof job.status === 'string' ? job.status.toLowerCase() : '';
      if (status === 'failed') {
        counts.failed += 1;
        counts.done += 1;
      } else if (DONE.has(status)) {
        counts.done += 1;
      } else if (status === 'running') {
        counts.running += 1;
      }
    }
  }
  return counts;
}

/** How the tile should look for a given set of counts. */
function lookOfCounts ({ total, done, failed, running }) {
  if (failed > 0) return { icon: 'x', klass: 'text-error' };
  if (running > 0) return { icon: 'sync', klass: 'text-info' };
  if (total > 0 && done === total) return { icon: 'check', klass: 'text-success' };
  return { icon: 'checklist', klass: 'text-subtle' };
}

class JobsTile {
  constructor ({ onClick }) {
    this.element = document.createElement('a');
    this.element.className = 'inline-block gitlab-pipelines-jobs';
    this.element.href = '#';

    this.iconEl = document.createElement('span');
    this.textEl = document.createElement('span');
    this.textEl.className = 'gl-jobs-text';
    this.element.appendChild(this.iconEl);
    this.element.appendChild(this.textEl);

    this.element.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });

    // Same rule as the pipeline light: the user setting is the only thing that
    // ever writes display, so a repaint cannot resurrect a tile switched off.
    this.visible = true;
    this.setIdle();
  }

  setVisible (visible) {
    this.visible = visible !== false;
    this.element.style.display = this.visible ? '' : 'none';
  }

  paint ({ icon, klass = '', text, title, inactive = false }) {
    this.iconEl.className = `icon icon-${icon}${klass ? ' ' + klass : ''}${inactive ? ' text-subtle' : ''}`;
    this.textEl.textContent = text;
    this.element.title = title;
    this.element.classList.toggle('gl-status-inactive', inactive);
  }

  setIdle () {
    this.paint({
      icon: 'checklist',
      text: ' no jobs',
      title: 'No pipeline running on this branch.'
    });
  }

  setInactive (reason) {
    this.paint({
      icon: 'checklist',
      text: ' jobs',
      title: reason || 'No GitLab remote in this project.',
      inactive: true
    });
  }

  setOffline (message) {
    this.paint({
      icon: 'alignment-unalign',
      text: ' jobs',
      title: message || 'Cannot reach GitLab. Retrying.',
      inactive: true
    });
  }

  /** @param {object} detail - the pipeline detail, or null for "nothing running" */
  setPipeline (detail) {
    const counts = countJobs(detail);
    if (counts.total === 0) {
      this.setIdle();
      return;
    }

    const look = lookOfCounts(counts);
    const failedPart = counts.failed > 0 ? `, ${counts.failed} failed` : '';
    const runningPart = counts.running > 0 ? `, ${counts.running} running` : '';

    this.paint({
      icon: look.icon,
      klass: look.klass,
      text: ` ${counts.done}/${counts.total} jobs${failedPart}`,
      title: `${counts.done} of ${counts.total} jobs finished${failedPart}${runningPart}. Click to open.`
    });
  }

  destroy () {
    if (this.element && this.element.parentNode) this.element.remove();
  }
}

module.exports = { JobsTile, countJobs, lookOfCounts };
