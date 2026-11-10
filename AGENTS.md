# AGENTS.md

## TypeScript

- `strict` + flags from `IMPLEMENTATION.md`; `tsc --noEmit` and type-checked ESLint must pass.
- No `any`, no `as` except at validated input boundaries (localStorage, messages).

## Verification

- Report what was verified and what was not.

## Coordination

- Supporting agents: stay in the assigned file/task; report interface changes to the orchestrator. Plan deviations and justification. Wait for orchestrator approval
before implementing them.
- You aim to leave the code in better/cleaner shape as you found it. But do not
fix unrelated issues by yourself. Add to your conclusion summary a section on
potential improvements of clean code principles, DRY, design simplicity/consistence,
match of interfaces to the domain/business use case. 

## Style

- Comments state *why* (role in design, browser quirks, spec constraints, ...), not what.
- Doc comments describe the return value specifically.
- Top-level comments for each module. States the responsibilities in the design

