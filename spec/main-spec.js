const path = require('path');
const main = require('../lib/main');
const { PIPELINES_URI } = require('../lib/views/pipelines-view');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

describe('the package itself', () => {
  let pack;

  // Load by path, not by name: activating by name alone only works when the
  // package is already linked into the config directory in use, and these
  // specs run in a throwaway one.
  //
  // The second half matters more. This package declares activationCommands, so
  // Pulsar deliberately does not run activate() until one of those commands
  // fires - it registers no-op stand-ins and waits. That means
  // activatePackage() alone never resolves. Kicking it with activateNow() runs
  // the real activate() without having to dispatch a command that would also
  // open the panel and start polling, which is the very thing several of these
  // specs are checking does not happen on its own.
  async function activateForTest () {
    atom.packages.loadPackage(PACKAGE_ROOT);
    const activation = atom.packages.activatePackage('gitlab-pipelines');
    atom.packages.getLoadedPackage('gitlab-pipelines').activateNow();
    return activation;
  }

  beforeEach(async () => {
    pack = await activateForTest();
  });

  afterEach(async () => {
    await atom.packages.deactivatePackage('gitlab-pipelines');
  });

  it('activates', () => {
    expect(atom.packages.isPackageActive('gitlab-pipelines')).toBe(true);
    expect(pack.name).toBe('gitlab-pipelines');
  });

  it('registers every command it advertises', () => {
    const names = atom.commands
      .findCommands({ target: atom.views.getView(atom.workspace) })
      .map((command) => command.name);
    for (const command of [
      'gitlab-pipelines:toggle',
      'gitlab-pipelines:refresh',
      'gitlab-pipelines:add-connection',
      'gitlab-pipelines:manage-connections',
      'gitlab-pipelines:run-pipeline',
      'gitlab-pipelines:lint-ci-config'
    ]) {
      expect(names).toContain(command);
    }
  });

  it('does no network or file work while activating', () => {
    // activate() runs on the window's startup path. Anything slow in there is
    // paid by every window open, whether or not the user touches GitLab.
    expect(main.connections).toBe(null);
    expect(main.poller).toBe(null);
  });

  it('reads its settings from the schema in package.json', () => {
    expect(atom.config.get('gitlab-pipelines.notifications')).toBe('failure');
    expect(atom.config.get('gitlab-pipelines.showStatusBar')).toBe(true);
    expect(atom.config.get('gitlab-pipelines.gitRemoteName')).toBe('');
  });

  it('rejects a setting that is not one of the offered choices', () => {
    atom.config.set('gitlab-pipelines.notifications', 'whenever');
    expect(atom.config.get('gitlab-pipelines.notifications')).toBe('failure');
  });

  describe('the status bar light', () => {
    function fakeStatusBar () {
      return {
        tiles: [],
        addRightTile (options) {
          const tile = {
            item: options.item,
            priority: options.priority,
            destroyed: false,
            destroy () { this.destroyed = true; }
          };
          this.tiles.push(tile);
          return tile;
        }
      };
    }

    // The bug this guards: the tile was built in consumeStatusBar but the
    // stores and the poll timer only ever came up from getView() or a command.
    // Until you opened the panel once, the light sat on its constructor's idle
    // state for ever, which is indistinguishable from a package that failed.
    it('starts the package, so the light has something to report', async () => {
      expect(main.connections).toBe(null);
      expect(main.poller).toBe(null);

      const bar = fakeStatusBar();
      main.consumeStatusBar(bar);

      expect(bar.tiles.length).toBe(1);
      expect(main.connections).not.toBe(null);
      expect(main.context).not.toBe(null);
      expect(main.poller).not.toBe(null);
    });

    it('stays asleep when the user has turned the light off', () => {
      atom.config.set('gitlab-pipelines.showStatusBar', false);

      main.consumeStatusBar(fakeStatusBar());

      expect(main.connections).toBe(null);
      expect(main.poller).toBe(null);
      atom.config.set('gitlab-pipelines.showStatusBar', true);
    });

    it('hands back a disposable that destroys the tile', () => {
      const bar = fakeStatusBar();
      const disposable = main.consumeStatusBar(bar);
      expect(bar.tiles[0].destroyed).toBe(false);
      disposable.dispose();
      expect(bar.tiles[0].destroyed).toBe(true);
    });
  });

  describe('the panel', () => {
    it('opens into the right dock and toggles shut again', async () => {
      const item = await atom.workspace.open(PIPELINES_URI);
      expect(item.getTitle()).toBe('GitLab Pipelines');
      expect(atom.workspace.getRightDock().getPaneItems()).toContain(item);
      expect(atom.workspace.getRightDock().isVisible()).toBe(true);

      await atom.workspace.toggle(PIPELINES_URI);
      expect(atom.workspace.getRightDock().isVisible()).toBe(false);
    });

    it('starts polling only once the panel is asked for', async () => {
      expect(main.poller).toBe(null);
      await atom.workspace.open(PIPELINES_URI);
      expect(main.poller).not.toBe(null);
    });

    it('shows the "no connection yet" state rather than an error', async () => {
      const item = await atom.workspace.open(PIPELINES_URI);
      expect(item.getElement().textContent).toContain('No GitLab connection yet');
    });
  });

  describe('the status bar tile', () => {
    it('adds a tile and hands back something that removes it', () => {
      const added = [];
      const fakeStatusBar = {
        addRightTile (options) {
          const tile = { destroyed: false, destroy () { this.destroyed = true; }, getItem: () => options.item };
          added.push(tile);
          return tile;
        }
      };
      const disposable = main.consumeStatusBar(fakeStatusBar);
      expect(added.length).toBe(1);
      expect(added[0].getItem().classList.contains('gitlab-pipelines-status')).toBe(true);

      // A status bar Tile is not a Disposable, so nothing would clean it up on
      // its own. One leaked tile per window reload is the classic symptom.
      disposable.dispose();
      expect(added[0].destroyed).toBe(true);
    });
  });

  describe('shutting down', () => {
    it('leaves no timer running', async () => {
      await atom.workspace.open(PIPELINES_URI);
      expect(main.poller).not.toBe(null);
      await atom.packages.deactivatePackage('gitlab-pipelines');
      expect(main.poller).toBe(null);
      // Re-activate so afterEach has something to tear down.
      await activateForTest();
    });

    it('can be activated and deactivated repeatedly without piling up', async () => {
      for (let i = 0; i < 3; i++) {
        await atom.packages.deactivatePackage('gitlab-pipelines');
        await activateForTest();
      }
      const names = atom.commands
        .findCommands({ target: atom.views.getView(atom.workspace) })
        .map((command) => command.name)
        .filter((name) => name === 'gitlab-pipelines:toggle');
      // Registered once, not once per activation.
      expect(names.length).toBe(1);
    });
  });
});
