/**
 * The status bar light.
 *
 * One line, always visible, telling you whether the branch you are on is
 * green. Clicking it opens the panel. This is the part people actually use all
 * day - the panel is for when something went wrong.
 */

const { lookOf } = require('./pipelines-view');

class StatusTile {
  constructor ({ onClick }) {
    this.element = document.createElement('a');
    this.element.className = 'inline-block gitlab-pipelines-status';
    this.element.href = '#';

    this.iconEl = document.createElement('span');
    this.textEl = document.createElement('span');
    this.textEl.className = 'gl-status-text';
    this.element.appendChild(this.iconEl);
    this.element.appendChild(this.textEl);

    this.element.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });

    this.setIdle();
  }

  setIdle () {
    this.iconEl.className = 'icon icon-git-branch';
    this.textEl.textContent = ' GitLab';
    this.element.title = 'GitLab Pipelines - click to open';
    this.element.style.display = '';
  }

  setHidden () {
    this.element.style.display = 'none';
  }

  setOffline (message) {
    this.iconEl.className = 'icon icon-alignment-unalign text-subtle';
    this.textEl.textContent = ' GitLab offline';
    this.element.title = message || 'Cannot reach GitLab. Retrying.';
    this.element.style.display = '';
  }

  /**
   * @param {object} pipeline - anything with .status, .iid and optionally .ref
   * @param {string} [suffix] - e.g. "3/8 jobs"
   */
  setPipeline (pipeline, suffix = null) {
    this.element.style.display = '';
    if (!pipeline) {
      this.setIdle();
      return;
    }
    const look = lookOf(pipeline.status);
    this.iconEl.className = `icon icon-${look.icon} ${look.klass}`;
    const iid = pipeline.iid || pipeline.id;
    this.textEl.textContent = suffix ? ` #${iid} ${suffix}` : ` #${iid} ${look.label}`;
    this.element.title = `Pipeline #${iid} on ${pipeline.ref || 'this branch'} - ${look.label}. Click to open.`;
  }

  destroy () {
    if (this.element && this.element.parentNode) this.element.remove();
  }
}

module.exports = { StatusTile };
