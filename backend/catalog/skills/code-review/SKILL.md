---
name: code-review
description: Checklist for reviewing code changes or files for bugs, security and clarity. Use when asked to review code.
---

# Code review

Check, in this order:

1. **Correctness**: wrong conditions, off-by-one, unhandled null/undefined, missing awaits, broken error handling.
2. **Security**: untrusted input reaching queries, paths, shells or HTML; secrets in code; missing authorization checks.
3. **Data**: migrations that lose data, missing transactions, race conditions.
4. **Clarity**: misleading names, dead code, duplication that will drift.

For each finding give `file:line`, severity (high / medium / low), the problem in one sentence and the fix.
Skip pure style nits.
