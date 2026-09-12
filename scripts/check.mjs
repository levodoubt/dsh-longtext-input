/**
 * Offline checks for the dsh-longtext-input halves.
 *
 * Not shipped with the plugin; run with `node scripts/check.mjs` from the
 * package root. Verifies:
 *  1. the host half parses and exports the expected cordis plugin shape;
 *  2. the client half parses, registers through the module-loader contract, and
 *     exports a plugin whose `apply` mounts both slots against a stub context;
 *  3. the host half's file-name rules produce the documented names.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let failures = 0
/**
 * Run one named check.
 *
 * @param {string} label - check name.
 * @param {() => void | Promise<void>} body - assertions.
 */
async function check(label, body) {
  try {
    await body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('dsh-longtext-input checks')

// ── Host half ───────────────────────────────────────────────────────────────
const hostSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const host = await import(new URL('../lib/index.js', import.meta.url))

await check('host half exports name/apply', () => {
  assert.equal(host.name, 'longtext-input')
  assert.equal(typeof host.apply, 'function')
})

await check('host half registers one prefix route on webServer', () => {
  const routes = []
  const ctx = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer', 'sessions'])
      callback({ webServer: { register: (route) => routes.push(route) }, sessions: { get: () => undefined } })
    },
    logger: { info() {}, warn() {} },
  }
  host.apply(ctx)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/longtext-input/save')
  assert.equal(typeof routes[0].handler, 'function')
})

await check('host half refuses a non-POST request', async () => {
  const routes = []
  host.apply({
    inject: (deps, callback) =>
      callback({ webServer: { register: (route) => routes.push(route) }, sessions: { get: () => undefined } }),
    logger: { info() {}, warn() {} },
  })
  let status = 0
  let body = ''
  const req = { method: 'GET', on() {}, destroy() {} }
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      body = text
    },
  }
  await routes[0].handler(req, res)
  assert.equal(status, 405)
  assert.equal(JSON.parse(body).ok, false)
})

await check('host half writes the file and answers the workspace-relative path', async () => {
  const routes = []
  const sessionId = 'sess-test'
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-longtext-'))
  host.apply({
    inject: (deps, callback) =>
      callback({
        webServer: { register: (route) => routes.push(route) },
        sessions: { get: (id) => (id === sessionId ? { header: { cwd } } : undefined) },
      }),
    logger: { info() {}, warn() {} },
  })

  let status = 0
  let body = ''
  const payload = JSON.stringify({ sessionId, title: '会议/记录 2026', content: '# 标题\n\n正文\n' })
  const req = {
    method: 'POST',
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(payload, 'utf8'))
      if (event === 'end') listener()
      return this
    },
    destroy() {},
  }
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      body = text
    },
  }

  await routes[0].handler(req, res)
  // The real response lifecycle ends on a later microtask; a macrotask hop is
  // enough to observe it without racing the write.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const parsed = JSON.parse(body)
  assert.equal(status, 200)
  assert.equal(parsed.ok, true)
  assert.match(parsed.name, /^\d{14}_会议_记录_2026\.md$/)
  assert.equal(parsed.path, `.dsh-longtext/${parsed.name}`)
  assert.equal(parsed.chars, '# 标题\n\n正文\n'.length)
  assert.equal(readFileSync(parsed.absolute, 'utf8'), '# 标题\n\n正文\n')
  assert.equal(dirname(parsed.absolute), join(cwd, '.dsh-longtext'))
  rmSync(cwd, { recursive: true, force: true })
})

await check('host half refuses an unknown session without writing', async () => {
  const routes = []
  host.apply({
    inject: (deps, callback) =>
      callback({ webServer: { register: (route) => routes.push(route) }, sessions: { get: () => undefined } }),
    logger: { info() {}, warn() {} },
  })
  let status = 0
  let body = ''
  const payload = JSON.stringify({ sessionId: 'gone', title: 't', content: 'x' })
  const req = {
    method: 'POST',
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(payload, 'utf8'))
      if (event === 'end') listener()
      return this
    },
    destroy() {},
  }
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      body = text
    },
  }
  await routes[0].handler(req, res)
  assert.equal(status, 400)
  assert.equal(JSON.parse(body).ok, false)
})

await check('host half rejects an empty body', async () => {
  const routes = []
  host.apply({
    inject: (deps, callback) =>
      callback({ webServer: { register: (route) => routes.push(route) }, sessions: { get: () => undefined } }),
    logger: { info() {}, warn() {} },
  })
  let status = 0
  const payload = JSON.stringify({ sessionId: 's', title: 't', content: '   ' })
  const req = {
    method: 'POST',
    on(event, listener) {
      if (event === 'data') listener(Buffer.from(payload, 'utf8'))
      if (event === 'end') listener()
      return this
    },
    destroy() {},
  }
  const res = { writeHead(code) { status = code }, end() {} }
  await routes[0].handler(req, res)
  assert.equal(status, 400)
})

// ── Client half ─────────────────────────────────────────────────────────────
await check('client half registers through the module loader contract', () => {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const registrations = []
  const globals = globalThis
  const previous = globals.window
  globals.window = {
    ...(previous ?? {}),
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  }
  try {
    // The bundle is a plain script, so evaluating it registers exactly once.
    // eslint-disable-next-line no-new-func
    new Function('require', source)((specifier) => {
      if (specifier === 'react') return createReactStub()
      throw new Error(`unexpected require("${specifier}")`)
    })
  } finally {
    globals.window = previous
  }
  assert.equal(registrations.length, 1, 'expected exactly one __ModuleLoader__.load call')
  assert.equal(typeof registrations[0].factory, 'function')
})

// Regression: the boot graph keys every client row by PACKAGE name and rejects a
// bundle that registers under the cordis row id. Getting this wrong loads the
// host half fine and then fails the whole plugin tree in the browser with
// `bundle … loaded without registering "<pkg>" via __ModuleLoader__.load`.
await check('client registration id is the package name, not the row id', () => {
  const registrations = []
  const globals = globalThis
  const previous = globals.window
  globals.window = {
    ...(previous ?? {}),
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function('require', readFileSync(join(root, 'lib', 'client.js'), 'utf8'))((specifier) => {
      if (specifier === 'react') return createReactStub()
      throw new Error(`unexpected require("${specifier}")`)
    })
  } finally {
    globals.window = previous
  }
  assert.equal(registrations[0].id, packageManifest.name)
  assert.notEqual(registrations[0].id, 'longtext-input')
  // The bundle the loader serves is named from the package, so the two must agree.
  assert.equal(
    packageManifest.exports['./client'].default,
    './lib/client.js',
    'the served ./client export must point at the bundle under test',
  )
})

await check('client plugin mounts both slots against a stub context', () => {
  const plugin = loadClientPlugin()
  assert.equal(plugin.name, 'longtext-input')
  assert.deepEqual(plugin.inject, ['slots'])

  const injected = []
  const registered = []
  const effects = []
  const slots = {
    inject: (key, callback) => {
      injected.push(key)
      callback()
    },
    register: (options) => {
      registered.push(options)
      return () => {}
    },
  }
  const documentStub = {
    head: { appendChild() {} },
    createElement: () => ({ dataset: {}, remove() {}, set textContent(_v) {} }),
    addEventListener() {},
    removeEventListener() {},
  }
  const previousDocument = globalThis.document
  globalThis.document = documentStub
  try {
    plugin.apply({
      get: (name) => (name === 'slots' ? slots : undefined),
      effect: (callback) => {
        effects.push(callback())
      },
    })
  } finally {
    globalThis.document = previousDocument
  }

  assert.deepEqual(injected, ['conversation.input.left', 'shell.overlay'])
  assert.equal(registered.length, 2)
  assert.deepEqual(
    registered.map((entry) => entry.name),
    ['conversation.input.left', 'shell.overlay'],
  )
  assert.equal(new Set(registered.map((entry) => entry.id)).size, 2, 'slot ids must be distinct')
  assert.equal(effects.length, 1)
})

// ── Draft preservation ─────────────────────────────────────────────────────
// Regression: the save path once used a draft captured when the editor OPENED.
// When that read came back empty, the save took the "composer was empty" branch
// and wiped text the user had typed. The save path must read the draft at
// injection time and never treat an unreadable draft as "empty".

/**
 * Run the client save path with a stubbed fetch.
 *
 * @param {{draft: string | null, live: string | null, payload?: object, status?: number}} setup - stub state.
 * @returns {Promise<{outcome: object, setDraftCalls: string[]}>} outcome and injected drafts.
 */
async function runSave(setup) {
  const plugin = loadClientPlugin()
  const internals = plugin.__internals
  internals.reset()
  internals.setLiveDraft(setup.live)

  const setDraftCalls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: (setup.status ?? 200) < 400,
    status: setup.status ?? 200,
    json: async () =>
      setup.payload ?? {
        ok: true,
        name: '20260912154657_长文本结果测试.md',
        path: '.dsh-longtext/20260912154657_长文本结果测试.md',
        chars: 42,
      },
  })
  try {
    const outcome = await internals.performLongTextSave({
      sessionId: 's1',
      title: '长文本结果测试',
      content: 'body',
      inputActions: { setDraft: (text) => setDraftCalls.push(text) },
      readDraft: () => setup.draft,
    })
    return { outcome, setDraftCalls }
  } finally {
    globalThis.fetch = previousFetch
    internals.reset()
  }
}

await check('save preserves an existing composer draft and appends the reference', async () => {
  const { outcome, setDraftCalls } = await runSave({ draft: '我原本输入的内容', live: null })
  assert.equal(outcome.ok, true)
  assert.equal(setDraftCalls.length, 1, 'exactly one setDraft call')
  assert.equal(setDraftCalls[0], '我原本输入的内容\n@.dsh-longtext/20260912154657_长文本结果测试.md ')
})

await check('save with an empty composer inserts only the reference', async () => {
  const { outcome, setDraftCalls } = await runSave({ draft: '', live: '' })
  assert.equal(outcome.ok, true)
  assert.equal(setDraftCalls.length, 1)
  assert.equal(setDraftCalls[0], '@.dsh-longtext/20260912154657_长文本结果测试.md ')
})

await check('save falls back to the render mirror when the live read is unavailable', async () => {
  // `readDraft` returns null (unreadable) — the mirror must win over "empty".
  const { outcome, setDraftCalls } = await runSave({ draft: null, live: '镜像里的内容' })
  assert.equal(outcome.ok, true)
  assert.equal(setDraftCalls[0], '镜像里的内容\n@.dsh-longtext/20260912154657_长文本结果测试.md ')
})

await check('a successful save reports no success notice', async () => {
  // The composer entry must render the bare button: the injected `@` reference
  // is the confirmation, and no green banner belongs beside the trigger.
  const { outcome } = await runSave({ draft: 'keep me', live: null })
  assert.equal(outcome.ok, true)
  assert.deepEqual(Object.keys(outcome), ['ok'], 'a successful outcome carries no message payload')
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /longtext-notice/, 'no notice markup or styles may remain')
  assert.doesNotMatch(source, /showNotice|dismissNotice|noticeTimer/, 'no notice machinery may remain')
})

await check('save drops trailing whitespace instead of stacking blank lines', async () => {
  const { setDraftCalls } = await runSave({ draft: 'abc\n\n  ', live: null })
  assert.equal(setDraftCalls[0], 'abc\n@.dsh-longtext/20260912154657_长文本结果测试.md ')
})

await check('a rejected save keeps the editor open and reports the host error', async () => {
  const { outcome, setDraftCalls } = await runSave({
    draft: 'keep me',
    live: null,
    status: 400,
    payload: { ok: false, error: '找不到对应会话，请刷新页面后重试' },
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error, '找不到对应会话，请刷新页面后重试')
  assert.deepEqual(setDraftCalls, [], 'a failed save must not touch the draft')
})

await check('a network failure keeps the editor open and reports it', async () => {
  const plugin = loadClientPlugin()
  plugin.__internals.reset()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('boom')
  }
  try {
    const outcome = await plugin.__internals.performLongTextSave({
      sessionId: 's1',
      title: '',
      content: 'x',
      inputActions: { setDraft: () => assert.fail('must not write the draft') },
      readDraft: () => 'keep me',
    })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /请求失败: boom/)
  } finally {
    globalThis.fetch = previousFetch
    plugin.__internals.reset()
  }
})

// ── Wallpaper Engine glass coupling ─────────────────────────────────────────
// The overlay reads dsh-plugin-wallpaper-engine's private --we-* custom
// properties. That plugin is optional and may rename them, so pin the contract
// against its real source, and keep the glass scoped so it cannot leak when no
// wallpaper is active.

/**
 * Extract the glass stylesheet block, comments stripped.
 *
 * The block is a run of single-line rules; the doc comment above it is removed
 * so prose mentioning `--we-*` cannot be mistaken for a declaration.
 *
 * @returns {string} the CSS rules of the wallpaper glass adaptation.
 */
function glassCssBlock() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const marker = '/* ── Wallpaper Engine frosted glass'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, 'the glass CSS block must exist')
  const end = source.indexOf('`', start)
  assert.notEqual(end, -1, 'the glass CSS block must be inside the CSS template')
  return source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

/** One CSS rule: a selector list followed by a `{…}` block (non-greedy). */
const RULE_RE = /[^{}]+\{[^{}]*\}/g

/**
 * Every rule of the plugin's own stylesheet, with comments stripped.
 *
 * Scoped to the CSS template — the surrounding JavaScript also contains braces
 * and `className:` strings that a whole-file regex would mistake for rules — and
 * comment-free, because a preceding comment otherwise glues itself to the next
 * selector and defeats `startsWith` matching.
 *
 * @returns {string[]} CSS rules, trimmed.
 */
function stylesheetRules() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const start = source.indexOf('const CSS = `')
  assert.notEqual(start, -1, 'the CSS template must exist')
  const end = source.indexOf('`', start + 'const CSS = `'.length)
  assert.notEqual(end, -1, 'the CSS template must be terminated')
  const css = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  return [...css.matchAll(RULE_RE)].map((match) => match[0].trim())
}

/** Read the installed wallpaper plugin's client source, when present. */
function wallpaperPluginSource() {
  const path = join(
    homedir(),
    '.dsh',
    'profiles',
    'web',
    'node_modules',
    'dsh-plugin-wallpaper-engine',
    'lib',
    'client.js',
  )
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

await check('glass reads the wallpaper plugin\'s blur/saturation/alpha/color knobs', () => {
  const referenced = new Set([...glassCssBlock().matchAll(/var\((--we-[a-z-]+)/g)].map((match) => match[1]))
  // These four are the ones the plugin sets from the user's sliders; if it ever
  // renames them, the glass silently stops following the settings, so pin them.
  for (const name of ['--we-blur', '--we-saturate', '--we-glass-alpha', '--we-glass-color']) {
    assert.ok(referenced.has(name), `glass must read ${name}`)
  }
})

await check('the knobs the plugin sets from its sliders are all defined by it', () => {
  const pluginSource = wallpaperPluginSource()
  if (pluginSource === null) {
    console.log('       note: wallpaper plugin not installed; skipped cross-check')
    return
  }
  const defined = new Set(
    [...pluginSource.matchAll(/setProperty\(\s*"(--we-[a-z-]+)"/g)].map((match) => match[1]),
  )
  for (const match of pluginSource.matchAll(/(--we-[a-z-]+)\s*:/g)) defined.add(match[1])

  // These are set from the user's 玻璃 / 玻璃透明度 sliders. Reading them is the
  // whole point of the adaptation, so they must exist.
  for (const name of ['--we-blur', '--we-saturate', '--we-glass-alpha', '--we-glass-color']) {
    assert.ok(defined.has(name), `${name} must be defined by the wallpaper plugin`)
  }
})

await check('every referenced --we-* knob carries a fallback', () => {
  // A variable the plugin never defines is tolerable ONLY because each use
  // supplies a fallback — the plugin does exactly this for --we-glass-highlight
  // and --we-glass-shadow. A bare `var(--we-x)` would render as nothing.
  const bare = [...glassCssBlock().matchAll(/var\((--we-[a-z-]+)\)/g)].map((match) => match[1])
  assert.deepEqual(bare, [], `these need a fallback: ${bare.join(', ')}`)
})

await check('every glass rule is scoped to the wallpaper attribute', () => {
  const rules = [...glassCssBlock().matchAll(RULE_RE)].map((match) => match[0].trim())
  assert.ok(rules.length >= 3, `expected several glass rules, found ${rules.length}`)
  const offenders = rules.filter(
    (rule) => rule.includes('--we-') && !rule.includes('body[data-we-wallpaper]'),
  )
  assert.deepEqual(offenders, [], `unscoped glass rules: ${offenders.join(' | ')}`)
  assert.ok(
    rules.some((rule) => rule.includes('body[data-we-wallpaper] .dsh-longtext-panel{')),
    'the panel itself must get the glass rule',
  )
  assert.ok(
    rules.some((rule) => rule.includes('backdrop-filter:blur(var(--we-blur')),
    'the panel rule must carry the backdrop blur',
  )
})

await check('the base overlay keeps an opaque fallback when no wallpaper is active', () => {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  // The unconditional rule must stay opaque so the modal is usable with the
  // wallpaper plugin absent entirely.
  assert.match(source, /\.dsh-longtext-panel\{[^}]*background:var\(--dsw-alias-bg-overlay,#fff\)/)
  assert.match(source, /\.dsh-longtext-backdrop\{[^}]*background:rgba\(0,0,0,\.45\)/)
})

await check('the save button shares the cancel button look, not a brand fill', () => {
  const rules = stylesheetRules()
  const shared = rules.find((rule) => rule.startsWith('.dsh-longtext-btn-flat,.dsh-longtext-btn-primary{'))
  assert.ok(shared, 'save and cancel must share one base rule')
  // Dark text on the panel's own surface: a white-on-brand fill is illegible over
  // the frosted panel, which is what the user reported.
  assert.match(shared, /background:var\(--dsw-alias-bg-layer-1/)
  assert.match(shared, /color:var\(--dsw-alias-label-primary/)
  assert.doesNotMatch(shared, /brand-primary/, 'the base rule must not use the brand fill')

  const primary = rules.find((rule) => rule.startsWith('.dsh-longtext-btn-primary{'))
  assert.ok(primary, 'the primary modifier rule must exist')
  assert.doesNotMatch(primary, /background|color:/, 'the modifier must not repaint the button')

  // Hover belongs to both, not only to cancel.
  assert.ok(
    rules.some(
      (rule) =>
        rule.startsWith('.dsh-longtext-btn-flat:hover:not(:disabled)') &&
        rule.includes('.dsh-longtext-btn-primary:hover:not(:disabled)'),
    ),
    'the save button must share the hover treatment',
  )
})

await check('neither dialog button hard-codes the brand fill anywhere', () => {
  const offenders = stylesheetRules().filter(
    (rule) => rule.includes('btn-primary') && /background:\s*(var\(--dsw-alias-brand-primary|#)/.test(rule),
  )
  assert.deepEqual(offenders, [], `brand-filled save button rules: ${offenders.join(' | ')}`)
})

await check('both dialog buttons stay readable over glass', () => {
  const rules = [...glassCssBlock().matchAll(RULE_RE)].map((match) => match[0])
  const buttonRule = rules.find((rule) => rule.includes('.dsh-longtext-btn-primary'))
  assert.ok(buttonRule, 'the save button needs its own glass rule too')
  assert.match(buttonRule, /color:var\(--dsw-alias-label-primary/)
  assert.match(buttonRule, /background:rgba\(255,255,255,/)
  // `color:inherit` would resolve to the panel's label token (white in dark mode).
  assert.doesNotMatch(buttonRule, /color:inherit/)
})

await check('glass field tint does not strip the input border', () => {
  const rules = [...glassCssBlock().matchAll(RULE_RE)].map((match) => match[0])
  const fieldRule = rules.find((rule) => rule.includes('.dsh-longtext-name,'))
  assert.ok(fieldRule, 'the glass field rule must exist')
  // The `background` shorthand resets background-image AND, when paired with the
  // sidebar's `border-color` override, reads as if the border vanished. Use the
  // longhand so the tint cannot clear sibling declarations.
  assert.match(fieldRule, /background:rgba\(255,255,255,/)
  assert.match(fieldRule, /border-color:rgba\(255,255,255,/)
})

// ── File-name rules ────────────────────────────────────────────────────────
await check('file-name rules match the documented format', () => {
  // Mirrors safeTitle/stamp in the host half so a regression in either the
  // sanitizer or the stamp ordering is caught without importing private helpers.
  const sanitize = (value) =>
    value
      .slice(0, 120)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[\\/]/g, '_')
      .replace(/[<>:"|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 60)

  assert.equal(sanitize('会议记录'), '会议记录')
  assert.equal(sanitize('  a  b  '), 'a_b')
  assert.equal(sanitize('a/b\\c:d*e?f'), 'a_b_c_d_e_f')
  assert.equal(sanitize('...'), '')
  assert.equal(sanitize(''), '')
  assert.ok(sanitize('x'.repeat(200)).length <= 60)
})

await check('host source declares the shared constants', () => {
  assert.match(hostSource, /const FOLDER = '\.dsh-longtext'/)
  assert.match(hostSource, /const ROUTE = '\/longtext-input\/save'/)
  assert.match(hostSource, /node:fs\/promises/)
})

/**
 * Minimal React surface, sufficient for module evaluation (render is never called).
 *
 * @returns {Record<string, unknown>} the stub.
 */
function createReactStub() {
  return {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  }
}

/**
 * Evaluate the client bundle and return its plugin export.
 *
 * @returns {Record<string, unknown>} the exported cordis plugin.
 */
function loadClientPlugin() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  const registrations = []
  const globals = globalThis
  const previous = globals.window
  globals.window = {
    ...(previous ?? {}),
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  }
  let result
  try {
    // eslint-disable-next-line no-new-func
    new Function('require', source)((specifier) => {
      if (specifier === 'react') return createReactStub()
      throw new Error(`unexpected require("${specifier}")`)
    })
    result = registrations[0].factory((specifier) => {
      if (specifier === 'react') return createReactStub()
      throw new Error(`unexpected require("${specifier}")`)
    })
  } finally {
    globals.window = previous
  }
  return result
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
