import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const configScript = fs.readFileSync(
  'scripts/windows/new-chat2api-native-config.ps1',
  'utf8',
)
const supervisorScript = fs.readFileSync(
  'scripts/windows/chat2api-native-supervisor.ps1',
  'utf8',
)
const nativeDocs = fs.readFileSync('docs/windows-native-services.md', 'utf8')

test('native deployment keeps the proxy endpoint and dependency graph generic', () => {
  assert.match(configScript, /\[string\]\$Chat2ApiHost\s*=\s*'127\.0\.0\.1'/)
  assert.match(configScript, /\[string\]\$LiteLlmHost\s*=\s*'127\.0\.0\.1'/)
  assert.match(configScript, /\[int\]\$Chat2ApiPort\s*=\s*18080/)
  assert.match(configScript, /\[int\]\$LiteLlmPort\s*=\s*4000/)
  assert.match(configScript, /CHAT2API_BASE_URL['\"]\]\s*=\s*"\$chatBaseUrl\/v1"/)
  assert.match(configScript, /CHAT2API_HEALTH_URL['\"]\]\s*=\s*\$chatHealthUrl/)
  assert.match(configScript, /DependsOn\s*=\s*@\('chat2api'\)/)
  assert.match(configScript, /DependencyHealthUrls\s*=\s*@\(\$chatHealthUrl\)/)
  assert.match(configScript, /SchemaVersion\s*=\s*2/)
})

test('native supervisor validates dependencies before starting downstream services', () => {
  assert.match(supervisorScript, /function Validate-ServiceGraph/)
  assert.match(
    supervisorScript,
    /\[System\.Collections\.Hashtable\]::new\(\[System\.StringComparer\]::OrdinalIgnoreCase\)/g,
  )
  assert.match(supervisorScript, /unknown dependency/)
  assert.match(supervisorScript, /must appear after its dependency/)
  assert.match(supervisorScript, /function Test-ServiceDependencies/)
  assert.match(supervisorScript, /Dependencies for \{0\} are not healthy; delaying startup\./)
  assert.match(supervisorScript, /SchemaVersion -notin \@\(1, 2\)/)
  assert.match(supervisorScript, /\$ServiceMap\[\[string\]\$dependencyName\]/)
  assert.match(supervisorScript, /\$serviceIndexes\[\$dependency\]/)
  assert.match(supervisorScript, /Stop-ManagedService -Service \$Service -Reason 'a required dependency is unavailable' \| Out-Null/)
  assert.match(supervisorScript, /Stop-ManagedService -Service \$Service -Reason 'its health check remained unhealthy' \| Out-Null/)
  assert.match(nativeDocs, /generated schema records a named `chat2api` dependency/)
  assert.match(nativeDocs, /Docker Compose deployment uses Chat2API port `8080`/)
})

test('native supervisor treats mixed-case dependency names as the same service identifier', () => {
  // Keep this contract test source-level: importing the supervisor would
  // start processes and require a Windows-only DPAPI configuration. Exercise
  // the same comparer contract with a local JavaScript map as a smoke check.
  const services = new Map([
    ['chat2api', { name: 'chat2api' }],
    ['litellm', { name: 'litellm', dependsOn: ['CHAT2API'] }],
  ])
  const dependencyName = services.get('litellm').dependsOn[0]
  assert.equal(
    [...services.keys()].find((name) => name.toLowerCase() === dependencyName.toLowerCase()),
    'chat2api',
  )

  const mapConstructors = supervisorScript.match(
    /\[System\.Collections\.Hashtable\]::new\(\[System\.StringComparer\]::OrdinalIgnoreCase\)/g,
  ) || []
  assert.equal(mapConstructors.length, 2)
  assert.match(supervisorScript, /if \(\$serviceMap\.ContainsKey\(\$name\)\)/)
  assert.match(supervisorScript, /if \(-not \$serviceMap\.ContainsKey\(\$dependency\)\)/)
})
