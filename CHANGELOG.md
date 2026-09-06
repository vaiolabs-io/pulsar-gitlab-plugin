# Changelog

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
