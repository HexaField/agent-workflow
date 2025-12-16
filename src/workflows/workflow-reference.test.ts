import { AgentWorkflowDefinition, runAgentWorkflow, validateWorkflowDefinition } from '@hexafield/agent-workflow'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { opencodeTestHooks } from '../opencodeTestHooks'

const workflowReferenceWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'workflow-reference.v1',
  description: 'Parent workflow that delegates work to a referenced child workflow.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [{ role: 'director' as const, nameTemplate: '{{runId}}-reference-director' }]
  },
  parsers: {
    noop: { type: 'unknown' as const }
  },
  roles: {
    director: {
      systemPrompt: 'Directs nested workflows; no agent turns expected in parent run.',
      parser: 'noop',
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
        webfetch: false
      }
    }
  },
  user: {
    goalFile: { type: 'string', default: 'nested-output.txt' },
    goalContent: { type: 'string', default: 'Nested workflow content' }
  },
  state: { initial: {} },
  flow: {
    round: {
      start: 'invokeChild',
      steps: [
        {
          type: 'workflow',
          key: 'invokeChild',
          workflowId: 'referenced-cli.v1',
          input: {
            filename: '{{user.goalFile}}',
            content: '{{user.goalContent}}'
          },
          inputSchema: {
            type: 'object',
            properties: {
              filename: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['filename', 'content']
          },
          exits: [
            {
              condition: { field: 'parsed.outcome', equals: 'written' },
              outcome: 'child-completed',
              reason: 'Nested workflow produced requested file'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'child-default',
        reason: 'Nested workflow finished without explicit exit'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition

const workflowReferenceWorkflowDefinition = validateWorkflowDefinition(workflowReferenceWorkflowDocument)

const referencedCliWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'referenced-cli.v1',
  description: 'CLI-only workflow used for nested workflow reference coverage.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [{ role: 'observer' as const, nameTemplate: '{{runId}}-ref-observer' }]
  },
  parsers: {
    noop: { type: 'unknown' as const }
  },
  roles: {
    observer: {
      systemPrompt: 'Minimal role for referenced CLI workflow. No agent turns should execute.',
      parser: 'noop',
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
        webfetch: false
      }
    }
  },
  user: {
    filename: { type: 'string', default: 'nested-output.txt' },
    content: { type: 'string', default: 'Nested workflow content' }
  },
  state: { initial: {} },
  flow: {
    round: {
      start: 'writeFile',
      steps: [
        {
          type: 'cli',
          key: 'writeFile',
          command: 'bash',
          args: ['-lc', 'printf "%s" "{{user.content}}" > "{{user.filename}}"'],
          argsSchema: { type: 'array', items: { type: 'string' } },
          exits: [
            {
              condition: 'always',
              outcome: 'written',
              reason: 'CLI child workflow wrote requested file'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'written',
        reason: 'CLI child workflow finished'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition

const referencedCliWorkflowDefinition = validateWorkflowDefinition(referencedCliWorkflowDocument)

async function referenceRunCliArgs(input: any) {
  const filename = String(input.scope.user.filename ?? input.args.arg1 ?? 'nested-output.txt')
  const content = String(input.scope.user.content ?? '')
  const target = path.join(input.cwd, filename)
  const buffer = Buffer.from(content)
  fs.writeFileSync(target, buffer)
  return { stdout: buffer.toString(), stderr: '', stdoutBuffer: buffer, exitCode: 0 }
}

function commandExists(cmd: string): boolean {
  const res = spawnSync('which', [cmd])
  return res.status === 0
}

function initGitRepo(directory: string) {
  try {
    execSync('git init', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.email "agent@example.com"', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.name "HyperAgent"', { cwd: directory, stdio: 'ignore' })
    execSync('git add .', { cwd: directory, stdio: 'ignore' })
    execSync('git commit --allow-empty -m "Initialize workspace"', { cwd: directory, stdio: 'ignore' })
  } catch (error) {
    throw new Error(
      `Failed to initialize git workspace in ${directory}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

const model = 'github-copilot/gpt-5-mini'

const workflowRegistry = {
  [referencedCliWorkflowDefinition.id]: referencedCliWorkflowDefinition
}

describe('Workflow references', () => {
  opencodeTestHooks()

  it('executes a referenced child workflow with hardcoded inputs', async () => {
    const sessionDir = path.join(os.tmpdir(), `.tests/workflow-ref-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })
    initGitRepo(sessionDir)

    const goalFile = 'workflow-ref-output.txt'
    const goalContent = 'Created by nested workflow reference.'

    const run = await runAgentWorkflow(workflowReferenceWorkflowDefinition, {
      user: { goalFile, goalContent },
      model,
      sessionDir,
      workflows: workflowRegistry,
      runCliArgs: referenceRunCliArgs
    })

    const result = await run.result
    expect(result.outcome).toBe('child-completed')
    expect(result.rounds.length).toBeGreaterThan(0)

    const round = result.rounds[0]
    const step = round.steps.invokeChild
    expect(step?.type).toBe('workflow')
    if (step?.type === 'workflow') {
      expect(step.parsed.outcome).toBe('written')
      expect(step.parsed.rounds).toBe(1)
      expect(typeof step.parsed.runId).toBe('string')
      expect(step.parsed.details?.rounds?.length).toBeGreaterThanOrEqual(1)
    }

    const outputPath = path.join(sessionDir, goalFile)
    expect(fs.existsSync(outputPath)).toBe(true)
    const content = fs.readFileSync(outputPath, 'utf8')
    expect(content).toBe(goalContent)
  }, 240_000)

  it('validates child workflow inputs against the provided schema', async () => {
    const sessionDir = path.join(os.tmpdir(), `.tests/workflow-ref-invalid-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })
    initGitRepo(sessionDir)

    const run = await runAgentWorkflow(workflowReferenceWorkflowDefinition, {
      // goalFile must be a string per inputSchema; number should fail after templating/parsing
      user: { goalFile: 123 as unknown as string, goalContent: 'ok' },
      model,
      sessionDir,
      workflows: workflowRegistry,
      runCliArgs: referenceRunCliArgs
    })

    await expect(run.result).rejects.toThrow(/Invalid input/i)
  }, 240_000)
})
