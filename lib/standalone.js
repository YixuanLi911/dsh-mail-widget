/** 独立运行挂件页面（不依赖 DSH），便于调试和截图 */
import { startWidgetServer } from './index.js'

const port = Number(process.env.PORT) || 47823
startWidgetServer(port).then(({ server, port: actual }) => {
  console.log(`dsh-mail-widget 挂件页面：http://127.0.0.1:${actual}/`)
  server.on('close', () => process.exit(0))
})
