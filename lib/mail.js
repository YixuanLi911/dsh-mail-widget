/**
 * 邮件头解析：RFC 2047（UTF-8 / GB2312 / GBK / Big5）+ 地址 + 日期 + 分段。
 */

import { IMAPClient } from './imap.js'

const CHARSET_ALIASES = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  gb2312: 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  'euc-cn': 'gb18030',
  cp936: 'gb18030',
  big5: 'big5',
  'big-5': 'big5',
  cp950: 'big5',
  'iso-8859-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
  'us-ascii': 'utf-8',
  ascii: 'utf-8'
}

function decodeBytes(bytes, charset) {
  const normalized = CHARSET_ALIASES[String(charset || '').toLowerCase().trim()]
  if (normalized) {
    try {
      return new TextDecoder(normalized).decode(bytes)
    } catch {}
  }
  try {
    return new TextDecoder('utf-8').decode(bytes)
  } catch {}
  return new TextDecoder('gb18030').decode(bytes)
}

function tryDecodeStrict(bytes, charset) {
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 已解码文本（用于整体兜底，例如未编码的 8-bit 中文头） */
function decodeRawText(text) {
  if (!text) return ''
  if (!/[\u0080-\u00ff]/.test(text)) return text
  const bytes = Buffer.from(text, 'latin1')
  return tryDecodeStrict(bytes, 'utf-8')
    ?? tryDecodeStrict(bytes, 'gb18030')
    ?? tryDecodeStrict(bytes, 'big5')
    ?? Buffer.from(bytes).toString('latin1')
}

function padBase64(text) {
  let out = text.replace(/\s+/g, '')
  while (out.length % 4 !== 0) out += '='
  return out
}

function qDecode(text) {
  const source = text.replace(/_/g, ' ')
  const bytes = []
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '=' && /^[0-9a-fA-F]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(source.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

export function decodeWords(input) {
  if (!input || !input.includes('=?')) return decodeRawText(input)
  const pattern = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g
  let output = ''
  let cursor = 0
  let previousWasEncoded = false
  let match
  while ((match = pattern.exec(input))) {
    const gap = input.slice(cursor, match.index)
    if (!(previousWasEncoded && gap.trim() === '')) output += gap
    const [, charset, encoding, payload] = match
    const bytes = encoding.toUpperCase() === 'B'
      ? Buffer.from(padBase64(payload), 'base64')
      : qDecode(payload)
    output += decodeBytes(bytes, charset)
    previousWasEncoded = true
    cursor = match.index + match[0].length
  }
  output += input.slice(cursor)
  return output
}

export function parseAddress(value) {
  let text = String(value || '').trim()
  if (!text) return { name: '', address: '' }
  text = text.replace(/\([^()]*\)/g, ' ')

  let address = ''
  let name = ''
  const lt = text.lastIndexOf('<')
  const gt = text.lastIndexOf('>')
  if (lt >= 0 && gt > lt) {
    address = text.slice(lt + 1, gt).trim()
    name = text.slice(0, lt)
  } else if (text.includes('@')) {
    address = text.trim()
  } else {
    name = text
  }

  name = decodeWords(name).replace(/^["'\s]+|["'\s]+$/g, '')
  address = address.replace(/^[<>\s]+|[<>\s]+$/g, '')
  if (!name) name = address
  return { name, address }
}

/** 解析 BODY[HEADER.FIELDS ...] 返回的原始头部文本 */
export function parseHeaderBlock(body) {
  const unfolded = String(body || '').replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ')
  const fields = {}
  for (const line of unfolded.split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toUpperCase()
    const value = line.slice(colon + 1).trim()
    if (fields[key] === undefined) fields[key] = value
  }
  return fields
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
}

export function parseDate(value) {
  const text = String(value || '').replace(/\([^()]*\)/g, ' ').trim()
  if (!text) return null
  const match = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4})?/.exec(text)
  if (!match) {
    const direct = Date.parse(text)
    return Number.isNaN(direct) ? null : new Date(direct)
  }
  const [, day, monthName, year, hour, minute, second = '0', zone] = match
  const month = MONTHS[monthName.toLowerCase()]
  if (month === undefined) return null
  let offsetMinutes = 0
  if (zone) {
    const sign = zone.startsWith('-') ? -1 : 1
    offsetMinutes = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)))
  }
  const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second))
  return new Date(utc - offsetMinutes * 60 * 1000)
}

export function relativeTime(date) {
  if (!date) return ''
  const seconds = (Date.now() - date.getTime()) / 1000
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 把未读邮件分成「近 7 天」和「8-30 天」两段 */
export function splitSections(items, now = Date.now()) {
  const weekStart = now - 7 * 86400 * 1000
  const monthStart = now - 30 * 86400 * 1000
  const week = []
  const month = []
  for (const item of items) {
    if (!item.date) continue
    const time = item.date.getTime()
    if (time > weekStart) week.push(item)
    else if (time > monthStart) month.push(item)
  }
  return { week, month }
}

function toItem({ uid, headers }) {
  const fields = parseHeaderBlock(headers)
  const sender = parseAddress(fields.FROM || '')
  const messageId = (fields['MESSAGE-ID'] || '').replace(/^[<>\s]+|[<>\s]+$/g, '')
  return {
    uid,
    name: sender.name || '未知发件人',
    address: sender.address,
    subject: decodeWords(fields.SUBJECT || '') || '(无主题)',
    date: parseDate(fields.DATE || ''),
    messageId: messageId || undefined
  }
}

/**
 * 读取收件箱未读概览。
 * @param {object} config IMAP 配置
 * @param {number} limit 每段最多返回多少条
 */
export async function fetchInbox(config, limit = 4) {
  const client = new IMAPClient(config)
  await client.login()
  try {
    const uids = await client.searchUnseen()
    if (!uids.length) {
      return { totalUnread: 0, week: { count: 0, items: [] }, month: { count: 0, items: [] } }
    }
    const newest = uids.slice(-Math.max(24, limit * 8))
    const raw = await client.fetchHeaders(newest)
    const items = raw
      .map(toItem)
      .filter((item) => item.date)
      .sort((a, b) => b.date - a.date)

    const { week, month } = splitSections(items)
    const trim = (list) => list.slice(0, limit).map((item) => ({
      uid: item.uid,
      name: item.name,
      address: item.address,
      subject: item.subject,
      time: relativeTime(item.date),
      at: item.date ? item.date.toISOString() : null
    }))
    return {
      totalUnread: uids.length,
      week: { count: week.length, items: trim(week) },
      month: { count: month.length, items: trim(month) }
    }
  } finally {
    await client.logout()
  }
}

/** 把收件箱里所有未读标为已读，返回处理数量 */
export async function markAllRead(config) {
  const client = new IMAPClient({ ...config, timeoutMs: 300000 })
  await client.login()
  try {
    const uids = await client.searchUnseen()
    if (!uids.length) return 0
    return await client.markSeen(uids)
  } finally {
    await client.logout()
  }
}
