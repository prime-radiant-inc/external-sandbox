# Claude Code shell prefix

One shared shell prefix and streaming client for [External Sandbox v86](https://github.com/prime-radiant-inc/external-sandbox-v86), [External Sandbox Container](https://github.com/prime-radiant-inc/external-sandbox-container), and [External Sandbox Quicksand](https://github.com/prime-radiant-inc/external-sandbox-quicksand). The wrapper sends Claude's complete command to the chosen server's `/exec/ws` endpoint without evaluating or reconstructing it on the host. The server executes it inside its Linux guest. This folder is the source of truth; backend packages do not include their own copies.

## Get the client

The streaming wrapper requires macOS or Linux, `uv` on the host, and Python 3.11 or later. Its inline script metadata pins `websockets==17.0.1`; `uv` prepares the Python environment on first use. The running guest needs Bash and whatever tools your commands use. The optional buffered wrapper requires Node.js 22 or later instead of Python/uv.

Clone this repository, or use an existing checkout:

```sh
git clone https://github.com/prime-radiant-inc/external-sandbox.git
PREFIX_DIR="$(cd external-sandbox/claude-code && pwd)"
```

Keep `claude-shell-prefix.sh` beside `external_sandbox_exec.py`. For the buffered alternative, keep `claude-shell-prefix-http.sh` beside `api-exec.mjs`. You can copy this folder elsewhere while preserving executable permissions. These files are used directly from the folder; installing the conformance-runner wheel does not install a shell-prefix command.

With a server running and a project mounted, warm the streaming client's dependency and check the connection. Select the v86 server on port 8686, the container server on port 8687, or the Quicksand server on port 8688 explicitly:

```sh
# v86 server
EXTERNAL_SANDBOX_API_URL=http://127.0.0.1:8686 EXTERNAL_SANDBOX_CWD=/mnt/project \
  "$PREFIX_DIR/claude-shell-prefix.sh" --no-stdin 'uname -m; pwd'

# Apple Container server
EXTERNAL_SANDBOX_API_URL=http://127.0.0.1:8687 EXTERNAL_SANDBOX_CWD=/mnt/project \
  "$PREFIX_DIR/claude-shell-prefix.sh" --no-stdin 'uname -m; pwd'

# Quicksand server
EXTERNAL_SANDBOX_API_URL=http://127.0.0.1:8688 EXTERNAL_SANDBOX_CWD=/mnt/project \
  "$PREFIX_DIR/claude-shell-prefix.sh" --no-stdin 'uname -m; pwd'
```

## Launch Claude with any backend

Build or install your chosen server using its own README first. Start it with the project writable and its absolute host path preserved inside the guest. From the project directory, use one of these examples in a separate terminal:

```sh
# v86: V86_APP points to its built application directory.
V86_APP=/absolute/path/to/external-sandbox-v86
node "$V86_APP/dist/cli.js" --port 8686 --preserve-paths --mount-rw "project=$PWD"

# Apple Container: CONTAINER_APP points to its checkout.
CONTAINER_APP=/absolute/path/to/external-sandbox-container
uv run --project "$CONTAINER_APP" external-sandbox-container \
  --port 8687 --preserve-paths --mount-rw "project=$PWD"

# Quicksand: QUICKSAND_APP points to its checkout.
QUICKSAND_APP=/absolute/path/to/external-sandbox-quicksand
uv run --project "$QUICKSAND_APP" external-sandbox-quicksand \
  --port 8688 --preserve-paths --mount-rw "project=$PWD"
```

From that same project directory in your Claude terminal:

```sh
PREFIX_DIR=/absolute/path/to/external-sandbox/claude-code
mkdir -p .external-sandbox-claude-tmp
CLAUDE_CODE_SHELL=/bin/bash \
CLAUDE_CODE_TMPDIR="$PWD/.external-sandbox-claude-tmp" \
CLAUDE_CODE_SHELL_PREFIX="$PREFIX_DIR/claude-shell-prefix.sh" \
EXTERNAL_SANDBOX_API_URL=http://127.0.0.1:8686 \
claude
```

Use port 8687 for the container backend or 8688 for Quicksand. The temporary directory must be inside the writable mount: Claude creates a user-specific subdirectory there and includes cwd bookkeeping in the command passed to the prefix. Preserving the project and temporary-directory absolute paths lets those commands refer to the same files from the host and guest. Add `.external-sandbox-claude-tmp/` to your project's ignore file if desired. Setting only `EXTERNAL_SANDBOX_CWD` does not translate absolute paths embedded in a command.

The prefix receives exactly one complete command argument; the streaming client also accepts `--no-stdin` before that argument for manual use. Quoting, multiline commands, shell expansion, and Claude's setup/bookkeeping remain part of that unchanged command and are interpreted by the guest shell. According to [Claude's environment-variable documentation](https://code.claude.com/docs/en/env-vars), the prefix also applies to other shell invocations such as shell hooks, status-line commands, and stdio MCP startup commands. Claude and its model connection stay on the host; native file tools such as Read/Edit still access host files. This integration does not change their permissions.

## Settings and behavior

Both clients use the following environment variables. Each accepts the matching historical `V86_*` name as a fallback when its `EXTERNAL_SANDBOX_*` variable is unset. An explicitly set new value always wins, including an empty value that subsequently fails validation.

| Variable | Behavior |
| --- | --- |
| `EXTERNAL_SANDBOX_API_URL` | Default `http://127.0.0.1:8686`. The streaming client accepts an HTTP or WS loopback origin; the buffered client accepts HTTP only. No credentials, non-root path, query, fragment, or redirects. |
| `EXTERNAL_SANDBOX_CWD` | Explicit absolute guest directory. Otherwise `/mounts` maps the host cwd using a preserved absolute path or the deepest matching host mount. Unmapped directories fail before execution. |
| `EXTERNAL_SANDBOX_TIMEOUT_MS` | Default 120,000 milliseconds; allowed range 1–300,000. |
| `EXTERNAL_SANDBOX_MAX_OUTPUT_BYTES` | Optional combined stdout/stderr limit, 1–16,777,216 bytes; omitted by default so the server chooses its default. |
| `EXTERNAL_SANDBOX_FORWARD_STDIN` | Streaming defaults to enabled; `0` disables it. Buffered input is disabled unless this value is `1`. |

Streaming stdout and stderr are written to their corresponding local streams as bytes arrive. Stdin is byte-preserving, sent in acknowledged chunks of at most 32 KiB, and followed by EOF when local stdin closes. The client exits promptly when the command ends even if its parent still keeps stdin open. These are pipes, not a PTY; full-screen terminal programs require a different interface.

```sh
# From a mapped project directory, stream binary input and output.
cat input.bin | "$PREFIX_DIR/claude-shell-prefix.sh" 'cat' > output.bin

# Run without forwarding input.
"$PREFIX_DIR/claude-shell-prefix.sh" --no-stdin 'printf "stdout\n"; printf "stderr\n" >&2; exit 7'
```

The client returns the guest's exit status, `128 + signal` for signal termination, 124 for timeout, and 125 for an output cap, invalid input, or transport/protocol failure. Local SIGHUP, SIGINT, and SIGTERM cancel the streaming command and return the corresponding signal status. The client does not invoke Claude or a model; the examples above can test the connection directly.

## Buffered alternative

`claude-shell-prefix-http.sh` uses the legacy `/exec` API through `api-exec.mjs`. Point `CLAUDE_CODE_SHELL_PREFIX` at that file if you specifically need buffered HTTP. It preserves the same complete-command argument and cwd mapping, but emits UTF-8 text only after command completion. Forwarded stdin requires `EXTERNAL_SANDBOX_FORWARD_STDIN=1`, must be valid UTF-8, and is capped at 32 KiB. Use the streaming wrapper for incremental or arbitrary binary data.

## Tests

From the repository root, run the migrated client and wrapper tests:

```sh
uv run pytest claude-code/tests -q
node --test claude-code/tests/*.test.mjs
```

The Python tests exercise real client subprocesses against disposable loopback WebSocket fixtures, plus a fake `uv` executable to check argument and environment forwarding. The plain Node.js tests exercise the buffered wrapper against disposable HTTP fixtures. They cover exact command forwarding, mount selection, settings and legacy aliases, streaming before stdin, binary data and backpressure, EOF, cancellation, errors, redirects, limits, and exit statuses. No sandbox VM, Apple Container, Claude process, or model call is required. The repository's normal `uv run pytest` command includes the Python tests; no npm dependencies are needed for the Node.js tests.

Backend compatibility tests can explicitly select these shared files using `EXTERNAL_SANDBOX_CLIENT=/absolute/path/to/external_sandbox_exec.py` and, where a wrapper is tested, `EXTERNAL_SANDBOX_PREFIX=/absolute/path/to/claude-shell-prefix.sh`. Those are test-harness paths, separate from the runtime settings above; see each backend's test instructions. The shared clients originated in the v86 backend, with settings/wrapper coverage also migrated from the container backend.
