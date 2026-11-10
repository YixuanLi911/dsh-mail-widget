/**
 * dsh-mail-widget —— DeepSeek Harness 插件
 *
 * 提供一个「未读邮件」挂件页面（可在 DSH 右侧边栏浏览器里打开），
 * 以及两个给 agent 用的工具：mail_unread / mail_mark_all_read。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchInbox, markAllRead } from './mail.js'
import { PROVIDERS, loadConfig, maskConfig, saveConfig } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PORT = 47823

export const name = 'mail-widget'

/** 需要 tools 服务来注册工具 */
export const inject = ['tools']

/** 正在运行的挂件服务（插件卸载时关闭） */
let activeServer = null
let activePort = null

export async function apply(ctx) {
  const { defineTool } = await import('@deepseek-ai/dsh-tools')


  const start = () => {
    const config = loadConfig()
    return startWidgetServer(config?.port_ui || DEFAULT_PORT)
      .then(({ server, port }) => {
        activeServer = server
        activePort = port
      })
      .catch((error) => {
        ctx.logger?.warn?.(`mail-widget: 挂件页面启动失败：${error.message}`)
      })
  }

  await start()

  ctx.tools.register(defineTool({
    name: 'mail_unread',
    description: '读取收件箱未读邮件，分「近 7 天」和「近一个月」两段，返回未读数量与发件人。用户问「有几封新邮件」「谁给我发邮件了」时使用。',
    parameters: {
      limit: { type: 'integer', description: '每段最多返回几条，默认 4' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          configured: { type: 'boolean' },
          totalUnread: { type: 'integer' },
          widgetUrl: { type: 'string' },
          message: { type: 'string' },
        week: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  subject: { type: 'string' },
                  time: { type: 'string' }
                },
                required: ['name', 'subject', 'time']
              }
            }
          },
          required: ['count', 'items']
        },
        month: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  subject: { type: 'string' },
                  time: { type: 'string' }
                },
                required: ['name', 'subject', 'time']
              }
            }
          },
          required: ['count', 'items']
        }
        },
        required: ['configured', 'totalUnread', 'widgetUrl', 'message', 'week', 'month']
      },
      render: (_args, value) => [{ type: 'text', text: value.message }]
    },
    execute: async (args) => {
      const config = loadConfig()
      const widgetUrl = activePort ? `http://127.0.0.1:${activePort}/` : ''
      if (!config) {
        return {
          configured: false,
          totalUnread: 0,
          widgetUrl,
          message: `还没有配置邮箱。打开 ${widgetUrl || '挂件页面'} 填写 IMAP 地址、账号和授权码后就能用了。`,
          week: { count: 0, items: [] },
          month: { count: 0, items: [] }
        }
      }
      try {
        const limit = Math.min(Math.max(Number(args?.limit) || config.maxRows || 4, 1), 10)
        const data = await fetchInbox(config, limit)
        const lines = []
        if (data.totalUnread === 0) {
          lines.push('收件箱没有未读邮件。')
        } else {
          lines.push(`收件箱共 ${data.totalUnread} 封未读。`)
          lines.push(`近 7 天：${data.week.count} 封${formatList(data.week.items)}`)
          lines.push(`近一个月（8–30 天）：${data.month.count} 封${formatList(data.month.items)}`)
        }
        return {
          configured: true,
          totalUnread: data.totalUnread,
          widgetUrl,
          message: lines.join('\n'),
          week: data.week,
          month: data.month
        }
      } catch (error) {
        return {
          configured: true,
          totalUnread: 0,
          widgetUrl,
          message: `读取邮件失败：${error.message}`,
          week: { count: 0, items: [] },
          month: { count: 0, items: [] }
        }
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'mail_mark_all_read',
    description: '把收件箱里所有未读邮件标为已读。这是不可撤销的写操作，执行前必须先向用户确认。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          marked: { type: 'integer' },
          message: { type: 'string' }
        },
        required: ['marked', 'message']
      },
      render: (_args, value) => [{ type: 'text', text: value.message }]
    },
    execute: async () => {
      const config = loadConfig()
      if (!config) {
        return { marked: 0, message: '还没有配置邮箱，无法标记。' }
      }
      try {
        const marked = await markAllRead(config)
        return {
          marked,
          message: marked === 0 ? '收件箱本来就没有未读邮件。' : `已把 ${marked} 封未读邮件标为已读。`
        }
      } catch (error) {
        return { marked: 0, message: `标记失败：${error.message}` }
      }
    }
  }))

  const dispose = () => {
    if (activeServer) {
      try { activeServer.close() } catch {}
      activeServer = null
    }
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose)
  }
  ctx.logger?.info?.(`mail-widget: 挂件页面 ${activePort ? `http://127.0.0.1:${activePort}/` : '未启动'}`)
}

function formatList(items) {
  if (!items.length) return ''
  const names = items.slice(0, 3).map((item) => `${item.name}（${item.subject}）`)
  return '：' + names.join('、') + (items.length > 3 ? ' 等' : '')
}

// ---------------------------------------------------------------------------
// 挂件页面（本地 HTTP 服务）
// ---------------------------------------------------------------------------

function sendJSON(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    request.on('error', reject)
  })
}

export function startWidgetServer(preferredPort) {
  const handler = async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1')

    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = fs.readFileSync(path.join(here, 'widget.html'))
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': html.length,
          'cache-control': 'no-store'
        })
        response.end(html)
        return
      }

      if (request.method === 'GET' && url.pathname === '/api/presets') {
        return sendJSON(response, 200, { providers: PROVIDERS })
      }

      if (request.method === 'GET' && url.pathname === '/api/config') {
        return sendJSON(response, 200, { config: maskConfig(loadConfig()) })
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        const config = loadConfig()
        if (!config) return sendJSON(response, 200, { configured: false })
        const data = await fetchInbox(config, config.maxRows)
        return sendJSON(response, 200, { configured: true, ...data, updatedAt: new Date().toISOString() })
      }

      if (request.method === 'POST' && url.pathname === '/api/config') {
        const body = await readBody(request)
        if (!body.host || !body.user || !body.password) {
          return sendJSON(response, 400, { error: '服务器、账号、密码都要填' })
        }
        const config = saveConfig(body)
        try {
          const data = await fetchInbox(config, 1)
          return sendJSON(response, 200, { ok: true, message: `连接成功，当前 ${data.totalUnread} 封未读` })
        } catch (error) {
          return sendJSON(response, 200, { ok: false, error: error.message })
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/mark-all-read') {
        const config = loadConfig()
        if (!config) return sendJSON(response, 400, { error: '还没有配置邮箱' })
        try {
          const marked = await markAllRead(config)
          return sendJSON(response, 200, { ok: true, marked })
        } catch (error) {
          return sendJSON(response, 500, { error: error.message })
        }
      }

      return sendJSON(response, 404, { error: 'not found' })
    } catch (error) {
      return sendJSON(response, 500, { error: error.message || '服务器错误' })
    }
  }

  return listen(preferredPort, handler, 0)
}

function listen(port, handler, attempt) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && attempt < 10) {
        resolve(listen(port + 1, handler, attempt + 1))
        return
      }
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}
