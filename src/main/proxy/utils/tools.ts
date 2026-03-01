/**
 * Tools Module - Convert OpenAI tools definition to system prompt
 * Enables tool calling for models without native function calling support
 */

import { ChatCompletionTool } from '../types'

/**
 * Convert OpenAI tools definition to system prompt
 */
export function toolsToSystemPrompt(tools: ChatCompletionTool[], simple: boolean = false): string {
  if (!tools || tools.length === 0) {
    return ''
  }

  const toolDefinitions = tools.map(tool => {
    const params = tool.function.parameters
      ? JSON.stringify(tool.function.parameters)
      : '{}'

    return `Tool \`${tool.function.name}\`: ${tool.function.description || 'No description'}. Arguments JSON schema: ${params}`
  }).join('\n')

  if (simple) {
    return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

${toolDefinitions}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE - NO LINE BREAKS inside the JSON
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block
6. If you need to call multiple tools, put them all inside the same [function_calls] block, each with its own [call:...]...[/call] wrapper
7. JSON arguments MUST be compact, all on one line, NO pretty printing, NO newlines
8. If you are writing code or regular expressions, you MUST properly escape all backslashes and quotes inside the JSON string.`
  }

  const caseSensitivityWarning = `
CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'default_api:'.
`

  return `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.
${caseSensitivityWarning}

${toolDefinitions}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list (e.g., if the tool is named \`default_api:read_file\`, you MUST use \`[call:default_api:read_file]\`, NOT \`[call:read_file]\`).
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE - NO LINE BREAKS inside the JSON
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block
6. If you need to call multiple tools, put them all inside the same [function_calls] block, each with its own [call:...]...[/call] wrapper
7. JSON arguments MUST be compact, all on one line, NO pretty printing, NO newlines
8. If you are writing code or regular expressions, you MUST properly escape all backslashes and quotes inside the JSON string.

EXAMPLE with multiple tools - NOTE THE JSON IS ALL ON ONE LINE:
[function_calls]
[call:default_api:read_file]{"filePath":"/path/to/file"}[/call]
[call:default_api:list_dir]{"target_directory":"/path/to/dir"}[/call]
[call:default_api:search_content]{"pattern":"example","directory":"/path/to/dir"}[/call]
[/function_calls]

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content
`
}

/**
 * Hint to be appended to the last user message to reinforce the protocol
 */
export const TOOL_WRAP_HINT = `

IMPORTANT: If you need to use a tool, you MUST wrap the tool call inside a [function_calls] block exactly like:
[function_calls]
[call:exact_tool_name]{"argument":"value"}[/call]
[/function_calls]

CRITICAL - MUST FOLLOW:
- Start with [call:exact_tool_name] (MUST include prefixes like default_api: if present in the tool name)
- Then the JSON arguments ALL ON ONE LINE - NO NEWLINES
- Example: [call:default_api:read_file]{"filePath":"/path/to/file"}[/call]
- Then CLOSE with [/call]
- Respond with NOTHING else if you are calling a tool`
