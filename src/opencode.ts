import type { FileDiff, OpencodeClient, Part, Session, TextPart } from '@opencode-ai/sdk'
import fs from 'fs'
import path from 'path'

let opencodeServer: {
  url: string
  close(): void
} | null = null
const opencodeClients: { [directory: string]: OpencodeClient } = {}

type SummaryWithDiffs = { title?: string; body?: string; diffs: FileDiff[] }

const extractSummaryDiffs = (summary: SummaryWithDiffs | boolean | undefined): FileDiff[] => {
  if (!summary || typeof summary === 'boolean') return []
  return Array.isArray(summary.diffs) ? summary.diffs : []
}

const resetOpencodeClients = () => {
  for (const key of Object.keys(opencodeClients)) {
    delete opencodeClients[key]
  }
}

export const closeOpencodeServer = () => {
  if (opencodeServer) {
    opencodeServer.close()
    opencodeServer = null
  }
  resetOpencodeClients()
}

// opencode freaks out if you try to import it statically
const getSdk = async () => await import('@opencode-ai/sdk')

/**
 * Starts a singleton Opencode server instance for use by clients.
 *
 * @returns An object containing the server URL and a close function.
 */
export const getOpencodeServer = async (): Promise<{
  url: string
  close(): void
}> => {
  if (opencodeServer) return opencodeServer
  const sdk = await getSdk()
  const preferredPort = process.env.OPENCODE_SERVER_PORT
  const port = preferredPort && Number.isFinite(Number(preferredPort)) ? Number(preferredPort) : 0
  const server = await sdk.createOpencodeServer({ port })
  opencodeServer = {
    url: server.url,
    close: () => {
      server.close()
      opencodeServer = null
      resetOpencodeClients()
    }
  }
  return opencodeServer
}

/**
 * Creates and returns an Opencode client connected to the singleton server.
 *
 * @param directory - The directory to be used by the Opencode client.
 * @returns An instance of OpencodeClient.
 */
export const getOpencodeClient = async (directory: string): Promise<OpencodeClient> => {
  if (!opencodeServer) {
    resetOpencodeClients()
  }

  if (!opencodeClients[directory]) {
    const server = await getOpencodeServer()
    const sdk = await getSdk()
    const opencode = await sdk.createOpencodeClient({
      baseUrl: server.url,
      directory: directory
    })
    opencodeClients[directory] = opencode
  }

  return opencodeClients[directory]
}

type CreateSessionOptions = {
  name?: string
}

/**
 * Creates and returns a new Opencode session for the specified directory.
 *
 * @param directory - The directory for which the session is created.
 * @returns A Promise that resolves to a Session object.
 */
export const createSession = async (directory: string, options: CreateSessionOptions = {}): Promise<Session> => {
  const opencode = await getOpencodeClient(directory)

  const session = await opencode.session.create({
    query: {
      directory
    },
    body: options.name ? { title: options.name } : undefined
  })

  if (!session?.data!) throw new Error('Failed to create Opencode session')

  return session?.data!
}

export const getSession = async (directory: string, id: string): Promise<Session | null> => {
  const opencode = await getOpencodeClient(directory)

  const sessions = await opencode.session.list({
    query: {
      directory
    }
  })

  if (!sessions?.data || sessions.data.length === 0) return null

  return sessions.data.find((session) => session.id === id) || null
}

/** Prompts the specified Opencode session with a given prompt.
 *
 * @param session - The Opencode session to be prompted.
 * @param prompts - Array of prompt parts to send to the session.
 * @param model - Model identifier in the form `provider/model`.
 * @param agent - Optional agent name to invoke (preferred over `@agent` mentions).
 * @param signal - Optional AbortSignal to cancel the request.
 * @returns A Promise that resolves to the response data from the prompt.
 */
export const promptSession = async (
  session: Session,
  prompts: string[],
  model: string,
  agent?: string,
  signal?: AbortSignal
) => {
  const opencode = await getOpencodeClient(session.directory)

  const [providerID, modelID] = model.split('/')

  const response = await opencode.session.prompt({
    path: { id: session.id },
    body: {
      model: { providerID, modelID },
      parts: prompts.map((prompt) => ({ type: 'text', text: prompt })),
      agent
    },
    signal
  })

  const payload = (response?.data ?? {}) as { parts?: Part[] }

  if (!Array.isArray(payload.parts) || !payload.parts?.length) {
    console.error('Opencode session prompt returned no response parts', {
      sessionId: session.id,
      model,
      agent,
      prompts,
      response
    })
    throw new Error('Opencode session prompt returned no response parts')
  }
  const parts: Part[] = payload.parts

  return { ...(payload as Record<string, unknown>), parts }
}

export const getMessageDiff = async (session: Session, messageID: string): Promise<FileDiff[]> => {
  if (!messageID) return []

  const opencode = await getOpencodeClient(session.directory)
  const directoryQuery = session.directory ? { directory: session.directory } : {}

  const response = await opencode.session.diff({
    path: { id: session.id },
    query: { ...directoryQuery, messageID }
  })

  if (!response?.data!) throw new Error('Failed to retrieve Opencode message diff')
  if (response.data.length > 0) {
    return response.data
  }

  try {
    const message = await opencode.session.message({
      path: { id: session.id, messageID },
      query: directoryQuery
    })
    const summaryDiffs = extractSummaryDiffs(message?.data?.info?.summary)
    if (summaryDiffs.length > 0) {
      return summaryDiffs
    }
  } catch {}

  return []
}

export const extractResponseText = (response?: Part[]): string => {
  if (!Array.isArray(response) || response.length === 0) {
    return JSON.stringify({ status: 'error', summary: 'opencode response contained no parts' })
  }
  const textPart = response.filter((part) => part.type === 'text').at(-1) as TextPart | undefined
  if (textPart?.text) {
    return textPart.text
  }
  return JSON.stringify({ status: 'error', summary: 'opencode response contained no text parts' })
}

export const getAgents = async (opencode: OpencodeClient, directory: string) => {
  return await opencode.app.agents({ query: { directory } })
}

export const TOOL_KEYS = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'list',
  'patch',
  'todowrite',
  'todoread',
  'webfetch'
] as const

type ToolKey = (typeof TOOL_KEYS)[number]

export type ToolOptions = Partial<Record<ToolKey, boolean>>

export const createAgentViaMarkdown = async (
  directory: string,
  name: string,
  model: string,
  instructions: string,
  tools?: ToolOptions
) => {
  const [providerID, modelID] = model.split('/')

  const agentsDir = path.join(directory, '.opencode', 'agent')
  await fs.promises.mkdir(agentsDir, { recursive: true })

  const filename = `${name.replace(/[^a-z0-9-_.]/gi, '-').toLowerCase()}.md`
  const filePath = path.join(agentsDir, filename)

  const exists = await fs.promises
    .access(filePath)
    .then(() => true)
    .catch(() => false)

  if (exists) {
    return { filePath }
  }

  const frontmatterLines: string[] = [
    '---',
    `description: ${name}`,
    'mode: primary',
    `model: ${providerID}/${modelID}`,
    'tools:'
  ]

  for (const key of TOOL_KEYS) {
    const val = tools && typeof tools[key] === 'boolean' ? tools[key] : false
    frontmatterLines.push(`  ${key}: ${val ? 'true' : 'false'}`)
  }

  frontmatterLines.push('permission:')

  for (const key of ['edit', 'bash', 'webfetch']) {
    const val = tools && (tools as any)[key] ? 'allow' : 'deny'
    frontmatterLines.push(`  ${key}: ${val}`)
  }

  frontmatterLines.push('---', '', instructions)

  await fs.promises.writeFile(filePath, frontmatterLines.join('\n'))

  // hack to force opencode to pick up new config
  closeOpencodeServer()

  return { filePath }
}

export type AgentConfig = {
  description?: string
  mode: 'primary' | 'subagent'
  model: string
  prompt: string
  temperature?: number
  tools: ToolOptions
  permission: Record<string, 'allow' | 'ask' | 'deny'>
}

export type OpencodeConfig = {
  $schema: 'https://opencode.ai/config.json'
  agent?: Record<string, AgentConfig>
}

/** alternative API using opencode.json */
export const createAgentViaConfig = async (
  directory: string,
  name: string,
  model: string,
  instructions: string,
  tools?: ToolOptions
) => {
  const [providerID, modelID] = model.split('/')

  const configPath = path.join(directory, 'opencode.json')
  let config: OpencodeConfig = { $schema: 'https://opencode.ai/config.json' }
  try {
    const raw = await fs.promises.readFile(configPath, 'utf8')
    config = JSON.parse(raw)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw err
    }
    // missing config is fine; we'll create one
    config = { $schema: 'https://opencode.ai/config.json' }
  }

  // ensure agent map exists
  if (typeof config.agent !== 'object' || config.agent === null) {
    config.agent = {}
  }

  // If agent already exists, leave it untouched
  if (config.agent?.[name]) {
    return { configPath }
  }

  const agentConfig: AgentConfig = {
    description: name,
    mode: 'primary',
    model: `${providerID}/${modelID}`,
    prompt: instructions,
    tools: {},
    permission: {}
  }

  for (const key of TOOL_KEYS) {
    agentConfig.tools[key] = tools && typeof tools[key] === 'boolean' ? tools[key] : false
    if (key === 'edit' || key === 'bash' || key === 'webfetch')
      agentConfig.permission[key] = tools && tools[key] ? 'allow' : 'deny'
  }

  config.agent[name] = agentConfig

  await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')

  // hack to force opencode to pick up new config
  closeOpencodeServer()

  return { configPath }
}

export const createAgent = createAgentViaMarkdown
