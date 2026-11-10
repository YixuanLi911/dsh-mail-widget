/**
 * 端到端测试：解析 + 分段 + 标记已读，跑在本地假 IMAP 服务器上。
 * 用法：node test/run.js
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchInbox, markAllRead, decodeWords, parseAddress, splitSections } from '../lib/mail.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = 11431
const config = {
  host: '127.0.0.1',
  port: PORT,
  user: 'test@example.com',
  password: 'secret',
  folder: 'INBOX',
  useTLS: false,
  maxRows: 4
}

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name} ${detail}`)
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [path.join(here, 'fake_imap.py'), String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) resolve(child)
    })
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('error', reject)
    setTimeout(() => resolve(child), 1500)
  })
}

console.log('解析')
check('UTF-8 Base64 姓名', decodeWords('=?UTF-8?B?5byg5pWZ5o6I?=') === '张教授')
check('相邻编码字', decodeWords('=?UTF-8?B?5L2g5aW9?= =?UTF-8?B?5LiW55WM?=') === '你好世界')
check('Q 编码', decodeWords('=?UTF-8?Q?=E4=BD=A0=E5=A5=BD?=') === '你好')
check('裸地址', (() => { const a = parseAddress('notices@github.com'); return a.address === 'notices@github.com' && a.name === 'notices@github.com' })())
check('带引号姓名', parseAddress('"Smith, John" <john@example.com>').name === 'Smith, John')

const server = await startServer()
try {
  console.log('\nIMAP 端到端')
  const data = await fetchInbox(config, 4)
  check('未读总数', data.totalUnread === 4, `实际 ${data.totalUnread}`)
  check('近 7 天 2 封', data.week.count === 2, `实际 ${data.week.count}`)
  check('近一个月 2 封', data.month.count === 2, `实际 ${data.month.count}`)
  const names = [...data.week.items, ...data.month.items].map((item) => item.name)
  check('中文发件人解析', ['张老师', '李老师', '王老师'].every((name) => names.includes(name)), names.join(','))
  check('主题解码', data.week.items.some((item) => item.subject.includes('毕业设计')))

  const marked = await markAllRead(config)
  check('标记已读数量', marked === 4, `实际 ${marked}`)
  const after = await fetchInbox(config, 4)
  check('标记后没有未读', after.totalUnread === 0, `实际 ${after.totalUnread}`)
} finally {
  server.kill()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
