import { readFile } from 'node:fs/promises'
import assert from 'node:assert'
import { setApp } from '@adonisjs/core/services/app'

const pkgUrl = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(await readFile(pkgUrl, 'utf-8'))

/**
 * The services/main entry is a singleton that resolves the audit service from
 * the Adonis container at import time. Outside an Adonis application the app
 * service is undefined, so we inject a minimal mock that lets the module load
 * and exposes the expected surface.
 */
setApp({
  booted: async (callback) => {
    await callback()
  },
  container: {
    make(binding) {
      if (binding === 'audit') {
        return { log() {} }
      }
      throw new Error(`Unexpected container binding: ${binding}`)
    },
  },
})

const shapeChecks = {
  '.': (mod) => {
    assert.strictEqual(typeof mod.configure, 'function')
    assert.strictEqual(typeof mod.defineConfig, 'function')
    assert.strictEqual(typeof mod.stores, 'object')
  },
  './types': () => {
    // Types-only module: the runtime file exists but exports nothing.
  },
  './auditable': (mod) => {
    assert.strictEqual(typeof mod.Auditable, 'function')
  },
  './audit_provider': (mod) => {
    assert.strictEqual(typeof mod.default, 'function')
  },
  './services/main': (mod) => {
    assert.ok(mod.default, 'expected a default export')
    assert.strictEqual(typeof mod.default.log, 'function')
  },
  './stores': (mod) => {
    assert.strictEqual(typeof mod.defineConfig, 'function')
    assert.strictEqual(typeof mod.stores, 'object')
  },
  './commands': (mod) => {
    assert.strictEqual(typeof mod.getCommand, 'function')
    assert.strictEqual(typeof mod.getMetaData, 'function')
  },
  './audit_context_middleware': (mod) => {
    assert.strictEqual(typeof mod.default, 'function')
  },
  './models/audit': (mod) => {
    assert.strictEqual(typeof mod.default, 'function')
  },
}

let passed = 0
let failed = 0
const entries = Object.entries(pkg.exports)

for (const [subpath, target] of entries) {
  const targetUrl = new URL(target, pkgUrl)
  try {
    const mod = await import(targetUrl.href)
    const check = shapeChecks[subpath]
    if (check) {
      check(mod)
    }
    console.log(`✓ ${subpath} -> ${target}`)
    passed++
  } catch (err) {
    failed++
    console.error(`✗ ${subpath} -> ${target}: ${err.message}`)
  }
}

console.log(`\n${passed} / ${entries.length} exports verified`)

if (failed > 0) {
  process.exit(1)
}
