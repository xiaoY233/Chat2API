import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

for (const dialog of ['AddAccountDialog.tsx', 'AddProviderDialog.tsx']) {
  test(`${dialog} exposes LongCat OAuth login and maps the captured cookie jar`, () => {
    const source = readFileSync(
      join(root, 'src/renderer/src/components/providers', dialog),
      'utf8',
    )

    assert.match(source, /supportsOAuth[^\n]*longcat/)
    assert.match(source, /if \(providerId === 'longcat'\)/)
    assert.match(source, /result\.passport_token_key = passport \|\| cookie/)
    assert.match(source, /result\.cookie = cookie/)
  })
}

test('LongCat login guide points at longcat.ai and mentions OAuth', () => {
  const source = readFileSync(
    join(root, 'src/renderer/src/components/providers/LoginGuideDialog.tsx'),
    'utf8',
  )

  assert.match(source, /longcat: \{[\s\S]*?loginUrl: 'https:\/\/longcat\.ai\/chat'/)
  assert.match(source, /Cookies → longcat\.ai/)
  assert.match(source, /OAuth Login tab/)
})
