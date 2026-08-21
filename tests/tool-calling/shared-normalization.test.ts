import assert from 'node:assert/strict'
import test from 'node:test'
import type { NormalizedToolDefinition } from '../../src/main/proxy/toolCalling/types.ts'
import {
  getToolArgumentValidationIssues,
  normalizeArguments,
  normalizeArgumentsForSchema,
} from '../../src/main/proxy/toolCalling/protocols/shared.ts'

function tool(parameters: Record<string, unknown>): NormalizedToolDefinition {
  return {
    name: 'fixture_tool',
    description: 'Shared argument normalization fixture',
    parameters,
    source: 'openai',
  }
}

function normalizedArguments(
  value: unknown,
  parameters: Record<string, unknown>,
): unknown {
  return JSON.parse(normalizeArguments(value, tool(parameters)))
}

const questionSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label', 'description'],
              additionalProperties: false,
            },
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
    },
    context: {
      type: 'object',
      properties: {
        attempt: { type: 'integer' },
      },
      required: ['attempt'],
      additionalProperties: false,
    },
  },
  required: ['questions'],
  additionalProperties: false,
}

test('shared normalization restores JSON strings for declared array and object fields', () => {
  const value = normalizedArguments({
    questions: JSON.stringify([{
      question: 'Choose a task',
      options: [
        { label: 'Code', description: 'Edit the project' },
        { label: 'Review', description: 'Inspect the project' },
      ],
    }]),
    context: JSON.stringify({ attempt: 2 }),
  }, questionSchema)

  assert.deepEqual(value, {
    questions: [{
      question: 'Choose a task',
      options: [
        { label: 'Code', description: 'Edit the project' },
        { label: 'Review', description: 'Inspect the project' },
      ],
    }],
    context: { attempt: 2 },
  })
})

test('shared normalization recursively restores nested structured JSON strings', () => {
  const schema = {
    type: 'object',
    properties: {
      payload: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { label: { type: 'string' } },
                  },
                },
                settings: {
                  type: 'object',
                  properties: { enabled: { type: 'boolean' } },
                },
              },
            },
          },
        },
      },
    },
  }
  const value = normalizedArguments({
    payload: JSON.stringify({
      groups: JSON.stringify([{
        options: JSON.stringify([{ label: 'Code' }, { label: 'Review' }]),
        settings: JSON.stringify({ enabled: true }),
      }]),
    }),
  }, schema)

  assert.deepEqual(value, {
    payload: {
      groups: [{
        options: [{ label: 'Code' }, { label: 'Review' }],
        settings: { enabled: true },
      }],
    },
  })
})

test('shared normalization preserves JSON text for fields declared as strings', () => {
  const value = normalizedArguments({
    objectText: '{"enabled":true}',
    arrayText: '[1,2,3]',
  }, {
    type: 'object',
    properties: {
      objectText: { type: 'string' },
      arrayText: { type: 'string' },
    },
  })

  assert.deepEqual(value, {
    objectText: '{"enabled":true}',
    arrayText: '[1,2,3]',
  })
})

test('shared normalization leaves invalid structured JSON strings unchanged', () => {
  const invalidArray = '[{"label":"Code"}'
  const invalidObject = '{"enabled":tru}'
  const value = normalizedArguments({
    questions: invalidArray,
    context: invalidObject,
  }, questionSchema)

  assert.deepEqual(value, {
    questions: invalidArray,
    context: invalidObject,
  })
})

test('shared normalization resolves structured unions and nullable schemas conservatively', () => {
  const cases = [
    {
      label: 'anyOf array or null',
      value: '[1,2]',
      schema: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }] },
      expected: [1, 2],
    },
    {
      label: 'oneOf object or null',
      value: '{"enabled":true}',
      schema: {
        oneOf: [
          { type: 'object', properties: { enabled: { type: 'boolean' } } },
          { type: 'null' },
        ],
      },
      expected: { enabled: true },
    },
    {
      label: 'nullable structured value',
      value: null,
      schema: { type: 'array', items: { type: 'string' }, nullable: true },
      expected: null,
    },
    {
      label: 'anyOf containing string',
      value: '[1,2]',
      schema: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'string' }] },
      expected: '[1,2]',
    },
    {
      label: 'oneOf containing string',
      value: '{"enabled":true}',
      schema: {
        oneOf: [
          { type: 'object', properties: { enabled: { type: 'boolean' } } },
          { type: 'string' },
        ],
      },
      expected: '{"enabled":true}',
    },
    {
      label: 'type array containing string',
      value: '[1,2]',
      schema: { type: ['array', 'string'], items: { type: 'integer' } },
      expected: '[1,2]',
    },
  ]

  for (const { label, value, schema, expected } of cases) {
    assert.deepEqual(normalizeArgumentsForSchema(value, tool(schema)), expected, label)
  }
})

test('shared validation reports nested types that normalization could not restore', () => {
  const invalidOptions = '[{"label":"Code","description":"Edit the project"}'
  const invalid = getToolArgumentValidationIssues({
    questions: [{
      question: 'Choose a task',
      options: invalidOptions,
    }],
  }, tool(questionSchema))
  const recoverable = getToolArgumentValidationIssues({
    questions: [{
      question: 'Choose a task',
      options: JSON.stringify([
        { label: 'Code', description: 'Edit the project' },
        { label: 'Review', description: 'Inspect the project' },
      ]),
    }],
  }, tool(questionSchema))

  assert.deepEqual(invalid, {
    missingRequired: [],
    unexpected: [],
    typeMismatches: ['questions[0].options (expected array, received string)'],
  })
  assert.deepEqual(recoverable, {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
  })
})

test('shared validation enforces array cardinality used by AskUserQuestion', () => {
  const oneOption = getToolArgumentValidationIssues({
    questions: [{
      question: 'What should be done?',
      options: [{ label: 'Provide details', description: 'Describe the task.' }],
    }],
  }, tool(questionSchema))
  const twoOptions = getToolArgumentValidationIssues({
    questions: [{
      question: 'What should be done?',
      options: [
        { label: 'Provide details', description: 'Describe the task.' },
        { label: 'Skip', description: 'Continue without details.' },
      ],
    }],
  }, tool(questionSchema))

  assert.deepEqual(oneOption, {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
    valueMismatches: ['questions[0].options (array has 1 items, minimum is 2)'],
  })
  assert.deepEqual(twoOptions, {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
  })
})

test('shared validation enforces scalar, object, uniqueness, and numeric constraints', () => {
  assert.match(
    getToolArgumentValidationIssues('"a"', tool({ type: 'string', minLength: 2 })).valueMismatches?.[0] || '',
    /minimum is 2/,
  )
  assert.match(
    getToolArgumentValidationIssues('"abc"', tool({ type: 'string', pattern: '^x' })).valueMismatches?.[0] || '',
    /does not match pattern/,
  )
  assert.match(
    getToolArgumentValidationIssues([1, 1], tool({ type: 'array', uniqueItems: true })).valueMismatches?.[0] || '',
    /must be unique/,
  )
  assert.match(
    getToolArgumentValidationIssues({}, tool({ type: 'object', minProperties: 1 })).valueMismatches?.[0] || '',
    /minimum is 1/,
  )
  assert.match(
    getToolArgumentValidationIssues(2, tool({ type: 'number', exclusiveMinimum: 2 })).valueMismatches?.[0] || '',
    /greater than 2/,
  )
  assert.match(
    getToolArgumentValidationIssues(5, tool({ type: 'number', multipleOf: 2 })).valueMismatches?.[0] || '',
    /multiple of 2/,
  )
})

test('shared normalization keeps union branches whole and applies allOf constraints cumulatively', () => {
  const objectValue = normalizeArgumentsForSchema({ enabled: true }, tool({
    oneOf: [
      { type: 'array', items: { type: 'string' } },
      { type: 'object', properties: { enabled: { type: 'boolean' } } },
    ],
  }))
  const allOfValue = normalizeArgumentsForSchema({ count: '2', enabled: 'true' }, tool({
    allOf: [
      { type: 'object', properties: { count: { type: 'integer' } } },
      { type: 'object', properties: { enabled: { type: 'boolean' } } },
    ],
  }))

  assert.deepEqual(objectValue, { enabled: true })
  assert.deepEqual(allOfValue, { count: 2, enabled: true })
})

test('shared normalization applies schemas for additional and patterned object properties', () => {
  const value = normalizeArgumentsForSchema({
    dynamic: '2',
    feature_enabled: 'true',
  }, tool({
    type: 'object',
    patternProperties: {
      '^feature_': { type: 'boolean' },
    },
    additionalProperties: { type: 'integer' },
  }))

  assert.deepEqual(value, { dynamic: 2, feature_enabled: true })
  assert.deepEqual(
    getToolArgumentValidationIssues(value, tool({
      type: 'object',
      patternProperties: { '^feature_': { type: 'boolean' } },
      additionalProperties: { type: 'integer' },
    })),
    { missingRequired: [], unexpected: [], typeMismatches: [] },
  )
})

test('shared validation enforces nullability and scalar value constraints after coercion', () => {
  const integerTool = tool({ type: 'integer', enum: [2] })

  assert.equal(normalizeArgumentsForSchema('2', integerTool), 2)
  assert.deepEqual(getToolArgumentValidationIssues('2', integerTool), {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
  })
  assert.deepEqual(getToolArgumentValidationIssues('3', integerTool), {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
    valueMismatches: ['$ (value is not in enum)'],
  })
  assert.deepEqual(getToolArgumentValidationIssues(null, tool({ type: 'array' })), {
    missingRequired: [],
    unexpected: [],
    typeMismatches: ['$ (expected array, received null)'],
  })
  assert.deepEqual(getToolArgumentValidationIssues(null, tool({ type: 'array', nullable: true })), {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
  })
  assert.deepEqual(getToolArgumentValidationIssues('unconstrained', tool({ nullable: true })), {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
  })
})

test('shared normalization preserves strings accepted by const branches', () => {
  const value = normalizeArgumentsForSchema('[1,2]', tool({
    oneOf: [
      { type: 'array', items: { type: 'integer' } },
      { const: '[1,2]' },
    ],
  }))

  assert.equal(value, '[1,2]')
})

test('shared normalization scores union candidates against parent value constraints', () => {
  const constrainedTool = tool({
    enum: [1],
    anyOf: [{ type: 'string' }, { type: 'integer' }],
  })

  assert.equal(normalizeArgumentsForSchema('1', constrainedTool), 1)
  assert.deepEqual(getToolArgumentValidationIssues('1', constrainedTool), {
    missingRequired: [],
    unexpected: [],
    typeMismatches: [],
  })
})

test('shared normalization infers objects from dynamic property schemas', () => {
  const value = normalizeArgumentsForSchema({
    count: '2',
    feature_enabled: 'true',
  }, tool({
    patternProperties: { '^feature_': { type: 'boolean' } },
    additionalProperties: { type: 'integer' },
  }))

  assert.deepEqual(value, { count: 2, feature_enabled: true })
})

test('shared validation compares object constants independent of key order', () => {
  assert.deepEqual(
    getToolArgumentValidationIssues(
      { nested: { b: 2, a: 1 } },
      tool({ const: { nested: { a: 1, b: 2 } } }),
    ),
    { missingRequired: [], unexpected: [], typeMismatches: [] },
  )
})

test('shared validation enforces oneOf branch exclusivity', () => {
  assert.deepEqual(
    getToolArgumentValidationIssues(1, tool({
      oneOf: [{ type: 'number' }, { type: 'integer' }],
    })),
    {
      missingRequired: [],
      unexpected: [],
      typeMismatches: [],
      valueMismatches: ['$ (value matches multiple oneOf branches)'],
    },
  )
})
