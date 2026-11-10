/** 验证插件入口：apply 能注册两个工具并启动挂件服务 */
import { apply } from '../lib/index.js'

const tools = []
const ctx = {
  tools: { register: (tool) => tools.push(tool) },
  effect: (fn) => { fn() },
  logger: { info: () => {}, warn: () => {} }
}

process.env.DSH_HOME = '/tmp/mailwidget-home'
await apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 400))

const names = tools.map((tool) => tool.name).sort()
console.log('registered tools:', names.join(', '))
const ok = names.length === 2 && names.includes('mail_unread') && names.includes('mail_mark_all_read')
console.log(ok ? '✓ apply 注册正常' : '✗ apply 注册异常')

const res = await fetch('http://127.0.0.1:47823/api/state')
const data = await res.json()
console.log('✓ 挂件接口可用，未读数 =', data.totalUnread)
process.exit(ok ? 0 : 1)
