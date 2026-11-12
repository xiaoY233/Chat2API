import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseSoftwareRendering } from '../../src/main/window/gpu.ts'

test('hardware rendering stays on for desktop platforms', () => {
  assert.equal(shouldUseSoftwareRendering({ platform: 'darwin', env: {} }), false)
  assert.equal(shouldUseSoftwareRendering({ platform: 'win32', env: {} }), false)
})

test('linux defaults to software rendering even with a display and render node', () => {
  // A render node does not prove GLX/EGL works: NVIDIA driver mismatches, VMs,
  // remote X and Xwayland can still fail with glxQueryExtensionsString NULL.
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { DISPLAY: ':0' },
    }),
    true,
  )
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
    }),
    true,
  )
})

test('linux without a display server uses software rendering', () => {
  assert.equal(shouldUseSoftwareRendering({ platform: 'linux', env: {} }), true)
})

test('proot and termux environments use software rendering', () => {
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { DISPLAY: ':0', PROOT_L2S_DIR: '/data/data/com.termux/var/lib/l2s' },
    }),
    true,
  )
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { DISPLAY: ':0', TERMUX_EXEC__PROC_SELF_EXE: '/data/data/com.termux/files/usr/bin/proot' },
    }),
    true,
  )
})

test('the environment override wins over the platform default', () => {
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
    }),
    false,
  )
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { CHAT2API_DISABLE_GPU: 'yes' },
    }),
    true,
  )
  assert.equal(
    shouldUseSoftwareRendering({
      platform: 'linux',
      env: { CHAT2API_DISABLE_GPU: 'no' },
    }),
    false,
  )
})
