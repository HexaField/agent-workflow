import { z } from 'zod'
import { workflow } from '../workflow-builder'

const singleAgentWorkflowDefinition = workflow('single-agent.v1')
  .description('Single role workflow that streams user instructions directly to one agent.')
  .model('github-copilot/gpt-5-mini')
  .session('agent', '{{runId}}-solo')
  .parser('passthrough', z.unknown())
  .user('instructions', z.string().default(''))
  .role('agent', {
    systemPrompt:
      'You are a helpful software engineering agent. Handle the user\'s request exactly, then respond with a valid JSON object {"status": string, "summary": string} summarizing your work.',
    parser: 'passthrough',
    tools: {
      read: true,
      write: true,
      edit: true,
      bash: true,
      grep: true,
      glob: true,
      list: true,
      patch: true,
      todowrite: true,
      todoread: true,
      webfetch: true
    }
  })
  .round((round) =>
    round
      .start('agent')
      .agent('agent', 'agent', ['Primary task:\n{{user.instructions}}'], {
        exits: [
          {
            condition: 'always',
            outcome: 'completed',
            reason: 'Agent returned a response'
          }
        ]
      })
      .defaultOutcome('completed', 'Agent completed single-step workflow')
      .maxRounds(1)
  )
  .build()

export { singleAgentWorkflowDefinition }
export const singleAgentWorkflowDocument = singleAgentWorkflowDefinition
