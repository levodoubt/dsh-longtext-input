/**
 * dsh-longtext-input — Client half (web GUI).
 *
 * Adds a compact "长文本" control to the composer tool row, beside the built-in
 * command and attach buttons (`conversation.input.left`), and a frame-wide
 * editor overlay (`shell.overlay`).
 *
 * Why two slots and a module-scoped island:
 * - The button belongs in the composer tool row, where the shipped controls
 *   live; that slot is a `list`, so a fresh `id` is added beside them and
 *   nothing shipped is replaced.
 * - The editor must cover the whole frame, so it registers in the root-scoped
 *   `shell.overlay` rather than inside the composer's own overflow box.
 * - The selected session's `inputActions`/`sessionId` arrive only through the
 *   composer slot's standard props, while `shell.overlay` is root-scoped and
 *   receives none. One small module-scoped store carries the request between the
 *   two entries.
 *
 * This file is a pre-built client bundle, not an ES module: DSH serves it at
 * /plugins/dsh-longtext-input/client.js and the page evaluates it through
 * `window.__ModuleLoader__`, whose factory body is CommonJS-style (no JSX, no
 * TypeScript).
 */
window.__ModuleLoader__.load({
  // Must be the PACKAGE name, not this plugin's cordis row id. The boot graph
  // keys every client row by package name and rejects a bundle that registers
  // under anything else. The row id (`longtext-input`, in cordis.patch.yml) is a
  // separate namespace and must not appear here.
  id: 'dsh-longtext-input',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Directory the host half writes into, relative to the workspace root. */
    const FOLDER = '.dsh-longtext'
    /** Route registered by this package's host half. */
    const SAVE_URL = '/longtext-input/save'
    /** Slot ids; both are fresh, so neither shadows a shipped entry. */
    const BUTTON_ID = 'longtext-input-button'
    const OVERLAY_ID = 'longtext-input-overlay'
    /** Guard against a runaway paste; the host enforces the same ceiling. */
    const MAX_CHARS = 2_000_000

    /**
     * One open editor request.
     *
     * `inputActions` and `sessionId` are captured from the session-scoped
     * composer slot at click time; the overlay is root-scoped and cannot read
     * them itself.
     *
     * The draft is deliberately NOT captured here. Reading it once at click time
     * proved unreliable — a read that came back empty made the save take the
     * "composer was empty" branch and wipe text the user had typed. The composer
     * entry mirrors the live draft into {@link liveDraft} instead, and the save
     * path reads it at injection time.
     *
     * @type {{sessionId: string, inputActions: unknown, readDraft: (() => string | null)} | null}
     */
    let island = null
    /**
     * Live mirror of the current composer draft.
     *
     * Kept up to date by the composer entry's `useInput` subscription, so the
     * save path never depends on a value captured earlier. `null` means no
     * composer entry has mounted yet, which is distinct from an empty draft.
     *
     * @type {string | null}
     */
    let liveDraft = null
    const listeners = new Set()

    /** Notify every mounted entry that shared state changed. */
    function notify() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[longtext-input] subscriber failed', error)
        }
      }
    }

    /**
     * Subscribe to shared-state changes.
     *
     * @param {() => void} listener - re-render callback.
     * @returns {() => void} unsubscribe.
     */
    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /** Close the editor and forget the captured session handles. */
    function closeIsland() {
      island = null
      notify()
    }

    /**
     * Surface a message the user cannot otherwise see.
     *
     * A successful save is deliberately silent — the `@` reference appearing in
     * the composer is the feedback. This is only for the residual case where the
     * file was written but the reference could not be injected, so the path has
     * to reach the user some other way.
     *
     * @param {string} text - message to display.
     */
    function alertUser(text) {
      try {
        if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(text)
      } catch {
        /* alert unavailable; the file is still on disk */
      }
    }

    /**
     * Read the current draft as plain text.
     *
     * Reads exactly one scalar leaf off the live input snapshot; never
     * enumerates or copies the snapshot itself.
     *
     * @param {unknown} useInput - the slot's `useInput` standard hook.
     * @returns {string | null} the current draft, or null when it cannot be read.
     */
    function readDraft(useInput) {
      if (typeof useInput !== 'function') return null
      try {
        // A throwing selector must not take the editor down with it.
        const value = useInput((state) => state?.draft)
        return typeof value === 'string' ? value : null
      } catch {
        return null
      }
    }

    /**
     * Append the `@` reference to the composer draft, preserving what was there.
     *
     * `setDraft` replaces the entire draft, so the whole next draft is composed
     * here. The current text comes from {@link liveDraft} — mirrored from the
     * composer's own subscription — never from a value captured when the editor
     * opened, which is what previously wiped the user's text.
     *
     * `@` is injected as literal projected text — DSH's `setDraft` renders plain
     * paragraphs rather than reference chips — which is the requested shape.
     *
     * @param {unknown} inputActions - captured action face.
     * @param {string} relativePath - workspace-relative path to reference.
     * @param {(() => string | null) | undefined} readDraftNow - fresh draft reader.
     * @returns {'appended' | 'replaced' | 'failed'} what actually happened.
     */
    function injectReference(inputActions, relativePath, readDraftNow) {
      const setDraft = inputActions?.setDraft
      if (typeof setDraft !== 'function') return 'failed'
      const reference = `@${relativePath} `
      try {
        let current = liveDraft
        if (typeof readDraftNow === 'function') {
          const fresh = readDraftNow()
          if (typeof fresh === 'string') current = fresh
        }
        if (current === null || current.trim() === '') {
          setDraft(reference)
          return 'replaced'
        }
        setDraft(`${current.replace(/\s+$/, '')}\n${reference}`)
        return 'appended'
      } catch (error) {
        console.error('[longtext-input] 注入引用失败', error)
        return 'failed'
      }
    }

    /**
     * Persist one long-text body, then inject the `@` reference into the composer.
     *
     * Extracted from the editor component so the whole save path — request,
     * error mapping, draft-preserving injection — is exercised by tests without
     * rendering React.
     *
     * @param {{
     *   sessionId: string,
     *   title: string,
     *   content: string,
     *   inputActions: unknown,
     *   readDraft: (() => string | null) | undefined,
     * }} input - one save request.
     * @returns {Promise<{ok: true} | {ok: false, error: string}>} outcome.
     */
    async function performLongTextSave(input) {
      let response
      let payload
      try {
        response = await fetch(SAVE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: input.sessionId,
            title: input.title,
            content: input.content,
          }),
        })
        payload = await response.json()
      } catch (failure) {
        return { ok: false, error: `请求失败: ${failure instanceof Error ? failure.message : String(failure)}` }
      }

      if (!response.ok || payload?.ok !== true) {
        return {
          ok: false,
          error: typeof payload?.error === 'string' ? payload.error : `保存失败（HTTP ${response.status}）`,
        }
      }

      const result = injectReference(input.inputActions, String(payload.path), input.readDraft)
      if (result === 'failed') {
        // The file is safely on disk but the reference could not be added, and
        // the editor is about to close. The injected reference is normally the
        // only confirmation, so this case has to speak up.
        alertUser(`已保存 ${payload.name}，但引用注入失败，请手动粘贴：@${payload.path}`)
      }
      return { ok: true }
    }

    /**
     * The composer-row trigger.
     *
     * @param {Record<string, unknown>} props - `conversation.input.left` standard props.
     * @returns {unknown} the React element.
     */
    function LongTextButton(props) {
      const inputActions = props.inputActions
      const sessionId = props.sessionId
      const useInput = props.useInput

      // Mirror the composer draft on every render and on every draft change. No
      // effect lag: `useInput` returns the current store value during render, so
      // the mirror is fresh by the time any click handler runs.
      const mirrored = readDraft(useInput)
      const mirrorRef = React.useRef(mirrored)
      mirrorRef.current = mirrored
      if (mirrored !== null) liveDraft = mirrored

      const readDraftAtSave = React.useCallback(() => {
        // Prefer a fresh read from the live hook; fall back to the render mirror.
        return readDraft(useInput) ?? mirrorRef.current
      }, [useInput])

      const open = React.useCallback(() => {
        island = {
          sessionId: typeof sessionId === 'string' ? sessionId : '',
          inputActions,
          readDraft: readDraftAtSave,
        }
        notify()
      }, [inputActions, sessionId, readDraftAtSave])

      const button = React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-longtext-btn',
          onClick: open,
          title: '长文本输入：写入工作区文件，并把引用加入输入框',
          'aria-label': '长文本输入',
        },
        React.createElement(
          'svg',
          {
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          React.createElement('path', {
            d: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7',
          }),
          React.createElement('path', {
            d: 'M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
          }),
        ),
        React.createElement('span', null, '长文本'),
      )

      return button
    }

    /**
     * The frame-wide editor overlay.
     *
     * @returns {unknown} the React element, or null while closed.
     */
    function LongTextEditor() {
      const [, setTick] = React.useState(0)
      const [title, setTitle] = React.useState('')
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const textareaRef = React.useRef(null)
      /** The island this editor instance is currently presenting. */
      const openRef = React.useRef(null)

      React.useEffect(
        () =>
          subscribe(() => {
            // Reset the form only on a genuine open, so a re-render caused by an
            // unrelated shared-state change cannot discard what the user is typing.
            if (island !== null && openRef.current !== island) {
              openRef.current = island
              setTitle('')
              setText('')
              setError('')
              setBusy(false)
            }
            if (island === null) openRef.current = null
            setTick((value) => value + 1)
          }),
        [],
      )

      const isOpen = island !== null

      React.useEffect(() => {
        if (!isOpen) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeIsland()
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [isOpen])

      React.useEffect(() => {
        if (!isOpen) return
        const node = textareaRef.current
        if (node !== null) node.focus()
      }, [isOpen])

      if (!isOpen) return null

      const session = island

      /**
       * Persist the body through the host half, then inject the reference.
       *
       * @returns {Promise<void>} resolves once the editor has decided its next state.
       */
      const save = async () => {
        const body = text
        if (body.trim() === '') {
          setError('正文不能为空')
          return
        }
        if (body.length > MAX_CHARS) {
          setError(`正文过长（${body.length} 字），上限 ${MAX_CHARS} 字`)
          return
        }
        setBusy(true)
        setError('')
        try {
          const outcome = await performLongTextSave({
            sessionId: session.sessionId,
            title,
            content: body,
            inputActions: session.inputActions,
            readDraft: session.readDraft,
          })
          if (!outcome.ok) {
            // The user's text is still only in this box, so stay open and keep it.
            setError(outcome.error)
            return
          }
          // Success is deliberately silent: the `@` reference now sitting in the
          // composer is the confirmation.
          closeIsland()
        } finally {
          setBusy(false)
        }
      }

      const cancel = () => {
        if (text.trim() !== '') {
          const confirmed =
            typeof window.confirm === 'function' ? window.confirm('放弃编辑？当前内容尚未保存') : true
          if (!confirmed) return
        }
        closeIsland()
      }

      const onEditorKeyDown = (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !busy) {
          event.preventDefault()
          void save()
        }
      }

      return React.createElement(
        'div',
        {
          className: 'dsh-longtext-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) cancel()
          },
        },
        React.createElement(
          'div',
          {
            className: 'dsh-longtext-panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '长文本输入',
            onMouseDown: (event) => event.stopPropagation(),
          },
          React.createElement(
            'div',
            { className: 'dsh-longtext-head' },
            React.createElement('span', { className: 'dsh-longtext-title' }, '长文本输入'),
            React.createElement(
              'span',
              { className: 'dsh-longtext-hint' },
              `保存到 ${FOLDER}/ · Ctrl/⌘+Enter 保存`,
            ),
          ),
          React.createElement('input', {
            className: 'dsh-longtext-name',
            value: title,
            placeholder: '标题（可选，将出现在文件名中）',
            maxLength: 120,
            disabled: busy,
            onChange: (event) => setTitle(event.target.value),
            onKeyDown: onEditorKeyDown,
          }),
          React.createElement('textarea', {
            ref: textareaRef,
            className: 'dsh-longtext-body',
            value: text,
            placeholder: '在此粘贴或输入长文本内容…',
            disabled: busy,
            spellCheck: false,
            onChange: (event) => setText(event.target.value),
            onKeyDown: onEditorKeyDown,
          }),
          React.createElement(
            'div',
            { className: 'dsh-longtext-foot' },
            React.createElement('span', { className: 'dsh-longtext-count' }, `${text.length} 字`),
            React.createElement(
              'div',
              { className: 'dsh-longtext-actions' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-longtext-btn-flat',
                  disabled: busy,
                  onClick: cancel,
                },
                '取消',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsh-longtext-btn-primary',
                  disabled: busy || text.trim() === '',
                  onClick: () => {
                    void save()
                  },
                },
                busy ? '保存中…' : '保存并加入输入框',
              ),
            ),
          ),
          error === '' ? null : React.createElement('div', { className: 'dsh-longtext-error' }, error),
        ),
      )
    }

    /**
     * Stylesheet for both entries.
     *
     * The wallpaper block at the end adapts this overlay to the optional
     * `dsh-plugin-wallpaper-engine` frosted-glass look. It is deliberately
     * self-contained and entirely conditional:
     *
     * - Its selectors are scoped to `body[data-we-wallpaper]`, the stable
     *   attribute that plugin puts on `<body>` while a wallpaper is active, so
     *   with the plugin absent or the wallpaper off nothing here matches.
     * - It reuses that plugin's own custom properties (`--we-blur`,
     *   `--we-saturate`, `--we-glass-alpha`, …). Those are declared on `<body>`,
     *   so they inherit into this overlay wherever it is portalled, and it keeps
     *   following the 玻璃 / 玻璃透明度 sliders with no coordination. Every
     *   `var()` carries a fallback, so the rules still render sensibly if a
     *   variable ever disappears.
     * - Glass has to be an element selector: `backdrop-filter` cannot be
     *   expressed as a design token, and DSH ships no glass token. The plugin
     *   itself hits the same wall and solves it the same way — see its
     *   `[data-composer-card]` rule and its `dsh-better-sidebar` adaptation.
     */
    const CSS = `
.dsh-longtext-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;border-radius:6px;font-size:12px;line-height:1;white-space:nowrap;font-family:inherit}
.dsh-longtext-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.dsh-longtext-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:1px}
.dsh-longtext-btn svg{width:13px;height:13px;flex-shrink:0}
.dsh-longtext-backdrop{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:24px}
.dsh-longtext-panel{display:flex;flex-direction:column;gap:10px;width:min(760px,100%);max-height:calc(100vh - 64px);box-sizing:border-box;padding:16px;border-radius:12px;background:var(--dsw-alias-bg-overlay,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 12px 48px rgba(0,0,0,.28);border:1px solid var(--dsw-alias-border-l2,#e5e5e5)}
.dsh-longtext-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dsh-longtext-title{font-size:15px;font-weight:600}
.dsh-longtext-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#999)}
.dsh-longtext-name{box-sizing:border-box;width:100%;padding:7px 10px;font-size:13px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-family:inherit}
.dsh-longtext-body{box-sizing:border-box;width:100%;flex:1 1 auto;min-height:320px;resize:vertical;padding:10px;font-size:14px;line-height:1.7;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-family:inherit}
.dsh-longtext-name:focus,.dsh-longtext-body:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4f7cff)}
.dsh-longtext-foot{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsh-longtext-count{font-size:12px;color:var(--dsw-alias-label-secondary,#999)}
.dsh-longtext-actions{display:flex;gap:8px}
.dsh-longtext-btn-flat,.dsh-longtext-btn-primary{height:30px;padding:0 14px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,inherit);font-family:inherit}
.dsh-longtext-btn-flat:hover:not(:disabled),
.dsh-longtext-btn-primary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
/* Save and cancel share one look: a brand-filled button turns into white-on-white
   over the frosted panel, so the primary action is distinguished by weight alone. */
.dsh-longtext-btn-primary{font-weight:500}
.dsh-longtext-btn-primary:disabled,.dsh-longtext-btn-flat:disabled{opacity:.5;cursor:not-allowed}
.dsh-longtext-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d4380d);word-break:break-all}

/* ── Wallpaper Engine frosted glass (see the CSS doc comment above) ───────────
   Same liquid-glass recipe the wallpaper plugin applies to the composer card:
   a faint top-weighted specular sheen, a backdrop blur that reads the plugin's
   own --we-* knobs, and a thick-glass inner highlight. Only the panel is
   blurred — the backdrop keeps its own, much lighter scrim, because a modal
   backdrop should not dim the frame as hard as the plugin's app-level scrim. */
body[data-we-wallpaper] .dsh-longtext-backdrop{background:rgba(0,0,0,calc(0.25 + var(--we-border-alpha,0.35) * 0.6))}
body[data-we-wallpaper][data-ds-dark-theme] .dsh-longtext-backdrop{background:rgba(0,0,0,calc(0.35 + var(--we-border-alpha,0.35) * 0.6))}
body[data-we-wallpaper] .dsh-longtext-panel{
  background-color:color-mix(in srgb,var(--we-glass-color,#fff) calc(var(--we-glass-alpha,.12) * 1.15 * 100%),transparent);
  background-image:linear-gradient(180deg,rgba(255,255,255,.16),rgba(255,255,255,.05) 38%,rgba(255,255,255,.02));
  -webkit-backdrop-filter:blur(var(--we-blur,16px)) saturate(var(--we-saturate,1.8)) brightness(var(--we-glass-brightness,1.04)) contrast(1.01);
  backdrop-filter:blur(var(--we-blur,16px)) saturate(var(--we-saturate,1.8)) brightness(var(--we-glass-brightness,1.04)) contrast(1.01);
  border-color:rgba(255,255,255,.22);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,var(--we-glass-highlight,.32)),
    inset 0 -1px 0 rgba(255,255,255,.08),
    inset 0 0 0 0.5px rgba(255,255,255,.08),
    0 12px 40px rgba(0,0,0,var(--we-glass-shadow,.12));
}
/* A frosted panel needs a faint tint under its fields, or the inputs vanish into
   the glass. The non-glass rules below still supply the opaque default. */
body[data-we-wallpaper] .dsh-longtext-name,
body[data-we-wallpaper] .dsh-longtext-body{
  background:rgba(255,255,255,.1);
  border-color:rgba(255,255,255,.24);
}
/* Keep the focus ring: the tint rule above also matched the :focus state, so the
   brand border has to be restated or focusing a field would show no change. */
body[data-we-wallpaper] .dsh-longtext-name:focus,
body[data-we-wallpaper] .dsh-longtext-body:focus{border-color:var(--dsw-alias-brand-primary,#4f7cff)}
/* Both dialog buttons need an explicit tint over glass. Inheriting the color would
   pick up the panel's label token — white in dark mode, i.e. white text on a
   translucent plate. The field rules below must NOT use that shorthand, or they
   silently strip the input border as well. */
body[data-we-wallpaper] .dsh-longtext-btn-flat,
body[data-we-wallpaper] .dsh-longtext-btn-primary{
  background:rgba(255,255,255,.1);
  border-color:rgba(255,255,255,.28);
  color:var(--dsw-alias-label-primary,#111);
}
/* No backdrop-filter support: fall back to the plugin's own policy — a
   near-opaque tinted plate so the text stays readable, with the tint kept. */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  body[data-we-wallpaper] .dsh-longtext-panel{background-color:color-mix(in srgb,var(--we-glass-color,#fff) 92%,transparent)}
}
`

    /**
     * Mount both entries.
     *
     * @param {import('@deepseek-ai/cordis').Context} ctx - client root context.
     */
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      // Styles are injected directly: `styles` is a dynamic-package builtin, not
      // a client Service, so it is not available to a mounted client plugin.
      // `ctx.effect` owns the removal, so the tag dies with this fiber.
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.dshLongtext = '1'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          island = null
          liveDraft = null
          tag.remove()
        }
      }, 'longtext-input: styles')

      slots.inject('conversation.input.left', () =>
        slots.register({ name: 'conversation.input.left', id: BUTTON_ID, order: 10 }, LongTextButton),
      )

      slots.inject('shell.overlay', () =>
        slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: 60 }, LongTextEditor),
      )
    }

    exports.name = 'longtext-input'
    exports.inject = ['slots']
    exports.apply = apply
    // Test seam only: lets the offline check suite drive the save path without
    // rendering React. Not part of the plugin's public surface; the cordis
    // loader reads `apply`/`name`/`inject` and ignores this.
    exports.__internals = {
      performLongTextSave,
      injectReference,
      setLiveDraft: (value) => {
        liveDraft = typeof value === 'string' ? value : null
      },
      reset: () => {
        island = null
        liveDraft = null
      },
    }
    return module.exports
  },
})
