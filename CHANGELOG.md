# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-12

First stable release.

### Added

- **Composer toolbar button.** A compact "长文本 / Long text" control registered in
  `conversation.input.left`, sitting beside the shipped command and attach buttons.
  It is a purely additive slot entry owning its own id, so nothing shipped is replaced.
- **Editor overlay.** A frame-wide dialog registered in `shell.overlay` with an
  optional title field, a large body field with a character count, `Ctrl`/`⌘`+`Enter`
  to save, `Esc` to cancel, and a discard confirmation when the body is non-empty.
- **Host-side persistence.** `POST /longtext-input/save` validates the session and
  body, then writes `<session cwd>/.dsh-longtext/<YYYYMMDDHHmmss>[_<title>].md` and
  answers with the workspace-relative path. The working directory comes from the
  Session header, and the file name is generated server-side, so no client input ever
  reaches the path as a segment.
- **`@` reference injection.** On save the reference is appended to the composer draft
  on its own line, preserving whatever was already there.
- **Wallpaper Engine frosted-glass adaptation.** With `dsh-plugin-wallpaper-engine`
  installed and a wallpaper active, the overlay takes on the same liquid-glass
  appearance as the composer and follows that plugin's glass sliders live. Pure CSS,
  scoped to `body[data-we-wallpaper]`, reusing that plugin's own `--we-*` custom
  properties; nothing matches when the plugin is absent.
- **Offline check suite** (`node scripts/check.mjs`), 27 checks: export shapes, the
  module-loader registration contract, slot registration, route behaviour including a
  real write to a temp directory, file-name rules, draft-preservation semantics,
  button contrast, and the cross-plugin variable contract.

### Design notes

- **Zero build, zero runtime dependencies.** Both halves are hand-written plain
  JavaScript; `lib/client.js` is a pre-built `window.__ModuleLoader__.load({id, factory})`
  bundle whose `id` must be the package name.
- **The `@` reference is literal text, not a reference chip.** DSH's `setDraft()`
  rebuilds the editor as plain-text paragraphs; fabricating a chip would require a
  `source` registered in the product-internal input trigger registry.
- **A successful save shows no notice.** The `@` reference appearing in the composer
  is the feedback.
- **The draft is never pre-filled, cleared, or overwritten.** Draft text is read from
  a continuous mirror of `useInput` and re-read at save time rather than captured when
  the editor opened.

### Known limitations

- The model does not read the saved body automatically; an `@path` is a path
  reference, not inlined content. Ask the model to read the file if it does not.
- The frosted glass applies only while the wallpaper plugin has a wallpaper active.

[1.0.0]: https://github.com/levodoubt/dsh-longtext-input/releases/tag/v1.0.0
