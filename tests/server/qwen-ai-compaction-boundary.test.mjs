import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const source = fs.readFileSync('src/main/proxy/qwenAiCompactionBoundary.ts', 'utf8')
const require = createRequire(import.meta.url)
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const module = { exports: {} }
new Function('require', 'module', 'exports', output)(require, module, module.exports)
const {
  boundQwenAiCompactionMessages,
  estimateQwenAiRequestInputTokens,
} = module.exports

test('request input estimate includes the complete tool schema', () => {
  const request = {
    model: 'qwen3-coder-plus',
    messages: [{ role: 'user', content: 'Inspect the workspace.' }],
  }
  const withoutTools = estimateQwenAiRequestInputTokens(request)
  const withTools = estimateQwenAiRequestInputTokens({
    ...request,
    tools: [{
      type: 'function',
      function: {
        name: 'inspect_workspace',
        description: 'Inspect files and return matching records.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'x'.repeat(30_000),
            },
          },
          required: ['query'],
        },
      },
    }],
  })

  assert.ok(withTools > withoutTools + 10_000)
})

test('request input estimate treats inline base64 as a bounded upload reference', () => {
  const estimateWithPayload = payload => estimateQwenAiRequestInputTokens({
    model: 'qwen3-vl-plus',
    messages: [{
      role: 'user',
      content: [{
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${payload}`, detail: 'high' },
      }],
    }],
  })
  const shortPayload = estimateWithPayload('AAAA')
  const longPayload = estimateWithPayload('A'.repeat(250_000))

  assert.ok(Math.abs(longPayload - shortPayload) <= 1)
})

test('request input estimate includes messages, tool calls, and tool results', () => {
  const empty = estimateQwenAiRequestInputTokens({
    model: 'qwen3-coder-plus',
    messages: [],
  })
  const conversation = [{ role: 'user', content: 'Run the lookup.' }]
  const messagesOnly = estimateQwenAiRequestInputTokens({
    model: 'qwen3-coder-plus',
    messages: conversation,
  })
  const withToolCall = estimateQwenAiRequestInputTokens({
    model: 'qwen3-coder-plus',
    messages: [
      ...conversation,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_lookup',
          type: 'function',
          function: { name: 'lookup', arguments: JSON.stringify({ query: 'x'.repeat(600) }) },
        }],
      },
    ],
  })
  const withToolResult = estimateQwenAiRequestInputTokens({
    model: 'qwen3-coder-plus',
    messages: [
      ...conversation,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_lookup',
          type: 'function',
          function: { name: 'lookup', arguments: JSON.stringify({ query: 'x'.repeat(600) }) },
        }],
      },
      { role: 'tool', tool_call_id: 'call_lookup', content: 'result-'.repeat(100) },
    ],
  })

  assert.equal(empty, 1)
  assert.ok(messagesOnly > empty)
  assert.ok(withToolCall > messagesOnly)
  assert.ok(withToolResult > withToolCall)
})

test('compaction boundary derives input budget and preserves complete messages', () => {
  const previous = process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
  process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = '40'
  const messages = [
    { role: 'system', content: 'policy' },
    { role: 'user', content: 'old'.repeat(20) },
    { role: 'assistant', content: 'middle'.repeat(20) },
    { role: 'user', content: 'latest'.repeat(20) },
  ]
  try {
    const result = boundQwenAiCompactionMessages(messages, {
      maxContextLength: 60,
      maxSummaryGenerationLength: 20,
    })

    assert.equal(result.boundarySource, 'metadata')
    assert.equal(result.inputTokenBudget, 40)
    assert.equal(result.trimmed, true)
    assert.ok(result.chunkCount > 1)
    assert.equal(result.coveredTextChars, result.sourceTextChars)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
    else process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = previous
  }
})

test('live one-million-token metadata keeps a 459k-token transcript in one chunk', () => {
  const previousCap = process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
  process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = '0'
  const text = 'x'.repeat(1_378_000)
  try {
    const result = boundQwenAiCompactionMessages([
      { role: 'system', content: 'policy' },
      { role: 'user', content: text },
    ], { maxContextLength: 1000000, maxSummaryGenerationLength: 65536 })

    assert.equal(result.chunkSource, 'metadata_exact')
    assert.equal(result.chunkBudgetTokens, 934464)
    assert.equal(result.chunkCount, 1)
    assert.equal(result.splitMessageCount, 0)
    assert.equal(result.coveredTextChars, result.sourceTextChars)
    assert.ok(result.originalEstimatedTokens > 459000)
    assert.ok(result.chunks[0].estimatedTokens <= result.chunkBudgetTokens)
  } finally {
    if (previousCap === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
    else process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = previousCap
  }
})

test('an explicit positive metadata cap still overrides the live catalogue', () => {
  const previousCap = process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
  process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = '12000'
  const text = '0123456789'.repeat(40000)
  try {
    const result = boundQwenAiCompactionMessages([
      { role: 'system', content: 'policy' },
      { role: 'user', content: text },
    ], { maxContextLength: 1000000, maxSummaryGenerationLength: 65536 })

    assert.equal(result.chunkSource, 'metadata_conservative')
    assert.equal(result.chunkBudgetTokens, 12000)
    assert.ok(result.chunkCount > 1)
    assert.equal(result.splitMessageCount, 1)
    assert.equal(result.coveredTextChars, result.sourceTextChars)
    assert.ok(result.chunks.every(chunk => chunk.estimatedTokens <= result.chunkBudgetTokens))
  } finally {
    if (previousCap === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
    else process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = previousCap
  }
})

test('catalogue-without-limits uses the configured fallback budget', () => {
  const previousCap = process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
  const previousFallback = process.env.CHAT2API_QWEN_AI_COMPACTION_FALLBACK_INPUT_TOKENS
  process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = '0'
  process.env.CHAT2API_QWEN_AI_COMPACTION_FALLBACK_INPUT_TOKENS = '800'
  try {
    const result = boundQwenAiCompactionMessages([
      { role: 'user', content: 'fallback-source-'.repeat(300) },
    ])

    assert.equal(result.chunkSource, 'fallback')
    assert.equal(result.chunkBudgetTokens, 800)
    assert.ok(result.chunkCount > 1)
    assert.equal(result.coveredTextChars, result.sourceTextChars)
  } finally {
    if (previousCap === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS
    else process.env.CHAT2API_QWEN_AI_COMPACTION_METADATA_MAX_INPUT_TOKENS = previousCap
    if (previousFallback === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_FALLBACK_INPUT_TOKENS
    else process.env.CHAT2API_QWEN_AI_COMPACTION_FALLBACK_INPUT_TOKENS = previousFallback
  }
})

test('explicit configured budget takes precedence over catalogue metadata', () => {
  const previous = process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
  process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = '10'
  try {
    const result = boundQwenAiCompactionMessages([
      { role: 'user', content: 'a'.repeat(30) },
      { role: 'user', content: 'b'.repeat(30) },
    ], { maxContextLength: 1000, maxSummaryGenerationLength: 1 })
    assert.equal(result.boundarySource, 'configured')
    assert.equal(result.inputTokenBudget, 10)
    assert.equal(result.messages.length, 1)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
    else process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = previous
  }
})

test('inline upload payload is excluded from context budget and the attachment stays in one chunk', () => {
  const previous = process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
  process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = '100'
  const dataUrl = `data:image/png;base64,${'A'.repeat(250000)}`
  const sourceText = 'before'.repeat(100)
  try {
    const result = boundQwenAiCompactionMessages([{
      role: 'user',
      content: [
        { type: 'text', text: sourceText.slice(0, 300) },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        { type: 'text', text: sourceText.slice(300) },
      ],
    }])

    assert.equal(result.oversizedMessageCount, 0)
    assert.equal(result.splitMessageCount, 1)
    assert.equal(result.coveredTextChars, sourceText.length)
    assert.ok(result.chunks.every(chunk => chunk.estimatedTokens <= result.chunkBudgetTokens))

    const retainedAttachments = result.chunks.flatMap(chunk => (
      chunk.messages.flatMap(message => (
        Array.isArray(message.content)
          ? message.content.filter(part => part.type === 'image_url')
          : []
      ))
    ))
    assert.equal(retainedAttachments.length, 1)
    assert.equal(retainedAttachments[0].image_url.url, dataUrl)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
    else process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = previous
  }
})

test('an unsplittable multimodal reference is reported only when its metadata exceeds budget', () => {
  const previous = process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
  process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = '100'
  try {
    const result = boundQwenAiCompactionMessages([{
      role: 'user',
      content: [{
        type: 'image_url',
        image_url: { url: `https://example.test/${'x'.repeat(1000)}` },
      }],
    }])

    assert.equal(result.chunkCount, 1)
    assert.equal(result.splitMessageCount, 0)
    assert.equal(result.oversizedMessageCount, 1)
    assert.ok(result.chunks[0].estimatedTokens > result.chunkBudgetTokens)
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
    else process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = previous
  }
})

test('non-ASCII text uses a conservative token budget without losing code points', () => {
  const previous = process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
  process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = '100'
  const text = '中文压缩测试🙂'.repeat(200)
  try {
    const result = boundQwenAiCompactionMessages([{ role: 'user', content: text }])
    const rebuilt = result.chunks
      .flatMap(chunk => chunk.messages)
      .map(message => message.content)
      .join('')

    assert.equal(rebuilt, text)
    assert.ok(result.chunkCount > 1)
    assert.ok(result.chunks.every(chunk => chunk.estimatedTokens <= result.chunkBudgetTokens))
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
    else process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = previous
  }
})

test('multimodal splitting preserves text and attachment order', () => {
  const previous = process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
  process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = '80'
  const before = 'before-'.repeat(20)
  const after = 'after-'.repeat(20)
  try {
    const result = boundQwenAiCompactionMessages([{
      role: 'user',
      content: [
        { type: 'text', text: before },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: after },
      ],
    }])
    const orderedParts = result.chunks
      .flatMap(chunk => chunk.messages)
      .flatMap(message => message.content)
    const attachmentIndex = orderedParts.findIndex(part => part.type === 'image_url')
    const beforeText = orderedParts.slice(0, attachmentIndex)
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
    const afterText = orderedParts.slice(attachmentIndex + 1)
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')

    assert.equal(beforeText, before)
    assert.equal(afterText, after)
    assert.equal(orderedParts.filter(part => part.type === 'image_url').length, 1)
    assert.ok(result.chunks.every(chunk => chunk.estimatedTokens <= result.chunkBudgetTokens))
  } finally {
    if (previous === undefined) delete process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET
    else process.env.CHAT2API_QWEN_AI_COMPACTION_INPUT_TOKEN_BUDGET = previous
  }
})
