/**
 * Everything down — DeepSeek Harness 插件入口
 * 注册下载工具，并起一个本地面板服务（默认 http://127.0.0.1:7788）。
 */
import { startServer, parseUrl, loadSettings, saveSettings, setHostSpeech, enqueueAuthorVideos } from './server.js'
import { listAuthor } from './engine.js'

export const name = 'dsh-everything-down'
export const inject = ['tools']

// 最后一道保险：这个插件跑在宿主进程里，一个漏网的异常会让用户看到「DSH 闪退」。
// 只有当宿主自己没装处理器时才接管，避免覆盖宿主的退出语义。
if (process.listenerCount('uncaughtException') === 0) {
  process.on('uncaughtException', function (e) {
    try { console.error('[everything-down] uncaughtException: ' + (e && e.stack ? e.stack : e)) } catch (err) {}
  })
}
if (process.listenerCount('unhandledRejection') === 0) {
  process.on('unhandledRejection', function (e) {
    try { console.error('[everything-down] unhandledRejection: ' + (e && e.stack ? e.stack : e)) } catch (err) {}
  })
}

let panelUrl = ''
let srv = null

function ensurePanel() {
  if (panelUrl) return Promise.resolve(panelUrl)
  let cfgPort = 0
  try { cfgPort = Number(loadSettings().panelPort || 0) } catch (e) {}
  const port = Number(process.env.ED_PORT || cfgPort || 7788)
  return startServer({ port: port }).then(function (r) {
    srv = r
    panelUrl = r.url
    return panelUrl
  }).catch(function () { return '' })
}

function tool(name, description, parameters, run) {
  return {
    name: name,
    description: description,
    parameters: parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: function (_a, v) { return [{ type: 'text', text: typeof v === 'string' ? v : (v.message || 'ok') }] }
    },
    execute: run
  }
}

export function apply(ctx) {
  // 宿主自带的本地语音识别服务（SenseVoice）；没有就退回让用户填 key
  try {
    const stt = ctx.get('speechToText')
    if (stt) setHostSpeech(stt)
  } catch (e) { /* 宿主没装语音能力，忽略 */ }

  const disposers = []
  const reg = function (t) {
    disposers.push(ctx.effect(function () { return ctx.tools.register(t) }, 'everything-down: ' + t.name))
  }

  reg(tool('ed_parse',
    '解析抖音/快手/小红书/B站等分享链接（也接受整段分享文案），返回标题、平台与可下载的视频流。',
    {
      type: 'object',
      properties: { url: { type: 'string', description: '链接或整段分享文案' } },
      required: ['url']
    },
    async function (args) {
      const r = await parseUrl(args.url, loadSettings())
      return Object.assign({ message: r.ok ? ('《' + r.title + '》 ' + (r.note || '')) : (r.note || '解析失败') }, r)
    }
  ))

  reg(tool('ed_download',
    '把链接加入下载队列，自动选择保存目录并下载（抖音会合并音轨，输出无水印 mp4）。',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: '链接或分享文案' },
        filename: { type: 'string', description: '可选，自定义文件名（不含扩展名）' }
      },
      required: ['url']
    },
    async function (args) {
      await ensurePanel()
      const mod = await import('./server.js')
      const q = srv ? srv.queue : null
      const r = await parseUrl(args.url, loadSettings())
      if (!r.streams) return { ok: false, message: r.note || '解析失败' }
      if (!q) return { ok: false, message: '面板服务未启动' }
      const t = q.enqueue(r.url, { parsed: r, filename: args.filename ? args.filename + '.mp4' : '' })
      return { ok: true, task: t, message: '已加入队列：' + (t.title || t.url) }
    }
  ))

  reg(tool('ed_tasks',
    '查看/管理下载任务：list 列表，retry 重试，remove 移除，open 打开所在文件夹。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'retry', 'remove', 'open'] },
        id: { type: 'string', description: '任务 id（retry/remove/open 时必填）' }
      }
    },
    async function (args) {
      await ensurePanel()
      const q = srv ? srv.queue : null
      if (!q) return { ok: false, message: '面板服务未启动' }
      if (!args.action || args.action === 'list') return { ok: true, tasks: q.list() }
      const t = q.action(args.id, args.action)
      return { ok: !!t, task: t }
    }
  ))

  reg(tool('ed_settings',
    '读取或修改设置（保存目录 saveDir、按平台分文件夹 byPlatform、按日期 byDate、命名 naming、并发 concurrency）。',
    {
      type: 'object',
      properties: {
        saveDir: { type: 'string' },
        byPlatform: { type: 'boolean' },
        byDate: { type: 'boolean' },
        naming: { type: 'string', enum: ['platform_title', 'title', 'time'] },
        concurrency: { type: 'integer' },
        openAfter: { type: 'boolean' }
      }
    },
    async function (args) {
      const keys = Object.keys(args || {})
      if (!keys.length) return { ok: true, settings: loadSettings() }
      return { ok: true, settings: saveSettings(args) }
    }
  ))

  reg(tool('ed_panel',
    '取得面板地址并确保服务已启动（用于在浏览器里打开可视化界面）。',
    { type: 'object', properties: {} },
    async function () {
      const url = await ensurePanel()
      return { ok: !!url, url: url, message: url ? ('面板已启动：' + url) : '面板启动失败（端口可能被占用）' }
    }
  ))

  reg(tool('ed_author',
    '抖音作者主页：列出该主页的全部作品；action=download 时把作品加入下载队列。作品太多的作者需要先在面板点「登录抖音」扫码，否则只能拿到前几条。',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: '作者主页链接或整段分享文案' },
        action: { type: 'string', enum: ['list', 'download'], description: 'list=只列出来（默认），download=顺手加入下载队列' },
        limit: { type: 'integer', description: 'download 时最多下载多少条，默认全部' }
      },
      required: ['url']
    },
    async function (args) {
      await ensurePanel()
      const r = await listAuthor(args.url, {})
      const head = '《' + (r.author.nickname || '抖音作者') + '》抓到 ' + r.videos.length +
        ' 条（主页显示 ' + (r.author.awemeCount || r.videos.length) + ' 条' + (r.loggedIn ? '' : '，未登录只能拿前几条') + '）'
      if (args.action !== 'download') {
        return {
          ok: true, message: head, author: r.author, loggedIn: r.loggedIn,
          total: r.videos.length, videos: r.videos.slice(0, 100)
        }
      }
      if (!srv || !srv.queue) return { ok: false, message: '面板服务未启动' }
      const ids = Number(args.limit || 0) > 0 ? r.videos.slice(0, Number(args.limit)).map(function (v) { return v.id }) : []
      const res = enqueueAuthorVideos({ videos: r.videos, author: r.author }, ids, srv.queue)
      let msg = head + '，已排队 ' + res.queued + ' 条'
      if (res.dup) msg += '，跳过重复 ' + res.dup + ' 条'
      if (res.skipped) msg += '，图文作品暂不支持 ' + res.skipped + ' 条'
      return { ok: true, message: msg, queued: res.queued, dup: res.dup, skipped: res.skipped }
    }
  ))

  // 设置页（浏览器半侧）要先知道面板到底起在哪个端口：
  // 7788 被占用时 startServer 会顺延，写死就会嵌错页面。
  // 这里走宿主自带 webServer 挂一个同源接口，Electron（file://）没有这个服务就跳过，前端会退回默认值。
  try {
    const ws = ctx.get('webServer')
    if (ws && typeof ws.register === 'function') {
      ctx.effect(function () {
        return ws.register({
          kind: 'exact',
          path: '/everything-down/panel',
          handler: function (req, res) {
            const body = JSON.stringify({
              ok: !!panelUrl,
              url: panelUrl || '',
              port: srv ? srv.port : 0,
              hint: panelUrl ? '' : '面板还没启动完，稍等一秒'
            })
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store'
            })
            res.end(body)
          }
        })
      }, 'everything-down: panel address')
    }
  } catch (e) { /* 没有 webServer 的宿主（Electron）忽略 */ }

  ensurePanel()

  return function () {
    for (const d of disposers) { try { if (typeof d === 'function') d() } catch (e) {} }
    if (srv && srv.server) { try { srv.server.close() } catch (e) {} }
    panelUrl = ''
  }
}
