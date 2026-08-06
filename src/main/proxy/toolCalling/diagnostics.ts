import type { ToolClientAdapterId, ToolSmokeCategory } from '../../../shared/toolCalling.ts'

export interface ToolCallingSmokeResult {
  success: boolean
  category: ToolSmokeCategory
  message: string
  clientAdapterId: ToolClientAdapterId
  providerId?: string
  requestId?: string
  timestamp: number
}

let latestSmokeResult: ToolCallingSmokeResult = {
  success: false,
  category: 'not_run',
  message: 'No smoke test has been run.',
  clientAdapterId: 'standard-openai-tools',
  timestamp: 0,
}

export function getLatestToolCallingSmokeResult(): ToolCallingSmokeResult {
  return latestSmokeResult
}

export function setLatestToolCallingSmokeResult(result: ToolCallingSmokeResult): ToolCallingSmokeResult {
  latestSmokeResult = { ...result }
  return latestSmokeResult
}

export function buildSmokeFixture(clientAdapterId: ToolClientAdapterId) {
  return {
    model: 'tool-smoke-test',
    stream: false,
    messages: [{ role: 'user', content: 'Get weather for Hangzhou with the weather tool.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'weather-test:get_weather',
        description: 'Get weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: clientAdapterId === 'cherry-studio-mcp'
      ? { type: 'function', function: { name: 'weather-test:get_weather' } }
      : 'auto',
  }
}
