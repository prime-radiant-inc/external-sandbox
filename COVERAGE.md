# Conformance coverage

Each test carries `@pytest.mark.contract("ID")` referring to [PROTOCOL.md](PROTOCOL.md). Parameterized cases exercise different invalid inputs. Assertions match required fields and values while allowing extra response fields, variable chunk boundaries, directory ordering, timing, and backend identities.

| ID | Coverage | Test module |
| --- | --- | --- |
| T1 | Discovery, mount schema, response headers, loopback Host and cross-origin rejection | `test_http`, `test_access` |
| H1 | Exact text streams, nonzero exit, stdin/EOF, env/cwd, UTF-8 replacement, fresh shells and persistent files | `test_http` |
| H2 | Validation/type/size boundaries, malformed JSON/UTF-8, media type/compression, routing, explicit backend errors and recovery | `test_http` |
| H3 | Timeout and output-cap termination | `test_http` |
| H4 | Independent concurrent commands and HTTP disconnect cancellation | `test_http` |
| S1–S2 | Output before input, binary streams, >32 KiB incremental input, acknowledgements, EOF, ordering and final close | `test_stream` |
| S3–S5 | Cancellation, timeouts/output caps, protocol errors, repeated IDs/start, closed stdin, disconnect cleanup and start deadline | `test_stream` |
| C1 | Initialization state machine, environment metadata, error recovery and resume rejection | `test_codex` |
| C2 | Literal argv, arg0, environment policy/secret stripping, binary notifications and replay cursor; independent processes in one session | `test_codex` |
| C3–C5 | Input write deduplication/status, signals/termination, disconnect, duplicate IDs and unsupported parameters | `test_codex` |
| F1–F2 | Binary read/write/truncate, metadata/list/canonicalize, immutable snapshots, offsets, idempotent close and session isolation | `test_filesystem` |
| F3–F5 | Recursive directories/copy/remove/walk, executable bits, truncation/pruning, symlinks, invalid URIs and explicit errors | `test_filesystem` |
| L1 | Output replay eviction is reported; body/field/input/output caps also covered above | `test_codex` |
| B1–B2 | Browser page headers, token acquisition and handshake, Origin/Fetch Metadata and legacy route access checks | `test_access` (browser profile) |
| M1 | Live shell/RPC writable mount round trips and read-only creation denial | `test_mounts` (mounts profile) |
| P1 | Token/origin checks, JSON/media/body validation, atomic rejection, valid live edits, guestEnv restart requirement | `test_proxy` (proxy profile) |
| P4 | Real guest HTTPS, exact header substitution using a synthetic host secret, wrong-placeholder denial, secret-echo/activity redaction, redirect reauthorization | `test_proxy` (proxy-tls profile) |
| P2–P3 | Real guest HTTP through same-host upstream, origin/method/path/private-address policy, denial after update, existing stream revocation, direct-connect rejection and sanitized activity | `test_proxy` (proxy profile) |

The proxy tests restore the original policy in teardown, including after assertion failures. Applying a policy closes active upstream connections; use a dedicated test server. The local upstream binds an ephemeral loopback port and uses synthetic content. No external Internet request or real secret is required. File tests create UUID-named guest scratch directories and mount files, and clean them up. They do not import implementation code, invoke a coding model, or test a mocked backend in place of the real endpoint.

Coverage is intentionally not exhaustive: TLS credential substitution and secret-echo redaction are covered only with the explicit proxy-tls profile. Every CIDR/DNS case, every resource-exhaustion ceiling, scheduler race, envPolicy combination, filesystem permission combination and nonconforming upstream TLS scenario is not exhaustively exercised. A green result is scoped to the selected profiles and listed checks, not a security certification. JSON reports state profiles, selection completeness, test outcomes and requirement IDs; `conforms` is false for failed, empty, collected-only or filtered runs. Normal pytest exit codes are preserved.

The harness has separate self-tests proving that malformed base64, invalid result shapes, premature socket closure, out-of-order output, mismatched RPC IDs and RPC error replies produce failures rather than success.
