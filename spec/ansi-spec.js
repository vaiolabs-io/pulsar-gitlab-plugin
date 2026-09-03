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
