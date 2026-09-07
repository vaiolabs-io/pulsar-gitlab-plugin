const { parseLines, stripAnsi, applySgr, styleToClasses, emptyStyle, renderLine } = require('../lib/ansi');

const ESC = String.fromCharCode(27);

describe('job log decoding', () => {
  describe('section markers', () => {
    it('pulls a section start out of the text', () => {
      const line = `section_start:1699999999:prepare${'\r'}${ESC}[0KPreparing the runner`;
      const [item] = parseLines(line);
      expect(item.type).toBe('section-start');
      expect(item.name).toBe('prepare');
      expect(item.at).toBe(1699999999);
      expect(item.text).toBe('Preparing the runner');
    });

    it('pulls a section end out of the text', () => {
      const [item] = parseLines(`section_end:1699999999:prepare${'\r'}${ESC}[0K`);
      expect(item.type).toBe('section-end');
      expect(item.name).toBe('prepare');
    });

    it('leaves ordinary lines alone', () => {
      const [item] = parseLines('npm install');
      expect(item.type).toBe('line');
      expect(item.text).toBe('npm install');
    });
  });

  describe('colour codes', () => {
    it('maps the basic foreground colours', () => {
      let style = applySgr(emptyStyle(), '31');
      expect(styleToClasses(style)).toContain('ansi-fg-red');
      style = applySgr(style, '32');
      expect(styleToClasses(style)).toContain('ansi-fg-green');
    });

    it('handles several codes in one escape', () => {
      const style = applySgr(emptyStyle(), '1;4;31');
      expect(styleToClasses(style).sort()).toEqual(['ansi-bold', 'ansi-fg-red', 'ansi-underline']);
    });

    it('resets everything on code 0', () => {
      const style = applySgr(applySgr(emptyStyle(), '1;31'), '0');
      expect(styleToClasses(style)).toEqual([]);
    });

    it('reads a truecolour foreground', () => {
      const style = applySgr(emptyStyle(), '38;2;255;128;0');
      expect(style.fg).toBe('rgb(255,128,0)');
    });

    it('turns bold off with 22 without losing the colour', () => {
      const style = applySgr(applySgr(emptyStyle(), '1;31'), '22');
      expect(style.bold).toBe(false);
      expect(style.fg).toBe('red');
    });
  });

  describe('rendering to DOM', () => {
    it('splits a line into coloured spans', () => {
      const { node } = renderLine(`${ESC}[32mOK${ESC}[0m done`);
      const host = document.createElement('div');
      host.appendChild(node);
      expect(host.querySelector('.ansi-fg-green').textContent).toBe('OK');
      expect(host.textContent).toBe('OK done');
    });

    it('carries the colour across a line boundary', () => {
      const first = renderLine(`${ESC}[31mstart of red`);
      expect(first.style.fg).toBe('red');
      const second = renderLine('still red', first.style);
      const host = document.createElement('div');
      host.appendChild(second.node);
      expect(host.querySelector('.ansi-fg-red').textContent).toBe('still red');
    });

    it('never produces executable markup from log text', () => {
      // Log text is whatever a build printed. It must land as text, not HTML.
      const { node } = renderLine('<img src=x onerror=alert(1)>');
      const host = document.createElement('div');
      host.appendChild(node);
      expect(host.querySelector('img')).toBe(null);
      expect(host.textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('drops cursor-movement escapes rather than printing them', () => {
      const { node } = renderLine(`progress${ESC}[2Kdone`);
      const host = document.createElement('div');
      host.appendChild(node);
      expect(host.textContent).toBe('progressdone');
    });
  });

  describe('timestamped logs', () => {
    // GitLab Runner 18.7 turned FF_TIMESTAMPS on by default, so every line
    // arrives behind a 32-byte header: 27 chars of UTC time, a space, a
    // two-hex-digit stream number, E or O, then '+' or a space.
    const ts = (body, { at = '2024-05-14T11:19:20.000000Z', stream = '00O', cont = ' ' } = {}) =>
      `${at} ${stream}${cont}${body}`;

    it('takes the header off an ordinary line', () => {
      const [item] = parseLines(ts('npm install'));
      expect(item.type).toBe('line');
      expect(item.text).toBe('npm install');
      expect(item.timestamp).toBe('2024-05-14T11:19:20.000000Z');
    });

    it('still finds a section marker hiding behind a header', () => {
      const marker = `section_start:1699999999:prepare${'\r'}${ESC}[0KPreparing the runner`;
      const [item] = parseLines(ts(marker));
      expect(item.type).toBe('section-start');
      expect(item.name).toBe('prepare');
      expect(item.text).toBe('Preparing the runner');
    });

    it('joins a line the runner split across several', () => {
      const text = [
        ts('a very '),
        ts('long ', { cont: '+' }),
        ts('line', { cont: '+' }),
        ts('next')
      ].join('\n');
      const items = parseLines(text);
      expect(items.length).toBe(2);
      expect(items[0].text).toBe('a very long line');
      expect(items[1].text).toBe('next');
    });

    it('leaves an untimestamped log untouched', () => {
      const [item] = parseLines('2024 was a good year');
      expect(item.text).toBe('2024 was a good year');
      expect(item.timestamp).toBe(null);
    });

    it('trusts the caller over the first line, for the later chunks of a tail', () => {
      const [item] = parseLines(ts('still ticking'), { timestamps: true });
      expect(item.text).toBe('still ticking');
    });

    it('strips the headers for the saved raw log', () => {
      const raw = [ts('Preparing'), ts('OK')].join('\n');
      expect(stripAnsi(raw)).toBe('Preparing\nOK');
    });
  });

  describe('things that only look like section markers', () => {
    it('ignores the text without the escape suffix that makes it a marker', () => {
      // A build that echoes this string must not fold the rest of the log.
      const [item] = parseLines('section_start:1699999999:prepare');
      expect(item.type).toBe('line');
      expect(item.text).toBe('section_start:1699999999:prepare');
    });

    it('reads the collapsed option GitLab puts on the noisy sections', () => {
      const [item] = parseLines(`section_start:1:prep[collapsed=true]${'\r'}${ESC}[0KPreparing`);
      expect(item.type).toBe('section-start');
      expect(item.name).toBe('prep');
      expect(item.collapsed).toBe(true);
      expect(item.text).toBe('Preparing');
    });

    it('leaves a section without the option expanded', () => {
      const [item] = parseLines(`section_start:1:prep${'\r'}${ESC}[0KPreparing`);
      expect(item.collapsed).toBe(false);
    });

    it('accepts the clear-line escape GitLab puts in front of the marker', () => {
      const [item] = parseLines(`${ESC}[0Ksection_start:1:prep${'\r'}${ESC}[0KPreparing`);
      expect(item.type).toBe('section-start');
      expect(item.name).toBe('prep');
    });
  });

  describe('stripAnsi', () => {
    it('removes colour codes and section markers', () => {
      const raw = [
        `section_start:1:prep${'\r'}${ESC}[0KPreparing`,
        `${ESC}[32mOK${ESC}[0m`,
        `section_end:1:prep${'\r'}${ESC}[0K`
      ].join('\n');
      expect(stripAnsi(raw)).toBe('Preparing\nOK\n');
    });
  });
});
