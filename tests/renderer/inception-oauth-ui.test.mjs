import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

for (const dialog of ['AddAccountDialog.tsx', 'AddProviderDialog.tsx']) {
  test(`${dialog} exposes Inception OAuth login and maps the clearance cookie`, () => {
    const source = readFileSync(
      join(root, 'src/renderer/src/components/providers', dialog),
      'utf8',
    )

    assert.match(source, /supportsOAuth[^\n]*inception/)
    assert.match(source, /if \(providerId === 'inception'\)/)
    assert.match(source, /credentials\.cookie \|\| credentials\.cookieJar/)
    assert.match(source, /result\['_vcrcs'\] = vcrcs/)
  })
}

test('Inception provider card, model list, and login guide wire the icon and steps', () => {
  const card = readFileSync(
    join(root, 'src/renderer/src/components/providers/ProviderCard.tsx'),
    'utf8',
  )
  const modelList = readFileSync(
    join(root, 'src/renderer/src/components/models/ModelList.tsx'),
    'utf8',
  )
  const guide = readFileSync(
    join(root, 'src/renderer/src/components/providers/LoginGuideDialog.tsx'),
    'utf8',
  )

  assert.match(card, /inception: inceptionIcon/)
  assert.match(modelList, /inception: inceptionIcon/)
  assert.match(guide, /inception: \{[\s\S]*?loginUrl: 'https:\/\/chat\.inceptionlabs\.ai\/'/)
  assert.match(guide, /Cookies → chat\.inceptionlabs\.ai/)
  assert.match(guide, /_vcrcs/)
})

test('Inception i18n entries exist in both locales', () => {
  const en = JSON.parse(
    readFileSync(join(root, 'src/renderer/src/i18n/locales/en-US.json'), 'utf8'),
  )
  const zh = JSON.parse(
    readFileSync(join(root, 'src/renderer/src/i18n/locales/zh-CN.json'), 'utf8'),
  )
  assert.equal(en.inception.name, 'Inception (Mercury)')
  assert.ok(en.inception.vcrcs)
  assert.ok(en.inception.vcrcsHelp)
  assert.ok(zh.inception.name)
  assert.ok(zh.inception.vcrcs)
  assert.ok(zh.inception.vcrcsHelp)
})