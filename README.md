# exec-server-spec

A compact [wire specification](SPEC.md) and independent Python/pytest conformance runner for `v86-shell-server` and `sandbox-exec-server`. Tests use only public HTTP/WebSocket interfaces and can target any implementation of the contract. See [coverage and limitations](COVERAGE.md).

## Run against a server

Requirements: Python 3.12+, `uv`, and a dedicated running server whose guest has Bash and Python 3. The runner connects only to loopback origins. It executes commands, creates temporary guest files, and checks cancellation; do not share the target instance with an interactive session. No Codex, Claude, Pi, paid model call, or test-time Internet access is needed after installing dependencies.

```sh
uv sync --locked
uv run exec-server-conformance --url http://127.0.0.1:8687 -q
```

Default **core** checks discovery, HTTP execution, streaming execution, Codex process/filesystem RPC, and access rejection. Optional profiles are explicit requirements; a missing dependency or endpoint fails rather than silently skips:

| Option | Additional checks/preconditions |
| --- | --- |
| `--profile browser` | Terminal page and browser WebSocket authorization. |
| `--profile mounts --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro` | Existing dedicated writable/read-only guest mounts, reported at those exact paths. |
| `--profile proxy` | Proxy-enabled target; runner and server must share a host so the proxy can reach a synthetic loopback upstream. Temporarily replaces policy and restores it afterward. |

```sh
uv run exec-server-conformance --url http://127.0.0.1:18787 \
  --profile browser --profile mounts --profile proxy \
  --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro \
  --report work/python.json --junitxml work/python.xml -q
```

`--deadline SECONDS` sets the per-operation deadline (default 30); pytest's per-test timeout defaults to 90 seconds. Standard pytest flags work, including `-v`, `-x`, `-k`, and `--junitxml`. JSON reports identify the target, profiles, requirements and outcomes; filtered runs are not marked fully conformant. Exit status is pytest's: 0 passed, 1 failures, 2 interrupted, 3 internal error, 4 usage error, 5 no tests. A failed report should remain a failure—do not use xfail to hide an implementation difference.

## Start dedicated instances of our two implementations

From this repository, prepare empty test mounts and a deny-all proxy policy:

```sh
mkdir -p work/rw work/ro
printf 'read-only fixture\n' > work/ro/conformance.txt
printf '{"allow": []}\n' > work/proxy.json
SPEC_DIR="$PWD"
```

In a separate terminal, start the Python server (Apple Container must already be running and `python:3.13-slim` available):

```sh
cd ../sandbox-exec-server
uv run sandbox-exec-server --port 18787 \
  --mount-rw "spec-rw=$SPEC_DIR/work/rw" \
  --mount-ro "spec-ro=$SPEC_DIR/work/ro" \
  --proxy-config "$SPEC_DIR/work/proxy.json"
```

Or start the Node server in another terminal:

```sh
cd ../v86-shell-server/outputs/v86-shell-server
npm ci
npm run build
node dist/cli.js --port 18786 \
  --mount-rw "spec-rw=$SPEC_DIR/work/rw" \
  --mount-ro "spec-ro=$SPEC_DIR/work/ro" \
  --proxy-config "$SPEC_DIR/work/proxy.json"
```

Set `SPEC_DIR` to this repository's absolute path in each terminal; shell variables do not carry into an unrelated terminal. Wait until the server reports readiness, then use the full test command above with the matching port. Ports are examples; choose unused ones. Shut down these dedicated servers with Ctrl-C when done. On failure, temporary files may remain if the server is unavailable during cleanup; all runner-created files use the `exec-server-spec-` prefix.

## Develop and distribute

```sh
uv run pytest -q                        # Checker self-tests; no server needed
uv run ruff check src tests
uv build
```

The executable and full pytest suite ship in the wheel, so it also works outside the source checkout:

```sh
uvx --from /absolute/path/to/exec_server_spec-0.1.0-py3-none-any.whl \
  exec-server-conformance --url http://127.0.0.1:8687 -q
```

Direct pytest invocation is also supported: `uv run pytest -p exec_server_spec.plugin src/exec_server_spec/suite --url http://127.0.0.1:8687`. `SPEC.md` records the contract derived from v86 commit `93e2d9a` and Python commit `94d5878`; server CLI flags, VM/container internals, browser layout and backend-specific security guarantees are outside the common wire contract.
