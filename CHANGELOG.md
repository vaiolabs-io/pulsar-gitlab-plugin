# Changelog

## Unreleased

- Every git remote is found now, not just `origin`, `upstream`, `gitlab` and
  `fork`. Those four were hardcoded, so a remote called anything else was
  invisible - and "Git remote to follow" could not select one either, because
  it checked against that same list. Pulsar's GitRepository cannot enumerate
  remotes, so the names are read from `.git/config` and each URL still comes
  back through the supported `getConfigValue`. Submodules, linked worktrees
  and an unreadable config are all handled.

## 0.3.1

- The status bar light now works without opening the panel first. It was built
  in `consumeStatusBar`, but the connection store, the project context and the
  poll timer only ever started from the panel or a command - so until you
  opened the panel once, the light sat on its initial state and never reported
  anything, which looks exactly like a broken package.
- Starting is deferred until Pulsar reports its initial packages are up.
  Doing that work inline crashed the renderer: `consumeStatusBar` runs on the
  activation path, and reading the connection file and decrypting a token
  there is a native, uncatchable crash.
- The light no longer hides itself when the project has no GitLab remote. It
  stays put, subdued, and its tooltip says which kind of nothing it is - no
  connection configured yet, or no GitLab remote here.
- Fixed "Show pipeline status in the status bar". Every repaint wrote
  `display`, so turning the tile off only lasted until the next poll.
- New: a **job progress** tile counting finished and failed jobs.
- New: a **stage strip** in the status bar, a circle per stage, hollow while a
  stage is still to come. Capped at six, with the tail folded into a single
  circle carrying the worst status in it. Click one to open the panel at that
  stage.
- The light carries the GitLab tanuki, so the three tiles read as one package.

## 0.2.0

- Add a stage strip to the panel header: one marker per stage, coloured by that
  stage's status, click to scroll to the stage.
- Fix GraphQL status casing. GitLab returns pipeline and job statuses in upper
  case, and the code compared them against lower case. In 0.1.1 this silently
  broke the status icons and hid the Run button on manual jobs.
- Fix an HTML injection in the stage tooltip. Atom's tooltip API defaults to
  `html: true` and assigns to `innerHTML`, so a GitLab-supplied stage name was
  rendered as markup. Tooltips now pass `html: false`.
- Register `gitlab-pipelines:manage-connections` as an activation command. The
  "Manage Connections..." menu item did nothing until the package had been
  activated by some other command.
- README: correct the install instructions, drop the stale claim that the
  package cannot be published, document the stage strip.

## 0.1.1

- Stop touching `electron.remote`. It works under `pulsar --test` but is removed
  in a real Pulsar window, so the package failed to activate once installed.
  Use the pinned `@electron/remote` dependency instead.

## 0.1.0

- First release. Pipeline and job panel, status bar light, job logs, schedules,
  `.gitlab-ci.yml` linting, multiple GitLab connections with secure token
  storage.
