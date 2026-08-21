import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

const runtimeRequire = createRequire(import.meta.url)
const source = fs.readFileSync('src/main/proxy/requestIntent.ts', 'utf8')
const output = ts.transpileModule(source, {
  compilerOptions: {
    esModuleInterop: true,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const module = { exports: {} }
new Function('require', 'module', 'exports', output)(runtimeRequire, module, module.exports)

const { classifyChatRequest } = module.exports

test('request intent detects the observed Claude context summary protocol', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    stream: true,
    tools: [{ type: 'function', function: { name: 'PowerShell' } }],
    messages: [
      { role: 'system', content: 'System instructions' },
      { role: 'user', content: 'Earlier conversation' },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Create a detailed summary of the conversation so far.',
          },
        ],
      },
    ],
  })

  assert.equal(result.intent, 'context_compaction')
  assert.equal(result.reason, 'text_only_tool_prohibition_summary')
  assert.equal(result.toolCount, 1)
  assert.match(result.lastUserTextPrefix, /CRITICAL: Respond with TEXT ONLY/)
})

test('request intent detects Claude summary turns that omit the tool prohibition', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max',
    stream: true,
    tools: Array.from({ length: 35 }, (_, index) => ({
      type: 'function',
      function: { name: `tool_${index}` },
    })),
    messages: [
      { role: 'user', content: 'Complete the implementation.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'tool_1', arguments: '{}' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'large tool result',
        }],
      },
      {
        role: 'user',
        content: 'CRITICAL: Respond with TEXT ONLY. Create a detailed summary of the conversation context.',
      },
    ],
  })

  assert.equal(result.intent, 'context_compaction')
  assert.equal(result.reason, 'text_only_summary_with_tool_history')
  assert.equal(result.toolResultCount, 1)
  assert.ok(result.signals.includes('terminal_tool_history'))
})

test('a text-only summary without tool history remains a normal request', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max',
    tools: [{ type: 'function', function: { name: 'Read' } }],
    messages: [{ role: 'user', content: 'Respond with text only and summarize this note.' }],
  })

  assert.equal(result.intent, 'normal')
  assert.equal(result.toolResultCount, 0)
})

test('ordinary summary requests remain normal provider requests', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    messages: [{ role: 'user', content: 'Please summarize this short note.' }],
  })

  assert.equal(result.intent, 'normal')
})

test('an old compaction instruction does not taint a later ordinary user turn', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    messages: [
      {
        role: 'user',
        content: 'Summarize the conversation. Respond with text only and do not call tools.',
      },
      { role: 'assistant', content: 'Earlier summary.' },
      { role: 'user', content: 'Now inspect the latest service logs and continue the task.' },
    ],
  })

  assert.equal(result.intent, 'normal')
  assert.equal(result.reason, 'no_compaction_signal')
})

test('explicit metadata can identify a compaction turn without prompt matching', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    metadata: { purpose: 'context_compaction' },
    messages: [{ role: 'user', content: 'opaque protocol payload' }],
  })

  assert.equal(result.intent, 'context_compaction')
  assert.equal(result.reason, 'explicit_compaction_marker')
})

test('Anthropic context_management identifies a compaction turn structurally', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    context_management: {
      edits: [{ type: 'clear_tool_uses_20250919' }],
    },
    messages: [{ role: 'user', content: 'opaque protocol payload' }],
  })

  assert.equal(result.intent, 'context_compaction')
  assert.equal(result.reason, 'protocol_compaction_marker')
  assert.ok(result.signals.includes('protocol_compaction_field'))
})

test('a nested LiteLLM protocol envelope identifies context compaction', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    extra_body: {
      anthropic: {
        contextManagement: { enabled: true },
      },
    },
    messages: [{ role: 'user', content: 'opaque protocol payload' }],
  })

  assert.equal(result.intent, 'context_compaction')
  assert.ok(result.signals.includes('nested_protocol_compaction_marker'))
})

test('a top-level system compaction mention is diagnostic but not decisive', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    system: 'Create a context summary by compressing the conversation history.',
    messages: [{ role: 'user', content: 'continue' }],
  })

  assert.equal(result.intent, 'normal')
  assert.equal(result.reason, 'no_compaction_signal')
  assert.ok(result.signals.includes('system_compaction_marker'))
})

test('Claude Code system documentation does not strip tools from an ordinary tool request', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max',
    stream: true,
    tools: [
      { type: 'function', function: { name: 'Bash' } },
      { type: 'function', function: { name: 'Read' } },
    ],
    system: [
      {
        type: 'text',
        text: 'You are Claude Code. Context compaction may summarize the conversation history when the context window is full.',
      },
    ],
    messages: [
      { role: 'user', content: 'Use Bash to run pwd, then report the exact output.' },
    ],
  })

  assert.equal(result.intent, 'normal')
  assert.equal(result.reason, 'no_compaction_signal')
  assert.equal(result.toolCount, 2)
  assert.ok(result.signals.includes('system_compaction_marker'))
})

test('a short continuation immediately after a compaction instruction stays on the compaction path', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    messages: [
      {
        role: 'user',
        content: 'Summarize the conversation history. Respond with text only and do not call tools.',
      },
      { role: 'user', content: 'continue' },
    ],
  })

  assert.equal(result.intent, 'context_compaction')
  assert.equal(result.reason, 'continuation_after_compaction_instruction')
})

test('ordinary summarization metadata does not masquerade as context compaction', () => {
  const result = classifyChatRequest({
    model: 'Qwen3.8-Max-Preview',
    metadata: { task: 'summarize_document' },
    messages: [{ role: 'user', content: 'Please summarize this short note.' }],
  })

  assert.equal(result.intent, 'normal')
})
