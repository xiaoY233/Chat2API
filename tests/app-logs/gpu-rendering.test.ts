import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseSoftwareRendering } from '../../src/main/window/gpu.ts'

test('hardware rendering stays on for desktop platforms', () => {
  assert.equal(shouldUseSoftwareRendering({ platform: 'darwin', env: {} }), false)
  assert.equal(shouldUseSoftwareRendering({ platform: 'win32', env: {} }), false)
})

test('linux without a display server uses software rendering', () => {
  assert.equal(
    shouldUseSoftwareRendering({ platform: 'linux', env: {}, driDeviceExists: true }),
    true,
  )
})

test('linux with a display but no DRI node uses software rendering', () => {
  assert.equal(
    shouldUseSoftwareRendering({ platform: 'linux', env: { DISPLAY: ':99' }, driDeviceExists: false }),
    true,
  )
})

test('linux with a display and a DRI render node keeps hardware rendering', () => {
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      driDeviceExists: true,
    }),
    false,
  )
})

test('a card node without a render node still uses software rendering', () => {
  // Android/proot exposes /dev/dri/card0 but no /dev/dri/renderD*, so ANGLE
  // cannot create a context and logs glxQueryExtensionsString errors.
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      driDeviceExists: false,
    }),
    true,
  )
})

test('proot and termux environments always use software rendering', () => {
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { DISPLAY: ':0', PROOT_L2S_DIR: '/data/data/com.termux/var/lib/l2s' },
      driDeviceExists: true,
    }),
    true,
  )
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { DISPLAY: ':0', TERMUX_EXEC__PROC_SELF_EXE: '/data/data/com.termux/files/usr/bin/proot' },
      driDeviceExists: true,
    }),
    true,
  )
})

test('wayland counts as a display server', () => {
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      driDeviceExists: true,
    }),
    false,
  )
})

test('the environment override wins over detection', () => {
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'darwin',
      env: { CHAT2API_DISABLE_GPU: '1' },
    }),
    true,
  )
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { CHAT2API_DISABLE_GPU: '0' },
      driDeviceExists: false,
    }),
    false,
  )
})
