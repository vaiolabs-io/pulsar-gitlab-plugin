const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConnectionStore, normaliseBaseUrl } = require('../lib/connections');

describe('ConnectionStore', () => {
  let dir;
  let file;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-conn-'));
    file = path.join(dir, 'gitlab-pipelines.json');
    store = new ConnectionStore({ filePath: file });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('base URLs', () => {
    it('adds a scheme when the user typed a bare hostname', () => {
      expect(normaliseBaseUrl('git.sds.lab')).toBe('https://git.sds.lab');
    });

    it('strips a trailing /api/v4 that people paste', () => {
      expect(normaliseBaseUrl('https://git.sds.lab/api/v4')).toBe('https://git.sds.lab');
      expect(normaliseBaseUrl('https://git.sds.lab/api/v4/')).toBe('https://git.sds.lab');
    });

    it('keeps a subpath install intact', () => {
      expect(normaliseBaseUrl('https://intranet.example/gitlab/')).toBe('https://intranet.example/gitlab');
    });

    it('refuses an empty URL', () => {
      expect(() => normaliseBaseUrl('')).toThrow();
    });
  });

  describe('storing connections', () => {
    it('writes the file so only the owner can read it', () => {
      store.add({ name: 'lab', baseUrl: 'git.sds.lab', tokenSource: 'plain', token: 'glpat-x' });
      const mode = fs.statSync(file).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('never writes the token in the clear, even in plain mode', () => {
      store.add({ name: 'lab', baseUrl: 'git.sds.lab', tokenSource: 'plain', token: 'glpat-supersecret' });
      const contents = fs.readFileSync(file, 'utf8');
      expect(contents).not.toContain('glpat-supersecret');
    });

    it('stores no token at all for the env and glab sources', () => {
      store.add({ name: 'com', baseUrl: 'gitlab.com', tokenSource: 'env', envVar: 'MY_TOKEN' });
      const [connection] = store.all();
      expect(connection.token).toEqual({ source: 'env', envVar: 'MY_TOKEN' });
    });

    it('reloads what it wrote', () => {
      store.add({ name: 'lab', baseUrl: 'git.sds.lab', tokenSource: 'glab' });
      const second = new ConnectionStore({ filePath: file });
      expect(second.all().length).toBe(1);
      expect(second.all()[0].name).toBe('lab');
    });

    it('starts empty rather than throwing when the file is not there', () => {
      const fresh = new ConnectionStore({ filePath: path.join(dir, 'nothing-here.json') });
      expect(fresh.all()).toEqual([]);
    });

    it('keeps the certificate settings it was given', () => {
      const connection = store.add({
        name: 'lab', baseUrl: 'git.sds.lab', tokenSource: 'glab',
        tls: { caPath: '/etc/ssl/lab.pem', fingerprint: 'AA:BB', rejectUnauthorized: false }
      });
      expect(connection.tls.caPath).toBe('/etc/ssl/lab.pem');
      expect(connection.tls.fingerprint).toBe('AA:BB');
      expect(connection.tls.rejectUnauthorized).toBe(false);
    });

    it('drops empty certificate fields instead of storing blanks', () => {
      const connection = store.add({ name: 'x', baseUrl: 'gitlab.com', tokenSource: 'glab', tls: { caPath: '', fingerprint: '' } });
      expect(connection.tls).toEqual({});
    });

    it('removes a connection', () => {
      const connection = store.add({ name: 'lab', baseUrl: 'git.sds.lab', tokenSource: 'glab' });
      store.remove(connection.id);
      expect(store.all()).toEqual([]);
    });
  });

  describe('matching a repository to a connection', () => {
    beforeEach(() => {
      store.add({ name: 'lab', baseUrl: 'https://git.sds.lab', tokenSource: 'glab' });
      store.add({ name: 'public', baseUrl: 'https://gitlab.com', tokenSource: 'glab' });
    });

    it('matches an ssh remote against an https connection', () => {
      const match = store.findForRemote('git@git.sds.lab:team/app.git');
      expect(match.connection.name).toBe('lab');
      expect(match.remote.projectPath).toBe('team/app');
    });

    it('picks the right instance when several are configured', () => {
      expect(store.findForRemote('https://gitlab.com/group/x.git').connection.name).toBe('public');
      expect(store.findForRemote('https://git.sds.lab/group/x.git').connection.name).toBe('lab');
    });

    it('returns nothing for a host we do not know', () => {
      expect(store.findForRemote('git@github.com:someone/thing.git')).toBe(null);
    });
  });

  describe('clients', () => {
    it('reuses one client per connection', () => {
      const connection = store.add({ name: 'lab', baseUrl: 'git.sds.lab', tokenSource: 'plain', token: 'glpat-x' });
      expect(store.clientFor(connection.id)).toBe(store.clientFor(connection.id));
    });

    it('throws the cached client away when the connection changes', () => {
      const connection = store.add({ name: 'lab', baseUrl: 'git.sds.lab', tokenSource: 'plain', token: 'glpat-x' });
      const first = store.clientFor(connection.id);
      store.update(connection.id, { baseUrl: 'https://git2.sds.lab' });
      expect(store.clientFor(connection.id)).not.toBe(first);
      expect(store.clientFor(connection.id).apiRoot).toBe('https://git2.sds.lab/api/v4');
    });
  });
});
