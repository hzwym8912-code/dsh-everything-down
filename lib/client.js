/**
 * Everything down —— 浏览器半侧
 *
 * 只做一件事：在「设置」左侧加一项 Everything down，点进去直接嵌工作台页面。
 * 面板功能全在 127.0.0.1 的那个面板里，这里不复刻任何功能。
 *
 * 面板端口不是写死的：先问宿主 /everything-down/panel 要真实地址
 * （7788 被占用时面板会顺延到 7789、7790…），拿不到才退回默认 7788。
 */
window.__ModuleLoader__.load({
  id: "dsh-everything-down",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    const react = require("react")

    const NS = "everything-down"
    const DEFAULT_URL = "http://127.0.0.1:7788"
    const INFO_PATH = "/everything-down/panel"

    const zh = { nav: "Everything down", title: "Everything down 工作台" }
    const en = { nav: "Everything down", title: "Everything down" }

    const btn = {
      font: "inherit",
      fontSize: "12px",
      lineHeight: "18px",
      padding: "4px 10px",
      borderRadius: "6px",
      border: "1px solid var(--dsw-alias-border-l2, #d9dee8)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary, #12151c)",
      cursor: "pointer"
    }
    const muted = { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #98a1b0)" }

    // 端口候选：默认 7788，被占用时面板会往后顺延几个
    const PING_PORTS = []
    for (let p = 7788; p <= 7810; p++) PING_PORTS.push(p)

    /** 问一个端口：这个地址上是不是我们的面板 */
    function pingPort(port) {
      return new Promise((resolve, reject) => {
        const ctrl = new AbortController()
        const timer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, 700)
        fetch("http://127.0.0.1:" + port + "/api/ping", { cache: "no-store", signal: ctrl.signal })
          .then((r) => (r && r.ok ? r.json() : Promise.reject(new Error("http"))))
          .then((j) => {
            clearTimeout(timer)
            if (j && j.app === "everything-down") resolve("http://127.0.0.1:" + port)
            else reject(new Error("mismatch"))
          })
          .catch((e) => { clearTimeout(timer); reject(e) })
      })
    }

    /** 扫一遍候选端口，找到真正在跑的那个面板 */
    async function discoverPanel() {
      const hits = await Promise.all(PING_PORTS.map((p) => pingPort(p).catch(() => null)))
      return hits.find(Boolean) || ""
    }

    /**
     * 面板地址：先问宿主的同源接口（web 模式最准），
     * 拿不到就自己扫端口（Electron 客户端里没有那个接口）。
     */
    function usePanelUrl(nonce) {
      const [url, setUrl] = react.useState("")
      const [state, setState] = react.useState("loading")
      react.useEffect(() => {
        let alive = true
        const finish = (u, s) => { if (alive) { setUrl(u); setState(s) } }
        const askHost = () => {
          let pending
          try { pending = fetch(INFO_PATH, { cache: "no-store" }) } catch (e) { pending = Promise.reject(e) }
          return pending
            .then((r) => (r && r.ok ? r.json() : Promise.reject(new Error("http"))))
            .then((info) => (info && info.url ? String(info.url) : Promise.reject(new Error("empty"))))
            .catch(() => "")
        }
        setState("loading")
        askHost()
          .then((u) => {
            if (u) { finish(u, "ready"); return null }
            return discoverPanel().then((found) => {
              if (found) finish(found, "ready")
              else finish(DEFAULT_URL, "fallback")
            })
          })
          .catch(() => finish(DEFAULT_URL, "fallback"))
        return () => { alive = false }
      }, [nonce])
      return { url, state }
    }

    function WorkbenchSection() {
      const h = react.createElement
      const [nonce, setNonce] = react.useState(0)
      const { url, state } = usePanelUrl(nonce)
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "10px", minWidth: 0 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          h("span", { style: muted }, state === "ready" ? "本机工作台 · " + url : (state === "loading" ? "正在连接工作台…" : "没拿到面板地址，按默认端口试： " + url)),
          h("span", { style: { flex: 1 } }),
          h("button", { type: "button", style: btn, onClick: () => setNonce(nonce + 1) }, "刷新"),
          h("button", { type: "button", style: btn, onClick: () => url && window.open(url, "_blank", "noopener") }, "在新窗口打开")
        ),
        state === "loading"
          ? h("div", { style: { ...muted, padding: "24px 0" } }, "面板启动中，稍等…")
          : h("iframe", {
            key: url + ":" + nonce,
            src: url,
            title: "Everything down",
            allow: "clipboard-read; clipboard-write; fullscreen",
            style: {
              width: "100%",
              height: "calc(100vh - 216px)",
              minHeight: "520px",
              border: "1px solid var(--dsw-alias-border-l2, #e6eaf2)",
              borderRadius: "10px",
              background: "#fff"
            }
          }),
        state === "fallback"
          ? h("div", { style: { ...muted, lineHeight: "1.6" } }, "没读到面板地址：可能是端口被占用后面板换了端口，或者面板还没起来。可以点右上角刷新重试；仍然空白就重启一次客户端。")
          : null
      )
    }

    /** 依赖的浏览器服务：槽位与多语言 */
    const inject = ["slots", "locale"]

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "everything-down: locale")
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "everything-down",
        order: 26,
        label: () => "Everything down",
        locale: NS
      }, WorkbenchSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
