/**
 * The stage strip, in the status bar.
 *
 * The panel has a full one. This is the glanceable version: one dot per stage,
 * coloured by that stage's status, so you can see where a build is without
 * opening anything. Clicking a dot opens the panel at that stage.
 */

const { lookOf } = require('./pipelines-view');

// The status bar is shared with every other package, so the strip cannot grow
// without limit. Past this, the tail folds into a single dot carrying the
// worst status in it - a red dot for "something back there failed" is the part
// you must not lose; the stage names are still in its tooltip.
const MAX_DOTS = 6;

// Worst first. Anything unlisted sorts last.
const SEVERITY = ['failed', 'canceled', 'running', 'pending', 'manual', 'created', 'success', 'skipped'];

function severityOf (status) {
  const key = typeof status === 'string' ? status.toLowerCase() : '';
  const index = SEVERITY.indexOf(key);
  return index === -1 ? SEVERITY.length : index;
}

/** The status that should represent a folded group of stages. */
function worstStatus (stages) {
  let worst = null;
  for (const stage of stages) {
    if (worst === null || severityOf(stage.status) < severityOf(worst)) worst = stage.status;
  }
  return worst;
}

/**
 * Decide what dots to draw for a set of stages.
 *
 * Separated out and exported because the folding is the only part with rules
 * in it, and it is far easier to test as data than as DOM.
 *
 * @returns {Array<{name: string, status: string, title: string, folded: boolean}>}
 */
function dotsFor (stages) {
  const list = Array.isArray(stages) ? stages : [];
  if (list.length <= MAX_DOTS) {
    return list.map((stage) => ({
      name: stage.name,
      status: stage.status,
      title: `${stage.name} - ${lookOf(stage.status).label}`,
      folded: false
    }));
  }

  const shown = list.slice(0, MAX_DOTS - 1);
  const rest = list.slice(MAX_DOTS - 1);
  const dots = shown.map((stage) => ({
    name: stage.name,
    status: stage.status,
    title: `${stage.name} - ${lookOf(stage.status).label}`,
    folded: false
  }));

  const status = worstStatus(rest);
  dots.push({
    // Clicking the folded dot goes to the first stage inside it, which is the
    // nearest thing to "show me what is back there".
    name: rest[0].name,
    status,
    title: `${rest.length} more stages, worst is ${lookOf(status).label}: ` +
      rest.map((stage) => `${stage.name} (${lookOf(stage.status).label})`).join(', '),
    folded: true
  });
  return dots;
}

class StagesTile {
  constructor ({ onSelect }) {
    this.onSelect = onSelect;
    this.element = document.createElement('span');
    this.element.className = 'inline-block gitlab-pipelines-stages';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', 'Pipeline stages');

    this.dots = [];
    this.visible = true;
    this.setIdle();
  }

  setVisible (visible) {
    this.visible = visible !== false;
    this.element.style.display = this.visible ? '' : 'none';
  }

  /** Replace the dots wholesale. There are at most MAX_DOTS, so this is cheap. */
  render (specs) {
    while (this.element.firstChild) this.element.removeChild(this.element.firstChild);
    this.dots = specs.map((spec) => {
      const look = lookOf(spec.status);
      const dot = document.createElement('a');
      dot.href = '#';
      dot.className = `gl-sb-stage icon icon-${look.icon} ${look.klass}` +
        (spec.folded ? ' gl-sb-stage-folded' : '');
      dot.title = spec.title;
      dot.setAttribute('aria-label', spec.title);
      dot.addEventListener('click', (event) => {
        event.preventDefault();
        this.onSelect(spec.name);
      });
      this.element.appendChild(dot);
      return dot;
    });
  }

  /** Nothing running: one hollow dot, so the strip does not jump about. */
  setIdle () {
    this.element.classList.remove('gl-status-inactive');
    this.render([{ name: null, status: 'created', title: 'No pipeline running on this branch.', folded: false }]);
  }

  setInactive (reason) {
    this.element.classList.add('gl-status-inactive');
    this.render([{
      name: null,
      status: 'created',
      title: reason || 'No GitLab remote in this project.',
      folded: false
    }]);
  }

  setOffline (message) {
    this.element.classList.add('gl-status-inactive');
    this.render([{
      name: null,
      status: 'created',
      title: message || 'Cannot reach GitLab. Retrying.',
      folded: false
    }]);
  }

  setPipeline (detail) {
    const stages = (detail && detail.stages && detail.stages.nodes) || [];
    if (stages.length === 0) {
      this.setIdle();
      return;
    }
    this.element.classList.remove('gl-status-inactive');
    this.render(dotsFor(stages));
  }

  destroy () {
    if (this.element && this.element.parentNode) this.element.remove();
  }
}

module.exports = { StagesTile, dotsFor, worstStatus, MAX_DOTS };
