#!/usr/bin/env node
/**
 * Everything down — MCP server（stdio）
 *
 * 给 Codex / WorkBuddy / Claude Desktop 这类支持 MCP 的客户端用。
 * 这一层只做"翻译"：所有活交给本机面板（127.0.0.1:7788）干，
 * 队列、去重、下载、转写都在面板里，不另起一套，避免两边抢同一个任务文件。
 *
 * 协议：JSON-RPC 2.0，逐行分隔（MCP stdio transport）。
 * stdout 只能输出协议消息，日志一律走 stderr。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANEL_SCRIPT = join(HERE, 'panel.js')
// 面板端口从 7788 起找；ED_MCP_PORT_BASE 可改起点（多套环境并存时用）
const PORT_BASE = Number(process.env.ED_MCP_PORT_BASE || 7788)
const PORTS = []
for (let p = PORT_BASE; p <= PORT_BASE + 12; p++) PORTS.push(p)
const VERSION = '0.4.0'

let panelUrl = ''
let starting = null

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
function log(msg) { try { process.stderr.write('[everything-down-mcp] ' + msg + '\n') } catch (e) {} }

async function pingPort(port) {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(function () { ctrl.abort() }, 700)
    const r = await fetch('http://127.0.0.1:' + port + '/api/ping', { signal: ctrl.signal })
    clearTimeout(timer)
    if (!r.ok) return false
    const j = await r.json()
    return !!j && j.app === 'everything-down'
  } catch (e) {
    return false
  }
}

async function findPanel() {
  for (const p of PORTS) {
    if (await pingPort(p)) return 'http://127.0.0.1:' + p
  }
  return ''
}

/** 有面板就复用；没有就自己拉一个（用独立任务文件，免得和 DSH 面板互相覆盖） */
async function ensurePanel() {
  if (panelUrl) return panelUrl
  if (starting) return starting
  starting = (async function () {
    const found = await findPanel()
    if (found) {
      panelUrl = found
      log('reuse panel ' + found)
      return found
    }
    log('starting panel on ' + PORTS[0] + ' …')
    const child = spawn(process.execPath, [PANEL_SCRIPT, String(PORTS[0])], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { ED_TASKS_SUFFIX: '-mcp' })
    })
    child.unref()
    for (let i = 0; i < 60; i++) {
      await sleep(500)
      const hit = await findPanel()
      if (hit) {
        panelUrl = hit
        log('panel ready ' + hit)
        return hit
      }
    }
    throw new Error('面板没起来，可能端口都被占用了')
  })().finally(function () { starting = null })
  return starting
}

async function api(path, opts) {
  const base = await ensurePanel()
  const init = Object.assign({ cache: 'no-store' }, opts || {})
  if (init.body && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body)
    init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {})
  }
  const r = await fetch(base + path, init)
  const text = await r.text()
  try { return JSON.parse(text) } catch (e) { return { ok: false, message: text.slice(0, 300) } }
}

// ------------------------------------------------------------------ 工具实现

async function toolPanel() {
  const url = await ensurePanel()
  return { text: '面板地址：' + url + '\n完整工作台用浏览器打开这个地址即可；MCP 只是遥控器，队列和下载都在面板里。' }
}

async function toolParse(args) {
  const url = String(args.url || '').trim()
  if (!url) throw new Error('要传 url')
  const r = await api('/api/parse', { method: 'POST', body: { url: url } })
  if (!r.ok) {
    const hint = /没有找到视频流|no-media/.test(String(r.note || '')) ? '\n如果是图文（图集）作品，改用 ed_gallery 试试。' : ''
    return { text: '解析失败：' + (r.note || '未知原因') + hint, error: true }
  }
  const line = '《' + (r.title || '未命名') + '》' + (r.platform ? ' · ' + r.platform : '') +
    (r.duration ? ' · ' + r.duration + ' 秒' : '') + (r.note ? '\n' + r.note : '')
  return { text: line + '\n要下载就调 ed_download。', data: r }
}

async function toolDownload(args) {
  const url = String(args.url || '').trim()
  if (!url) throw new Error('要传 url')
  const body = { url: url }
  if (args.filename) body.filename = String(args.filename).replace(/\.mp4$/i, '')
  const r = await api('/api/download', { method: 'POST', body: body })
  if (!r.ok) return { text: '入队失败：' + (r.message || ''), error: true }
  return { text: '已入队：' + (r.task.title || r.task.url) + '\n任务 id：' + r.task.id + '\n用 ed_tasks 查进度。', data: r.task }
}

async function toolBatch(args) {
  const text = String(args.text || args.url || '').trim()
  if (!text) throw new Error('要传 text（可多行链接）')
  const r = await api('/api/batch', { method: 'POST', body: { text: text } })
  if (!r.ok) return { text: '入队失败：' + (r.message || ''), error: true }
  return { text: '已入队 ' + r.count + ' 条，用 ed_tasks 查进度。', data: r }
}

async function toolTasks(args) {
  const action = String(args.action || 'list')
  if (action === 'list') {
    const st = await api('/api/state')
    const all = st.tasks || []
    const list = all.slice(0, 30)
    const lines = list.map(function (t) {
      const pct = t.total ? Math.round(t.got / t.total * 100) : (t.status === 'done' ? 100 : 0)
      return '[' + t.status + '] ' + String(t.title || t.url).slice(0, 40) + ' · ' + pct + '%' +
        (t.error ? ' — ' + t.error : '')
    })
    return { text: '共 ' + all.length + ' 条（显示最近 ' + list.length + '）\n' + lines.join('\n') }
  }
  const id = String(args.id || '').trim()
  if (!id) throw new Error('这个操作要传 id')
  const r = await api('/api/task', { method: 'POST', body: { id: id, action: action } })
  return { text: r.ok ? ('已' + action + '：' + (r.message || (r.task && r.task.title) || id)) : ('操作失败：' + (r.message || '')), error: !r.ok }
}

async function authorResolve(url) {
  const start = await api('/api/author', { method: 'POST', body: { url: url } })
  if (!start.ok) throw new Error(start.message || '提交解析失败')
  let job = null
  for (let i = 0; i < 200; i++) {
    await sleep(1500)
    const r = await api('/api/author?id=' + encodeURIComponent(start.id) + '&meta=1')
    if (!r.ok) throw new Error(r.message || '解析中断')
    job = r.job
    if (job.status !== 'running') break
  }
  if (!job) throw new Error('没拿到解析结果')
  if (job.status === 'error') throw new Error(job.error || '解析失败')
  const full = await api('/api/author?id=' + encodeURIComponent(start.id))
  return { id: start.id, job: job, videos: (full.job && full.job.videos) || [] }
}

async function toolAuthor(args) {
  const url = String(args.url || '').trim()
  if (!url) throw new Error('要传作者主页 url')
  const got = await authorResolve(url)
  const a = got.job.author || {}
  const head = '《' + (a.nickname || '作者') + '》主页 ' + (a.awemeCount || got.videos.length) + ' 条，抓到 ' + got.videos.length + ' 条' +
    (got.job.loggedIn ? '' : '（未登录，只有前几条；让用户在面板点「登录抖音」扫码）')
  if (String(args.action || 'list') !== 'download') {
    const sample = got.videos.slice(0, 20).map(function (v, i) {
      return (i + 1) + '. ' + String(v.title || '无标题').slice(0, 36)
    })
    return { text: head + '\n' + sample.join('\n'), data: { author: a, total: got.videos.length } }
  }
  const limit = Number(args.limit || 0)
  const ids = limit > 0 ? got.videos.slice(0, limit).map(function (v) { return v.id }) : []
  const r = await api('/api/author/download', { method: 'POST', body: { id: got.id, ids: ids } })
  if (!r.ok) return { text: '入队失败：' + (r.message || ''), error: true }
  return {
    text: head + '\n已排入下载 ' + r.queued + ' 条' + (r.dup ? '，跳过重复 ' + r.dup + ' 条' : '') +
      (r.skipped ? '，图文暂不支持 ' + r.skipped + ' 条' : '') + '\n用 ed_tasks 查进度。',
    data: r
  }
}

async function toolGallery(args) {
  const url = String(args.url || '').trim()
  if (!url) throw new Error('要传图文链接 url')
  const r = await api('/api/gallery', { method: 'POST', body: { url: url } })
  if (!r.ok) return { text: '解析失败：' + (r.message || ''), error: true }
  const head = '《' + String(r.title || '图文').slice(0, 40) + '》' + r.platform + ' · ' + r.images.length + ' 张'
  const urls = r.images.slice(0, 10).map(function (x, i) { return (i + 1) + '. ' + x.url })
  return {
    text: head + '\n' + urls.join('\n') + (r.images.length > 10 ? '\n…' : '') +
      '\n要保存用 ed_gallery_download（images 传这些 url）。',
    data: { platform: r.platform, title: r.title, count: r.images.length }
  }
}

async function toolGalleryDownload(args) {
  const images = Array.isArray(args.images) ? args.images.filter(function (u) { return typeof u === 'string' }) : []
  if (!images.length) throw new Error('要传 images（图片 URL 数组）')
  const body = {
    url: String(args.url || ''),
    platform: String(args.platform || 'douyin'),
    title: String(args.title || '图文'),
    images: images
  }
  const r = await api('/api/gallery/download', { method: 'POST', body: body })
  if (!r.ok) return { text: '保存失败：' + (r.message || ''), error: true }
  return { text: '已保存 ' + r.saved + ' 张' + (r.failed ? '，失败 ' + r.failed + ' 张' : '') + '\n目录：' + r.dir, data: r }
}

async function toolSettings(args) {
  if (args.set && typeof args.set === 'object') {
    const r = await api('/api/settings', { method: 'POST', body: args.set })
    if (!r.ok) return { text: '保存失败：' + (r.message || ''), error: true }
    const s = r.settings || {}
    return { text: '已保存。当前关键设置：保存目录 ' + (s.saveDir || '') + ' · 并发 ' + (s.concurrency || '') + ' · 打开方式 ' + (s.openWith || 'default') }
  }
  const r = await api('/api/settings')
  const s = r.settings || {}
  return {
    text: '保存目录：' + (s.saveDir || '') + '\n按平台分文件夹：' + !!s.byPlatform + '\n并发：' + (s.concurrency || '') +
      '\n打开方式：' + (s.openWith || 'default') + '\n下载后自动转写：' + !!(s.transcribe && s.transcribe.enabled) +
      '\n（要改就调 ed_settings 带 set，例如 {"set":{"concurrency":4}}）'
  }
}

const TOOLS = [
  {
    name: 'ed_panel',
    description: '拿到本机工作台面板的地址（没有就自动启动一个）。想看完整界面、登录抖音、手动挑作品时用。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'ed_parse',
    description: '解析抖音/快手/小红书/B站/TikTok/YouTube 等分享链接，返回标题、平台、时长，不下载。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '链接或整段分享文案' } },
      required: ['url']
    }
  },
  {
    name: 'ed_download',
    description: '把一条链接加入下载队列（面板里执行，支持断点续传与失败重试）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '链接或分享文案' },
        filename: { type: 'string', description: '可选，自定义文件名（不含扩展名）' }
      },
      required: ['url']
    }
  },
  {
    name: 'ed_batch',
    description: '一次粘贴多行链接，全部加入下载队列。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '多行文本，里面可以混着分享文案' } },
      required: ['text']
    }
  },
  {
    name: 'ed_tasks',
    description: '查看下载队列进度，或对某条任务重试/移除/打开文件夹。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'retry', 'remove', 'open'], description: '默认 list' },
        id: { type: 'string', description: 'retry/remove/open 时必填' }
      }
    }
  },
  {
    name: 'ed_author',
    description: '抖音作者主页：列出该主页的全部作品；action=download 时把作品加入下载队列。作品多需要先在面板扫码登录。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '作者主页链接或分享文案' },
        action: { type: 'string', enum: ['list', 'download'], description: '默认 list' },
        limit: { type: 'integer', description: 'download 时最多下多少条，默认全部' }
      },
      required: ['url']
    }
  },
  {
    name: 'ed_gallery',
    description: '解析图文（图集）作品，返回全部图片地址。支持抖音、快手、小红书。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '图文链接或分享文案' } },
      required: ['url']
    }
  },
  {
    name: 'ed_gallery_download',
    description: '把图文作品里的图片保存到本地（传 ed_gallery 返回的图片地址）。',
    inputSchema: {
      type: 'object',
      properties: {
        images: { type: 'array', items: { type: 'string' }, description: '图片地址数组' },
        title: { type: 'string', description: '标题，用来建文件夹' },
        platform: { type: 'string', description: '平台标识：douyin / kuaishou / xhs' },
        url: { type: 'string', description: '原作品链接（可选）' }
      },
      required: ['images']
    }
  },
  {
    name: 'ed_settings',
    description: '查看或修改设置（保存目录、并发、打开方式、是否自动转写）。',
    inputSchema: {
      type: 'object',
      properties: { set: { type: 'object', description: '要改的字段，例如 {"concurrency":4}' } }
    }
  }
]

const HANDLERS = {
  ed_panel: toolPanel,
  ed_parse: toolParse,
  ed_download: toolDownload,
  ed_batch: toolBatch,
  ed_tasks: toolTasks,
  ed_author: toolAuthor,
  ed_gallery: toolGallery,
  ed_gallery_download: toolGalleryDownload,
  ed_settings: toolSettings
}

// ------------------------------------------------------------------ 协议

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } })
}

async function handleMessage(msg) {
  const method = msg.method
  const id = msg.id
  const params = msg.params || {}

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'everything-down', version: VERSION }
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params.name
    const handler = HANDLERS[name]
    if (!handler) return replyError(id, -32602, '未知工具：' + name)
    try {
      const out = await handler(params.arguments || {})
      return reply(id, {
        content: [{ type: 'text', text: String(out.text || '') }],
        isError: !!out.error
      })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: '执行失败：' + String(e.message || e) }], isError: true })
    }
  }
  if (method === 'notifications/initialized') return
  if (id !== undefined) return replyError(id, -32601, '不支持的方法：' + method)
}

const rl = createInterface({ input: process.stdin })
let chain = Promise.resolve()
rl.on('line', function (line) {
  const text = String(line || '').trim()
  if (!text) return
  chain = chain.then(async function () {
    let msg = null
    try { msg = JSON.parse(text) } catch (e) { log('bad json: ' + text.slice(0, 120)); return }
    try { await handleMessage(msg) } catch (e) { log('handler error: ' + String(e.message || e)) }
  })
})
rl.on('close', function () { process.exit(0) })
process.on('SIGTERM', function () { process.exit(0) })
log('server started, waiting for requests')
