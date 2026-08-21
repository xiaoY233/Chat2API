import { Transform, type TransformCallback } from 'node:stream'
import {
  chatUsageToResponseUsage,
  createResponseObject,
  decodeCustomToolArguments,
  defaultResponseImageResolver,
  extractChatResponseImages,
  isResponseCustomTool,
  type ChatResponseImage,
  type ResponseCreateRequest,
  type ResponseImageResolver,
  type ResponseObject,
  type ResponseUsage,
} from './compat.ts'

interface ResponsesStreamOptions {
  request: ResponseCreateRequest
  responseId: string
  model: string
  createdAt?: number
  imageResolver?: ResponseImageResolver
  onComplete?: (response: ResponseObject) => void | Promise<void>
  onIncomplete?: (response: ResponseObject) => void | Promise<void>
  onFailure?: (error: Error, response: ResponseObject) => void
}

interface ToolStreamState {
  key: string
  chatIndex: number
  outputIndex: number
  itemId: string
  callId?: string
  name: string
  arguments: string
  custom: boolean
  started: boolean
}

interface IndexedOutput {
  outputIndex: number
  item: Record<string, any>
}

interface ParsedSseEvent {
  data: string
}

class IncrementalSseParser {
  private buffer = ''

  push(chunk: string): ParsedSseEvent[] {
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n')
    const blocks = this.buffer.split('\n\n')
    this.buffer = blocks.pop() ?? ''
    return blocks.flatMap((block) => {
      const dataLines = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
      return dataLines.length > 0 ? [{ data: dataLines.join('\n') }] : []
    })
  }

  finish(): ParsedSseEvent[] {
    if (!this.buffer.trim()) return []
    const final = this.push('\n\n')
    this.buffer = ''
    return final
  }
}

function mergeIncremental(current: string, fragment: unknown): { value: string; delta: string } {
  if (typeof fragment !== 'string' || fragment.length === 0) {
    return { value: current, delta: '' }
  }
  if (fragment === current || current.startsWith(fragment)) {
    return { value: current, delta: '' }
  }
  if (fragment.startsWith(current)) {
    return { value: fragment, delta: fragment.slice(current.length) }
  }
  return { value: current + fragment, delta: fragment }
}

function toolKey(call: Record<string, any>, fallbackIndex: number): string {
  if (Number.isInteger(call.index)) return `index:${call.index}`
  if (typeof call.id === 'string' && call.id) return `id:${call.id}`
  return `index:${fallbackIndex}`
}

function responseIdSuffix(responseId: string): string {
  return responseId.startsWith('resp_') ? responseId.slice(5) : responseId
}

function customToolNames(request: ResponseCreateRequest): string[] {
  const inputTools = Array.isArray(request.input)
    ? request.input.flatMap((item) => (
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && item.type === 'additional_tools'
        && Array.isArray(item.tools)
          ? item.tools
          : []
      ))
    : []
  return [
    ...(request.tools ?? []),
    ...(request.additional_tools ?? []),
    ...inputTools,
  ].flatMap((tool) => (
    tool?.type === 'custom' && typeof tool.name === 'string' ? [tool.name] : []
  ))
}

export class ChatCompletionsToResponsesStream extends Transform {
  private readonly parser = new IncrementalSseParser()
  private readonly request: ResponseCreateRequest
  private readonly responseId: string
  private readonly model: string
  private readonly createdAt: number
  private readonly imageResolver: ResponseImageResolver
  private readonly customToolNames: string[]
  private readonly onComplete?: ResponsesStreamOptions['onComplete']
  private readonly onIncomplete?: ResponsesStreamOptions['onIncomplete']
  private readonly onFailure?: ResponsesStreamOptions['onFailure']
  private started = false
  private finalized = false
  private finalizationPromise?: Promise<void>
  private sawDone = false
  private finishReason?: string
  private sequenceNumber = 0
  private nextOutputIndex = 0
  private textStarted = false
  private text = ''
  private textOutputIndex = -1
  private readonly textItemId: string
  private reasoningStarted = false
  private reasoningFinished = false
  private reasoning = ''
  private reasoningOutputIndex = -1
  private readonly reasoningItemId: string
  private toolStates = new Map<string, ToolStreamState>()
  private images: ChatResponseImage[] = []
  private indexedOutputs: IndexedOutput[] = []
  private usage: ResponseUsage | null = null

  constructor(options: ResponsesStreamOptions) {
    super()
    this.request = options.request
    this.responseId = options.responseId
    this.model = options.model
    this.createdAt = options.createdAt ?? Math.floor(Date.now() / 1000)
    this.imageResolver = options.imageResolver ?? defaultResponseImageResolver
    this.customToolNames = customToolNames(options.request)
    this.onComplete = options.onComplete
    this.onIncomplete = options.onIncomplete
    this.onFailure = options.onFailure
    this.textItemId = `msg_${responseIdSuffix(this.responseId)}`
    this.reasoningItemId = `rs_${responseIdSuffix(this.responseId)}`
  }

  start(): this {
    if (this.started) return this
    this.started = true
    const response = createResponseObject(this.request, {
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status: 'in_progress',
      usage: null,
    })
    this.enqueueEvent('response.created', { response })
    this.enqueueEvent('response.in_progress', { response: { ...response } })
    return this
  }

  fail(error: Error): void {
    if (this.finalized) return
    this.start()
    this.finalized = true
    const responseError = {
      code: typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : 'upstream_error',
      message: error.message,
    }
    this.enqueueEvent('error', {
      code: responseError.code,
      message: responseError.message,
      param: null,
    })
    const response = createResponseObject(this.request, {
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status: 'failed',
      output: this.sortedOutput(),
      usage: this.usage,
      error: responseError,
    })
    try {
      this.onFailure?.(error, response)
    } catch (callbackError) {
      this.reportLifecycleCallbackError('failure', callbackError)
    }
    this.enqueueEvent('response.failed', { response })
  }

  override _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.start()
    void this.processEvents(this.parser.push(chunk.toString()))
      .then(() => callback())
      .catch((error) => callback(error as Error))
  }

  override _flush(callback: TransformCallback): void {
    this.start()
    void this.processEvents(this.parser.finish())
      .then(async () => {
        if (this.finalized) return
        if (!this.sawDone) {
          const error = new Error('Upstream stream ended before the [DONE] marker.') as Error & { code: string }
          error.code = 'incomplete_upstream_stream'
          this.fail(error)
          return
        }
        await this.finalize()
      })
      .then(() => callback())
      .catch((error) => callback(error as Error))
  }

  private async processEvents(events: ParsedSseEvent[]): Promise<void> {
    for (const event of events) {
      if (this.finalized) return
      if (event.data === '[DONE]') {
        this.sawDone = true
        await this.finalize()
        continue
      }
      let chunk: Record<string, any>
      try {
        chunk = JSON.parse(event.data) as Record<string, any>
      } catch {
        const error = new Error('Upstream stream returned malformed JSON data.') as Error & { code: string }
        error.code = 'invalid_upstream_stream'
        this.fail(error)
        continue
      }
      if (chunk.error) {
        const message = typeof chunk.error.message === 'string'
          ? chunk.error.message
          : 'Upstream stream returned an error.'
        const error = new Error(message) as Error & { code?: string }
        if (typeof chunk.error.code === 'string') error.code = chunk.error.code
        this.fail(error)
        continue
      }

      if (chunk.usage) this.usage = chatUsageToResponseUsage(chunk.usage)
      const choice = chunk.choices?.[0]
      if (!choice || typeof choice !== 'object') continue
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        this.finishReason = choice.finish_reason
      }
      const delta = choice.delta ?? {}

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        this.appendReasoning(delta.reasoning_content)
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        this.finishReasoning()
        this.appendText(delta.content)
      }
      if (Array.isArray(delta.tool_calls)) {
        if (delta.tool_calls.length > 0) this.finishReasoning()
        delta.tool_calls.forEach((call: Record<string, any>, index: number) => {
          this.appendToolCall(call, index)
        })
      }
      const newImages = extractChatResponseImages(delta.images)
      if (newImages.length > 0) {
        this.finishReasoning()
        const existingUrls = new Set(this.images.map((image) => this.imageUrl(image)))
        this.images = [
          ...this.images,
          ...newImages.filter((image) => !existingUrls.has(this.imageUrl(image))),
        ]
      }
    }
  }

  private ensureReasoningStarted(): void {
    if (this.reasoningStarted || this.reasoningFinished) return
    this.reasoningStarted = true
    this.reasoningOutputIndex = this.nextOutputIndex
    this.nextOutputIndex += 1
    this.enqueueEvent('response.output_item.added', {
      output_index: this.reasoningOutputIndex,
      item: {
        id: this.reasoningItemId,
        type: 'reasoning',
        status: 'in_progress',
        summary: [],
      },
    })
  }

  private appendReasoning(delta: string): void {
    if (this.reasoningFinished) return
    this.ensureReasoningStarted()
    this.reasoning += delta
    this.enqueueEvent('response.reasoning_summary_text.delta', {
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      delta,
    })
  }

  private finishReasoning(): void {
    if (!this.reasoningStarted || this.reasoningFinished) return
    this.reasoningFinished = true
    const part = {
      type: 'summary_text',
      text: this.reasoning,
    }
    const item = {
      id: this.reasoningItemId,
      type: 'reasoning',
      summary: [{ ...part }],
    }
    this.enqueueEvent('response.reasoning_summary_text.done', {
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      text: this.reasoning,
    })
    this.enqueueEvent('response.reasoning_summary_part.done', {
      item_id: this.reasoningItemId,
      output_index: this.reasoningOutputIndex,
      summary_index: 0,
      part,
    })
    this.enqueueEvent('response.output_item.done', {
      output_index: this.reasoningOutputIndex,
      item,
    })
    this.indexedOutputs = [
      ...this.indexedOutputs,
      { outputIndex: this.reasoningOutputIndex, item },
    ]
  }

  private ensureTextStarted(): void {
    if (this.textStarted) return
    this.textStarted = true
    this.textOutputIndex = this.nextOutputIndex
    this.nextOutputIndex += 1
    this.enqueueEvent('response.output_item.added', {
      output_index: this.textOutputIndex,
      item: {
        id: this.textItemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    })
    this.enqueueEvent('response.content_part.added', {
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    })
  }

  private appendText(delta: string): void {
    this.ensureTextStarted()
    this.text += delta
    this.enqueueEvent('response.output_text.delta', {
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      delta,
      logprobs: [],
    })
  }

  private appendToolCall(call: Record<string, any>, fallbackIndex: number): void {
    const key = toolKey(call, fallbackIndex)
    const existing = this.toolStates.get(key)
    const chatIndex = Number.isInteger(call.index) ? call.index : existing?.chatIndex ?? fallbackIndex
    const outputIndex = existing?.outputIndex ?? this.nextOutputIndex
    if (!existing) this.nextOutputIndex += 1

    const nameMerge = mergeIncremental(existing?.name ?? '', call.function?.name)
    const argumentMerge = mergeIncremental(existing?.arguments ?? '', call.function?.arguments)
    const callId = typeof call.id === 'string' && call.id
      ? call.id
      : existing?.callId
    const custom = isResponseCustomTool(this.request, nameMerge.value)
    const customNamePending = Boolean(nameMerge.value) && this.customToolNames.some((name) => (
      name !== nameMerge.value && name.startsWith(nameMerge.value)
    ))
    const itemId = existing && (existing.started || !custom)
      ? existing.itemId
      : `${custom ? 'ctc' : 'fc'}_${responseIdSuffix(this.responseId)}_${chatIndex}`
    const state: ToolStreamState = {
      key,
      chatIndex,
      outputIndex,
      itemId,
      callId,
      name: nameMerge.value,
      arguments: argumentMerge.value,
      custom,
      started: existing?.started ?? false,
    }

    const canStart = Boolean(state.name && state.callId && !customNamePending)
    let nextState = state
    if (!state.started && canStart) {
      this.enqueueToolAdded(state)
      nextState = { ...state, started: true }
      if (state.arguments) this.enqueueToolArgumentDelta(nextState, state.arguments)
    } else if (state.started && argumentMerge.delta) {
      this.enqueueToolArgumentDelta(state, argumentMerge.delta)
    }

    this.toolStates = new Map([
      ...Array.from(this.toolStates.entries()).filter(([stateKey]) => stateKey !== key),
      [key, nextState],
    ])
  }

  private enqueueToolAdded(state: ToolStreamState): void {
    const item = state.custom
      ? {
          id: state.itemId,
          type: 'custom_tool_call',
          status: 'in_progress',
          call_id: state.callId,
          name: state.name,
          input: '',
        }
      : {
          id: state.itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: state.callId,
          name: state.name,
          arguments: '',
        }
    this.enqueueEvent('response.output_item.added', {
      output_index: state.outputIndex,
      item,
    })
  }

  private enqueueToolArgumentDelta(state: ToolStreamState, delta: string): void {
    if (state.custom) return
    this.enqueueEvent('response.function_call_arguments.delta', {
      item_id: state.itemId,
      output_index: state.outputIndex,
      delta,
    })
  }

  private finishText(status: 'completed' | 'incomplete'): void {
    if (!this.textStarted) return
    const contentPart = {
      type: 'output_text',
      text: this.text,
      annotations: [],
      logprobs: [],
    }
    const item = {
      id: this.textItemId,
      type: 'message',
      status,
      role: 'assistant',
      content: [contentPart],
    }
    this.enqueueEvent('response.output_text.done', {
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      text: this.text,
      logprobs: [],
    })
    this.enqueueEvent('response.content_part.done', {
      item_id: this.textItemId,
      output_index: this.textOutputIndex,
      content_index: 0,
      part: { ...contentPart },
    })
    this.enqueueEvent('response.output_item.done', {
      output_index: this.textOutputIndex,
      item,
    })
    this.indexedOutputs = [
      ...this.indexedOutputs,
      { outputIndex: this.textOutputIndex, item },
    ]
  }

  private finishTools(status: 'completed' | 'incomplete'): void {
    const states = Array.from(this.toolStates.values()).sort((a, b) => a.outputIndex - b.outputIndex)
    states.forEach((state) => {
      const completedState: ToolStreamState = {
        ...state,
        callId: state.callId ?? `call_${responseIdSuffix(this.responseId)}_${state.chatIndex}`,
        name: state.name || 'unknown',
        custom: isResponseCustomTool(this.request, state.name),
      }
      if (!completedState.started) {
        this.enqueueToolAdded(completedState)
        if (completedState.arguments) {
          this.enqueueToolArgumentDelta(completedState, completedState.arguments)
        }
      }
      const customInput = completedState.custom
        ? decodeCustomToolArguments(completedState.arguments)
        : undefined
      const item = completedState.custom
        ? {
            id: completedState.itemId,
            type: 'custom_tool_call',
            status,
            call_id: completedState.callId,
            name: completedState.name,
            input: customInput,
          }
        : {
            id: completedState.itemId,
            type: 'function_call',
            status,
            call_id: completedState.callId,
            name: completedState.name,
            arguments: completedState.arguments,
          }
      if (completedState.custom) {
        if (customInput) {
          this.enqueueEvent('response.custom_tool_call_input.delta', {
            item_id: completedState.itemId,
            output_index: completedState.outputIndex,
            delta: customInput,
          })
        }
        this.enqueueEvent('response.custom_tool_call_input.done', {
          item_id: completedState.itemId,
          output_index: completedState.outputIndex,
          input: customInput ?? '',
        })
      } else {
        this.enqueueEvent('response.function_call_arguments.done', {
          item_id: completedState.itemId,
          output_index: completedState.outputIndex,
          arguments: completedState.arguments,
        })
      }
      this.enqueueEvent('response.output_item.done', {
        output_index: completedState.outputIndex,
        item,
      })
      this.indexedOutputs = [
        ...this.indexedOutputs,
        { outputIndex: completedState.outputIndex, item },
      ]
    })
  }

  private async finishImages(): Promise<void> {
    const resolved = await Promise.all(this.images.map((image) => this.imageResolver(image)))
    resolved.forEach((image, index) => {
      const outputIndex = this.nextOutputIndex
      this.nextOutputIndex += 1
      const itemId = `ig_${responseIdSuffix(this.responseId)}_${index}`
      this.enqueueEvent('response.output_item.added', {
        output_index: outputIndex,
        item: {
          id: itemId,
          type: 'image_generation_call',
          status: 'in_progress',
        },
      })
      const item = {
        id: itemId,
        type: 'image_generation_call',
        status: 'completed',
        ...image,
      }
      this.enqueueEvent('response.output_item.done', { output_index: outputIndex, item })
      this.indexedOutputs = [...this.indexedOutputs, { outputIndex, item }]
    })
  }

  private async finalize(): Promise<void> {
    if (this.finalized) return
    if (this.finalizationPromise) return this.finalizationPromise
    this.finalizationPromise = this.finishResponse()
    return this.finalizationPromise
  }

  private async finishResponse(): Promise<void> {
    if (this.finalized) return
    if (!this.finishReason) {
      const error = new Error('Upstream stream reached [DONE] without a finish_reason.') as Error & { code: string }
      error.code = 'invalid_upstream_stream'
      this.fail(error)
      return
    }
    const incompleteReason = this.finishReason === 'length'
      ? 'max_output_tokens'
      : this.finishReason === 'content_filter'
        ? 'content_filter'
        : undefined
    const itemStatus = incompleteReason ? 'incomplete' : 'completed'
    if (!this.textStarted && !this.reasoningStarted && this.toolStates.size === 0 && this.images.length === 0) {
      this.ensureTextStarted()
    }
    this.finishReasoning()
    this.finishText(itemStatus)
    this.finishTools(itemStatus)
    try {
      await this.finishImages()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (this.finalized) return
    this.finalized = true

    const baseResponse = createResponseObject(this.request, {
      id: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      status: incompleteReason ? 'incomplete' : 'completed',
      output: this.sortedOutput(),
      usage: this.usage ?? chatUsageToResponseUsage(undefined),
    })
    const response = incompleteReason
      ? { ...baseResponse, incomplete_details: { reason: incompleteReason } }
      : baseResponse
    if (incompleteReason) {
      try {
        await this.onIncomplete?.(response)
      } catch (callbackError) {
        this.reportLifecycleCallbackError('incomplete', callbackError)
      }
      this.enqueueEvent('response.incomplete', { response })
      return
    }
    try {
      await this.onComplete?.(response)
    } catch (callbackError) {
      this.reportLifecycleCallbackError('completion', callbackError)
    }
    this.enqueueEvent('response.completed', { response })
  }

  private reportLifecycleCallbackError(
    phase: 'completion' | 'incomplete' | 'failure',
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[Responses] ${phase} callback failed after stream state was resolved: ${message}`)
  }

  private sortedOutput(): Array<Record<string, any>> {
    return [...this.indexedOutputs]
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map(({ item }) => ({ ...item }))
  }

  private imageUrl(image: ChatResponseImage): string {
    if (typeof image.image_url === 'string') return image.image_url
    return image.image_url?.url ?? image.url ?? ''
  }

  private enqueueEvent(type: string, fields: Record<string, any>): void {
    const event = {
      type,
      sequence_number: this.sequenceNumber,
      ...fields,
    }
    this.sequenceNumber += 1
    this.push(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
}

export function createResponsesStreamTransform(
  options: ResponsesStreamOptions,
): ChatCompletionsToResponsesStream {
  return new ChatCompletionsToResponsesStream(options)
}
