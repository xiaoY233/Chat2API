import type { ToolCallingPlan } from './types.ts'

export type ToolStreamValidationFailure = {
  message: string
  type: 'tool_call_parse_error'
  param: 'tool_calls'
  code: 'malformed_tool_call' | 'missing_tool_call'
}

export function getToolStreamValidationFailure(input: {
  plan?: ToolCallingPlan
  emittedToolCall: boolean
  pendingToolProtocol: boolean
}): ToolStreamValidationFailure | undefined {
  const { plan, emittedToolCall, pendingToolProtocol } = input
  if (!plan?.shouldParseResponse || emittedToolCall) return undefined

  const requiresToolCall = plan.toolChoiceMode === 'required' || plan.toolChoiceMode === 'forced'
  // `auto` means that a tool call is optional.  A model can start emitting the
  // managed marker and then finish with an incomplete block (for example when
  // it changes its mind during a reasoning turn).  The non-stream path treats
  // that as ordinary assistant text; failing the stream with a 502 here makes
  // the two protocol paths disagree and turns a recoverable answer into a
  // client-visible transport error.  Only an explicit required/forced choice
  // makes a malformed or missing block a protocol failure.
  if (!requiresToolCall) return undefined

  if (pendingToolProtocol) {
    return {
      message: 'Provider returned a malformed or empty tool call block for an enforced tool call',
      type: 'tool_call_parse_error',
      param: 'tool_calls',
      code: 'malformed_tool_call',
    }
  }

  return {
    message: 'Provider did not return the required tool call',
    type: 'tool_call_parse_error',
    param: 'tool_calls',
    code: 'missing_tool_call',
  }
}
