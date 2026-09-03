const fs = require('fs');
const os = require('os');
const path = require('path');
const secrets = require('../lib/secrets');

// The first safeStorage call crosses a synchronous IPC boundary into the main
// process and can take longer than a spec's 5-second budget. Pulsar's runner
// wraps every spec as async, so that budget applies even to a synchronous one,
// and it cannot be raised from inside a spec. Pay the cost here, while spec
// files are still loading, and record what it actually cost.
const COLD_PROBE_MS = (() => {
  const started = Date.now();
  try {
    secrets.warmUp();
  } catch (err) {
    // No keyring on this machine. The specs below handle that case.
  }
  return Date.now() - started;
})();

describe('token storage', () => {
  describe('the machine\'s keyring', () => {
    // This is the one thing that cannot be worked out by reading source: it
    // depends on whether a keyring daemon is running on this machine right now.
    it('reports which store it would use', () => {
      const backend = secrets.keyringBackendName();
      console.log(`[gitlab-pipelines] safeStorage backend: ${backend}, usable: ${secrets.keyringAvailable()}, cold probe took ${COLD_PROBE_MS}ms`);
      expect(typeof backend).toBe('string');
    });

    it('refuses to call the plaintext fallback "available"', () => {
      // Electron's isEncryptionAvailable() returns true even when the backend
      // is basic_text, where the key is hardcoded in Chromium's source. That is
      // not encryption, and treating it as such would be the whole bug.
      if (secrets.keyringBackendName() === 'basic_text') {
        expect(secrets.keyringAvailable()).toBe(false);
      }
    });

    it('round-trips a token when a real keyring is there', async () => {
      if (!secrets.keyringAvailable()) {
        console.log('[gitlab-pipelines] no OS keyring here, skipping round-trip');
        return;
      }
      const record = secrets.makeTokenRecord('keyring', { token: 'glpat-round-trip-me' });
      expect(record.source).toBe('keyring');
      expect(record.blob).not.toContain('glpat-');
      expect(await secrets.readToken(record, 'git.sds.lab')).toBe('glpat-round-trip-me');
    });
  });

  describe('the GitLab CLI config', () => {
    let configDir;
    let previousXdg;

    beforeEach(() => {
      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glab-test-'));
      fs.mkdirSync(path.join(configDir, 'glab-cli'));
      fs.writeFileSync(path.join(configDir, 'glab-cli', 'config.yml'), [
        'git_protocol: ssh',
        'editor:',
        'hosts:',
        '  gitlab.com:',
        '    token: glpat-public-one',
        '    api_protocol: https',
        '  git.sds.lab:',
        '    token: glpat-local-one',
        '    api_host: git.sds.lab',
        ''
      ].join('\n'));
      previousXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = configDir;
    });

    afterEach(() => {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      fs.rmSync(configDir, { recursive: true, force: true });
    });

    it('finds the token for each host separately', () => {
      expect(secrets.fromGlab('gitlab.com')).toBe('glpat-public-one');
      expect(secrets.fromGlab('git.sds.lab')).toBe('glpat-local-one');
    });

    it('says what to run when the host is not logged in', () => {
      expect(() => secrets.fromGlab('other.example')).toThrow();
      try {
        secrets.fromGlab('other.example');
      } catch (err) {
        expect(err.message).toContain('glab auth login');
      }
    });
  });

  describe('environment variables', () => {
    it('reads the named variable', () => {
      process.env.GITLAB_TEST_TOKEN = 'glpat-from-env';
      expect(secrets.fromEnv('GITLAB_TEST_TOKEN')).toBe('glpat-from-env');
      delete process.env.GITLAB_TEST_TOKEN;
    });

    it('explains the launcher problem when the variable is missing', () => {
      try {
        secrets.fromEnv('DEFINITELY_NOT_SET_ANYWHERE');
      } catch (err) {
        expect(err.message).toContain('Restart Pulsar');
      }
    });
  });

  describe('redaction', () => {
    it('hides a personal access token', () => {
      expect(secrets.redact('failed with glpat-AbCdEf123456')).toBe('failed with glpat-***');
    });

    it('hides a bearer header', () => {
      expect(secrets.redact('Authorization: Bearer abc123def456')).toBe('Authorization: Bearer ***');
    });

    it('leaves ordinary text alone', () => {
      expect(secrets.redact('connection refused by git.sds.lab')).toBe('connection refused by git.sds.lab');
    });
  });

  describe('plain storage', () => {
    it('round-trips, but is not the default', async () => {
      const record = secrets.makeTokenRecord('plain', { token: 'glpat-plain' });
      expect(record.blob).not.toBe('glpat-plain');
      expect(await secrets.readToken(record, 'x')).toBe('glpat-plain');
    });
  });
});
