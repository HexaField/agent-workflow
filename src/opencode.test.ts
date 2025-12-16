import {
  createAgent,
  createSession,
  getAgents,
  getMessageDiff,
  getOpencodeClient,
  promptSession
} from '@hexafield/agent-workflow'
import { Part, TextPart } from '@opencode-ai/sdk'
import { execSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { opencodeTestHooks } from './opencodeTestHooks'

//note: big-pickle likes to have a reasoning step
const MODEL = 'github-copilot/gpt-5-mini' // 'opencode/big-pickle'

const initGitRepo = (directory: string) => {
  try {
    execSync('git init', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.email "agent@example.com"', { cwd: directory, stdio: 'ignore' })
    execSync('git config user.name "HyperAgent"', { cwd: directory, stdio: 'ignore' })
    execSync('git add .', { cwd: directory, stdio: 'ignore' })
    execSync('git commit --allow-empty -m "Initialize workspace"', { cwd: directory, stdio: 'ignore' })
  } catch (error) {
    throw new Error(`Failed to initialize git workspace: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const createSessionDir = () => {
  const sessionDir = path.join(os.tmpdir(), '.tests', `opencode-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.mkdirSync(sessionDir, { recursive: true })
  initGitRepo(sessionDir)
  return sessionDir
}

describe('Opencode Module', () => {
  opencodeTestHooks()

  it('should create a session successfully', async () => {
    const sessionDir = createSessionDir()
    const session = await createSession(sessionDir)
    expect(session).toBeDefined()
    expect(session.id).toBeDefined()
  })

  it('should prompt a session successfully', async () => {
    const sessionDir = createSessionDir()
    const session = await createSession(sessionDir)
    const promptText = 'What is the capital of France?'
    const response = await promptSession(session, [promptText], MODEL)
    expect(response).toBeDefined()
    expect(response.parts.length).toBe(3)
    const textParts = response.parts[1] as TextPart
    const answer = textParts.text.trim().toLowerCase()
    expect(answer.includes('paris')).toBe(true)
  }, 120_000)

  it('should create and invoke a project-scoped agent', async () => {
    const sessionDir = createSessionDir()

    const AGENT_NAME = 'test-agent'
    const TOKEN = 'AGENT_CREATE_TEST_OK'
    const agentPrompt = `You are the ${AGENT_NAME} agent. When invoked, respond exactly with:\n${TOKEN}`

    const created = await createAgent(sessionDir, AGENT_NAME, MODEL, agentPrompt)
    expect(created).toBeDefined()

    const opencode = await getOpencodeClient(sessionDir)
    const agentsResp = await getAgents(opencode, sessionDir)
    const agentList = (agentsResp && agentsResp.data) || []
    const found = agentList.find((a) => a.name === AGENT_NAME)
    expect(found).toBeTruthy()

    const session = await createSession(sessionDir)
    const response = await promptSession(session, [`please respond`], MODEL, AGENT_NAME)
    expect(response).toBeDefined()
    const textParts = (response.parts || []).filter((p: Part) => p?.type === 'text') as TextPart[]
    const lastText = textParts.length ? textParts.at(-1)!.text : ''
    expect(typeof lastText).toBe('string')

    expect(lastText.includes(TOKEN)).toBe(true)
  }, 120_000)

  /** @todo fails intermittently */
  it.skip('should retrieve message diffs after file edits', async () => {
    const sessionDir = createSessionDir()

    const AGENT_NAME = 'test-agent'
    const agentPrompt = `You are the ${AGENT_NAME} agent. When invoked, do as the user instructs.`

    const created = await createAgent(sessionDir, AGENT_NAME, MODEL, agentPrompt, {
      read: true,
      edit: true,
      bash: true
    })
    expect(created).toBeDefined()

    const session = await createSession(sessionDir)
    const promptText = `Create (or overwrite) a file named "opencode-test.md" in the workspace root with the exact contents: "Hello from the Opencode tests" followed by a newline. After writing, confirm the file contents.`
    const response = await promptSession(session, [promptText], MODEL, AGENT_NAME)
    const messageId = response.parts.find((part) => typeof part?.messageID === 'string')?.messageID as
      | string
      | undefined

    expect(messageId).toBeDefined()

    const diffs = await getMessageDiff(session, messageId!)
    expect(Array.isArray(diffs)).toBe(true)

    const filePath = path.join(sessionDir, 'opencode-test.md')
    expect(fs.existsSync(filePath)).toBe(true)
    const content = fs.readFileSync(filePath, 'utf8')
    expect(content.toLowerCase()).toContain('hello from the opencode tests')

    const readmeDiff = diffs.find((diff) => diff.file.toLowerCase().includes('opencode-test.md'))
    expect(readmeDiff).toBeTruthy()
    expect(readmeDiff?.after.toLowerCase()).toContain('hello from the opencode tests')
  }, 120_000)
})
