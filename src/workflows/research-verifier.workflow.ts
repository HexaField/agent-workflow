import { workflow } from '../workflow-builder'

const researchVerifierWorkflowDefinition = workflow('research-verifier.v1')
  .description('Two-role workflow pairing a researcher and verifier for evidence-backed synthesis.')
  .model('github-copilot/gpt-5-mini')
  .session('researcher', '{{runId}}-researcher')
  .session('verifier', '{{runId}}-verifier')
  .parser('researcher', {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['working', 'done', 'blocked'] },
      plan: { type: 'string' },
      work: { type: 'string' },
      requests: { type: 'string', default: '' }
    },
    required: ['status', 'plan', 'work']
  })
  .parser('verifier', {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['instruct', 'approve', 'fail'] },
      critique: { type: 'string' },
      instructions: { type: 'string' },
      priority: { type: 'number', integer: true, minimum: 1, maximum: 5 }
    },
    required: ['verdict', 'critique', 'instructions', 'priority']
  })
  .role('researcher', {
    systemPrompt:
      'You are a rigorous research agent who collects evidence, synthesizes findings, and cites sources. Follow verifier instructions precisely.\n\nAlways return STRICT JSON with the shape:\n{\n  "status": "working" | "done" | "blocked",\n  "plan": "short bullet-style plan clarifying approach",\n  "work": "concise summary of findings, sources, and decisions",\n  "requests": "questions or additional info you need (empty string if none)"\n}\n\nRules:\n- Think aloud inside the plan field; keep "work" focused on evidence, citations, or synthesis.\n- Use status "done" only when the research question is satisfied with sources noted.\n- Use status "blocked" when you cannot proceed without missing info; include what is missing in requests.\n- Never include Markdown fences or commentary outside the JSON object.',
    parser: 'researcher',
    tools: {
      webfetch: true
    }
  })
  .role('verifier', {
    systemPrompt:
      'You are a staff-level research verifier ensuring responses are accurate, sourced, and on-brief.\n\nResponsibilities:\n1. Internalize the user\'s research goal and acceptance criteria.\n2. Examine the researcher\'s most recent JSON response for correctness, completeness, sourcing, and alignment with the request.\n3. Provide concise guidance that sharpens the next research step.\n\nResponse policy:\n- Always return STRICT JSON with the shape:\n{\n  "verdict": "instruct" | "approve" | "fail",\n  "critique": "succinct reasoning referencing concrete requirements",\n  "instructions": "ordered guidance for the researcher to follow next",\n  "priority": number (1-5, where 1 is critical blocker)\n}\n- Use verdict "approve" ONLY when the latest submission fully satisfies the research goal with sufficient sourcing.\n- Use "fail" when the researcher is off-track or violating constraints; clearly state blockers in critique.\n- Otherwise respond with "instruct" and provide the next best set of actions in the instructions field.\n- Keep critiques grounded in evidence and reference specific user needs, gaps, or missing citations.\n- Assume future turns depend solely on your guidance—be explicit about quality bars, edge cases, and verification steps.',
    parser: 'verifier',
    tools: {
      webfetch: true
    }
  })
  .stateInitial({
    pendingInstructions: '{{user.instructions}}',
    latestCritique: ''
  })
  .user('instructions', { type: 'string', default: '' })
  .bootstrapAgent('bootstrap', 'verifier', [
    'User research instructions:\n{{user.instructions}}',
    'The researcher has not produced any output yet. Provide the first set of instructions that sets them up for success.'
  ], {
    stateUpdates: {
      pendingInstructions: '{{parsed.instructions||user.instructions}}',
      latestCritique: '{{parsed.critique||state.latestCritique}}'
    }
  })
  .round((round) =>
    round
      .start('researcher')
      .agent('researcher', 'researcher', [
        'Primary research question from the user:\n{{user.instructions}}',
        'Verifier guidance for round #{{round}}:\n{{state.pendingInstructions}}',
        '{{state.latestCritique}}',
        'Deliver verifiable research findings or progress that can be assessed immediately.'
      ], {
        next: 'verifier',
        transitions: [
          {
            condition: { field: 'parsed.status', equals: 'blocked' },
            outcome: 'failed',
            reason: '{{parsed.requests||"researcher reported blocked status"}}'
          }
        ]
      })
      .agent('verifier', 'verifier', [
        'User research instructions:\n{{user.instructions}}',
        'Latest researcher JSON (round #{{round}}):\n{{steps.researcher.raw}}',
        'Evaluate the researcher output, note gaps, and craft the next set of instructions.'
      ], {
        stateUpdates: {
          pendingInstructions: '{{parsed.instructions||state.pendingInstructions}}',
          latestCritique: '{{parsed.critique||state.latestCritique}}'
        },
        exits: [
          {
            condition: { field: 'parsed.verdict', equals: 'approve' },
            outcome: 'approved',
            reason: '{{parsed.critique||"Verifier approved the research"}}'
          },
          {
            condition: { field: 'parsed.verdict', equals: 'fail' },
            outcome: 'failed',
            reason: '{{parsed.critique||"Verifier rejected the research"}}'
          }
        ]
      })
      .defaultOutcome('max-rounds', 'Verifier never approved within {{maxRounds}} rounds')
      .maxRounds(10)
  )
  .build()

export { researchVerifierWorkflowDefinition }
export const researchVerifierWorkflowDocument = researchVerifierWorkflowDefinition
