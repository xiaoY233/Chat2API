import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

for (const dialog of ['AddAccountDialog.tsx', 'AddProviderDialog.tsx']) {
  test(`${dialog} treats Inception as a no-login provider`, () => {
    const source = readFileSync(
      join(root, 'src/renderer/src/components/providers', dialog),
      'utf8',
    )

    // Inception is anonymous: it must not appear in the OAuth-capable list and
    // must not carry an OAuth credential-mapping branch.
    assert.doesNotMatch(source, /supportsOAuth[^\n]*inception/)
    assert.doesNotMatch(source, /if \(providerId === 'inception'\)/)
  })
}

test('Inception provider card and model list wire the icon', () => {
  const card = readFileSync(
    join(root, 'src/renderer/src/components/providers/ProviderCard.tsx'),
    'utf8',
  )
  const modelList = readFileSync(
    join(root, 'src/renderer/src/components/models/ModelList.tsx'),
    'utf8',
  )

  assert.match(card, /inception: inceptionIcon/)
  assert.match(modelList, /inception: inceptionIcon/)
})

test('Inception has no login guide entry in the dialog', () => {
  const guide = readFileSync(
    join(root, 'src/renderer/src/components/providers/LoginGuideDialog.tsx'),
    'utf8',
  )

  assert.doesNotMatch(guide, /inception: \{/)
  assert.doesNotMatch(guide, /chat\.inceptionlabs\.ai/)
})

test('Inception i18n entries describe a no-login provider in both locales', () => {
  const en = JSON.parse(
    readFileSync(join(root, 'src/renderer/src/i18n/locales/en-US.json'), 'utf8'),
  )
  const zh = JSON.parse(
    readFileSync(join(root, 'src/renderer/src/i18n/locales/zh-CN.json'), 'utf8'),
  )
  assert.equal(en.inception.name, 'Inception (Mercury)')
  assert.match(en.inception.description, /no login/i)
  assert.ok(en.inception.vcrcs)
  assert.ok(en.inception.vcrcsHelp)
  assert.ok(zh.inception.name)
  assert.ok(zh.inception.vcrcs)
  assert.ok(zh.inception.vcrcsHelp)
})