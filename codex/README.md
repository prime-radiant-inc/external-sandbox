# Codex with External Sandbox

Run Codex on the host and route its process and filesystem operations to any External Sandbox backend through `/codex`. Commands run inside the Linux guest, and native `apply_patch` uses the guest filesystem and the backend's mount permissions. No Codex installation inside the guest or Claude shell-prefix client is needed.

This guide preserves the configuration tested with **Codex CLI 0.164.0**. Its exec-server protocol and environment selection are experimental; newer CLI versions need a compatibility check. The [official CLI reference](https://developers.openai.com/codex/cli/reference/) describes current general commands, but does not establish compatibility with this version-specific executor configuration.

## Start a backend

Install or build the backend using its repository README, then start it with a writable project and optional read-only reference directory. Choose one:

```sh
# v86, with its CLI installed
external-sandbox-v86 --port 8686 --preserve-paths \
  --mount-rw project=/absolute/path/to/project \
  --mount-ro reference=/absolute/path/to/reference

# Apple Container, from its checkout
uv run external-sandbox-container --port 8687 --preserve-paths \
  --mount-rw project=/absolute/path/to/project \
  --mount-ro reference=/absolute/path/to/reference

# Quicksand, from its checkout
uv run external-sandbox-quicksand --port 8688 --preserve-paths \
  --mount-rw project=/absolute/path/to/project \
  --mount-ro reference=/absolute/path/to/reference
```

For v86 from source, run `npm run build` in `external-sandbox-v86/outputs/external-sandbox-v86`, then substitute `node dist/cli.js` for the installed command. For the container or Quicksand backend from elsewhere, use `uv run --project /absolute/path/to/external-sandbox-container external-sandbox-container` or the matching `external-sandbox-quicksand` checkout and command. Replace the example paths with existing absolute host directories; omit the reference mount if unused.

`--preserve-paths` exposes each mounted host path at the same absolute path inside the guest, so Codex's working directory resolves there. Mounts and network policy remain backend responsibilities: see [v86](https://github.com/prime-radiant-inc/external-sandbox-v86), [container](https://github.com/prime-radiant-inc/external-sandbox-container) and [Quicksand](https://github.com/prime-radiant-inc/external-sandbox-quicksand) for their guarantees and options. Guest networking is disabled by default; use the selected backend's `--proxy-config` option when commands need approved network access.

| Backend | Executor URL |
| --- | --- |
| v86 | `ws://127.0.0.1:8686/codex` |
| Apple Container | `ws://127.0.0.1:8687/codex` |
| Quicksand | `ws://127.0.0.1:8688/codex` |

## Configure a dedicated Codex home

CLI 0.164.0 reads `$CODEX_HOME/environments.toml`, normally `~/.codex/environments.toml`. Create a separate home for External Sandbox so choosing this executor is explicit for each invocation:

```sh
mkdir -p "$HOME/.codex-external-sandbox"
```

Create `$HOME/.codex-external-sandbox/environments.toml` with the following content. Select the URL from the table above; this example selects v86:

```toml
default = "external-sandbox"
include_local = false

[[environments]]
id = "external-sandbox"
url = "ws://127.0.0.1:8686/codex"
connect_timeout_sec = 5
initialize_timeout_sec = 10
```

For Apple Container, change the URL port to `8687`; for Quicksand, `8688`. For any other port, update both the server command and this URL. Use separate dedicated homes if you want to keep configurations for several backends. The file format is TOML, with top-level settings before `[[environments]]`.

`include_local = false` and the single environment entry make only this remote executor available. In the tested CLI, `default` alone does not exclude other registered executors. There is no `--environment` selector; `--profile` and `-c` configure `config.toml`, not this separate file. `CODEX_EXEC_SERVER_URL` is ignored when `environments.toml` exists.

The dedicated home has its own settings, authentication and session history. Authenticate it once using your usual login method, then add any needed model/provider settings to its `config.toml`:

```sh
CODEX_HOME="$HOME/.codex-external-sandbox" codex login
```

## Launch Codex

With the selected server running, start an interactive session:

```sh
CODEX_HOME="$HOME/.codex-external-sandbox" codex --sandbox danger-full-access \
  -c features.shell_snapshot=false \
  -c features.unified_exec_tty=false \
  --cd /absolute/path/to/project
```

For a non-interactive run:

```sh
CODEX_HOME="$HOME/.codex-external-sandbox" codex exec --sandbox danger-full-access \
  -c features.shell_snapshot=false \
  -c features.unified_exec_tty=false \
  --cd /absolute/path/to/project \
  'Run uname -s and pwd, then inspect this project.'
```

The command should report Linux and the mounted project path. Keep the `CODEX_HOME` assignment with these launch commands: it loads the configuration that excludes the local executor. The assignment applies to that invocation only; ordinary Codex launches continue to use your usual home.

Here `danger-full-access` requests execution without an additional Codex platform sandbox inside the guest. The selected backend still enforces its mount and network policy. Extra Codex sandbox requirements, PTYs and executor-owned shell snapshots are unsupported and return errors, which is why the two feature flags are disabled above.

Codex, its authentication, model requests and host extensions continue running on the host. This integration routes the executor's process and filesystem operations; it does not relocate every host extension. Guest processes do not implicitly inherit host environment variables.

In CLI 0.164.0, the TUI's `!command` shortcut requires a local environment and fails in this remote-only configuration; it can terminate the TUI. Ask Codex to run a command through its execution tool, or use the backend's browser terminal. The `/codex` endpoint speaks exec-server RPC; it is not a Codex app-server endpoint for `codex --remote` or `thread/shellCommand`.

## Verification and protocol

The [protocol specification](../SPEC.md) defines the common `/codex` process and filesystem contract, limits and unsupported capabilities. The [conformance runner](../README.md#run-against-a-server) checks that contract against any running backend without a model call. These checks do not by themselves prove compatibility with every Codex CLI release.

Backend compatibility tests also exercise a real Codex CLI with deterministic local model responses, including native `apply_patch` on writable and read-only mounts. See the [v86 protocol and test notes](https://github.com/prime-radiant-inc/external-sandbox-v86/blob/main/outputs/external-sandbox-v86/docs/codex-protocol.md), the [container demo verification](https://github.com/prime-radiant-inc/external-sandbox-container/blob/main/docs/demo.md#verification) and the [Quicksand verification](https://github.com/prime-radiant-inc/external-sandbox-quicksand/blob/main/docs/verification.md) for their test commands and prerequisites. Recheck those tests before changing the CLI version used with this guide.
