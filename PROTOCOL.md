# External Sandbox protocol, revision 1

An External Sandbox server is a localhost service that runs a coding agent's commands inside an isolated Linux guest. This document defines what such a server must do, as seen from the outside. It covers:

- a buffered shell API and a streaming shell API,
- a Codex-compatible process and filesystem endpoint, which follows the experimental exec-server wire format of Codex CLI 0.164.0,
- and three optional profiles: a browser terminal, host directory mounts, and a managed HTTP(S) proxy.

The specification describes observable behavior only. It says nothing about the server's language, its implementation, or the sandbox technology behind it, which is why one conformance suite can test a v86 virtual machine, an Apple container and a QEMU guest alike.

## How to read this document

- **MUST** marks a conformance requirement. **MAY** marks a point where implementations are free to differ.
- Each section heading carries one or more requirement IDs in brackets, such as `[H1–H4]`. The letter names the area and the number splits it into separately testable claims: T is transport, H the buffered HTTP shell, S the streaming WebSocket shell, C the Codex session, F the Codex filesystem, B browser access, M mounts, P the proxy and L resource limits. The IDs are only given at section level here; `COVERAGE.md` says what each one covers and names the conformance test that checks it, and every test in the suite is tagged with its ID through `@pytest.mark.contract`.
- "Revision 1" names this document and its test contract. There is no wire-level version negotiation field.
- Default ports, error wording and other details called out as unspecified are implementation choices.

## 1. Transport and profiles [T1]

### Transport and encoding

- The server listens on loopback HTTP, and every endpoint shares one base URL. Default ports are implementation choices.
- JSON is UTF-8. Binary payloads are canonical, padded RFC 4648 base64.
- Strings MUST NOT contain NUL unless a field explicitly allows it.
- Integer fields accept any mathematically integral JSON number within the documented range. Booleans are never accepted as numbers.

### What a client may and may not rely on

- Clients MUST ignore response fields they do not recognize.
- Clients MUST NOT depend on object key order, on where output chunks are split, on the wording of error messages, or on the order in which directories are listed.
- Clients MUST keep stdout and stderr separate.
- An error MUST NOT be treated as a successful empty result.

### Profiles

The **core** profile is discovery, buffered shell execution, streaming shell execution, Codex process and filesystem RPC, and the local access checks. Three further profiles are selected explicitly: **browser**, **mounts** and **proxy**. A fourth, **proxy-tls**, extends proxy with TLS and credential checks against a disposable, trusted upstream fixture.

Once a profile is selected, a missing endpoint or a failed prerequisite is a test failure, not a skip.

The protocol deliberately does not promise that different backends share the same guest architecture, UID, image contents, filesystem metadata precision, performance, or host mount semantics.

### Endpoints

| Method and path | Contract |
| --- | --- |
| `GET /health` | `{status:"ready", backend:string, architecture:string, shell:string, defaultCwd:string, activeCommands:integer, mounts:[Mount], ...}`. `activeCommands` is nonnegative. |
| `GET /mounts` | `{mounts:[Mount]}`, consistent with `/health`. |
| `POST /exec` | Buffered shell request and result (section 2). |
| WebSocket `/exec/ws` | One streaming shell execution per connection (section 3). |
| WebSocket `/codex` | A multiplexed Codex process and filesystem session (sections 4 and 5). |
| `GET /`, `GET /terminal.js` | The browser terminal and its script (section 6). |
| `GET /proxy`, `GET /proxy/api`, `PUT /proxy/api` | Optional proxy management (section 7). |

### Discovery

A `Mount` has a `name`, an absolute `hostPath`, an absolute guest `guestPath`, a `mode` of `ro` or `rw`, and optionally `preservedPaths`, a list of guest aliases. A server with no mounts is valid.

Other fields a server may report, such as `network`, `proxyEnabled`, package lists, image IDs and container IDs, are implementation metadata. They are not a capability negotiation mechanism, and core discovery must not infer proxy support from them.

## 2. Buffered shell execution [H1–H4]

### The request

`POST /exec` requires `Content-Type: application/json`, with an optional charset, and either no `Content-Encoding` or `identity`. The body MUST be a JSON object containing only the fields below.

| Field | Required or default | Meaning and bounds |
| --- | --- | --- |
| `command` | Required | A nonblank Bash script of at most 65,536 UTF-8 bytes, run as `/bin/bash -c command` in the guest. |
| `cwd` | The server's `defaultCwd` | An absolute guest path of at most 4,096 bytes. This is a path, not a file URI. |
| `env` | `{}` | Guest environment overrides. Names match `[A-Za-z_][A-Za-z0-9_]*` and values are strings. At most 128 entries and 32,768 bytes in total, counting `key + value + 2` per entry, with each value at most 32,768 bytes. The host environment is never inherited implicitly. |
| `stdin` | Empty, then EOF | A UTF-8 string of at most 32,768 bytes. NUL is allowed. The server sends EOF after these bytes. |
| `timeoutMs` | 30,000 | An integer from 1 to 300,000. |
| `maxOutputBytes` | 4,194,304 | An integer from 1 to 16,777,216, capping stdout and stderr combined. |

### The result

Success is HTTP 200 with:

```
{stdout:string, stderr:string, exitCode:integer|null, signal:integer|null,
 timedOut:boolean, outputLimitExceeded:boolean, durationMs:number}
```

- A nonzero program exit is still HTTP 200.
- Ordinary completion carries an `exitCode` and a null `signal`. Termination by a signal carries a null `exitCode` and the signal number.
- Termination by timeout or by the output cap sets the corresponding flag.
- `durationMs` is a nonnegative number of milliseconds.
- Output is decoded as UTF-8 with replacement characters. Use the WebSocket API when you need arbitrary bytes.
- Every request starts a fresh shell, so the working directory and shell variables do not persist between requests. Files in the guest do.

### Errors

An HTTP error body is `{error:string}`. The wording is unspecified; the status codes are not.

| Status | When |
| --- | --- |
| 400 | Malformed JSON or UTF-8, an unknown field, or an invalid value. |
| 403 | Access rejected. |
| 404 | Unknown route. |
| 405 | Wrong method. The response carries `Allow`. |
| 413 | Body larger than 262,144 bytes. |
| 415 | Wrong media type or a compressed body. |
| 429 | Concurrency exhausted. |
| 500 | Execution or backend failure. |

JSON responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

### Cancellation

If the client disconnects, the server cancels that command's process group. A detached process that deliberately escapes its group is outside this per-command guarantee.

## 3. Streaming shell execution [S1–S5]

### Starting a command

The client opens a WebSocket to `/exec/ws` on the same base URL as the HTTP endpoints. Messages MUST be JSON text objects. Binary WebSocket frames are not part of this protocol.

Within ten seconds of connecting, the client sends one start message:

```
{type:"start", command, cwd?, env?, stdin?, timeoutMs?, maxOutputBytes?}
```

The fields mean what they mean in section 2, with one difference: `stdin` is a boolean that defaults to true. Sending false starts the command with stdin already at EOF. An unknown field in the start message is a failure.

The first success event is `{type:"started", processId:string}`, which arrives before any output. Each connection runs exactly one command.

### Messages

| Direction and type | Other fields | Semantics |
| --- | --- | --- |
| Server `stdout`, `stderr` | `data`: base64 | Immediate, binary-safe output. No ordering between the two streams is promised beyond the order the events arrive in. |
| Client `stdin` | `id`: integer from 0 to 2^53−1; `data`: base64 | IDs strictly increase. Each decoded chunk is at most 32,768 bytes; total input may span many chunks. |
| Server `stdin_ack` | `id` | The chunk has been queued. It has not necessarily been read by the program. Acknowledgements and output may interleave. |
| Client `stdin_eof` | None | EOF, delivered after all previously queued input. No input or EOF may follow. |
| Server `stdin_closed` | None | EOF was accepted, or the program closed its input. Stop sending. An explicit EOF receives this notice before the final exit. |
| Client `cancel` | None | Cancel the process group, including when the program is blocked on input. |
| Server `exit` | The section 2 result fields except `stdout` and `stderr` | Exactly one terminal success event, after all output, followed by a normal WebSocket close with code 1000. |
| Server `error` | `error`: string | A terminal failure. The connection closes without a success exit. |

### Rules

- Input and control messages accept only the fields listed above.
- The server MUST fail on invalid base64, on a repeated or non-increasing `id`, on an unknown message type, on a second start, on input after stdin was disabled or closed, and on an invalid first message.
- If the program exits before accepting pending input, the server is not required to fabricate acknowledgements for it.
- A close without an `exit` event is a failure, even when the close code is 1000.
- Closing the connection cancels the process group.
- Clients SHOULD send one input chunk at a time and wait for its acknowledgement, while continuing to receive output.

## 4. Codex session and processes [C1–C5]

### Envelopes

`/codex` carries JSON-RPC-shaped messages **without requiring a `jsonrpc` member**.

- A request is `{id:string|integer, method:string, params:object}`.
- A response is `{id, result:object}` or `{id, error:{code:integer, message:string, data?:{code:string}}}`.
- A notification is a request with no `id`.
- An `id` is a string of at most 256 characters or a safe integer.
- Responses may interleave with notifications. Match responses by `id`, never by position.
- Missing or null `params` means `{}`.
- Clients SHOULD use JSON text frames.

### Session lifecycle

1. The first request is `initialize` with `{clientName: string}`, where the name is nonempty and at most 256 bytes. The result is `{sessionId, environmentInfo}`.
2. The client then sends the notification `{method:"initialized", params:{}}`.
3. Until both have happened, ordinary requests fail with error −32002.

Initialization must complete within ten seconds. Reinitialization, a non-null `resumeSessionId`, and session resumption are unsupported.

`environment/info` returns the shell as `{name, path}`, `executorVersion`, `cwd` and `userHomeDir` as guest file URIs, `platformOs` of `linux`, `temporaryDirectories`, `tempDir`, and `capabilities`. `environment/status` returns `{status:"ready"}`.

Closing the connection terminates its active processes and releases its snapshots. It need not destroy the VM or the server.

### Error codes

| Code | Meaning |
| --- | --- |
| −32600 | Invalid envelope, or certain filesystem validation and permission failures. |
| −32601 | Unsupported method. |
| −32602 | Invalid process or session parameters. |
| −32002 | Not initialized. |
| −32004 | Filesystem path not found. |
| −32603 | Any other backend failure. |

An errno name MAY appear at `error.data.code`. A malformed transport frame or envelope may instead close the WebSocket. An invalid ordinary request MUST NOT corrupt an otherwise valid session. Error messages are not a stable API.

### Starting a process

`process/start` requires `{processId, argv, cwd, env, tty:false}`.

- `processId` is new and nonempty, at most 256 bytes.
- `argv` is a nonempty array of at most 1,024 NUL-free strings, at most 65,536 bytes in total counting one terminator per argument. `argv[0]` is nonempty. Arguments are passed literally and never evaluated by a host shell.
- `cwd` is a guest file URI as defined in section 5.
- `env` follows the section 2 limits.
- `pipeStdin` is optional and defaults to false.
- `arg0` is optional and replaces `argv[0]` as the program sees it, without changing which executable runs.

The server rejects a non-null `shellSnapshot`, a `tty` that is true or missing, `managedNetwork` or `networkProxy`, and `enforceManagedNetwork` set to true. If `sandbox` is supplied, it must have `permissions.type` of `"disabled"`. The returned `sandboxType` of `none` means no additional Codex platform sandbox is layered on; it does not mean host execution.

### Environment policy

`envPolicy` is optional:

```
{inherit:"all"|"core"|"none", exclude:[glob], includeOnly:[glob],
 set?:object, ignoreDefaultExcludes?:boolean}
```

With no policy, the process starts with an empty environment. With a policy, the server builds the environment in this order:

1. Inherit the guest defaults, never host variables. `core` keeps `PATH`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LOGNAME` and `USER`.
2. Drop inherited names containing `key`, `secret` or `token`, unless `ignoreDefaultExcludes` is set.
3. Apply `exclude`, then `set`, then `includeOnly`.
4. Apply the explicit `env` overrides last.

Globs support case-insensitive `*` and `?`, with at most 128 patterns per array and 256 characters per pattern.

Regardless of policy, the server always strips `CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN`, `NODE_REPL_AUTH_TOKEN`, `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE` and `OPENAI_WORKLOAD_IDENTITY_CONTEXT`, even when set as explicit overrides.

### Process notifications

`process/start` returns `{processId, sandboxType:"none"}` before any notification for that process. Every notification carries the `processId` and a `seq` that increases from 1:

1. `process/output`, with `stream` of `stdout` or `stderr` and a base64 `chunk`.
2. `process/exited`, with `exitCode` and `sandboxDenied` false.
3. `process/closed`.

Output always precedes `exited`, which precedes `closed`. A signal exit is reported as 128 plus the signal number. An execution or output failure is reported as 125.

### Process requests

| Request | Parameters besides `processId` | Result |
| --- | --- | --- |
| `process/read` | `afterSeq` default 0; `maxBytes` default 1 MiB, range 0 to 16 MiB; `waitMs` default 0, range 0 to 30,000 | `{chunks:[{seq, stream, chunk}], nextSeq, exited, exitCode, closed, sandboxDenied:false, failure:string|null}`. Returns retained chunks strictly after `afterSeq`. The first chunk may exceed `maxBytes`, and chunks are never split. `nextSeq` is an exclusive cursor, so pass `nextSeq−1` as the next `afterSeq`. Omit `maxBytes` only when the default response can hold the output you want. |
| `process/write` | `writeId`: nonempty string of at most 256 bytes; `chunk`: canonical base64 of at most 32 KiB decoded | `{status:"accepted"|"starting"|"stdinClosed"|"unknownProcess"}`. While the process is retained and stdin is open, repeating a `writeId` with the same bytes is idempotent; repeating it with different bytes fails. There is no stdin-EOF request. |
| `process/signal` | `signal`: `interrupt` | `{}`. Sends SIGINT. Other signal names fail. An unknown or finished process is a no-op. |
| `process/terminate` | None | `{running:boolean}`, reflecting whether the process was running when the request arrived. Cancellation itself is asynchronous. |

### Replay and retention

- `process/read` on an unknown process fails.
- Output replay is bounded. When output has been evicted, the server MUST say so through a non-null `failure` rather than silently claim the output is complete.
- Reading and replaying do not consume notifications.
- Handles for closed processes may eventually be evicted.

This profile does not add PTYs, shell snapshots, reconnect or resume, local extension execution, or `thread/shellCommand`.

## 5. Codex filesystem [F1–F5]

### Paths

Filesystem requests operate inside the guest, mounted directories included. `path`, `sourcePath`, `destinationPath` and a process `cwd` are local file URIs of the form `file:///absolute/path`; `file://localhost/` is also accepted. Spaces and non-ASCII characters are percent-encoded.

The server rejects any other scheme or authority, a query or fragment, a malformed escape, an encoded slash, a backslash, a control character, or a decoded path longer than 4,096 UTF-8 bytes.

Where a method lists `followSymlinks`, it defaults to true. Setting it false rejects traversal through a symlinked ancestor and also refuses to follow a final symlink when reading or writing a file. URIs the server returns are canonical local file URIs. A filesystem error is an RPC error, never an empty success.

### Methods

| Method | Parameters | Result and behavior |
| --- | --- | --- |
| `fs/readFile` | `path`, `followSymlinks?` | `{dataBase64}`. A regular file of up to 8 MiB. |
| `fs/writeFile` | `path`, `dataBase64`, `followSymlinks?` | `{}`. Creates or truncates a regular file and preserves the exact bytes. The parent directory must exist. |
| `fs/open` | `path`, `handleId` of at most 32 bytes | `{handleId}`. An immutable read snapshot that always follows symlinks. A duplicate handle fails. |
| `fs/readBlock` | `handleId`, `offset` ≥ 0, `len` ≥ 0 and ≤ 8 MiB | `{chunk:base64, eof:boolean}`. Reads from the snapshot. An offset at or beyond the end yields an empty chunk with `eof`. An unknown handle fails. |
| `fs/close` | `handleId` | `{}`. Idempotent; releases the snapshot. |
| `fs/getMetadata` | `path`, `followSymlinks?` | `{isDirectory, isFile, isSymlink, size, createdAtMs, modifiedAtMs}`. Size in bytes, times in milliseconds. An unknown creation time is 0. |
| `fs/canonicalize` | `path` | `{path}`. Resolves symlinks to an existing guest path. |
| `fs/readDirectory` | `path` | `{entries:[{fileName, isDirectory, isFile}]}`. Immediate children, dotfiles included, in no guaranteed order. A symlink entry has both booleans false. |
| `fs/createDirectory` | `path`, `recursive` default true, `followSymlinks?` | `{}`. Recursive creation tolerates an existing directory. |
| `fs/remove` | `path`, `recursive` default true, `force` default true, `followSymlinks?` | `{}`. Removes a final symlink itself rather than its target. A missing path is tolerated only with `force`. Deleting the root is forbidden. |
| `fs/copy` | `sourcePath`, `destinationPath`, `recursive` (required boolean) | `{}`. Copies a regular file, or a directory recursively, preserving executable mode bits. Rejects symlinks and special files, copying a path onto itself, and a destination inside the source. Not transactional. |
| `fs/walk` | `path`, `options` | `{entries:[{path, kind:"file"|"directory"}], errors:[{path, message}], truncated:boolean}`. `options` requires `maxDepth`, `maxDirectories` and `maxEntries` as nonnegative integers, with optional `followDirectorySymlinks` and `pruneHiddenDirectories`, both default false. |

### Walk semantics

- The root itself is not an entry.
- Depth 0 lists immediate children. Children that would need deeper traversal set `truncated`.
- Pruning hidden directories keeps their own entries but not their descendants.
- Directory symlinks are skipped unless `followDirectorySymlinks` is set, and cycles are suppressed.
- The limits count entries and directories examined. Reaching a limit sets `truncated`.
- Backend path errors met during traversal are reported in `errors`.

## 6. Browser access and mounts [B1–B2, M1]

### Host and Origin checks

- Every API requires exactly one loopback `Host`: `localhost`, `127.0.0.1` or `[::1]`, with an optional valid port.
- The core HTTP routes and `/codex` reject any request carrying a browser `Origin`.
- A command-line client connecting to `/exec/ws` without an `Origin` needs no token.
- A browser connecting to `/exec/ws` must instead present an `Origin` exactly matching the HTTP page and offer exactly two subprotocols: `sandbox-terminal` and `sandbox-token.<token>`. The server selects only `sandbox-terminal`.
- The page exposes its per-server token in `<meta name="terminal-token" content="...">`.
- A cross-origin request, or one whose `Sec-Fetch-Site` is not same-origin, is rejected. Browser Fetch Metadata without an `Origin` must not bypass the WebSocket checks.
- Token checks are in addition to the loopback checks. They do not authenticate local command-line processes.

### The browser terminal

The terminal page serves `/terminal.js`. Pages and scripts are served with `no-store`, `nosniff`, a same-origin resource policy and `DENY` framing, and each page carries a Content Security Policy that restricts execution and connections to its approved resources. The token value must not be echoed back in the selected WebSocket subprotocol. Visual layout, the copy button and other browser UX are outside this wire specification.

### The mounts profile

The operator supplies one writable and one read-only guest directory.

- Shell and filesystem writes under the read-only mount must fail without changing existing content.
- The writable mount supports full round trips.
- The mounts the server reports must agree with the configured paths and modes.
- Access to mounted host files is deliberate.

Permission bits, UID mapping, writable hardlink aliases and host-side races are backend-specific and are not standardized as equivalent security guarantees.

## 7. Managed HTTP(S) proxy [P1–P4]

### The model

The proxy is an optional guest egress facility, separate from the localhost execution listener.

- With the proxy disabled, the protocol makes no network promise beyond the backend's offline configuration.
- With it enabled, proxy and CA settings in the guest environment route HTTP(S) through the host's policy engine.
- HTTPS uses an ephemeral CA trusted by the guest, with a separately verified TLS connection to the upstream.
- The host never provisions its CA private key or a real substituted credential to the guest. An allowed upstream can still transform a credential and echo it in a response, so credential rules belong only with trusted services and narrowly scoped methods and paths.
- Redirect targets need their own authorization.
- Arbitrary TCP and UDP, HTTP/2 and WebSocket upgrades are not supported by this profile.

### Management API

`GET /proxy` serves a page exposing a per-server `<meta name="proxy-token" content="...">`. `GET /proxy/api` and `PUT /proxy/api` require that token in `X-Proxy-Token`, and any `Origin` must exactly match the page's origin.

- The GET response is `{enabled:true, policy:Policy, events:[Event]}`.
- PUT accepts a `Policy` directly, not wrapped. It requires `application/json`, no compression, and a body of at most 256 KiB.
- An invalid policy returns 400 and leaves the active policy unchanged.
- A valid replacement is atomic: it closes existing proxy connections and applies to subsequent traffic. Edits live only for the server's runtime. Changing `guestEnv` requires a restart.
- A missing or wrong token, or a cross-origin request, returns 403. When the proxy is disabled, these endpoints may return 404.

### Policy

A `Policy` is `{allow:[Rule], guestEnv?:{name:string}}` with at most 64 allow rules. Unknown keys in a policy, a rule or a credential are rejected.

A `Rule` is `{origin, methods?, paths?, allowCidrs?, credential?}`:

- `origin` is an exact HTTP(S) origin, including a nondefault port, with no wildcard, userinfo, path, query or fragment. Origins must be canonical, meaning a lowercase host with no trailing slash or explicit default port, and unique across rules.
- `methods` and `paths` optionally restrict the permitted HTTP methods and the exact URL pathnames. `allowCidrs` optionally lists permitted IP CIDR ranges.
- A request matching no rule is denied.
- Without `allowCidrs`, only publicly routable resolved addresses are allowed. An explicit list replaces that default for the rule. The resolved address is validated and pinned for the connection.
- `guestEnv` is a literal map of variable names to values, never expanded from the host environment.

Validation details:

- The optional `methods`, `paths` and `allowCidrs` lists are nonempty and free of duplicates. Omit a list instead of sending null.
- Methods are uppercase letters. Paths begin with a single slash, contain no query or fragment, and must be unchanged by URL normalization.
- Policy strings are at most 16 KiB and contain no control characters. `guestEnv` holds at most 128 entries with valid environment-variable names.
- A credential header name uses HTTP field-name syntax and cannot be `Host`, `Connection`, `Content-Length`, `Transfer-Encoding`, `Upgrade`, `Trailer`, `TE`, `Proxy-Connection`, `Proxy-Authorization` or `Proxy-Authenticate`.
- Placeholders, prefixes and resolved secrets are printable ASCII. A secret must be nonblank and present on the host before the policy is accepted.
- A configuration that would expose a resolved secret through `guestEnv` or through any placeholder is rejected.

### Credentials

A `Credential` is `{header, placeholder, secretEnv, prefix?}` and only applies over HTTPS.

- The request's complete header value must equal `placeholder`; anything else is denied.
- The host resolves `secretEnv` when the policy is configured and replaces the header with `(prefix or "") + hostSecret`.
- The configuration schema takes environment-variable names only. A real key is not accepted in their place.
- Literal echoes of a secret in responses or activity are redacted as defense in depth. That redaction does not protect against an upstream that deliberately transforms the secret.

### Events

An `Event` carries `timestamp` (string), `method`, `origin`, `path` without query or fragment, `status` (number), `decision` of `allowed`, `denied` or `error`, `reason`, `durationMs` and `credentialInjected` (boolean).

- Up to 500 recent events are retained.
- Snapshots omit request and response bodies and headers, and redact real credentials.
- The ordering of events across simultaneous requests is not a synchronization mechanism.

## 8. Resource limits and coverage boundaries [L1]

### Reference limits

| Area | Limit |
| --- | --- |
| Shell | 16 concurrent shell processes. |
| Streaming | 256 KiB per message; 256 KiB or 256 pending stdin messages; 1 MiB of pending output; ten-second start deadline. |
| Codex session | Ten-second initialization deadline; messages up to 12 MiB; 32 pending requests; 128 process handles; 4,096 remembered write IDs. |
| Codex output retention | 1 MiB or 8,192 retained chunks per process; 8 MiB per session. |
| Filesystem | 64 snapshots and 32 MiB in aggregate; 10,000 directory or copy entries; depth 64; at most 4,096 directories per walk; 64 MiB aggregate per copy. |

Implementations must bound their buffering and fail explicitly when a limit is exhausted. Timings and transport close codes under overload may vary, and a client must never equate a disconnect with success.

### What the conformance runner does and does not prove

The runner is a black-box interoperability test. It is not a proof of isolation and not an exhaustive denial-of-service audit.

- It makes no paid model calls and does not require Codex, Claude or Pi.
- It exercises wire behavior using only the Bash and Python 3 already present in the guest.
- Proxy management and HTTP forwarding can be tested on the same host without Internet access. TLS credential substitution requires the explicit proxy-tls fixture.
- DNS rebinding, saturation of every resource ceiling, and adversarial host filesystem races need separate security testing. A green core run does not claim to cover them.

`COVERAGE.md` records exactly what is covered and where the limits lie.
