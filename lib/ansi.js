/**
 * Job logs come back as raw terminal output. Two things have to be decoded
 * before a person can read them:
 *
 *   - ANSI colour codes, so a red FAILED line is red instead of "[31m".
 *   - GitLab's own section markers, which are how the web UI gets collapsible
 *     "Preparing the runner" blocks.
 *
 * The old gitlab-manager package skipped both and told users to install a
 * separate syntax package. We do it here.
 */

// The escape character itself, built rather than typed, so this file stays
// plain printable ASCII and survives copy-paste, diffs and editors intact.
const ESC = String.fromCharCode(27);

// section_start:1699999999:prepare_script\r<ESC>[0KPreparing environment
const SECTION_RE = new RegExp('^section_(start|end):(\\d+):([^\\r\\n' + ESC + ']+)');
const SGR_RE = new RegExp(ESC + '\\[([0-9;]*)m', 'g');
const OTHER_ESCAPES = new RegExp(ESC + '\\[[0-9;?]*[A-HJKSTfhlnsu]', 'g');
const ALL_ESCAPES = new RegExp(ESC + '\\[[0-9;?]*[A-HJKSTfhlmnsu]', 'g');
const CLEAR_LINE = new RegExp(ESC + '\\[0K', 'g');

const BASIC_COLOURS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'
];

function emptyStyle () {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

/** Apply one SGR parameter list to a style, returning a new style. */
function applySgr (style, params) {
  const next = Object.assign({}, style);
  const codes = params === '' ? [0] : params.split(';').map(Number);

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) { Object.assign(next, emptyStyle()); continue; }
    if (code === 1) { next.bold = true; continue; }
    if (code === 2) { next.dim = true; continue; }
    if (code === 3) { next.italic = true; continue; }
    if (code === 4) { next.underline = true; continue; }
    if (code === 7) { next.inverse = true; continue; }
    if (code === 22) { next.bold = false; next.dim = false; continue; }
    if (code === 23) { next.italic = false; continue; }
    if (code === 24) { next.underline = false; continue; }
    if (code === 27) { next.inverse = false; continue; }
    if (code >= 30 && code <= 37) { next.fg = BASIC_COLOURS[code - 30]; continue; }
    if (code === 39) { next.fg = null; continue; }
    if (code >= 40 && code <= 47) { next.bg = BASIC_COLOURS[code - 40]; continue; }
    if (code === 49) { next.bg = null; continue; }
    if (code >= 90 && code <= 97) { next.fg = `bright-${BASIC_COLOURS[code - 90]}`; continue; }
    if (code >= 100 && code <= 107) { next.bg = `bright-${BASIC_COLOURS[code - 100]}`; continue; }
    // 256-colour and truecolour: 38;5;n and 38;2;r;g;b (48;... for background)
    if (code === 38 || code === 48) {
      const target = code === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5) { next[target] = `x${codes[i + 2]}`; i += 2; continue; }
      if (codes[i + 1] === 2) { next[target] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; continue; }
    }
  }
  return next;
}

function styleToClasses (style) {
  const classes = [];
  const fg = style.inverse ? style.bg : style.fg;
  const bg = style.inverse ? style.fg : style.bg;
  if (fg && !fg.startsWith('rgb(') && !fg.startsWith('x')) classes.push(`ansi-fg-${fg}`);
  if (bg && !bg.startsWith('rgb(') && !bg.startsWith('x')) classes.push(`ansi-bg-${bg}`);
  if (style.bold) classes.push('ansi-bold');
  if (style.dim) classes.push('ansi-dim');
  if (style.italic) classes.push('ansi-italic');
  if (style.underline) classes.push('ansi-underline');
  return classes;
}

function styleToInline (style) {
  const fg = style.inverse ? style.bg : style.fg;
  const bg = style.inverse ? style.fg : style.bg;
  const parts = [];
  if (fg && fg.startsWith('rgb(')) parts.push(`color:${fg}`);
  if (bg && bg.startsWith('rgb(')) parts.push(`background-color:${bg}`);
  return parts.join(';');
}

/**
 * Turn one line of log text into DOM nodes, carrying the colour state in and
 * out so a colour that spans several lines keeps working.
 *
 * Building nodes rather than an HTML string is deliberate. Log text is whatever
 * a build printed, which means it is untrusted; textContent cannot be talked
 * into executing anything, innerHTML can.
 *
 * @returns {{node: DocumentFragment, style: object}}
 */
function renderLine (line, styleIn = emptyStyle()) {
  const fragment = document.createDocumentFragment();
  let style = styleIn;
  let lastIndex = 0;

  const push = (text) => {
    if (text === '') return;
    const clean = text.replace(OTHER_ESCAPES, '').replace(/\r/g, '');
    if (clean === '') return;
    const classes = styleToClasses(style);
    const inline = styleToInline(style);
    if (classes.length === 0 && inline === '') {
      fragment.appendChild(document.createTextNode(clean));
      return;
    }
    const span = document.createElement('span');
    if (classes.length > 0) span.className = classes.join(' ');
    if (inline !== '') span.setAttribute('style', inline);
    span.textContent = clean;
    fragment.appendChild(span);
  };

  SGR_RE.lastIndex = 0;
  let match;
  while ((match = SGR_RE.exec(line)) !== null) {
    push(line.slice(lastIndex, match.index));
    style = applySgr(style, match[1]);
    lastIndex = SGR_RE.lastIndex;
  }
  push(line.slice(lastIndex));

  return { node: fragment, style };
}

/**
 * Split raw log text into lines, pulling GitLab's section markers out into
 * structure rather than leaving them as noise in the text.
 *
 * @returns {Array<{type, text, name?, at?}>} type is 'line', 'section-start'
 *          or 'section-end'.
 */
function parseLines (text) {
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    // The marker sits in front of a \r + clear-line escape. Strip that first
    // so the regex can see the marker at the start of the line.
    const probe = rawLine.replace(CLEAR_LINE, '');
    const match = probe.match(SECTION_RE);
    if (match) {
      const [, kind, timestamp, name] = match;
      const remainder = probe.slice(match[0].length).replace(/^\r/, '');
      out.push({
        type: kind === 'start' ? 'section-start' : 'section-end',
        name,
        at: Number(timestamp),
        text: remainder
      });
      continue;
    }
    out.push({ type: 'line', text: rawLine });
  }
  return out;
}

/** Strip every escape sequence and marker. Used for "save raw log" and search. */
function stripAnsi (text) {
  return String(text)
    .replace(ALL_ESCAPES, '')
    .replace(/^section_(start|end):\d+:[^\r\n]*\r?/gm, '')
    .replace(/\r/g, '');
}

module.exports = { renderLine, parseLines, stripAnsi, emptyStyle, applySgr, styleToClasses };
