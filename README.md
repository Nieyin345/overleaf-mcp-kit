# Overleaf MCP Kit

增强版 Overleaf MCP Server 与公网/本机双模网关套件（基于 `@netique/overleaf-mcp` 扩展）。  
通过模拟 Overleaf 官方网页编辑器的 **Socket.IO OT + HTTP API**，让 **网页端 AI（ChatGPT Connectors / Claude 等）** 与 **本地 AI Agent（Antigravity / Cursor / Claude Code / VS Code / Claude Desktop）** 都能实时读写 Overleaf 项目、保留 Track Changes 修订记录、上传下载文件、发起云端编译并返回 PDF 图像/网页预览。

## ✨ 核心特性（共 31 个 MCP 工具）

| 分类 | 工具列表 | 说明 |
| --- | --- | --- |
| 🔐 认证 | `ping`, `auth_status` | 实时检测 Cookie 与登录账号状态，不触发浏览器弹窗 |
| 📂 浏览 | `list_projects`, `open_project`, `list_files`, `read_file` | 项目树浏览与源码读取（支持 `start_line` / `end_line` 行号切片） |
| 🔍 检索 | `search_in_project` | 跨文档关键词 / 正则全文检索，返回路径、行列号与上下文 |
| ✏️ 编辑 | `edit_file`, `find_and_replace`, `multi_replace`, `list_tracked_changes`, `accept_changes`, `reject_changes` | 单次/批量原子 OT 编辑，完整兼容 Overleaf 右侧 Review 面板 **Track Changes** |
| 📦 文件 | `create_doc`, `create_folder`, `upload_file`, `delete_entity`, `rename_entity`, `move_entity` | 新建、Base64 multipart 上传图片/附件、安全删除、重命名与移动 |
| 🧪 编译 | `compile`, `read_log`, `preview_pdf` | 云端编译并返回错误摘要；支持 `pdftoppm` / PyMuPDF 渲染页面 PNG + Token 化在线 PDF 预览页 |
| ⬇️ 下载 | `download_file`, `download_project`, `download_output` | 下载单文件、整项目 `.zip` 或 `output.pdf`/`.bbl` 等编译产物并生成临时签名下载链接 |
| 💬 批注 | `list_comments`, `read_comment_thread`, `add_comment`, `reply_comment`, `resolve_comment`, `reopen_comment` | 根据原文 `quote` 锚定新建批注、回复、关闭与重开 Review 讨论 |

### 工程化与易用性增强
- **无需域名也能公网用**：内置免费 **Cloudflare Quick Tunnel**（启动即得 `https://*.trycloudflare.com/mcp` 与自动生成的 `API Key`），同时也支持 **固定域名 / 固定 IP**（终端直接展示回源地址 `http://127.0.0.1:<端口>` 供 Cloudflare Zero Trust 配置）与 **仅本机模式**。
- **开机自动登录检测**：启动时自动校验 Overleaf 登录状态；无 Cookie 或会话失效时自动弹出独立隔离 Chrome 完成登录（支持验证码 / SSO / 2FA）。
- **Cookie 延长保留与保活**：支持 `COOKIE_TTL_DAYS`（默认 30 天，`0` 不限制本地时长）、响应 `Set-Cookie` 滚动刷新自动落盘及后台定时保活 `COOKIE_KEEPALIVE_MIN`（默认 180 分钟）。
- **分类 Emoji 常驻终端日志**：按 `🔐认证 / 📂浏览 / 🔍检索 / ✏️编辑 / 📦文件 / 🧪编译 / ⬇️下载 / 💬批注` 彩色分区展示每次 HTTP 请求、工具入参、耗时与输出摘要。
- **网页端 AI + 本地 Agent 全兼容**：运行中的终端同时提供 Streamable HTTP (`/mcp`) 与 SSE (`/sse`)，并兼容 `Authorization: Bearer` 与 `x-api-key`；可执行文件还支持 `--stdio` 参数供本地 Agent 直接拉起。
- **Windows 单文件免环境 EXE**：提供开箱即用的 `Overleaf-MCP-SingleFile.exe` 与 `Overleaf-MCP-Portable.zip`。

---

## 🚀 快速使用（Windows 可执行版）

前往 [Releases](https://github.com/Nieyin345/overleaf-mcp-kit/releases) 下载：
- **`Overleaf-MCP-SingleFile.exe`**：单文件版，双击即可运行，首次会自动解压运行环境。
- **`Overleaf-MCP-Portable.zip`**：便携文件夹版，解压后双击 `Overleaf-MCP.exe`（启动更快）。

### 1. 启动选择连接模式
运行后控制台会提示选择连接方式：
1. **`[1] 临时公网地址`**：自动生成 `https://xxxx.trycloudflare.com/mcp` 和随机 `API Key`，无需域名。
2. **`[2] 固定域名 / IP`**：终端展示本机监听地址（如 `http://127.0.0.1:8080` 及局域网 IP），随后到 Cloudflare Zero Trust → Tunnels → Public Hostname 将 Service 指向该地址即可。
3. **`[3] 仅本机使用`**：只监听 `127.0.0.1`。

### 2. 接入本地 Agent（Cursor / Claude Code / Antigravity / VS Code / Claude Desktop）
- **方式 A（推荐，与网页 AI 共用常驻终端看实时日志）**：先运行 EXE，在本地 Agent 配置中填入 HTTP URL：
  ```json
  {
    "mcpServers": {
      "overleaf": {
        "url": "http://127.0.0.1:8080/mcp",
        "headers": {
          "Authorization": "Bearer <终端显示的 API Key，未开启鉴权可省略>"
        }
      }
    }
  }
  ```
- **方式 B（`--stdio` 本地 Agent 自动拉起）**：
  ```json
  {
    "mcpServers": {
      "overleaf": {
        "command": "D:\\path\\to\\Overleaf-MCP-SingleFile.exe",
        "args": ["--stdio"]
      }
    }
  }
  ```

---

## ⚙️ 配置文件 `config.json`

复制 `config.example.json` 为 `config.json` 即可自定义参数（单文件版可将 `config.json` 放在 EXE 同级目录，或位于 `%LOCALAPPDATA%\Overleaf-MCP\config.json`）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `0` | `0` 为自动分配空闲端口；固定域名或本地长期连接建议设为 `8080` |
| `HOSTNAME` | `""` | 你的固定域名（如 `overleaf.example.com`）；留空亦可配合模式 `[2]` 仅显示本地回源地址 |
| `TUNNEL_MODE` | `"auto"` | `"auto"` / `"quick"` / `"custom"` / `"local"` |
| `AUTH_MODE` | `"auto"` | `"auto"`（Quick Tunnel 自动生成 Key） / `"none"` |
| `APIKEY` | `""` | 自定义访问密钥（支持 `Bearer` 或 `x-api-key`） |
| `PROMPT_ON_START` | `true` | 启动时是否在终端交互选择连接方式 |
| `AUTO_LOGIN_ON_START` | `true` | 启动时是否自动校验 Overleaf 登录态并在未登录时弹出 Chrome |
| `COOKIE_TTL_DAYS` | `30` | 本地 Cookie 最大保留天数（`0` 为不限本地时长） |
| `COOKIE_KEEPALIVE_MIN` | `180` | 后台保活与 `Set-Cookie` 刷新周期（分钟，`0` 关闭） |
| `OL_BASE_URL` | `"https://www.overleaf.com"` | 可选，自建 Overleaf Community Edition 地址 |

---

## 🛠️ 从源码开发与打包

需要 Node.js >= 20：

```bash
npm install
npm test
npm start
```

若要使用 `packaging/build-release.mjs` 编译 Windows EXE，请先在项目根目录下放置便携版 Node 到 `node/node.exe`（以及可选的 `bin/cloudflared.exe`），系统需安装 `.NET Framework 4.0`（`csc.exe`）：

```bash
npm run build:exe
```

## 📄 开源协议

基于上游项目 [`@netique/overleaf-mcp`](https://www.npmjs.com/package/@netique/overleaf-mcp) 扩展，遵循 **GNU AGPL-3.0-or-later** 协议。详情见 [LICENSE](./LICENSE)。
