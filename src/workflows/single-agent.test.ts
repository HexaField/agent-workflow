import { getWorkflowRunDiff, runAgentWorkflow } from '@hexafield/agent-workflow/agent-orchestrator'
import { RunMeta } from '@hexafield/agent-workflow/provenance'
import { singleAgentWorkflowDefinition } from '@hexafield/agent-workflow/workflows'
import type { FileDiff } from '@opencode-ai/sdk'
import { execSync, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { opencodeTestHooks } from '../opencodeTestHooks'

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

describe('Single agent loop', () => {
  opencodeTestHooks()

  it('creates provenance and runs at least one agent turn', async () => {
    const sessionDir = path.join(os.tmpdir(), `${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const exists = commandExists('opencode')
    expect(exists, "Required CLI 'opencode' not found on PATH").toBe(true)

    fs.mkdirSync(sessionDir, { recursive: true })

    initGitRepo(sessionDir)

    const scenario = `Create a readme.md file that includes the text "Hello, single agent".`

    const agentRun = await runAgentWorkflow(singleAgentWorkflowDefinition, {
      user: { instructions: scenario },
      model: model,
      sessionDir
    })

    const parsed = await agentRun.result
    expect(typeof agentRun.runId).toBe('string')

    expect(parsed.rounds.length).toBeGreaterThan(0)
    const firstRound = parsed.rounds[0]
    const agentStep = firstRound?.steps.agent
    expect(agentStep).toBeDefined()
    expect(typeof agentStep?.raw).toBe('string')
    const hyperagentDir = path.join(sessionDir, '.hyperagent')

    const metaFiles = fs
      .readdirSync(hyperagentDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(hyperagentDir, f))

    expect(metaFiles.length).toBeGreaterThan(0)

    const logs = metaFiles.map((file) => {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as RunMeta
    })

    expect(logs.length).toBeGreaterThan(0)

    const namespacedAgentName = `${singleAgentWorkflowDefinition.id}.agent`

    for (const entry of logs) {
      expect(typeof entry.id).toBe('string')

      expect(entry.agents.length).toBe(1)
      const agent = entry.agents.find((a) => a.role === namespacedAgentName)
      expect(agent?.sessionId).toBeDefined()

      expect(entry.log.length).toBeGreaterThan(0)
      const agentMessages = entry.log.filter((e) => e.role === namespacedAgentName)
      expect(agentMessages.length).toBeGreaterThan(0)
      const userMessages = entry.log.filter((e) => e.role === 'user')
      expect(userMessages.length).toBeGreaterThan(0)
      expect(
        userMessages.some(
          (message) =>
            typeof message.payload?.instructions === 'string' && message.payload.instructions.includes('Hello')
        )
      ).toBe(true)
    }

    const diffs: FileDiff[] = await getWorkflowRunDiff(agentRun.runId, sessionDir, { role: namespacedAgentName })
    expect(diffs.length).toBeGreaterThan(0)
    const readmeDiff = diffs.find((diff) => diff.file.toLowerCase().includes('readme.md'))
    expect(readmeDiff).toBeTruthy()
    expect(readmeDiff?.after.toLowerCase()).toContain('hello, single agent')
  }, 240_000)
})
