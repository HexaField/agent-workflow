import { z } from 'zod'
import { ToolOptions } from './opencode'
import { WorkflowParserJsonSchema, WorkflowTransitionDefinition, validateWorkflowDefinition } from './workflow-schema'

type AnyParserSchema = WorkflowParserJsonSchema | z.ZodTypeAny
type InferParserSchema<TSchema> = TSchema extends z.ZodTypeAny
  ? WorkflowParserJsonSchema
  : TSchema extends WorkflowParserJsonSchema
    ? TSchema
    : never
type WorkflowRoleConfig<TParserName extends string> = { systemPrompt: string; parser: TParserName; tools?: ToolOptions }
type RoleNames<TRoles> = keyof TRoles extends never ? string : keyof TRoles & string

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

type AgentStepDraft<TRole extends string = string> = CommonStepFields & {
  type: 'agent'
  key: string
  role: TRole
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

type AnyStepDraft<TRole extends string = string> =
  | AgentStepDraft<TRole>
  | CliStepDraft
  | WorkflowReferenceStepDraft
  | TransformStepDraft
type NormalizedParserSchema<TSchema extends AnyParserSchema> = InferParserSchema<TSchema>

const normalizeParserSchema = <TSchema extends AnyParserSchema>(schema?: TSchema): NormalizedParserSchema<TSchema> | undefined => {
  if (!schema) return undefined
  return (isZodSchema(schema) ? zodToWorkflowParserJsonSchema(schema) : schema) as NormalizedParserSchema<TSchema>
}

const buildAgentStep = <TRole extends string>(input: Omit<AgentStepDraft<TRole>, 'type'>): AgentStepDraft<TRole> => ({
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
type RoundDefinitionDraft<TRole extends string = string> = {
  start?: string
  steps: AnyStepDraft<TRole>[]
  maxRounds?: number
  defaultOutcome: { outcome: string; reason: string }
}

class RoundBuilder<TRole extends string> {
  private readonly draft: Omit<RoundDefinitionDraft<TRole>, 'defaultOutcome'> & {
    defaultOutcome?: RoundDefinitionDraft<TRole>['defaultOutcome']
  }

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

  agent(key: string, role: TRole, prompt: string[], options: CommonStepFields = {}): this {
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

  build(): RoundDefinitionDraft<TRole> {
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

type WorkflowDefinitionDraft<
  TParsers extends Record<string, WorkflowParserJsonSchema>,
  TRoles extends Record<string, WorkflowRoleConfig<keyof TParsers & string>>,
  TUser extends Record<string, WorkflowParserJsonSchema> | undefined,
  TRound extends RoundDefinitionDraft<RoleNames<TRoles>> | undefined,
  TBootstrap extends AnyStepDraft<RoleNames<TRoles>> | undefined
> = {
  $schema?: string
  id: string
  description?: string
  model?: string
  sessions: { roles: ReadonlyArray<{ role: RoleNames<TRoles> | string; nameTemplate?: string }> }
  parsers?: TParsers
  roles: TRoles
  state?: { initial?: Record<string, string> }
  user?: TUser
  flow: { bootstrap?: TBootstrap; round?: TRound }
}

type WorkflowBuilderState<
  TParsers extends Record<string, WorkflowParserJsonSchema>,
  TRoles extends Record<string, WorkflowRoleConfig<keyof TParsers & string>>,
  TUser extends Record<string, WorkflowParserJsonSchema> | undefined,
  TRound extends RoundDefinitionDraft<RoleNames<TRoles>> | undefined,
  TBootstrap extends AnyStepDraft<RoleNames<TRoles>> | undefined
> = {
  $schema?: string
  id: string
  description?: string
  model?: string
  sessions: { roles: Array<{ role: RoleNames<TRoles> | string; nameTemplate?: string }> }
  parsers?: TParsers
  roles: TRoles
  state?: { initial?: Record<string, string> }
  user?: TUser
  flow: { bootstrap?: TBootstrap; round?: TRound }
}

export class WorkflowBuilder<
  TParsers extends Record<string, WorkflowParserJsonSchema> = {},
  TRoles extends Record<string, WorkflowRoleConfig<keyof TParsers & string>> = {},
  TUser extends Record<string, WorkflowParserJsonSchema> | undefined = undefined,
  TRound extends RoundDefinitionDraft<RoleNames<TRoles>> | undefined = undefined,
  TBootstrap extends AnyStepDraft<RoleNames<TRoles>> | undefined = undefined
> {
  private readonly state: WorkflowBuilderState<TParsers, TRoles, TUser, TRound, TBootstrap>

  constructor(id: string) {
    this.state = {
      id,
      sessions: { roles: [] },
      parsers: {} as TParsers,
      roles: {} as TRoles,
      flow: {} as { bootstrap?: TBootstrap; round?: TRound },
      user: undefined as TUser
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

  session<const TRoleName extends RoleNames<TRoles> | string>(role: TRoleName, nameTemplate?: string): this {
    this.state.sessions.roles.push({ role, nameTemplate })
    return this
  }

  parser<const TName extends string, const TSchema extends AnyParserSchema>(
    name: TName,
    schema: TSchema
  ): WorkflowBuilder<
    TParsers & Record<TName, NormalizedParserSchema<TSchema>>,
    TRoles,
    TUser,
    TRound,
    TBootstrap
  > {
    const normalized = normalizeParserSchema(schema)
    ;(this.state.parsers as Record<string, WorkflowParserJsonSchema>)[name] = normalized as WorkflowParserJsonSchema
    return this as unknown as WorkflowBuilder<
      TParsers & Record<TName, NormalizedParserSchema<TSchema>>,
      TRoles,
      TUser,
      TRound,
      TBootstrap
    >
  }

  role<const TRoleName extends string, const TParserName extends keyof TParsers & string>(
    name: TRoleName,
    config: WorkflowRoleConfig<TParserName>
  ): WorkflowBuilder<
    TParsers,
    TRoles & Record<TRoleName, WorkflowRoleConfig<TParserName>>,
    TUser,
    TRound,
    TBootstrap
  > {
    this.state.roles[name] = {
      systemPrompt: config.systemPrompt,
      parser: config.parser,
      tools: config.tools
    } as unknown as TRoles[TRoleName]
    return this as unknown as WorkflowBuilder<
      TParsers,
      TRoles & Record<TRoleName, WorkflowRoleConfig<TParserName>>,
      TUser,
      TRound,
      TBootstrap
    >
  }

  user<const TKey extends string, const TSchema extends AnyParserSchema>(
    key: TKey,
    schema: TSchema
  ): WorkflowBuilder<
    TParsers,
    TRoles,
    (TUser extends undefined ? Record<TKey, NormalizedParserSchema<TSchema>> : TUser & Record<TKey, NormalizedParserSchema<TSchema>>),
    TRound,
    TBootstrap
  > {
    const normalized = normalizeParserSchema(schema)
    if (!this.state.user) {
      ;(this.state.user as Record<string, WorkflowParserJsonSchema> | undefined) = {} as any
    }
    ;(this.state.user as Record<string, WorkflowParserJsonSchema> | undefined)![key] = normalized as WorkflowParserJsonSchema
    return this as unknown as WorkflowBuilder<
      TParsers,
      TRoles,
      (TUser extends undefined
        ? Record<TKey, NormalizedParserSchema<TSchema>>
        : TUser & Record<TKey, NormalizedParserSchema<TSchema>>),
      TRound,
      TBootstrap
    >
  }

  stateInitial(initial: Record<string, string>): this {
    this.state.state = { initial }
    return this
  }

  bootstrapAgent<const TRole extends RoleNames<TRoles>>(
    key: string,
    role: TRole,
    prompt: string[],
    options: CommonStepFields = {}
  ): WorkflowBuilder<TParsers, TRoles, TUser, TRound, AgentStepDraft<TRole>> {
    this.state.flow.bootstrap = buildAgentStep({ key, role, prompt, ...options }) as unknown as TBootstrap
    return this as unknown as WorkflowBuilder<TParsers, TRoles, TUser, TRound, AgentStepDraft<TRole>>
  }

  bootstrapCli(
    key: string,
    command: string,
    options: Omit<CliStepDraft, 'type' | 'key' | 'command' | 'argsSchema'> & { argsSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}
  ): WorkflowBuilder<TParsers, TRoles, TUser, TRound, CliStepDraft> {
    this.state.flow.bootstrap = buildCliStep({ key, command, ...options }) as TBootstrap
    return this as unknown as WorkflowBuilder<TParsers, TRoles, TUser, TRound, CliStepDraft>
  }

  bootstrapWorkflow(
    key: string,
    workflowId: string,
    options: Omit<WorkflowReferenceStepDraft, 'type' | 'key' | 'workflowId' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}
  ): WorkflowBuilder<TParsers, TRoles, TUser, TRound, WorkflowReferenceStepDraft> {
    this.state.flow.bootstrap = buildWorkflowReferenceStep({ key, workflowId, ...options }) as TBootstrap
    return this as unknown as WorkflowBuilder<TParsers, TRoles, TUser, TRound, WorkflowReferenceStepDraft>
  }

  bootstrapTransform(
    key: string,
    template: unknown,
    options: Omit<TransformStepDraft, 'type' | 'key' | 'template' | 'inputSchema'> & { inputSchema?: z.ZodTypeAny | WorkflowParserJsonSchema } = {}
  ): WorkflowBuilder<TParsers, TRoles, TUser, TRound, TransformStepDraft> {
    this.state.flow.bootstrap = buildTransformStep({ key, template, ...options }) as TBootstrap
    return this as unknown as WorkflowBuilder<TParsers, TRoles, TUser, TRound, TransformStepDraft>
  }

  round(builder: (round: RoundBuilder<RoleNames<TRoles>>) => void): WorkflowBuilder<
    TParsers,
    TRoles,
    TUser,
    RoundDefinitionDraft<RoleNames<TRoles>>,
    TBootstrap
  > {
    const roundBuilder = new RoundBuilder<RoleNames<TRoles>>()
    builder(roundBuilder)
    this.state.flow.round = roundBuilder.build() as TRound
    return this as unknown as WorkflowBuilder<
      TParsers,
      TRoles,
      TUser,
      RoundDefinitionDraft<RoleNames<TRoles>>,
      TBootstrap
    >
  }

  build(): WorkflowDefinitionDraft<
    TParsers,
    TRoles,
    TUser,
    RoundDefinitionDraft<RoleNames<TRoles>>,
    TBootstrap
  > & { flow: { round: RoundDefinitionDraft<RoleNames<TRoles>>; bootstrap?: TBootstrap } } {
    const round = this.state.flow.round
    if (!round) {
      throw new Error('Workflow round must be defined before build()')
    }

    const definition = {
      $schema: 'https://hyperagent.dev/schemas/agent-workflow.json',
      id: this.state.id,
      description: this.state.description,
      model: this.state.model,
      sessions: { roles: [...this.state.sessions.roles] },
      parsers: Object.keys(this.state.parsers ?? {}).length ? this.state.parsers : undefined,
      roles: this.state.roles,
      state: this.state.state,
      user: this.state.user,
      flow: { bootstrap: this.state.flow.bootstrap, round }
    } satisfies WorkflowDefinitionDraft<
      TParsers,
      TRoles,
      TUser,
      RoundDefinitionDraft<RoleNames<TRoles>>,
      TBootstrap
    > & { flow: { round: RoundDefinitionDraft<RoleNames<TRoles>>; bootstrap?: TBootstrap } }

    return validateWorkflowDefinition(definition)
  }
}

export const workflow = (id: string) => new WorkflowBuilder(id)
