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

/**
 * A section marker, matching GitLab's own rule rather than an approximation of
 * it (lib/gitlab/regex.rb, build_trace_section_regex).
 *
 *   <ESC>[0Ksection_start:1699999999:prepare_script\r<ESC>[0KPreparing environment
 *
 * Three details that a looser regex gets wrong:
 *   - The trailing \r<ESC>[0K is mandatory. Without it GitLab treats the line
 *     as ordinary output, so a build that merely echoes "section_start:1:foo"
 *     must not fold the rest of the log into a section.
 *   - The name is restricted to letters, digits, _ . and -.
 *   - An option list may follow the name, which is where [collapsed=true]
 *     lives - that is how a section arrives already folded shut.
 */
const SECTION_RE = new RegExp(
  '^(?:' + ESC + '\\[0K)?' +
  'section_((?:start)|(?:end)):(\\d+):([a-zA-Z0-9_.-]+)' +
  '(?:\\[((?:\\w+=\\w+)(?:, ?\\w+=\\w+)*)\\])?' +
  '\\r' + ESC + '\\[0K'
);

/**
 * Since GitLab Runner 18.7 the FF_TIMESTAMPS feature flag is on by default, so
 * every line of a modern job log arrives behind a fixed 32-byte header:
 *
 *   2024-05-14T11:19:20.000000Z 00O+Hey there!
 *   |------- 27 chars -------| |^^^^|
 *
 * That is a 27-character UTC timestamp, a space, a two-hex-digit stream
 * number, E or O for stderr or stdout, and finally '+' if this line is the
 * continuation of the one before it or a space if it is not.
 *
 * It sits in front of everything, including section markers, which is why it
 * has to come off before anything else is looked at.
 * See lib/gitlab/ci/trace/stream.rb and lib/gitlab/ci/ansi2json/converter.rb.
 */
const TIMESTAMP_HEADER_LENGTH = 32;
const TIMESTAMP_DATETIME_LENGTH = 27;

/**
 * Is this line carrying a timestamp header?
 *
 * A positional check rather than a regex, which is what GitLab does too: this
 * runs once per line on logs that are allowed to reach 100 MB, and that is the
 * wrong place for a regular expression.
 */
function hasTimestampPrefix (line) {
  return typeof line === 'string' &&
    line.length >= TIMESTAMP_HEADER_LENGTH &&
    line[4] === '-' && line[7] === '-' && line[10] === 'T' &&
    line[13] === ':' && line[16] === ':' && line[26] === 'Z' &&
    (line[30] === 'E' || line[30] === 'O');
}

/** The '+' in the header says this line is the rest of the previous one. */
function isContinuation (line) {
  return hasTimestampPrefix(line) && line[31] === '+';
}

const SGR_RE = new RegExp(ESC + '\\[([0-9;]*)m', 'g');
const OTHER_ESCAPES = new RegExp(ESC + '\\[[0-9;?]*[A-HJKSTfhlnsu]', 'g');
const ALL_ESCAPES = new RegExp(ESC + '\\[[0-9;?]*[A-HJKSTfhlmnsu]', 'g');

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
function parseLines (text, options = {}) {
  const lines = String(text).split('\n');

  // Whether a log carries timestamps is decided once, when the job runs, so it
  // is the same for every line. GitLab sniffs the first line and commits to
  // the answer; do the same, and let the caller pass it in for the second and
  // later chunks of a tail, where line one is long gone.
  const timestamps = options.timestamps === undefined
    ? hasTimestampPrefix(lines[0])
    : Boolean(options.timestamps);

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    let at = null;

    if (timestamps && hasTimestampPrefix(raw)) {
      at = raw.slice(0, TIMESTAMP_DATETIME_LENGTH);
      raw = raw.slice(TIMESTAMP_HEADER_LENGTH);
      // Glue continuations back on. The runner splits a long line into
      // several, and without this a 300-character error message is shown as
      // four unrelated ones.
      while (i + 1 < lines.length && isContinuation(lines[i + 1])) {
        raw += lines[i + 1].slice(TIMESTAMP_HEADER_LENGTH);
        i += 1;
      }
    }

    const match = raw.match(SECTION_RE);
    if (match) {
      const [, kind, marked, name, opts] = match;
      out.push({
        type: kind === 'start' ? 'section-start' : 'section-end',
        name,
        at: Number(marked),
        collapsed: /\bcollapsed=true\b/.test(opts || ''),
        timestamp: at,
        text: raw.slice(match[0].length)
      });
      continue;
    }
    out.push({ type: 'line', text: raw, timestamp: at });
  }
  return out;
}

/**
 * Strip every escape sequence, timestamp header and marker. Used for "save raw
 * log", for copying to the clipboard and for search - all places where the
 * user wants the text a person would read, not the bytes the runner sent.
 */
function stripAnsi (text) {
  const lines = String(text).split('\n');
  const timestamps = hasTimestampPrefix(lines[0]);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (timestamps && hasTimestampPrefix(line)) {
      line = line.slice(TIMESTAMP_HEADER_LENGTH);
      while (i + 1 < lines.length && isContinuation(lines[i + 1])) {
        line += lines[i + 1].slice(TIMESTAMP_HEADER_LENGTH);
        i += 1;
      }
    }
    out.push(line);
  }

  return out.join('\n')
    // Markers first, while the mandatory \r + clear-line suffix that tells a
    // real marker from a build echoing the same text is still there.
    .replace(new RegExp(
      'section_(?:start|end):\\d+:[a-zA-Z0-9_.-]+' +
      '(?:\\[(?:\\w+=\\w+)(?:, ?\\w+=\\w+)*\\])?' +
      '\\r' + ESC + '\\[0K', 'g'), '')
    .replace(ALL_ESCAPES, '')
    .replace(/\r/g, '');
}

module.exports = {
  renderLine,
  parseLines,
  stripAnsi,
  hasTimestampPrefix,
  emptyStyle,
  applySgr,
  styleToClasses,
  TIMESTAMP_HEADER_LENGTH
};
