/**
 * 配置读写：保存在 $DSH_HOME/mail-widget/config.json（0600）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PROVIDERS = [
  {
    id: 'gmail',
    label: 'Gmail',
    host: 'imap.gmail.com',
    port: 993,
    hint: '需要「应用专用密码」：Google 账号 → 安全性 → 两步验证 → 应用专用密码，不能填网页登录密码。'
  },
  {
    id: 'qq',
    label: 'QQ 邮箱 / Foxmail',
    host: 'imap.qq.com',
    port: 993,
    hint: 'QQ 邮箱网页版 → 设置 → 账号 → 开启 IMAP，把页面给的「授权码」当密码填。'
  },
  {
    id: '163',
    label: '163 邮箱',
    host: 'imap.163.com',
    port: 993,
    hint: '163 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP，用生成的「授权码」作为密码。'
  },
  {
    id: '126',
    label: '126 邮箱',
    host: 'imap.126.com',
    port: 993,
    hint: '126 网页版 → 设置 → POP3/SMTP/IMAP → 开启 IMAP，用生成的「授权码」作为密码。'
  },
  {
    id: 'icloud',
    label: 'iCloud 邮箱',
    host: 'imap.mail.me.com',
    port: 993,
    hint: '需要 App 专用密码：appleid.apple.com → 登录与安全 → App 专用密码。'
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    host: 'outlook.office365.com',
    port: 993,
    hint: '微软已对个人账号关闭 IMAP 密码登录；学校/企业账号可能仍可用，失败请改用网页版或其他邮箱。'
  },
  { id: 'custom', label: '自定义 IMAP 服务器', host: '', port: 993, hint: '填写邮箱服务商提供的 IMAP 地址与端口，通常开启 SSL，端口 993。' }
]

export function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

export function configPath() {
  return path.join(homeDir(), 'mail-widget', 'config.json')
}

export function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.host || !parsed.user || !parsed.password) return null
    return {
      host: String(parsed.host),
      port: Number(parsed.port) || 993,
      user: String(parsed.user),
      password: String(parsed.password),
      folder: parsed.folder || 'INBOX',
      useTLS: parsed.useTLS !== false,
      maxRows: Number(parsed.maxRows) || 4,
      port_ui: Number(parsed.port_ui) || 47823
    }
  } catch {
    return null
  }
}

export function saveConfig(input) {
  const dir = path.dirname(configPath())
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const config = {
    host: String(input.host || '').trim(),
    port: Number(input.port) || 993,
    user: String(input.user || '').trim(),
    password: String(input.password || ''),
    folder: String(input.folder || 'INBOX').trim() || 'INBOX',
    useTLS: input.useTLS !== false,
    maxRows: Number(input.maxRows) || 4,
    port_ui: Number(input.port_ui) || 47823
  }
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 })
  try { fs.chmodSync(configPath(), 0o600) } catch {}
  return config
}

export function maskConfig(config) {
  if (!config) return null
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    folder: config.folder,
    useTLS: config.useTLS,
    maxRows: config.maxRows,
    hasPassword: Boolean(config.password)
  }
}
