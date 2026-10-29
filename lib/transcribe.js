/**
 * 文字提取（语音转写）
 *
 * 流程：视频 → ffmpeg 抽成小音频 → 需要时切片 → 调服务商接口 → 合并文本
 * 只上传音频，视频文件始终在本机。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pick, FFMPEG } from './engine.js'

// 各家对单次音频的限制不一样：GLM 只收 30 秒，OpenAI 能收 25 分钟
const CHUNK_LIMITS = { glm: 30, openai: 1200, siliconflow: 300, custom: 300 }
const MAX_CHUNK_SEC = 1200   // 上限值，具体按服务商收窄
const MAX_BYTES = 24 * 1024 * 1024

function run(cmd, args, timeoutMs) {
  return new Promise(function (resolvePromise) {
    const child = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(function () { try { child.kill('SIGKILL') } catch (e) {} }, timeoutMs || 600000)
    child.stdout.on('data', function (d) { out += d.toString() })
    child.stderr.on('data', function (d) { err += d.toString() })
    child.on('error', function (e) { clearTimeout(timer); resolvePromise({ code: -1, out: out, err: err + ' ' + e.message }) })
    child.on('close', function (c) { clearTimeout(timer); resolvePromise({ code: c, out: out, err: err }) })
  })
}

/** 取视频时长（秒） */
export async function probeDuration(file) {
  const r = await run(pick(FFMPEG).replace(/ffmpeg\.exe$/i, 'ffprobe.exe'), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
  ], 60000)
  const n = parseFloat(String(r.out).trim())
  return Number.isFinite(n) ? n : 0
}

/**
 * 把 ffmpeg 写出的 WAV 削成「44 字节标准头 + PCM16」
 *
 * 宿主的本地识别（SenseVoice）只收最朴素的 WAV：fmt 块必须紧跟 WAVE、
 * data 块必须在第 36 字节开始。而 ffmpeg 会往里塞 LIST/INFO 块（ICMT/Lavf 版本号），
 * 头一变长就直接被判 Invalid speech WAV。所以这里重写一遍头，只保留真正的音频数据。
 */
export function canonicalWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 数据')
  }
  let fmt = null
  let pcm = null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = buf.subarray(body, Math.min(body + size, buf.length))
    } else if (id === 'data') {
      // 有些 ffmpeg 版本把 data size 写成 0 或超出实际文件，按实际剩下的字节算
      const end = size > 0 && body + size <= buf.length ? body + size : buf.length
      pcm = buf.subarray(body, end)
      break
    }
    off = body + size + (size % 2)
  }
  if (!fmt || !pcm) throw new Error('WAV 缺少 fmt/data 块')
  const channels = fmt.readUInt16LE(2)
  const rate = fmt.readUInt32LE(4)
  const bits = fmt.readUInt16LE(14)
  if (channels !== 1 || rate !== 16000 || bits !== 16) {
    throw new Error('WAV 格式不对（需要 16k 单声道 16bit，实际 ' + rate + 'Hz/' + channels + '声道/' + bits + 'bit）')
  }
  const usable = pcm.length - (pcm.length % 2)
  const out = Buffer.allocUnsafe(44 + usable)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(out.length - 8, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)   // PCM
  out.writeUInt16LE(1, 22)   // 单声道
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(usable, 40)
  pcm.copy(out, 44, 0, usable)
  return out
}

/** 抽 WAV 给本地模型用（16k 单声道，已削成标准头） */
export async function extractWav(video, outDir) {
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'audio.wav')
  const r = await run(pick(FFMPEG), [
    '-y', '-loglevel', 'error', '-i', video,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-map_metadata', '-1', '-fflags', '+bitexact',
    out
  ], 1800000)
  if (r.code !== 0 || !existsSync(out)) throw new Error('抽音频失败：' + String(r.err).slice(-160))
  writeFileSync(out, canonicalWav(readFileSync(out)))
  return out
}

/** 用宿主自带的本地语音模型转写（不联网、不花钱） */
// 宿主本地模型单次最多收 4MB 音频（16k 单声道约 2 分钟），超了必须切
const LOCAL_CHUNK_SEC = 110

export async function transcribeLocal(video, stt, workDir, onProgress) {
  if (!stt) throw new Error('宿主没有提供本地语音服务')
  const duration = await probeDuration(video)
  const wav = await extractWav(video, workDir)
  mkdirSync(workDir, { recursive: true })

  const chunks = []
  if (duration <= LOCAL_CHUNK_SEC) {
    chunks.push({ file: wav, offset: 0 })
  } else {
    const count = Math.ceil(duration / LOCAL_CHUNK_SEC)
    for (let i = 0; i < count; i++) {
      const start = i * LOCAL_CHUNK_SEC
      const file = join(workDir, 'w' + i + '.wav')
      const r = await run(pick(FFMPEG), [
        '-y', '-loglevel', 'error', '-ss', String(start), '-t', String(LOCAL_CHUNK_SEC),
        '-i', wav, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
        '-map_metadata', '-1', '-fflags', '+bitexact', file
      ], 600000)
      if (r.code === 0 && existsSync(file)) {
        // 切片同样会被 ffmpeg 塞元数据块，一并削成标准头
        try { writeFileSync(file, canonicalWav(readFileSync(file))) } catch (e) {}
        chunks.push({ file: file, offset: start })
      }
    }
    try { unlinkSync(wav) } catch (e) {}
  }
  if (!chunks.length) throw new Error('音频切片失败')

  let text = ''
  let segments = []
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress('transcribing', Math.round((i / chunks.length) * 100))
    // 兜底再规整一次：宿主只认 44 字节标准头
    const audio = canonicalWav(readFileSync(chunks[i].file))
    let raw
    try {
      const spec = stt.resolve({ audio: audio, language: 'zh' })
      raw = await stt.transcribe(spec, new AbortController().signal)
    } catch (e) {
      for (const c of chunks) { try { unlinkSync(c.file) } catch (err) {} }
      throw new Error('本地识别失败（第 ' + (i + 1) + '/' + chunks.length + ' 段）：' + String(e.message || e).slice(0, 140))
    }
    let t = ''
    if (typeof raw === 'string') t = raw
    else if (raw && typeof raw === 'object') {
      t = String(raw.text || raw.transcript || '')
      if (Array.isArray(raw.segments)) {
        segments = segments.concat(raw.segments.map(function (s) {
          return { start: Number(s.start || 0) + chunks[i].offset, end: Number(s.end || 0) + chunks[i].offset, text: String(s.text || '').trim() }
        }))
      }
    }
    if (t) text += (text ? '\n' : '') + t.trim()
    if (chunks[i].file !== wav) { try { unlinkSync(chunks[i].file) } catch (e) {} }
  }
  if (!text) throw new Error('本地识别没有返回文字')
  if (onProgress) onProgress('transcribing', 100)
  return { text: text.trim(), segments: segments, chars: text.replace(/\s/g, '').length, seconds: Math.round(duration) }
}

/** 抽音频：16k 单声道 mp3，体积约为原视频的百分之一 */
export async function extractAudio(video, outDir, onProgress) {
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'audio.mp3')
  const r = await run(pick(FFMPEG), [
    '-y', '-loglevel', 'error', '-i', video,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out
  ], 1800000)
  if (r.code !== 0 || !existsSync(out)) throw new Error('抽音频失败：' + String(r.err).slice(-160))
  if (onProgress) onProgress('audio', statSync(out).size)
  return out
}

/** 超过限制就切片，返回 [{file, offset}] */
export async function sliceAudio(audio, durationSec, outDir, provider) {
  const limit = Math.min(CHUNK_LIMITS[provider] || 300, MAX_CHUNK_SEC)
  const size = statSync(audio).size
  const needByTime = durationSec > limit
  const needBySize = size > MAX_BYTES
  if (!needByTime && !needBySize) return [{ file: audio, offset: 0 }]

  const parts = []
  const count = Math.ceil(durationSec / limit)
  for (let i = 0; i < count; i++) {
    const start = i * limit
    const file = join(outDir, 'part' + i + '.mp3')
    const r = await run(pick(FFMPEG), [
      '-y', '-loglevel', 'error', '-ss', String(start), '-t', String(limit),
      '-i', audio, '-c', 'copy', file
    ], 600000)
    if (r.code === 0 && existsSync(file)) parts.push({ file: file, offset: start })
  }
  return parts.length ? parts : [{ file: audio, offset: 0 }]
}

/** 调服务商（OpenAI 兼容的 /audio/transcriptions） */
export async function callApi(part, cfg) {
  const buf = readFileSync(part.file)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3')
  form.append('model', cfg.model || 'whisper-1')
  form.append('response_format', 'verbose_json')
  if (cfg.language) form.append('language', cfg.language)

  const base = String(cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')
  let res
  try {
    res = await fetch(base + '/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + cfg.apiKey },
      body: form
    })
  } catch (e) {
    const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : ''
    throw new Error('连不上这个接口' + (cause ? '（' + cause + '）' : '') +
      '。国外服务在国内常常连不上，换个能访问的服务商试试')
  }
  if (!res.ok) {
    let detail = ''
    try { detail = (await res.text()).slice(0, 200) } catch (e) {}
    throw new Error('接口返回 ' + res.status + '：' + detail)
  }
  const j = await res.json()
  return {
    text: String(j.text || ''),
    segments: Array.isArray(j.segments)
      ? j.segments.map(function (s) {
        return { start: Number(s.start || 0) + part.offset, end: Number(s.end || 0) + part.offset, text: String(s.text || '').trim() }
      })
      : []
  }
}

/** 完整流程；返回 { text, segments, chars, seconds } */
export async function transcribeVideo(video, cfg, workDir, onProgress) {
  if (!cfg || !cfg.apiKey) throw new Error('还没有填写 API key')
  const duration = await probeDuration(video)
  const audio = await extractAudio(video, workDir, onProgress)
  const parts = await sliceAudio(audio, duration, workDir, cfg.provider)
  if (onProgress) onProgress('sliced', parts.length)

  let text = ''
  let segments = []
  for (let i = 0; i < parts.length; i++) {
    if (onProgress) onProgress('transcribing', Math.round((i / parts.length) * 100))
    const r = await callApi(parts[i], cfg)
    text += (text ? '\n' : '') + r.text
    segments = segments.concat(r.segments)
  }
  // 清理中间文件
  for (const p of parts) { if (p.file !== audio) { try { unlinkSync(p.file) } catch (e) {} } }
  try { unlinkSync(audio) } catch (e) {}

  return { text: text.trim(), segments: segments, chars: text.replace(/\s/g, '').length, seconds: Math.round(duration) }
}

/** verbose_json 的分段转成 SRT */
export function toSrt(segments) {
  const pad = function (n, w) { return String(n).padStart(w || 2, '0') }
  const fmt = function (sec) {
    const s = Math.max(0, sec)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = Math.floor(s % 60)
    const ms = Math.round((s - Math.floor(s)) * 1000)
    return pad(h) + ':' + pad(m) + ':' + pad(ss) + ',' + pad(ms, 3)
  }
  return segments.map(function (s, i) {
    return (i + 1) + '\n' + fmt(s.start) + ' --> ' + fmt(s.end) + '\n' + s.text + '\n'
  }).join('\n')
}
