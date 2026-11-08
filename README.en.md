<div align="center">

# Everything Down

**Paste a link. Get the watermark-free video.**

**Kuaishou and Xiaohongshu included — most downloaders can't do those two.**

[![MIT](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](./LICENSE)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4?style=flat-square)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square)]()
[![Version](https://img.shields.io/badge/version-0.5.0-f2560d?style=flat-square)]()

<img src="assets/hero.jpg" alt="Everything Down" width="100%" />

<sub>Download → organize → transcribe. Everything runs locally; your video never leaves the machine.</sub>

</div>

---

## Why this one

Plenty of tools download Douyin. **Almost none handle Kuaishou and Xiaohongshu reliably.**

This plugin does:

- **Kuaishou**: the desktop page plays a recommended feed instead of the target video. We use the mobile share page with a WeChat UA to get the real stream.
- **Xiaohongshu**: direct links return 403 unless the Referer is set.
- **Douyin**: video and audio are separate streams; they get merged automatically.

## Supported platforms

| Platform | Status | Notes |
| --- | --- | --- |
| Kuaishou | ✅ | Mobile share page, no watermark |
| Xiaohongshu | ✅ | Desktop page sniffing, no watermark |
| Douyin | ✅ | Separate video/audio merged |
| Bilibili | ✅ | 480P without login, higher when signed in |
| Weibo / Xigua / X / Instagram / Facebook / YouTube / TikTok | ✅ | Public content |
| Douyin creator pages / image galleries | ✅ | Douyin, Kuaishou, Xiaohongshu galleries |

> Douyin now **requires a login** to parse. The home screen has a login banner — scan the QR code once and the session is stored locally.

## Features

| Feature | Description |
| --- | --- |
| **Batch paste** | One link per line, dozens at once, auto-detected and queued |
| **Creator pages** (Douyin) | List every work of a creator, pick and download in bulk |
| **Library** | Everything downloaded is archived with thumbnails, searchable, filterable by platform or custom category |
| **Subscriptions** (Douyin) | Follow creators, check for new works, queue them in one click |
| **Transcripts** | Local speech-to-text (free, offline), export TXT / SRT / storyboard Markdown |
| **Extract MP3** | One click on any finished video |
| **Live progress** | Speed, ETA, resume, automatic retries |
| **Quality presets** | Best / 1080P / 720P / 480P (Bilibili, YouTube and other yt-dlp platforms) |
| **Open with** | System player / Jianying (CapCut CN) / custom program |
| **MCP** | Callable from Claude Code, Cursor, Codex and other AI clients |

## Install

Requires the DSH (DeepSeek Harness) client.

```powershell
git clone https://github.com/hzwym8912-code/dsh-everything-down.git
cd dsh-everything-down
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

Restart the DSH client, then open **http://127.0.0.1:7788**.

External tools (not bundled): **Chrome/Edge**, **ffmpeg** (`winget install Gyan.FFmpeg`), **yt-dlp** (`winget install yt-dlp`).

## MCP

```json
{
  "mcpServers": {
    "everything-down": {
      "command": "node",
      "args": ["<plugin-dir>/bin/mcp.js"]
    }
  }
}
```

Tools: `ed_parse`, `ed_download`, `ed_batch`, `ed_tasks`, `ed_author`, `ed_gallery`, `ed_settings`, `ed_panel`.

## FAQ

**Why does Douyin fail to parse?** It now requires a login. Use the login button on the home screen; the session is stored locally and expires occasionally — scan again when it does.

**Do Kuaishou and Xiaohongshu need a login?** No, public content works directly.

**Where are the files?** Default `D:\下载\短视频\{platform}\`, configurable in Settings.

**Can it download private or paid content?** No. Only what your own session can already open.

## License

[MIT](./LICENSE)

---

<div align="center">
<sub>中文说明：<a href="./README.md">README.md</a></sub>
</div>
