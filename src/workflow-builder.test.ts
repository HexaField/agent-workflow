import { validateWorkflowDefinition, workflow, zodToWorkflowParserJsonSchema } from '@hexafield/agent-workflow'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

describe('workflow builder', () => {
  it('builds a workflow via chaining API', () => {
    const definition = workflow('builder-single.v1')
      .description('Chained single agent workflow')
      .model('github-copilot/gpt-5-mini')
      .session('agent', '{{runId}}-builder')
      .parser('passthrough', z.unknown())
      .user('instructions', z.string().default(''))
      .role('agent', {
        systemPrompt: 'You are a single agent focused on the user request.',
        parser: 'passthrough',
        tools: { read: true, write: true }
      })
      .round((round) =>
        round
          .start('agent')
          .agent('agent', 'agent', ['Do the thing:\n{{user.instructions}}'], {
            exits: [
              {
                condition: 'always',
                outcome: 'done',
                reason: 'Finished via builder'
              }
            ]
          })
          .defaultOutcome('done', 'Finished via builder')
          .maxRounds(1)
      )
      .build()

    expect(definition.id).toBe('builder-single.v1')
    expect(definition.sessions.roles).toEqual([{ role: 'agent', nameTemplate: '{{runId}}-builder' }])
    expect(definition.parsers?.passthrough).toEqual({ type: 'unknown' })
    expect(definition.roles.agent.parser).toBe('passthrough')
    expect(definition.flow.round.steps[0].type).toBe('agent')
    expect(() => validateWorkflowDefinition(definition)).not.toThrow()
  })

  it('converts zod schemas into workflow parser JSON', () => {
    const zodSchema = z
      .object({
        name: z.string().min(2),
        tags: z.array(z.string()).optional(),
        priority: z.number().int().min(1).max(5).default(3)
      })
      .strict()

    const converted = zodToWorkflowParserJsonSchema(zodSchema)

    expect(converted).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number', default: 3 }
      },
      required: ['name']
    })
  })

  it('supports bootstrap + multi-step rounds with zod schemas', () => {
    const definition = workflow('builder-mixed.v1')
      .description('Mixed step kinds')
      .model('github-copilot/gpt-5-mini')
      .session('director', '{{runId}}-director')
      .parser('text', z.string())
      .parser('noop', z.unknown())
      .role('director', { systemPrompt: 'Lead', parser: 'text', tools: { list: true } })
      .role('observer', { systemPrompt: 'Observe only', parser: 'noop' })
      .stateInitial({ seed: '{{run.id}}' })
      .bootstrapCli('prep', 'printf', {
        argsObject: { arg0: '%s', arg1: '{{state.seed}}' },
        argsSchema: z.object({ arg0: z.string(), arg1: z.string() })
      })
      .round((round) =>
        round
          .start('agent')
          .agent('agent', 'director', ['Hello {{state.seed}}'], {
            stateUpdates: { echoed: '{{parsed}}' },
            next: 'mirror'
          })
          .transform('mirror', { echoed: '$.steps.agent.raw' })
          .cli('write', 'printf', {
            args: ['{{steps.mirror.raw}}'],
            capture: 'text'
          })
          .workflow('delegate', 'child-workflow.v1', {
            input: { value: '{{steps.write.parsed.stdout}}' },
            inputSchema: z.object({ value: z.string() })
          })
          .defaultOutcome('done', 'Completed mixed workflow')
          .maxRounds(2)
      )
      .build()

    expect(definition.flow.bootstrap?.type).toBe('cli')
    expect(definition.flow.round.steps.map((s) => s.type)).toEqual(['agent', 'transform', 'cli', 'workflow'])

    const cliStep = definition.flow.round.steps.find((s) => s.key === 'write')
    if (cliStep?.type === 'cli') {
      expect(cliStep.args).toEqual(['{{steps.mirror.raw}}'])
    } else {
      throw new Error('CLI step missing')
    }

    const workflowStep = definition.flow.round.steps.find((s) => s.key === 'delegate')
    if (workflowStep?.type === 'workflow') {
      expect(workflowStep.inputSchema).toEqual({
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      })
    } else {
      throw new Error('Workflow reference step missing')
    }

    expect(() => validateWorkflowDefinition(definition)).not.toThrow()
  })

  it('converts enums, unions, defaults, and optionals from zod', () => {
    const converted = zodToWorkflowParserJsonSchema(
      z.object({
        status: z.enum(['pending', 'done']),
        choice: z.union([z.literal(1), z.literal(2)]),
        maybe: z.string().optional(),
        flag: z.literal(true)
      })
    )

    expect(converted).toEqual({
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'done'] },
        choice: { type: 'number', enum: [1, 2] },
        maybe: { type: 'string' },
        flag: { type: 'boolean', default: true }
      },
      required: ['status', 'choice']
    })
  })
})
