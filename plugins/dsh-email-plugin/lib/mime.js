/**
 * RFC 5322 / MIME message construction.
 *
 * Produces a CRLF-normalized message with UTF-8 headers (RFC 2047 encoded
 * words), text/plain + optional text/html alternatives, and base64 attachments
 * (RFC 2231 filenames). No external dependencies.
 */
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'

const CRLF = '\r\n'

const CONTENT_TYPES = new Map([
  ['.txt', 'text/plain; charset=UTF-8'],
  ['.log', 'text/plain; charset=UTF-8'],
  ['.md', 'text/markdown; charset=UTF-8'],
  ['.csv', 'text/csv; charset=UTF-8'],
  ['.htm', 'text/html; charset=UTF-8'],
  ['.html', 'text/html; charset=UTF-8'],
  ['.json', 'application/json; charset=UTF-8'],
  ['.xml', 'application/xml; charset=UTF-8'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.zip', 'application/zip'],
  ['.gz', 'application/gzip'],
  ['.7z', 'application/x-7z-compressed'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
])

/** ASCII-only and free of control characters: usable as an unencoded header value. */
function isPrintableAscii(text) {
  return /^[\x20-\x7E]*$/.test(text)
}

/** RFC 2047 base64 encoded word for non-ASCII header text. */
export function encodeWord(text) {
  if (text === undefined || text === null || text === '') return ''
  const value = String(text)
  if (isPrintableAscii(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** Percent-encode a parameter value for RFC 2231 (`filename*=UTF-8''...`). */
function encodeParameterValue(text) {
  return encodeURIComponent(text).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function quoteDisplayName(name) {
  const text = String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `"${text}"`
}

/**
 * Format one address for a header.
 * @param address - `{ name?, address }`.
 */
export function formatAddress(address) {
  if (address.name === undefined || address.name === '') return address.address
  const name = isPrintableAscii(address.name) ? quoteDisplayName(address.name) : encodeWord(address.name)
  return `${name} <${address.address}>`
}

function formatDate(date) {
  const formatted = date.toUTCString().replace(/GMT$/, '+0000')
  return formatted
}

function base64Body(buffer) {
  const encoded = buffer.toString('base64')
  const lines = []
  for (let index = 0; index < encoded.length; index += 76) lines.push(encoded.slice(index, index + 76))
  return lines.join(CRLF)
}

function serializeHeaders(headers) {
  return headers.map(([name, value]) => `${name}: ${value}`).join(CRLF)
}

/**
 * Serialize one MIME entity (headers + blank line + body).
 * @param entity - `{ headers: [name, value][], body: string }`.
 */
function serializeEntity(entity) {
  return `${serializeHeaders(entity.headers)}${CRLF}${CRLF}${entity.body}`
}

function textEntity(content, subtype) {
  return {
    headers: [
      ['Content-Type', `text/${subtype}; charset=UTF-8`],
      ['Content-Transfer-Encoding', 'base64'],
    ],
    body: base64Body(Buffer.from(content, 'utf8')),
  }
}

function multipartEntity(subtype, parts) {
  const boundary = `----dsh-email-${randomBytes(12).toString('hex')}`
  const body = parts
    .map(part => [`--${boundary}${CRLF}${serializeEntity(part)}`].join(''))
    .join(CRLF)
    .concat(`${CRLF}--${boundary}--`)
  return {
    headers: [['Content-Type', `multipart/${subtype}; boundary="${boundary}"`]],
    body,
  }
}

function attachmentEntity(attachment) {
  const filename = basename(attachment.path)
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_')
  const contentType = CONTENT_TYPES.get(extensionOf(filename)) ?? 'application/octet-stream'
  return {
    headers: [
      ['Content-Type', `${contentType}; name="${fallback}"`],
      ['Content-Disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${encodeParameterValue(filename)}`],
      ['Content-Transfer-Encoding', 'base64'],
    ],
    body: base64Body(attachment.content),
  }
}

function extensionOf(filename) {
  const index = filename.lastIndexOf('.')
  return index < 0 ? '' : filename.slice(index).toLowerCase()
}

function splitAddress(address) {
  const at = address.lastIndexOf('@')
  return at <= 0 ? 'localhost' : address.slice(at + 1)
}

/**
 * Build a complete RFC 5322 message.
 * @param options - envelope content.
 * @param options.from - `{ name?, address }`.
 * @param options.to - array of `{ name?, address }`, already non-empty.
 * @param options.cc - optional CC addresses.
 * @param options.subject - raw (unencoded) subject text.
 * @param options.text - plain-text body, omitted when only `html` is given.
 * @param options.html - optional HTML body.
 * @param options.attachments - `[{ path, content: Buffer }]`.
 * @param options.headers - optional extra raw headers `[name, value][]`.
 * @returns `{ raw, messageId }` where `raw` is CRLF-normalized without dot-stuffing.
 */
export function buildMessage(options) {
  const date = options.date ?? new Date()
  const messageId = `<${Math.floor(date.getTime() / 1000)}.${randomBytes(10).toString('hex')}@${splitAddress(options.from.address)}>`
  const cc = options.cc ?? []

  const messageHeaders = [
    ['From', formatAddress(options.from)],
    ['To', options.to.map(formatAddress).join(', ')],
    ...(cc.length > 0 ? [['Cc', cc.map(formatAddress).join(', ')]] : []),
    ['Subject', encodeWord(options.subject)],
    ['Date', formatDate(date)],
    ['Message-ID', messageId],
    ['MIME-Version', '1.0'],
    ...(options.headers ?? []),
  ]

  const text = options.text ?? (options.html === undefined ? '' : undefined)
  const alternative =
    options.html !== undefined
      ? multipartEntity('alternative', [
          ...(text === undefined ? [] : [textEntity(text, 'plain')]),
          textEntity(options.html, 'html'),
        ])
      : textEntity(text ?? '', 'plain')

  const root =
    options.attachments !== undefined && options.attachments.length > 0
      ? multipartEntity('mixed', [alternative, ...options.attachments.map(attachmentEntity)])
      : alternative

  const raw = [
    serializeHeaders(messageHeaders),
    serializeHeaders(root.headers),
    '',
    root.body,
  ].join(CRLF)

  return { raw, messageId }
}

/**
 * Prepare a message body for the SMTP DATA phase: CRLF-normalized and dot-stuffed.
 * @param raw - the serialized message.
 * @returns the payload that may be written between DATA and the terminating dot.
 */
export function prepareDataPayload(raw) {
  const normalized = raw.replace(/\r\n|\r|\n/g, CRLF)
  const stuffed = normalized.replace(/(^|\r\n)\./g, '$1..')
  return stuffed.endsWith(CRLF) ? stuffed : `${stuffed}${CRLF}`
}
