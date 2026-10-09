# exec-server-spec

A compact [wire specification](SPEC.md) and independent Python/pytest conformance runner for `v86-shell-server` and `sandbox-exec-server`. The tests use only their public HTTP/WebSocket interfaces and can target any implementation of this contract.

The runner and usage instructions are added in the next implementation commit. The specification records the common contract at v86 commit `93e2d9a` and Python commit `94d5878`; implementation-specific VM/container internals and command-line setup flags are outside its scope.
