#!/usr/bin/env node
/**
 * 独立启动面板（不依赖 DSH 宿主，方便直接测试）：
 *   node bin/panel.js [端口]
 */
import { startServer } from '../lib/server.js'

process.title = 'everything-down-panel'
const port = Number(process.argv[2] || process.env.ED_PORT || 7788)
startServer({ port: port }).then(function (r) {
  console.log('Everything down 面板已启动: ' + r.url)
  console.log('按 Ctrl+C 停止')
}).catch(function (e) {
  console.error('启动失败: ' + (e && e.message ? e.message : e))
  process.exit(1)
})
