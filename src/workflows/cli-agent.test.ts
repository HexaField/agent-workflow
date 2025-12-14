import { runAgentWorkflow } from '@hexafield/agent-workflow'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { opencodeTestHooks } from '../opencodeTestHooks'
import { AgentWorkflowDefinition, validateWorkflowDefinition } from '../workflow-schema'

export const cliAgentWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'cli-agent.v1',
  description: 'Runs two CLI steps then an agent confirmation step within one round.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [{ role: 'agent' as const, nameTemplate: '{{runId}}-cli-agent' }]
  },
  parsers: {
    confirmation: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        message: { type: 'string', default: '' }
      },
      required: ['ok']
    }
  },
  roles: {
    agent: {
      systemPrompt:
        'You are a concise validator. Confirm the CLI work completed. Reply ONLY with JSON matching {"ok": true, "message": string}.',
      parser: 'confirmation',
      tools: {
        read: true,
        write: false,
        edit: false,
        bash: false,
        grep: false,
        glob: true,
        list: true,
        patch: false,
        todowrite: false,
        todoread: false,
        webfetch: false
      }
    }
  },
  state: {
    initial: {}
  },
  user: {
    content: { type: 'string', default: 'CLI step content' }
  },
  flow: {
    round: {
      start: 'writeFile',
      steps: [
        {
          type: 'cli',
          key: 'writeFile',
          command: 'bash',
          args: ['-lc', 'printf "%s\n" "{{user.content}}" "cli step 1" > cli-output.txt'],
          argsSchema: { type: 'array', items: { type: 'string' } }
        },
        {
          type: 'cli',
          key: 'appendFile',
          command: 'bash',
          args: ['-lc', 'echo "cli step 2" >> cli-output.txt'],
          argsSchema: { type: 'array', items: { type: 'string' } }
        },
        {
          type: 'agent',
          key: 'agent',
          role: 'agent' as const,
          prompt: [
            'The CLI steps wrote and appended to cli-output.txt.',
            'Respond with {"ok": true, "message": "<short confirmation>"}. No prose outside JSON.'
          ],
          exits: [
            {
              condition: 'always',
              outcome: 'completed',
              reason: 'CLI + agent sequence finished'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'completed',
        reason: 'CLI-agent workflow completed'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition

const cliAgentWorkflowDefinition = validateWorkflowDefinition(cliAgentWorkflowDocument)

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

describe('CLI + Agent workflow', () => {
  opencodeTestHooks()

  it('runs two CLI steps then an agent step in sequence', async () => {
    const sessionDir = path.join(os.tmpdir(), `.tests/cli-agent-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })
    initGitRepo(sessionDir)

    const content = 'hello from cli'

    const run = await runAgentWorkflow(cliAgentWorkflowDefinition, {
      user: { content },
      model,
      sessionDir
    })

    const result = await run.result

    expect(result.rounds.length).toBeGreaterThan(0)
    const firstRound = result.rounds[0]
    const writeStep = firstRound.steps.writeFile
    const appendStep = firstRound.steps.appendFile
    const agentStep = firstRound.steps.agent

    expect(writeStep?.type).toBe('cli')
    if (writeStep?.type === 'cli') {
      expect(writeStep.parsed.exitCode).toBe(0)
    }

    expect(appendStep?.type).toBe('cli')
    if (appendStep?.type === 'cli') {
      expect(appendStep.parsed.exitCode).toBe(0)
    }

    expect(agentStep?.type).toBe('agent')
    if (agentStep?.type === 'agent') {
      const parsed = agentStep.parsed as { ok?: boolean }
      expect(parsed.ok).toBe(true)
    }

    const outputPath = path.join(sessionDir, 'cli-output.txt')
    expect(fs.existsSync(outputPath)).toBe(true)
    const output = fs.readFileSync(outputPath, 'utf8')
    expect(output).toContain(content)
    expect(output).toContain('cli step 1')
    expect(output).toContain('cli step 2')
  }, 240_000)
})
