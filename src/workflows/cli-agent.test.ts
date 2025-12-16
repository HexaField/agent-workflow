import { runAgentWorkflow } from '@hexafield/agent-workflow'
import { execSync, spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { CliRuntimeInvocation, CliRuntimeResult } from '../agent-orchestrator'
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
    initial: { appendLine: '' }
  },
  user: {
    content: { type: 'string', default: 'CLI step content' }
  },
  flow: {
    round: {
      start: 'writeLine',
      steps: [
        {
          type: 'cli',
          key: 'writeLine',
          command: 'printf',
          argsObject: {
            arg0: '%s\n',
            arg1: '{{user.content}}'
          },
          argsSchema: {
            type: 'object',
            properties: {
              arg0: { type: 'string' },
              arg1: { type: 'string' }
            },
            required: ['arg0', 'arg1']
          },
          capture: 'buffer'
        },
        {
          type: 'cli',
          key: 'writeFile',
          command: 'tee',
          argsObject: {
            arg0: 'cli-output.txt'
          },
          argsSchema: {
            type: 'object',
            properties: {
              arg0: { type: 'string' }
            },
            required: ['arg0']
          },
          stdinFrom: 'steps.writeLine.parsed.stdoutBuffer',
          capture: 'both'
        },
        {
          type: 'cli',
          key: 'appendFile',
          command: 'tee',
          argsObject: {
            flag: '-a',
            file: 'cli-output.txt'
          },
          argsSchema: {
            type: 'object',
            properties: {
              flag: { type: 'string' },
              file: { type: 'string' }
            },
            required: ['flag', 'file']
          },
          stdinFrom: 'state.appendLine',
          capture: 'both'
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

function defaultRunCliArgs(input: CliRuntimeInvocation): Promise<CliRuntimeResult> {
  const captureBuffer = input.capture === 'buffer' || input.capture === 'both'
  const captureText = input.capture === 'text' || input.capture === 'both'
  const argv = Object.keys(input.args ?? {})
    .sort()
    .map((key) => String(input.args?.[key]))
  const child = spawn(input.step.command, argv, { cwd: input.cwd, shell: false })
  let stdout = ''
  let stderr = ''
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  child.stdout?.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (captureBuffer) stdoutChunks.push(buffer)
    if (captureText) stdout += buffer.toString()
  })
  child.stderr?.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (captureBuffer) stderrChunks.push(buffer)
    if (captureText) stderr += buffer.toString()
  })

  if (input.stdinValue !== undefined && child.stdin) {
    if (typeof input.stdinValue === 'string') {
      child.stdin.end(input.stdinValue)
    } else if (input.stdinValue instanceof Uint8Array) {
      child.stdin.end(Buffer.from(input.stdinValue))
    } else {
      child.stdin.end(String(input.stdinValue))
    }
  }

  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      const stdoutBuffer = captureBuffer ? Buffer.concat(stdoutChunks) : undefined
      const stderrBuffer = captureBuffer ? Buffer.concat(stderrChunks) : undefined
      if (!captureText && stdoutBuffer) {
        stdout = stdoutBuffer.toString()
      }
      if (!captureText && stderrBuffer) {
        stderr = stderrBuffer.toString()
      }
      resolve({
        stdout,
        stderr,
        stdoutBuffer,
        stderrBuffer,
        exitCode: code ?? -1
      })
    })
  })
}

export const cliPipelineWorkflowDocument = {
  $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
  id: 'cli-pipeline.v1',
  description: 'Two CLI steps that pipe binary stdout directly to stdin of the next step.',
  model: 'github-copilot/gpt-5-mini',
  sessions: {
    roles: [{ role: 'runner' as const, nameTemplate: '{{runId}}-pipeline' }]
  },
  parsers: {
    noop: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  roles: {
    runner: {
      systemPrompt: 'unused for CLI-only workflow',
      parser: 'noop',
      tools: {}
    }
  },
  state: { initial: {} },
  flow: {
    round: {
      start: 'produce',
      steps: [
        {
          type: 'cli',
          key: 'produce',
          command: 'printf',
          argsObject: {
            arg0: '%b',
            arg1: '\\x00\\x01\\x02\\x03\\x04'
          },
          argsSchema: {
            type: 'object',
            properties: {
              arg0: { type: 'string' },
              arg1: { type: 'string' }
            },
            required: ['arg0', 'arg1']
          },
          capture: 'buffer'
        },
        {
          type: 'cli',
          key: 'pipe',
          command: 'xxd',
          argsObject: {
            arg0: '-p'
          },
          argsSchema: {
            type: 'object',
            properties: {
              arg0: { type: 'string' }
            },
            required: ['arg0']
          },
          stdinFrom: 'steps.produce.parsed.stdoutBuffer',
          capture: 'both',
          exits: [
            {
              condition: 'always',
              outcome: 'completed',
              reason: 'pipeline finished'
            }
          ]
        }
      ],
      maxRounds: 1,
      defaultOutcome: {
        outcome: 'completed',
        reason: 'CLI pipeline finished'
      }
    }
  }
} as const satisfies AgentWorkflowDefinition

const cliPipelineWorkflowDefinition = validateWorkflowDefinition(cliPipelineWorkflowDocument)

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
      sessionDir,
      runCliArgs: defaultRunCliArgs
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
    expect(output.trim().split('\n')).toEqual([content])
  }, 240_000)

  it('throws when CLI args are rejected by validator', async () => {
    const sessionDir = path.join(os.tmpdir(), `.tests/cli-agent-reject-${Date.now()}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })
    initGitRepo(sessionDir)

    const validationSpy = vi.fn().mockReturnValue(false)

    const run = await runAgentWorkflow(cliAgentWorkflowDefinition, {
      user: { content: 'blocked by validator' },
      model,
      sessionDir,
      runCliArgs: async (input) => {
        const ok = validationSpy(input.args, input.step)
        if (!ok) throw new Error('rejected by runCliArgs')
        return defaultRunCliArgs(input)
      }
    })

    await expect(run.result).rejects.toThrow(/rejected by runCliArgs/)
    expect(validationSpy).toHaveBeenCalled()
    expect(validationSpy.mock.calls[0][0]).toEqual({
      arg0: '%s\n',
      arg1: 'blocked by validator'
    })
    expect(fs.existsSync(path.join(sessionDir, 'cli-output.txt'))).toBe(false)
  }, 240_000)

  it('pipes binary stdout buffer into next CLI stdin', async () => {
    const sessionDir = path.join(os.tmpdir(), `.tests/cli-agent-pipeline-${Date.now()}`)

    fs.mkdirSync(sessionDir, { recursive: true })
    initGitRepo(sessionDir)

    const run = await runAgentWorkflow(cliPipelineWorkflowDefinition, {
      user: {},
      model,
      sessionDir,
      runCliArgs: defaultRunCliArgs
    })

    const result = await run.result

    expect(result.rounds.length).toBeGreaterThan(0)
    const firstRound = result.rounds[0]
    const produce = firstRound.steps.produce
    const pipe = firstRound.steps.pipe

    expect(produce?.type).toBe('cli')
    if (produce?.type === 'cli') {
      expect(produce.parsed.stdoutBuffer).toBeInstanceOf(Buffer)
      expect(produce.parsed.stdoutBuffer?.equals(Buffer.from([0, 1, 2, 3, 4]))).toBe(true)
    }

    expect(pipe?.type).toBe('cli')
    if (pipe?.type === 'cli') {
      expect(pipe.parsed.stdout).toBe('0001020304')
      expect(pipe.parsed.stdoutBuffer).toBeInstanceOf(Buffer)
      // stdoutBuffer holds the bytes of the hex string produced by the second CLI step
      expect(pipe.parsed.stdoutBuffer?.toString()).toBe('0001020304')
      expect(pipe.parsed.stderr).toBe('')
      expect(pipe.parsed.exitCode).toBe(0)
    }
  }, 240_000)
})
