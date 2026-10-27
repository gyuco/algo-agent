# Example resources

Resources live in the DB, in each user's library, and are edited from the "Risorse" page.
This folder only holds examples: "Importa esempi" copies the ones the user doesn't have yet
into their library. The formats below are the same the API validates.

Keys (file and folder names) use lowercase letters, digits and dashes.

## agents/`<key>`.md

```markdown
---
description: Shown in the UI.
enabledByDefault: true      # optional, default false
model: sonnet               # optional, default: the chat's model
maxTurns: 20                # optional
permissions:                # anything left out is denied
  files: read               # none | read | write
  tools: [current_datetime] # app tools (src/catalog/app-tools.ts)
  mcp: [context7]           # servers in mcp/
  skills: [code-review]     # skills in skills/
---
System prompt of the agent.
```

An agent gets its own permissions, narrowed to the resources switched on in the project.
Every tool call is checked against them by a PreToolUse hook, and file tools are also
confined to the project folder. No agent ever gets a shell.

## mcp/`<key>`.yaml

```yaml
description: …
type: http                  # or stdio
url: https://…
headers: { Authorization: "Bearer ${MY_TOKEN}" }   # ${VAR} comes from the backend's environment
```

```yaml
description: …
type: stdio
command: npx
args: [-y, some-mcp-server]
env: { API_KEY: "${SOME_API_KEY}" }
```

A stdio server runs as a process on this machine with the backend's privileges: only the app
owner in personal mode can create one. `app` is reserved for the app tools. Env and header
values are stored encrypted and never sent back to the browser.

## skills/`<key>`/SKILL.md

Standard Claude Code skills (`name` and `description` frontmatter). Agents run without a
shell, so skills should be instructions, not scripts.

## workflows/`<key>`.yaml

```yaml
description: …
enabledByDefault: true
input: Label of the text the user types
steps:                      # run in order, each a fresh session of its agent
  - agent: reviewer
    prompt: "Review {{input}}"
  - agent: assistant
    prompt: "Fix these problems: {{previous}}"
```

`{{input}}` is what the user typed, `{{previous}}` the previous step's answer.
A run stops at the first step that fails.

## App tools

Tools written in TypeScript live in `src/catalog/app-tools.ts` and are served to agents by the
in-process `app` MCP server.
