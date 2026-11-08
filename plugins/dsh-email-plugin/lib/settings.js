/**
 * Browser-facing settings page for the email plugin.
 *
 * Served by the DSH host web server on loopback, so the account can be
 * configured without editing JSON. The page is plain HTML + fetch calls; no
 * build step and no npm dependency.
 *
 * Security model: every handler requires a loopback Host header, and mutating
 * requests additionally require a same-origin (or absent) Origin header, so a
 * cross-site form post from another website is rejected. The stored password is
 * never returned to the page; saving with an empty password keeps the old one.
 */
import { buildMessage } from './mime.js'
import { sendMail, verifySmtp } from './smtp.js'
import {
  configPath,
  loadConfig,
  readRawConfig,
  requireAccount,
  writeRawConfig,
} from './config.js'

export const SETTINGS_PATH = '/dsh-email-plugin/settings'
export const STATUS_PATH = '/dsh-email-plugin/api/status'
export const SAVE_PATH = '/dsh-email-plugin/api/save'
export const VERIFY_PATH = '/dsh-email-plugin/api/verify'
export const TEST_PATH = '/dsh-email-plugin/api/test'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const MAX_BODY_BYTES = 64 * 1024
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return ''
  const value = hostHeader.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end < 0 ? value : value.slice(1, end)
  }
  return value.split(':')[0]
}

/** Loopback-only guard: the page and its API never answer on a public interface. */
function allowed(req) {
  return LOOPBACK_HOSTS.has(hostnameOf(req.headers?.host))
}

/** Same-origin guard for mutations; non-browser clients without Origin are allowed. */
function sameOrigin(req) {
  const originHeader = req.headers?.origin
  if (originHeader === undefined || originHeader === '' || originHeader === 'null') return true
  try {
    return new URL(originHeader).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase()
  } catch {
    return false
  }
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function textOf(value, maxLength = 512) {
  if (value === undefined || value === null) return ''
  return String(value).trim().slice(0, maxLength)
}

/**
 * Validate the settings form and merge it into the stored JSON object.
 * @param draft - form fields from the browser.
 * @param current - the current raw JSON object.
 * @returns the next raw configuration object.
 */
export function draftToConfig(draft, current = {}) {
  const smtp = { ...(current.smtp ?? {}) }

  const host = textOf(draft.host, 255) || 'smtp.qq.com'
  if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new Error('SMTP 服务器地址不正确')
  smtp.host = host

  const port = Number(draft.port === undefined || draft.port === '' ? 465 : draft.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口需要是 1-65535 之间的整数')
  smtp.port = port

  const secure = textOf(draft.secure, 16).toLowerCase() || 'tls'
  if (!['tls', 'starttls', 'plain'].includes(secure)) throw new Error('加密方式只能是 tls / starttls / plain')
  smtp.secure = secure

  const user = textOf(draft.user, 320)
  if (user === '') throw new Error('请填写邮箱地址')
  if (!EMAIL_PATTERN.test(user)) throw new Error('邮箱地址格式不正确')
  smtp.user = user

  const password = typeof draft.pass === 'string' ? draft.pass.trim() : ''
  if (password !== '') smtp.pass = password
  else if (typeof smtp.pass !== 'string' || smtp.pass === '')
    throw new Error('请填写 SMTP 授权码（QQ 邮箱需要在设置里生成授权码，不能用登录密码）')

  const fromAddress = textOf(draft.fromAddress, 320) || user
  if (!EMAIL_PATTERN.test(fromAddress)) throw new Error('发件人地址格式不正确')
  const fromName = textOf(draft.fromName, 200)
  const defaultTo = textOf(draft.defaultTo, 320) || fromAddress
  if (!EMAIL_PATTERN.test(defaultTo)) throw new Error('默认收件人地址格式不正确')

  const timeoutMs = Number(current.timeoutMs)
  return {
    ...current,
    smtp,
    from: fromName === '' ? { address: fromAddress } : { name: fromName, address: fromAddress },
    defaultTo,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
  }
}

/** The JSON status payload the page renders (never includes the password). */
export function statusPayload(config = loadConfig(), extra = {}) {
  return {
    configured: Boolean(config.smtp.user && config.smtp.pass && config.from),
    smtp: {
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user ?? '',
    },
    from: config.from ?? null,
    defaultTo: config.defaultTo ?? '',
    hasPassword: Boolean(config.smtp.pass),
    configFile: configPath(),
    ...extra,
  }
}

function parseRecipients(value, fallback) {
  const source = textOf(value, 2000) || textOf(fallback, 2000)
  if (source === '') throw new Error('请填写收件人地址')
  const list = source
    .split(/[,;]/)
    .map(item => item.trim())
    .filter(item => item !== '')
  for (const address of list) if (!EMAIL_PATTERN.test(address)) throw new Error(`收件人地址格式不正确: ${address}`)
  return list
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>邮件插件设置</title>
<style>
  :root { color-scheme: light dark; --fg:#1f2328; --muted:#6a737d; --bg:#ffffff; --panel:#f6f8fa; --line:#d0d7de; --accent:#0969da; --danger:#cf222e; --ok:#1a7f37; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --muted:#8b949e; --bg:#0d1117; --panel:#161b22; --line:#30363d; --accent:#4493f8; --danger:#f85149; --ok:#3fb950; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  main { max-width: 620px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 24px; color: var(--muted); }
  form { background: var(--panel); border:1px solid var(--line); border-radius: 10px; padding: 20px; }
  label { display:block; margin-bottom:14px; font-weight:600; font-size:13px; }
  input, select { display:block; width:100%; margin-top:6px; padding:8px 10px; font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--line); border-radius:6px; }
  .row { display:flex; gap:12px; }
  .row > label { flex:1; }
  .actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:6px; }
  button { padding:8px 14px; font:inherit; font-weight:600; border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color:#fff; }
  button:disabled { opacity:.6; cursor:progress; }
  .hint { color: var(--muted); font-size:12px; font-weight:400; margin-top:4px; }
  #result { margin-top:20px; padding:12px 14px; border-radius:8px; background:var(--panel); border:1px solid var(--line); white-space:pre-wrap; word-break:break-all; font:12px/1.6 ui-monospace,Consolas,monospace; }
  #result.ok { border-color: var(--ok); }
  #result.bad { border-color: var(--danger); }
  #configFile { margin-top:16px; color:var(--muted); font-size:12px; word-break:break-all; }
</style>
</head>
<body>
<main>
  <h1>邮件插件设置</h1>
  <p class="sub">配置 SMTP 账号，保存后立即生效，不需要重启 DeepSeek Harness。</p>
  <form id="form">
    <label>邮箱地址
      <input id="user" autocomplete="username" placeholder="例如 123456@qq.com">
    </label>
    <label>SMTP 授权码
      <input id="pass" type="password" autocomplete="new-password" placeholder="已保存的授权码不会显示；留空表示不修改">
      <span class="hint">QQ 邮箱：设置 → 账号 → POP3/IMAP/SMTP 服务 → 开启 IMAP/SMTP 后生成授权码。</span>
    </label>
    <label>SMTP 服务器
      <input id="host" placeholder="smtp.qq.com">
    </label>
    <div class="row">
      <label>端口
        <input id="port" inputmode="numeric" placeholder="465">
      </label>
      <label>加密方式
        <select id="secure">
          <option value="tls">SSL/TLS（465，QQ 邮箱用这个）</option>
          <option value="starttls">STARTTLS（587）</option>
          <option value="plain">不加密（仅限本机测试）</option>
        </select>
      </label>
    </div>
    <label>发件人名称
      <input id="fromName" placeholder="可留空">
    </label>
    <label>发件人地址
      <input id="fromAddress" placeholder="默认与邮箱地址相同">
    </label>
    <label>默认收件人
      <input id="defaultTo" placeholder="默认与发件人地址相同">
    </label>
    <label>测试收件人
      <input id="to" placeholder="默认使用上面的默认收件人">
    </label>
    <div class="actions">
      <button type="submit" class="primary" id="save">保存配置</button>
      <button type="button" id="verify">测试连接</button>
      <button type="button" id="test">发送测试邮件</button>
    </div>
  </form>
  <p id="configFile"></p>
  <pre id="result" hidden></pre>
</main>
<script>
(() => {
  const $ = id => document.getElementById(id)
  const fields = ['user','pass','host','port','secure','fromName','fromAddress','defaultTo']
  const draft = () => Object.fromEntries(fields.map(f => [f, $(f).value]))
  const result = $('result')
  function show(value, ok) {
    result.hidden = false
    result.className = ok === true ? 'ok' : ok === false ? 'bad' : ''
    result.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }
  async function call(path, body) {
    const response = await fetch(path, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let value
    try { value = await response.json() } catch { value = { ok: false, error: '服务器返回了非 JSON 内容（HTTP ' + response.status + '）' } }
    return { ok: response.ok && value.ok !== false, value }
  }
  async function load() {
    const { value } = await call('./api/status')
    if (!value || !value.smtp) { show(value); return }
    $('user').value = value.smtp.user || ''
    $('host').value = value.smtp.host || 'smtp.qq.com'
    $('port').value = value.smtp.port || 465
    $('secure').value = value.smtp.secure || 'tls'
    $('fromName').value = value.from && value.from.name ? value.from.name : ''
    $('fromAddress').value = value.from ? value.from.address || '' : ''
    $('defaultTo').value = value.defaultTo || ''
    $('configFile').textContent = '配置文件：' + value.configFile
    if (value.configured) show('已配置：' + value.smtp.user + '（' + value.smtp.host + ':' + value.smtp.port + '）', true)
    else show('尚未配置完整，请填写邮箱地址和 SMTP 授权码后保存。')
  }
  async function run(button, label, path, body, done) {
    button.disabled = true
    show(label + '…')
    try {
      const { ok, value } = await call(path, body)
      show(value, ok)
      if (ok && done) done()
    } catch (error) {
      show(String(error && error.message ? error.message : error), false)
    } finally {
      button.disabled = false
    }
  }
  $('form').addEventListener('submit', event => {
    event.preventDefault()
    run($('save'), '保存中', './api/save', draft(), () => { $('pass').value = ''; load() })
  })
  $('verify').addEventListener('click', () => run($('verify'), '连接测试中', './api/verify', {}))
  $('test').addEventListener('click', () => run($('test'), '发送中', './api/test', { to: $('to').value }))
  load()
})()
</script>
</body>
</html>`

/**
 * Create the HTTP handlers for the settings page and its API.
 * @param options.getOrigin - returns the browser origin of the running host (or undefined).
 * @returns one handler per route.
 */
export function createSettingsHandlers({ rowConfig = {}, getOrigin } = {}) {
  const originOf = () => {
    try {
      const value = getOrigin?.()
      return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
    } catch {
      return ''
    }
  }

  return {
    page(req, res) {
      if (!allowed(req)) return sendText(res, 403, 'forbidden')
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' })
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(PAGE.replace('</body>', `<p id="settingsUrl" hidden>${originOf()}${SETTINGS_PATH}</p></body>`))
    },

    async status(req, res) {
      if (!allowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        sendJson(res, 200, { ok: true, ...statusPayload(loadConfig(rowConfig)), settingsUrl: `${originOf()}${SETTINGS_PATH}` })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
      }
    },

    async save(req, res) {
      if (!allowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const body = await readJsonBody(req)
        const next = draftToConfig(body, readRawConfig())
        writeRawConfig(next)
        sendJson(res, 200, { ok: true, message: '配置已保存', ...statusPayload(loadConfig(rowConfig)) })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
      }
    },

    async verify(req, res) {
      if (!allowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const config = requireAccount(loadConfig(rowConfig))
        const result = await verifySmtp({
          smtp: config.smtp,
          timeoutMs: config.timeoutMs,
          allowInvalidCert: config.allowInvalidCert,
        })
        sendJson(res, 200, { ok: true, message: '连接成功', server: result.server, greeting: result.greeting, auth: result.auth })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
      }
    },

    async test(req, res) {
      if (!allowed(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
      if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      try {
        const config = requireAccount(loadConfig(rowConfig))
        const body = await readJsonBody(req)
        const recipients = parseRecipients(body.to, config.defaultTo)
        const message = buildMessage({
          from: config.from,
          to: recipients.map(address => ({ address })),
          subject: '[DSH 邮件插件] 测试邮件',
          text: `这是一封来自 DeepSeek Harness 邮件插件的测试邮件。\n\n发送时间：${new Date().toLocaleString('zh-CN')}\n账号：${config.smtp.user}\n服务器：${config.smtp.host}:${config.smtp.port} (${config.smtp.secure})`,
        })
        const delivery = await sendMail({
          smtp: config.smtp,
          from: config.from,
          to: recipients.map(address => ({ address })),
          message,
          timeoutMs: config.timeoutMs,
          allowInvalidCert: config.allowInvalidCert,
        })
        sendJson(res, 200, {
          ok: true,
          message: '测试邮件已发送',
          messageId: delivery.messageId,
          accepted: delivery.accepted,
          response: delivery.response,
        })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message })
      }
    },
  }
}
