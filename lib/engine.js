/**
 * Everything down — 下载引擎
 *
 * 浏览器常驻：一次启动、多次复用，省掉每次 1~2 秒的冷启动。
 * 早停：一旦抓到视频流立刻收工，不再傻等满时长。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, statSync, createWriteStream, unlinkSync, renameSync, copyFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// 可执行文件探测：环境变量 > PATH > 常见安装位置 > 裸命令名。
// 这里刻意不写任何个人路径：别的用户机器上那串路径根本不存在。
// 探测不到时保底返回裸命令名，让 spawn 的 error 分支去报错，不在模块加载期抛异常。
function commandInPath(name) {
  const dirs = String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        const full = join(dir, name + ext)
        if (existsSync(full)) return full
      } catch (e) {}
    }
  }
  return ''
}

function binCandidates(envKey, name, extra) {
  const list = []
  const fromEnv = process.env[envKey]
  if (fromEnv) list.push(fromEnv)
  const inPath = commandInPath(name)
  if (inPath) list.push(inPath)
  for (const p of extra || []) list.push(p)
  list.push(name)
  return list
}

const CHROME = binCandidates('ED_CHROME', 'chrome', [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
])
const FFMPEG = binCandidates('ED_FFMPEG', 'ffmpeg', [
  'C:/ffmpeg/bin/ffmpeg.exe',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg'
])
const YTDLP = binCandidates('ED_YTDLP', 'yt-dlp', [
  join(homedir(), 'AppData/Local/Programs/Python/Python312/Scripts/yt-dlp.exe'),
  '/opt/homebrew/bin/yt-dlp',
  '/usr/local/bin/yt-dlp',
  '/usr/bin/yt-dlp'
])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const WX_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN'

export function pick(list) {
  for (const p of list) {
    if (p.indexOf('/') >= 0 || p.indexOf('\\') >= 0) { if (existsSync(p)) return p }
    else return p
  }
  return list[list.length - 1]
}

/**
 * 浏览器到底找没找到。返回可用路径，找不到返回 ''。
 * 给面板和解析失败提示用：区分「链接没戏」和「你机器上压根没有浏览器」。
 */
export function browserFound() {
  const candidate = pick(CHROME)
  if (!candidate) return ''
  if (candidate.indexOf('/') >= 0 || candidate.indexOf('\\') >= 0) {
    return existsSync(candidate) ? candidate : ''
  }
  return commandInPath(candidate) || ''
}

export function platformOf(url) {
  const u = String(url || '').toLowerCase()
  if (/ixigua\.com/.test(u)) return 'xigua'
  if (/douyin\.com|iesdouyin/.test(u)) return 'douyin'
  if (/kuaishou\.com|gifshow\.com|chenzhongtech/.test(u)) return 'kuaishou'
  if (/xiaohongshu\.com|xhslink/.test(u)) return 'xhs'
  if (/bilibili\.com|b23\.tv/.test(u)) return 'bilibili'
  if (/weibo\.(com|cn)/.test(u)) return 'weibo'
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube'
  if (/tiktok\.com/.test(u)) return 'tiktok'
  if (/x\.com|twitter\.com/.test(u)) return 'x'
  if (/instagram\.com/.test(u)) return 'instagram'
  if (/facebook\.com|fb\.watch/.test(u)) return 'facebook'
  return 'other'
}

export function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>()]+/)
  return m ? m[0].replace(/[，。、；：）】]+$/, '') : ''
}

function run(cmd, args, timeoutMs) {
  return new Promise(function (resolvePromise) {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(function () { try { child.kill('SIGKILL') } catch (e) {} }, timeoutMs || 600000)
    child.stdout.on('data', function (d) { out += d.toString('utf8') })
    child.stderr.on('data', function (d) { err += d.toString('utf8') })
    child.on('error', function (e) { clearTimeout(timer); resolvePromise({ code: -1, stdout: out, stderr: err + ' ' + e.message }) })
    child.on('close', function (c) { clearTimeout(timer); resolvePromise({ code: c, stdout: out, stderr: err }) })
  })
}

// ---------------------------------------------------------------- 常驻浏览器

let shared = null

async function waitCdp(port, tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/version')
      if (r.ok) return await r.json()
    } catch (e) { /* not ready */ }
    await new Promise(function (r) { setTimeout(r, 150) })
  }
  return null
}

async function ensureBrowser() {
  if (shared && shared.alive) return shared
  const chrome = pick(CHROME)
  if (!chrome) throw new Error('没有找到 Chrome 或 Edge')
  if (chrome.indexOf('/') >= 0 || chrome.indexOf('\\') >= 0) {
    if (!existsSync(chrome)) throw new Error('浏览器路径不存在：' + chrome)
  }
  const port = 9300 + Math.floor(Math.random() * 500)
  const profile = mkdtempSync(join(tmpdir(), 'ed-'))
  const child = spawn(chrome, [
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--headless=new', '--disable-gpu', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check',
    'about:blank'
  ], { windowsHide: true, stdio: 'ignore' })

  // spawn 失败（没装浏览器、路径不对）会发 'error' 事件。
  // 不接住它 = 未捕获异常 = 整个宿主进程退出，所以这里必须挂。
  let spawnError = null
  child.on('error', function (e) { spawnError = e })
  child.on('exit', function () { /* 正常退出由 waitCdp/close 流程处理 */ })

  const ver = await waitCdp(port, 100)
  if (!ver) {
    try { child.kill('SIGKILL') } catch (e) {}
    try { rmSync(profile, { recursive: true, force: true }) } catch (e) {}
    throw new Error(spawnError
      ? ('浏览器启动失败：' + (spawnError.message || spawnError.code || 'spawn error'))
      : '浏览器启动失败（没等到调试端口，可能被安全软件拦了）')
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  try {
    await new Promise(function (resolvePromise, rejectPromise) {
      const timer = setTimeout(function () { rejectPromise(new Error('浏览器连接超时')) }, 10000)
      ws.addEventListener('open', function () { clearTimeout(timer); resolvePromise() })
      ws.addEventListener('error', function () { clearTimeout(timer); rejectPromise(new Error('浏览器连接失败')) })
    })
  } catch (e) {
    try { child.kill('SIGKILL') } catch (err) {}
    try { rmSync(profile, { recursive: true, force: true }) } catch (err) {}
    throw new Error('浏览器连接失败：' + (e && e.message ? e.message : e))
  }

  let seq = 0
  const pend = new Map()
  const handlers = new Map()  // sessionId -> fn

  ws.addEventListener('message', function (ev) {
    let m = null
    try { m = JSON.parse(ev.data) } catch (e) { return }   // 坏消息直接丢，不能让监听器抛
    if (!m) return
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id)
      if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result)
      return
    }
    if (m.sessionId && handlers.has(m.sessionId)) {
      const fn = handlers.get(m.sessionId)
      try { fn(m) } catch (e) {}
    }
  })

  const send = function (method, params, sessionId) {
    return new Promise(function (res, rej) {
      const id = ++seq
      const timer = setTimeout(function () {
        if (!pend.has(id)) return
        pend.delete(id)
        rej(new Error('CDP 超时：' + method))
      }, 15000)
      pend.set(id, {
        res: function (v) { clearTimeout(timer); res(v) },
        rej: function (e) { clearTimeout(timer); rej(e) }
      })
      try {
        ws.send(JSON.stringify({ id: id, method: method, params: params || {}, sessionId: sessionId }))
      } catch (e) {
        clearTimeout(timer)
        pend.delete(id)
        rej(e)
      }
    })
  }

  const api = {
    child: child,
    ws: ws,
    send: send,
    handlers: handlers,
    profile: profile,
    alive: true,
    justCreated: true,
    lastUsed: Date.now(),
    close: function () {
      api.alive = false
      try { ws.close() } catch (e) {}
      try { child.kill('SIGKILL') } catch (e) {}
      setTimeout(function () { try { rmSync(profile, { recursive: true, force: true }) } catch (e) {} }, 1500)
      if (shared === api) shared = null
    }
  }
  ws.addEventListener('close', function () {
    api.alive = false
    if (shared === api) shared = null
    // 浏览器断了就把所有等着回话的请求全部拒掉，否则下载任务会永久卡在 running
    for (const entry of pend.values()) {
      try { entry.rej(new Error('浏览器已断开')) } catch (e) {}
    }
    pend.clear()
  })

  shared = api
  return api
}

// 常驻浏览器只有一个，批量并发时多个页面会抢资源、互相拖死。
// 这里用一条串行队列，同一时刻只跑一个嗅探。
let sniffLock = Promise.resolve()
export function sniffOne(url, opts) {
  const run = sniffLock.then(function () { return sniff(url, opts) })
  sniffLock = run.then(function () {}, function () {})
  return run
}

export function shutdownBrowser() {
  if (shared) shared.close()
}

function kindOf(url, mime) {
  const m = String(mime || '').toLowerCase()
  const u = String(url || '').toLowerCase()
  if (m.indexOf('mpegurl') >= 0 || /\.m3u8(\?|$)/.test(u)) return 'hls'
  if (m.indexOf('audio/') === 0 || /media-audio|audio-und|audio-track/.test(u) || /\.(m4a|mp3|aac)(\?|$)/.test(u)) return 'audio'
  if (/\.ts(\?|$)/.test(u) || m.indexOf('mp2t') >= 0) return 'segment'
  // B 站 DASH：xxx-1-30216.m4s 这类是音频轨，其余 qn 是视频轨
  if (/-1-302\d{2}\.m4s/.test(u)) return 'audio'
  if (/-1-\d+\.m4s/.test(u)) return 'video'
  if (m.indexOf('video/') === 0 || /media-video|\.(mp4|m4v|mov|flv)(\?|$)/.test(u)) return 'video'
  if (m.indexOf('image/') === 0) return 'image'
  return null
}

const photos = new Map()
export function photosFound() { return [...photos.values()] }
export function resetPhotos() { photos.clear() }

function collectPhotos(node, depth) {
  if (!node || typeof node !== 'object' || (depth || 0) > 6) return
  if (Array.isArray(node)) {
    for (const x of node) collectPhotos(x, (depth || 0) + 1)
    return
  }
  const id = node.photoId || node.id || ''
  const caption = node.caption || node.title || ''
  const urls = []
  const pickUrl = function (v) {
    if (typeof v === 'string' && /^https?:\/\/.+\.(mp4|m3u8)/i.test(v)) urls.push(v)
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (typeof v[k] === 'string' && /^https?:\/\/.+\.(mp4|m3u8)/i.test(v[k])) urls.push(v[k])
      }
    }
  }
  pickUrl(node.photoUrl); pickUrl(node.srcNoMark); pickUrl(node.playUrl)
  pickUrl(node.manifest); pickUrl(node.adaptationSet); pickUrl(node.representation)
  if (id && urls.length) {
    photos.set(String(id), { photoId: String(id), caption: String(caption).slice(0, 120), urls: [...new Set(urls)].slice(0, 6) })
  }
  for (const k of Object.keys(node)) {
    if (node[k] && typeof node[k] === 'object') collectPhotos(node[k], (depth || 0) + 1)
  }
}

/**
 * 打开页面嗅探媒体地址。
 * opts: { waitMs, userAgent, mobile, earlyStop }
 * earlyStop = true 时，一旦出现视频流就提前收工（默认开启）。
 */
export async function sniff(url, opts) {
  const o = opts || {}
  const b = await ensureBrowser()
  const coldStart = !!b.justCreated
  b.justCreated = false
  // 浏览器刚启动那一次，页面首屏更慢，给一点额外时间
  const maxWait = Number(o.waitMs || 15000) + (coldStart ? 7000 : 0)
  b.lastUsed = Date.now()

  const found = new Map()
  const jsonIds = []
  let title = ''
  let earlySrc = ''
  let earlyTitle = ''
  let pageDuration = 0
  let pagePoster = ''
  let firstMediaAt = 0

  const created = await b.send('Target.createTarget', { url: 'about:blank' })
  const targetId = created.targetId
  const attached = await b.send('Target.attachToTarget', { targetId: targetId, flatten: true })
  const sid = attached.sessionId

  b.handlers.set(sid, function (m) {
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response
      const kind = kindOf(r.url, r.mimeType)
      const junk = /douyinstatic\.com|\/obj\/douyin-pc-web\/|uuu_265|\/aweme\/v1\/web\//i.test(r.url)
      if (kind && kind !== 'image' && kind !== 'segment' && !junk && !found.has(r.url)) {
        found.set(r.url, { kind: kind, url: r.url, mime: r.mimeType || '', size: 0 })
        if ((kind === 'video' || kind === 'hls') && !firstMediaAt) firstMediaAt = Date.now()
      }
      const mt = String(r.mimeType || '')
      if ((/json/.test(mt) || /graphql|\/rest\//i.test(r.url)) && jsonIds.length < 12) {
        jsonIds.push({ id: m.params.requestId, url: r.url })
      }
    }
  })

  const cleanupTarget = async function () {
    b.handlers.delete(sid)
    try { await b.send('Target.closeTarget', { targetId: targetId }) } catch (e) {}
  }

  try {
    await b.send('Network.enable', {}, sid)
    await b.send('Page.enable', {}, sid)
    await b.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'Object.defineProperty(navigator,"webdriver",{get:()=>undefined});'
    }, sid)
    if (o.mobile) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sid)
    }
    await b.send('Emulation.setUserAgentOverride', { userAgent: o.userAgent || UA, platform: o.mobile ? 'iPhone' : 'Win32' }, sid)
    await b.send('Page.navigate', { url: url }, sid)

    const startedAt = Date.now()
    let playTriggered = false

    // 轮询：抓够就停，不等满
    while (Date.now() - startedAt < maxWait) {
      await new Promise(function (r) { setTimeout(r, 350) })

      if (!earlySrc) {
        try {
          const e = await b.send('Runtime.evaluate', {
            expression: 'JSON.stringify({src:((document.querySelector("video")||{}).currentSrc)||"", t:document.title})',
            returnByValue: true
          }, sid)
          const v = JSON.parse((e.result || {}).value || '{}')
          const fake = /douyinstatic|uuu_265|\/obj\/douyin-pc-web\//i.test(String(v.src || ''))
          if (v.src && /^https?:/.test(v.src) && !fake) { earlySrc = v.src; earlyTitle = String(v.t || '') }
        } catch (e) { /* ignore */ }
      }

      const wait = Date.now() - startedAt
      if (!playTriggered && wait > (o.mobile ? 2500 : 4000)) {
        playTriggered = true
        try {
          await b.send('Runtime.evaluate', {
            expression: '(() => { const vs = document.querySelectorAll("video"); vs.forEach(v => { try { v.muted = true; v.play().catch(() => {}) } catch (e) {} }); return vs.length })()',
            returnByValue: true
          }, sid)
        } catch (e) { /* ignore */ }
      }

      if (o.earlyStop !== false) {
        // 移动端页面（快手）是单个合并 mp4，currentSrc 一出现就够用了
        if (o.mobile && earlySrc) break
        const hasVideo = [...found.values()].some(function (m) { return m.kind === 'video' || m.kind === 'hls' })
        const hasAudio = [...found.values()].some(function (m) { return m.kind === 'audio' })
        // 视频到手后再给 1.2 秒收音轨，然后收工
        if (hasVideo && (hasAudio || earlySrc) && firstMediaAt && Date.now() - firstMediaAt > 1200) break
        if (hasVideo && Date.now() - firstMediaAt > 2500) break
      }
    }

    try {
      const t = await b.send('Runtime.evaluate', {
        expression: 'JSON.stringify({t:document.title, d:(document.querySelector("video")||{}).duration||0, p:(document.querySelector("video")||{}).poster||""})',
        returnByValue: true
      }, sid)
      const v = JSON.parse((t.result || {}).value || '{}')
      title = String(v.t || '')
      pageDuration = Number(v.d || 0)
      pagePoster = String(v.p || '')
    } catch (e) { /* ignore */ }

    for (const item of jsonIds) {
      try {
        const body = await b.send('Network.getResponseBody', { requestId: item.id }, sid)
        const text = String(body.body || '')
        if (text.length < 40 || text.length > 3000000) continue
        collectPhotos(JSON.parse(text))
      } catch (e) { /* 拿不到就跳过 */ }
    }
  } finally {
    await cleanupTarget()
  }

  const media = [...found.values()]
  const cdn = function (u) { return /douyinvod|kwaicdn|ndcimgs|yximgs|kuaishou|chenzhongtech/i.test(u) ? 0 : 1 }
  const order = { video: 0, hls: 1, audio: 2 }
  media.sort(function (a, b2) {
    const d = (order[a.kind] === undefined ? 9 : order[a.kind]) - (order[b2.kind] === undefined ? 9 : order[b2.kind])
    if (d !== 0) return d
    return cdn(a.url) - cdn(b2.url)
  })

  return {
    title: earlyTitle || title,
    media: media,
    duration: pageDuration,
    poster: pagePoster,
    currentSrc: earlySrc,
    photos: photosFound(),
    elapsedMs: Math.round(Date.now() - (firstMediaAt || Date.now()))
  }
}

// ------------------------------------------------------------------ 下载

function httpFail(status) {
  const e = new Error('HTTP ' + status)
  e.httpStatus = status
  return e
}

/**
 * 下载一次（内部用）：先写 .part，支持 Range 续传，写完再改名成正式文件。
 * 失败时 .part 会留着，下次调用自动从断点接着下。
 */
async function downloadOnce(url, file, o) {
  const part = file + '.part'
  mkdirSync(dirname(file), { recursive: true })
  const headers = {
    'user-agent': o.userAgent || UA,
    referer: o.referer || 'https://www.douyin.com/',
    accept: '*/*'
  }
  let startByte = 0
  try {
    if (existsSync(part)) {
      const s = statSync(part).size
      if (s > 0) startByte = s
    }
  } catch (e) {}
  if (startByte > 0) headers.range = 'bytes=' + startByte + '-'

  const r = await fetch(url, { headers })
  // 416：说明 .part 已经是完整文件（上一次改名失败留下的），直接收尾
  if (r.status === 416 && startByte > 0) {
    try { await r.body?.cancel() } catch (e) {}
    try { renameSync(part, file); return { size: startByte, total: startByte, resumed: true } } catch (e) {}
  }
  if (!r.ok && r.status !== 206) throw httpFail(r.status)
  if (!r.body) throw new Error('服务器没有返回数据')

  let total = 0
  if (r.status === 206) {
    const cr = r.headers.get('content-range') || ''
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(cr)
    if (!m || Number(m[1]) !== startByte) {
      try { await r.body.cancel() } catch (e) {}
      throw new Error('续传区间对不上，重新下载')
    }
    total = Number(m[3]) || 0
    if (total && startByte >= total) {
      try { await r.body.cancel() } catch (e) {}
      try { renameSync(part, file); return { size: startByte, total: total, resumed: true } } catch (e) {}
    }
  } else {
    // 200：服务端没理 Range，返回的是完整内容，从头写
    if (startByte > 0) { try { unlinkSync(part) } catch (e) {} }
    startByte = 0
    total = Number(r.headers.get('content-length') || 0)
  }

  let got = startByte
  if (o.onProgress) { try { o.onProgress(got, total) } catch (e) {} }
  const stream = Readable.fromWeb(r.body)
  stream.on('data', function (chunk) {
    got += chunk.length
    if (o.onProgress) o.onProgress(got, total)
  })
  await pipeline(stream, createWriteStream(part, { flags: startByte > 0 ? 'a' : 'w' }))

  // CDN 中途断流 HTTP 层不报错，必须自己核对大小；对不上就抛，交给上层重试（.part 留着）
  let size = 0
  try { size = statSync(part).size } catch (e) {}
  if (total > 0 && size < total * 0.98) {
    throw new Error('下载不完整（' + Math.round(size / 1024) + 'KB / ' + Math.round(total / 1024) + 'KB）')
  }
  try {
    renameSync(part, file)
  } catch (e) {
    copyFileSync(part, file)
    try { unlinkSync(part) } catch (err) {}
  }
  return { size: size, total: total, resumed: startByte > 0 }
}

/**
 * 下载文件（外层）：断点续传 + 网络类错误自动重试。
 * 4xx（直链过期这类）不重试，直接抛给上层去重新解析。
 */
export async function downloadFile(url, file, opts) {
  const o = opts || {}
  const tries = Math.max(1, Number(o.retries || 3))
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    try {
      return await downloadOnce(url, file, o)
    } catch (e) {
      lastErr = e
      const st = Number(e.httpStatus || 0)
      const permanent = st >= 400 && st < 500 && st !== 408 && st !== 429
      if (permanent) break
      if (i < tries - 1) await new Promise(function (r) { setTimeout(r, 600 * Math.pow(2, i)) })
    }
  }
  throw lastErr
}

export async function merge(video, audio, out) {
  const r = await run(pick(FFMPEG), ['-y', '-loglevel', 'error', '-i', video, '-i', audio, '-c', 'copy', '-movflags', '+faststart', out], 900000)
  if (r.code !== 0) throw new Error('合并失败：' + r.stderr.slice(-300))
  return out
}

/**
 * yt-dlp 的公共参数。
 * proxy 来自设置（国内不填；要用境外平台时填本机代理，比如 http://127.0.0.1:7890，
 * 开了全局 VPN 就不用填）。
 */
export function ytdlpArgs(settings, extra) {
  const a = ['--no-warnings', '--no-playlist']
  const proxy = String((settings && settings.proxy) || '').trim()
  if (proxy) a.push('--proxy', proxy)
  return extra ? a.concat(extra) : a
}

/**
 * TikTok 专用：必须伪装 Chrome 的 TLS 指纹，否则网页接口返回壳页面
 * （报 Unexpected response from webpage request）。
 * 需要本机 Python 装了 curl_cffi，没装的话 yt-dlp 会直接报错，回退到浏览器嗅探。
 */
export function tiktokArgs(settings, extra) {
  return ytdlpArgs(settings, ['--impersonate', 'chrome']).concat(extra || [])
}

export function safeName(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[，。！？、；：""''《》【】（）!?,;:()]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim()
    .slice(0, 42) || ('video_' + Date.now())
}

// ------------------------------------------------------------------ 作者主页
//
// 抖音主页列表是页面自己算签名的：直接请求 /aweme/v1/web/aweme/post/ 会被
// ArgusSecurityPlugin 拦成 403，所以照旧用浏览器打开页面，截它自己发的请求，
// 再靠滚动翻页。未登录时平台只给首页那几条（has_more=0），要完整列表必须登录，
// 所以这里的浏览器用户目录是固定的，登录态能留到下次。

const DATA_DIR_ED = join(homedir(), '.everything-down')
export const AUTHOR_PROFILE = join(DATA_DIR_ED, 'chrome')
const AUTHOR_PORT = 9334

let authorConn = null
let authorOwned = null

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

async function cdpVersionOnce(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/version')
    if (r.ok) return await r.json()
  } catch (e) {}
  return null
}

async function connectCdp(ver) {
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise(function (resolvePromise, rejectPromise) {
    const timer = setTimeout(function () { rejectPromise(new Error('浏览器连接超时')) }, 10000)
    ws.addEventListener('open', function () { clearTimeout(timer); resolvePromise() })
    ws.addEventListener('error', function () { clearTimeout(timer); rejectPromise(new Error('浏览器连接失败')) })
  })
  let seq = 0
  const pend = new Map()
  const handlers = new Map()
  ws.addEventListener('message', function (ev) {
    let m = null
    try { m = JSON.parse(ev.data) } catch (e) { return }
    if (!m) return
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id)
      if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result)
      return
    }
    if (m.sessionId && handlers.has(m.sessionId)) {
      try { handlers.get(m.sessionId)(m) } catch (e) {}
    }
  })
  const api = {
    ws: ws, handlers: handlers, alive: true,
    send: function (method, params, sessionId) {
      return new Promise(function (res, rej) {
        const id = ++seq
        const timer = setTimeout(function () {
          if (!pend.has(id)) return
          pend.delete(id)
          rej(new Error('CDP 超时：' + method))
        }, 15000)
        pend.set(id, {
          res: function (v) { clearTimeout(timer); res(v) },
          rej: function (e) { clearTimeout(timer); rej(e) }
        })
        try {
          ws.send(JSON.stringify({ id: id, method: method, params: params || {}, sessionId: sessionId }))
        } catch (e) {
          clearTimeout(timer)
          pend.delete(id)
          rej(e)
        }
      })
    },
    close: function () { api.alive = false; try { ws.close() } catch (e) {} }
  }
  ws.addEventListener('close', function () {
    api.alive = false
    for (const entry of pend.values()) {
      try { entry.rej(new Error('浏览器已断开')) } catch (e) {}
    }
    pend.clear()
  })
  return api
}

/** 作者主页专用浏览器：固定端口 + 固定用户目录；已经开着就复用 */
async function authorSession() {
  if (authorConn && authorConn.alive) return authorConn
  let ver = await cdpVersionOnce(AUTHOR_PORT)
  if (!ver) {
    const chrome = pick(CHROME)
    if (!chrome) throw new Error('没有找到 Chrome 或 Edge')
    mkdirSync(AUTHOR_PROFILE, { recursive: true })
    const child = spawn(chrome, [
      '--remote-debugging-port=' + AUTHOR_PORT,
      '--user-data-dir=' + AUTHOR_PROFILE,
      '--headless=new', '--disable-gpu', '--mute-audio',
      '--window-size=1400,1100',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run', '--no-default-browser-check',
      'about:blank'
    ], { windowsHide: true, stdio: 'ignore' })
    let spawnError = null
    child.on('error', function (e) { spawnError = e })
    authorOwned = child
    for (let i = 0; i < 100; i++) {
      ver = await cdpVersionOnce(AUTHOR_PORT)
      if (ver) break
      await sleep(150)
    }
    if (!ver) {
      try { child.kill('SIGKILL') } catch (e) {}
      authorOwned = null
      throw new Error(spawnError
        ? ('主页浏览器启动失败：' + (spawnError.message || spawnError.code || 'spawn error'))
        : '主页浏览器没起来（可能登录窗口还开着占着目录，先关掉它）')
    }
  }
  const conn = await connectCdp(ver)
  authorConn = conn
  return conn
}

// 自己拉起来的浏览器别一直常驻：3 分钟没人用就关掉（登录态在磁盘上，下次照样有）
let authorIdleTimer = null
function scheduleAuthorIdleClose() {
  if (authorIdleTimer) clearTimeout(authorIdleTimer)
  authorIdleTimer = setTimeout(function () {
    if (!authorOwned) return
    try { if (authorConn) authorConn.close() } catch (e) {}
    authorConn = null
    try { authorOwned.kill('SIGKILL') } catch (e) {}
    authorOwned = null
  }, 180000)
}

/** 开一个可见窗口让用户扫码登录（登录态写进固定用户目录，下次直接复用） */
export async function openAuthorLogin() {
  if (authorConn) { try { authorConn.close() } catch (e) {} authorConn = null }
  if (authorOwned) { try { authorOwned.kill('SIGKILL') } catch (e) {} authorOwned = null }
  await sleep(600)
  const ver = await cdpVersionOnce(AUTHOR_PORT)
  if (ver) {
    const conn = await connectCdp(ver)
    try { await conn.send('Target.createTarget', { url: 'https://www.douyin.com/' }) } catch (e) {}
    authorConn = conn
    return { ok: true, reused: true }
  }
  const chrome = pick(CHROME)
  if (!chrome) throw new Error('没有找到 Chrome 或 Edge')
  mkdirSync(AUTHOR_PROFILE, { recursive: true })
  const child = spawn(chrome, [
    '--remote-debugging-port=' + AUTHOR_PORT,
    '--user-data-dir=' + AUTHOR_PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--new-window', 'https://www.douyin.com/'
  ], { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', function (e) {
    // 扫码窗口起不来不能把宿主带崩：记一笔，让上层提示用户手动开浏览器
    try { console.error('[everything-down] 登录窗口启动失败: ' + (e && e.message ? e.message : e)) } catch (err) {}
  })
  child.unref()
  return { ok: true, reused: false }
}

/** 读 cookie 判断有没有登录；没开浏览器就返回 unknown */
export async function authorLoginState() {
  const ver = await cdpVersionOnce(AUTHOR_PORT)
  if (!ver) return { known: false, loggedIn: false }
  let conn = null
  let targetId = ''
  try {
    conn = await connectCdp(ver)
    // Network 域只在页面会话里能用，浏览器级会话调 getCookies 会直接报错
    const t = await conn.send('Target.createTarget', { url: 'about:blank' })
    targetId = t.targetId
    const att = await conn.send('Target.attachToTarget', { targetId: targetId, flatten: true })
    const r = await conn.send('Network.getCookies', { urls: ['https://www.douyin.com/'] }, att.sessionId)
    const names = (r.cookies || []).map(function (c) { return c.name })
    return { known: true, loggedIn: names.indexOf('sessionid') >= 0 || names.indexOf('sessionid_ss') >= 0 }
  } catch (e) {
    return { known: false, loggedIn: false }
  } finally {
    if (conn) {
      if (targetId) { try { await conn.send('Target.closeTarget', { targetId: targetId }) } catch (e) {} }
      try { conn.close() } catch (e) {}
    }
  }
}

function awemeToVideo(a) {
  const v = a.video || {}
  const first = function (obj) { return ((obj || {}).url_list || [])[0] || '' }
  let play = first(v.play_addr) || first(v.play_addr_h264) || first(v.play_addr_265)
  const rates = Array.isArray(v.bit_rate) ? v.bit_rate : []
  for (const b of rates) { if (!play) play = first(b.play_addr) }
  const cover = first(v.cover) || first(v.origin_cover) || first(v.dynamic_cover) || first(v.raw_cover)
  const imgs = Array.isArray(a.images) ? a.images : []
  return {
    id: String(a.aweme_id || ''),
    title: String(a.desc || '').trim(),
    duration: Math.round(Number(v.duration || a.duration || 0) / 1000),
    cover: cover,
    play: /^https?:/.test(play) ? play : '',
    images: imgs.length,
    likes: Number((a.statistics || {}).digg_count || 0),
    createTime: Number(a.create_time || 0),
    isTop: !!a.is_top
  }
}

function cleanAuthorName(pageTitle) {
  return String(pageTitle || '').replace(/\s*-\s*抖音.*$/, '').replace(/的抖音.*$/, '').trim() || '抖音作者'
}

/**
 * 列出一个抖音作者主页的作品。
 * opts: { limit, timeoutMs, onProgress({fetched,hasMore}), shouldStop() }
 */
export async function listAuthor(rawUrl, opts) {
  const o = opts || {}
  const url = extractUrl(rawUrl) || String(rawUrl || '').trim()
  if (!/^https?:/.test(url)) throw new Error('没有识别到主页链接')
  const b = await authorSession()

  const created = await b.send('Target.createTarget', { url: 'about:blank' })
  const targetId = created.targetId
  const att = await b.send('Target.attachToTarget', { targetId: targetId, flatten: true })
  const sid = att.sessionId

  const postIds = []
  const profileIds = []
  b.handlers.set(sid, function (m) {
    if (m.method !== 'Network.responseReceived') return
    const u = String(m.params.response.url || '')
    if (/aweme\/v1\/web\/aweme\/post/.test(u)) postIds.push(m.params.requestId)
    else if (/user\/profile\/other/.test(u)) profileIds.push(m.params.requestId)
  })

  const videos = new Map()
  let author = null
  let loggedIn = false
  let hasMore = true
  let cursorSeen = 0
  let stopped = false

  const drain = async function () {
    while (cursorSeen < postIds.length) {
      const id = postIds[cursorSeen++]
      let j = null
      try {
        const body = await b.send('Network.getResponseBody', { requestId: id }, sid)
        j = JSON.parse(String(body.body || '{}'))
      } catch (e) { continue }
      const list = j.aweme_list || []
      for (const a of list) {
        const v = awemeToVideo(a)
        if (v.id && (v.play || v.images)) videos.set(v.id, v)
      }
      if (j.has_more === 0) hasMore = false
      else if (j.has_more === 1) hasMore = true
      if (!author && list.length && list[0].author) {
        const au = list[0].author
        author = {
          nickname: String(au.nickname || ''),
          secUid: String(au.sec_uid || ''),
          avatar: ((au.avatar_thumb || {}).url_list || [])[0] || ((au.avatar_medium || {}).url_list || [])[0] || '',
          signature: String(au.signature || ''),
          awemeCount: Number(au.aweme_count || 0),
          follower: Number(au.follower_count || 0)
        }
      }
    }
    while (profileIds.length) {
      const id = profileIds.shift()
      try {
        const body = await b.send('Network.getResponseBody', { requestId: id }, sid)
        const j = JSON.parse(String(body.body || '{}'))
        const u = j.user || {}
        if (u.nickname) {
          author = {
            nickname: String(u.nickname || ''),
            secUid: String(u.sec_uid || ''),
            avatar: ((u.avatar_thumb || {}).url_list || [])[0] || '',
            signature: String(u.signature || ''),
            awemeCount: Number(u.aweme_count || 0),
            follower: Number(u.follower_count || 0)
          }
        }
      } catch (e) {}
    }
  }

  const scrollDown = async function () {
    try {
      await b.send('Runtime.evaluate', {
        expression: '(() => { const se = document.scrollingElement || document.documentElement; se.scrollTop = se.scrollHeight; window.scrollBy(0, 1500); return se.scrollTop })()',
        returnByValue: true
      }, sid)
    } catch (e) {}
    try {
      await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 600, deltaX: 0, deltaY: 1800, pointerType: 'mouse' }, sid)
    } catch (e) {}
  }

  try {
    await b.send('Network.enable', {}, sid)
    await b.send('Page.enable', {}, sid)
    await b.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'Object.defineProperty(navigator,"webdriver",{get:()=>undefined});'
    }, sid)
    await b.send('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'Win32' }, sid)
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1100, deviceScaleFactor: 1, mobile: false }, sid)
    await b.send('Page.navigate', { url: url }, sid)

    const startedAt = Date.now()
    const deadline = startedAt + Number(o.timeoutMs || 900000)

    // 1) 等首屏：主页信息 + 第一批作品
    let firstAt = 0
    while (Date.now() - startedAt < 30000) {
      await sleep(600)
      await drain()
      if (!firstAt && videos.size) firstAt = Date.now()
      if (firstAt && author) break
      if (o.shouldStop && o.shouldStop()) { stopped = true; break }
    }
    // 2) 滚动翻页
    let idle = 0
    let rounds = 0
    while (!stopped && Date.now() < deadline && rounds < 600) {
      if (o.shouldStop && o.shouldStop()) { stopped = true; break }
      if (o.limit && videos.size >= Number(o.limit)) break
      if (!hasMore) break
      const before = videos.size
      await scrollDown()
      await sleep(850)
      await drain()
      rounds++
      if (videos.size === before) idle++; else idle = 0
      if (o.onProgress) {
        try { o.onProgress({ fetched: videos.size, hasMore: hasMore, rounds: rounds }) } catch (e) {}
      }
      if (idle >= 8) break
    }

    let finalUrl = url
    let pageTitle = ''
    try {
      const e = await b.send('Runtime.evaluate', { expression: 'JSON.stringify({h:location.href,t:document.title})', returnByValue: true }, sid)
      const v = JSON.parse((e.result || {}).value || '{}')
      finalUrl = String(v.h || url)
      pageTitle = String(v.t || '')
    } catch (e) {}
    try {
      const ck = await b.send('Network.getCookies', { urls: ['https://www.douyin.com/'] })
      const names = (ck.cookies || []).map(function (c) { return c.name })
      loggedIn = names.indexOf('sessionid') >= 0 || names.indexOf('sessionid_ss') >= 0
    } catch (e) {}

    if (/\/video\/|\/note\//.test(finalUrl)) {
      throw new Error('这是单个作品链接，不是作者主页；用「单个链接」解析它')
    }
    if (!videos.size) {
      throw new Error(loggedIn
        ? '页面里没抓到作品列表，稍后再试一次'
        : '没抓到作品列表。抖音不给未登录用户看完整主页，先点「登录抖音」扫码再解析')
    }

    const list = [...videos.values()].sort(function (a, b2) {
      if (a.isTop !== b2.isTop) return a.isTop ? -1 : 1
      return (b2.createTime || 0) - (a.createTime || 0)
    })
    return {
      ok: true,
      url: finalUrl,
      pageTitle: pageTitle,
      author: author || { nickname: cleanAuthorName(pageTitle), secUid: '', avatar: '', signature: '', awemeCount: 0, follower: 0 },
      videos: list,
      loggedIn: loggedIn,
      hasMore: hasMore,
      complete: !hasMore,
      stopped: stopped
    }
  } finally {
    b.handlers.delete(sid)
    try { await b.send('Target.closeTarget', { targetId: targetId }) } catch (e) {}
    scheduleAuthorIdleClose()
  }
}

// ------------------------------------------------------------------ 图文（图集）
// 抖音/快手/小红书三家的图文页都能靠浏览器打开：抖音截 detail 接口，
// 小红书读 __INITIAL_STATE__，快手读 INIT_STATE（键名整体做了 -1 位移，解码后再找 atlas 图）。

function sleepG(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

let galleryLock = Promise.resolve()
/** 图文解析串行排队：常驻浏览器只有一个，并发会互相拖死 */
export function galleryOne(url, opts) {
  const run = galleryLock.then(function () { return gallery(url, opts) })
  galleryLock = run.then(function () {}, function () {})
  return run
}

// 页面里跑的取图脚本（不用正则，省得转义出错）
const DOM_IMG_JS = '(function(){var out=[];var seen={};var hosts=["douyinpic.com","yximgs.com","kwimgs.com","xhscdn.com"];'
  + 'for(var i=0;i<document.images.length;i++){var im=document.images[i];var s=im.currentSrc||im.src||"";'
  + 'if(s.indexOf("http")!==0)continue;var isAtlas=s.indexOf("/atlas/")>=0;if(!isAtlas&&im.naturalWidth<500)continue;var ok=false;'
  + 'for(var h=0;h<hosts.length;h++){if(s.indexOf(hosts[h])>=0){ok=true;break}}if(!ok)continue;'
  + 'if(s.indexOf("aweme-avatar")>=0||s.indexOf("uhead")>=0||s.indexOf("image-cut-tos")>=0)continue;'
  + 'var k=s.split("?")[0];if(seen[k])continue;seen[k]=1;out.push({url:s,w:im.naturalWidth,h:im.naturalHeight})}'
  + 'return JSON.stringify(out.slice(0,40))})()'

const XHS_STATE_JS = '(function(){var st=window.__INITIAL_STATE__||{};var n=st.note||{};var m=n.noteDetailMap||{};'
  + 'var k=n.currentNoteId||Object.keys(m)[0];var note=(m[k]||{}).note;if(!note)return "";'
  + 'var imgs=(note.imageList||[]).map(function(i){return {url:i.urlDefault||i.urlPre||"",w:i.width||0,h:i.height||0}});'
  + 'return JSON.stringify({title:note.title||"",author:(note.user||{}).nickname||"",images:imgs})})()'

const KS_STATE_JS = '(function(){var raw=JSON.stringify(window.INIT_STATE||{});if(raw.length<200)return "";'
  + 'var dec="";for(var i=0;i<raw.length;i++){dec+=String.fromCharCode(raw.charCodeAt(i)+1)}'
  + 'var parts=dec.split("\"");var uniq={};var out=[];'
  + 'for(var j=0;j<parts.length;j++){var u=parts[j];if(u.indexOf("http")!==0)continue;'
  + 'if(u.indexOf("atlas")<0&&u.indexOf(".jpg")<0&&u.indexOf(".png")<0)continue;'
  + 'if(u.indexOf("uhead")>=0)continue;if(uniq[u])continue;uniq[u]=1;out.push({url:u,w:0,h:0})}'
  + 'return JSON.stringify({images:out.slice(0,60)})})()'

/** 解析一个图文链接，返回 { platform, title, author, images } */
/**
 * 把抓到的图片整理干净：
 *   快手：只认 /atlas/ 里的图集图，按 _0 _1 序号排（DOM 里会混进推荐流和其他作品的封面）
 *   抖音/小红书：同一张图会有多个变体（~noop 原图 / ~tplv 展示图，!nd_dft 压缩图），按前缀合并、优先原图
 */
function pickGalleryImages(platform, list) {
  const clean = []
  for (const im of list) {
    let u = String(im.url || '').trim()
    if (!/^https?:/.test(u)) continue
    if (platform === 'xhs' && u.indexOf('http://') === 0) u = 'https://' + u.slice(7)
    clean.push({ url: u, w: im.w || 0, h: im.h || 0 })
  }
  if (platform === 'kuaishou') {
    const atlas = clean.filter(function (x) { return x.url.indexOf('/atlas/') >= 0 })
    if (atlas.length) {
      const uniq = []
      const seen = {}
      for (const a of atlas) {
        const k = a.url.split('?')[0]
        if (seen[k]) continue
        seen[k] = 1
        uniq.push(a)
      }
      uniq.sort(function (a, b) { return a.url.localeCompare(b.url) })
      return uniq
    }
  }
  const rank = platform === 'douyin'
    ? function (u) { return u.indexOf('~noop') >= 0 ? 0 : (u.indexOf('~tplv-dy-aweme-images') >= 0 ? 1 : 2) }
    : function (u) { return u.indexOf('!') < 0 ? 0 : 1 }
  const groups = new Map()
  for (const im of clean) {
    const key = platform === 'douyin' ? im.url.split('~')[0] : im.url.split('!')[0]
    const prev = groups.get(key)
    if (!prev || rank(im.url) < rank(prev.url) || (rank(im.url) === rank(prev.url) && im.w * im.h > prev.w * prev.h)) {
      groups.set(key, im)
    }
  }
  return [...groups.values()]
}
export async function gallery(rawUrl, opts) {
  const link = extractUrl(rawUrl) || String(rawUrl || '').trim()
  if (!/^https?:/.test(link)) throw new Error('没有识别到链接')
  const platform = platformOf(link)
  if (['douyin', 'kuaishou', 'xhs'].indexOf(platform) < 0) {
    throw new Error('图文目前支持抖音、快手、小红书')
  }
  const b = await ensureBrowser()
  const created = await b.send('Target.createTarget', { url: 'about:blank' })
  const targetId = created.targetId
  const att = await b.send('Target.attachToTarget', { targetId: targetId, flatten: true })
  const sid = att.sessionId
  const detailIds = []
  b.handlers.set(sid, function (m) {
    if (m.method !== 'Network.responseReceived') return
    const u = String(m.params.response.url || '')
    if (u.indexOf('/aweme/v1/web/aweme/detail') >= 0) detailIds.push(m.params.requestId)
  })
  const mobile = platform === 'kuaishou'
  const ev = async function (expr) {
    try {
      const r = await b.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid)
      return r.result ? r.result.value : undefined
    } catch (e) { return undefined }
  }

  let images = []
  let title = ''
  let author = ''
  try {
    await b.send('Network.enable', {}, sid)
    await b.send('Page.enable', {}, sid)
    if (mobile) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }, sid)
    }
    await b.send('Emulation.setUserAgentOverride', { userAgent: mobile ? WX_UA : UA, platform: mobile ? 'iPhone' : 'Win32' }, sid)
    await b.send('Page.navigate', { url: link }, sid)

    const deadline = Date.now() + Number(opts && opts.timeoutMs || 30000)
    while (Date.now() < deadline) {
      await sleepG(700)
    if (platform === 'kuaishou') {
      try { await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 400, deltaX: 0, deltaY: 900, pointerType: 'mouse' }, sid) } catch (e) {}
    }
      // 抖音：先看接口
      while (platform === 'douyin' && detailIds.length) {
        const id = detailIds.shift()
        try {
          const body = await b.send('Network.getResponseBody', { requestId: id }, sid)
          const j = JSON.parse(String(body.body || '{}'))
          const d = j.aweme_detail || (Array.isArray(j.aweme_details) ? j.aweme_details[0] : null)
          if (d) {
            title = String(d.desc || '')
            author = String((d.author || {}).nickname || '')
            images = (Array.isArray(d.images) ? d.images : []).map(function (im) {
              const list = im.url_list || []
              return { url: list[0] || '', w: im.width || 0, h: im.height || 0 }
            }).filter(function (x) { return /^https?:/.test(x.url) })
          }
        } catch (e) {}
      }
      // 小红书：读页面状态
      if (platform === 'xhs' && !images.length) {
        const raw = await ev(XHS_STATE_JS)
        if (raw) {
          try {
            const j = JSON.parse(String(raw))
            title = String(j.title || '')
            author = String(j.author || '')
            images = (j.images || []).filter(function (x) { return /^https?:/.test(x.url) })
          } catch (e) {}
        }
      }
      // 快手：解码 INIT_STATE
      if (platform === 'kuaishou' && !images.length) {
        const raw = await ev(KS_STATE_JS)
        if (raw) {
          try {
            const j = JSON.parse(String(raw))
            const list = (j.images || []).filter(function (x) { return /^https?:/.test(x.url) })
            if (list.length) images = list
          } catch (e) {}
        }
      }
      // 兜底：直接从 DOM 抓大图
      if (!images.length) {
        const raw = await ev(DOM_IMG_JS)
        if (raw) {
          try {
            const list = JSON.parse(String(raw))
            if (Array.isArray(list) && list.length) images = list
          } catch (e) {}
        }
      }
      if (images.length) break
    }

    if (!title) {
      const t = await ev('document.title')
      title = String(t || '').replace(/\s*-\s*(小红书|抖音|快手).*$/, '').trim()
    }
    // 快手/抖音的 title 只有平台名，退回 meta 描述（正好是正文前几十字）
    if (!title || title === '快手' || title === '抖音' || title === '小红书') {
      const meta = await ev('(function(){var ms=document.querySelectorAll("meta");for(var i=0;i<ms.length;i++){var n=ms[i].getAttribute("name")||ms[i].getAttribute("property");if(n==="description"||n==="og:title"){return ms[i].content||""}}return ""})()')
      const mt = String(meta || '').trim()
      if (mt.length > 4) title = mt.replace(/\s+/g, ' ').slice(0, 50)
    }
  } finally {
    b.handlers.delete(sid)
    try { await b.send('Target.closeTarget', { targetId: targetId }) } catch (e) {}
  }

  const out = pickGalleryImages(platform, images)
  if (!out.length) throw new Error('这个页面里没抓到图片（可能不是图文作品，或者平台改版了）')
  return { ok: true, platform: platform, url: link, title: title, author: author, images: out }
}

export { run, FFMPEG, YTDLP, CHROME, UA, WX_UA }
