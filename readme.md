# Agent Workflows

This package contains predefined agent workflows and the orchestrator function to run them. Workflows are defined as JSON Schema documents that specify roles, sessions, state, prompt templates, transitions, and step types (LLM agents and CLI commands). The orchestrator loads, validates, and executes these workflows deterministically.

Internally, opencode is used to run coding-agent style agents with file read & write access. Zod is used for schema validation and the package supports extensible parsers for role responses.

## Provided Workflows

- `singleAgentWorkflowDefinition`: Single-role agent, runs one step with user instructions.
- `verifierWorkerWorkflowDefinition`: Two-role worker + verifier with iterative rounds and approvals.
- `workflowCreateWorkflowDefinition`: Meta-workflow that authors new workflow definitions.
- `cliAgentWorkflowDefinition`: Two CLI steps (write/append) followed by an agent confirmation step.

## Running Workflows

Use `runAgentWorkflow` with a validated definition. Minimal example:

```ts
import { runAgentWorkflow, verifierWorkerWorkflowDefinition } from '@hexafield/agent-workflow'

const run = await runAgentWorkflow(verifierWorkerWorkflowDefinition, {
  // `user` must match the workflow's declared `user` JSON-schema-like map.
  // Fields without a `default` in the workflow are required and will be
  // enforced at compile-time and runtime. Fields with a `default` are optional.
  user: { instructions: 'Create README content' },
  sessionDir: '/abs/path/to/workdir',
  model: 'github-copilot/gpt-5-mini', // optional override
  maxRounds: 5, // optional override of definition
  onStream: (event) => console.log(event.step, event.round, event.parts.length)
})

const result = await run.result
console.log(result.outcome, result.reason)
```

Options:

- `user` (object of inputs derived from the workflow `user` schema). Keys without a `default` are required; mismatches cause TypeScript errors and runtime validation failures.
- `sessionDir` (required)
- `model?`, `maxRounds?`, `onStream?`, `workflowId?`, `workflowSource?`, `workflowLabel?`.

Behavior notes:

- The `user` property on a workflow is a JSON-schema-like map (the same compact parser shape used by `parsers`). The orchestrator compiles Zod validators from that schema and validates/coerces `options.user` at run time. Defaults declared in the schema are applied automatically.
- TypeScript typings are derived from the workflow `user` schema via `UserInputsFromDefinition<T>` so supplying incorrect or missing required fields yields compile-time errors.
- If runtime validation fails, `runAgentWorkflow` throws `Invalid user inputs for workflow <id>: <details>`.
- Workflows can mix agent steps (`type: "agent"`, prompt + parser) and CLI steps (`type: "cli"`, `command` + `args` with optional `argsSchema`). CLI steps emit `parsed` with `{ stdout, stderr, exitCode, args }` so transitions and state updates can react to command results.
