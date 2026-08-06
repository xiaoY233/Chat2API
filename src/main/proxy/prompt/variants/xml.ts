/**
 * XML Prompt Variant
 * XML format tool calling for clients like Cherry Studio
 */

import { PromptVariant } from '../types'

export const XML_VARIANT: PromptVariant = {
  id: 'xml',
  name: 'XML Format',
  description: 'XML format tool calling',
  modelPatterns: ['.*'],
  systemPrompt: 'You are a helpful AI assistant.',
  toolPromptTemplate: `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'default_api:'.

{{TOOL_DEFINITIONS}}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single <tool_use> block exactly like the template below:

<tool_use>
  <name>exact_tool_name_from_list</name>
  <arguments>{"argument": "value"}</arguments>
</tool_use>

CRITICAL RULES:
1. You MUST use the EXACT tool name as defined in the Available Tools list (e.g., if the tool is named \`default_api:read_file\`, you MUST use \`<name>default_api:read_file</name>\`, NOT \`<name>read_file</name>\`).
2. The content inside <arguments> MUST be a raw JSON object
3. Do NOT wrap JSON in \`\`\`json blocks
4. Do NOT output any other text, explanation, or reasoning before or after the <tool_use> block
5. If you need to call multiple tools, output multiple <tool_use> blocks sequentially
6. JSON arguments MUST be valid JSON format

EXAMPLE with multiple tools:
<tool_use>
  <name>default_api:read_file</name>
  <arguments>{"filePath":"/path/to/file"}</arguments>
</tool_use>
<tool_use>
  <name>default_api:list_dir</name>
  <arguments>{"target_directory":"/path/to/dir"}</arguments>
</tool_use>

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`,
  toolCallFormat: 'xml',
  priority: 0,
}
