const { JobLogView, logUriFor, parseLogUri, MAX_RENDERED_LINES } = require('../lib/views/job-log-view');

const ESC = String.fromCharCode(27);

// A timestamped line, the way GitLab Runner 18.7+ sends every one of them:
// 27 chars of UTC time, a space, a 2-hex stream number, E or O, then '+' for
// a continuation of the line before or a space for a fresh one.
const ts = (body, cont = ' ') => `2024-05-14T11:19:20.000000Z 00O${cont}${body}`;

function makeView () {
  const client = {
    getJobLog: () => Promise.resolve({ text: '', totalBytes: 0, etag: null, unchanged: true }),
    call: () => Promise.resolve({ body: { status: 'running' } })
  };
  const view = new JobLogView({
    client,
    projectId: 7,
    connectionId: 'c1',
    baseUrl: 'https://git.sds.lab',
    job: { id: 55, name: 'unit', status: 'running' }
  });
  // The tail is a timer against a fake server; these specs drive append()
  // directly, so shut it down before it can schedule anything.
  view.stopTail();
  return view;
}

describe('JobLogView', () => {
  let view;

  beforeEach(() => { view = makeView(); });
  afterEach(() => view.destroy());

  const lines = () => Array.from(view.outputEl.querySelectorAll('.gl-log-line'))
    .map((el) => el.textContent);

  describe('its URI', () => {
    it('round-trips the connection, project and job', () => {
      const uri = logUriFor('c1', 7, 55);
      expect(parseLogUri(uri)).toEqual({ connectionId: 'c1', projectId: 7, jobId: 55 });
    });
  });

  describe('chunks that do not end on a line break', () => {
    it('holds the half line back until the rest of it arrives', () => {
      view.append('one\ntw');
      expect(lines()).toEqual(['one']);

      view.append('o\nthree\n');
      expect(lines()).toEqual(['one', 'two', 'three']);
    });

    it('shows the last line when the job ends without a trailing newline', () => {
      view.append('one\nlast bit');
      expect(lines()).toEqual(['one']);

      view.append('', { final: true });
      expect(lines()).toEqual(['one', 'last bit']);
    });

    it('does not add an empty line every time a chunk ends cleanly', () => {
      view.append('one\n');
      view.append('two\n');
      view.append('three\n');
      expect(lines()).toEqual(['one', 'two', 'three']);
    });

    it('keeps a section marker whole when a chunk splits it', () => {
      const marker = `section_start:1699999999:prepare${'\r'}${ESC}[0KPreparing`;
      view.append(marker.slice(0, 12));
      view.append(`${marker.slice(12)}\ninside\n`);

      const section = view.outputEl.querySelector('.gl-log-section');
      expect(section).not.toBe(null);
      expect(section.querySelector('summary').textContent).toBe('Preparing');
      expect(section.querySelectorAll('.gl-log-line').length).toBe(1);
    });
  });

  describe('timestamped logs', () => {
    it('decides once, and keeps stripping on later chunks', () => {
      view.append(`${ts('first')}\n`);
      expect(view.hasTimestamps).toBe(true);
      view.append(`${ts('second')}\n`);
      expect(lines()).toEqual(['first', 'second']);
    });

    it('folds a section whose marker arrived behind a timestamp', () => {
      view.append(`${ts(`section_start:1:prep${'\r'}${ESC}[0KPreparing`)}\n${ts('inside')}\n`);
      const section = view.outputEl.querySelector('.gl-log-section');
      expect(section).not.toBe(null);
      expect(section.querySelector('.gl-log-line').textContent).toBe('inside');
    });

    it('opens a section GitLab did not mark collapsed, and shuts one it did', () => {
      view.append(`section_start:1:a${'\r'}${ESC}[0KOpen me\n`);
      view.append(`section_end:1:a${'\r'}${ESC}[0K\n`);
      view.append(`section_start:2:b[collapsed=true]${'\r'}${ESC}[0KShut me\n`);

      const sections = view.outputEl.querySelectorAll('.gl-log-section');
      expect(sections.length).toBe(2);
      expect(sections[0].open).toBe(true);
      expect(sections[1].open).toBe(false);
    });
  });

  describe('trimming a log that has grown too big', () => {
    it('counts the lines inside a section, not the section as one line', () => {
      view.append(`section_start:1:prep${'\r'}${ESC}[0KPreparing\n`);
      for (let i = 0; i < 5; i++) view.append(`line ${i}\n`);
      view.append(`section_end:1:prep${'\r'}${ESC}[0K\n`);

      expect(view.lineCount).toBe(5);
      expect(view.renderedLinesIn(view.outputEl.querySelector('.gl-log-section'))).toBe(5);
    });

    it('lets go of the open section when that section is the thing removed', () => {
      view.append(`section_start:1:prep${'\r'}${ESC}[0KPreparing\n`);
      view.append('a\nb\nc\n');
      const section = view.outputEl.querySelector('.gl-log-section');
      expect(section.contains(view.openSection)).toBe(true);

      // Sit one line under the cap, so the next append tips it over and the
      // trim wants exactly the four lines the section will then hold.
      view.lineCount = MAX_RENDERED_LINES + 3;
      view.append('after\n');

      expect(view.outputEl.querySelector('.gl-log-section')).toBe(null);
      expect(view.openSection).toBe(null);

      // The point of clearing it: the next line goes into the document rather
      // than into a node that is no longer in it.
      view.lineCount = 0;
      view.append('later\n');
      expect(view.outputEl.textContent).toContain('later');
    });
  });
});
