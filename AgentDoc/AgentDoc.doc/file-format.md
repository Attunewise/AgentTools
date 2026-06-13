---
id: agentdoc.file-format
title: AgentDoc file format
scope:
  paths:
    - "*.md"
    - "*.doc/**"
---

# AgentDoc File Format

Large documentation files are avoided.

An AgentDoc documentation set uses a small Markdown index beside a sibling `.doc` directory:

```text
Something.md
Something.doc/
  focused-section.md
```

The index file is a map. It should stay short and link to focused section files.

Each section file should be self-contained enough for an agent to read without loading the entire documentation set. Section frontmatter may declare source scopes:

```md
---
id: compiler.frontend.design
title: Compiler frontend design
scope:
  paths:
    - src/compiler/frontend/**
---
```

AgentDoc uses `scope.paths` to map staged source changes to the smallest relevant doc sections.
