import { validateWorkflowDefinition, type AgentWorkflowDefinition } from '../workflow-schema'

// Embed the workflows API documentation inline so the prompt is self-contained.
const workflowsReadme = `# Workflow Document Structure

Every workflow document must satisfy the canonical JSON Schema for workflows. The runtime ships a Zod-based \`workflowDefinitionSchema\` which is used to validate inputs; this guide describes the structure expected by that schema.

Top-level fields:

| Field | Required | Description |
| --- | --- | --- |
| \`$schema\` | optional | Reference to the JSON Schema URL for tooling. |
| \`id\` | required | Unique identifier string, typically \`<name>.<version>\`. |
| \`description\` | optional | Human-readable summary of the workflow's intent. |
| \`model\` | optional | Default LLM model; callers can override per run. |
| \`sessions.roles\` | required | Array of role entries describing how to create per-role sessions. |
| \`parsers\` | optional | Map of parser name → JSON-schema-like shape describing expected responses. Definitions are converted to runtime validators. |
| \`roles\` | required | Map of role name → role definition (system prompt + parser). Must include all role names referenced elsewhere. Parsers must reference keys defined in \`parsers\`. |
| \`user\` | optional | Map of input keys → compact JSON-schema-like parser describing expected runtime inputs and defaults. |
| \`state\` | optional | Initial key/value store with template-aware values. |
| \`flow.bootstrap\` | optional | A single verifier step that runs before round 1. |
| \`flow.round\` | required | Definition of the repeating round (steps array + transitions + default outcome). |

### Sessions

\`sessions.roles\` defines sessions that will be created or reused for each run:

\`\`\`jsonc
{
  "role": "worker",
  "nameTemplate": "{{runId}}-worker"
}
\`\`\`


### Roles & Parsers

Define parser shapes in \`parsers\` using a compact JSON schema that supports \`string\`, \`number\`, \`boolean\`, \`unknown\`, \`array\`, and \`object\` types (with \`enum\`, \`required\`, and \`default\` support). Roles then reference these parser names. Parsers are converted at runtime into validators that parse and coerce role responses.

Example parser and role:

\`\`\`jsonc
"parsers": {
  "worker": {
    "type": "object",
    "properties": {
      "status": { "type": "string", "enum": ["working","done","blocked"] },
      "plan": { "type": "string" },
      "work": { "type": "string" },
      "requests": { "type": "string", "default": "" }
    },
    "required": ["status","plan","work"]
  }
},
"roles": {
  "worker": { "systemPrompt": "...", "parser": "worker" }
}
\`\`\`

 
### Tool Permission API

Each role can include a compact \`tools\` object to grant runtime capabilities. Keys are booleans; omitted keys default to \`false\`.

Common keys: \`read\`, \`write\`, \`edit\`, \`bash\`, \`grep\`, \`glob\`, \`list\`, \`patch\`, \`todowrite\`, \`todoread\`, \`webfetch\`.

Example:

\`\`\`jsonc
"roles": {
  "search": {
    "systemPrompt": "...",
    "parser": "search",
    "tools": { "webfetch": true }
  }
}
\`\`\`

Note: The orchestrator enforces these flags at runtime — grant only the capabilities a role needs.

### User inputs

Workflows may declare a \`user\` map that describes expected runtime inputs. This map uses the same compact JSON-schema-like parser shape used for \`parsers\` and allows specifying type and an optional \`default\`.


Example:

\`\`\`jsonc
"user": {
  "instructions": { "type": "string", "default": "" },
  "priority": { "type": "number" }
}
\`\`\`

In the example above \`instructions\` is optional (has default) while \`priority\` is required.

### Shared State

\`state.initial\` is an object whose values are template strings rendered once at run start. Rendered values are stored in the state bag and can be retrieved inside prompts or transitions via \`{{state.key}}\`.

### Flow Definition

\`flow\` contains an optional \`bootstrap\` step and a required \`round\` object.

A \`round\` defines the repeating sequence of steps, transitions, and a default outcome. Steps are ordered and may define \`prompt\` sections, \`stateUpdates\`, \`transitions\`, and \`exits\`.

#### Step kinds

- Agent step: \`type: "agent"\` (default when omitted). Fields: \`key\`, \`role\`, \`prompt\`, optional \`next\`, \`stateUpdates\`, \`transitions\`, \`exits\`.
- CLI step: \`type: "cli"\`. Fields: \`key\`, \`command\`, optional \`args\` (templated strings), optional \`argsSchema\` (compact JSON-schema-like validator for args), optional \`cwd\`, optional \`stdinFrom\` (path expression resolved from scope, streamed into process stdin), optional \`capture\` (\`text\` | \`buffer\` | \`both\`, default \`text\`), plus the same \`next\` / \`stateUpdates\` / \`transitions\` / \`exits\` fields. CLI steps emit \`parsed = { stdout, stderr, exitCode, args, stdoutBuffer?, stderrBuffer? }\` so transitions and templating can respond to command results without touching the filesystem.
- Workflow reference step: \`type: "workflow"\`. Fields: \`key\`, \`workflowId\`, optional \`input\` (templated object), optional \`inputSchema\` (compact JSON-schema-like validator applied after templating), optional \`next\` / \`stateUpdates\` / \`transitions\` / \`exits\`. The orchestrator resolves \`workflowId\` from a registry/resolver, runs the child workflow synchronously, and exposes a summary on the step (\`parsed.outcome\`, \`parsed.reason\`, \`parsed.runId\`, \`parsed.rounds\`).

### Template Rendering

Prompt sections, state initializers, \`stateUpdates\`, and transition \`reason\` fields support handlebars-style expressions:

- \`{{user.<key>}}\`, \`{{run.id}}\`, \`{{round}}\`, \`{{maxRounds}}\` reference built-in scope values.
- \`{{steps.worker.raw}}\` accesses the raw JSON emitted by a prior step within the same round.
- \`{{parsed.instructions}}\` refers to the parsed payload of the current step.
- Literal strings can provide fallbacks using \`||\`, e.g. \`{{parsed.instructions||state.pendingInstructions}}\`.

### Transitions & Exits

Transitions determine whether a step loops, advances, or finishes the run. Conditions support comparators (\`equals\`, \`includes\`, \`in\`, \`matches\`, etc.), existence checks, and logical combinators (\`any\`, \`all\`).

Example transition:

\`\`\`jsonc
{
  "condition": { "field": "parsed.status", "equals": "blocked" },
  "outcome": "failed",
  "reason": "{{parsed.requests}}",
  "stateUpdates": { "latestCritique": "{{parsed.requests}}" }
}
\`\`\`

### Parsers & Typed Results

Role responses are parsed against the parser schema declared for that role. For example, the \`worker\` parser above yields a structured JSON object with \`status\`, \`plan\`, \`work\`, and \`requests\`.

### Validation & Tooling

Workflow documents must conform to the canonical JSON Schema for agent workflows. Use a JSON Schema validator (any standard validator that understands draft-07 or later) to validate documents before use. The schema enforces structural rules such as:

- required top-level fields (\`id\`, \`sessions.roles\`, \`roles\`, \`flow.round\`);
- uniqueness of step \`key\` values within a round;
- that role names referenced in workflow steps match keys declared in \`roles\`;
- parser shapes in \`parsers\` adhere to the compact allowed types (\`string\`, \`number\`, \`boolean\`, \`array\`, \`object\`, \`unknown\`) and their constraints (\`enum\`, \`required\`, \`default\`);
- that \`user\` entries (if present) are parser-shaped objects describing expected runtime inputs and defaults.

Produce or obtain a standalone JSON Schema file for tooling (editors, CI, or registries) and validate workflow JSON documents against it as part of your CI or authoring workflow.

### Reference Example

\`\`\`jsonc
{
  "id": "verifier-worker.v1",
  "sessions": { "roles": [{ "role": "worker" }, { "role": "verifier" }] },
  "roles": {
    "worker": { "systemPrompt": "...", "parser": "worker" },
    "verifier": { "systemPrompt": "...", "parser": "verifier" }
  },
  "user": {
    "instructions": { "type": "string", "default": "" },
    "context": { "type": "string", "default": "" }
  },
  "state": {
    "initial": {
      "pendingInstructions": "{{user.instructions}}",
      "latestCritique": ""
    }
  },
  "flow": {
    "bootstrap": { "key": "bootstrap", "role": "verifier", "prompt": ["..."] },
    "round": {
      "start": "worker",
      "steps": [
        /* worker + verifier definitions */
      ],
      "maxRounds": 10,
      "defaultOutcome": {
        "outcome": "max-rounds",
        "reason": "Verifier never approved within {{maxRounds}} rounds"
      }
    }
  }
}
\`\`\`

### Authoring Checklist

1. Pick a stable \`id\` and version suffix.
2. Enumerate every role and ensure prompts + parsers are accurate.
3. Define session templates for each role.
4. Seed any shared state needed across steps.
5. Lay out bootstrap and round steps with clear prompts and \`stateUpdates\`.
6. Encode transitions/exits for every completion or failure path.
7. Validate with the runtime schema or generate the standalone JSON Schema via the converter script above.

By adhering to this structure, you can describe new agent collaborations purely through JSON without writing bespoke orchestration code, keeping behavior consistent and testable throughout the platform.
`

export const workflowCreateWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'workflow-create.v1',
  description:
    'Single-step workflow that instructs an agent to author a new workflow file. The README.md is embedded in the prompt to provide authoring guidance.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [{ role: 'creator' as const, nameTemplate: '{{runId}}-creator' }]
  },
  parsers: {
    createWorkflow: {
      type: 'object' as const,
      properties: {
        id: { type: 'string' as const },
        content: { type: 'string' as const }
      },
      required: ['id', 'content']
    }
  },
  roles: {
    creator: {
      systemPrompt:
        'You are an expert workflow author. Respond with a single valid JSON object only (no markdown, no code fences, no leading text). The FIRST character of your reply must be `{` and the last must be `}`; nothing else may precede or follow. Shape: {"id": string, "content": string}. Use id "workflow-create.v1". The "content" must be a JSON string that is itself a valid AgentWorkflowDefinition (no TypeScript). Do not include commentary or prose. Do not include the README text inside the content; use it only for guidance. Escape newlines in the content with `\n` so the JSON remains valid.',
      parser: 'createWorkflow',
      tools: {
        read: false,
        write: false,
        edit: false,
        bash: false,
        grep: false,
        glob: false,
        list: false,
        patch: false,
        todowrite: false,
        todoread: false,
        webfetch: true
      }
    }
  },
  state: { initial: {} },
  user: {
    instructions: { type: 'string', default: '' }
  },
  flow: {
    round: {
      start: 'createWorkflow',
      steps: [
        {
          type: 'agent',
          key: 'createWorkflow',
          role: 'creator' as const,
          prompt: [
            'You are being asked to author a new workflow file for the Hyperagent repository.',
            'Include the following API guidance verbatim (for context):',
            workflowsReadme,
            'User request: Create a workflow definition object. For this task, return the workflow definition as a JSON string in the `content` field of the JSON object. The output must satisfy the parser schema { id, content } and the id should be "workflow-create.v1". The `content` must be a JSON string that parses to a valid AgentWorkflowDefinition. Keep the authored workflow concise and JSON-compatible. Respond with ONLY the JSON object—no extra text. Strict formatting: start the reply with `{` (no leading characters) and end with `}`. Do NOT paste the README into the content; only use it as guidance.'
          ],
          exits: [
            {
              condition: 'always',
              outcome: 'created',
              reason: 'Creator produced workflow file content'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'created',
        reason: 'Single-step authoring workflow completed'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition

export const workflowCreateWorkflowDefinition = validateWorkflowDefinition(workflowCreateWorkflowDocument)
