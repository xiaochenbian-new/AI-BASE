/**
 * Minimal SMTP client (implicit TLS, STARTTLS, plain) with AUTH LOGIN/PLAIN.
 * No external dependencies, so the plugin stays installable offline.
 */
import net from 'node:net'
import os from 'node:os'
import tls from 'node:tls'
import { prepareDataPayload } from './mime.js'

const CRLF = '\r\n'

/** SMTP protocol or connection failure. */
export class SmtpError extends Error {
  constructor(message, smtpCode) {
    super(message)
    this.name = 'SmtpError'
    this.smtpCode = smtpCode
  }
}

function socketOptions(smtp, allowInvalidCert) {
  return {
    host: smtp.host,
    port: smtp.port,
    servername: smtp.host,
    rejectUnauthorized: !allowInvalidCert,
    ...(allowInvalidCert ? { checkServerIdentity: () => undefined } : {}),
  }
}

class LineReader {
  constructor(socket) {
    this.socket = socket
    this.buffer = ''
    this.queue = []
    this.waiter = undefined
    this.error = undefined
    this.closed = false
    this.onData = chunk => {
      this.buffer += chunk.toString('utf8')
      this.flush()
    }
    this.onError = error => this.fail(error)
    this.onClose = () => {
      this.closed = true
      if (this.waiter !== undefined) {
        const waiter = this.waiter
        this.waiter = undefined
        waiter.reject(new SmtpError('SMTP 连接已关闭'))
      }
    }
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
    socket.on('end', this.onClose)
  }

  detach() {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    this.socket.off('end', this.onClose)
  }

  fail(error) {
    this.error = error
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.reject(error)
    }
  }

  flush() {
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (this.waiter !== undefined) {
        const waiter = this.waiter
        this.waiter = undefined
        waiter.resolve(line)
      } else {
        this.queue.push(line)
      }
    }
  }

  nextLine() {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift())
    if (this.error !== undefined) return Promise.reject(this.error)
    if (this.closed) return Promise.reject(new SmtpError('SMTP 连接已关闭'))
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }
}

class SmtpClient {
  constructor({ smtp, timeoutMs, allowInvalidCert, signal }) {
    this.smtp = smtp
    this.timeoutMs = timeoutMs
    this.allowInvalidCert = allowInvalidCert
    this.signal = signal
    this.socket = undefined
    this.reader = undefined
    this.onAbort = () => this.close(new Error('已取消'))
  }

  attachSocket(socket) {
    this.socket = socket
    this.reader = new LineReader(socket)
    socket.setTimeout(this.timeoutMs, () => {
      socket.destroy(new SmtpError(`SMTP 连接超时（${this.timeoutMs}ms）`))
    })
    socket.on('error', () => {})
  }

  writeRaw(data) {
    if (this.socket === undefined || this.socket.destroyed) throw new SmtpError('SMTP 连接已断开')
    if (this.signal?.aborted) throw new Error('已取消')
    this.socket.write(data)
  }

  write(line) {
    this.writeRaw(`${line}${CRLF}`)
  }

  async readReply(expected) {
    const lines = []
    for (;;) {
      const line = await this.reader.nextLine()
      lines.push(line)
      if (/^\d{3} /.test(line)) break
      if (!/^\d{3}[- ]/.test(line)) throw new SmtpError(`无法解析 SMTP 响应: ${line}`)
    }
    const last = lines[lines.length - 1]
    const code = Number(last.slice(0, 3))
    const text = lines.map(line => line.slice(4)).join('\n').trim()
    if (expected !== undefined && !expected.includes(code)) {
      throw new SmtpError(`SMTP ${code}: ${text === '' ? '无响应文本' : text}`, code)
    }
    return { code, text, lines }
  }

  async command(line, expected) {
    this.write(line)
    return await this.readReply(expected)
  }

  async connect() {
    if (this.signal?.aborted) throw new Error('已取消')
    if (this.smtp.secure === 'tls') {
      const socket = tls.connect(socketOptions(this.smtp, this.allowInvalidCert))
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve)
        socket.once('error', reject)
      })
      this.attachSocket(socket)
    } else if (this.smtp.secure === 'starttls') {
      const socket = net.connect({ host: this.smtp.host, port: this.smtp.port })
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      this.attachSocket(socket)
    } else {
      const socket = net.connect({ host: this.smtp.host, port: this.smtp.port })
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      this.attachSocket(socket)
    }

    if (this.signal !== undefined) {
      if (this.signal.aborted) this.close(new Error('已取消'))
      else this.signal.addEventListener('abort', this.onAbort, { once: true })
    }

    this.greeting = await this.readReply([220])
    await this.ehlo()

    if (this.smtp.secure === 'starttls') await this.startTls()
    if (this.smtp.user !== undefined && this.smtp.user !== '') await this.login()
  }

  async ehlo() {
    const name = os.hostname().replace(/[^A-Za-z0-9.-]/g, '-') || 'localhost'
    let reply
    try {
      reply = await this.command(`EHLO ${name}`, [250])
    } catch (error) {
      if (error instanceof SmtpError && error.smtpCode === 500) {
        reply = await this.command(`HELO ${name}`, [250])
      } else {
        throw error
      }
    }
    this.capabilities = reply.lines
      .slice(1)
      .map(line => line.slice(4).trim().toUpperCase())
      .filter(line => line !== '')
    return reply
  }

  async startTls() {
    await this.command('STARTTLS', [220])
    this.reader.detach()
    const plain = this.socket
    const secured = tls.connect({
      socket: plain,
      servername: this.smtp.host,
      rejectUnauthorized: !this.allowInvalidCert,
      ...(this.allowInvalidCert ? { checkServerIdentity: () => undefined } : {}),
    })
    await new Promise((resolve, reject) => {
      secured.once('secureConnect', resolve)
      secured.once('error', reject)
    })
    this.attachSocket(secured)
    await this.ehlo()
  }

  async login() {
    this.write('AUTH LOGIN')
    const prompt = await this.readReply()
    if (prompt.code !== 334) {
      if (prompt.code === 504 || prompt.code === 502 || prompt.code === 530) {
        await this.loginPlain()
        return
      }
      throw new SmtpError(`SMTP 服务器不支持 AUTH LOGIN (${prompt.code}): ${prompt.text}`, prompt.code)
    }
    this.write(Buffer.from(this.smtp.user, 'utf8').toString('base64'))
    const userPrompt = await this.readReply([334])
    this.write(Buffer.from(this.smtp.pass ?? '', 'utf8').toString('base64'))
    const ok = await this.readReply([235]).catch(error => {
      if (error instanceof SmtpError && error.smtpCode === 535) {
        throw new SmtpError(
          `SMTP 认证失败 (535)。QQ 邮箱需要「授权码」而不是登录密码：在 QQ 邮箱网页版 → 设置 → 账号 → POP3/IMAP/SMTP 服务中生成。服务器原文: ${error.message}`,
          535,
        )
      }
      throw error
    })
    this.authMethod = 'LOGIN'
    return ok
  }

  async loginPlain() {
    const token = Buffer.from(`\u0000${this.smtp.user}\u0000${this.smtp.pass ?? ''}`, 'utf8').toString('base64')
    const ok = await this.command(`AUTH PLAIN ${token}`, [235]).catch(error => {
      if (error instanceof SmtpError && error.smtpCode === 535) {
        throw new SmtpError(
          `SMTP 认证失败 (535)。QQ 邮箱需要「授权码」而不是登录密码。服务器原文: ${error.message}`,
          535,
        )
      }
      throw error
    })
    this.authMethod = 'PLAIN'
    return ok
  }

  async quit() {
    try {
      await this.command('QUIT', [221])
    } catch {
      // Servers may close the connection right after DATA; not a delivery failure.
    }
    this.close()
  }

  close(reason) {
    if (this.signal !== undefined) this.signal.removeEventListener('abort', this.onAbort)
    if (this.socket !== undefined && !this.socket.destroyed) this.socket.destroy(reason)
  }
}

/**
 * Deliver one already-built message.
 * @param options - delivery parameters.
 * @param options.smtp - normalized SMTP endpoint configuration.
 * @param options.from - sender `{ name?, address }`.
 * @param options.to - recipient `{ name?, address }[]` (non-empty).
 * @param options.cc - optional CC recipients.
 * @param options.bcc - optional BCC recipients (envelope only).
 * @param options.message - `{ raw, messageId }` from `buildMessage`.
 * @param options.timeoutMs - socket timeout.
 * @param options.allowInvalidCert - skip TLS certificate verification.
 * @param options.signal - cooperative cancellation signal.
 * @returns `{ messageId, accepted, rejected, response }`.
 */
export async function sendMail(options) {
  const { smtp, from, to, cc = [], bcc = [], message, timeoutMs, allowInvalidCert, signal } = options
  const client = new SmtpClient({ smtp, timeoutMs, allowInvalidCert, signal })
  const envelope = [...to, ...cc, ...bcc]
  const accepted = []
  const rejected = []
  try {
    await client.connect()
    await client.command(`MAIL FROM:<${from.address}>`, [250])
    for (const recipient of envelope) {
      try {
        await client.command(`RCPT TO:<${recipient.address}>`, [250, 251])
        accepted.push(recipient.address)
      } catch (error) {
        if (!(error instanceof SmtpError)) throw error
        rejected.push({ address: recipient.address, reason: error.message })
      }
    }
    if (accepted.length === 0) {
      throw new SmtpError(
        `所有收件人都被服务器拒绝: ${rejected.map(item => `${item.address} (${item.reason})`).join('; ')}`,
      )
    }
    await client.command('DATA', [354])
    client.writeRaw(`${prepareDataPayload(message.raw)}.${CRLF}`)
    const result = await client.readReply([250])
    await client.quit()
    return { messageId: message.messageId, accepted, rejected, response: result.text }
  } finally {
    client.close()
  }
}

/**
 * Open a connection and authenticate without sending anything.
 * @param options - connection parameters.
 * @returns `{ greeting, server, auth }`.
 */
export async function verifySmtp(options) {
  const { smtp, timeoutMs, allowInvalidCert, signal } = options
  const client = new SmtpClient({ smtp, timeoutMs, allowInvalidCert, signal })
  try {
    await client.connect()
    const result = {
      server: `${smtp.host}:${smtp.port} (${smtp.secure})`,
      greeting: client.greeting?.text ?? '',
      auth: client.authMethod === undefined ? 'anonymous' : client.authMethod,
    }
    await client.quit()
    return result
  } finally {
    client.close()
  }
}
