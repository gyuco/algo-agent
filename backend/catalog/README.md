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
steps:                      # each a fresh session of its agent
  - id: review              # optional, default step-<n>
    agent: reviewer
    prompt: "Review {{input}}"
  - agent: assistant
    needs: [review]         # optional, default the step before
    approval: true          # optional: wait for the user before running it
    prompt: "Fix these problems: {{steps.review}}"
```

`{{input}}` is what the user typed, `{{steps.<id>}}` the answer of a step the prompt's step
depends on, directly or indirectly. `{{previous}}` is the answer of the step's only dependency
(empty with none, refused with more). Without `id` and `needs` the steps form a chain in list
order, as before. Dependencies may not form a cycle.

A step may declare `verdict: [ok, problemi]`: its prompt then asks the agent to end with a line
`VERDETTO: <value>`, read ignoring case and markdown, and left out of the step's output. Without
a valid one the agent is asked once more in the same session; then the step fails.

A step may repeat with a check:

```yaml
  - id: fix
    agent: assistant
    prompt: "Fix {{steps.review}}. Last check: {{steps.check}}"
    repeat: { with: check, until: ok, max: 3 }   # onMax: fail (default) or continue
  - id: check                 # must need only fix, and declare verdict
    agent: reviewer
    verdict: [ok, problemi]
    prompt: "Check the fixes: {{steps.fix}}"
```

Each round runs the step, then its check, each in a fresh session, until the check's verdict is
`until`. The step sees the last check in `{{steps.check}}` (`(nessuna verifica ancora)` the
first time) and both see the round in `{{iteration}}`. Steps that need either one start once
the rounds are over. Out of rounds, the run fails, or with `onMax: continue` goes on with a
warning.

Steps run one at a time, each after the ones it needs. A step with `approval` waits for the
user, who sees the prompt it will run; the other steps go on meanwhile, and the run waits once
nothing else is left. Rejecting the step ends the run. A run stops at the first step that
fails. See `docs/workflow-a-grafo.md` for the full design.

## App tools

Tools written in TypeScript live in `src/catalog/app-tools.ts` and are served to agents by the
in-process `app` MCP server.
