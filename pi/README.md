# Pi integration for External Sandbox

Run Pi's `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` tools through the shared External Sandbox WebSocket API. Both `!command` and `!!command` use the same remote execution route. Pi, its model connection, and its session files stay on the host. The extension belongs to this repository's `pi/` directory and uses no backend's implementation code.

Tested with `@earendil-works/pi-coding-agent` **0.85.1**, Node.js 26, the v86 server on port **8686**, the Apple Container server on port **8687**, and the Quicksand server on port **8688**. Node.js **22.19 or newer** is required. The guest needs Bash and Python **3.12+**; `find` and `grep` also require `rg`. The container backend's [developer image](https://github.com/prime-radiant-inc/external-sandbox-container/blob/main/examples/Containerfile), commonly tagged `sandbox-demo:latest`, the Quicksand backend's default Alpine image, and the v86 backend's bundled image include all three. The container backend's minimal default Python image does not include ripgrep.

## Try it

Start any server with the project mounts and network policy you need:

| Backend | URL |
| --- | --- |
| [external-sandbox-container](https://github.com/prime-radiant-inc/external-sandbox-container) | `http://127.0.0.1:8687` |
| [external-sandbox-v86](https://github.com/prime-radiant-inc/external-sandbox-v86) | `http://127.0.0.1:8686` |
| [external-sandbox-quicksand](https://github.com/prime-radiant-inc/external-sandbox-quicksand) | `http://127.0.0.1:8688` |

The default remains port `8687` for compatibility. Select a backend explicitly with `--sandbox-url`. From this `pi/` directory, connect to the container backend:

```sh
npm ci --ignore-scripts
./node_modules/.bin/pi --no-extensions --no-builtin-tools \
  -e ./index.ts --sandbox-url http://127.0.0.1:8687
```

For v86 or Quicksand, use the same command with `--sandbox-url http://127.0.0.1:8686` or `--sandbox-url http://127.0.0.1:8688`.

Pi uses its usual provider configuration. Select/authenticate a model in Pi if needed. The extension requires no model API key of its own.

The `--no-extensions` option disables automatic extension discovery; explicit `-e ./index.ts` still loads this extension. `--no-builtin-tools` prevents local built-in tools being enabled if this extension is missing. **Check that Pi shows `Sandbox: ...` in the status bar and no extension loading errors before using it.** Pi's manual `!` shell is independent of that built-in-tools flag.

Try these manual commands:

```text
!uname -s; pwd
!node --version; uv --version; rg --version
!curl -I https://example.com
```

Or ask the model: “Create hello.py, run it, then find and edit its greeting.” Changes go to the guest, or through to the host when the server has a writable project mount. `!!command` also runs remotely but excludes its output from model context, following Pi's normal behavior.

To choose a directory already present inside the guest:

```sh
./node_modules/.bin/pi --no-extensions --no-builtin-tools \
  -e ./index.ts --sandbox-url http://127.0.0.1:8687 \
  --sandbox-cwd /mnt/project --sandbox-timeout 120
```

Without `--sandbox-cwd`, the extension uses `/health`'s `defaultCwd`, normally `/workspace` or the server's first mounted directory. Relative tool paths and `!` commands use that guest cwd regardless of Pi's host cwd. Absolute file paths under advertised host mount roots map to the corresponding guest paths; other absolute paths are interpreted inside the guest. `~` uses the guest's `HOME`. Shell command text is passed unchanged, so use guest paths in commands.

## Behavior

- Shell output streams through `/exec/ws`; cancellation closes the connection and asks the server to stop the process group. A lost connection, protocol error, timeout, or output cap is an error, never a request to execute locally.
- The command timeout defaults to 120 seconds and can be set up to 300 seconds. There is a hard 16 MiB combined output cap. Each command starts a fresh Bash process, with no PTY. Files remain for the lifetime of the sandbox, and writable host mounts persist according to the backend.
- Agent Bash results show the last 2,000 lines or 50 KiB. Overflow logs are written to `/tmp/pi-sandbox-*.log` **inside the guest**, where `read` and `bash` can access them. Manual shell output streams a bounded prefix, then displays a tail and guest log path for longer output, preventing Pi from creating a host-only overflow log.
- Read supports text offsets/limits and PNG, JPEG, GIF, WebP, and BMP images. Images are returned without resizing. Whole-file reads are limited to 12 MiB minus 4 KiB; use shell commands for portions of larger files.
- Edit uses Pi's normal exact-replacement and diff implementation with remote reads/writes. Searches execute guest ripgrep; no host `rg` or `fd` is launched.
- The server supplies proxy variables, CA settings, and credential placeholders. Host environment variables and Pi's provider credentials are never forwarded. Network allow-listing and credential substitution continue to happen in the existing host proxy and can be inspected at `/proxy`.
- The extension attaches to an existing server. It does not create, stop, or reconfigure the sandbox. Closing Pi cancels its active commands; the server remains available to the browser, Codex, and Claude Code.

## Execution boundary

Seven remote tools are enabled; PowerShell is explicitly rejected. The `tool_call` hook blocks other model tools while this extension is active. Use the explicit isolated launch command above to avoid other tool overrides.

Pi **0.85.1** catches exceptions thrown by `user_bash` hooks and can subsequently run commands locally. Our hook always synchronously returns a fixed remote operations object. All configuration checks and network failures occur inside that object, after Pi has selected the execution backend. Tests cover invalid URLs and unreachable servers through the actual Pi RPC CLI.

This routes coding tools; it does not sandbox the Pi process. Pi still loads host configuration, context files, skills, and attachments, stores sessions on the host, and contacts its model provider directly. Other extensions are host code and can call Node APIs or `pi.exec()` themselves. Model tools in this extension cannot directly read arbitrary host files; writable mounts remain intentional access to the directories selected when starting the server.

## Share it

The `external-sandbox-pi` package is a normal Pi extension with an `index.ts` entry point. It can be installed from its directory using `pi install /absolute/path/to/external-sandbox/pi`, or distributed as an npm package. Its runtime dependencies are `ws` and the Pi SDK peer dependency; the development lockfile pins Pi 0.85.1.

To create an npm tarball:

```sh
npm pack
```

An extracted tarball can be used with `npm install --ignore-scripts` followed by the explicit `pi -e ./index.ts` launch shown above. No backend bundles or installs this separate Node package.

## Verification

```sh
npm test
EXTERNAL_SANDBOX_PI_TEST_URL=http://127.0.0.1:8687 npm run test:integration
```

`SANDBOX_PI_TEST_URL` remains a fallback alias for existing integration-test scripts; `EXTERNAL_SANDBOX_PI_TEST_URL` takes precedence. To test v86 or Quicksand, select port `8686` or `8688`; a v86 guest must also have the required utilities.

Unit tests exercise malformed frames, stdin flow control, cancellation, bounded output, no fallback, guest paths, and helper behavior. Guest-helper unit tests use `uv run` with a disposable local fixture and require local `rg`. They run under uv's default Python and also under Python 3.12 when uv has it installed. A comparison test checks the helper's glob matching against `PurePosixPath.full_match` when uv has Python 3.13 or newer installed. Integration tests use temporary guest files and the actual Pi 0.85.1 RPC CLI, exercise all seven tools and manual shell routing, and make no paid model calls. They do not change the server or proxy configuration.

The recorded live integration tests use Apple Container and Quicksand. The shared protocol permits any backend; this verification does not claim a live Pi run against v86.

The relocation to `external-sandbox/pi` passed 51 unit tests and 12 integration tests on 9 October 2026. The integration run used the actual Pi 0.85.1 RPC CLI and a temporary Apple Container server with `sandbox-demo:latest`, then removed its guest fixtures and stopped the temporary server. `npm pack --dry-run` confirmed that the distributable contains the entry point, three runtime modules, package metadata, and this README.

On 9 October 2026, 53 unit tests passed, including the guest-helper fixture under Python 3.12 and the glob comparison over 544 path/pattern pairs. The 12 integration tests passed against a temporary [external-sandbox-quicksand](https://github.com/prime-radiant-inc/external-sandbox-quicksand) server using its default Alpine image, whose guest runs Python 3.12, with ripgrep and the example public-site proxy policy.
