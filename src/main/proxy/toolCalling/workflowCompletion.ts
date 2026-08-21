import type { ToolCallingPlan } from './types.ts'

export const MANAGED_WORKFLOW_COMPLETE_MARKER = '<chat2api_workflow_complete/>'
const MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS = [
  MANAGED_WORKFLOW_COMPLETE_MARKER,
  '<chat2api_workflow_complete>',
] as const

type ManagedWorkflowCompletionPlan = Pick<
  ToolCallingPlan,
  | 'shouldParseResponse'
  | 'protocol'
  | 'allowedToolNames'
  | 'workflowContinuation'
  | 'failedToolResultPending'
>

export interface ManagedWorkflowCompletionProof {
  complete: boolean
  content: string
}

export function parseManagedWorkflowCompletionProof(
  content: string,
  plan?: ManagedWorkflowCompletionPlan,
): ManagedWorkflowCompletionProof {
  if (!supportsManagedWorkflowCompletionMarker(plan)) {
    return { complete: false, content }
  }

  const trimmed = content.trimEnd()
  const marker = MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS.find(candidate => (
    trimmed.endsWith(candidate)
  ))
  if (!marker) {
    return { complete: false, content }
  }

  const markerStart = trimmed.length - marker.length
  const prefix = trimmed.slice(0, markerStart)
  if (
    MANAGED_WORKFLOW_COMPLETE_MARKER_VARIANTS.some(candidate => prefix.includes(candidate))
    || isInsideOpenCodeFence(trimmed, markerStart)
    || isQuotedOrCodeLine(trimmed, markerStart)
  ) {
    return { complete: false, content }
  }

  return {
    complete: true,
    content: prefix.trimEnd(),
  }
}

export function hasManagedWorkflowCompletionMarker(
  content: string,
  plan?: ManagedWorkflowCompletionPlan,
): boolean {
  return parseManagedWorkflowCompletionProof(content, plan).complete
}

export function stripManagedWorkflowCompletionMarker(
  content: string,
  plan?: ManagedWorkflowCompletionPlan,
): string {
  return parseManagedWorkflowCompletionProof(content, plan).content
}

export function requiresManagedWorkflowCompletionMarker(plan?: ManagedWorkflowCompletionPlan): boolean {
  return Boolean(
    supportsManagedWorkflowCompletionMarker(plan)
    // A matched tool-result batch, including an error result, opens a normal
    // assistant turn. In auto mode the model may call another tool or explain
    // why the operation could not complete; ordinary terminal text is valid
    // in either case. The private marker is needed only on the initial turn,
    // where it distinguishes a final answer from a progress announcement.
    && !plan?.workflowContinuation
  )
}

/**
 * The marker belongs to the managed protocol even when this branch does not
 * require the model to emit it. Keeping capability separate lets us strip an
 * optional marker without turning it into client-visible protocol text.
 */
export function supportsManagedWorkflowCompletionMarker(
  plan?: ManagedWorkflowCompletionPlan,
): boolean {
  return Boolean(
    plan?.shouldParseResponse
    && plan.protocol === 'qwen_hermes'
    && plan.allowedToolNames.size > 0
  )
}

function isInsideOpenCodeFence(content: string, index: number): boolean {
  let openFence: { character: '`' | '~'; length: number } | undefined
  const linesBeforeMarker = content.slice(0, index).split('\n')

  for (const line of linesBeforeMarker) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue

    const sequence = match[1]
    const character = sequence[0] as '`' | '~'
    if (!openFence) {
      openFence = { character, length: sequence.length }
      continue
    }

    if (
      character === openFence.character
      && sequence.length >= openFence.length
      && match[2].trim() === ''
    ) {
      openFence = undefined
    }
  }

  return Boolean(openFence)
}

function isQuotedOrCodeLine(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1
  const linePrefix = content.slice(lineStart, index)
  if (/^\s*>/.test(linePrefix) || /^(?: {4}|\t)/.test(linePrefix)) return true
  const singleBackticks = linePrefix.replace(/```/g, '').match(/`/g)?.length ?? 0
  return singleBackticks % 2 === 1
}
