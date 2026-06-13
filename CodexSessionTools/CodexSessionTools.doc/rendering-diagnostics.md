---
id: codex-session-tools.rendering-diagnostics
title: Rendering and diagnostics
scope:
  paths:
    - CodexSessionTools/src/render.js
    - CodexSessionTools/src/diagnostics.js
    - CodexSessionTools/src/server.js
    - CodexSessionTools/test/codex-session-tools.test.js
---

# Rendering and Diagnostics

CodexSessionTools separates rich internal state from model-facing output.

`renderForTool` chooses a fixed compact renderer based on the tool name. Callers do not pass verbosity, format, or include-evidence options. This prevents the model from accidentally pulling high-token diagnostics into context.

Normal renders are one-line status strings such as:

```text
ok thread=019ebf51 reason=session_marker_match
```

Blocked renders are similarly compact:

```text
blocked reason=ambiguous_fork
```

`DiagnosticsStore` keeps richer events in memory and optional JSONL files under the Codex agent-tools runtime directory. Diagnostic reads are paged and return compact event summaries, not raw repair objects or stack traces.
