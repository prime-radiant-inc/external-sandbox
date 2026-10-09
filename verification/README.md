# Sample implementation verification

These are observations about two implementations, not part of the implementation-neutral [protocol definition](../SPEC.md). They were recorded on October 9, 2026, on macOS arm64, using dedicated loopback instances, temporary mounts, a deny-all initial proxy policy, and the generated localhost TLS fixture. Both services ran real Linux guests; no fake execution backend or coding-model call was used.

| Target | Code tested | Full profile result | Report |
| --- | --- | --- | --- |
| `sandbox-exec-server` (Python / Apple Container) | `94d5878` | **116 passed**, exit 0 | [python.json](python.json) |
| `v86-shell-server` (Node.js / v86) | `93e2d9a` | **115 passed, 1 failed**, exit 1 | [node.json](node.json) |

Profiles: core, browser, mounts, proxy, proxy-tls. The runner was built at commit `11710b2` and installed into an isolated environment from its wheel, with the working directory outside the source package. Both reports have complete selections and zero deselected cases. `conforms` is true only for the first target. The checker itself also passed 22 self-tests, including subprocess tests of its exit status and JSON reporting, and passed Ruff. The wheel SHA-256 was `15159055e59c484b1d3009e66082cc3dd8593934cd0d1e0f14a58e1f2cd7efab`.

## Observed difference: browser Fetch Metadata without Origin

Requirement **B2** requires a browser WebSocket to supply both its exact Origin and terminal token. A request to `/exec/ws` with `Sec-Fetch-Site: same-origin`, but no Origin or subprotocol/token, must be rejected with HTTP 403. The Python implementation does so; the Node implementation accepts the WebSocket upgrade.

The Node handler classifies requests as browser requests only when Origin is present; otherwise it applies the originless CLI checks, ignoring Fetch Metadata. This is an authorization-classification discrepancy exposed by the conformance suite. It is not by itself proof that an ordinary browser can construct such a request. The failure remains a normal failing test, not an xfail, skip, or relaxed expectation. Neither implementation was modified in this task.

To reproduce just this case against a running implementation:

```sh
uv run exec-server-conformance --url http://127.0.0.1:18786 \
  --profile browser -k 'invalid_handshake and headers2' -v
```

For the complete run, start a dedicated service exposing writable `/mnt/spec-rw` and read-only `/mnt/spec-ro`, enable the deny-all proxy, and configure upstream TLS trust and the synthetic secret as described in the [runner instructions](../README.md#optional-https-proxy-fixture). Then run:

```sh
uv run exec-server-conformance --url http://127.0.0.1:18786 \
  --profile browser --profile mounts --profile proxy-tls \
  --rw-dir /mnt/spec-rw --ro-dir /mnt/spec-ro \
  --proxy-tls-cert work/tls/cert.pem --proxy-tls-key work/tls/key.pem \
  --report work/result.json --junitxml work/result.xml -q
```

Switch the URL to the other service to apply exactly the same checks. Initial full runs before the added TLS/revocation/concurrent-session cases produced 112/112 and 111/112 passes respectively, reproducing the same browser discrepancy. The final 116-case runs supersede those initial results. Both targets' source working trees were unchanged, and the dedicated test processes were shut down after verification.
