const { GitLabClient, ACCESS, isTerminal } = require('../lib/gitlab/client');

function clientFor (overrides = {}) {
  const connection = Object.assign({
    id: 'c1', name: 'lab', baseUrl: 'https://git.sds.lab', scope: 'api', tls: {}
  }, overrides);
  return new GitLabClient(connection, async () => 'glpat-test');
}

describe('GitLabClient', () => {
  describe('URLs', () => {
    it('builds the API root from the base URL', () => {
      expect(clientFor().apiRoot).toBe('https://git.sds.lab/api/v4');
      expect(clientFor({ baseUrl: 'https://gitlab.com/' }).apiRoot).toBe('https://gitlab.com/api/v4');
    });

    it('builds the GraphQL URL from the same base', () => {
      expect(clientFor().graphqlUrl).toBe('https://git.sds.lab/api/graphql');
    });

    it('supports GitLab installed under a subpath', () => {
      expect(clientFor({ baseUrl: 'https://intranet.example/gitlab' }).apiRoot)
        .toBe('https://intranet.example/gitlab/api/v4');
    });
  });

  describe('version gating', () => {
    // Self-hosted instances lag, so every optional feature has to be gated on
    // the version the server actually reports.
    it('compares versions with the -ee suffix stripped', () => {
      const client = clientFor();
      client.version = { version: '18.11.2-ee' };
      expect(client.atLeast(19)).toBe(false);
      expect(client.atLeast(18, 1)).toBe(true);
      expect(client.atLeast(18, 11, 2)).toBe(true);
      expect(client.atLeast(18, 11, 3)).toBe(false);
    });

    it('says no when the version is unknown', () => {
      expect(clientFor().atLeast(18, 1)).toBe(false);
    });

    it('treats 19.0 as having the incremental log parameters', () => {
      const client = clientFor();
      client.version = { version: '19.0.0-ee' };
      expect(client.atLeast(19)).toBe(true);
    });
  });

  describe('permissions', () => {
    it('takes the higher of project and group access', () => {
      const project = { permissions: { project_access: { access_level: 20 }, group_access: { access_level: 40 } } };
      expect(GitLabClient.accessLevel(project)).toBe(ACCESS.MAINTAINER);
      expect(GitLabClient.canWrite(project)).toBe(true);
    });

    it('copes with either half being null', () => {
      expect(GitLabClient.accessLevel({ permissions: { project_access: null, group_access: { access_level: 30 } } })).toBe(30);
      expect(GitLabClient.accessLevel({})).toBe(0);
    });

    it('refuses write below Developer', () => {
      expect(GitLabClient.canWrite({ permissions: { project_access: { access_level: 20 } } })).toBe(false);
    });
  });

  describe('error messages', () => {
    it('says the token is read-only when a write fails on a read_api connection', () => {
      const client = clientFor({ scope: 'read_api' });
      const err = client.explain({ status: 403, body: {}, url: 'x' }, 'POST', '/pipeline');
      expect(err.message).toContain('read-only');
    });

    it('blames the role, not the scope, when the token can write', () => {
      const err = clientFor().explain({ status: 403, body: {}, url: 'x' }, 'POST', '/pipeline');
      expect(err.message).toContain('Developer');
    });

    it('never says a plain "not found"', () => {
      // A private project and a missing one are indistinguishable over the API,
      // so the message has to cover both or it sends people hunting for typos.
      const err = clientFor().explain({ status: 404, body: {}, url: 'x' }, 'GET', '/projects/1');
      expect(err.message).toContain('cannot see it');
    });

    it('tells the user to reconnect on 401', () => {
      const err = clientFor().explain({ status: 401, body: {}, url: 'x' }, 'GET', '/user');
      expect(err.message).toContain('reconnect');
    });

    it('surfaces GitLab\'s own message for a 400', () => {
      const err = clientFor().explain(
        { status: 400, body: { message: { base: ['Reference not found'] } }, url: 'x' },
        'POST', '/pipeline'
      );
      expect(err.message).toContain('Reference not found');
    });

    it('reads a message given as a plain string', () => {
      const err = clientFor().explain({ status: 400, body: { message: '403 Forbidden' }, url: 'x' }, 'POST', '/x');
      expect(err.message).toContain('403 Forbidden');
    });
  });

  describe('terminal statuses', () => {
    it('knows which statuses mean stop polling', () => {
      expect(isTerminal('success')).toBe(true);
      expect(isTerminal('failed')).toBe(true);
      expect(isTerminal('canceled')).toBe(true);
      expect(isTerminal('running')).toBe(false);
      // "canceling" is not terminal - it is still doing something.
      expect(isTerminal('canceling')).toBe(false);
      expect(isTerminal('waiting_for_callback')).toBe(false);
    });
  });
});
