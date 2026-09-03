const { parseRemote, encodeProjectPath, hostMatches } = require('../lib/git-remote');

describe('git remote parsing', () => {
  it('reads an scp-style ssh remote', () => {
    expect(parseRemote('git@gitlab.com:group/project.git')).toEqual({
      host: 'gitlab.com', port: null, projectPath: 'group/project', protocol: 'ssh'
    });
  });

  it('reads an ssh:// remote with a port', () => {
    expect(parseRemote('ssh://git@git.sds.lab:2222/team/sub/app.git')).toEqual({
      host: 'git.sds.lab', port: 2222, projectPath: 'team/sub/app', protocol: 'ssh'
    });
  });

  it('reads an https remote', () => {
    expect(parseRemote('https://git.sds.lab/team/app.git')).toEqual({
      host: 'git.sds.lab', port: null, projectPath: 'team/app', protocol: 'https'
    });
  });

  it('keeps nested subgroups intact', () => {
    expect(parseRemote('git@gitlab.com:a/b/c/d.git').projectPath).toBe('a/b/c/d');
  });

  it('ignores credentials embedded in the URL', () => {
    const parsed = parseRemote('https://oauth2:secret@gitlab.com/group/project.git');
    expect(parsed.host).toBe('gitlab.com');
    expect(parsed.projectPath).toBe('group/project');
  });

  it('copes with a missing .git suffix and trailing slashes', () => {
    expect(parseRemote('https://gitlab.com/group/project/').projectPath).toBe('group/project');
  });

  it('returns null for things that are not remotes', () => {
    expect(parseRemote('')).toBe(null);
    expect(parseRemote(null)).toBe(null);
    expect(parseRemote('just some text')).toBe(null);
    expect(parseRemote('git@gitlab.com:')).toBe(null);
  });

  it('encodes the whole project path, slashes included', () => {
    // A path left with real slashes routes to a different endpoint and 404s,
    // so this is the single most load-bearing line in the module.
    expect(encodeProjectPath('group/sub/project')).toBe('group%2Fsub%2Fproject');
  });

  it('matches a remote host against a connection base URL', () => {
    expect(hostMatches('git.sds.lab', 'https://git.sds.lab')).toBe(true);
    expect(hostMatches('GIT.SDS.LAB', 'https://git.sds.lab/')).toBe(true);
    expect(hostMatches('gitlab.com', 'https://git.sds.lab')).toBe(false);
    expect(hostMatches('gitlab.com', 'not a url')).toBe(false);
  });
});
