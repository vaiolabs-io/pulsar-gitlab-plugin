const { GitLabClient, ACCESS, isTerminal, normaliseStatus, normaliseDetail } = require('../lib/gitlab/client');

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

  describe('status casing', () => {
    // Observed against gitlab.com's GraphQL API on 2026-09-03, unauthenticated,
    // on gitlab-org/gitlab-runner. This is the real shape, not a guess:
    //   pipeline.status "RUNNING"   job.status "SUCCESS"   stage.status "running"
    // The enums serialise as their upper-case names; stage.status is a plain
    // String field. Left alone, "SUCCESS" matches nothing, so every icon falls
    // back to a grey dot and a manual job never offers its Run button.
    const asGitLabSendsIt = () => ({
      iid: 42,
      status: 'RUNNING',
      stages: {
        nodes: [{
          name: 'build',
          status: 'running',
          jobs: { nodes: [{ name: 'binaries', status: 'RUNNING' }, { name: 'deploy', status: 'MANUAL' }] }
        }]
      }
    });

    it('lower-cases pipeline, stage and job statuses alike', () => {
      const detail = normaliseDetail(asGitLabSendsIt());
      expect(detail.status).toBe('running');
      expect(detail.stages.nodes[0].status).toBe('running');
      expect(detail.stages.nodes[0].jobs.nodes.map((job) => job.status)).toEqual(['running', 'manual']);
    });

    it('leaves an already lower-case status alone, so the REST path is untouched', () => {
      const detail = normaliseDetail({ status: 'success', stages: { nodes: [{ status: 'success', jobs: { nodes: [{ status: 'success' }] } }] } });
      expect(detail.status).toBe('success');
      expect(detail.stages.nodes[0].jobs.nodes[0].status).toBe('success');
    });

    it('survives a pipeline with no stages or no jobs', () => {
      expect(() => normaliseDetail({ status: 'SUCCESS' })).not.toThrow();
      expect(() => normaliseDetail({ status: 'SUCCESS', stages: { nodes: [{ status: 'success' }] } })).not.toThrow();
      expect(normaliseDetail(null)).toBe(null);
    });

    it('does not choke on a missing or non-string status', () => {
      expect(normaliseStatus(undefined)).toBe(undefined);
      expect(normaliseStatus(null)).toBe(null);
      expect(normaliseStatus(7)).toBe(7);
    });

    it('makes the manual-job check work, which is what the bug actually broke', () => {
      const detail = normaliseDetail(asGitLabSendsIt());
      const manual = detail.stages.nodes[0].jobs.nodes.find((job) => job.status === 'manual');
      expect(manual).toBeDefined();
      expect(manual.name).toBe('deploy');
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
      // GraphQL sends these upper case.
      expect(isTerminal('SUCCESS')).toBe(true);
      expect(isTerminal('RUNNING')).toBe(false);
    });
  });
});
