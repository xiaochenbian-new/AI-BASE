/**
 * Configuration loading for the email plugin.
 *
 * Sources, lowest to highest precedence:
 *   built-in defaults -> $DSH_HOME/email-plugin.json -> DSH_EMAIL_* env vars -> plugin row `config`
 *
 * The tool re-reads configuration on every call, so credentials can be edited in
 * the JSON file without restarting DeepSeek Harness.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Built-in SMTP defaults point at QQ Mail (ssl). */
const DEFAULT_SMTP = { host: 'smtp.qq.com', port: 465, secure: 'tls' }

/** Absolute path of the harness home directory (`~/.dsh` unless DSH_HOME is set). */
export function dshHome() {
  const home = process.env.DSH_HOME
  if (home !== undefined && home.trim() !== '') return home.trim()
  return join(homedir(), '.dsh')
}

/** Absolute path of the JSON credential file. */
export function configPath() {
  return join(dshHome(), 'email-plugin.json')
}

/** Read the raw JSON object of the credential file (empty object when absent). */
export function readRawConfig() {
  return readFileConfig()
}

/**
 * Persist the raw configuration object atomically (temp file + rename).
 * @param value - the complete JSON object to write.
 * @returns the absolute path written.
 */
export function writeRawConfig(value) {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  if (process.platform !== 'win32') chmodSync(temporary, 0o600)
  renameSync(temporary, path)
  return path
}

function normalizeSecure(value) {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value).trim().toLowerCase()
  if (text === 'tls' || text === 'ssl' || text === 'smtps') return 'tls'
  if (text === 'starttls' || text === 'start-tls') return 'starttls'
  if (text === 'plain' || text === 'none' || text === 'insecure') return 'plain'
  throw new Error(`invalid smtp.secure "${value}" (expected tls | starttls | plain)`)
}

function readFileConfig() {
  const path = configPath()
  if (!existsSync(path)) return {}
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('the top level must be a JSON object')
    return parsed
  } catch (error) {
    throw new Error(
      `cannot parse ${path}: ${error.message}. Expected JSON like {"smtp":{"user":"you@qq.com","pass":"SMTP授权码"}}`,
    )
  }
}

function envConfig() {
  const env = process.env
  const smtp = {}
  if (env.DSH_EMAIL_HOST) smtp.host = env.DSH_EMAIL_HOST
  if (env.DSH_EMAIL_PORT) smtp.port = Number(env.DSH_EMAIL_PORT)
  if (env.DSH_EMAIL_SECURE) smtp.secure = normalizeSecure(env.DSH_EMAIL_SECURE)
  if (env.DSH_EMAIL_USER) smtp.user = env.DSH_EMAIL_USER
  if (env.DSH_EMAIL_PASS) smtp.pass = env.DSH_EMAIL_PASS
  const result = { smtp }
  if (env.DSH_EMAIL_FROM) result.from = env.DSH_EMAIL_FROM
  if (env.DSH_EMAIL_TO) result.defaultTo = env.DSH_EMAIL_TO
  return result
}

/** Parse `"Name <a@b>"`, `"a@b"` or `{ name?, address }` into `{ name?, address }`. */
export function normalizeAddress(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'object') {
    const address = String(value.address ?? '').trim()
    if (address === '') return undefined
    const name = value.name === undefined || value.name === null ? undefined : String(value.name).trim()
    return name === undefined || name === '' ? { address } : { name, address }
  }
  const text = String(value).trim()
  const match = /^(.*?)<([^>]+)>\s*$/.exec(text)
  if (match !== null) {
    const name = match[1].trim().replace(/^"(.*)"$/, '$1')
    const address = match[2].trim()
    return name === '' ? { address } : { name, address }
  }
  return { address: text }
}

function mergeSection(base, ...sources) {
  const result = { ...base }
  for (const source of sources) {
    if (source === undefined || source === null || typeof source !== 'object') continue
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) result[key] = value
    }
  }
  return result
}

/**
 * Resolve the effective configuration.
 * @param rowConfig - the `config` object of this plugin's row in the patch layer.
 * @returns a normalized configuration object (not yet validated for sending).
 */
export function loadConfig(rowConfig = {}) {
  const file = readFileConfig()
  const env = envConfig()
  const fromRow = typeof rowConfig.from === 'string' ? normalizeAddress(rowConfig.from) : undefined

  const smtp = mergeSection(DEFAULT_SMTP, file.smtp, env.smtp, rowConfig.smtp)
  smtp.secure = normalizeSecure(smtp.secure) ?? 'tls'
  if (smtp.host !== undefined) smtp.host = String(smtp.host).trim()
  if (smtp.user !== undefined) smtp.user = String(smtp.user).trim()
  if (smtp.pass !== undefined) smtp.pass = String(smtp.pass)
  const port = Number(smtp.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid smtp.port "${smtp.port}" (expected a number between 1 and 65535)`)
  }
  smtp.port = port

  const from =
    normalizeAddress(rowConfig.from) ??
    normalizeAddress(env.from) ??
    normalizeAddress(file.from) ??
    (smtp.user === undefined ? undefined : { address: smtp.user })

  const timeoutMs = Number(rowConfig.timeoutMs ?? file.timeoutMs ?? 15000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive number')

  return {
    smtp,
    from,
    defaultTo: rowConfig.defaultTo ?? env.defaultTo ?? file.defaultTo,
    timeoutMs,
    allowInvalidCert: Boolean(rowConfig.allowInvalidCert ?? file.allowInvalidCert ?? false),
  }
}

/**
 * Throwing guard for operations that need a complete account.
 * @param config - the resolved configuration.
 * @returns the same configuration once proven complete.
 */
export function requireAccount(config) {
  const missing = []
  if (config.smtp.host === undefined || config.smtp.host === '') missing.push('smtp.host')
  if (config.smtp.user === undefined || config.smtp.user === '') missing.push('smtp.user')
  if (config.smtp.pass === undefined || config.smtp.pass === '') missing.push('smtp.pass')
  if (config.from === undefined || config.from.address === '') missing.push('from')
  if (missing.length > 0) {
    throw new Error(
      `邮件账号未配置（缺少 ${missing.join(', ')}）。请在 ${configPath()} 写入 ` +
        `{"smtp":{"host":"smtp.qq.com","port":465,"secure":"tls","user":"你的QQ邮箱","pass":"SMTP授权码"}}，` +
        '或设置 DSH_EMAIL_USER / DSH_EMAIL_PASS 环境变量。QQ 邮箱的授权码在「设置 → 账号 → POP3/IMAP/SMTP 服务」中生成，不是登录密码。',
    )
  }
  return config
}

/** Human-readable account summary with the password masked. */
export function describeConfig(config) {
  const from = config.from === undefined ? '(未设置)' : config.from.address
  const user = config.smtp.user === undefined || config.smtp.user === '' ? '(未设置)' : config.smtp.user
  const pass = config.smtp.pass === undefined || config.smtp.pass === '' ? '(未设置)' : '******'
  return [
    `smtp: ${config.smtp.host}:${config.smtp.port} (${config.smtp.secure})`,
    `user: ${user}`,
    `pass: ${pass}`,
    `from: ${from}`,
    `config file: ${configPath()}`,
  ].join('\n')
}
