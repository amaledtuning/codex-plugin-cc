# Changelog

## Unreleased

- Add an opt-in `task --capacity-fallback=noncritical` mode that performs at most one fail-closed, same-thread retry for allowlisted GPT-5.6 capacity failures. The mode is off by default and excludes write-capable, xhigh, critical/live, stop-review, and already-started work.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
