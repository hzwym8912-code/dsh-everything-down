/**
 * Everything down — 本地面板服务
 * 提供 HTML 面板 + JSON API（解析 / 下载 / 任务 / 设置）。
 */
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir, freemem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { sniff, sniffOne, downloadFile, merge, extractUrl, platformOf, safeName, run, pick, FFMPEG, YTDLP, UA, WX_UA, shutdownBrowser, listAuthor, openAuthorLogin, authorLoginState, ytdlpArgs, tiktokArgs, galleryOne, browserFound } from './engine.js'
import { transcribeVideo, transcribeLocal, toSrt } from './transcribe.js'

// 宿主自带的本地语音服务（SenseVoice），没有就是 null
let hostStt = null
export function setHostSpeech(stt) { hostStt = stt || null }
export function hasHostSpeech() { return !!hostStt }

const DATA_DIR = join(homedir(), '.everything-down')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')
const TASKS_FILE = join(DATA_DIR, 'tasks.json')
const TRANSCRIPT_DIR = join(DATA_DIR, 'transcripts')

const DEFAULT_SETTINGS = {
  saveDir: existsSync('D:\\') ? 'D:\\下载\\短视频' : join(homedir(), 'Downloads', '短视频'),
  byPlatform: true,
  byDate: false,
  naming: 'platform_title',
  quality: 'best',
  concurrency: 3,
  panelPort: 0,          // 0 = 用默认 7788（被占用会自动往后找，设置页会自己跟上）
  openWith: 'default',   // default=系统播放器 | jianying=剪映 | custom=自定义程序
  openWithPath: '',      // 自定义程序的 exe 路径
  retry: true,
  openAfter: false,
  proxy: '',
  cookieFrom: '',
  transcribe: {
    enabled: false,   // 默认不自动转写：批量下载几十条时自动转写太吵，需要就手动开
    provider: 'local',
    baseUrl: '',
    apiKey: '',
    model: '',
    language: 'zh'
  }
}

function ensureDir(p) { try { mkdirSync(p, { recursive: true }) } catch (e) {} }

/**
 * 外部依赖体检。这三样不是插件自带的：
 *   Chrome  —— 抖音/快手/小红书要靠它跑页面
 *   ffmpeg  —— 合并音视频、转码、HLS 下载
 *   yt-dlp  —— B站/微博/YouTube 这类站点的解析（Python 写的独立 CLI）
 */
function envReport() {
  const probe = function (cmd, args) {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true })
      if (r.error) return { ok: false, detail: String(r.error.message || r.error).slice(0, 120) }
      const out = (String(r.stdout || '') + String(r.stderr || '')).trim().split('\n')[0]
      return { ok: r.status === 0, version: out.slice(0, 80) }
    } catch (e) {
      return { ok: false, detail: String(e.message || e).slice(0, 120) }
    }
  }

  const chromePath = (function () {
    const list = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
    ]
    for (const p of list) if (existsSync(p)) return p
    return ''
  })()

  const ff = pick(FFMPEG)
  const yt = pick(YTDLP)

  const ffCheck = /[\\/]/.test(ff) ? { ok: existsSync(ff), version: ff } : probe(ff, ['-version'])
  const ytCheck = /[\\/]/.test(yt) ? { ok: existsSync(yt), version: yt } : probe(yt, ['--version'])

  return [
    {
      key: 'localstt', name: '本地语音识别（宿主自带）',
      ok: !!hostStt, version: hostStt ? 'SenseVoice · 就绪' : '',
      purpose: '提取文案用，免费、不联网；缺了就在 DSH 设置里开启语音输入',
      install: 'DSH 设置 → 语音输入 → 开启（会自动下载模型）'
    },
    {
      key: 'chrome', name: 'Chrome / Edge',
      ok: !!chromePath, version: chromePath,
      purpose: '抖音、快手、小红书需要它打开页面抓视频地址',
      install: '安装 Chrome 或 Edge 即可'
    },
    {
      key: 'ffmpeg', name: 'ffmpeg',
      ok: !!ffCheck.ok, version: String(ffCheck.version || '').slice(0, 90),
      purpose: '合并音视频、转 GIF、压缩、HLS 下载',
      install: 'winget install Gyan.FFmpeg'
    },
    {
      key: 'yt-dlp', name: 'yt-dlp',
      ok: !!ytCheck.ok, version: String(ytCheck.version || '').slice(0, 40),
      purpose: 'B 站、微博等站点的解析（独立命令行工具，不是插件）',
      install: 'winget install yt-dlp 或 pip install -U yt-dlp'
    }
  ]
}

export function loadSettings() {
  ensureDir(DATA_DIR)
  let saved = {}
  try { saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch (e) {}
  const merged = Object.assign({}, DEFAULT_SETTINGS, saved)
  // 迁移：旧版本的默认值（硅基流动且没填 key）升级成本地优先
  const t = merged.transcribe || {}
  if (!t.provider || (t.provider === 'siliconflow' && !t.apiKey)) {
    merged.transcribe = Object.assign({}, DEFAULT_SETTINGS.transcribe)
  }
  return merged
}

export function saveSettings(next) {
  ensureDir(DATA_DIR)
  const merged = Object.assign(loadSettings(), next || {})
  writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8')
  return merged
}

function loadTasks() {
  ensureDir(DATA_DIR)
  try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')) } catch (e) { return [] }
}
function saveTasks(list) {
  ensureDir(DATA_DIR)
  try { writeFileSync(TASKS_FILE, JSON.stringify(list.slice(0, 200), null, 1), 'utf8') } catch (e) {}
}

/** 从一大段文字里抽出所有链接并去重 */
function extractAllUrls(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>()\u4e00-\u9fa5]+/g) || []
  const out = []
  const seen = new Set()
  for (let u of m) {
    u = u.replace(/[，。、；：）】,!;]+$/, '')
    if (!seen.has(u)) { seen.add(u); out.push(u) }
  }
  return out
}

function outDirFor(settings, platform) {
  let dir = settings.saveDir
  if (settings.byPlatform && platform) dir = join(dir, platformLabel(platform))
  if (settings.byDate) dir = join(dir, new Date().toISOString().slice(0, 10))
  ensureDir(dir)
  return dir
}

function platformLabel(p) {
  return ({ douyin: '抖音', kuaishou: '快手', xhs: '小红书', bilibili: 'B站', weibo: '微博',
    x: 'X', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok',
    xigua: '西瓜视频', other: '其它' })[p] || '其它'
}

// 境外平台（TikTok/YouTube 这类）要先确认能连出去，否则解析只会白等两分钟。
// 两级探测：先探平台自己的域名（通了才可能解析），再探通用地址（用来区分「没开代理」还是「节点被限」）。
const OVERSEAS = ['tiktok', 'youtube', 'x', 'instagram', 'facebook']
const OVERSEAS_PROBE = {
  tiktok: 'https://www.tiktok.com/favicon.ico',
  youtube: 'https://www.youtube.com/favicon.ico',
  x: 'https://x.com/favicon.ico',
  instagram: 'https://www.instagram.com/favicon.ico',
  facebook: 'https://www.facebook.com/favicon.ico'
}
let netCache = { at: 0, result: null }
const platformNetCache = new Map()

async function probeUrl(u, ms) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(ms || 3000), redirect: 'manual' })
    try { if (r.body) await r.body.cancel() } catch (e) {}
    return true
  } catch (e) {
    return false
  }
}

/** 通用境外连通性（Google / Cloudflare），30 秒缓存 */
async function probeGeneric(force) {
  if (!force && netCache.result && Date.now() - netCache.at < 30000) return netCache.result
  const custom = String(process.env.ED_NET_PROBE || '').split(',').map(function (s) { return s.trim() }).filter(Boolean)
  const targets = custom.length ? custom : ['https://www.gstatic.com/generate_204', 'https://www.cloudflare.com/cdn-cgi/trace']
  const t0 = Date.now()
  for (const u of targets) {
    if (await probeUrl(u, 3000)) {
      const res = { ok: true, ms: Date.now() - t0, via: u }
      netCache = { at: Date.now(), result: res }
      return res
    }
  }
  const res = { ok: false, ms: Date.now() - t0, via: '' }
  netCache = { at: Date.now(), result: res }
  return res
}

/**
 * 给某个境外平台做连通性判断。
 * 返回 { ok, ms, generic }：generic=true/false 表示通用网络是否也通，
 * 用它区分「代理没开」和「代理开着但这个站连不上」。
 */
async function probeInternet(platform) {
  const generic = await probeGeneric()
  if (!platform || !OVERSEAS_PROBE[platform]) return generic
  const hit = platformNetCache.get(platform)
  if (hit && Date.now() - hit.at < 30000) return hit.result
  const t0 = Date.now()
  const ok = await probeUrl(OVERSEAS_PROBE[platform], 3500)
  const res = { ok: ok, ms: Date.now() - t0, generic: generic.ok, via: OVERSEAS_PROBE[platform] }
  platformNetCache.set(platform, { at: Date.now(), result: res })
  return res
}

const NET_HINT = '连不上境外网络。TikTok / YouTube 这类要先打开代理或 VPN（全局模式），国内平台不受影响。'
function netHintFor(platform, net) {
  if (net && net.generic === false) return NET_HINT
  const label = platform === 'tiktok' ? 'TikTok' : (platform === 'youtube' ? 'YouTube' : '这个站点')
  return '代理是通的，但连不上' + label + '：多半是当前节点被平台限了，换一个节点再试。'
}

let envCache = { at: 0, list: null }
function envCached() {
  if (envCache.list && Date.now() - envCache.at < 30000) return envCache.list
  const list = envReport()
  envCache = { at: Date.now(), list: list }
  return list
}

/** 这个平台缺了关键依赖吗？缺就返回一句能照做的话 */
export function checkDeps(platform, envList) {
  const env = envList || envCached()
  const has = function (k) { const e = env.find(function (x) { return x.key === k }); return e && e.ok ? e : null }
  const needYtdlp = ['weibo', 'bilibili', 'other', 'x', 'instagram', 'facebook', 'youtube', 'tiktok'].indexOf(platform) >= 0
  const needChrome = ['douyin', 'kuaishou', 'xhs', 'xigua'].indexOf(platform) >= 0

  if (needYtdlp) {
    const y = has('yt-dlp')
    if (!y) {
      const e = env.find(function (x) { return x.key === 'yt-dlp' })
      return '这个平台要靠 yt-dlp 解析，但本机没装。安装命令：' + ((e && e.install) || 'winget install yt-dlp')
    }
  }
  if (needChrome) {
    const c = has('chrome')
    if (!c) {
      return '这个平台要打开网页才能抓到视频，但本机没有 Chrome/Edge。装一个 Chrome 即可。'
    }
  }
  const ff = has('ffmpeg')
  if (!ff) {
    const e = env.find(function (x) { return x.key === 'ffmpeg' })
    return '缺少 ffmpeg，下载后无法合并音视频。安装命令：' + ((e && e.install) || 'winget install Gyan.FFmpeg')
  }
  return ''
}

/** 解析一个链接：返回平台、标题、可选流 */
export async function parseUrl(rawUrl, settings, forcedPlatform) {
  const url = extractUrl(rawUrl) || String(rawUrl || '').trim()
  if (!/^https?:\/\//.test(url)) throw new Error('没有识别到链接')
  const forced = String(forcedPlatform || '').trim()
  let platform = (forced && forced !== 'auto') ? forced : platformOf(url)

  // 境外平台先花 3 秒确认能不能连出去：不通就直接说清楚，
  // 别让用户等 yt-dlp 超时 + 页面嗅探超时（那要两分钟）
  if (OVERSEAS.indexOf(platform) >= 0) {
    const net = await probeInternet(platform)
    if (!net.ok) {
      logOpen('net check fail ' + platform + ' generic=' + net.generic + ' ' + net.ms + 'ms')
      return {
        ok: false, url: url, platform: platform, title: '', streams: null, preview: '',
        via: 'net', note: netHintFor(platform, net)
      }
    }
  }

  // B 站单独走嗅探：yt-dlp 解析它的新版页面会失败，先跑一遍纯属浪费 7 秒
  if (platform !== 'bilibili' && ['other', 'weibo', 'x', 'instagram', 'facebook', 'youtube', 'tiktok'].indexOf(platform) >= 0) {
    const jArgs = platform === 'tiktok'
      ? tiktokArgs(settings, ['-J', url])
      : ytdlpArgs(settings, ['-J', url])
    const r = await run(pick(YTDLP), jArgs, platform === 'tiktok' ? 90000 : 120000)
    if (r.code !== 0) {
      const err = String(r.stderr || '')
      logOpen('yt-dlp fail code=' + r.code + ' err=' + err.trim().slice(0, 220))
      if (platform === 'tiktok' && /curl_cffi|impersonat/i.test(err)) {
        return {
          ok: false, url: url, platform: platform, title: '', streams: null, via: 'yt-dlp', preview: '',
          note: 'TikTok 需要伪装浏览器指纹，本机缺 curl_cffi。装一下：pip install curl_cffi（用装 yt-dlp 的同一个 Python）'
        }
      }
      if (platform === 'tiktok' && /IP address is blocked|blocked/i.test(err)) {
        return {
          ok: false, url: url, platform: platform, title: '', streams: null, via: 'yt-dlp', preview: '',
          note: 'TikTok 把这个出口 IP 拦了（机房 IP 常见）。换一个节点再试，最好用住宅/原生 IP'
        }
      }
    }
    if (r.code === 0) {
      const info = JSON.parse(r.stdout)
      // 微博常见的标题只有个话题标签，太短就把作者名带上
      if (String(info.title || '').replace(/[#\s]/g, '').length < 6 && info.uploader) {
        info.title = String(info.uploader) + '_' + String(info.title || '').replace(/^#/, '')
      }
      const formats = (info.formats || []).filter(function (f) { return f.url })
      if (!formats.length) {
        // yt-dlp 只拿到元数据、没拿到可用流（B 站这种情况很常见）——继续往下走嗅探
        logOpen('yt-dlp no formats, fallback to sniff: ' + url)
      } else {
      // TikTok 的 1080P 常常只有 h265(bytevc1)，不少播放器不认；优先挑 h264，再按高度排
      const isH264 = function (f) { return /^h264|^avc/i.test(String(f.vcodec || '')) }
      const tall = formats.filter(function (f) { return f.height }).sort(function (a, b) {
        if (platform === 'tiktok' && isH264(a) !== isH264(b)) return isH264(a) ? -1 : 1
        return (b.height || 0) - (a.height || 0)
      })
      const best = tall[0] || formats[formats.length - 1]
      return {
        ok: true, url: url, platform: platform,
        title: String(info.title || ''), duration: Math.round(info.duration || 0),
        thumbnail: String(info.thumbnail || ''),
        streams: best ? { video: best.url, audio: '', hls: '', mime: best.ext || 'mp4' } : null,
        pageUrl: url,
        via: 'yt-dlp',
        // TikTok 的 CDN 会校验 TLS 指纹，Node 转发过去一律 403，所以不给它做预览
        preview: (best && platform !== 'tiktok') ? previewUrl({ video: best.url }, platform) : '',
        note: '共 ' + formats.length + ' 个格式'
      }
      }
    }
    // yt-dlp 失败则退回嗅探
  }

  // 快手：桌面版详情页不播目标视频，只播推荐流；
  // 换成移动端分享页 + 微信 UA 才会直接渲染目标作品
  const missing = checkDeps(platform)
  if (missing) {
    return { ok: false, url: url, platform: platform, title: '', streams: null, via: 'check', note: missing, preview: '' }
  }

  const isKS = platform === 'kuaishou'
  const sniffOpts = isKS
    ? { waitMs: 11000, userAgent: WX_UA, mobile: true, earlyStop: true }
    : { waitMs: 14000, earlyStop: true }
  // B 站页面资源重、播放器起播慢；给 9 秒足够，之前 14 秒纯属浪费
  if (platform === 'bilibili') sniffOpts.waitMs = 9000
  // 加个整体超时：页面卡死时不能让任务一直挂在「解析中」
  const sniffWithTimeout = function (u, o) {
    return Promise.race([
      sniffOne(u, o),
      new Promise(function (_, rej) {
        setTimeout(function () {
          // 页面卡死多半是常驻浏览器僵了：关掉它，下一次解析会重新拉起
          try { shutdownBrowser() } catch (e) {}
          rej(new Error('解析超时（页面没响应）'))
        }, 100000)
      })
    ])
  }
  let s = await sniffWithTimeout(url, sniffOpts)
  // 抖音短链有时指向西瓜视频的内容（跳转后地址带 /xg/），页面标题会带「西瓜视频」字样
  if (platform === 'douyin' && /西瓜视频/.test(String(s.title || ''))) {
    platform = 'xigua'
    logOpen('reclassified as xigua: ' + url)
  }
  const hasAny = function (x) {
    if (!x) return false
    if (x.currentSrc) return true
    if (Array.isArray(x.photos) && x.photos.length) return true
    return (x.media || []).some(function (m) { return m.kind === 'video' || m.kind === 'hls' })
  }
  // 只记录失败，不自动重试：抖音偶尔会限流，自动重试会让等待时间翻倍，
  // 交给界面上现成的「重新解析」按钮更可控
  if (!hasAny(s)) logOpen('no-media ' + platform + ' ' + url)

  // 抖音详情页偶尔会滑到推荐流，抓回来的是别的视频。
  // 用户粘的整段文案里通常带标题，拿它当指纹核对一下，对不上就重抓一次。
  if (hasAny(s) && (platform === 'douyin' || platform === 'kuaishou')) {
    // 分享文案长这样：9.92 复制打开抖音，看看【港澳的作品】苹果公司承认… https://…
    // 真正的标题在【】后面，直接取整段开头会把"抖音/作品"这类噪音当指纹
    let hint = titleFromText(rawUrl)
    const m = String(rawUrl || '').match(/】\s*([^【】\n]{4,60})/)
    if (m) hint = m[1]
    const got = cleanTitle(s.title || '', platform)
    const key = String(hint || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    const gotKey = String(got || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    if (key.length >= 6 && gotKey && !shareWindow(key, gotKey)) {
      logOpen('title mismatch, retry once | want=' + key + ' got=' + gotKey.slice(0, 12))
      await new Promise(function (r) { setTimeout(r, 700) })
      const s2 = await sniffWithTimeout(url, sniffOpts)
      if (hasAny(s2)) {
        const got2 = cleanTitle(s2.title || '', platform)
        const got2Key = String(got2 || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
        const ok2 = shareWindow(key, got2Key)
        if (ok2) s = s2
        logOpen('retry result: ' + (ok2 ? 'matched' : 'still mismatch') + ' | ' + String(got2 || '').slice(0, 16))
      }
    }
  }
  // 接口数据里若有作品直链，优先用它（能避开详情页轮播到推荐视频的问题）
  const ph = Array.isArray(s.photos) ? s.photos : []
  if (ph.length) {
    const scored = ph.map(function (p) {
      const cap = String(p.caption || '')
      let score = 0
      if (s.title && cap && (s.title.indexOf(cap.slice(0, 8)) >= 0 || cap.indexOf(String(s.title).slice(0, 8)) >= 0)) score += 5
      const mp4 = (p.urls || []).find(function (u) { return /\.mp4/i.test(u) })
      if (mp4) score += 2
      return { p: p, score: score, mp4: mp4 }
    }).sort(function (a, b) { return b.score - a.score })
    const best = scored[0]
    const u = best.mp4 || (best.p.urls || [])[0]
    if (u) {
      const isHls = /\.m3u8/i.test(u)
      return {
        ok: true, url: url, platform: platform,
        title: finalTitle(cleanTitle(best.p.caption || s.title, platform), platform, rawUrl),
        duration: Math.round(s.duration || 0), thumbnail: s.poster || '',
        streams: { video: isHls ? '' : u, audio: '', hls: isHls ? u : '', mime: isHls ? 'm3u8' : 'mp4' },
        via: 'api', note: '接口直链',
        preview: previewUrl({ video: isHls ? '' : u, hls: isHls ? u : '' }, platform)
      }
    }
  }
  const cur = String(s.currentSrc || '')
  if (cur) {
    const isHls = /\.m3u8/i.test(cur)
    return {
      ok: true, url: url, platform: platform, title: finalTitle(cleanTitle(s.title, platform), platform, rawUrl),
      duration: Math.round(s.duration || 0), thumbnail: s.poster || '',
      streams: { video: isHls ? '' : cur, audio: '', hls: isHls ? cur : '', mime: isHls ? 'm3u8' : 'mp4' },
      via: 'sniff', note: '使用当前播放源',
      preview: previewUrl({ video: isHls ? '' : cur, hls: isHls ? cur : '' }, platform)
    }
  }
  const videos = s.media.filter(function (m) { return m.kind === 'video' })
  const audios = s.media.filter(function (m) { return m.kind === 'audio' })
  const hls = s.media.filter(function (m) { return m.kind === 'hls' })
  let streams = null
  if (platform === 'kuaishou' && hls.length) {
    streams = { video: '', audio: '', hls: hls[0].url, mime: 'm3u8' }
  } else if (videos.length) {
    streams = {
      video: videos[0].url,
      audio: audios.length ? audios[0].url : '',
      hls: '', mime: 'mp4',
      candidates: {
        video: rankStreams(videos.map(function (m) { return m.url }), 6),
        audio: rankStreams(audios.map(function (m) { return m.url }), 4)
      }
    }
  } else if (hls.length) {
    streams = { video: '', audio: '', hls: hls[0].url, mime: 'm3u8' }
  }

  let title = cleanTitle(s.title, platform)
  if (!title || title === '短视频' || title.length < 2) {
    title = platformLabel(platform) + '_' + Date.now()
  }
  return {
    ok: !!streams, url: url, platform: platform,
    title: finalTitle(title, platform, rawUrl),
    duration: Math.round(s.duration || 0), thumbnail: s.poster || '', streams: streams, via: 'sniff',
    note: streams
      ? ('抓到 ' + s.media.length + ' 个地址')
      : (browserFound()
        ? ('页面里没有找到视频流' + (OVERSEAS.indexOf(platform) >= 0 ? '（境外平台，确认代理还开着）' : ''))
        : '没找到 Chrome 或 Edge，装一个再试（设置里的环境检查能看到缺什么）'),
    preview: previewUrl(streams, platform)
  }
}

/** 图文用的标题兜底：挑一句干净的正文，别把「该作品在快手被播放过」这类平台水词当标题 */
function galleryTitleFromText(raw) {
  const s = String(raw || '').replace(/https?:\/\/\S+/g, ' ')
  const parts = s.split(/[\n\r。！？!?]+/)
  const bad = /复制|打开|该作品|点击链接|直接观看|抖音|快手|小红书|点赞|关注|分享|播放过/
  let best = ''
  for (let p of parts) {
    p = p.replace(/[0-9]+[.、]?/g, ' ').replace(/[“”"'【】]/g, ' ').replace(/\s+/g, ' ').trim()
    const cn = (p.match(/[\u4e00-\u9fa5]/g) || []).length
    if (cn >= 6 && !bad.test(p) && p.length > best.length) best = p
  }
  return best.slice(0, 40)
}

/** 从整段分享文案里提取一句像标题的中文 */
/** 两段中文有没有 4 字以上的公共片段（用于判断抓到的视频是不是用户要的） */
function shareWindow(a, b) {
  const A = String(a || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  const B = String(b || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  if (A.length < 4 || B.length < 4) return true
  for (let i = 0; i + 4 <= A.length; i++) {
    if (B.indexOf(A.slice(i, i + 4)) >= 0) return true
  }
  return false
}

function titleFromText(raw) {
  const s = String(raw || '').replace(/https?:\/\/\S+/g, ' ')
  const parts = s.split(/[\n\r]+|(?<=[。！？!?])/)
  let best = ''
  for (let p of parts) {
    p = p.replace(/复制|打开|看看|点击链接|直接观看|https?/g, ' ').replace(/[0-9]+[.、]?/g, ' ').trim()
    const cn = (p.match(/[\u4e00-\u9fa5]/g) || []).length
    if (cn >= 8 && p.length > best.length) best = p
  }
  return best.slice(0, 48).trim()
}

/** 标题兜底：页面标题无效时，从用户粘贴的文案里取 */
/**
 * 候选流去重排序。B 站 URL 里的 qn 就是清晰度档位
 * （100023 = 480P，100022 = 360P，30216 = 音频），数字大的优先。
 * 页面里同一条流会被反复请求，先去重，否则会在无效地址上白等。
 */
function rankStreams(urls, limit) {
  const qn = function (u) {
    const m = String(u).match(/-1-(\d+)\.m4s/)
    return m ? Number(m[1]) : 0
  }
  const uniq = [...new Set(urls.filter(Boolean))]
  uniq.sort(function (a, b) { return qn(b) - qn(a) })
  return uniq.slice(0, limit || 6)
}

function previewUrl(streams, platform) {
  if (!streams) return ''
  const u = streams.video || streams.hls || ''
  if (!u) return ''
  return '/api/media?p=' + encodeURIComponent(platform || '') + '&u=' + encodeURIComponent(u)
}

function finalTitle(t, platform, rawUrl) {
  const p = platformLabel(platform)
  const bad = !t || String(t).length < 3 || t === p || String(t).indexOf(p + '_') === 0
  if (!bad) return t
  const fromText = titleFromText(rawUrl)
  return fromText || t || (p + '_' + Date.now())
}

function cleanTitle(t, platform) {
  let s = String(t || '')
    .replace(/\s*-\s*(抖音|快手|小红书|哔哩哔哩|微博).*$/, '')
    .replace(/\s*[|｜]\s*(Facebook|Instagram|X|Twitter|YouTube|西瓜视频|抖音|快手).*$/i, '')
    .replace(/#[^\s#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length > 48) s = s.slice(0, 48).trim()
  if (!s) s = platformLabel(platform) + '_' + Date.now()
  return s
}

function fileNameFor(settings, platform, title) {
  const p = platformLabel(platform)
  let t = safeName(title)
  // 标题本身已带平台名时不再重复加前缀
  if (t.indexOf(p + '_') === 0) t = t.slice(p.length + 1)
  if (settings.naming === 'title') return t + '.mp4'
  if (settings.naming === 'time') return p + '_' + Date.now() + '.mp4'
  return p + '_' + t + '.mp4'
}

/**
 * 打开文件或定位到资源管理器。
 * mode='file'   -> 用系统默认播放器直接打开视频
 * mode='folder' -> 在资源管理器里选中该文件
 * 路径必须自己带引号：explorer 的 /select, 后面遇到空格或逗号就截断，
 * 之前不带引号正是「打开到错误位置」的原因。
 */
function psQuote(s) {
  return "'" + String(s || '').replace(/'/g, "''") + "'"
}

function logOpen(msg) {
  try {
    ensureDir(DATA_DIR)
    writeFileSync(join(DATA_DIR, 'open.log'), '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: 'a' })
  } catch (e) {}
}

function powershellBin() {
  const sys = process.env.SystemRoot || 'C:\\Windows'
  const p = join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(p) ? p : 'powershell'
}

function runPowerShell(script, timeoutMs) {
  return new Promise(function (resolvePromise) {
    const ps = powershellBin()
    let out = ''
    let err = ''
    let done = false
    // 直接把脚本拼进命令行会被 Windows 的引号转义搞坏（PowerShell 收到半截命令），
    // 用 Base64(UTF-16LE) 的 -EncodedCommand 传参最稳
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true })
    const timer = setTimeout(function () {
      if (done) return
      done = true
      try { child.kill() } catch (e) {}
      resolvePromise({ code: -1, out: out, err: err + ' [timeout]' })
    }, timeoutMs || 15000)
    child.stdout.on('data', function (d) { out += d.toString() })
    child.stderr.on('data', function (d) { err += d.toString() })
    child.on('error', function (e) {
      if (done) return
      done = true; clearTimeout(timer)
      resolvePromise({ code: -1, out: out, err: err + ' ' + e.message })
    })
    child.on('close', function (c) {
      if (done) return
      done = true; clearTimeout(timer)
      resolvePromise({ code: c, out: out, err: err })
    })
  })
}

async function openPath(p, mode) {
  if (!p) return { ok: false, message: '没有路径' }
  try {
    if (mode === 'folder') {
      // explorer.exe 的 /select,"路径" 经 Node 传参会多转义一层，
      // 结果被解析成"文档"或"桌面"。改用 Shell COM：打开目录并选中文件。
      let target = p
      let isDir = false
      try { isDir = statSync(p).isDirectory() } catch (e) {}
      if (!isDir && !existsSync(p)) {
        target = dirname(p)
        isDir = true
      }
      const folder = isDir ? target : dirname(target)
      const name = isDir ? '' : basename(target)
      // 让 PowerShell 去调 explorer：它处理 /select,"路径" 的引号是正确的，
      // Node 直接 spawn 会被多转义一层（之前就是这个坑）
      const psTarget = psQuote(target)
      const parts = [
        '$ErrorActionPreference = "Stop"',
        '$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8',
        'try {',
        name
          ? ('  $arg = \'/select,"\' + ' + psTarget + ' + \'"\'')
          : ('  $arg = ' + psTarget),
        '  Start-Process explorer.exe -ArgumentList $arg',
        '  Write-Output "' + (name ? 'OK_SELECTED' : 'OK_FOLDER') + '"',
        '} catch {',
        '  Write-Output ("ERR: " + $_.Exception.Message)',
        '}',
        'exit 0'
      ]
      const script = parts.join("\n")
      const r = await runPowerShell(script, 15000)
      // PowerShell 首次运行会把进度流写进 stderr（#< CLIXML ...），那不是错误
      const errText = String(r.err || '').replace(/#< CLIXML[\s\S]*/g, '').trim()
      logOpen('folder p=' + p + ' code=' + r.code + ' out=' + String(r.out).trim().slice(0, 80) + ' err=' + errText.slice(0, 160))
      if (/ERR:/m.test(String(r.out || ''))) {
        // COM 失败就退回最朴素的方式：直接打开目录，至少能弹出来
        spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' }).unref()
        logOpen('fallback explorer ' + folder)
        return { ok: true, fallback: true, message: '已打开文件夹（未选中文件）' }
      }
      return { ok: true, message: /OK_SELECTED/.test(String(r.out || '')) ? '已在资源管理器中定位并选中' : '已打开所在文件夹' }
    }
    if (!existsSync(p)) return { ok: false, message: '文件不存在：' + p }
    spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref()
    logOpen('play ' + p)
    return { ok: true, message: '已用默认播放器打开' }
  } catch (e) {
    logOpen('error ' + String(e.message || e))
    return { ok: false, message: String(e.message || e) }
  }
}

function openInExplorer(p) { openPath(p, 'folder') }

// ---------------------------------------------------------------- 打开方式
// 剪映专业版常见装法：随包在 LocalAppData，也可能装在 D 盘；最后用开始菜单快捷方式兜底。
let jianyingCache = null
function findJianying(force) {
  if (!force && jianyingCache !== null) return jianyingCache
  const la = process.env.LOCALAPPDATA || ''
  const cands = []
  if (la) {
    cands.push(join(la, 'JianyingPro', 'Apps', 'JianyingPro.exe'))
    cands.push(join(la, 'JianyingPro', 'JianyingPro.exe'))
  }
  for (const d of ['C:', 'D:', 'E:', 'F:']) {
    cands.push(d + '\\JianyingPro\\JianyingPro.exe')
    cands.push(d + '\\Program Files\\JianyingPro\\JianyingPro.exe')
    cands.push(d + '\\Program Files (x86)\\JianyingPro\\JianyingPro.exe')
  }
  for (const c of cands) {
    if (existsSync(c)) { jianyingCache = c; return c }
  }
  try {
    const ps = '$s = New-Object -ComObject WScript.Shell; '
      + 'Get-ChildItem "$env:APPDATA\\Microsoft\\Windows\\Start Menu","C:\\ProgramData\\Microsoft\\Windows\\Start Menu" '
      + '-Recurse -Filter *.lnk -ErrorAction SilentlyContinue | '
      + 'Where-Object { $_.Name -match "剪映|Jianying|CapCut" } | '
      + 'ForEach-Object { $s.CreateShortcut($_.FullName).TargetPath }'
    const r = spawnSync(powershellBin(), ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    const hit = String(r.stdout || '').split(/\r?\n/).map(function (s) { return s.trim() })
      .find(function (p) { return /JianyingPro\.exe$/i.test(p) && existsSync(p) })
    if (hit) { jianyingCache = hit; return hit }
  } catch (e) {}
  jianyingCache = ''
  return ''
}

/** 用选定的程序打开一个文件；找不到程序就退回系统默认 */
async function openWithApp(file) {
  if (!file || !existsSync(file)) return { ok: false, message: '文件不在了' }
  const cfg = loadSettings()
  const mode = String(cfg.openWith || 'default')
  if (mode === 'default') return openPath(file, 'file')

  let exe = ''
  if (mode === 'jianying') exe = findJianying()
  else if (mode === 'custom') exe = String(cfg.openWithPath || '').trim()
  if (exe && !existsSync(exe)) exe = ''

  if (!exe) {
    const r = await openPath(file, 'file')
    return {
      ok: true,
      message: (mode === 'jianying' ? '没找到剪映' : '没设置程序') + '，先用系统默认播放器打开了',
      fallback: true,
    }
  }

  // 剪映很吃内存，先看一眼可用内存，太低就别硬开
  if (mode === 'jianying') {
    const freeGB = freemem() / 1024 / 1024 / 1024
    if (freeGB < 1.2) {
      return { ok: false, message: '可用内存只剩 ' + freeGB.toFixed(1) + 'GB，剪映多半起不来；先关掉些程序再点' }
    }
  }

  try {
    const child = spawn(exe, [file], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', function () {})
    child.unref()
    logOpen('open with ' + basename(exe) + ' ' + file)
    return { ok: true, message: mode === 'jianying' ? '已用剪映打开' : ('已用 ' + basename(exe) + ' 打开') }
  } catch (e) {
    return { ok: false, message: '打不开：' + String(e.message || e).slice(0, 80) }
  }
}

// ---------------------------------------------------------------- 文字提取
let transcribingCount = 0

// 进度写盘节流：按 30 秒切片时每段都存一次太频繁，800ms 内合并成一次
let saveSoonTimer = null
function saveSoon(save) {
  if (saveSoonTimer) return
  saveSoonTimer = setTimeout(function () {
    saveSoonTimer = null
    try { save() } catch (e) {}
  }, 800)
}


function transcriptPath(id) { return join(TRANSCRIPT_DIR, id + '.json') }

function readTranscript(id) {
  try { return JSON.parse(readFileSync(transcriptPath(id), 'utf8')) } catch (e) { return null }
}

async function doTranscribe(task, cfg, save) {
  if (!task.file || !existsSync(task.file)) {
    task.transcript = { status: 'error', error: '视频文件不在了' }
    save()
    return
  }
  ensureDir(TRANSCRIPT_DIR)
  const workDir = join(DATA_DIR, 'tmp', 'tr_' + task.id)
  task.transcript = { status: 'running', progress: 0 }
  save()
  try {
    const useLocal = (cfg.transcribe.provider === 'local' || !cfg.transcribe.provider) && hostStt
    const r = useLocal
      ? await transcribeLocal(task.file, hostStt, workDir, function (stage, v) {
        if (stage === 'transcribing') { task.transcript.progress = v; saveSoon(save) }
      })
      : await transcribeVideo(task.file, cfg.transcribe, workDir, function (stage, v) {
        if (stage === 'transcribing') { task.transcript.progress = v; saveSoon(save) }
      })
    writeFileSync(transcriptPath(task.id), JSON.stringify({
      taskId: task.id,
      title: task.title || '',
      file: task.file,
      text: r.text,
      segments: r.segments,
      chars: r.chars,
      seconds: r.seconds,
      at: Date.now()
    }, null, 1), 'utf8')
    task.transcript = { status: 'done', chars: r.chars, seconds: r.seconds, progress: 100 }
    logOpen('transcript done ' + task.id + ' chars=' + r.chars)
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160)
    task.transcript = { status: 'error', error: msg }
    logOpen('transcript fail ' + task.id + ' ' + msg)
  } finally {
    transcribingCount--
    // 中间音频（wav/mp3/切片）用完就删，别把 tmp 越堆越大
    try { rmSync(workDir, { recursive: true, force: true }) } catch (e) {}
    save()
  }
}

/** 把一个任务的音频送去转写（自动/手动共用） */
function enqueueTranscribe(task, cfg, save) {
  if (transcribingCount >= 1) {
    task.transcript = { status: 'queued' }
    save()
    // 简单轮询等待前一个完成
    setTimeout(function () { enqueueTranscribe(task, cfg, save) }, 3000)
    return
  }
  transcribingCount++
  doTranscribe(task, cfg, save)
}

/** 任务队列 */
export function createQueue() {
  const tasks = loadTasks()
  let running = 0
  const settings = loadSettings.bind(null)

  function save() { saveTasks(tasks) }

  /** 删掉某个任务在 tmp 里的中间文件（含断点续传的 .part） */
  function cleanupTmp(id) {
    const dir = join(DATA_DIR, 'tmp')
    const names = [id + '_v.mp4', id + '_a.mp4', id + '_v.mp4.part', id + '_a.mp4.part']
    for (const n of names) { try { unlinkSync(join(dir, n)) } catch (e) {} }
  }

  function tick() {
    const limit = Math.max(1, Number(settings().concurrency) || 3)
    while (running < limit) {
      const next = tasks.find(function (t) { return t.status === 'pending' })
      if (!next) break
      runTask(next)
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  /** 一次下载尝试：需要就先解析，然后抓到输出文件；成功返回文件路径 */
  async function runAttempt(task, parsed, cfg) {
    if (!parsed || !parsed.streams) {
      task.status = 'parsing'
      save()
      parsed = await parseUrl(task.url, cfg, task.platform)
      task.parsed = parsed
      task.status = 'running'
      save()
    }
    if (!parsed.streams) throw new Error(parsed.note || '解析失败')
    // 重新解析有时只拿到「抖音_时间戳」这种兜底标题，别把原来的好标题冲掉
    const fallbackTitle = /^[^_]+_\d{10,}$/.test(String(parsed.title || ''))
    if (fallbackTitle && task.titleKeep) parsed.title = task.titleKeep
    if (task.title && /^[^_]+_\d{10,}$/.test(String(task.title)) === false && !task.titleKeep) task.titleKeep = task.title
    task.title = parsed.title
    task.platform = parsed.platform
    const outDir = outDirFor(cfg, parsed.platform)
    let outName = task.filename || fileNameFor(cfg, parsed.platform, parsed.title)
    if (!/\.[a-z0-9]{2,4}$/i.test(outName)) outName += '.mp4'
    const out = join(outDir, outName)
    task.file = out
    const tmpDir = join(DATA_DIR, 'tmp')
    ensureDir(tmpDir)

    // YouTube / X / Instagram / Facebook：交给 yt-dlp，它自己处理分片、签名、Referer
    if (parsed.via === 'yt-dlp' && parsed.pageUrl) {
      const isTT = parsed.platform === 'tiktok'
      const fmt = isTT ? 'bv*[vcodec^=h264]+ba/bv*+ba/b' : 'bv*+ba/b'
      const baseArgs = isTT ? tiktokArgs(cfg) : ytdlpArgs(cfg)
      const args = baseArgs.concat(['-f', fmt, '--merge-output-format', 'mp4',
        '-o', out, '--print', 'after_move:filepath', parsed.pageUrl])
      const r = await run(pick(YTDLP), args, 1800000)
      if (r.code !== 0) throw new Error('yt-dlp 下载失败：' + String(r.stderr).trim().split('\n').slice(-2).join(' ').slice(0, 200))
      if (!existsSync(out) && r.stdout.trim()) {
        const printed = r.stdout.trim().split('\n').pop()
        if (printed && existsSync(printed)) task.file = printed
      }
      task.got = existsSync(task.file) ? statSync(task.file).size : 0
      task.total = task.got
      return task.file
    }

    const vTmp = join(tmpDir, task.id + '_v.mp4')
    const aTmp = join(tmpDir, task.id + '_a.mp4')
    // 换下一个候选地址前，半截文件属于旧地址，续传会拼错，直接清掉
    const dropPart = function (p) { try { unlinkSync(p + '.part') } catch (e) {} }

    if (parsed.streams.hls) {
      const ref = parsed.platform === 'kuaishou' ? 'https://www.kuaishou.com/'
        : (parsed.platform === 'xhs' ? 'https://www.xiaohongshu.com/' : 'https://www.douyin.com/')
      const hdr = 'Referer: ' + ref + '\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36\r\n'
      const r = await run(pick(FFMPEG), ['-y', '-loglevel', 'error', '-headers', hdr, '-i', parsed.streams.hls, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', out], 1800000)
      if (r.code !== 0) throw new Error('HLS 下载失败')
      task.got = existsSync(out) ? statSync(out).size : 0
      task.total = task.got
      return out
    }

    const isKs = parsed.platform === 'kuaishou'
    const isXhs = parsed.platform === 'xhs'
    const ksUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003128) NetType/WIFI Language/zh_CN'
    const ref = isKs ? 'https://v.m.chenzhongtech.com/'
      : (isXhs ? 'https://www.xiaohongshu.com/'
        : (parsed.platform === 'weibo' ? 'https://weibo.com/'
          : (parsed.platform === 'bilibili' ? 'https://www.bilibili.com/'
            : (parsed.platform === 'tiktok' ? 'https://www.tiktok.com/' : 'https://www.douyin.com/'))))

    const vList = (parsed.streams.candidates && parsed.streams.candidates.video) || [parsed.streams.video]
    let lastErr = null
    let ok = false
    // 上一次已经下好的临时文件直接复用（免得上一次是合并失败、这次又把视频重下一遍）
    if (existsSync(vTmp) && statSync(vTmp).size > 0) {
      ok = true
      task.got = statSync(vTmp).size
      logOpen('reuse temp video ' + task.id + ' ' + task.got)
    }
    for (const u of ok ? [] : vList) {
      if (!u) continue
      try {
        const res = await downloadFile(u, vTmp, {
          referer: ref,
          userAgent: isKs ? ksUA : '',
          retries: 3,
          onProgress: function (got, total) { task.got = got; task.total = total || task.total }
        })
        if (!res || !res.size) throw new Error('空文件')
        ok = true
        break
      } catch (e) {
        lastErr = e
        dropPart(vTmp)
        logOpen('video candidate failed: ' + String(e.message || e).slice(0, 80))
      }
    }
    if (!ok) throw lastErr || new Error('所有视频地址都不可用')

    if (parsed.streams.audio) {
      const aList = (parsed.streams.candidates && parsed.streams.candidates.audio) || [parsed.streams.audio]
      let aOk = existsSync(aTmp) && statSync(aTmp).size > 0
      let aErr = null
      for (const u of aOk ? [] : aList) {
        if (!u) continue
        try {
          await downloadFile(u, aTmp, {
            referer: ref,
            userAgent: isKs ? ksUA : '',
            retries: 3,
            onProgress: function (got) { try { task.got = statSync(vTmp).size + got } catch (e) {} }
          })
          aOk = true
          break
        } catch (e) {
          aErr = e
          dropPart(aTmp)
          logOpen('audio candidate failed: ' + String(e.message || e).slice(0, 80))
        }
      }
      if (!aOk) throw aErr || new Error('音轨地址都不可用')
      await merge(vTmp, aTmp, out)
      try { unlinkSync(aTmp) } catch (e) {}
    } else {
      copyFileSync(vTmp, out)
    }
    try { unlinkSync(vTmp) } catch (e) {}
    dropPart(vTmp)
    dropPart(aTmp)
    task.got = existsSync(out) ? statSync(out).size : 0
    task.total = task.got
    return out
  }

  /**
   * 跑一个任务：失败自动重试，最多 3 次。
   * 直链 403/404/410 视为过期 → 清缓存重新解析；其他错误退避后重试（.part 还在，能续传）。
   */
  async function runTask(task) {
    running++
    task.startedAt = Date.now()
    task.attempt = 0
    const cfg = settings()
    let parsed = task.parsed
    const MAX_ATTEMPTS = 3
    try {
      while (true) {
        task.attempt++
        task.error = ''
        task.status = parsed && parsed.streams ? 'running' : 'parsing'
        save()
        try {
          const out = await runAttempt(task, parsed, cfg)
          task.status = 'done'
          task.finishedAt = Date.now()
          task.error = ''
          save()
          if (cfg.openAfter) openInExplorer(out)
          // 开着了才自动转写（默认关），本地模式不需要 key
          if (cfg.transcribe && cfg.transcribe.enabled) {
            const localOk = (cfg.transcribe.provider === 'local' || !cfg.transcribe.provider) && hostStt
            if (localOk || cfg.transcribe.apiKey) enqueueTranscribe(task, cfg, save)
            else task.transcript = { status: 'need_key' }
          }
          break
        } catch (e) {
          parsed = task.parsed
          const msg = String(e.message || e)
          const st = Number(e.httpStatus || 0)
          const expired = st === 403 || st === 404 || st === 410
          logOpen('task ' + task.id + ' attempt ' + task.attempt + '/' + MAX_ATTEMPTS + ' fail: ' + msg.slice(0, 140))
          if (task.attempt >= MAX_ATTEMPTS) throw e
          task.error = '第 ' + task.attempt + ' 次失败，自动重试中：' + msg.slice(0, 50)
          if (expired) {
            task.parsed = null
            parsed = null
            task.status = 'parsing'
            save()
            await sleep(700)
          } else {
            task.status = 'running'
            save()
            // 解析失败多半是平台限流，等一下再抓；纯下载失败按普通节奏退避
            const parseish = /解析|没抓到|没有找到视频流|页面里没有/.test(msg)
            await sleep(parseish ? 2500 * task.attempt : 1000 + 1200 * (task.attempt - 1))
          }
        }
      }
    } catch (e) {
      task.status = 'error'
      let msg = String(e.message || e)
      if (/EXDEV|cross-device/i.test(msg)) msg = '文件搬运失败，请重试'
      else if (/ENOSPC/i.test(msg)) msg = '磁盘空间不足'
      else if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(msg)) msg = '网络断了或连不上，检查网络后再点重试'
      else if (/下载不完整/.test(msg)) msg = 'CDN 中途断流了，点重试能从断点接着下'
      else if (/HTTP 4\d\d/i.test(msg)) msg = '视频地址已失效，点重试重新解析'
      else if (/合并失败/.test(msg)) msg = '音视频合并失败，请重试'
      if (task.attempt > 1) msg = msg + '（重试 ' + (task.attempt - 1) + ' 次仍失败）'
      task.error = msg.slice(0, 160)
      task.finishedAt = Date.now()
    } finally {
      save()
      running--
      tick()
    }
  }

  function enqueue(url, extra) {
    const task = Object.assign({
      id: randomUUID().slice(0, 8),
      url: url,
      status: 'pending',
      got: 0,
      total: 0,
      createdAt: Date.now()
    }, extra || {})
    tasks.unshift(task)
    save()
    tick()
    return task
  }

  function list() { return tasks }

  async function action(id, act) {
    const t = tasks.find(function (x) { return x.id === id })
    if (!t) return null
    if (act === 'remove') {
      const i = tasks.indexOf(t)
      if (i >= 0) tasks.splice(i, 1)
      cleanupTmp(t.id)
      save()
      return t
    }
    if (act === 'retry') {
      // 作者主页批量下来的任务，直链是解析那一刻拿的，过期了就得重新走一遍
      if (t.via === 'author') t.parsed = null
      t.status = 'pending'; t.error = ''; t.got = 0; t.total = 0
      save(); tick(); return t
    }
    if (act === 'open' && t.file) {
      t.lastOpen = await openWithApp(t.file)
      return t
    }
    if (act === 'reveal' && t.file) { t.lastOpen = await openPath(t.file, 'folder'); return t }
    return t
  }

  function clearFinished() {
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (tasks[i].status === 'done' || tasks[i].status === 'error') {
        cleanupTmp(tasks[i].id)
        tasks.splice(i, 1)
      }
    }
    save()
    return tasks
  }

  // 重启时把上次没跑完的标记为失败，避免卡住
  for (const t of tasks) {
    if (t.status === 'running') { t.status = 'error'; t.error = '上次退出时未完成' }
  }
  save()

  function transcribe(id) {
    const t = tasks.find(function (x) { return x.id === id })
    if (!t) return null
    if (t.status !== 'done' || !t.file) return null
    const cfg = settings()
    const localOk = (cfg.transcribe.provider === 'local' || !cfg.transcribe.provider) && hostStt
    if (!localOk && (!cfg.transcribe || !cfg.transcribe.apiKey)) {
      t.transcript = { status: 'need_key' }
      save()
      return t
    }
    enqueueTranscribe(t, cfg, save)
    return t
  }

  return { enqueue: enqueue, list: list, action: action, tick: tick, clearFinished: clearFinished, transcribe: transcribe }
}

// ---------------------------------------------------------------- 作者主页
// 解析跑在后台，界面按 id 轮询进度；只留最近 5 个，避免内存里堆一堆大列表
const authorJobs = new Map()

function authorJobView(job, withVideos) {
  const v = {
    id: job.id, url: job.url, status: job.status, error: job.error || '',
    author: job.author || null, fetched: job.fetched || 0,
    hasMore: !!job.hasMore, complete: !!job.complete, loggedIn: !!job.loggedIn,
    cancelled: !!job.cancelled, startedAt: job.startedAt, finishedAt: job.finishedAt || 0,
    total: (job.videos || []).length
  }
  if (withVideos) v.videos = job.videos || []
  return v
}

async function runAuthorJob(job, limit) {
  try {
    const r = await listAuthor(job.url, {
      limit: Number(limit) || 0,
      shouldStop: function () { return job.cancelled },
      onProgress: function (p) {
        job.fetched = p.fetched
        job.hasMore = p.hasMore
      }
    })
    job.author = r.author
    job.videos = r.videos
    job.fetched = r.videos.length
    job.hasMore = r.hasMore
    job.complete = r.complete
    job.loggedIn = r.loggedIn
    job.pageUrl = r.url
    job.status = 'done'
    logOpen('author done ' + job.id + ' ' + (r.author && r.author.nickname) + ' items=' + r.videos.length + ' loggedIn=' + r.loggedIn)
  } catch (e) {
    job.status = 'error'
    job.error = String(e.message || e).slice(0, 220)
    logOpen('author fail ' + job.id + ' ' + job.error)
  } finally {
    job.finishedAt = Date.now()
  }
}

/**
 * 把作者主页的解析结果塞进下载队列。
 * ids 为空 = 全部；返回 { queued, dup, skipped }
 */
export function enqueueAuthorVideos(job, ids, queue) {
  const st = loadSettings()
  const list = (job && job.videos) || []
  const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null
  const have = new Set(queue.list().map(function (t) { return t.url }))
  let queued = 0, dup = 0, skipped = 0
  for (const v of list) {
    if (wanted && !wanted.has(v.id)) continue
    if (!v.play) { skipped++; continue }
    const pageUrl = 'https://www.douyin.com/video/' + v.id
    if (have.has(pageUrl)) { dup++; continue }
    have.add(pageUrl)
    let nm = safeName(v.title || '') || ('作品_' + v.id)
    if (st.naming === 'platform_title' && nm.indexOf('抖音_') !== 0) nm = '抖音_' + nm
    if (st.naming === 'time') nm = '抖音_' + Date.now()
    const parsed = {
      ok: true, url: pageUrl, platform: 'douyin',
      title: v.title || ('抖音_' + v.id),
      duration: v.duration || 0, thumbnail: v.cover || '',
      streams: {
        video: v.play, audio: '', hls: '', mime: 'mp4',
        candidates: { video: [v.play], audio: [] }
      },
      via: 'author', note: '作者主页',
      preview: previewUrl({ video: v.play }, 'douyin')
    }
    queue.enqueue(pageUrl, {
      parsed: parsed,
      platform: 'douyin',
      via: 'author',
      authorName: job.author ? job.author.nickname : '',
      filename: nm + '_' + v.id.slice(-6) + '.mp4'
    })
    queued++
  }
  return { queued: queued, dup: dup, skipped: skipped }
}

function startAuthorJob(rawUrl, limit) {
  const job = {
    id: randomUUID().slice(0, 8),
    url: String(rawUrl || ''),
    status: 'running',
    videos: [],
    fetched: 0,
    hasMore: true,
    cancelled: false,
    startedAt: Date.now()
  }
  authorJobs.set(job.id, job)
  if (authorJobs.size > 5) {
    const oldest = [...authorJobs.keys()][0]
    authorJobs.delete(oldest)
  }
  runAuthorJob(job, limit)
  return job
}

export function startServer(opts) {
  const o = opts || {}
  const port = Number(o.port || process.env.ED_PORT || 7788)
  const queue = createQueue()
  // 必须用 fileURLToPath：用户名/路径含中文时 import.meta.url 的 pathname 是 percent-encoded
  // （%E5%B0%8F...），直接当路径用会找不到 ui.html，面板就 500 了。
  const uiFile = join(dirname(fileURLToPath(import.meta.url)), 'ui.html')

  const server = createHttpServer(async function (req, res) {
    const send = function (code, obj, type) {
      res.writeHead(code, {
        'content-type': type || 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      })
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
    }
    const readBody = function () {
      return new Promise(function (resolvePromise) {
        let b = ''
        req.on('data', function (d) { b += d })
        req.on('end', function () { try { resolvePromise(JSON.parse(b || '{}')) } catch (e) { resolvePromise({}) } })
      })
    }

    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (!existsSync(uiFile)) return send(500, 'ui.html missing', 'text/plain; charset=utf-8')
        return send(200, readFileSync(uiFile, 'utf8'), 'text/html; charset=utf-8')
      }
      // 预览代理：带上平台要求的 Referer/UA 转发视频流，支持 Range
      if (url.pathname === '/api/media' && req.method === 'GET') {
        const target = url.searchParams.get('u') || ''
        const plat = url.searchParams.get('p') || ''
        if (!/^https?:\/\//.test(target)) return send(400, { ok: false, message: 'bad url' })
        const isKs = plat === 'kuaishou'
        const ref = isKs ? 'https://v.m.chenzhongtech.com/'
          : (plat === 'xhs' ? 'https://www.xiaohongshu.com/'
            : (plat === 'weibo' ? 'https://weibo.com/'
              : (plat === 'bilibili' ? 'https://www.bilibili.com/'
                : (plat === 'tiktok' ? 'https://www.tiktok.com/' : 'https://www.douyin.com/'))))
        const headers = {
          'user-agent': isKs ? WX_UA : UA,
          referer: ref,
          accept: '*/*'
        }
        if (req.headers.range) headers.range = req.headers.range
        const r = await fetch(target, { headers: headers })
        const out = { 'content-type': r.headers.get('content-type') || 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
        const len = r.headers.get('content-length')
        if (len) out['content-length'] = len
        const cr = r.headers.get('content-range')
        if (cr) out['content-range'] = cr
        res.writeHead(r.status, out)
        if (!r.body) return res.end()
        Readable.fromWeb(r.body).pipe(res)
        return
      }
      if (url.pathname === '/api/env') {
        const list = envReport()
        const net = await probeGeneric()
        list.unshift({
          key: 'net', name: '境外网络（代理 / VPN）',
          ok: !!net.ok, version: net.ok ? ('可访问 · ' + net.ms + 'ms') : '连不上',
          purpose: 'TikTok、YouTube、X、Instagram、Facebook 需要能连境外',
          install: '打开代理软件（全局/TUN 模式），或在设置里填代理地址'
        })
        return send(200, { ok: true, env: list })
      }
      // 设置页（浏览器半侧）用它确认「这个端口上确实是我们的面板」。
      // 只回一句身份，不带任何设置，所以允许跨域。
      if (url.pathname === '/api/ping') {
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*'
        })
        return res.end(JSON.stringify({ ok: true, app: 'everything-down', version: '0.3.7' }))
      }
      if (url.pathname === '/api/net') {
        const net = await probeGeneric()
        return send(200, { ok: !!net.ok, ms: net.ms, hint: net.ok ? '' : NET_HINT })
      }
      if (url.pathname === '/api/state') {
        return send(200, { ok: true, settings: loadSettings(), tasks: queue.list() })
      }
      if (url.pathname === '/api/parse' && req.method === 'POST') {
        const body = await readBody()
        const t0 = Date.now()
        const r = await parseUrl(body.url, loadSettings(), body.platform)
        r.elapsed = Date.now() - t0
        return send(200, r)
      }
      // 批量：一次贴多行，全部入队（解析交给队列，不阻塞请求）
      if (url.pathname === '/api/batch' && req.method === 'POST') {
        const body = await readBody()
        const urls = extractAllUrls(body.text || body.url || '')
        if (!urls.length) return send(400, { ok: false, message: '没有识别到链接' })
        const created = urls.map(function (u) { return queue.enqueue(u, { platform: body.platform || '' }) })
        return send(200, { ok: true, count: created.length, ids: created.map(function (t) { return t.id }) })
      }
      if (url.pathname === '/api/download' && req.method === 'POST') {
        const body = await readBody()
        const url = extractUrl(body.url) || String(body.url || '').trim()
        if (!/^https?:\/\//.test(url)) return send(400, { ok: false, message: '没有识别到链接' })
        const task = queue.enqueue(url, { parsed: body.parsed || null, filename: body.filename || '', platform: body.platform || '' })
        return send(200, { ok: true, task: task })
      }
      // ---- 作者主页 ----
      if (url.pathname === '/api/author' && req.method === 'POST') {
        const body = await readBody()
        const link = extractUrl(body.url) || String(body.url || '').trim()
        if (!/^https?:\/\//.test(link)) return send(400, { ok: false, message: '没有识别到主页链接' })
        if (!/douyin\.com|iesdouyin/.test(link)) return send(400, { ok: false, message: '目前只支持抖音作者主页' })
        const job = startAuthorJob(body.url, body.limit)
        logOpen('author start ' + job.id + ' ' + link)
        return send(200, { ok: true, id: job.id })
      }
      if (url.pathname === '/api/author' && req.method === 'GET') {
        const job = authorJobs.get(url.searchParams.get('id') || '')
        if (!job) return send(404, { ok: false, message: '解析任务不在了，重新解析一次' })
        return send(200, { ok: true, job: authorJobView(job, url.searchParams.get('meta') !== '1') })
      }
      if (url.pathname === '/api/author/stop' && req.method === 'POST') {
        const body = await readBody()
        const job = authorJobs.get(body.id || '')
        if (!job) return send(404, { ok: false, message: '解析任务不在了' })
        job.cancelled = true
        return send(200, { ok: true })
      }
      // 一键下载：不传 ids 就是全部
      if (url.pathname === '/api/author/download' && req.method === 'POST') {
        const body = await readBody()
        const job = authorJobs.get(body.id || '')
        if (!job) return send(404, { ok: false, message: '解析任务不在了，重新解析一次' })
        if (!job.videos || !job.videos.length) return send(400, { ok: false, message: '还没有解析出作品' })
        const res = enqueueAuthorVideos(job, body.ids, queue)
        logOpen('author download ' + job.id + ' queued=' + res.queued + ' dup=' + res.dup + ' skipped=' + res.skipped)
        return send(200, Object.assign({ ok: true }, res))
      }
      // 打开可见窗口扫码登录（登录态存在固定用户目录，下次直接用）
      if (url.pathname === '/api/author/login' && req.method === 'POST') {
        try {
          const r = await openAuthorLogin()
          return send(200, { ok: true, reused: !!r.reused })
        } catch (e) {
          return send(500, { ok: false, message: String(e.message || e) })
        }
      }
      if (url.pathname === '/api/author/state') {
        return send(200, Object.assign({ ok: true }, await authorLoginState()))
      }
      // ---- 图文（图集） ----
      if (url.pathname === '/api/gallery' && req.method === 'POST') {
        const body = await readBody()
        try {
          const g = await galleryOne(body.url, {})
          // 快手这类页面标题只有平台名，用用户粘的分享文案兜一下
          if (!g.title || /^(快手|抖音|小红书|图文)$/.test(String(g.title).trim())) {
            const fromText = galleryTitleFromText(body.url)
            if (fromText) g.title = fromText
          }
          logOpen('gallery ' + g.platform + ' imgs=' + g.images.length + ' ' + String(g.title || '').slice(0, 30))
          return send(200, g)
        } catch (e) {
          return send(200, { ok: false, message: String(e.message || e).slice(0, 200) })
        }
      }
      if (url.pathname === '/api/gallery/download' && req.method === 'POST') {
        const body = await readBody()
        const list = Array.isArray(body.images) ? body.images : []
        if (!list.length) return send(400, { ok: false, message: '没有图片可保存' })
        const cfg = loadSettings()
        const platform = platformOf(body.url || '') || String(body.platform || 'douyin')
        const dir = join(outDirFor(cfg, platform), safeName(body.title || ('图文_' + Date.now())))
        ensureDir(dir)
        const referer = platform === 'xhs' ? 'https://www.xiaohongshu.com/'
          : (platform === 'kuaishou' ? 'https://v.m.chenzhongtech.com/' : 'https://www.douyin.com/')
        const ua = platform === 'kuaishou' ? WX_UA : ''
        const saved = []
        let failed = 0
        for (let i = 0; i < list.length; i++) {
          const u = String(list[i] || '')
          if (!/^https?:\/\//.test(u)) { failed++; continue }
          const ext = /\.png(\?|$)/i.test(u) ? '.png' : (/webp/i.test(u) ? '.webp' : '.jpg')
          const name = String(i + 1).padStart(2, '0') + ext
          const file = join(dir, name)
          try {
            await downloadFile(u, file, { referer: referer, userAgent: ua, retries: 3 })
            saved.push(name)
          } catch (e) {
            failed++
            logOpen('gallery img fail ' + String(e.message || e).slice(0, 60))
          }
        }
        logOpen('gallery saved ' + saved.length + '/' + list.length + ' -> ' + dir)
        return send(200, { ok: true, dir: dir, saved: saved.length, failed: failed })
      }
      if (url.pathname === '/api/tasks') return send(200, { ok: true, tasks: queue.list() })
      // 手动触发转写
      if (url.pathname === '/api/transcribe' && req.method === 'POST') {
        const body = await readBody()
        const t = queue.transcribe(body.id)
        if (!t) return send(400, { ok: false, message: '任务不存在或还没下载完' })
        const st = (t.transcript && t.transcript.status) || ''
        return send(200, { ok: true, task: t, message: st === 'need_key' ? '还没填 API key' : '已开始提取' })
      }
      // 读取文稿
      if (url.pathname === '/api/transcript' && req.method === 'GET') {
        const id = url.searchParams.get('id') || ''
        const data = readTranscript(id)
        if (!data) return send(404, { ok: false, message: '还没有文稿' })
        return send(200, { ok: true, transcript: data })
      }
      // 下载字幕文件
      if (url.pathname === '/api/transcript/srt' && req.method === 'GET') {
        const id = url.searchParams.get('id') || ''
        const data = readTranscript(id)
        if (!data) return send(404, '还没有文稿', 'text/plain; charset=utf-8')
        const srt = toSrt(data.segments || [])
        res.writeHead(200, {
          'content-type': 'application/x-subrip; charset=utf-8',
          'content-disposition': 'attachment; filename="' + encodeURIComponent((data.title || 'subtitle').slice(0, 40)) + '.srt"'
        })
        return res.end(srt)
      }
      // 纯文本下载
      if (url.pathname === '/api/transcript/txt' && req.method === 'GET') {
        const id = url.searchParams.get('id') || ''
        const data = readTranscript(id)
        if (!data) return send(404, '还没有文稿', 'text/plain; charset=utf-8')
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="' + encodeURIComponent((data.title || 'transcript').slice(0, 40)) + '.txt"'
        })
        return res.end(data.text || '')
      }
      if (url.pathname === '/api/tasks/clear' && req.method === 'POST') {
        return send(200, { ok: true, tasks: queue.clearFinished() })
      }
      if (url.pathname === '/api/task' && req.method === 'POST') {
        const body = await readBody()
        const t = await queue.action(body.id, body.action)
        return send(200, { ok: !!t, task: t, message: (t && t.lastOpen && t.lastOpen.message) || '' })
      }
      if (url.pathname === '/api/settings') {
        if (req.method === 'POST') {
          const body = await readBody()
          return send(200, { ok: true, settings: saveSettings(body) })
        }
        return send(200, { ok: true, settings: loadSettings() })
      }
      if (url.pathname === '/api/open' && req.method === 'POST') {
        const body = await readBody()
        const r = await openPath(body.path || '', body.mode || 'folder')
        return send(200, r)
      }
      if (url.pathname === '/api/jianying') {
        const p = findJianying(true)
        return send(200, { ok: true, path: p, found: !!p })
      }
      if (url.pathname === '/api/pick-app') {
        const ps = 'Add-Type -AssemblyName System.Windows.Forms;'
          + '$d = New-Object System.Windows.Forms.OpenFileDialog;'
          + '$d.Filter = "程序 (*.exe)|*.exe|所有文件 (*.*)|*.*";'
          + '$d.Title = "选择要用它打开视频的程序";'
          + 'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileName }'
        const rr = await new Promise(function (resolvePromise) {
          const child = spawn(powershellBin(), ['-NoProfile', '-STA', '-Command', ps], { windowsHide: false })
          let out = ''
          child.stdout.on('data', function (d) { out += d.toString() })
          child.on('close', function () { resolvePromise(out.trim()) })
        })
        return send(200, { ok: !!rr, path: rr })
      }
      if (url.pathname === '/api/pick-dir') {
        // 用 PowerShell 弹目录选择框：先建一个置顶小窗口当 owner，
        // 否则对话框会跑到调用方窗口后面（浏览器/客户端被挡住就以为没反应）
        const ps = 'Add-Type -AssemblyName System.Windows.Forms;'
          + '$owner = New-Object System.Windows.Forms.Form;'
          + '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Width = 1; $owner.Height = 1;'
          + '$owner.StartPosition = "CenterScreen"; $owner.Opacity = 0; $owner.Show();'
          + '[System.Windows.Forms.Application]::DoEvents();'
          + '$d = New-Object System.Windows.Forms.FolderBrowserDialog;'
          + '$d.Description = "选择保存目录"; $d.ShowNewFolderButton = $true;'
          + '$ok = $d.ShowDialog($owner);'
          + '$owner.Close();'
          + 'if ($ok -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }'
        const r = await new Promise(function (resolvePromise) {
          const child = spawn('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: false })
          let out = ''
          child.stdout.on('data', function (d) { out += d.toString() })
          child.on('close', function () { resolvePromise(out.trim()) })
        })
        return send(200, { ok: !!r, path: r })
      }
      return send(404, { ok: false, message: 'not found' })
    } catch (e) {
      return send(500, { ok: false, message: String(e.message || e) })
    }
  })

  // 端口被占就往后试几个，别直接报到界面上。
  // Windows 上不能指望 EADDRINUSE：SO_REUSEADDR 允许两个进程绑同一端口，
  // listen 根本不报错，结果是「面板看着起来了、其实连不上」。所以先主动探一下。
  function portInUse(p) {
    return new Promise(function (resolve) {
      const sock = netConnect({ port: p, host: '127.0.0.1' })
      let done = false
      const finish = function (v) {
        if (done) return
        done = true
        try { sock.destroy() } catch (e) {}
        resolve(v)
      }
      sock.once('connect', function () { finish(true) })
      sock.once('error', function () { finish(false) })
      setTimeout(function () { finish(false) }, 800)
    })
  }

  return (async function () {
    let p = port
    for (let i = 0; i < 6; i++) {
      const busy = await portInUse(p)
      if (!busy) break
      logOpen('port ' + p + ' busy, trying ' + (p + 1))
      p++
    }
    return new Promise(function (resolvePromise, reject) {
      server.once('error', reject)
      server.listen({ port: p, host: '127.0.0.1' }, function () {
        server.removeListener('error', reject)
        queue.tick()
        resolvePromise({ server: server, port: p, queue: queue, url: 'http://127.0.0.1:' + p })
      })
    })
  })()
}
