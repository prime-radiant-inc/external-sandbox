# exec-server-spec

A compact [wire specification](SPEC.md) and independent Python/pytest conformance runner for localhost sandbox execution services. Tests use only public HTTP/WebSocket interfaces and can target any implementation of the contract. See [coverage and limitations](COVERAGE.md).

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
| `--profile proxy-tls --proxy-tls-cert CERT --proxy-tls-key KEY` | Adds HTTPS credential substitution, echo redaction and redirect scoping; implies proxy. Requires the disposable fixture below. |
| `--profile proxy` | Proxy-enabled target; runner and server must share a host so the proxy can reach a synthetic loopback upstream. Temporarily replaces policy and restores it afterward. |

```sh
uv run exec-server-conformance --url http://127.0.0.1:18787 \
  --profile browser --profile mounts --profile proxy \
  --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro \
  --report work/python.json --junitxml work/python.xml -q
```

`--deadline SECONDS` sets the per-operation deadline (default 30); pytest's per-test timeout defaults to 90 seconds. Standard pytest flags work, including `-v`, `-x`, `-k`, and `--junitxml`. JSON reports identify the target, profiles, requirements and outcomes; filtered runs are not marked fully conformant. Exit status is pytest's: 0 passed, 1 failures, 2 interrupted, 3 internal error, 4 usage error, 5 no tests. A failed report should remain a failure—do not use xfail to hide an implementation difference.

## Prepare the target

Start a dedicated implementation on an unused loopback port and wait for `/health` to report readiness. For the mounts profile, expose two temporary host directories as `/mnt/spec-rw` (writable) and `/mnt/spec-ro` (read-only). For the proxy profile, start with a deny-all policy (`{"allow": []}`); the tests supply local allow rules as needed and restore the original policy. These launch settings are implementation-specific and are not part of the wire protocol.

Shut down the dedicated server after testing. If it becomes unavailable during cleanup, guest scratch files may remain; all runner-created scratch files/directories use the `exec-server-spec-` prefix.

## Optional HTTPS proxy fixture

The HTTPS profile uses a synthetic host secret and a temporary localhost upstream certificate. Generate them with:

```sh
uv run exec-server-proxy-fixture work/tls
```

Before starting the dedicated target, source `work/tls/server-env.sh` in its launch shell. This sets `EXEC_SERVER_SPEC_SECRET` to a synthetic test value and supplies `SSL_CERT_FILE` / `NODE_EXTRA_CA_CERTS` for runtimes that support those trust settings. Other implementations must be configured to trust `work/tls/cert.pem` for upstream TLS and expose the same synthetic secret to their policy engine. This trust is scoped to the target process; do not install the certificate in the host trust store. The certificate expires after seven days; use a fresh directory to regenerate it.

Then include the profile when invoking the runner:

```sh
uv run exec-server-conformance --url http://127.0.0.1:18787 \
  --profile browser --profile mounts --profile proxy-tls \
  --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro \
  --proxy-tls-cert work/tls/cert.pem --proxy-tls-key work/tls/key.pem \
  --report work/full.json -q
```

The test upstream checks the substituted Authorization value, echoes it to verify response redaction, rejects incorrect placeholders, and redirects to a disallowed path to verify that authorization is checked again. Real credentials are neither needed nor used. The runner restores the original proxy policy after each test, but cannot restore connections closed by a policy update.

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

Direct pytest invocation is also supported: `uv run pytest -p exec_server_spec.plugin src/exec_server_spec/suite --url http://127.0.0.1:8687`. Server launch flags, guest transport, sandbox internals, browser layout and backend-specific security guarantees are outside this wire contract.
