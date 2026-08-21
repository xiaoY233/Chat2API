import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isCompleteJsonText,
  mergeNativeToolArguments,
  mergeNativeToolName,
  normalizeNativeFunctionCallDelta,
} from '../../src/main/proxy/adapters/qwen-ai-native-tools.ts'
import { getToolArgumentValidationIssues } from '../../src/main/proxy/toolCalling/protocols/shared.ts'

test('Qwen AI native tool argument merge supports cumulative chunks without duplication', () => {
  let args = ''
  args = mergeNativeToolArguments(args, '{"items"')
  args = mergeNativeToolArguments(args, '{"items":[1')
  args = mergeNativeToolArguments(args, '{"items":[1,2]}')

  assert.equal(args, '{"items":[1,2]}')
  assert.equal(isCompleteJsonText(args), true)
})

test('Qwen AI native tool argument merge supports incremental chunks', () => {
  let args = ''
  args = mergeNativeToolArguments(args, '{"items"')
  args = mergeNativeToolArguments(args, ':[1')
  args = mergeNativeToolArguments(args, ',2]}')

  assert.equal(args, '{"items":[1,2]}')
  assert.equal(isCompleteJsonText(args), true)
})

test('Qwen AI native tool argument merge replaces newer complete snapshots', () => {
  let args = ''
  args = mergeNativeToolArguments(args, '{"command":"node dist/cli.js"}')
  args = mergeNativeToolArguments(args, '{"command":"node dist/cli.js","workdir":"C:\\\\tmp"}')

  assert.equal(args, '{"command":"node dist/cli.js","workdir":"C:\\\\tmp"}')
  assert.equal(isCompleteJsonText(args), true)
})

test('Qwen AI native tool name merge collapses repeated cumulative snapshots', () => {
  const allowed = new Set(['shell_exec'])
  let name = ''
  name = mergeNativeToolName(name, 'shell_exec', allowed)
  name = mergeNativeToolName(name, 'shell_execshell_exec', allowed)
  name = mergeNativeToolName(name, 'shell_execshell_execshell_exec', allowed)

  assert.equal(name, 'shell_exec')
  assert.equal(mergeNativeToolName('', 'shell_execshell_exec', allowed), 'shell_exec')
})

test('Qwen AI native tool name merge supports genuine name fragments', () => {
  const allowed = new Set(['namespace:search_tool'])
  let name = ''
  name = mergeNativeToolName(name, 'namespace:', allowed)
  name = mergeNativeToolName(name, 'search_', allowed)
  name = mergeNativeToolName(name, 'tool', allowed)

  assert.equal(name, 'namespace:search_tool')
})

test('Qwen AI native tool name merge preserves unknown names for validation', () => {
  const allowed = new Set(['declared_tool'])

  assert.equal(
    mergeNativeToolName('unknown', 'unknown_suffix', allowed),
    'unknown_suffix',
  )
})

test('Qwen AI native function call normalization accepts OpenAI-style tool_calls and legacy function_call', () => {
  const toolCalls = normalizeNativeFunctionCallDelta({
    tool_calls: [
      {
        index: 2,
        id: 'call_any',
        function: {
          name: 'namespace:any_tool',
          arguments: { value: 1 },
        },
      },
    ],
    function_call: {
      name: 'namespace:legacy_tool',
      arguments: '{"value":2}',
    },
  })

  assert.deepEqual(toolCalls, [
    {
      key: 'call_any',
      id: 'call_any',
      index: 2,
      name: 'namespace:any_tool',
      arguments: '{"value":1}',
    },
    {
      key: '1',
      id: undefined,
      index: 1,
      name: 'namespace:legacy_tool',
      arguments: '{"value":2}',
    },
  ])
})

test('Qwen AI native function call normalization unwraps matching provider parameter wrappers', () => {
  const toolCalls = normalizeNativeFunctionCallDelta({
    function_call: {
      name: 'namespace:any_tool',
      arguments: {
        command: '<｜QCML｜parameter name="command"><![CDATA[Test-Path -LiteralPath "x"]]></｜QCML｜parameter>]]>',
        untouched: '<｜QCML｜parameter name="other"><![CDATA[value]]></｜QCML｜parameter>]]>',
      },
    },
  })

  assert.deepEqual(toolCalls, [
    {
      key: '0',
      id: undefined,
      index: 0,
      name: 'namespace:any_tool',
      arguments: '{"command":"Test-Path -LiteralPath \\"x\\"","untouched":"<｜QCML｜parameter name=\\"other\\"><![CDATA[value]]></｜QCML｜parameter>]]>"}',
    },
  ])
})

test('tool argument validation catches missing required and strict unknown fields without hardcoding tool names', () => {
  const tool = {
    name: 'arbitrary_tool',
    source: 'openai' as const,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }

  assert.deepEqual(
    getToolArgumentValidationIssues({ prompt: 'generate an image' }, tool),
    {
      missingRequired: ['command'],
      unexpected: ['prompt'],
      typeMismatches: [],
    },
  )
  assert.deepEqual(
    getToolArgumentValidationIssues({ command: 'Get-ChildItem' }, tool),
    { missingRequired: [], unexpected: [], typeMismatches: [] },
  )
})

test('tool argument validation preserves explicitly open additional properties', () => {
  const tool = {
    name: 'dynamic_tool',
    source: 'openai' as const,
    parameters: {
      type: 'object',
      properties: { known: { type: 'string' } },
    },
  }

  assert.deepEqual(
    getToolArgumentValidationIssues({ known: 'ok', dynamic: 1 }, tool),
    { missingRequired: [], unexpected: [], typeMismatches: [] },
  )
})
