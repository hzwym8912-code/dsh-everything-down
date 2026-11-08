<div align="center">

# Everything Down

**贴个链接，无水印视频直接下**

**快手、小红书也能下 —— 这是大多数下载器做不到的**

[![MIT](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](./LICENSE)
[![Windows](https://img.shields.io/badge/platform-Windows-0078d4?style=flat-square)]()
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square)]()
[![Version](https://img.shields.io/badge/version-0.5.0-f2560d?style=flat-square)]()

<img src="assets/hero.jpg" alt="Everything Down" width="100%" />

<sub>下载 → 归档 → 转文字稿，一条龙。全部在本机完成，视频不上传云端。</sub>

</div>

---

## 为什么选它

能下抖音的下载器很多，**能稳定下快手和小红书的几乎没有**。

这个插件专门啃这两个平台：

- **快手**：桌面页面不播目标视频（只播推荐流），得用移动端分享页 + 微信 UA 才拿得到真视频；
- **小红书**：直链要带 Referer 才生效，普通请求一律 403；
- **抖音**：音视频是分开的两条流，下完还得合并。

这些坑都趟过了，代码里每一处都有注释说明为什么这么写。

## 支持平台

| 平台 | 状态 | 备注 |
| --- | --- | --- |
| 快手 | ✅ | 移动端分享页，无水印 |
| 小红书 | ✅ | 桌面页抓流，无水印 |
| 抖音 | ✅ | 音视频分轨自动合并 |
| B站 | ✅ | 未登录最高 480P，登录后更高 |
| 微博 / 西瓜 / X / Instagram / Facebook / YouTube / TikTok | ✅ | 公开内容 |
| 抖音作者主页 / 图文图集 | ✅ | 抖音、快手、小红书图集 |

> 抖音现在**必须登录**才给解析（未登录会被验证码页拦住）。首页有登录状态条，点「登录抖音」扫码即可。

## 功能

| 功能 | 说明 |
| --- | --- |
| **批量粘贴** | 一行一条，一次贴几十条链接，自动识别、一起排队 |
| **作者主页**（抖音） | 列出博主全部作品，勾选批量下载 |
| **素材库** | 下载过的自动归档：缩略图网格、搜索、按平台或自建分类筛选 |
| **博主订阅**（抖音） | 关注博主，检查新作品，一键入队 |
| **文字稿** | 下载完转文字（默认用本机模型，免费不联网），导出 TXT / SRT / 分镜表 |
| **转 MP3** | 已下载的视频一键提取音频 |
| **实时进度** | 速度、剩余时间、断点续传、失败自动重试 |
| **画质选择** | 最好 / 1080P / 720P / 480P（对 B站、YouTube 等生效） |
| **打开方式** | 系统播放器 / 剪映 / 自定义程序 |
| **MCP** | 给 Claude Code、Cursor、Codex 等 AI 客户端调用 |

## 安装

需要先装好 DSH（DeepSeek Harness）客户端。然后：

```powershell
git clone https://github.com/hzwym8912-code/dsh-everything-down.git
cd dsh-everything-down
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

装完**重启 DSH 客户端**，设置左侧会出现 **Everything down**，点进去就是完整工作台。

也可以直接访问面板：**http://127.0.0.1:7788**

> 插件本身不打包外部工具，缺了面板「设置 → 环境依赖」会提示。需要的三样：
> - **Chrome / Edge**（抖音、快手、小红书要开网页抓流）
> - **ffmpeg**（合并、转码、提取音频）：`winget install Gyan.FFmpeg`
> - **yt-dlp**（B站、微博等）：`winget install yt-dlp`

卸载（连同设置和任务记录一起删）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -PurgeData
```

## 用法

1. 打开面板 → 左侧「下载台」
2. 粘贴链接（一行一条，或整段分享文案）
3. 点「开始解析」或「识别并排队」
4. 下完的视频进「素材库」，可按平台或自建分类归档
5. 需要文字稿就点「提取文案」，能导出 TXT / 字幕 SRT / 分镜表

## 给 AI 用（MCP）

`bin/mcp.js` 是一个标准 MCP 服务，Claude Code、Cursor、Codex、WorkBuddy 等都能挂。它只是「遥控器」，解析、下载、队列全部交给本机面板，不会另起一套。

```json
{
  "mcpServers": {
    "everything-down": {
      "command": "node",
      "args": ["<插件目录>/bin/mcp.js"]
    }
  }
}
```

可用工具：`ed_parse`、`ed_download`、`ed_batch`、`ed_tasks`、`ed_author`、`ed_gallery`、`ed_settings`、`ed_panel`。

## 常见问题

**为什么解析不到抖音？**
抖音现在要求登录。点首页的「登录抖音」扫码，登录态会存在本机，下次直接用。登录态会过期，过期了重新扫一次。

**快手/小红书要不要登录？**
不用，公开内容直接能下。

**下载的视频在哪？**
默认 `D:\下载\短视频\{平台名}\`，可以在「设置 → 保存目录」里改。

**能下私密/会员内容吗？**
不能。只下你自己登录后能看到的公开内容。

**B站为什么只有 480P？**
未登录的上限。在插件里登录 B站浏览器档案后可以更高。

## 许可

[MIT](./LICENSE)

---

<div align="center">
<sub>English: <a href="./README.en.md">README.en.md</a></sub>
</div>
