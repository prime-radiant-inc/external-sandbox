# External Sandbox protocol, revision 1

This specification defines a localhost execution service with buffered and streaming shell APIs, a Codex-compatible process/filesystem endpoint, and optional browser, mount, and managed-proxy profiles. It specifies observable behavior independently of server language, implementation, or sandbox technology. The Codex endpoint follows the experimental Codex CLI 0.164.0 exec-server wire format. “MUST” is a conformance requirement; “MAY” permits implementation variation. Requirement IDs identify executable tests and coverage in `COVERAGE.md`.

## 1. Transport and profiles [T1]

Revision 1 identifies this document/test contract; it does not add a wire-version negotiation field. The server listens on loopback HTTP. All endpoints share one base URL; default ports are implementation choices. JSON is UTF-8; binary payloads use canonical padded RFC 4648 base64. Strings MUST NOT contain NUL unless explicitly allowed. Numeric integer fields accept mathematically integral JSON numbers within their documented range; booleans are not numbers. Clients MUST ignore additional response fields, MUST NOT depend on object-key order, output chunk boundaries, error text, or directory iteration order, and MUST preserve stdout and stderr independently. Errors MUST NOT be treated as successful empty results.

The **core** profile includes discovery, buffered shell execution, streaming shell execution, Codex process/filesystem RPC, and local access checks. **browser**, **mounts**, and **proxy** are additional explicitly selected profiles; **proxy-tls** adds TLS/credential checks to proxy using a disposable trusted upstream fixture. Missing endpoints or failed prerequisites for a selected profile are failures, not skips. The protocol does not promise identical guest architecture, UID, image contents, filesystem metadata precision, performance, or host mount semantics.

| Method/path | Contract |
| --- | --- |
| `GET /health` | `{status:"ready", backend:string, architecture:string, shell:string, defaultCwd:string, activeCommands:integer, mounts:[Mount], ...}`; activeCommands is nonnegative. |
| `GET /mounts` | `{mounts:[Mount]}`, consistent with `/health`. |
| `POST /exec` | Buffered shell request/result (§2). |
| WebSocket `/exec/ws` | One streaming shell execution per connection (§3). |
| WebSocket `/codex` | Multiplexed Codex process/filesystem session (§4–5). |
| `GET /`, `GET /terminal.js` | Browser terminal and script (§6). |
| `GET /proxy`, `GET /proxy/api`, `PUT /proxy/api` | Optional proxy management (§7). |

A Mount contains `name`, absolute `hostPath`, absolute guest `guestPath`, `mode` (`ro` or `rw`), and optionally `preservedPaths` (guest aliases). Empty mounts are valid. `network`, `proxyEnabled`, package lists, image and container IDs are implementation metadata, not portable capability negotiation. Core discovery must not infer proxy support from those fields.

## 2. Buffered shell execution [H1–H4]

`POST /exec` requires `Content-Type: application/json` (optional charset) and absent or `identity` Content-Encoding. The body MUST be a JSON object containing only these fields:

| Field | Required/default | Meaning and bounds |
| --- | --- | --- |
| `command` | Required | Nonblank Bash script, at most 65,536 UTF-8 bytes. Executed as `/bin/bash -c command` in the guest. |
| `cwd` | Server defaultCwd | Absolute guest path, at most 4,096 bytes. A shell cwd is a path, not a file URI. |
| `env` | `{}` | Guest environment overrides; variable names match `[A-Za-z_][A-Za-z0-9_]*`, values are strings. At most 128 entries, 32,768 bytes total (`key + value + 2` per entry), each value at most 32,768 bytes. Host environment is not implicitly inherited. |
| `stdin` | Empty/EOF | UTF-8 string, NUL allowed, at most 32,768 bytes; server sends EOF after the supplied bytes. |
| `timeoutMs` | 30,000 | Integer 1–300,000. |
| `maxOutputBytes` | 4,194,304 | Integer 1–16,777,216, combined stdout/stderr output cap. |

Success is HTTP 200 with `{stdout:string, stderr:string, exitCode:integer|null, signal:integer|null, timedOut:boolean, outputLimitExceeded:boolean, durationMs:number}`. Duration is nonnegative milliseconds. HTTP output decodes bytes as UTF-8 with replacement; use WebSocket for arbitrary bytes. A nonzero program exit remains HTTP 200. Ordinary completion has an exitCode and null signal; signal termination has null exitCode and a signal number. Timeout/output-cap termination sets the corresponding flag. Each request starts a fresh shell; cwd and shell variables do not persist, but guest files do.

HTTP errors are `{error:string}`. Required statuses: 400 for malformed JSON/UTF-8, unknown fields or invalid values; 403 for rejected access; 404 for unknown route; 405 with Allow for wrong method; 413 above 262,144 body bytes; 415 for wrong media type/compression; 429 for concurrency exhaustion; 500 for execution/backend failure. Exact error wording is unspecified. JSON responses have `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Client disconnect cancels that command's process group. Detached descendants escaping their group are outside this per-command guarantee.

## 3. Streaming shell execution [S1–S5]

WebSocket messages MUST be JSON text objects; binary WebSocket frames are not this protocol. Within ten seconds of connecting, send one `{type:"start", command, cwd?, env?, stdin?, timeoutMs?, maxOutputBytes?}`. Fields have §2 semantics except `stdin` is boolean, default true; false starts with EOF. Unknown start fields fail. The first success event is `{type:"started", processId:string}` before any output. There is exactly one command per connection.

| Direction/type | Other fields | Semantics |
| --- | --- | --- |
| Server `stdout`, `stderr` | `data`: base64 | Immediate binary-safe output; no cross-stream ordering beyond the received events is promised. |
| Client `stdin` | `id`: integer 0–2^53−1; `data`: base64 | IDs strictly increase; each decoded chunk is at most 32,768 bytes. Total input may exceed one chunk. |
| Server `stdin_ack` | `id` | Input accepted into the queue, not necessarily consumed by the program. Acks and output may interleave. |
| Client `stdin_eof` | None | EOF after previously queued input. No later input/EOF is valid. |
| Server `stdin_closed` | None | EOF accepted or program closed input. Stop sending. An explicit EOF gets this notice before final exit. |
| Client `cancel` | None | Cancel the process group, including when input is blocked. |
| Server `exit` | §2 result fields except stdout/stderr | Exactly one terminal success event, after all output. Then normal WebSocket close (1000). |
| Server `error` | `error`: string | Terminal failure; close without a success exit. |

Input/control objects accept only the listed fields. Invalid base64, repeated/non-increasing IDs, unknown types, duplicate start, input when disabled/closed, or invalid first messages MUST fail. No fabricated acknowledgement is required when the program exits before accepting pending input. A close without exit is failure even if its close code is 1000. Closing the connection cancels its process group. Clients SHOULD send one input chunk at a time, waiting for its acknowledgement while still receiving output.

## 4. Codex session and processes [C1–C5]

`/codex` uses JSON-RPC-shaped envelopes **without requiring a `jsonrpc` member**. Request: `{id:string|integer, method:string, params:object}`. Response: `{id, result:object}` or `{id, error:{code:integer,message:string,data?:{code:string}}}`. A notification omits id. IDs are strings of at most 256 characters or safe integers. Responses can interleave with notifications; match by id, not receive position. Missing/null params means `{}`. A client SHOULD use JSON text frames.

First request `initialize` with `{clientName:nonempty string}` (up to 256 bytes); result `{sessionId,environmentInfo}`. Then send notification `{method:"initialized",params:{}}`. Until both, ordinary requests fail with −32002. Reinitialization, non-null resumeSessionId and session resumption are unsupported. Complete initialization within ten seconds. `environment/info` returns shell `{name,path}`, executorVersion, cwd and userHomeDir as guest file URIs, platformOs (`linux`), temporaryDirectories, tempDir and capabilities. `environment/status` returns `{status:"ready"}`. Closing the connection terminates its active processes and releases snapshots; it need not destroy the VM/server.

Errors: −32600 invalid envelope or some filesystem validation/permission failures; −32601 unsupported method; −32602 invalid process/session parameters; −32002 not initialized; −32004 missing filesystem path; −32603 other backend failures. An errno name MAY appear at `error.data.code`. Malformed transport/envelopes may instead close the WebSocket. Invalid ordinary requests MUST NOT corrupt an otherwise valid session. Error messages are not stable API.

`process/start` requires `{processId,argv,cwd,env,tty:false}`. processId is new/nonempty, at most 256 bytes; argv is a nonempty array of at most 1,024 NUL-free strings, at most 65,536 bytes including one terminator per argument, argv[0] nonempty. Arguments are literal, not evaluated by a host shell. cwd is a guest file URI (§5); env uses §2 limits. Optional `pipeStdin` defaults false; optional `arg0` replaces argv[0] as seen by the program, not the executable path. A non-null shellSnapshot, tty true/missing, managedNetwork/networkProxy, or enforceManagedNetwork true is rejected. If sandbox is supplied it must have `permissions.type:"disabled"`; sandboxType `none` describes the absence of an additional Codex platform sandbox, not host execution.

Optional envPolicy is `{inherit:"all"|"core"|"none", exclude:[glob], includeOnly:[glob], set?:object, ignoreDefaultExcludes?:boolean}`. With no policy, begin with an empty environment. Otherwise inherit guest defaults (never host variables); `core` keeps PATH, SHELL, TMPDIR, TEMP, TMP, HOME, LANG, LC_ALL, LC_CTYPE, LOGNAME and USER. Drop inherited names containing key/secret/token unless ignoreDefaultExcludes; then apply exclude, set, includeOnly, and finally explicit env overrides. Globs support case-insensitive `*`/`?`, at most 128 patterns per array and 256 characters per pattern. Always strip CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN, NODE_REPL_AUTH_TOKEN, OPENAI_FEDERATION_RULE_ID, OPENAI_IDENTITY_TOKEN_FILE and OPENAI_WORKLOAD_IDENTITY_CONTEXT, including explicit overrides.

Start returns `{processId,sandboxType:"none"}` before process notifications. Notifications all carry processId and increasing seq starting at 1: `process/output` also carries `stream:"stdout"|"stderr"` and `chunk` base64; then `process/exited` carries exitCode and sandboxDenied false; finally `process/closed`. Signal exits use 128+signal; execution/output failures use 125. Output precedes exited, which precedes closed.

| Request | Parameters besides processId | Result |
| --- | --- | --- |
| `process/read` | afterSeq=0; maxBytes=1 MiB (0–16 MiB); waitMs=0 (0–30,000) | `{chunks:[{seq,stream,chunk}],nextSeq,exited,exitCode,closed,sandboxDenied:false,failure:string|null}`. Returns retained chunks strictly after afterSeq. First chunk can exceed maxBytes; chunks are never split. nextSeq is an exclusive cursor; use nextSeq−1 for the next afterSeq. Omit maxBytes only when the default response can contain the desired output. |
| `process/write` | writeId: nonempty string ≤256 bytes; chunk: canonical base64 ≤32 KiB decoded | `{status:"accepted"|"starting"|"stdinClosed"|"unknownProcess"}`. While retained and stdin open, repeating writeId with the same bytes is idempotent; different bytes fail. No stdin-EOF RPC is invented. |
| `process/signal` | signal: `interrupt` | `{}`; sends SIGINT. Other signal names fail. Unknown/finished process is a no-op. |
| `process/terminate` | None | `{running:boolean}` reflecting whether the process was running when requested; cancellation is asynchronous. |

Unknown process/read fails. Output replay is bounded: evicted output MUST be reported through a non-null failure rather than silently claimed complete. Read/replay does not consume notifications. Closed process handles may eventually be evicted. This profile does not add PTYs, shell snapshots, reconnect/resume, local extension execution, or `thread/shellCommand`.

## 5. Codex filesystem [F1–F5]

Filesystem requests operate inside the guest, including mounted paths. `path`, sourcePath, destinationPath, and process cwd use local `file:///absolute/path` URIs; `file://localhost/` is also accepted. Percent-encode spaces/non-ASCII characters. Reject other schemes/authorities, queries/fragments, malformed escapes, encoded slash, backslash, control characters, or decoded paths over 4,096 UTF-8 bytes. `followSymlinks` defaults true where listed; false rejects traversal through symlink ancestors as well as following the final link for file reads/writes. Returned URIs are canonical local file URIs. A filesystem error is an RPC error, not an empty success.

| Method | Parameters | Result/behavior |
| --- | --- | --- |
| `fs/readFile` | path, followSymlinks? | `{dataBase64}`; regular file up to 8 MiB. |
| `fs/writeFile` | path, dataBase64, followSymlinks? | `{}`; create/truncate regular file, preserve exact bytes; parent must exist. |
| `fs/open` | path, handleId ≤32 bytes | `{handleId}`; immutable read snapshot, always follows symlinks. Duplicate handle fails. |
| `fs/readBlock` | handleId, offset≥0, len≥0 (≤8 MiB) | `{chunk:base64,eof:boolean}`; reads snapshot bytes; offset at/beyond end yields empty/eof. Unknown handle fails. |
| `fs/close` | handleId | `{}`; idempotent, releases snapshot. |
| `fs/getMetadata` | path, followSymlinks? | `{isDirectory,isFile,isSymlink,size,createdAtMs,modifiedAtMs}`; size is bytes, timestamps milliseconds; unknown creation time is 0. |
| `fs/canonicalize` | path | `{path}`; resolve symlinks to an existing guest path. |
| `fs/readDirectory` | path | `{entries:[{fileName,isDirectory,isFile}]}`; immediate children including dotfiles, no ordering guarantee. Symlink entries have both booleans false. |
| `fs/createDirectory` | path, recursive=true, followSymlinks? | `{}`; recursive creation permits an existing directory. |
| `fs/remove` | path, recursive=true, force=true, followSymlinks? | `{}`; removes final symlink itself. Missing path is tolerated only with force. Root deletion is forbidden. |
| `fs/copy` | sourcePath, destinationPath, recursive (required boolean) | `{}`; copies regular files or recursive directories, preserves executable mode bits. Reject symlinks/special files, self-copy or a destination within source. Not transactional. |
| `fs/walk` | path, options | `{entries:[{path,kind:"file"|"directory"}],errors:[{path,message}],truncated:boolean}`. options requires maxDepth, maxDirectories, maxEntries (nonnegative integers); optional followDirectorySymlinks=false and pruneHiddenDirectories=false. |

Walk omits its root entry. Depth 0 lists immediate children; children requiring deeper traversal mark truncated. Pruning hidden directories keeps their entries but not their descendants. Directory symlinks are skipped unless enabled; cycles are suppressed. Limits count examined entries/directories; hitting a limit reports truncated. Backend path errors encountered during traversal appear in errors.

## 6. Browser access and mounts [B1–B2, M1]

Every API requires exactly one loopback Host (`localhost`, `127.0.0.1` or `[::1]`, optional valid port). Core HTTP and `/codex` reject any browser Origin. Originless CLI `/exec/ws` needs no token. Browser `/exec/ws` instead requires exact same Origin as the HTTP page and exactly two offered subprotocols: `sandbox-terminal` and `sandbox-token.<token>`. The server selects only sandbox-terminal. The page exposes its per-server token in `<meta name="terminal-token" content="...">`. Cross-origin or non-same-origin Sec-Fetch-Site is rejected; browser Fetch Metadata without Origin must not bypass WebSocket checks. Browser token checks supplement loopback checks; they do not authenticate local CLI processes.

The terminal serves `/terminal.js`. Browser pages/scripts use no-store, nosniff, same-origin resource policy and DENY framing; pages provide a CSP restricting execution/connections to their approved resources. Token values must not be echoed in the selected WebSocket subprotocol. Visual layout, copy-button implementation and other browser UX are outside this wire specification.

For the mounts profile, the operator supplies one writable and one read-only guest directory. Shell and filesystem writes under ro must fail without changing existing content; rw supports round trips. Mount reports must agree with those configured paths/modes. Access to mounted host files is deliberate. Permission bits, UID mapping, writable hardlink aliases and host races are backend-specific and not standardized as equivalent security guarantees.

## 7. Managed HTTP(S) proxy [P1–P4]

The optional proxy is a guest egress facility, separate from the localhost execution listener. With it disabled there is no network promise beyond the backend's offline configuration. When enabled, guest proxy/CA environment settings route HTTP(S) through the host policy engine. HTTPS uses a guest-trusted ephemeral CA and a separately verified upstream TLS connection. The host does not provision its CA private key or real substituted credentials to the guest. An allowed upstream can transform and echo a credential in a response, so credential rules require trusted services and narrowly scoped methods and paths. Redirect targets require independent authorization; arbitrary TCP/UDP, HTTP/2 and WebSocket upgrades are not supported by this profile.

`GET /proxy` exposes a per-server `<meta name="proxy-token" content="...">`. `GET /proxy/api` and `PUT /proxy/api` require `X-Proxy-Token`; any Origin must exactly match the page's origin. Response is `{enabled:true,policy:Policy,events:[Event]}`. PUT accepts a Policy directly, not a wrapper. It requires application/json and no compression, with a 256 KiB body cap. Invalid policies return 400 and leave the active policy unchanged. Valid replacement is atomic, closes existing proxy connections and affects subsequent traffic; edits are runtime-only. Changing guestEnv requires restart. Missing/wrong token or cross-origin access returns 403. Disabled proxy endpoints may return 404.

Policy is `{allow:[Rule], guestEnv?:{name:string}}`. Unknown policy/rule/credential keys are rejected. At most 64 allow rules. A rule is `{origin,methods?,paths?,allowCidrs?,credential?}`: exact HTTP(S) origin including nondefault port, no wildcard/userinfo/path/query/fragment; optional permitted HTTP methods, exact URL pathnames, and IP CIDR list. No match denies. With no allowCidrs, only public resolved addresses are allowed; an explicit list replaces that rule. The resolved address is validated and pinned for the connection. guestEnv is a literal map, never host expansion.

Rule origins must be canonical (lowercase host, no trailing slash or explicit default port) and unique. Optional methods/paths/allowCidrs lists are nonempty and duplicate-free; omit them instead of sending null. Methods are uppercase letters; paths begin with one slash, contain no query/fragment, and must not change when URL-normalized. Policy strings are at most 16 KiB and contain no control characters; guestEnv has at most 128 valid environment-variable names. Credential header names use HTTP field-name syntax and cannot be Host, Connection, Content-Length, Transfer-Encoding, Upgrade, Trailer, TE, Proxy-Connection, Proxy-Authorization or Proxy-Authenticate. Placeholder, prefix and resolved secret use printable ASCII; secrets must be nonblank and available on the host before policy acceptance. Configurations exposing a resolved secret through guestEnv or any placeholder are rejected.

Credential is `{header,placeholder,secretEnv,prefix?}` and requires HTTPS. The request's complete header value must equal placeholder; otherwise deny. The host resolves secretEnv at configuration time and replaces the header with `(prefix or "") + hostSecret`. Real keys are not accepted as substitutes for env-variable names in the configuration schema. Literal secret echoes in responses/activity are redacted as defense in depth, not protection from an upstream deliberately transforming a secret.

Event contains timestamp (string), method, origin, path (without query/fragment), status (number), decision (`allowed`, `denied`, `error`), reason, durationMs and credentialInjected (boolean). Up to 500 recent events are retained. Snapshots must omit request/response bodies and headers and redact real credentials. Activity ordering across simultaneous requests is not a synchronization mechanism.

## 8. Resource limits and coverage boundaries [L1]

Reference limits: 16 concurrent shell processes, 256 KiB streaming messages, 256 KiB/256 pending stdin messages, 1 MiB pending streaming output, ten-second start/initialization deadlines; Codex messages up to 12 MiB, 32 pending requests, 128 process handles, 1 MiB/8,192 retained chunks per process and 8 MiB per session, 4,096 remembered write IDs; 64 filesystem snapshots/32 MiB aggregate, 10,000 directory/copy entries, depth 64, walk at most 4,096 directories, copy aggregate 64 MiB. Implementations must bound buffering and fail explicitly under exhaustion. Timings and transport-close codes under overload may vary; clients must not equate a disconnect with success.

The conformance runner is a black-box interoperability test, not a proof of isolation or an exhaustive denial-of-service audit. It does not make paid model calls or require Codex/Claude/Pi. It exercises wire behavior using Bash and Python 3 already present in the guest. Proxy management/HTTP forwarding can be tested on the same host without Internet access. TLS credential substitution requires the explicit proxy-tls fixture. DNS rebinding, saturation of every resource ceiling, and adversarial host filesystem races require separate security testing; they are not silently claimed covered by a green core run. See `COVERAGE.md` for exact coverage and limitations.
