import { z } from 'zod'
import { ToolOptions } from './opencode'
import {
  AgentWorkflowDefinition,
  WorkflowParserJsonSchema,
  WorkflowTransitionDefinition,
  validateWorkflowDefinition
} from './workflow-schema'

type ParserDraft =
  | { type: 'unknown'; default?: unknown }
  | { type: 'string'; enum?: string[]; default?: string; minLength?: number; maxLength?: number }
  | { type: 'number'; enum?: number[]; minimum?: number; maximum?: number; integer?: boolean; default?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'array'; items: ParserDraft; default?: unknown[] }
  | {
      type: 'object'
      properties: Record<string, ParserDraft>
      required?: string[]
      additionalProperties?: boolean
      default?: Record<string, unknown>
    }

const isZodSchema = (value: unknown): value is z.ZodTypeAny => {
  return Boolean(value) && typeof (value as { safeParse?: unknown }).safeParse === 'function' && Boolean((value as any)._def)
}

const typeNameOf = (schema: z.ZodTypeAny): string => ((schema as any)?._def?.type as string) || 'unknown'

const unwrapEffects = (schema: z.ZodTypeAny): z.ZodTypeAny => {
  let current = schema
  while (typeNameOf(current) === 'effects') {
    current = (((current as any)._def?.schema as z.ZodTypeAny) ?? current) as z.ZodTypeAny
  }
  return current
}

const unwrapSchema = (
  schema: z.ZodTypeAny
): { inner: z.ZodTypeAny; defaultValue?: unknown; required: boolean } => {
  let current = unwrapEffects(schema)
  let required = true
  let defaultValue: unknown

  const typeName = typeNameOf(current)
  if (typeName === 'default') {
    const def: any = (current as any)._def
    defaultValue = def?.defaultValue
    current = ((current as any)._def?.innerType as z.ZodTypeAny) ?? current
    required = false
  }

  if (typeNameOf(current) === 'optional') {
    const nested = unwrapSchema(((current as any)._def?.innerType as z.ZodTypeAny) ?? current)
    required = false
    current = nested.inner
    if (defaultValue === undefined && nested.defaultValue !== undefined) {
      defaultValue = nested.defaultValue
    }
  }

  if (typeNameOf(current) === 'nullable') {
    throw new Error('Nullable schemas are not supported for workflow conversion')
  }

  return { inner: unwrapEffects(current), defaultValue, required }
}

const extractStringChecks = (schema: z.ZodTypeAny) => {
  const checks: any[] = ((schema as any)._def?.checks ?? []) as any[]
  let minLength: number | undefined
  let maxLength: number | undefined
  for (const check of checks) {
    if (check?.kind === 'min') minLength = check.value
    else if (check?.kind === 'max') maxLength = check.value
    else if (check?.kind && check.kind !== 'email' && check.kind !== 'url' && check.kind !== 'uuid' && check.kind !== 'regex') {
      throw new Error('Unsupported string constraint in Zod schema')
    }
  }
  return { minLength, maxLength }
}

const extractNumberChecks = (schema: z.ZodTypeAny) => {
  const checks: any[] = ((schema as any)._def?.checks ?? []) as any[]
  let minimum: number | undefined
  let maximum: number | undefined
  let integer = false
  for (const check of checks) {
    if (check?.kind === 'min') minimum = check.value
    else if (check?.kind === 'max') maximum = check.value
    else if (check?.kind === 'int') integer = true
    else if (check?.kind && check.kind !== 'finite') {
      throw new Error('Unsupported number constraint in Zod schema')
    }
  }
  return { minimum, maximum, integer }
}

const convertUnionOfLiterals = (schemas: readonly z.ZodTypeAny[]): ParserDraft => {
  const literals = schemas.map((s) => unwrapSchema(s).inner).filter((s) => typeNameOf(s) === 'literal')
  if (literals.length !== schemas.length) {
    throw new Error('Only unions of literals are supported')
  }
  const values = literals.map((l) => {
    const def: any = (l as any)._def ?? {}
    if (def.value !== undefined) return def.value
    if (Array.isArray(def.values) && def.values.length > 0) return def.values[0]
    return undefined
  })
  if (values.every((v) => typeof v === 'string')) return { type: 'string', enum: values as string[] }
  if (values.every((v) => typeof v === 'number')) return { type: 'number', enum: values as number[] }
  if (values.every((v) => typeof v === 'boolean')) {
    if (values.length === 1) return { type: 'boolean', default: values[0] as boolean }
    throw new Error('Boolean literal unions with multiple values are not supported')
  }
  throw new Error('Unsupported literal union type')
}

export const zodToWorkflowParserJsonSchema = (schema: z.ZodTypeAny): WorkflowParserJsonSchema => {
  const { inner, defaultValue } = unwrapSchema(schema)
  const typeName = typeNameOf(inner)
  let parsed: ParserDraft

  if (typeName === 'unknown' || typeName === 'any') {
    parsed = { type: 'unknown' }
  } else if (typeName === 'string') {
    const { minLength, maxLength } = extractStringChecks(inner)
    parsed = { type: 'string' }
    if (minLength !== undefined) (parsed as any).minLength = minLength
    if (maxLength !== undefined) (parsed as any).maxLength = maxLength
  } else if (typeName === 'number') {
    const { minimum, maximum, integer } = extractNumberChecks(inner)
    parsed = { type: 'number' }
    if (minimum !== undefined) (parsed as any).minimum = minimum
    if (maximum !== undefined) (parsed as any).maximum = maximum
    if (integer) (parsed as any).integer = true
  } else if (typeName === 'boolean') {
    parsed = { type: 'boolean' }
  } else if (typeName === 'array') {
    const child = ((inner as any)._def?.element as z.ZodTypeAny) ?? z.unknown()
    parsed = { type: 'array', items: zodToWorkflowParserJsonSchema(child) as ParserDraft }
  } else if (typeName === 'object') {
    const properties: Record<string, ParserDraft> = {}
    const requiredKeys: string[] = []
    const shape: Record<string, z.ZodTypeAny> = ((inner as any)._def?.shape ?? {}) as Record<string, z.ZodTypeAny>
    for (const [key, value] of Object.entries(shape)) {
      const converted = zodToWorkflowParserJsonSchema(value)
      properties[key] = converted as ParserDraft
      const unwrapped = unwrapSchema(value)
      const hasDefault = (converted as any).default !== undefined || unwrapped.defaultValue !== undefined
      if (unwrapped.required && !hasDefault) {
        requiredKeys.push(key)
      }
    }
    parsed = { type: 'object', properties }
    if (requiredKeys.length > 0) (parsed as any).required = requiredKeys
  } else if (typeName === 'literal') {
    const literalDef: any = (inner as any)._def ?? {}
    const literal = literalDef.value ?? (Array.isArray(literalDef.values) ? literalDef.values[0] : undefined)
    if (typeof literal === 'string') parsed = { type: 'string', enum: [literal] }
    else if (typeof literal === 'number') parsed = { type: 'number', enum: [literal] }
    else if (typeof literal === 'boolean') parsed = { type: 'boolean', default: literal }
    else throw new Error('Unsupported literal type in Zod schema')
  } else if (typeName === 'enum') {
    const entries = ((inner as any)._def?.entries ?? {}) as Record<string, string>
    const values = Object.values(entries)
    parsed = { type: 'string', enum: [...values] }
  } else if (typeName === 'union') {
    const options = ((inner as any)._def?.options ?? []) as z.ZodTypeAny[]
    parsed = convertUnionOfLiterals(options)
  } else {
    throw new Error('Unsupported Zod schema type for workflow parser conversion')
  }

  if (defaultValue !== undefined) {
    (parsed as any).default = defaultValue
  }

  return parsed as WorkflowParserJsonSchema
}

type CommonStepFields = {
  next?: string
  stateUpdates?: Record<string, string>
  transitions?: WorkflowTransitionDefinition[]
  exits?: WorkflowTransitionDefinition[]
}

type AgentStepDraft = CommonStepFields & {
  type: 'agent'
  key: string
  role: string
  prompt: string[]
}

type CliStepDraft = CommonStepFields & {
  type: 'cli'
  key: string
  command: string
  args?: string[]
  argsObject?: Record<string, string>
  argsSchema?: WorkflowParserJsonSchema
  cwd?: string
  stdinFrom?: string
  capture?: 'text' | 'buffer' | 'both'
}

type WorkflowReferenceStepDraft = CommonStepFields & {
  type: 'workflow'
  key: string
  workflowId: string
  input?: Record<string, unknown>
  inputSchema?: WorkflowParserJsonSchema
}

type TransformStepDraft = CommonStepFields & {
  type: 'transform'
  key: string
  template: unknown
  input?: unknown
  inputSchema?: WorkflowParserJsonSchema
}

type AnyStepDraft = AgentStepDraft | CliStepDraft | WorkflowReferenceStepDraft | TransformStepDraft

const normalizeParserSchema = (schema?: z.ZodTypeAny | WorkflowParserJsonSchema) => {
  if (!schema) return undefined
  return isZodSchema(schema) ? zodToWorkflowParserJsonSchema(schema) : schema
}

const buildAgentStep = (input: Omit<AgentStepDraft, 'type'>): AgentStepDraft => ({
  type: 'agent',
  ...input
})

const buildCliStep = (input: Omit<CliStepDraft, 'type' | 'argsSchema'> & { argsSchema?: z.ZodTypeAny | WorkflowParserJsonSchema }): CliStepDraft => ({
  type: 'cli',
  ...input,
  argsSchema: normalizeParserSchema(input.argsSchema)
})

const buildWorkflowReferenceStep = (
  input: Omit<WorkflowReferenceStepDraft, 'type' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema }
): WorkflowReferenceStepDraft => ({
  type: 'workflow',
  ...input,
  inputSchema: normalizeParserSchema(input.inputSchema)
})

const buildTransformStep = (
  input: Omit<TransformStepDraft, 'type' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema }
): TransformStepDraft => ({
  type: 'transform',
  ...input,
  inputSchema: normalizeParserSchema(input.inputSchema)
})

type RoundDefinitionDraft = {
  start?: string
  steps: AnyStepDraft[]
  maxRounds?: number
  defaultOutcome?: { outcome: string; reason: string }
}

class RoundBuilder {
  private readonly draft: RoundDefinitionDraft

  constructor() {
    this.draft = { steps: [] }
  }

  start(stepKey: string): this {
    this.draft.start = stepKey
    return this
  }

  maxRounds(count: number): this {
    this.draft.maxRounds = count
    return this
  }

  defaultOutcome(outcome: string, reason: string): this {
    this.draft.defaultOutcome = { outcome, reason }
    return this
  }

  agent(key: string, role: string, prompt: string[], options: CommonStepFields = {}): this {
    this.draft.steps.push(buildAgentStep({ key, role, prompt, ...options }))
    return this
  }

  cli(key: string, command: string, options: Omit<CliStepDraft, 'type' | 'key' | 'command' | 'argsSchema'> & { argsSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}): this {
    this.draft.steps.push(buildCliStep({ key, command, ...options }))
    return this
  }

  workflow(key: string, workflowId: string, options: Omit<WorkflowReferenceStepDraft, 'type' | 'key' | 'workflowId' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}): this {
    this.draft.steps.push(buildWorkflowReferenceStep({ key, workflowId, ...options }))
    return this
  }

  transform(key: string, template: unknown, options: Omit<TransformStepDraft, 'type' | 'key' | 'template' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}): this {
    this.draft.steps.push(buildTransformStep({ key, template, ...options }))
    return this
  }

  build(): RoundDefinitionDraft {
    if (!this.draft.defaultOutcome) {
      throw new Error('defaultOutcome is required for workflow rounds')
    }
    if (this.draft.steps.length === 0) {
      throw new Error('At least one step is required in a workflow round')
    }
    return {
      start: this.draft.start,
      steps: [...this.draft.steps],
      maxRounds: this.draft.maxRounds,
      defaultOutcome: this.draft.defaultOutcome
    }
  }
}

type WorkflowDefinitionDraft = {
  id: string
  description?: string
  model?: string
  sessions: { roles: { role: string; nameTemplate?: string }[] }
  parsers: Record<string, WorkflowParserJsonSchema>
  roles: Record<string, { systemPrompt: string; parser: string; tools?: ToolOptions }>
  state?: { initial?: Record<string, string> }
  user?: Record<string, WorkflowParserJsonSchema>
  flow: { bootstrap?: AnyStepDraft; round?: RoundDefinitionDraft }
}

export class WorkflowBuilder {
  private readonly state: WorkflowDefinitionDraft

  constructor(id: string) {
    this.state = {
      id,
      sessions: { roles: [] },
      parsers: {},
      roles: {},
      flow: {}
    }
  }

  description(text: string): this {
    this.state.description = text
    return this
  }

  model(model: string): this {
    this.state.model = model
    return this
  }

  session(role: string, nameTemplate?: string): this {
    this.state.sessions.roles.push({ role, nameTemplate })
    return this
  }

  parser(name: string, schema: z.ZodTypeAny | WorkflowParserJsonSchema): this {
    this.state.parsers[name] = isZodSchema(schema) ? zodToWorkflowParserJsonSchema(schema) : schema
    return this
  }

  role(name: string, config: { systemPrompt: string; parser: string; tools?: ToolOptions }): this {
    this.state.roles[name] = {
      systemPrompt: config.systemPrompt,
      parser: config.parser,
      tools: config.tools
    }
    return this
  }

  user(key: string, schema: z.ZodTypeAny | WorkflowParserJsonSchema): this {
    if (!this.state.user) this.state.user = {}
    this.state.user[key] = isZodSchema(schema) ? zodToWorkflowParserJsonSchema(schema) : schema
    return this
  }

  stateInitial(initial: Record<string, string>): this {
    this.state.state = { initial }
    return this
  }

  bootstrapAgent(key: string, role: string, prompt: string[], options: CommonStepFields = {}): this {
    this.state.flow.bootstrap = buildAgentStep({ key, role, prompt, ...options })
    return this
  }

  bootstrapCli(key: string, command: string, options: Omit<CliStepDraft, 'type' | 'key' | 'command' | 'argsSchema'> & { argsSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}): this {
    this.state.flow.bootstrap = buildCliStep({ key, command, ...options })
    return this
  }

  bootstrapWorkflow(
    key: string,
    workflowId: string,
    options: Omit<WorkflowReferenceStepDraft, 'type' | 'key' | 'workflowId' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}
  ): this {
    this.state.flow.bootstrap = buildWorkflowReferenceStep({ key, workflowId, ...options })
    return this
  }

  bootstrapTransform(
    key: string,
    template: unknown,
    options: Omit<TransformStepDraft, 'type' | 'key' | 'template' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}
  ): this {
    this.state.flow.bootstrap = buildTransformStep({ key, template, ...options })
    return this
  }

  round(builder: (round: RoundBuilder) => void): this {
    const roundBuilder = new RoundBuilder()
    builder(roundBuilder)
    this.state.flow.round = roundBuilder.build()
    return this
  }

  build(): AgentWorkflowDefinition {
    if (!this.state.flow.round) {
      throw new Error('Workflow round must be defined before build()')
    }

    const definition = {
      $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
      id: this.state.id,
      description: this.state.description,
      model: this.state.model,
      sessions: this.state.sessions,
      parsers: Object.keys(this.state.parsers).length ? this.state.parsers : undefined,
      roles: this.state.roles,
      state: this.state.state,
      user: this.state.user,
      flow: this.state.flow
    } as AgentWorkflowDefinition

    return validateWorkflowDefinition(definition)
  }
}

export const workflow = (id: string) => new WorkflowBuilder(id)
