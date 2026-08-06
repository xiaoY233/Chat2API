const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..', '..')

test('RequestForwarder dispatches dedicated providers through a registry', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  assert.match(source, /providerForwarders/)
  assert.doesNotMatch(source, /if \(\w+Adapter\.is\w+Provider\(provider\)\)/)
  assert.match(source, /providerForwarders\.find/)
})
