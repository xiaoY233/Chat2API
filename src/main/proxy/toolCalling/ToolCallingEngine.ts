import { randomUUID } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage, ChatMessageContent } from '../types.ts'
import type { Provider } from '../../store/types.ts'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  normalizeToolCallingConfig,
  type ToolCallingConfig,
} from '../../../shared/toolCalling.ts'
import { getToolProtocol } from './protocols/index.ts'
import { getToolClientAdapter } from './clientAdapters/index.ts'
import { buildToolCallingRuntimePlan } from './runtimePlan.ts'
import type { NormalizedToolDefinition, ToolCallingPlan, ToolCallingTransformResult, ToolProtocolId } from './types.ts'
import { deduplicateEquivalentToolCalls } from './toolCallDeduplication.ts'
import {
  createManagedToolResultWrapperLeakError,
  stripManagedToolResultWrappers,
} from './managedToolResultGuard.ts'
import {
  hasTrailingMatchedToolResultBatch,
  isToolResultMessage,
} from './workflowHeuristics.ts'
import {
  MANAGED_WORKFLOW_COMPLETE_MARKER,
  requiresManagedWorkflowCompletionMarker,
} from './workflowCompletion.ts'
import { getToolStreamValidationFailure } from './streamValidationPolicy.ts'
import {
  createManagedToolPromptMessage,
  type ManagedToolDocumentPrompt,
} from './managedPromptMetadata.ts'
import { createQwenHermesDocumentPrompt } from './protocols/qwenHermes.ts'

const TOOL_CALLING_SHAPE_DIAGNOSTICS_ENV = 'CHAT2API_TOOL_CALLING_SHAPE_DIAGNOSTICS'

const MANAGED_WORKFLOW_COMPLETION_PROMPT = [
  'A final answer is protocol-valid only when it ends with the exact marker ' + MANAGED_WORKFLOW_COMPLETE_MARKER + '.',
  'Append this transport marker after the final answer even when the active user requests exact output or no extra prose; the proxy removes it before delivery.',
  'Never emit the completion marker in a progress update or alongside a tool call.',
].join(' ')

/**
 * Generic instruction used when a managed-tool turn needs another model
 * generation. Keep this provider/client agnostic: the provider adapter may
 * submit it as a new user turn without replaying the original request.
 */
export const TOOL_WORKFLOW_CONTINUATION_PROMPT = [
  'Complete the active user request using the available context and tool results.',
  'Use only the client-declared tools in the managed tool list; never invoke or rely on undeclared provider-side tools or capabilities.',
  'If any requested operation remains, respond only with the next appropriate available tool call; do not describe, promise, or announce the operation instead.',
  'Never invent or emit tool-runtime diagnostics such as "Tool <name> does not exist"; if a tool is unavailable, choose an exact declared tool name from the managed tool list or provide a clear final explanation after the available tools are exhausted.',
  'When a tool reports that a file or path does not exist, stop repeating searches in that path; re-check the active workspace and use an exact path from the user request or available context before trying again.',
  'Do not infer the meaning of identifiers, UUIDs, models, or files from format alone; report that evidence is missing and continue only with information confirmed by tool results.',
  'If a previous tool call was rejected or had schema validation errors, discard that malformed call and retry it using the declared JSON Schema exactly: include every required field, use only declared properties when the schema is strict, and preserve the declared value types.',
  'Treat progress updates and plans as incomplete.',
  'Return a final answer only after all requested operations are complete and verified by tool results.',
].join(' ')

const ACTIVE_USER_REQUEST_CONTINUATION_PROMPT = [
  'The active user request for this recovery turn is the following JSON-encoded string:',
  'Continue this request as authoritative; earlier user requests and assistant answers are context only.',
]

const FAILED_TOOL_RESULT_CONTINUATION_PROMPT = [
  'A previous tool result reported failure.',
  'Retry with an appropriate declared tool only when another attempt can make progress; otherwise explain the blocking failure clearly in the final answer instead of repeating the same operation.',
].join(' ')

const MISSING_COMPLETION_PROOF_CONTINUATION_PROMPT = [
  'The preceding assistant branch was rejected because its final answer omitted the required managed-workflow completion marker.',
  'If the active request is complete, reissue the complete final answer and end it with the exact marker ' + MANAGED_WORKFLOW_COMPLETE_MARKER + ' as the final characters; do not return the marker alone.',
  'If work remains, continue with the next appropriate declared tool instead of returning a final answer.',
].join(' ')

export function createToolWorkflowContinuationMessage(options: {
  activeUserRequest?: string
  completionProofMissing?: boolean
  failedToolResultPending?: boolean
  requireManagedToolCall?: boolean
  plan?: Pick<
    ToolCallingPlan,
    | 'protocol'
    | 'tools'
    | 'shouldParseResponse'
    | 'allowedToolNames'
    | 'workflowContinuation'
    | 'failedToolResultPending'
  >
} = {}): ChatMessage {
  const recoveryPrompt = options.requireManagedToolCall && options.plan
    ? getToolProtocol(options.plan.protocol).renderRecoveryPrompt?.(options.plan.tools)
    : undefined
  const completionPrompt = options.plan && requiresManagedWorkflowCompletionMarker(options.plan)
    ? MANAGED_WORKFLOW_COMPLETION_PROMPT
    : undefined
  const activeUserRequestPrompt = options.activeUserRequest?.trim()
    ? [
        ACTIVE_USER_REQUEST_CONTINUATION_PROMPT[0],
        JSON.stringify(options.activeUserRequest),
        ACTIVE_USER_REQUEST_CONTINUATION_PROMPT[1],
      ].join('\n')
    : undefined

  return {
    role: 'user',
    content: [
      TOOL_WORKFLOW_CONTINUATION_PROMPT,
      activeUserRequestPrompt,
      options.completionProofMissing ? MISSING_COMPLETION_PROOF_CONTINUATION_PROMPT : undefined,
      options.failedToolResultPending ? FAILED_TOOL_RESULT_CONTINUATION_PROMPT : undefined,
      recoveryPrompt,
      completionPrompt,
    ].filter((part): part is string => Boolean(part)).join('\n\n'),
  }
}

/** Select the latest client user turn without mistaking tool results for a new task. */
export function extractLatestActiveUserRequest(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user') continue

    if (typeof message.content === 'string') {
      if (isToolResultMessage(message)) continue
      return message.content.trim() ? message.content : undefined
    }
    if (!Array.isArray(message.content)) {
      if (isToolResultMessage(message)) continue
      return undefined
    }

    const text = message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text as string)
      .join('\n')
    if (text.trim()) return text
    if (!isToolResultMessage(message)) return undefined
  }
  return undefined
}

const ACTIVE_USER_ATTACHMENT_TYPES = new Set<ChatMessageContent['type']>([
  'image_url',
  'file',
  'input_audio',
  'video_url',
])

/**
 * Retain attachments from the active user turn for provider-native follow-ups.
 * Some upstream chats keep text history across a continuation but do not keep
 * the provider-side visual/file context unless the attachment is sent again.
 */
export function extractLatestActiveUserAttachments(
  messages: ChatMessage[],
): ChatMessageContent[] {
  const attachments: ChatMessageContent[] = []
  let activeUserTurnStarted = false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isToolResultMessage(message)) continue

    if (message.role === 'assistant') {
      if (activeUserTurnStarted) break
      continue
    }
    if (message.role === 'system') {
      if (activeUserTurnStarted) break
      continue
    }
    if (message.role !== 'user') continue

    activeUserTurnStarted = true
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (ACTIVE_USER_ATTACHMENT_TYPES.has(part.type)) {
        attachments.push({ ...part })
      }
    }
  }

  return attachments.reverse()
}

export class ToolCallingEngine {
  private readonly config: ToolCallingConfig

  constructor(config: Partial<ToolCallingConfig> = {}) {
    this.config = normalizeToolCallingConfig({
      ...DEFAULT_TOOL_CALLING_CONFIG,
      ...config,
      advanced: {
        ...DEFAULT_TOOL_CALLING_CONFIG.advanced,
        ...config.advanced,
      },
    })
  }

  transformRequest(input: {
    request: ChatCompletionRequest
    provider: Provider
    providerProfileKey?: string
    actualModel: string
    requestId?: string
  }): ToolCallingTransformResult {
    const { request, provider, providerProfileKey, actualModel, requestId } = input
    const adapter = getToolClientAdapter(this.config.clientAdapterId)
    const clientRequest = adapter.normalizeRequest(request)
    const plan = buildToolCallingRuntimePlan({
      requestId,
      providerId: provider.id,
      providerProfileKey,
      actualModel,
      model: request.model,
      config: this.config,
      clientRequest,
    })
    const shouldInjectPrompt = plan.shouldInjectPrompt
    const failedToolResultPending = hasUnresolvedFailedToolResult(request.messages)
    const workflow = shouldInjectPrompt
      ? appendToolWorkflowContinuation(request.messages, failedToolResultPending, plan)
      : { messages: request.messages, appended: false }
    const planWithWorkflow = withWorkflowState(plan, {
      workflowContinuation: workflow.appended,
      failedToolResultPending,
    })

    emitToolCallingShapeDiagnostics({
      messages: request.messages,
      rawToolCount: Array.isArray(request.tools) ? request.tools.length : 0,
      normalizedToolCount: clientRequest.tools.length,
      workflowContinuation: workflow.appended,
      failedToolResultPending,
    })

    if (!shouldInjectPrompt) {
      return {
        messages: request.messages,
        tools: planWithWorkflow.mode === 'disabled' ? request.tools : undefined,
        plan: planWithWorkflow,
      }
    }

    const renderedPrompt = renderPrompt(planWithWorkflow, this.config)
    return {
      messages: injectPrompt(
        workflow.messages,
        renderedPrompt.content,
        planWithWorkflow.protocol === 'qwen_hermes',
        renderedPrompt.documentPrompt,
      ),
      tools: undefined,
      plan: planWithWorkflow,
    }
  }

  applyNonStreamResponse(result: any, plan: ToolCallingPlan): void {
    const choices = Array.isArray(result?.choices) ? result.choices : []
    const message = choices[0]?.message
    if (!message) return

    let guardedContent: string | undefined
    for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
      const choiceMessage = choices[choiceIndex]?.message
      if (!choiceMessage || typeof choiceMessage !== 'object') continue

      const assistantTextFields: Array<{
        field: string
        value: unknown
        protectedProtocol: ToolProtocolId | null
        primaryContent?: boolean
      }> = [
        {
          field: 'content',
          value: choiceMessage.content,
          protectedProtocol: plan.shouldParseResponse ? plan.protocol : null,
          primaryContent: choiceIndex === 0,
        },
        { field: 'reasoning_content', value: choiceMessage.reasoning_content, protectedProtocol: null },
        { field: 'reasoning', value: choiceMessage.reasoning, protectedProtocol: null },
        { field: 'thinking', value: choiceMessage.thinking, protectedProtocol: null },
        { field: 'summary', value: choiceMessage.summary, protectedProtocol: null },
      ]
      appendStructuredAssistantTextFields(
        assistantTextFields,
        choiceMessage.content,
        `choices[${choiceIndex}].message.content`,
      )

      for (const candidate of assistantTextFields) {
        if (typeof candidate.value !== 'string') continue
        const guarded = stripManagedToolResultWrappers(
          candidate.value,
          candidate.protectedProtocol,
        )
        if (guarded.wrapperLeakDetected) {
          console.warn('[ToolCalling] Blocked leaked managed tool-result wrapper', JSON.stringify({
            wrapperLeakDetected: true,
            requestId: plan.diagnostics.requestId,
            providerId: plan.diagnostics.providerId,
            model: plan.diagnostics.actualModel || plan.diagnostics.model,
            protocol: plan.protocol,
            channel: candidate.field,
          }))
          throw createManagedToolResultWrapperLeakError(candidate.field)
        }
        if (candidate.primaryContent && candidate.field === 'content') {
          guardedContent = guarded.content
        }
      }
    }

    if (guardedContent === undefined) return
    if (!plan.shouldParseResponse) return

    const parseResult = parseSelectedProtocol(guardedContent, plan, { allowPartial: true })
    const deduplicated = deduplicateEquivalentToolCalls(parseResult.toolCalls)
    if (deduplicated.duplicateCount > 0) {
      console.warn(`[ToolCalling] Suppressed ${deduplicated.duplicateCount} duplicate tool call(s) in one non-stream response`)
    }
    plan.diagnostics.parserFormat = parseResult.protocol
    plan.diagnostics.parsedToolCallCount = deduplicated.toolCalls.length
    plan.diagnostics.invalidToolNames = parseResult.invalidToolNames
    plan.diagnostics.malformedReason = parseResult.malformedReason

    const validationFailure = getToolStreamValidationFailure({
      plan,
      emittedToolCall: deduplicated.toolCalls.length > 0,
      pendingToolProtocol: parseResult.rawMatches.length > 0,
    })
    if (validationFailure) {
      const error = new Error(validationFailure.message) as Error & {
        status?: number
        type?: string
        param?: string
        code?: string
        retryable?: boolean
        accountFault?: boolean
      }
      error.status = 422
      error.type = validationFailure.type
      error.param = validationFailure.param
      error.code = validationFailure.code
      error.retryable = false
      error.accountFault = false
      throw error
    }

    if (deduplicated.toolCalls.length === 0) {
      if (parseResult.rawMatches.length > 0) {
        message.content = parseResult.content || null
      }
      return
    }

    const callIdPrefix = `call_${randomUUID().replace(/-/g, '')}`
    message.content = parseResult.content || null
    message.tool_calls = deduplicated.toolCalls.map((toolCall, index) => ({
      ...toolCall,
      id: `${callIdPrefix}_${index}`,
    }))

    const choice = choices[0]
    choice.finish_reason = 'tool_calls'
  }
}

function appendStructuredAssistantTextFields(
  fields: Array<{
    field: string
    value: unknown
    protectedProtocol: ToolProtocolId | null
  }>,
  content: unknown,
  fieldPrefix: string,
): void {
  if (!Array.isArray(content)) return

  const visibleBlockTypes = new Set(['text', 'output_text', 'reasoning', 'thinking', 'summary'])
  content.forEach((part, index) => {
    if (typeof part === 'string') {
      fields.push({
        field: `${fieldPrefix}[${index}]`,
        value: part,
        protectedProtocol: null,
      })
      return
    }
    if (!part || typeof part !== 'object' || Array.isArray(part)) return

    const record = part as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : undefined
    if (type && !visibleBlockTypes.has(type)) return
    for (const key of ['text', 'content'] as const) {
      if (typeof record[key] !== 'string') continue
      fields.push({
        field: `${fieldPrefix}[${index}].${key}`,
        value: record[key],
        protectedProtocol: null,
      })
    }
  })
}

/**
 * Keep managed tool workflows moving after a tool result, including a client
 * retry after the model returned only a progress update. The directive stays
 * conditional so completed workflows and ordinary answers can still finish.
 */
function appendToolWorkflowContinuation(
  messages: ChatMessage[],
  failedToolResultPending: boolean,
  plan: ToolCallingPlan,
): { messages: ChatMessage[]; appended: boolean } {
  const lastMessage = messages.at(-1)
  if (!lastMessage) return { messages, appended: false }

  // A user message after an older tool exchange can be a completely new
  // request. There is no protocol-safe way to infer that it is a retry from
  // the message text, so only an actual trailing tool result opens a managed
  // continuation turn. This keeps old tool history from contaminating new
  // tasks while preserving the normal tool-result -> model turn boundary.
  if (!hasTrailingMatchedToolResultBatch(messages)) {
    return { messages, appended: false }
  }

  return {
    messages: [
      ...messages,
      createToolWorkflowContinuationMessage({
        failedToolResultPending,
        plan: {
          ...plan,
          workflowContinuation: true,
          failedToolResultPending,
        },
      }),
    ],
    appended: true,
  }
}

function withWorkflowState(
  plan: ToolCallingPlan,
  state: Pick<ToolCallingPlan, 'workflowContinuation' | 'failedToolResultPending'>,
): ToolCallingPlan {
  return {
    ...plan,
    ...state,
    diagnostics: {
      ...plan.diagnostics,
      ...state,
    },
  }
}

function hasUnresolvedFailedToolResult(messages: ChatMessage[]): boolean {
  const lastMessage = messages.at(-1)
  if (!lastMessage || !hasTrailingMatchedToolResultBatch(messages)) return false

  const lastToolResultIndex = messages.length - 1

  let batchStartIndex = lastToolResultIndex
  while (batchStartIndex > 0 && isToolResultMessage(messages[batchStartIndex - 1])) {
    batchStartIndex -= 1
  }

  return messages
    .slice(batchStartIndex, lastToolResultIndex + 1)
    .some(message => hasToolResultError(message))
}

function hasToolResultError(message: ChatMessage): boolean {
  if (message.is_error === true) return true
  if (!Array.isArray(message.content)) return false

  return message.content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    const record = part as { is_error?: unknown; isError?: unknown }
    return record.is_error === true || record.isError === true
  })
}

type ToolCallingShapeDiagnosticsInput = {
  messages: ChatMessage[]
  rawToolCount: number
  normalizedToolCount: number
  workflowContinuation: boolean
  failedToolResultPending: boolean
}

/**
 * Emit a protocol-shape-only snapshot when explicitly enabled. The snapshot
 * intentionally contains no values from message content, tool definitions, or
 * tool-call identifiers so it can be enabled while investigating a live
 * client/proxy bridge without exposing the request payload.
 */
function emitToolCallingShapeDiagnostics(input: ToolCallingShapeDiagnosticsInput): void {
  if (!isToolCallingShapeDiagnosticsEnabled()) return

  const messageShapes = input.messages.map((message) => ({
    role: safeRole(message.role),
    contentPartTypes: safeContentPartTypes(message.content),
    hasToolCalls: Array.isArray(message.tool_calls)
      ? message.tool_calls.length > 0
      : Boolean(message.tool_calls),
    hasToolCallId: typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0,
  }))

  console.info('[ToolCalling] request-shape', JSON.stringify({
    messageRoles: messageShapes.map((message) => message.role),
    messageShapes,
    rawToolCount: input.rawToolCount,
    normalizedToolCount: input.normalizedToolCount,
    workflowContinuation: input.workflowContinuation,
    failedToolResultPending: input.failedToolResultPending,
  }))
}

function isToolCallingShapeDiagnosticsEnabled(): boolean {
  const value = process.env[TOOL_CALLING_SHAPE_DIAGNOSTICS_ENV]
  return value !== undefined && /^(?:1|true|yes|on)$/i.test(value.trim())
}

const SAFE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

function safeRole(role: unknown): string {
  return typeof role === 'string' && SAFE_ROLES.has(role) ? role : 'other'
}

const SAFE_CONTENT_PART_TYPES = new Set([
  'string',
  'null',
  'text',
  'image',
  'image_url',
  'document',
  'file',
  'file_url',
  'input_audio',
  'video',
  'video_url',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
  'web_search_result',
  'thinking',
  'redacted_thinking',
  'computer_screenshot',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'code_execution_tool_result',
])

function safeContentPartTypes(content: ChatMessage['content']): string[] {
  if (content === null) return ['null']
  if (typeof content === 'string') return ['string']
  if (!Array.isArray(content)) return ['other']

  return content.map((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return 'other'
    const type = (part as { type?: unknown }).type
    return typeof type === 'string' && SAFE_CONTENT_PART_TYPES.has(type) ? type : 'other'
  })
}

function renderPrompt(
  plan: ToolCallingPlan,
  config: ToolCallingConfig,
): { content: string; documentPrompt?: ManagedToolDocumentPrompt } {
  const policyPrompt = renderToolChoicePolicyPrompt(plan)
  const completionPrompt = requiresManagedWorkflowCompletionMarker(plan)
    ? MANAGED_WORKFLOW_COMPLETION_PROMPT
    : ''
  const customPromptTemplate = config.diagnosticsEnabled
    ? config.advanced.customPromptTemplate
    : undefined
  const finishPrompt = (protocolPrompt: string): string => {
    const prompt = [protocolPrompt, policyPrompt, completionPrompt].filter(Boolean).join('\n\n')
    if (!customPromptTemplate) return prompt

    return customPromptTemplate
      .replace(/\{\{tools\}\}/g, prompt)
      .replace(/\{\{tool_names\}\}/g, plan.tools.map((tool) => tool.name).join(', '))
      .replace(/\{\{format\}\}/g, plan.protocol)
  }

  const content = finishPrompt(getToolProtocol(plan.protocol).renderPrompt(plan.tools))
  if (plan.protocol !== 'qwen_hermes') return { content }

  const documentVariant = createQwenHermesDocumentPrompt(plan.tools)
  return {
    content,
    documentPrompt: {
      content: finishPrompt(documentVariant.compactPrompt),
      referenceContent: documentVariant.referenceContent,
    },
  }
}

function renderToolChoicePolicyPrompt(plan: ToolCallingPlan): string {
  if (plan.toolChoiceMode === 'required') {
    return [
      'Tool choice policy: a tool call is required for this request.',
      'Respond with one or more tool calls using only the listed tool names and the required protocol block.',
      'Do not answer in natural language instead of calling a tool.',
    ].join('\n')
  }

  if (plan.toolChoiceMode === 'forced' && plan.forcedToolName) {
    return [
      `Tool choice policy: you must call \`${plan.forcedToolName}\` for this request.`,
      'Use only that tool name and the required protocol block.',
      'Do not answer in natural language instead of calling the tool.',
    ].join('\n')
  }

  return ''
}

function injectPrompt(
  messages: ChatMessage[],
  prompt: string,
  keepPromptSeparate: boolean,
  documentPrompt?: ManagedToolDocumentPrompt,
): ChatMessage[] {
  if (keepPromptSeparate) {
    const firstNonSystemIndex = messages.findIndex(message => message.role !== 'system')
    const insertionIndex = firstNonSystemIndex === -1 ? messages.length : firstNonSystemIndex
    return [
      ...messages.slice(0, insertionIndex),
      createManagedToolPromptMessage(prompt, documentPrompt),
      ...messages.slice(insertionIndex),
    ]
  }

  const [first, ...rest] = messages
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${prompt}` }, ...rest]
  }

  return [{ role: 'system', content: prompt }, ...messages]
}

function parseSelectedProtocol(
  content: string,
  plan: ToolCallingPlan,
  options: { allowPartial?: boolean } = {},
) {
  const selected = getToolProtocol(plan.protocol)
  return selected.parse(content, {
    tools: plan.tools,
    protocol: plan.protocol,
    allowPartial: options.allowPartial,
  })
}
