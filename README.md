# gitlab-pipelines

Watch and drive GitLab CI/CD pipelines from inside Pulsar.

Works with gitlab.com, with a self-hosted GitLab on your own network, and with
several of them at once. Each instance is a named connection with its own token
and its own certificate settings.

## What it does

- **A panel** in the right dock: the pipeline for the branch you are on, broken
  into stages and jobs, plus the last ten pipelines and every schedule.
- **A stage strip** across the top of the panel: one marker per stage, coloured
  by how that stage is doing. Click one to jump to that stage in the list.
- **A status bar light** showing whether the current branch is green.
- **A job progress tile** next to it: how many jobs of the running pipeline
  have finished, and how many failed.
- **A stage strip in the status bar**: a circle per stage, filled once the
  stage has a result and hollow while it is still to come, coloured by that
  stage's status. Click one to open the panel at that stage. Long pipelines
  fold their tail into a single dot carrying the worst status in it.
  Every status bar tile can be switched off.
- **Run** a pipeline on the current branch. **Cancel** or **retry** one.
- **Play** a manual job, **retry** or **cancel** a single job, without
  re-running the whole pipeline.
- **Toggle a schedule** on or off, or run it now.
- **Job logs** in the centre pane, with the terminal colours rendered and the
  runner's `section_start` blocks folded, tailing while the job runs. Click any
  job to open its log; click any pipeline in the recent list to bring that
  pipeline's jobs into the panel, so an older pipeline's logs are reachable
  too.
- **Check `.gitlab-ci.yml`** against your project before you push it.

Buttons appear only when GitLab says the action is allowed, so you do not get a
Cancel button that answers with an error.

## Install

```bash
ppm install gitlab-pipelines
```

Or from Settings > Install, searching for `gitlab-pipelines`.

To hack on it instead:

```bash
git clone git@github.com:vaiolabs-io/pulsar-gitlab-plugin.git ~/Projects/pulsar-plugin-gitlab
cd ~/Projects/pulsar-plugin-gitlab
ppm install     # one pure-JS dependency, @electron/remote
ppm link
```

Either way, reload the window afterwards (`Window: Reload`, or `ctrl-shift-F5`).

## Connect

`Packages > GitLab Pipelines > Connect To GitLab...`, or `ctrl-alt-g` then the
Connect button.

You need a **personal access token**. GitLab has exactly two useful scopes and
nothing in between:

| You want to | Scope |
| --- | --- |
| Look at pipelines, jobs, logs; check the CI file | `read_api` |
| Also run, retry, cancel, play a job, toggle a schedule | `api` |

With a `read_api` token every write button is hidden rather than broken.
Running anything also needs the **Developer** role on the project; changing a
schedule you did not create needs **Maintainer**.

### Where your token is kept

Not in `config.cson`. That file is world-readable on a normal Linux install,
and it is what people paste into bug reports.

Four choices, offered in the connect dialog:

| Choice | What happens |
| --- | --- |
| **Encrypted** (default) | Encrypted by your desktop keyring through Electron's `safeStorage`, stored in `~/.pulsar/gitlab-pipelines.json`, mode `0600`. |
| **Environment variable** | Read from `GITLAB_TOKEN` (or a name you pick). Nothing is stored. |
| **GitLab CLI** | Read from `~/.config/glab-cli/config.yml`, if you already ran `glab auth login`. Nothing is stored. |
| **Unencrypted** | Base64 in that same `0600` file. Offered, not recommended, never the default. |

The dialog tells you which storage backend your machine actually has before you
choose. On Linux, Electron reports encryption as "available" even when it is
falling back to a key hardcoded in Chromium's source; this package treats that
case as unavailable and says so, rather than pretending your token is safe.

If you start Pulsar from a desktop icon it will not see environment variables
exported by your shell.

## Self-hosted GitLab with its own certificate

The connect dialog has a **Certificates** section. In order of preference:

1. **Certificate authority file** — point it at the CA that signed your
   server's certificate. This is the correct fix.
2. **Pin the fingerprint** — for one server with a self-signed certificate:
   ```bash
   openssl s_client -connect your-gitlab:443 </dev/null 2>/dev/null \
     | openssl x509 -noout -fingerprint -sha256
   ```
3. **Skip certificate checking** — per connection, and the dialog says plainly
   what you are giving up. Anyone on the network who can answer for that
   hostname then receives your token.

There is no global "disable SSL" switch, and the package never touches
`NODE_TLS_REJECT_UNAUTHORIZED` or Electron's `--ignore-certificate-errors`:
both would turn certificate checking off for the whole editor.

## Commands

| Command | Key |
| --- | --- |
| `gitlab-pipelines:toggle` | `ctrl-alt-g` |
| `gitlab-pipelines:refresh` | `ctrl-alt-r` |
| `gitlab-pipelines:lint-ci-config` | `ctrl-alt-l` |
| `gitlab-pipelines:run-pipeline` | |
| `gitlab-pipelines:add-connection` | |
| `gitlab-pipelines:manage-connections` | |

## Settings

- **Git remote to follow** — the *name* of a remote, like `origin` or
  `monitoring`, not a URL. Leave blank and it uses the first remote whose host
  matches one of your connections, which is what you want when `origin` is a
  GitHub mirror.
- **Tell me when a pipeline finishes** — never, only on failure (the default),
  or always.
- **Clicking a pipeline in the Recent list** — shows it in the panel (the
  default), so you can read its job logs without leaving the editor, or opens
  it on GitLab in your browser. Whichever you pick, each row has its own link
  button that always opens GitLab.
- **Show pipeline status in the status bar** — the light saying whether the
  branch is green.
- **Show job progress in the status bar** — the tile counting finished and
  failed jobs.
- **Show pipeline stages in the status bar** — the dot-per-stage strip.
  Turning all three off stops all polling.

There is no polling interval setting, on purpose. See below.

## How it talks to GitLab

**It polls, every 30 seconds, and only while the Pulsar window is focused.**
It catches up immediately when you come back to the window.

Webhooks would be better but cannot work here: they need Maintainer on the
project, and a self-hosted GitLab refuses to call back to a local-network
address by default. GitLab's live-update subscriptions are internal and
undocumented. So: polling, done carefully.

The budget it is built for is 120 requests a minute — the default when an
administrator turns on rate limiting for a self-hosted instance, which is 16
times tighter than gitlab.com's allowance.

| What | How often |
| --- | --- |
| Pipeline and job list, window focused | 30s |
| Job log, while the tab is open and the job is running | 3s |
| Anything finished | stops |
| Window not focused | stops |

On failure it backs off 30s, 60s, 120s, 300s and shows one quiet "offline"
state rather than a notification per attempt. A 429 suspends every request to
that host for exactly as long as GitLab asked. An expired token stops polling
at once and asks you to reconnect.

On GitLab 19.0 and later a job log is fetched with `byte_offset`, so each poll
carries only the bytes added since the last one — that parameter does not exist
before 19.0, so older servers send the whole log and it is sliced here instead.
An `If-None-Match` header goes with the request as well, but the trace endpoint
is not known to set an `ETag`, so nothing depends on it: "nothing new" is
decided by the byte count, not by a 304.

Since GitLab Runner 18.7 every log line arrives behind a 32-byte header holding
a timestamp, the stream number and a continuation flag. It is stripped before
the log is rendered, split lines are joined back up, and the sections GitLab
marks `[collapsed=true]` open folded, matching what the GitLab web UI shows.

The panel uses one GraphQL query for the current pipeline, because REST cannot
tell you the stage order or whether an action is permitted. Everything else,
including all the write actions, is REST. If GraphQL fails — an older
self-hosted instance missing a field fails the whole query — it falls back to
REST automatically.

## Development

```bash
pulsar --test spec/          # 209 specs
```

Run it against a throwaway config directory to keep your own untouched:

```bash
ATOM_HOME=/tmp/pulsar-test pulsar --test spec/
```

Two quirks worth knowing.

In a full-suite run, whichever spec happens to run first fails with a timeout
and is then retried and passes. That is Pulsar's own harness warming up inside
the 5-second budget it sets for each spec, not this package — every spec file
passes cleanly when run on its own, and the suite exits 0.

**The spec environment answers for `require('electron').remote`; a real Pulsar
window does not** — there it is removed and throws. Never use it, and never
trust a spec that calls it. The one test guarding this asserts on the source
text of `lib/secrets.js` for exactly that reason. Use the pinned
`@electron/remote` dependency instead.

After changing code, reload the Pulsar window. Stylesheet changes apply live.

### Layout

```
lib/
  main.js               commands, lifecycle, and every decision
  connections.js        the list of instances, and the 0600 state file
  secrets.js            where the token lives, and how it is read back
  project-context.js    which repo, remote, branch and GitLab project
  poller.js             focus-aware timer, backoff, per-host throttling
  ansi.js               terminal colours and section markers
  git-remote.js         remote URL -> host and project path
  gitlab/http.js        Node https, per-connection TLS
  gitlab/client.js      the GitLab endpoints, and readable errors
  views/                dock panel, status tile, job log, connect dialog
```

## Licence

MIT
