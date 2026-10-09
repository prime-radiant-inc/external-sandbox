# Remote Sandbox

Remote Sandbox provides a common interface for running commands and working with files inside isolated Linux environments. Clients use the same HTTP and WebSocket protocol with either a v86 virtual machine or an Apple Container backend. A shared browser UI provides a terminal and a managed-network policy editor.

This repository is the project home: it contains the implementation-independent [protocol specification](SPEC.md), a Python/pytest conformance runner, the shared [Claude Code shell prefix and streaming client](claude-code/README.md), [Codex setup instructions](codex/README.md), and the [Pi extension](pi/README.md). The implementations and UI have their own repositories and release independently.

| Project | Responsibility | Local directory |
| --- | --- | --- |
| `remote-sandbox` | Protocol specification, conformance runner, agent integrations, and overall documentation | `~/dev/prime-radiant-inc/remote-sandbox` |
| [`remote-sandbox-ui`](https://github.com/prime-radiant-inc/remote-sandbox-ui) | Shared HTML, CSS, JavaScript, frontend tests, and pinned-bundle updater | `~/dev/prime-radiant-inc/remote-sandbox-ui` |
| [`remote-sandbox-v86`](https://github.com/prime-radiant-inc/remote-sandbox-v86) | TypeScript/Node.js implementation using v86 to run a Linux guest | `~/dev/prime-radiant-inc/remote-sandbox-v86` |
| [`remote-sandbox-container`](https://github.com/prime-radiant-inc/remote-sandbox-container) | Python implementation using Apple Container to run a Linux guest | `~/dev/prime-radiant-inc/remote-sandbox-container` |

The core protocol covers discovery, buffered and streaming command execution, and a Codex-compatible process/filesystem endpoint. Optional browser, mount, and managed-proxy profiles add explicit requirements. Each implementation owns its execution backend, lifecycle, file mounts, and authorization. The UI owns presentation; each server bundles a pinned UI release, injects its own branding and tokens, and serves the files from the same origin. Installed servers do not need a sibling UI checkout or Git submodules.

Choose an implementation and follow its README to start a server. Ports remain implementation-specific: the current v86 examples use 8686 and container examples use 8687. The conformance runner below targets either implementation using only its public interfaces. See [coverage and limitations](COVERAGE.md) and [historical implementation results](verification/README.md); those results describe the exact commits tested and are not a claim that every later revision has passed every profile.

The project rename changes repository, package, module, command, and documentation names. It does not change the protocol endpoints, message fields, browser WebSocket subprotocols, or proxy authentication headers in [SPEC.md](SPEC.md).

## Run against a server

Requirements: Python 3.12+, `uv`, and a dedicated running server whose guest has Bash and Python 3. The runner connects only to loopback origins. It executes commands, creates temporary guest files, and checks cancellation; do not share the target instance with an interactive session. No Codex, Claude, Pi, paid model call, or test-time Internet access is needed after installing dependencies.

```sh
uv sync --locked
uv run remote-sandbox-conformance --url http://127.0.0.1:8687 -q
```

Default **core** checks discovery, HTTP execution, streaming execution, Codex process/filesystem RPC, and access rejection. Optional profiles are explicit requirements; a missing dependency or endpoint fails rather than silently skips:

| Option | Additional checks/preconditions |
| --- | --- |
| `--profile browser` | Terminal page and browser WebSocket authorization. |
| `--profile mounts --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro` | Existing dedicated writable/read-only guest mounts, reported at those exact paths. |
| `--profile proxy-tls --proxy-tls-cert CERT --proxy-tls-key KEY` | Adds HTTPS credential substitution, echo redaction and redirect scoping; implies proxy. Requires the disposable fixture below. |
| `--profile proxy` | Proxy-enabled target; runner and server must share a host so the proxy can reach a synthetic loopback upstream. Temporarily replaces policy and restores it afterward. |

```sh
uv run remote-sandbox-conformance --url http://127.0.0.1:18787 \
  --profile browser --profile mounts --profile proxy \
  --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro \
  --report work/python.json --junitxml work/python.xml -q
```

`--deadline SECONDS` sets the per-operation deadline (default 30); pytest's per-test timeout defaults to 90 seconds. Standard pytest flags work, including `-v`, `-x`, `-k`, and `--junitxml`. JSON reports identify the target, profiles, requirements and outcomes; filtered runs are not marked fully conformant. Exit status is pytest's: 0 passed, 1 failures, 2 interrupted, 3 internal error, 4 usage error, 5 no tests. A failed report should remain a failure—do not use xfail to hide an implementation difference.

## Prepare the target

Start a dedicated implementation on an unused loopback port and wait for `/health` to report readiness. For the mounts profile, expose two temporary host directories as `/mnt/spec-rw` (writable) and `/mnt/spec-ro` (read-only). For the proxy profile, start with a deny-all policy (`{"allow": []}`); the tests supply local allow rules as needed and restore the original policy. These launch settings are implementation-specific and are not part of the wire protocol.

Shut down the dedicated server after testing. If it becomes unavailable during cleanup, guest scratch files may remain; all runner-created scratch files/directories use the `remote-sandbox-` prefix.

## Optional HTTPS proxy fixture

The HTTPS profile uses a synthetic host secret and a temporary localhost upstream certificate. Generate them with:

```sh
uv run remote-sandbox-proxy-fixture work/tls
```

Before starting the dedicated target, source `work/tls/server-env.sh` in its launch shell. This sets `REMOTE_SANDBOX_SPEC_SECRET` to a synthetic test value and supplies `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` for runtimes that support those trust settings. Other implementations must be configured to trust `work/tls/cert.pem` for upstream TLS and expose the same synthetic secret to their policy engine. This trust is scoped to the target process; do not install the certificate in the host trust store. The certificate expires after seven days; use a fresh directory to regenerate it.

Then include the profile when invoking the runner:

```sh
uv run remote-sandbox-conformance --url http://127.0.0.1:18787 \
  --profile browser --profile mounts --profile proxy-tls \
  --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro \
  --proxy-tls-cert work/tls/cert.pem --proxy-tls-key work/tls/key.pem \
  --report work/full.json -q
```

The test upstream checks the substituted Authorization value, echoes it to verify response redaction, rejects incorrect placeholders, and redirects to a disallowed path to verify that authorization is checked again. Real credentials are neither needed nor used. The runner restores the original proxy policy after each test, but cannot restore connections closed by a policy update.

## Develop and distribute

```sh
uv run pytest -q                        # Checker and client self-tests; no server needed
uv run ruff check src tests claude-code
uv build
```

The executable and full pytest suite ship in the wheel, so it also works outside the source checkout:

```sh
uvx --from /absolute/path/to/remote_sandbox-0.1.0-py3-none-any.whl \
  remote-sandbox-conformance --url http://127.0.0.1:8687 -q
```

Direct pytest invocation is also supported: `uv run pytest -p remote_sandbox.plugin src/remote_sandbox/suite --url http://127.0.0.1:8687`. Server launch flags, guest transport, sandbox internals, browser layout and backend-specific security guarantees are outside this wire contract.
