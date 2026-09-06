/**
 * The status bar light.
 *
 * One line, always visible, telling you whether the branch you are on is
 * green. Clicking it opens the panel. This is the part people actually use all
 * day - the panel is for when something went wrong.
 */

const { lookOf } = require('./pipelines-view');
const { gitlabLogo } = require('./gitlab-logo');

class StatusTile {
  constructor ({ onClick }) {
    this.element = document.createElement('a');
    this.element.className = 'inline-block gitlab-pipelines-status';
    this.element.href = '#';

    // Brand mark first, then the state. The logo says which package these
    // tiles belong to - with three of them in the bar that was not obvious.
    this.logoEl = gitlabLogo();
    this.iconEl = document.createElement('span');
    this.textEl = document.createElement('span');
    this.textEl.className = 'gl-status-text';
    this.element.appendChild(this.logoEl);
    this.element.appendChild(this.iconEl);
    this.element.appendChild(this.textEl);

    this.element.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });

    // Whether the user wants the tile at all. This is the only thing that
    // decides display, so a repaint can never resurrect a tile they turned
    // off - which is exactly what used to happen: every setter wrote
    // `display = ''`, so the next poll undid the setting.
    this.visible = true;
    this.setIdle();
  }

  /** The user setting. The single source of truth for whether we are on screen. */
  setVisible (visible) {
    this.visible = visible !== false;
    this.element.style.display = this.visible ? '' : 'none';
  }

  /** Paint a state. Deliberately does not touch display - see setVisible. */
  paint ({ icon, text, title, inactive = false }) {
    this.iconEl.className = `icon icon-${icon}${inactive ? ' text-subtle' : ''}`;
    this.textEl.textContent = text;
    this.element.title = title;
    this.element.classList.toggle('gl-status-inactive', inactive);
  }

  setIdle () {
    this.paint({
      icon: 'git-branch',
      text: ' GitLab',
      title: 'GitLab Pipelines - click to open'
    });
  }

  /**
   * Nothing to report: no GitLab remote here, or no connection for it yet.
   *
   * This used to hide the tile outright, which made "there is no GitLab
   * project in this window" look identical to "the package is broken". It
   * stays on screen, subdued, and says which of the two it is. Still
   * clickable, because the panel is where you add the missing connection.
   */
  setInactive (reason) {
    this.paint({
      icon: 'git-branch',
      text: ' GitLab',
      title: reason || 'No GitLab remote in this project.',
      inactive: true
    });
  }

  setOffline (message) {
    this.paint({
      icon: 'alignment-unalign',
      text: ' GitLab offline',
      title: message || 'Cannot reach GitLab. Retrying.',
      inactive: true
    });
  }

  /**
   * @param {object} pipeline - anything with .status, .iid and optionally .ref
   * @param {string} [suffix] - e.g. "3/8 jobs"
   */
  setPipeline (pipeline, suffix = null) {
    if (!pipeline) {
      this.setIdle();
      return;
    }
    const look = lookOf(pipeline.status);
    const iid = pipeline.iid || pipeline.id;
    this.paint({
      icon: look.icon,
      text: suffix ? ` #${iid} ${suffix}` : ` #${iid} ${look.label}`,
      title: `Pipeline #${iid} on ${pipeline.ref || 'this branch'} - ${look.label}. Click to open.`
    });
    // The status colour is the point of the tile, so it goes on after paint.
    this.iconEl.className = `icon icon-${look.icon} ${look.klass}`;
  }

  destroy () {
    if (this.element && this.element.parentNode) this.element.remove();
  }
}

module.exports = { StatusTile };
