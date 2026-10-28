# dsh-webannotate — 交接说明

在 DSH 内置浏览器里给网页做批注：点元素 → 写意见 → 「发送全部」→ 结构化批注直接作为一条消息进当前对话。
装插件即用，不改被标注项目的任何代码。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半（跑在 DSH host 子进程，pid 不是 Electron 主进程）。`GET /dsh-webannotate/overlay.js` 现读 `web/overlay.js` 返回；`POST /dsh-webannotate/report` 收前端诊断（环形 80 条）；`GET /dsh-webannotate/status` 同内容只读 JSON；`POST /dsh-webannotate/batch` 存最近 20 个批次；工具 `webannotate_status`。 |
| `client.js` | Client 半（跑在 GUI 页面里 = 内置浏览器 `<webview>` 所在页面）。扫描 `document.querySelectorAll('webview')`，`dom-ready` 时 `webview.executeJavaScript(overlay)`，每 700ms 轮询 `window.__dshWebAnnotate.outbox()`；收到 `submit` 批注 → 生成中文消息 → `ctx.sessions.using(sessionId, {source:'controllerOperation'}, ref => ref.session.prompt([{type:'text',text}], 'queue'))`。`sessionId` 由注册进 `conversation.input.dock` 的空组件从 props 拿到。 |
| `web/overlay.js` | 注入到被标注页面的批注层（纯 IIFE，无依赖，Shadow DOM 隔离）。右下角「批注」pill、点选元素、评论卡 + 分类（文案/样式/布局/交互/其他）、编号 pin、本页批注列表（定位/删除/清空）、「发送全部 (n)」；`sessionStorage` 按 origin+path 持久化。 |

## 关键事实（踩过的坑）

- DSH 桌面是三进程：Electron 主进程（GUI/webview 宿主）→ `dsh-desktop-host` 子进程（Cordis host、webServer、插件 host 半都在这里，`process.type === null`，`import('electron')` 拿不到 `app`/`webContents`）→ 工具子进程。**host 插件够不到 webview，只有 client 插件够得到**，所以注入必须在 client 半。
- host 服务的 `webServer.register({kind:'exact', path, handler(req,res)})` 路由不需要 GUI 的登录态，可直接用 `Invoke-WebRequest http://127.0.0.1:14872/...` 调。
- 插件内 `webServer.register` 没有"反注册"以外的手段；本插件每次激活先 dispose 上一批路由再注册，避免重载后 404。
- `plugin_manager` 的 target 必须写 `include:dsh-webannotate`（写包名会报 `unknown-plugin`）；改 host 代码后 `set_plugin` 先 false 再 true 即热重载。
- **client 半的发现发生在 host 启动时**（boot payload 的 `__DSH_BOOT__.entries` 由 host 组装并缓存在 `clientModules.composed`），所以插件首次带 client 半时必须重启 DSH 一次；之后改 `client.js` / `web/overlay.js` 只需刷新页面（overlay 甚至不用刷新，host 每次现读文件）。
- 页面加载后可用 `GET /dsh-webannotate/status` 看前端上报；改 `client.js` 后若 status 里没有新的 `boot` 上报，先刷新窗口。

## 验证清单

1. 重启 DSH → 打开内置浏览器 → 访问本地 dev 站点。
2. 页面右下角出现「批注」pill；点它进入标注模式，点元素 → 写意见 → 保存。
3. 打开列表 → 「发送全部」→ 对话里出现「【网页批注】…」消息。
4. 不生效时：`webannotate_status`（或 GET `/dsh-webannotate/status`）看 `reports` 里 `inject` / `submit` 的 error。

## 已知限制

- 跨域 iframe 里的元素无法标注；只能标顶层文档。
- 内置浏览器关闭或切走后 DOM 里的 `webview` 不存在，批注层随之暂停。
- SPA 内部路由切换后，旧的编号 pin 可能定位不到元素（列表会提示）。
