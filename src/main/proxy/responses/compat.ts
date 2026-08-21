import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatMessageContent,
  ChatCompletionTool,
  ChatCompletionToolChoice,
  ToolCall,
} from '../types'

export type ResponseInputRole = 'user' | 'assistant' | 'system' | 'developer'

export interface ResponseFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown>
  strict?: boolean
}

export interface ResponseCustomTool {
  type: 'custom'
  name: string
  description?: string
  format?: Record<string, unknown>
  [key: string]: unknown
}

export interface ResponseImageGenerationTool {
  type: 'image_generation'
  size?: string
  model?: string
  quality?: string
  format?: string
  output_format?: string
  action?: 'auto' | 'generate' | 'edit'
  [key: string]: unknown
}

export interface ResponseCreateRequest {
  model: string
  input: string | Array<string | Record<string, any>>
  instructions?: string | null
  stream?: boolean
  tools?: Array<ResponseFunctionTool | ResponseCustomTool | ResponseImageGenerationTool | Record<string, any>>
  additional_tools?: Array<ResponseFunctionTool | ResponseCustomTool | ResponseImageGenerationTool | Record<string, any>>
  tool_choice?: string | Record<string, any>
  parallel_tool_calls?: boolean
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  user?: string | null
  metadata?: Record<string, string> | null
  previous_response_id?: string | null
  store?: boolean | null
  truncation?: 'auto' | 'disabled' | string | null
  service_tier?: string | null
  reasoning?: {
    effort?: 'low' | 'medium' | 'high' | string | null
    summary?: 'auto' | 'concise' | 'detailed' | string | null
  } | null
  text?: Record<string, any> | null
  [key: string]: unknown
}

export interface InternalImageGenerationConfig {
  enabled: true
  size?: string
  model?: string
  quality?: string
  format?: string
  action?: 'auto' | 'generate' | 'edit'
}

export type ResponsesChatCompletionRequest = ChatCompletionRequest & {
  image_generation?: InternalImageGenerationConfig
  parallel_tool_calls?: boolean
  response_format?: Record<string, any>
}

export interface ChatResponseImage {
  type?: string
  image_url?: string | { url?: string }
  url?: string
  source?: string
  revised_prompt?: string
}

export interface ResolvedResponseImage {
  result?: string
  revised_prompt?: string
}

export type ResponseImageResolver = (
  image: ChatResponseImage,
) => ResolvedResponseImage | Promise<ResolvedResponseImage>

export interface ResponseUsage {
  input_tokens: number
  input_tokens_details: {
    cached_tokens: number
  }
  output_tokens: number
  output_tokens_details: {
    reasoning_tokens: number
  }
  total_tokens: number
}

export interface ResponseObject {
  id: string
  object: 'response'
  created_at: number
  status: 'in_progress' | 'completed' | 'failed' | 'incomplete'
  completed_at?: number | null
  background: false
  error: Record<string, any> | null
  incomplete_details: Record<string, any> | null
  instructions: string | null
  max_output_tokens: number | null
  max_tool_calls: number | null
  model: string
  output: Array<Record<string, any>>
  parallel_tool_calls: boolean
  previous_response_id: string | null
  reasoning: {
    effort: string | null
    summary: string | null
  }
  service_tier: string
  store: boolean
  temperature: number | null
  text: Record<string, any>
  tool_choice: string | Record<string, any>
  tools: Array<Record<string, any>>
  top_p: number | null
  truncation: string
  usage: ResponseUsage | null
  user: string | null
  metadata: Record<string, string>
}

export class ResponsesCompatibilityError extends Error {
  readonly param: string | null
  readonly code: string

  constructor(message: string, param: string | null, code = 'invalid_request') {
    super(message)
    this.name = 'ResponsesCompatibilityError'
    this.param = param
    this.code = code
  }
}

function responseInputRole(role: unknown): ChatMessage['role'] {
  if (role === 'assistant') return 'assistant'
  if (role === 'system' || role === 'developer') return 'system'
  return 'user'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function serializeJsonValue(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value ?? '') : serialized
}

function responseContentPartToChat(part: unknown, param: string): ChatMessageContent | undefined {
  if (typeof part === 'string') {
    return { type: 'text', text: part }
  }
  if (!part || typeof part !== 'object') return undefined

  const value = part as Record<string, any>
  if (value.type === 'input_text' || value.type === 'output_text' || value.type === 'text') {
    return { type: 'text', text: typeof value.text === 'string' ? value.text : '' }
  }

  if (value.type === 'input_image' || value.type === 'image_url') {
    const rawUrl = typeof value.image_url === 'string'
      ? value.image_url
      : stringValue(value.image_url?.url)
    if (!rawUrl) {
      throw new ResponsesCompatibilityError(
        'input_image requires image_url; file_id-only image inputs are not available through this proxy.',
        param,
      )
    }
    return {
      type: 'image_url',
      image_url: {
        url: rawUrl,
        detail: value.detail,
      },
    }
  }

  if (value.type === 'input_file' || value.type === 'file') {
    let fileUrl = stringValue(value.file_url)
      ?? stringValue(value.file_url?.url)
    const fileData = stringValue(value.file_data)
    if (!fileUrl && fileData) {
      fileUrl = fileData.startsWith('data:')
        ? fileData
        : `data:application/octet-stream;base64,${fileData}`
    }
    if (!fileUrl) {
      throw new ResponsesCompatibilityError(
        'input_file requires file_url or file_data; file_id-only inputs are not available through this proxy.',
        param,
      )
    }
    return {
      type: 'file',
      file_url: { url: fileUrl },
      filename: stringValue(value.filename),
    }
  }

  return undefined
}

function responseMessageContentToChat(
  content: unknown,
  param: string,
): string | ChatMessageContent[] | null {
  if (content === null || content === undefined) return null
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    throw new ResponsesCompatibilityError('Message content must be a string or an array.', param)
  }

  const parts = content
    .map((part, index) => responseContentPartToChat(part, `${param}[${index}]`))
    .filter((part): part is ChatMessageContent => part !== undefined)

  return parts
}

interface ToolOutputContent {
  text: string
  attachments: ChatMessageContent[]
}

function responseToolOutputToChat(
  output: unknown,
  param: string,
): ToolOutputContent {
  if (typeof output === 'string') return { text: output, attachments: [] }
  if (output === null || output === undefined) return { text: '', attachments: [] }

  const values = Array.isArray(output) ? output : [output]
  return values.reduce<ToolOutputContent>((result, part, index) => {
    if (typeof part === 'string') {
      return { ...result, text: result.text + part }
    }
    if (!part || typeof part !== 'object') {
      return { ...result, text: result.text + serializeJsonValue(part) }
    }

    const converted = responseContentPartToChat(part, `${param}[${index}]`)
    if (converted?.type === 'text') {
      return { ...result, text: result.text + (converted.text ?? '') }
    }
    if (converted) {
      return { ...result, attachments: [...result.attachments, converted] }
    }
    return { ...result, text: result.text + serializeJsonValue(part) }
  }, { text: '', attachments: [] })
}

function toolAttachmentMessage(attachments: ChatMessageContent[]): ChatMessage {
  const label = attachments.length === 1
    ? 'Tool output attachment follows.'
    : `Tool output attachments follow (${attachments.length}).`
  return {
    role: 'user',
    content: [
      { type: 'text', text: label },
      ...attachments,
    ],
  }
}

function encodeCustomToolArguments(input: string): string {
  return JSON.stringify({ input })
}

export function decodeCustomToolArguments(argumentsValue: unknown): string {
  const raw = typeof argumentsValue === 'string'
    ? argumentsValue
    : serializeJsonValue(argumentsValue ?? {})
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof (parsed as Record<string, unknown>).input === 'string'
    ) {
      return (parsed as Record<string, string>).input
    }
  } catch {
    // Preserve malformed provider output so the client can inspect or retry it.
  }
  return raw
}

function appendFunctionCall(
  messages: ChatMessage[],
  item: Record<string, any>,
  custom = false,
): ChatMessage[] {
  const callId = stringValue(item.call_id) ?? stringValue(item.id)
  const name = stringValue(item.name)
  if (!callId || !name) {
    throw new ResponsesCompatibilityError(
      `${custom ? 'custom_tool_call' : 'function_call'} input items require call_id (or id) and name.`,
      'input',
    )
  }

  if (custom && typeof item.input !== 'string') {
    throw new ResponsesCompatibilityError(
      'custom_tool_call input items require a string input.',
      'input',
    )
  }

  const toolCall = {
    id: callId,
    type: 'function' as const,
    function: {
      name,
      arguments: custom
        ? encodeCustomToolArguments(item.input)
        : typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments ?? {}),
    },
  }
  const last = messages[messages.length - 1]
  if (last?.role === 'assistant' && last.content === null && last.tool_calls) {
    return [
      ...messages.slice(0, -1),
      { ...last, tool_calls: [...last.tool_calls, toolCall] },
    ]
  }
  return [...messages, { role: 'assistant', content: null, tool_calls: [toolCall] }]
}

export function responsesInputToChatMessages(
  input: ResponseCreateRequest['input'],
): ChatMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  if (!Array.isArray(input)) {
    throw new ResponsesCompatibilityError('input must be a string or an array.', 'input')
  }

  let messages: ChatMessage[] = []
  let pendingAttachmentMessages: ChatMessage[] = []
  const flushAttachments = () => {
    if (pendingAttachmentMessages.length === 0) return
    messages = [...messages, ...pendingAttachmentMessages]
    pendingAttachmentMessages = []
  }

  input.forEach((rawItem, index) => {
    if (typeof rawItem === 'string') {
      flushAttachments()
      messages = [...messages, { role: 'user', content: rawItem }]
      return
    }
    if (!rawItem || typeof rawItem !== 'object') {
      throw new ResponsesCompatibilityError(`input[${index}] must be an object.`, `input[${index}]`)
    }

    const item = rawItem as Record<string, any>
    if (item.type === 'function_call') {
      flushAttachments()
      messages = appendFunctionCall(messages, item)
      return
    }
    if (item.type === 'custom_tool_call') {
      flushAttachments()
      messages = appendFunctionCall(messages, item, true)
      return
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      const callId = stringValue(item.call_id)
      if (!callId) {
        throw new ResponsesCompatibilityError(
          `${item.type} requires call_id.`,
          `input[${index}].call_id`,
        )
      }
      const output = responseToolOutputToChat(item.output, `input[${index}].output`)
      messages = [...messages, {
        role: 'tool',
        tool_call_id: callId,
        content: output.text || (output.attachments.length > 0 ? 'Tool output attachment follows.' : ''),
        ...(typeof item.is_error === 'boolean' ? { is_error: item.is_error } : {}),
      }]
      if (output.attachments.length > 0) {
        pendingAttachmentMessages = [
          ...pendingAttachmentMessages,
          toolAttachmentMessage(output.attachments),
        ]
      }
      return
    }
    if (item.type === 'reasoning') {
      return
    }
    if (item.type === 'additional_tools') {
      if (!Array.isArray(item.tools)) {
        throw new ResponsesCompatibilityError(
          'additional_tools input items require a tools array.',
          `input[${index}].tools`,
        )
      }
      return
    }
    if (item.type === 'input_text' || item.type === 'output_text') {
      flushAttachments()
      messages = [...messages, {
        role: 'user',
        content: typeof item.text === 'string' ? item.text : '',
      }]
      return
    }

    if (item.type === 'message' || typeof item.role === 'string') {
      flushAttachments()
      messages = [...messages, {
        role: responseInputRole(item.role),
        content: responseMessageContentToChat(item.content, `input[${index}].content`),
        name: stringValue(item.name),
      }]
      return
    }

    // Output item references such as image_generation_call IDs carry no
    // transferable payload for a Chat Completions upstream. Keep parsing the
    // remaining concrete message and tool-result items.
    if (item.type === 'image_generation_call') return

    throw new ResponsesCompatibilityError(
      `Unsupported input item type: ${String(item.type ?? 'unknown')}`,
      `input[${index}].type`,
    )
  })

  flushAttachments()
  return messages
}

function toChatTools(tools: ResponseCreateRequest['tools']): ChatCompletionTool[] | undefined {
  const functionTools = (tools ?? []).flatMap((tool) => {
    if (tool?.type === 'function' && typeof tool.name === 'string') {
      return [{
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      }]
    }
    if (tool?.type === 'custom' && typeof tool.name === 'string') {
      return [{
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'string',
                description: 'Complete raw input for the custom tool.',
              },
            },
            required: ['input'],
            additionalProperties: false,
          },
          strict: true,
        },
      }]
    }
    return []
  }) as Array<ChatCompletionTool & { function: ChatCompletionTool['function'] & { strict?: boolean } }>
  return functionTools.length > 0 ? functionTools : undefined
}

function inputAdditionalTools(input: ResponseCreateRequest['input']): ResponseCreateRequest['tools'] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => (
    item
      && typeof item === 'object'
      && !Array.isArray(item)
      && item.type === 'additional_tools'
      && Array.isArray(item.tools)
      ? item.tools
      : []
  ))
}

function requestTools(request: ResponseCreateRequest): ResponseCreateRequest['tools'] {
  return [
    ...(request.tools ?? []),
    ...(request.additional_tools ?? []),
    ...(inputAdditionalTools(request.input) ?? []),
  ]
}

export function isResponseCustomTool(request: ResponseCreateRequest, name: string): boolean {
  return requestTools(request)?.some((tool) => (
    tool?.type === 'custom' && tool.name === name
  )) ?? false
}

function choiceExplicitlySelectsAnotherTool(choice: unknown): boolean {
  if (!choice || typeof choice !== 'object') return false
  const value = choice as Record<string, any>
  if (value.type === 'function' || value.type === 'custom') return true
  if (value.type === 'allowed_tools' && Array.isArray(value.tools)) {
    return !value.tools.some((tool: unknown) => (
      tool && typeof tool === 'object' && (tool as Record<string, unknown>).type === 'image_generation'
    ))
  }
  return false
}

function imageGenerationConfig(request: ResponseCreateRequest): InternalImageGenerationConfig | undefined {
  const tool = requestTools(request)?.find((candidate): candidate is ResponseImageGenerationTool => (
    candidate?.type === 'image_generation'
  ))
  if (!tool || request.tool_choice === 'none' || choiceExplicitlySelectsAnotherTool(request.tool_choice)) {
    return undefined
  }

  return {
    enabled: true,
    size: stringValue(tool.size),
    model: stringValue(tool.model),
    quality: stringValue(tool.quality),
    format: stringValue(tool.output_format) ?? stringValue(tool.format),
    action: tool.action,
  }
}

function toChatToolChoice(
  choice: ResponseCreateRequest['tool_choice'],
  hasFunctionTools: boolean,
  hasImageGeneration: boolean,
): ChatCompletionToolChoice | undefined {
  if (!hasFunctionTools) return undefined
  if (choice === 'none' || choice === 'auto') return choice
  if (choice === 'required') return hasImageGeneration ? 'auto' : 'required'
  if (
    choice
    && typeof choice === 'object'
    && (choice.type === 'function' || choice.type === 'custom')
    && typeof choice.name === 'string'
  ) {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

function textFormatToChatResponseFormat(text: ResponseCreateRequest['text']): Record<string, any> | undefined {
  const format = text?.format
  if (!format || typeof format !== 'object' || format.type === 'text') return undefined
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name,
        description: format.description,
        schema: format.schema,
        strict: format.strict,
      },
    }
  }
  if (format.type === 'json_object') return { type: 'json_object' }
  return undefined
}

export function responsesRequestToChatCompletion(
  request: ResponseCreateRequest,
  previousMessages: ChatMessage[] = [],
): { chatRequest: ResponsesChatCompletionRequest; conversationMessages: ChatMessage[] } {
  if (!request || typeof request !== 'object') {
    throw new ResponsesCompatibilityError('Request body must be a JSON object.', null)
  }
  if (!stringValue(request.model)) {
    throw new ResponsesCompatibilityError('Missing required field: model', 'model')
  }

  const inputMessages = responsesInputToChatMessages(request.input)
  const conversationMessages = [...previousMessages, ...inputMessages]
  if (conversationMessages.length === 0) {
    throw new ResponsesCompatibilityError('input must contain at least one message.', 'input')
  }
  const instructionMessages: ChatMessage[] = typeof request.instructions === 'string'
    ? [{ role: 'system', content: request.instructions }]
    : []
  const allTools = requestTools(request)
  const tools = toChatTools(allTools)
  const imageGeneration = imageGenerationConfig(request)
  const webSearch = allTools?.some((tool) => (
    tool?.type === 'web_search' || tool?.type === 'web_search_preview'
  ))
  const requestRecord = request as Record<string, unknown>
  const protocolExtensions: Record<string, unknown> = {}
  for (const key of [
    'system',
    'context_management',
    'contextManagement',
    'compaction',
    'compact',
    'auto_compact',
    'autoCompact',
    'context_edit',
    'contextEdit',
    'anthropic_context_management',
    'extra_body',
    'extraBody',
    'provider_fields',
    'providerFields',
  ]) {
    if (Object.prototype.hasOwnProperty.call(requestRecord, key)) {
      protocolExtensions[key] = requestRecord[key]
    }
  }

  const chatRequest: ResponsesChatCompletionRequest = {
    model: request.model,
    messages: [...instructionMessages, ...conversationMessages],
    stream: request.stream === true,
    temperature: typeof request.temperature === 'number' ? request.temperature : undefined,
    top_p: typeof request.top_p === 'number' ? request.top_p : undefined,
    max_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : undefined,
    user: typeof request.user === 'string' ? request.user : undefined,
    reasoning_effort: (
      request.reasoning?.effort === 'minimal'
        || request.reasoning?.effort === 'low'
        || request.reasoning?.effort === 'medium'
        || request.reasoning?.effort === 'high'
        || request.reasoning?.effort === 'xhigh'
        ? request.reasoning.effort
        : undefined
    ) as ChatCompletionRequest['reasoning_effort'],
    tools,
    tool_choice: toChatToolChoice(request.tool_choice, Boolean(tools?.length), Boolean(imageGeneration)),
    web_search: webSearch || undefined,
    image_generation: imageGeneration,
    parallel_tool_calls: request.parallel_tool_calls,
    response_format: textFormatToChatResponseFormat(request.text),
    metadata: request.metadata && typeof request.metadata === 'object'
      ? { ...request.metadata }
      : undefined,
    ...protocolExtensions,
  }

  return { chatRequest, conversationMessages }
}

export function defaultResponseImageResolver(image: ChatResponseImage): ResolvedResponseImage {
  const url = typeof image.image_url === 'string'
    ? image.image_url
    : stringValue(image.image_url?.url) ?? stringValue(image.url)
  if (!url) return { revised_prompt: image.revised_prompt }

  const dataUrl = /^data:[^;,]+;base64,([\s\S]+)$/i.exec(url)
  if (dataUrl) {
    return {
      result: dataUrl[1].replace(/\s+/g, ''),
      revised_prompt: image.revised_prompt,
    }
  }
  throw new Error('Remote generated images require the bounded Responses image resolver.')
}

export function extractChatResponseImages(value: unknown): ChatResponseImage[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const image = candidate as ChatResponseImage
    const url = typeof image.image_url === 'string'
      ? image.image_url
      : stringValue(image.image_url?.url) ?? stringValue(image.url)
    // Only consume the explicit adapter contract. This deliberately avoids
    // treating arbitrary Markdown or agent image discussion as generated media.
    if (!url || (image.source !== undefined && image.source !== 'qwen-ai') || seen.has(url)) return []
    seen.add(url)
    return [{ ...image }]
  })
}

export function chatUsageToResponseUsage(usage: unknown): ResponseUsage {
  const value = usage && typeof usage === 'object' ? usage as Record<string, any> : {}
  const inputTokens = Number(value.prompt_tokens ?? value.input_tokens ?? 0) || 0
  const outputTokens = Number(value.completion_tokens ?? value.output_tokens ?? 0) || 0
  const totalTokens = Number(value.total_tokens ?? inputTokens + outputTokens) || 0
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: Number(value.prompt_tokens_details?.cached_tokens
        ?? value.input_tokens_details?.cached_tokens
        ?? 0) || 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: Number(value.completion_tokens_details?.reasoning_tokens
        ?? value.output_tokens_details?.reasoning_tokens
        ?? 0) || 0,
    },
    total_tokens: totalTokens,
  }
}

export function createResponseObject(
  request: ResponseCreateRequest,
  options: {
    id: string
    model: string
    createdAt: number
    status: ResponseObject['status']
    output?: Array<Record<string, any>>
    usage?: ResponseUsage | null
    error?: Record<string, any> | null
    incompleteDetails?: Record<string, any> | null
  },
): ResponseObject {
  return {
    id: options.id,
    object: 'response',
    created_at: options.createdAt,
    status: options.status,
    completed_at: options.status === 'completed' ? Math.floor(Date.now() / 1000) : null,
    background: false,
    error: options.error ?? null,
    incomplete_details: options.incompleteDetails ?? null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    max_tool_calls: typeof request.max_tool_calls === 'number' ? request.max_tool_calls : null,
    model: options.model,
    output: options.output ?? [],
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: typeof request.previous_response_id === 'string'
      ? request.previous_response_id
      : null,
    reasoning: {
      effort: typeof request.reasoning?.effort === 'string' ? request.reasoning.effort : null,
      summary: typeof request.reasoning?.summary === 'string' ? request.reasoning.summary : null,
    },
    service_tier: typeof request.service_tier === 'string' ? request.service_tier : 'default',
    store: request.store ?? false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: request.text && typeof request.text === 'object'
      ? { ...request.text }
      : { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: requestTools(request)?.map((tool) => ({ ...tool })) ?? [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: options.usage ?? null,
    user: typeof request.user === 'string' ? request.user : null,
    metadata: request.metadata && typeof request.metadata === 'object'
      ? { ...request.metadata }
      : {},
  }
}

function chatMessageText(message: Record<string, any>): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.map((part: unknown) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object') {
      return stringValue((part as Record<string, unknown>).text) ?? ''
    }
    return ''
  }).join('')
}

function normalizeToolCalls(message: Record<string, any>): ToolCall[] {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls.filter((call: unknown) => (
      call && typeof call === 'object' && (call as Record<string, any>).function
    )) as ToolCall[]
    : []
}

export async function chatCompletionToResponse(
  chatCompletion: ChatCompletionResponse | Record<string, any>,
  request: ResponseCreateRequest,
  options: {
    id: string
    model: string
    createdAt: number
    imageResolver?: ResponseImageResolver
  },
): Promise<ResponseObject> {
  const choice = chatCompletion.choices?.[0] ?? {}
  const message = choice.message ?? {}
  const incompleteReason = choice.finish_reason === 'length'
    ? 'max_output_tokens'
    : choice.finish_reason === 'content_filter'
      ? 'content_filter'
      : undefined
  const outputStatus = incompleteReason ? 'incomplete' : 'completed'
  const text = chatMessageText(message)
  const toolCalls = normalizeToolCalls(message)
  const images = extractChatResponseImages(message.images)
  const output: Array<Record<string, any>> = []

  if (text.length > 0 || (toolCalls.length === 0 && images.length === 0)) {
    output.push({
      id: `msg_${options.id.slice(5)}`,
      type: 'message',
      status: outputStatus,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
    })
  }

  toolCalls.forEach((toolCall, index) => {
    if (isResponseCustomTool(request, toolCall.function.name)) {
      output.push({
        id: `ctc_${options.id.slice(5)}_${index}`,
        type: 'custom_tool_call',
        status: outputStatus,
        call_id: toolCall.id,
        name: toolCall.function.name,
        input: decodeCustomToolArguments(toolCall.function.arguments),
      })
      return
    }
    output.push({
      id: `fc_${options.id.slice(5)}_${index}`,
      type: 'function_call',
      status: outputStatus,
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    })
  })

  const imageResolver = options.imageResolver ?? defaultResponseImageResolver
  const resolvedImages = await Promise.all(images.map((image) => imageResolver(image)))
  resolvedImages.forEach((image, index) => {
    output.push({
      id: `ig_${options.id.slice(5)}_${index}`,
      type: 'image_generation_call',
      status: 'completed',
      ...image,
    })
  })

  return createResponseObject(request, {
    id: options.id,
    model: typeof chatCompletion.model === 'string' ? chatCompletion.model : options.model,
    createdAt: options.createdAt,
    status: incompleteReason ? 'incomplete' : 'completed',
    output,
    usage: chatUsageToResponseUsage(chatCompletion.usage),
    incompleteDetails: incompleteReason ? { reason: incompleteReason } : null,
  })
}

export function responseOutputToChatMessages(output: Array<Record<string, any>>): ChatMessage[] {
  const messageItems = output.filter((item) => item.type === 'message')
  const functionItems = output.filter((item) => (
    item.type === 'function_call' || item.type === 'custom_tool_call'
  ))
  const messages: ChatMessage[] = messageItems.map((item) => ({
    role: 'assistant',
    content: Array.isArray(item.content)
      ? item.content.map((part: Record<string, any>) => part.text ?? '').join('')
      : '',
  }))
  if (functionItems.length === 0) return messages
  return [...messages, {
    role: 'assistant',
    content: null,
    tool_calls: functionItems.map((item) => ({
      id: item.call_id,
      type: 'function' as const,
      function: {
        name: item.name,
        arguments: item.type === 'custom_tool_call'
          ? encodeCustomToolArguments(typeof item.input === 'string' ? item.input : '')
          : item.arguments,
      },
    })),
  }]
}
