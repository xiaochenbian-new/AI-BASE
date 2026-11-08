/**
 * DeepSeek Harness email plugin.
 *
 * Registers three model-facing tools:
 *   - email_send    send a message (text / HTML / attachments) through SMTP
 *   - email_verify  connect + authenticate without sending
 *   - email_status  show the resolved configuration with the password masked
 *
 * Also serves a browser settings page at `/dsh-email-plugin/settings` on the
 * DSH host web server, so the account can be configured without editing JSON.
 *
 * Credentials are read from $DSH_HOME/email-plugin.json (or DSH_EMAIL_* env
 * vars, or this plugin row's `config`) on every call, so they never travel
 * through the model prompt and can be rotated without a restart.
 */
import { readFile } from 'node:fs/promises'
import { configPath, describeConfig, loadConfig, normalizeAddress, requireAccount } from './config.js'
import { buildMessage } from './mime.js'
import { createSettingsHandlers, SAVE_PATH, SETTINGS_PATH, STATUS_PATH, TEST_PATH, VERIFY_PATH } from './settings.js'
import { sendMail, verifySmtp } from './smtp.js'

export const name = 'email'
export const inject = ['tools']

/** Split an address list on commas/semicolons that are outside quotes and angle brackets. */
function splitAddressString(text) {
  const parts = []
  let current = ''
  let inQuotes = false
  let inAngle = false
  for (const character of text) {
    if (character === '"') inQuotes = !inQuotes
    else if (character === '<' && !inQuotes) inAngle = true
    else if (character === '>' && !inQuotes) inAngle = false
    if ((character === ',' || character === ';') && !inQuotes && !inAngle) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

function parseAddressList(input, label) {
  if (input === undefined || input === null) return []
  const text = String(input).trim()
  if (text === '') return []
  return splitAddressString(text).map(part => {
    const address = normalizeAddress(part)
    if (address === undefined) throw new Error(`无法解析${label}地址: "${part}"`)
    return address
  })
}

async function readAttachments(paths) {
  const attachments = []
  for (const path of paths ?? []) {
    const trimmed = String(path).trim()
    if (trimmed === '') continue
    try {
      attachments.push({ path: trimmed, content: await readFile(trimmed) })
    } catch (error) {
      throw new Error(`无法读取附件 "${trimmed}": ${error.code === 'ENOENT' ? '文件不存在' : error.message}`)
    }
  }
  return attachments
}

function wrapFailure(prefix, error) {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${prefix}: ${message}`)
}

const sendParameters = {
  type: 'object',
  properties: {
    to: {
      type: 'string',
      description: 'Recipient address(es). Commas or semicolons separate multiple addresses. Falls back to the configured default recipient when omitted.',
    },
    subject: { type: 'string', description: 'Subject line (UTF-8 is fine).' },
    text: { type: 'string', description: 'Plain-text body. Omit when only `html` is provided.' },
    html: { type: 'string', description: 'Optional HTML body. When present, the message becomes multipart/alternative.' },
    cc: { type: 'string', description: 'Optional CC address list.' },
    bcc: { type: 'string', description: 'Optional BCC address list (envelope only, not written to headers).' },
    attachments: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional absolute file paths to attach.',
    },
  },
  required: ['subject'],
}

const sendOutput = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    messageId: { type: 'string' },
    accepted: { type: 'array', items: { type: 'string' } },
    rejected: { type: 'array', items: { type: 'string' } },
    response: { type: 'string' },
  },
  required: ['ok', 'messageId', 'accepted', 'rejected', 'response'],
}

const verifyOutput = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    server: { type: 'string' },
    greeting: { type: 'string' },
    auth: { type: 'string' },
  },
  required: ['ok', 'server', 'greeting', 'auth'],
}

const statusOutput = {
  type: 'object',
  properties: {
    configured: { type: 'boolean' },
    summary: { type: 'string' },
    configFile: { type: 'string' },
    hint: { type: 'string' },
    settingsUrl: { type: 'string' },
  },
  required: ['configured', 'summary', 'configFile', 'hint', 'settingsUrl'],
}

/** Build the model-facing registry entry for `email_send`. */
function sendTool(rowConfig) {
  return {
    name: 'email_send',
    description:
      'Send an email through the configured SMTP account (defaults to QQ Mail). Use it when the user asks to send mail, forward results, or email a file. ' +
      'Credentials come from the plugin configuration, never from arguments. Supports plain text, HTML, CC/BCC and file attachments.',
    parameters: sendParameters,
    output: {
      schema: sendOutput,
      render: (_args, value) => {
        const rejected = value.rejected.length === 0 ? '' : `\n被拒绝: ${value.rejected.join(', ')}`
        return [
          {
            type: 'text',
            text: `邮件已发送\nMessage-ID: ${value.messageId}\n收件人: ${value.accepted.join(', ')}${rejected}\n服务器响应: ${value.response}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const config = requireAccount(loadConfig(rowConfig))
      const to = parseAddressList(args.to ?? config.defaultTo, '收件人')
      if (to.length === 0) throw new Error('缺少收件人：请在 `to` 中给出邮箱地址，或在配置中设置 defaultTo。')
      const cc = parseAddressList(args.cc, '抄送')
      const bcc = parseAddressList(args.bcc, '密送')
      const attachments = await readAttachments(args.attachments)
      const message = buildMessage({
        from: config.from,
        to,
        cc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        attachments,
      })
      try {
        const delivery = await sendMail({
          smtp: config.smtp,
          from: config.from,
          to,
          cc,
          bcc,
          message,
          timeoutMs: config.timeoutMs,
          allowInvalidCert: config.allowInvalidCert,
          signal: exec?.signal,
        })
        return {
          ok: true,
          messageId: delivery.messageId,
          accepted: delivery.accepted,
          rejected: delivery.rejected.map(item => `${item.address}: ${item.reason}`),
          response: delivery.response,
        }
      } catch (error) {
        throw wrapFailure('发送邮件失败', error)
      }
    },
  }
}

/** Build the model-facing registry entry for `email_verify`. */
function verifyTool(rowConfig) {
  return {
    name: 'email_verify',
    description:
      'Check the configured SMTP account without sending mail: connect, authenticate, and report the server greeting. Use it to diagnose delivery problems.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: verifyOutput,
      render: (_args, value) => [
        { type: 'text', text: `SMTP 连接成功\n服务器: ${value.server}\n认证: ${value.auth}\n问候: ${value.greeting}` },
      ],
    },
    async execute(_args, exec) {
      const config = requireAccount(loadConfig(rowConfig))
      try {
        const result = await verifySmtp({
          smtp: config.smtp,
          timeoutMs: config.timeoutMs,
          allowInvalidCert: config.allowInvalidCert,
          signal: exec?.signal,
        })
        return { ok: true, server: result.server, greeting: result.greeting, auth: result.auth }
      } catch (error) {
        throw wrapFailure('SMTP 连接失败', error)
      }
    },
  }
}

/** Build the model-facing registry entry for `email_status`. */
function statusTool(rowConfig, settingsUrlOf) {
  return {
    name: 'email_status',
    description:
      'Show the resolved email configuration (password masked), the credential file path, the browser settings page URL, and setup instructions.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: statusOutput,
      render: (_args, value) => [
        { type: 'text', text: `${value.summary}\n设置页: ${value.settingsUrl === '' ? '(当前环境没有 Web 服务)' : value.settingsUrl}` },
      ],
    },
    async execute() {
      const config = loadConfig(rowConfig)
      const configured = config.smtp.user !== undefined && config.smtp.pass !== undefined && config.from !== undefined
      return {
        configured,
        summary: describeConfig(config),
        configFile: configPath(),
        hint: configured
          ? '配置已就绪，可以直接使用 email_send 发信。'
          : '打开设置页填写邮箱地址和 SMTP 授权码，或把账号写入配置文件。',
        settingsUrl: settingsUrlOf(),
      }
    },
  }
}

/**
 * Cordis entry point.
 * @param ctx - plugin context; `tools` is injected before `apply` runs.
 * @param config - this plugin row's `config` object, if the profile sets one.
 */
export function apply(ctx, config) {
  const rowConfig = config !== null && typeof config === 'object' ? config : {}

  /** Resolves the browser origin of the running host, when a web server exists. */
  let webOrigin = () => ''
  const settingsUrlOf = () => {
    const origin = webOrigin()
    return origin === '' ? '' : `${origin}${SETTINGS_PATH}`
  }

  ctx.tools.register(sendTool(rowConfig))
  ctx.tools.register(verifyTool(rowConfig))
  ctx.tools.register(statusTool(rowConfig, settingsUrlOf))

  // Optional web surface: profiles without a web server (headless, SDK) still load the tools.
  ctx.inject(['webServer'], sub => {
    webOrigin = () => {
      try {
        const origin = sub.webServer.getOrigin()
        return typeof origin === 'string' ? origin.replace(/\/+$/, '') : ''
      } catch {
        return ''
      }
    }
    const handlers = createSettingsHandlers({ rowConfig, getOrigin: webOrigin })
    const register = (path, handler) =>
      sub.effect(() => sub.webServer.register({ kind: 'exact', path, handler }), `dsh-email-plugin: ${path}`)
    register(SETTINGS_PATH, handlers.page)
    register(STATUS_PATH, handlers.status)
    register(SAVE_PATH, handlers.save)
    register(VERIFY_PATH, handlers.verify)
    register(TEST_PATH, handlers.test)
    if (process.env.DSH_EMAIL_DEBUG === '1') {
      console.error(`[dsh-email-plugin] settings page: ${settingsUrlOf() || SETTINGS_PATH}`)
    }
  })

  if (process.env.DSH_EMAIL_DEBUG === '1') {
    console.error('[dsh-email-plugin] registered tools: email_send, email_verify, email_status')
  }
}
