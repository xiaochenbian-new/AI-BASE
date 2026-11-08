import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from '../lib/index.js'
import { buildMessage, prepareDataPayload } from '../lib/mime.js'
import { sendMail, verifySmtp } from '../lib/smtp.js'
import { describeConfig, loadConfig } from '../lib/config.js'
import { createSettingsHandlers, draftToConfig, SETTINGS_PATH, statusPayload } from '../lib/settings.js'

const ENV_KEYS = [
  'DSH_HOME',
  'DSH_EMAIL_HOST',
  'DSH_EMAIL_PORT',
  'DSH_EMAIL_SECURE',
  'DSH_EMAIL_USER',
  'DSH_EMAIL_PASS',
  'DSH_EMAIL_FROM',
  'DSH_EMAIL_TO',
]

/** A tiny in-process SMTP server good enough for AUTH LOGIN + DATA. */
async function createMockSmtp({ expectedUser = 'tester@qq.com', expectedPass = 'auth-code' } = {}) {
  const state = { messages: [], rcpt: [], mailFrom: '', auth: undefined, user: undefined }
  let stage = 'ready'
  const server = net.createServer(socket => {
    socket.setEncoding('utf8')
    socket.write('220 mock.example ESMTP Mock\r\n')
    let buffer = ''
    const reply = text => socket.write(`${text}\r\n`)

    const handleLine = line => {
      const upper = line.toUpperCase()
      if (stage === 'user') {
        state.user = Buffer.from(line, 'base64').toString('utf8')
        stage = 'pass'
        reply('334 UGFzc3dvcmQ6')
        return
      }
      if (stage === 'pass') {
        const pass = Buffer.from(line, 'base64').toString('utf8')
        if (state.user === expectedUser && pass === expectedPass) {
          state.auth = 'LOGIN'
          reply('235 Authentication successful')
        } else {
          reply('535 Authentication failed')
        }
        stage = 'ready'
        return
      }
      if (upper.startsWith('EHLO')) {
        socket.write('250-mock.example\r\n250-AUTH LOGIN PLAIN\r\n250-8BITMIME\r\n250 SIZE 35882577\r\n')
        return
      }
      if (upper.startsWith('HELO')) return reply('250 mock.example')
      if (upper === 'AUTH LOGIN') {
        stage = 'user'
        return reply('334 VXNlcm5hbWU6')
      }
      if (upper.startsWith('AUTH PLAIN ')) {
        const token = Buffer.from(line.slice('AUTH PLAIN '.length).trim(), 'base64').toString('utf8')
        const [, user, pass] = token.split('\u0000')
        if (user === expectedUser && pass === expectedPass) {
          state.auth = 'PLAIN'
          reply('235 Authentication successful')
        } else {
          reply('535 Authentication failed')
        }
        return
      }
      if (upper.startsWith('MAIL FROM:')) {
        state.mailFrom = line.slice('MAIL FROM:'.length).replace(/[<>]/g, '')
        return reply('250 OK')
      }
      if (upper.startsWith('RCPT TO:')) {
        state.rcpt.push(line.slice('RCPT TO:'.length).replace(/[<>]/g, ''))
        return reply('250 OK')
      }
      if (upper === 'DATA') {
        stage = 'data'
        return reply('354 End data with <CR><LF>.<CR><LF>')
      }
      if (upper === 'QUIT') {
        reply('221 Bye')
        socket.end()
        return
      }
      if (upper === 'NOOP') return reply('250 OK')
      reply(`500 Unrecognized command: ${line}`)
    }

    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        if (stage === 'data') {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0) return
          state.messages.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 5)
          stage = 'ready'
          reply('250 OK queued as mock-1')
          continue
        }
        const index = buffer.indexOf('\r\n')
        if (index < 0) return
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        handleLine(line)
      }
    })
    socket.on('error', () => {})
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    state,
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

function collectRegisteredTools(rowConfig) {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    // Unit tests have no web server; the optional web surface stays unmounted.
    inject() {},
  }
  plugin.apply(ctx, rowConfig)
  return tools
}

function fakeRequest({ method = 'GET', headers = { host: '127.0.0.1:1461' }, body } = {}) {
  const listeners = {}
  const req = {
    method,
    headers,
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener)
      return req
    },
  }
  queueMicrotask(() => {
    if (body !== undefined) for (const listener of listeners.data ?? []) listener(Buffer.from(body))
    for (const listener of listeners.end ?? []) listener()
  })
  return req
}

function fakeResponse() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      Object.assign(res.headers, headers ?? {})
    },
    end(data) {
      res.body += data === undefined ? '' : String(data)
    },
  }
  return res
}

async function callHandler(handler, options) {
  const res = fakeResponse()
  await handler(fakeRequest(options), res)
  return res
}

describe('mime', () => {
  test('encodes non-ASCII subject and builds multipart/alternative', () => {
    const { raw, messageId } = buildMessage({
      from: { name: '发送者', address: 'sender@example.com' },
      to: [{ name: '收件人', address: 'receiver@example.com' }],
      subject: '你好，DSH 测试邮件',
      text: 'plain body',
      html: '<p>html body</p>',
    })
    assert.match(raw, /^Subject: =\?UTF-8\?B\?/m)
    assert.match(raw, /Content-Type: multipart\/alternative; boundary="----dsh-email-/)
    assert.match(messageId, /^<[\w.]+@example\.com>$/)
    assert.ok(raw.includes(Buffer.from('plain body', 'utf8').toString('base64')))
    assert.ok(raw.includes(Buffer.from('<p>html body</p>', 'utf8').toString('base64')))
    assert.match(raw, /^To: =\?UTF-8\?B\?/m)
  })

  test('attaches files as multipart/mixed with RFC 2231 filename', () => {
    const { raw } = buildMessage({
      from: { address: 'sender@example.com' },
      to: [{ address: 'receiver@example.com' }],
      subject: 'with attachment',
      text: 'see attachment',
      attachments: [{ path: 'C:\\tmp\\报告 2026.pdf', content: Buffer.from('pdf-bytes') }],
    })
    assert.match(raw, /Content-Type: multipart\/mixed; boundary="----dsh-email-/)
    assert.match(raw, /filename\*=UTF-8''/)
    assert.ok(raw.includes(Buffer.from('pdf-bytes').toString('base64')))
  })

  test('dot-stuffs the DATA payload', () => {
    const payload = prepareDataPayload('line one\r\n.leading dot\r\n..two dots')
    assert.ok(payload.includes('\r\n..leading dot\r\n'))
    assert.ok(payload.includes('\r\n...two dots'))
    assert.ok(payload.endsWith('\r\n'))
  })
})

describe('smtp', () => {
  test('delivers a message through a mock server', async () => {
    const mock = await createMockSmtp()
    try {
      const smtp = { host: '127.0.0.1', port: mock.port, secure: 'plain', user: 'tester@qq.com', pass: 'auth-code' }
      const message = buildMessage({
        from: { address: 'tester@qq.com' },
        to: [{ address: 'target@example.com' }],
        subject: 'smtp test',
        text: 'hello over smtp',
      })
      const result = await sendMail({
        smtp,
        from: { address: 'tester@qq.com' },
        to: [{ address: 'target@example.com' }],
        message,
        timeoutMs: 5000,
        signal: undefined,
      })
      assert.deepEqual(result.accepted, ['target@example.com'])
      assert.match(result.response, /queued as mock-1/)
      assert.equal(mock.state.auth, 'LOGIN')
      assert.deepEqual(mock.state.rcpt, ['target@example.com'])
      assert.equal(mock.state.messages.length, 1)
      assert.ok(mock.state.messages[0].includes('Subject: smtp test'))
      assert.ok(mock.state.messages[0].includes(Buffer.from('hello over smtp').toString('base64')))
    } finally {
      await mock.close()
    }
  })

  test('verifies the account without sending mail', async () => {
    const mock = await createMockSmtp()
    try {
      const result = await verifySmtp({
        smtp: { host: '127.0.0.1', port: mock.port, secure: 'plain', user: 'tester@qq.com', pass: 'auth-code' },
        timeoutMs: 5000,
        signal: undefined,
      })
      assert.equal(result.auth, 'LOGIN')
      assert.match(result.greeting, /mock\.example/)
      assert.equal(mock.state.messages.length, 0)
    } finally {
      await mock.close()
    }
  })
})

describe('config', () => {
  let home
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-email-test-'))
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.DSH_HOME = home
  })
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
    rmSync(home, { recursive: true, force: true })
  })

  test('reads credentials from the JSON file and masks the password', () => {
    writeFileSync(
      join(home, 'email-plugin.json'),
      JSON.stringify({
        smtp: { host: 'smtp.qq.com', port: 465, secure: 'tls', user: 'me@qq.com', pass: 'secret-code' },
        defaultTo: 'me@qq.com',
      }),
    )
    const config = loadConfig()
    assert.equal(config.smtp.host, 'smtp.qq.com')
    assert.equal(config.from.address, 'me@qq.com')
    assert.equal(config.smtp.pass, 'secret-code')
    assert.ok(!describeConfig(config).includes('secret-code'))
    assert.match(describeConfig(config), /\*\*\*\*\*\*/)
  })

  test('environment variables override the JSON file', () => {
    writeFileSync(join(home, 'email-plugin.json'), JSON.stringify({ smtp: { user: 'file@qq.com', pass: 'file-pass' } }))
    process.env.DSH_EMAIL_USER = 'env@qq.com'
    process.env.DSH_EMAIL_PASS = 'env-pass'
    const config = loadConfig()
    assert.equal(config.smtp.user, 'env@qq.com')
    assert.equal(config.smtp.pass, 'env-pass')
  })

  test('row config overrides env and file', () => {
    writeFileSync(
      join(home, 'email-plugin.json'),
      JSON.stringify({ smtp: { host: 'file.example', user: 'file@qq.com', pass: 'p' } }),
    )
    const config = loadConfig({ smtp: { host: 'row.example' }, timeoutMs: 1234 })
    assert.equal(config.smtp.host, 'row.example')
    assert.equal(config.timeoutMs, 1234)
  })
})

describe('plugin tools', () => {
  let home
  let mock
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-email-test-'))
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.DSH_HOME = home
    mock = await createMockSmtp()
    writeFileSync(
      join(home, 'email-plugin.json'),
      JSON.stringify({
        smtp: { host: '127.0.0.1', port: mock.port, secure: 'plain', user: 'tester@qq.com', pass: 'auth-code' },
        defaultTo: 'target@example.com',
      }),
    )
  })
  afterEach(async () => {
    await mock.close()
    for (const key of ENV_KEYS) delete process.env[key]
    rmSync(home, { recursive: true, force: true })
  })

  test('registers email_send, email_verify and email_status', () => {
    const tools = collectRegisteredTools({})
    assert.deepEqual([...tools.keys()].sort(), ['email_send', 'email_status', 'email_verify'])
  })

  test('email_send sends and renders a summary', async () => {
    const tools = collectRegisteredTools({})
    const send = tools.get('email_send')
    const value = await send.execute(
      { to: 'first@example.com, second@example.com', subject: '来自 DSH 的测试', text: '这是一封测试邮件' },
      {},
    )
    assert.equal(value.ok, true)
    assert.deepEqual(value.accepted, ['first@example.com', 'second@example.com'])
    assert.deepEqual(value.rejected, [])
    assert.match(value.messageId, /^<[\w.]+@qq\.com>$/)
    assert.equal(mock.state.messages.length, 1)
    const raw = mock.state.messages[0]
    assert.ok(raw.includes('Subject: =?UTF-8?B?'))
    assert.ok(raw.includes(Buffer.from('这是一封测试邮件', 'utf8').toString('base64')))
    const content = send.output.render({}, value)
    assert.equal(content[0].type, 'text')
    assert.match(content[0].text, /邮件已发送/)
    assert.match(content[0].text, /first@example\.com/)
  })

  test('email_send uses defaultTo when `to` is omitted', async () => {
    const tools = collectRegisteredTools({})
    const value = await tools.get('email_send').execute({ subject: 'default recipient', text: 'hi' }, {})
    assert.deepEqual(value.accepted, ['target@example.com'])
  })

  test('email_send reports the QQ authorization-code hint on 535', async () => {
    writeFileSync(
      join(home, 'email-plugin.json'),
      JSON.stringify({
        smtp: { host: '127.0.0.1', port: mock.port, secure: 'plain', user: 'tester@qq.com', pass: 'wrong' },
        defaultTo: 'target@example.com',
      }),
    )
    const tools = collectRegisteredTools({})
    await assert.rejects(() => tools.get('email_send').execute({ subject: 'should fail', text: 'x' }, {}), /授权码/)
  })

  test('email_status masks the password', async () => {
    const tools = collectRegisteredTools({})
    const value = await tools.get('email_status').execute({}, {})
    assert.equal(value.configured, true)
    assert.ok(!value.summary.includes('auth-code'))
    assert.match(value.configFile, /email-plugin\.json$/)
    assert.equal(value.settingsUrl, '')
  })

  test('email_verify connects to the configured account', async () => {
    const tools = collectRegisteredTools({})
    const value = await tools.get('email_verify').execute({}, {})
    assert.equal(value.ok, true)
    assert.equal(value.auth, 'LOGIN')
    assert.equal(mock.state.messages.length, 0)
  })
})

describe('settings page', () => {
  let home
  let mock
  let handlers
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-email-settings-'))
    for (const key of ENV_KEYS) delete process.env[key]
    process.env.DSH_HOME = home
    mock = await createMockSmtp()
    handlers = createSettingsHandlers({ rowConfig: {}, getOrigin: () => 'http://127.0.0.1:1461' })
    writeFileSync(
      join(home, 'email-plugin.json'),
      JSON.stringify({
        smtp: { host: '127.0.0.1', port: mock.port, secure: 'plain', user: 'tester@qq.com', pass: 'auth-code' },
        defaultTo: 'target@example.com',
      }),
    )
  })
  afterEach(async () => {
    await mock.close()
    for (const key of ENV_KEYS) delete process.env[key]
    rmSync(home, { recursive: true, force: true })
  })

  test('serves the HTML form', async () => {
    const res = await callHandler(handlers.page)
    assert.equal(res.status, 200)
    assert.match(res.headers['Content-Type'], /text\/html/)
    assert.ok(res.body.includes('邮箱地址'))
    assert.ok(res.body.includes('SMTP 授权码'))
    assert.ok(res.body.includes(SETTINGS_PATH))
  })

  test('rejects a non-loopback Host header', async () => {
    const res = await callHandler(handlers.status, { headers: { host: 'example.com' } })
    assert.equal(res.status, 403)
  })

  test('reports status without leaking the password', async () => {
    const res = await callHandler(handlers.status)
    assert.equal(res.status, 200)
    const value = JSON.parse(res.body)
    assert.equal(value.configured, true)
    assert.equal(value.hasPassword, true)
    assert.ok(!res.body.includes('auth-code'))
    assert.equal(value.settingsUrl, `http://127.0.0.1:1461${SETTINGS_PATH}`)
  })

  test('saves the form and keeps the password out of the response', async () => {
    const res = await callHandler(handlers.save, {
      method: 'POST',
      headers: { host: '127.0.0.1:1461', origin: 'http://127.0.0.1:1461' },
      body: JSON.stringify({
        user: 'me@qq.com',
        pass: 'new-auth-code',
        host: 'smtp.qq.com',
        port: 465,
        secure: 'tls',
        fromName: '测试',
        fromAddress: 'me@qq.com',
        defaultTo: 'me@qq.com',
      }),
    })
    assert.equal(res.status, 200, res.body)
    const saved = JSON.parse(readFileSync(join(home, 'email-plugin.json'), 'utf8'))
    assert.equal(saved.smtp.user, 'me@qq.com')
    assert.equal(saved.smtp.pass, 'new-auth-code')
    assert.equal(saved.from.name, '测试')
    const value = JSON.parse(res.body)
    assert.equal(value.configured, true)
    assert.ok(!res.body.includes('new-auth-code'))
  })

  test('keeps the stored password when the form leaves it blank', () => {
    const next = draftToConfig(
      { user: 'me@qq.com', pass: '', host: 'smtp.qq.com', port: '465', secure: 'tls' },
      { smtp: { pass: 'existing-code' } },
    )
    assert.equal(next.smtp.pass, 'existing-code')
  })

  test('rejects a cross-site Origin on save', async () => {
    const res = await callHandler(handlers.save, {
      method: 'POST',
      headers: { host: '127.0.0.1:1461', origin: 'https://evil.example' },
      body: JSON.stringify({ user: 'me@qq.com', pass: 'x' }),
    })
    assert.equal(res.status, 403)
  })

  test('sends a test mail through the page API', async () => {
    const res = await callHandler(handlers.test, {
      method: 'POST',
      headers: { host: '127.0.0.1:1461', origin: 'http://127.0.0.1:1461' },
      body: JSON.stringify({ to: 'target@example.com' }),
    })
    assert.equal(res.status, 200, res.body)
    const value = JSON.parse(res.body)
    assert.equal(value.ok, true)
    assert.equal(mock.state.messages.length, 1)
    assert.ok(mock.state.messages[0].includes('Subject: =?UTF-8?B?'))
  })

  test('statusPayload masks the password and keeps the file path', () => {
    const value = statusPayload(loadConfig())
    assert.equal(value.hasPassword, true)
    assert.match(value.configFile, /email-plugin\.json$/)
    assert.ok(!JSON.stringify(value).includes('auth-code'))
  })
})
