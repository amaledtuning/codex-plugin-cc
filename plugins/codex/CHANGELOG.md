# Changelog

## 1.0.7

- Add an opt-in `task --capacity-fallback=noncritical` mode that performs at most one fail-closed, same-thread retry for allowlisted GPT-5.6 capacity failures. The mode is off by default and excludes write-capable, xhigh, critical/live, stop-review, and already-started work.
- Forward `/codex:rescue --capacity-fallback off|noncritical` as a validated runtime option while keeping it out of the natural-language task text.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
