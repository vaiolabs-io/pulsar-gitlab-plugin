const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProjectContext, remoteNamesIn, gitConfigPathFor } = require('../lib/project-context');

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-pipelines-spec-'));
}

function stubConnections () {
  return { onDidChange: () => ({ dispose () {} }), all: () => [] };
}

describe('finding the git remotes', () => {
  let roots;

  beforeEach(() => { roots = []; });

  afterEach(() => {
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) { /* gone */ }
    }
  });

  function makeRoot () {
    const root = tmpDir();
    roots.push(root);
    return root;
  }

  describe('reading names out of a config file', () => {
    it('finds every remote, whatever it is called', () => {
      const config = [
        '[core]',
        '\trepositoryformatversion = 0',
        '[remote "origin"]',
        '\turl = git@git.sds.lab:sds-devops/far-seer.git',
        '[remote "monitoring"]',
        '\turl = https://git.sds.lab/sds-devops/monitoring',
        '[branch "main"]',
        '\tremote = origin'
      ].join('\n');
      expect(remoteNamesIn(config)).toEqual(['origin', 'monitoring']);
    });

    it('keeps the order git wrote them in', () => {
      const config = '[remote "zulu"]\n\turl = a\n[remote "alpha"]\n\turl = b\n';
      expect(remoteNamesIn(config)).toEqual(['zulu', 'alpha']);
    });

    it('copes with the whitespace git allows', () => {
      const config = '  [ remote   "spaced" ]\n\turl = a\n';
      expect(remoteNamesIn(config)).toEqual(['spaced']);
    });

    it('does not list the same remote twice', () => {
      const config = '[remote "origin"]\n\turl = a\n[remote "origin"]\n\tfetch = +refs/*\n';
      expect(remoteNamesIn(config)).toEqual(['origin']);
    });

    it('ignores sections that are not remotes', () => {
      const config = '[branch "remote"]\n\turl = a\n[submodule "x"]\n\turl = b\n';
      expect(remoteNamesIn(config)).toEqual([]);
    });

    it('returns nothing for an empty config', () => {
      expect(remoteNamesIn('')).toEqual([]);
    });

    it('ignores comments', () => {
      expect(remoteNamesIn('# [remote "commented"]\n; [remote "also"]\n')).toEqual([]);
    });
  });

  describe('remotes defined in an included file', () => {
    it('follows include.path', () => {
      const root = makeRoot();
      const main = path.join(root, 'config');
      const extra = path.join(root, 'extra');
      fs.writeFileSync(extra, '[remote "fromInclude"]\n\turl = a\n');
      fs.writeFileSync(main, '[remote "origin"]\n\turl = b\n[include]\n\tpath = ./extra\n');
      expect(remoteNamesIn(fs.readFileSync(main, 'utf8'), main)).toEqual(['origin', 'fromInclude']);
    });

    // The condition is not evaluated. Over-including is safe: a name that
    // should not be there simply has no url and gets dropped later.
    it('follows includeIf without judging the condition', () => {
      const root = makeRoot();
      const main = path.join(root, 'config');
      const extra = path.join(root, 'work');
      fs.writeFileSync(extra, '[remote "work"]\n\turl = a\n');
      fs.writeFileSync(main, '[includeIf "gitdir:~/nope/"]\n\tpath = ./work\n');
      expect(remoteNamesIn(fs.readFileSync(main, 'utf8'), main)).toEqual(['work']);
    });

    it('does not loop on a config that includes itself', () => {
      const root = makeRoot();
      const main = path.join(root, 'config');
      fs.writeFileSync(main, '[remote "origin"]\n\turl = a\n[include]\n\tpath = ./config\n');
      expect(remoteNamesIn(fs.readFileSync(main, 'utf8'), main)).toEqual(['origin']);
    });

    it('shrugs off an include that is not there', () => {
      const root = makeRoot();
      const main = path.join(root, 'config');
      fs.writeFileSync(main, '[remote "origin"]\n\turl = a\n[include]\n\tpath = ./missing\n');
      expect(remoteNamesIn(fs.readFileSync(main, 'utf8'), main)).toEqual(['origin']);
    });

    it('does nothing with includes when it has no path to resolve against', () => {
      expect(remoteNamesIn('[include]\n\tpath = ./extra\n')).toEqual([]);
    });
  });

  describe('locating the config file', () => {
    it('takes it from the .git directory', () => {
      const root = makeRoot();
      const gitDir = path.join(root, '.git');
      fs.mkdirSync(gitDir);
      expect(gitConfigPathFor({ getPath: () => gitDir })).toBe(path.join(gitDir, 'config'));
    });

    // A submodule's .git is a file naming the real directory.
    it('follows a .git file to the real git directory', () => {
      const root = makeRoot();
      const real = path.join(root, 'real');
      fs.mkdirSync(real);
      const pointer = path.join(root, '.git');
      fs.writeFileSync(pointer, 'gitdir: ./real\n');
      expect(gitConfigPathFor({ getPath: () => pointer })).toBe(path.join(real, 'config'));
    });

    // A linked worktree has its own HEAD but shares the main checkout's config.
    it('follows commondir, because a worktree shares the main config', () => {
      const root = makeRoot();
      const shared = path.join(root, 'main.git');
      const worktree = path.join(root, 'wt.git');
      fs.mkdirSync(shared);
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, 'commondir'), '../main.git\n');
      expect(gitConfigPathFor({ getPath: () => worktree })).toBe(path.join(shared, 'config'));
    });

    it('gives up quietly when there is no path', () => {
      expect(gitConfigPathFor({ getPath: () => null })).toBe(null);
      expect(gitConfigPathFor({})).toBe(null);
    });
  });

  describe('putting it together', () => {
    let context;

    beforeEach(() => { context = new ProjectContext(stubConnections()); });
    afterEach(() => context.dispose());

    function repositoryWith (config, urls) {
      const root = makeRoot();
      const gitDir = path.join(root, '.git');
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(gitDir, 'config'), config);
      return {
        getPath: () => gitDir,
        getOriginURL: () => urls['remote.origin.url'] || null,
        repo: { getConfigValue: (key) => urls[key] || null }
      };
    }

    // The bug: only origin, upstream, gitlab and fork were ever looked for, so
    // a remote called anything else could not be seen or selected.
    it('finds a remote whose name is not one of the old four', () => {
      const repository = repositoryWith(
        '[remote "origin"]\n\turl = a\n[remote "monitoring"]\n\turl = b\n',
        {
          'remote.origin.url': 'git@git.sds.lab:sds-devops/far-seer.git',
          'remote.monitoring.url': 'https://git.sds.lab/sds-devops/monitoring'
        }
      );
      const remotes = context.remotesOf(repository);

      expect(remotes.has('monitoring')).toBe(true);
      expect(remotes.get('monitoring')).toBe('https://git.sds.lab/sds-devops/monitoring');
    });

    it('still puts origin first, so it keeps winning the fallback', () => {
      const repository = repositoryWith(
        '[remote "aaa"]\n\turl = a\n[remote "origin"]\n\turl = b\n',
        { 'remote.origin.url': 'git@host:o/o.git', 'remote.aaa.url': 'git@host:a/a.git' }
      );
      expect([...context.remotesOf(repository).keys()]).toEqual(['origin', 'aaa']);
    });

    it('skips a remote that is named but has no url', () => {
      const repository = repositoryWith(
        '[remote "origin"]\n\turl = a\n[remote "broken"]\n\tfetch = x\n',
        { 'remote.origin.url': 'git@host:o/o.git' }
      );
      const remotes = context.remotesOf(repository);
      expect(remotes.has('broken')).toBe(false);
      expect(remotes.size).toBe(1);
    });

    it('falls back to the old guesses when the config cannot be read', () => {
      const repository = {
        getPath: () => '/nowhere/at/all/.git',
        getOriginURL: () => 'git@host:o/o.git',
        repo: { getConfigValue: (key) => (key === 'remote.gitlab.url' ? 'git@host:g/g.git' : null) }
      };
      const remotes = context.remotesOf(repository);
      expect(remotes.get('origin')).toBe('git@host:o/o.git');
      expect(remotes.get('gitlab')).toBe('git@host:g/g.git');
    });

    it('returns nothing for no repository', () => {
      expect(context.remotesOf(null).size).toBe(0);
    });
  });

  describe('choosing between them', () => {
    let context;

    beforeEach(() => { context = new ProjectContext(stubConnections()); });
    afterEach(() => context.dispose());

    // The point of the fix: "Git remote to follow" can now name any remote.
    it('honours a setting naming a remote outside the old four', () => {
      const root = makeRoot();
      const gitDir = path.join(root, '.git');
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(gitDir, 'config'),
        '[remote "origin"]\n\turl = a\n[remote "monitoring"]\n\turl = b\n');
      const repository = {
        getPath: () => gitDir,
        getOriginURL: () => 'git@git.sds.lab:sds-devops/far-seer.git',
        repo: {
          getConfigValue: (key) => ({
            'remote.origin.url': 'git@git.sds.lab:sds-devops/far-seer.git',
            'remote.monitoring.url': 'https://git.sds.lab/sds-devops/monitoring'
          })[key] || null
        }
      };

      atom.config.set('gitlab-pipelines.gitRemoteName', 'monitoring');
      const chosen = context.chooseRemote(repository);
      expect(chosen.name).toBe('monitoring');
      atom.config.set('gitlab-pipelines.gitRemoteName', '');
    });
  });
});
