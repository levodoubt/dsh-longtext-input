/**
 * dsh-longtext-input — Host half.
 *
 * Owns exactly one thing: a `POST /longtext-input/save` route that writes the
 * editor's body into `<session cwd>/.dsh-longtext/<YYYYMMDDHHmmss>[_<title>].md`
 * and answers with the workspace-relative path the browser half injects as an
 * `@` reference.
 *
 * The browser cannot do this itself: the composer is sandboxed to the page and
 * has no filesystem access, so persistence lives here.
 *
 * Design notes:
 * - The working directory comes from the Session header (`session.header.cwd`),
 *   not from a path guessed by the client, so a Workspace switch cannot make the
 *   plugin write into the wrong tree.
 * - The file name is generated on this side. The client only supplies a title,
 *   which is sanitized; no client input ever reaches the path as a segment.
 * - Writes go through `node:fs/promises` deliberately: `fs.writeText` refuses to
 *   create a missing parent directory, and `.dsh-longtext/` will not exist on
 *   first use.
 */

/** Directory created inside the session working directory. */
const FOLDER = '.dsh-longtext'
/** Route path; the browser half posts to this exact pathname. */
const ROUTE = '/longtext-input/save'
/** Largest accepted body, guarding against an accidental multi-hundred-MB paste. */
const MAX_CONTENT_BYTES = 8 * 1024 * 1024
/** Longest title accepted, before the file-name sanitizer trims it further. */
const MAX_TITLE_CHARS = 120

/**
 * Sanitize a user title into a safe file-name fragment.
 *
 * Strips both separator styles (a POSIX host would otherwise keep a Windows
 * path verbatim), removes characters Windows forbids, collapses whitespace, and
 * caps the length. Mirrors the intent of the original QwenPaw plugin's
 * `safeTitle`, extended to cover the separator and control-character cases DSH's
 * own `fileLeafName` handles.
 *
 * @param {unknown} value - raw title from the request body.
 * @returns {string} a safe fragment, or an empty string when nothing usable remains.
 */
function safeTitle(value) {
  if (typeof value !== 'string') return ''
  return value
    .slice(0, MAX_TITLE_CHARS)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 60)
}

/**
 * Render a local-time `YYYYMMDDHHmmss` stamp.
 *
 * Local, not UTC, because the file name is for the human reading their own
 * workspace.
 *
 * @param {Date} date - the instant to stamp.
 * @returns {string} 14 digits.
 */
function stamp(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

/**
 * Read and parse a JSON request body with a hard byte cap.
 *
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {Promise<Record<string, unknown>>} the parsed object body.
 * @throws {Error} when the body is too large, malformed, or not a JSON object.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_CONTENT_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('请求体必须是 JSON 对象'))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - HTTP status code.
 * @param {Record<string, unknown>} payload - JSON-serializable body.
 */
function respond(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Handle one save request end to end.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @param {import('node:http').ServerResponse} res - the response to own.
 */
async function handleSave(ctx, req, res) {
  if (req.method !== 'POST') {
    respond(res, 405, { ok: false, error: '只接受 POST' })
    return
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    respond(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    return
  }

  const content = typeof body.content === 'string' ? body.content : ''
  if (content.trim() === '') {
    respond(res, 400, { ok: false, error: '正文为空' })
    return
  }

  // The client's own session identity decides the destination. An unknown id is
  // refused rather than defaulted, so a stale tab cannot write into a session it
  // is no longer attached to.
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const session = sessionId === '' ? undefined : ctx.sessions.get(sessionId)
  if (session === undefined) {
    respond(res, 400, { ok: false, error: '找不到对应会话，请刷新页面后重试' })
    return
  }

  const cwd = session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    respond(res, 400, { ok: false, error: '当前会话没有工作目录，无法写入' })
    return
  }

  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')

  const directory = join(cwd, FOLDER)
  const title = safeTitle(body.title)
  const name = `${stamp(new Date())}${title === '' ? '' : `_${title}`}.md`
  const absolute = join(directory, name)

  try {
    await mkdir(directory, { recursive: true })
    await writeFile(absolute, content, 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`[longtext-input] 写入失败: ${error instanceof Error ? error.message : String(error)}`)
    respond(res, 500, { ok: false, error: `写入失败: ${error instanceof Error ? error.message : String(error)}` })
    return
  }

  // A workspace-relative path is what the model can actually open, and what the
  // composer shows. Forward slashes keep it usable on every platform.
  const relative = `${FOLDER}/${name}`
  ctx.logger?.info?.(`[longtext-input] 已保存 ${absolute}`)
  respond(res, 200, {
    ok: true,
    name,
    path: relative,
    absolute,
    bytes: Buffer.byteLength(content, 'utf8'),
    chars: content.length,
  })
}

/**
 * Mount the Host half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer', 'sessions'], (scope) => {
    scope.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          await handleSave(scope, req, res)
        } catch (error) {
          // The handler owns the full response lifecycle, so an unexpected
          // failure still has to answer rather than leave the socket hanging.
          try {
            respond(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          } catch {
            /* response already sent */
          }
        }
      },
    })
  })
}

export const name = 'longtext-input'
/** Services this fiber waits for before `apply` runs. */
export const inject = ['webServer', 'sessions']
