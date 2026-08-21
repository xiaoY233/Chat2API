export interface NativeToolCallFragment {
  key: string
  id?: string
  index?: number
  name?: string
  arguments?: string
}

export interface NativeToolCallState {
  key: string
  id: string
  index: number
  name: string
  arguments: string
  allowed: boolean
}

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stableStringify(value: unknown): string {
  if (typeof value === 'string') {
    return normalizeNativeArgumentsString(value)
  }

  return JSON.stringify(normalizeNativeArgumentsValue(value ?? {}))
}

function normalizeNativeArgumentsString(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value

  try {
    const parsed = JSON.parse(trimmed)
    return JSON.stringify(normalizeNativeArgumentsValue(parsed))
  } catch {
    return value
  }
}

function normalizeNativeArgumentsValue(value: unknown, keyName?: string): unknown {
  if (typeof value === 'string') {
    return decodeWrappedParameterValue(value, keyName)
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeNativeArgumentsValue(item))
  }

  if (isObjectValue(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        normalizeNativeArgumentsValue(item, key),
      ]),
    )
  }

  return value
}

function decodeWrappedParameterValue(value: string, keyName?: string): string {
  if (!keyName) return value

  const match = value.match(
    /^\s*<\s*[|｜]([^|｜<>\s]+)[|｜]parameter\s+name=(["'])([^"']+)\2\s*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/\s*[|｜]\1[|｜]parameter\s*>\s*(?:\]\]>)?\s*$/i,
  )
  if (!match) return value

  return match[3] === keyName ? match[4] : value
}

export function normalizeNativeFunctionCallDelta(delta: Record<string, any>): NativeToolCallFragment[] {
  const fragments: NativeToolCallFragment[] = []

  const addFragment = (raw: any, fallbackIndex: number) => {
    if (!isObjectValue(raw)) return

    const rawFunction = isObjectValue(raw.function)
      ? raw.function
      : raw
    const name = typeof rawFunction.name === 'string' ? rawFunction.name : undefined
    const args = rawFunction.arguments !== undefined
      ? stableStringify(rawFunction.arguments)
      : undefined
    const id = typeof raw.id === 'string' ? raw.id : undefined
    const rawIndex = typeof raw.index === 'number' ? raw.index : fallbackIndex
    const key = id || String(rawIndex)

    if (name || args !== undefined || id) {
      fragments.push({
        key,
        id,
        index: rawIndex,
        name,
        arguments: args,
      })
    }
  }

  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach(addFragment)
  }

  if (isObjectValue(delta.function_call)) {
    addFragment(delta.function_call, fragments.length)
  }

  return fragments
}

export function mergeNativeToolArguments(previous: string, fragment?: string): string {
  if (fragment === undefined) return previous
  if (!previous) return fragment
  if (fragment === previous) return previous
  if (fragment.startsWith(previous)) return fragment
  if (previous.startsWith(fragment)) return previous
  if (isCompleteJsonText(fragment)) return fragment
  return previous + fragment
}

export function mergeNativeToolName(
  previous: string,
  fragment: string | undefined,
  allowedToolNames: ReadonlySet<string>,
): string {
  if (!fragment) return previous

  const repeatedDeclaredName = [...allowedToolNames].find(name =>
    name.length > 0
    && fragment.length > name.length
    && fragment.length % name.length === 0
    && fragment === name.repeat(fragment.length / name.length),
  )
  const normalizedFragment = repeatedDeclaredName ?? fragment
  if (!previous || normalizedFragment === previous) return normalizedFragment

  // Qwen may alternate between cumulative snapshots and token deltas. Prefer a
  // candidate declared by the client, then a candidate that can still grow
  // into one. This keeps the reconciliation protocol-based and tool-agnostic.
  const snapshotLooksCumulative = normalizedFragment.startsWith(previous)
  const candidates = snapshotLooksCumulative
    ? [normalizedFragment, previous + normalizedFragment]
    : [previous + normalizedFragment, normalizedFragment]
  const exact = candidates.find(candidate => allowedToolNames.has(candidate))
  if (exact) return exact

  const viablePrefix = candidates.find(candidate =>
    [...allowedToolNames].some(name => name.startsWith(candidate)),
  )
  if (viablePrefix) return viablePrefix

  // Some Qwen streams repeat an already-complete name in their cumulative
  // field (name -> namename -> namenamename). Preserve the declared name so a
  // provider framing defect cannot turn it into a different downstream tool.
  if (
    allowedToolNames.has(previous)
    && normalizedFragment.length > previous.length
    && normalizedFragment.length % previous.length === 0
    && normalizedFragment === previous.repeat(normalizedFragment.length / previous.length)
  ) {
    return previous
  }

  return normalizedFragment
}

export function isCompleteJsonText(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false

  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}
