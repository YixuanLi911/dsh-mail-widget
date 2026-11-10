/**
 * 极简 IMAP 客户端（Node 内置 tls，无第三方依赖）。
 * 只做三件事：取未读邮件头、取未读数量、把未读标为已读。
 */

import net from 'node:net'
import tls from 'node:tls'

const CRLF = '\r\n'

class IMAPError extends Error {}

export class IMAPClient {
  constructor(options) {
    this.options = {
      host: options.host,
      port: Number(options.port || 993),
      user: options.user,
      password: options.password,
      folder: options.folder || 'INBOX',
      useTLS: options.useTLS !== false,
      timeoutMs: options.timeoutMs || 30000
    }
    this.socket = null
    /** 原始字节缓冲：IMAP literal 的长度是字节数，不能用字符串下标 */
    this.buffer = Buffer.alloc(0)
    this.counter = 0
  }

  // ---------- 连接与收发 ----------

  connect() {
    const { host, port, timeoutMs } = this.options
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        clearTimeout(timer)
        resolve()
      }
      const socket = this.options.useTLS
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }, onConnect)
        : net.connect({ host, port }, onConnect)
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk])
      })
      socket.on('error', (error) => {
        clearTimeout(timer)
        reject(new IMAPError(friendlyNetworkError(error)))
      })
      socket.on('close', () => {
        this.closed = true
      })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new IMAPError('连接邮件服务器超时，请检查网络'))
      }, timeoutMs)
      this.socket = socket
    })
  }

  close() {
    if (this.socket) {
      try { this.socket.end() } catch {}
      try { this.socket.destroy() } catch {}
      this.socket = null
    }
  }

  async write(text) {
    if (!this.socket) throw new IMAPError('未连接')
    await new Promise((resolve, reject) => {
      this.socket.write(text + CRLF, (error) => (error ? reject(error) : resolve()))
    })
  }

  /** 读取直到出现 tagged 完成行，正确处理 literal */
  async readUntil(tag) {
    const deadline = Date.now() + this.options.timeoutMs
    while (true) {
      const end = this.findTaggedEnd(tag)
      if (end !== null) {
        const data = this.buffer.subarray(0, end).toString('utf8')
        this.buffer = this.buffer.subarray(end)
        return data
      }
      if (Date.now() > deadline) throw new IMAPError('等待邮件服务器响应超时')
      await this.waitForData()
    }
  }

  waitForData() {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket) return reject(new IMAPError('未连接'))
      let done = false
      const finish = (error) => {
        if (done) return
        done = true
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        error ? reject(error) : resolve()
      }
      const onData = () => finish()
      const onError = (error) => finish(new IMAPError(friendlyNetworkError(error)))
      const onClose = () => finish(new IMAPError('邮件服务器断开了连接'))
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      setTimeout(() => finish(), 200)
    })
  }

  /** 找到 tag 结尾行的位置，跳过 literal 内容 */
  findTaggedEnd(tag) {
    let index = 0
    while (index < this.buffer.length) {
      const lineEnd = this.buffer.indexOf(CRLF, index, 'latin1')
      if (lineEnd < 0) return null
      const line = this.buffer.subarray(index, lineEnd).toString('latin1')
      if (line.startsWith(tag + ' ') || line === tag) return lineEnd + 2
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal) {
        const start = lineEnd + 2
        const size = Number(literal[1])
        if (start + size > this.buffer.length) return null
        index = start + size
        continue
      }
      index = lineEnd + 2
    }
    return null
  }

  /** 与 readUntil 相同，但返回原始字节（literal 里可能是 GB2312 等非 UTF-8） */
  async readUntilRaw(tag) {
    const deadline = Date.now() + this.options.timeoutMs
    while (true) {
      const end = this.findTaggedEnd(tag)
      if (end !== null) {
        const data = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(end)
        return data
      }
      if (Date.now() > deadline) throw new IMAPError('等待邮件服务器响应超时')
      await this.waitForData()
    }
  }

  async command(text) {
    this.counter += 1
    const tag = `A${this.counter}`
    await this.write(`${tag} ${text}`)
    const response = await this.readUntil(tag)
    const lines = response.split(CRLF)
    const statusLine = [...lines].reverse().find((line) => line.startsWith(tag + ' ') || line === tag)
    if (statusLine) {
      const parts = statusLine.split(' ')
      const status = (parts[1] || '').toUpperCase()
      if (status === 'NO' || status === 'BAD') {
        throw new IMAPError(friendlyServerError(parts.slice(2).join(' ') || statusLine))
      }
    }
    return response
  }

  // ---------- 对外操作 ----------

  async login() {
    await this.connect()
    // 必须先等到服务器的问候行，否则某些服务器（QQ 邮箱）会忽略抢跑的 LOGIN
    await this.waitForGreeting()
    await this.command(`LOGIN ${quote(this.options.user)} ${quote(this.options.password)}`)
    // 网易邮箱需要这个，否则报 Unsafe Login；其他服务器不支持时忽略
    try {
      await this.command('ID ("name" "dsh-mail-widget" "version" "1.0.0" "vendor" "dsh-mail-widget")')
    } catch {}
    await this.command(`SELECT ${quote(this.options.folder)}`)
  }

  /** 读取并消费服务器问候行（* OK / * PREAUTH） */
  async waitForGreeting() {
    const deadline = Date.now() + this.options.timeoutMs
    while (true) {
      const text = this.buffer.toString('latin1')
      const lineEnd = text.indexOf(CRLF)
      if (lineEnd >= 0) {
        const line = text.slice(0, lineEnd)
        this.buffer = this.buffer.subarray(lineEnd + 2)
        if (line.startsWith('* OK') || line.startsWith('* PREAUTH')) return line
        if (line.startsWith('* BYE')) throw new IMAPError('邮件服务器拒绝连接：' + line.slice(5))
        continue
      }
      if (this.closed) throw new IMAPError('邮件服务器在问候前断开了连接')
      if (Date.now() > deadline) throw new IMAPError('等待邮件服务器问候超时')
      await this.waitForData(1000)
    }
  }

  async logout() {
    try { await this.command('LOGOUT') } catch {}
    this.close()
  }

  async searchUnseen() {
    let response
    try {
      response = await this.command('UID SEARCH UNSEEN')
    } catch {
      response = await this.command('SEARCH UNSEEN')
    }
    const line = response.split(CRLF).find((item) => item.startsWith('* SEARCH'))
    if (!line) return []
    return line
      .slice('* SEARCH'.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
  }

  /** 取指定 UID 的头部；返回 { uid, headers } 数组 */
  async fetchHeaders(uids) {
    if (!uids.length) return []
    const list = uids.join(',')
    this.counter += 1
    const tag = `A${this.counter}`
    await this.write(`${tag} UID FETCH ${list} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])`)
    const raw = await this.readUntilRaw(tag)
    const response = raw.toString('latin1')
    const results = []
    let index = 0
    while (index < response.length) {
      const lineEnd = response.indexOf(CRLF, index)
      if (lineEnd < 0) break
      const line = response.slice(index, lineEnd)
      const literal = /\{(\d+)\}$/.exec(line)
      const uidMatch = /UID (\d+)/.exec(line)
      if (literal && uidMatch) {
        const start = lineEnd + 2
        const size = Number(literal[1])
        const body = response.slice(start, start + size)
        results.push({ uid: Number(uidMatch[1]), headers: body })
        index = start + size
        continue
      }
      index = lineEnd + 2
    }
    return results
  }

  async markSeen(uids) {
    if (!uids.length) return 0
    let handled = 0
    for (let i = 0; i < uids.length; i += 200) {
      const chunk = uids.slice(i, i + 200)
      await this.command(`UID STORE ${chunk.join(',')} +FLAGS.SILENT (\\Seen)`)
      handled += chunk.length
    }
    return handled
  }
}

// ---------- 工具函数 ----------

export function quote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function friendlyNetworkError(error) {
  const code = error?.code || ''
  if (code === 'ENOTFOUND') return '找不到邮件服务器地址，请检查服务器名'
  if (code === 'ECONNREFUSED') return '邮件服务器拒绝了连接，请检查端口'
  if (code === 'ETIMEDOUT') return '连接邮件服务器超时'
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return '邮件服务器证书校验失败'
  return `网络错误：${error?.message || error}`
}

export function friendlyServerError(raw) {
  const text = String(raw).trim()
  const lower = text.toLowerCase()
  if (lower.includes('authenticationfailed') || lower.includes('invalid credentials') || lower.includes('login failed')) {
    return '登录失败：账号或密码不对。Gmail / QQ / 163 需要「应用专用密码」或「授权码」，不是网页登录密码。'
  }
  if (lower.includes('unsafe login')) return '163 / 126 邮箱需要先开启 IMAP，并使用授权码登录。'
  if (lower.includes('too many')) return '登录太频繁被服务器限制，请稍后再试。'
  return `服务器返回：${text}`
}
