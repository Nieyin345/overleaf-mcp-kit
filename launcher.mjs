// Overleaf MCP Launcher
// Supports three modes via config.json:
//   1. Custom domain (HOSTNAME set) -> uses your fixed Cloudflare Tunnel domain
//   2. Quick Tunnel (HOSTNAME empty / TUNNEL_MODE="quick") -> zero-domain instant HTTPS URL
//   3. Local only (TUNNEL_MODE="local") -> http://127.0.0.1:<port>/mcp
import crypto from "node:crypto";
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayServer } from "./gateway/GatewayServer.js";
import { StartupConfigPrompt } from "./gateway/StartupPrompt.js";
import { TunnelManager } from "./gateway/TunnelManager.js";

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.OL_CONFIG_PATH ? resolve(process.env.OL_CONFIG_PATH) : join(here, "config.json");
const dataDir = process.env.OL_DATA_DIR ? resolve(process.env.OL_DATA_DIR) : here;

const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", d: "\x1b[90m", x: "\x1b[0m" };
const say = (m, col = "") => console.log(col ? col + m + C.x : m);

say("");
say("=========================================", C.c);
say("   🚀 Overleaf MCP Gateway (终端版)", C.c);
say("=========================================", C.c);
say("");

let cfg = {};
if (existsSync(cfgPath)) {
  try {
    cfg = JSON.parse(readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    say("[ERROR] Cannot parse config.json: " + e.message, C.r);
    process.exit(1);
  }
} else {
  say("[INFO] config.json not found, using zero-domain Quick Tunnel defaults.", C.y);
}

const startupSelection = await new StartupConfigPrompt(cfg).resolveInteractiveOrDefault();
const tunnelMode = startupSelection.tunnelMode;
const customHost = startupSelection.hostname;
const configuredPort = startupSelection.port;
const authMode = String(cfg.AUTH_MODE || "auto").trim().toLowerCase();
let apiKey = String(cfg.APIKEY || "").trim();
const olBaseUrl = String(cfg.OL_BASE_URL || "").trim();
const olInsecure = cfg.OL_INSECURE === true || cfg.OL_INSECURE === "1" || cfg.OL_INSECURE === 1;
const olBrowser = String(cfg.OL_BROWSER || "").trim();
const artifactTtlMin = Number(cfg.ARTIFACT_TTL_MIN) || 60;
const cookieTtlDays = cfg.COOKIE_TTL_DAYS === 0 || cfg.COOKIE_TTL_DAYS === "0"
  ? 0
  : (Number(cfg.COOKIE_TTL_DAYS) > 0 ? Number(cfg.COOKIE_TTL_DAYS) : 30);
const cookieKeepAliveMin = cfg.COOKIE_KEEPALIVE_MIN === 0 || cfg.COOKIE_KEEPALIVE_MIN === "0"
  ? 0
  : (Number(cfg.COOKIE_KEEPALIVE_MIN) > 0 ? Number(cfg.COOKIE_KEEPALIVE_MIN) : 180);
const autoLoginOnStart = cfg.AUTO_LOGIN_ON_START !== false && process.env.OL_SKIP_LOGIN_CHECK !== "1";

// In Quick Tunnel mode with empty APIKEY, auto-generate & persist a strong key so
// shared links are never exposed unauthenticated unless AUTH_MODE === "none".
if (tunnelMode === "quick" && !apiKey && authMode !== "none") {
  const keyFile = join(dataDir, "auto-apikey.txt");
  if (existsSync(keyFile)) {
    apiKey = readFileSync(keyFile, "utf8").trim();
  }
  if (!apiKey) {
    apiKey = "ol_" + crypto.randomBytes(12).toString("hex");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(keyFile, apiKey, "utf8");
    say(`[OK] Generated API Key for Quick Tunnel (saved in ${keyFile})`, C.g);
  }
}

async function allocatePort(requestedPort, host = "0.0.0.0") {
  if (requestedPort !== 0) {
    let portBusy = null;
    try {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr ":${requestedPort} "`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        shell: "cmd.exe",
      });
      const m = out.match(/\s(\d+)\s*$/m);
      if (m) portBusy = m[1];
    } catch {
      // free
    }
    const bindFree = await new Promise((resolvePort) => {
      const srv = net.createServer();
      srv.once("error", () => resolvePort(false));
      srv.once("listening", () => srv.close(() => resolvePort(true)));
      srv.listen(requestedPort, host);
    });
    if (portBusy !== null || !bindFree) {
      say("");
      say(`[ERROR] Port ${requestedPort} is already in use` + (portBusy ? ` by PID ${portBusy}` : "") + ".", C.r);
      say("        Close the previous launcher window first, or set PORT=0 in config.json.", C.y);
      if (portBusy) say(`          taskkill /PID ${portBusy} /F`, C.y);
      process.exit(1);
    }
    return requestedPort;
  }

  return await new Promise((resolvePort, rejectPort) => {
    const srv = net.createServer();
    srv.once("error", rejectPort);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 18081;
      srv.close(() => resolvePort(p));
    });
  });
}

const listenHost = tunnelMode === "custom" ? "0.0.0.0" : "127.0.0.1";
const port = await allocatePort(configuredPort, listenHost);
const internalPort = await allocatePort(0, "127.0.0.1");

say(`[OK] Mode       : ${tunnelMode}`, C.g);
say(`[OK] Local Port : ${port} (${listenHost})`, C.g);
if (olBaseUrl) {
  say(`[OK] Overleaf   : ${olBaseUrl}`, C.g);
}

// --- paths (relative forward-slash paths for Windows non-ASCII cwd safety) ---
const proxy = "node_modules/mcp-proxy/dist/bin/mcp-proxy.mjs";
const entry = "server/index.js";

for (const p of [proxy, entry]) {
  if (!existsSync(join(here, p))) {
    say("");
    say("[ERROR] Missing file: " + join(here, p), C.r);
    process.exit(1);
  }
}

if (!process.env.APPDATA) {
  process.env.APPDATA = join(process.env.USERPROFILE || "", "AppData", "Roaming");
}

const bundledNode = join(here, "node", "node.exe");
const cmdExe = existsSync(bundledNode) ? bundledNode : process.execPath;
const baseAuthEnv = {
  ...process.env,
  APPDATA: process.env.APPDATA || join(process.env.USERPROFILE || "", "AppData", "Roaming"),
  OL_COOKIE_TTL_DAYS: String(cookieTtlDays),
  OL_COOKIE_KEEPALIVE_MIN: String(cookieKeepAliveMin),
};
if (olBaseUrl) baseAuthEnv.OL_BASE_URL = olBaseUrl;
if (olInsecure) baseAuthEnv.OL_INSECURE = "1";
if (olBrowser) baseAuthEnv.OL_BROWSER = olBrowser;

if (autoLoginOnStart) {
  say("[AUTH] Checking Overleaf login status...", C.c);
  const statusRes = spawnSync(cmdExe, [entry, "status"], {
    cwd: here,
    env: baseAuthEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${statusRes.stdout ?? ""}\n${statusRes.stderr ?? ""}`.trim();
  if (statusRes.status === 0) {
    const idLine = out.split(/\r?\n/).find((l) => l.startsWith("identity:"));
    say(`[OK] Overleaf logged in (${idLine ? idLine.replace("identity:", "").trim() : "valid session"})`, C.g);
  } else {
    const needsBrowser = /no cookie for|Session cookie rejected|HTTP 401|HTTP 403|ol-user_id|ol-csrfToken|cookie/i.test(out);
    if (needsBrowser) {
      say("[AUTH] 未检测到有效的 Overleaf 登录状态，正在打开浏览器窗口登录...", C.y);
      say("       请在弹出的独立 Chrome 窗口中完成登录，登录成功后窗口会自动关闭。", C.y);
      const loginRes = spawnSync(cmdExe, [entry, "login"], {
        cwd: here,
        env: baseAuthEnv,
        stdio: "inherit",
      });
      if (loginRes.status !== 0) {
        say("[ERROR] Overleaf 登录未完成或失败，服务未启动。", C.r);
        process.exit(loginRes.status ?? 1);
      }
      say("[OK] Overleaf 登录完成，继续启动网关...", C.g);
    } else {
      say(`[WARN] 无法连接 Overleaf 验证登录 (${out.split(/\r?\n/)[0] || "network error"})，跳过预检继续启动。`, C.y);
    }
  }
}

const artifactDir = process.env.OL_ARTIFACT_DIR ? resolve(process.env.OL_ARTIFACT_DIR) : join(dataDir, "artifacts");
const downloadDir = process.env.OL_DOWNLOAD_DIR ? resolve(process.env.OL_DOWNLOAD_DIR) : join(dataDir, "downloads");
mkdirSync(artifactDir, { recursive: true });
mkdirSync(downloadDir, { recursive: true });

const gateway = new GatewayServer({
  port,
  host: listenHost,
  upstreamHost: "127.0.0.1",
  upstreamPort: internalPort,
  artifactDir,
});
await gateway.start();
say(`[OK] Front-door gateway listening on ${listenHost}:${port}`, C.g);

const tunnelManager = new TunnelManager(here);
const lanIps = StartupConfigPrompt.getLanIpv4Addresses(os);
let publicUrl;

if (tunnelMode === "custom") {
  publicUrl = customHost ? `https://${customHost}` : `http://127.0.0.1:${port}`;
  const svc = tunnelManager.checkCustomServiceRunning();
  if (customHost && svc === "running") {
    say(`[OK] Cloudflared service is running (${publicUrl})`, C.g);
  } else {
    say(`[INFO] 固定域名 / IP 模式已启动本机监听: http://127.0.0.1:${port}`, C.c);
    if (lanIps.length > 0) {
      say(`       局域网 / 本机 IP 地址: ${lanIps.map((ip) => `http://${ip}:${port}`).join(", ")}`, C.c);
    }
    say(`       请到 Cloudflare Zero Trust -> Tunnels -> Public Hostname 将 Service 设为 HTTP: 127.0.0.1:${port}`, C.y);
  }
  if (!apiKey) {
    say("[INFO] 未设置 APIKEY（如需接入认证，可在 config.json 中配置 APIKEY）。", C.d);
  }
} else if (tunnelMode === "quick") {
  try {
    publicUrl = await tunnelManager.startQuickTunnel(port);
  } catch (err) {
    say(`[ERROR] Failed to start Quick Tunnel: ${err.message}`, C.r);
    await gateway.stop();
    process.exit(1);
  }
} else {
  publicUrl = `http://127.0.0.1:${port}`;
}

writeFileSync(join(artifactDir, ".public-url"), publicUrl, "utf8");

const args = [
  proxy,
  "--host",
  "127.0.0.1",
  "--port",
  String(internalPort),
  "--sessionIdleTimeout",
  "0",
  "--maxBodySize",
  "52428800",
];
if (apiKey) args.push("--apiKey", apiKey);

const upstreamNode = existsSync(bundledNode) ? "./node/node.exe" : process.execPath;
args.push("--", upstreamNode, entry);

const childEnv = {
  ...baseAuthEnv,
  OL_PUBLIC_URL: publicUrl,
  OL_ARTIFACT_DIR: artifactDir,
  OL_DOWNLOAD_DIR: downloadDir,
  OL_ARTIFACT_TTL_MIN: String(artifactTtlMin),
};

say(`[cmd] ${cmdExe} ${args.join(" ")}`, C.d);

const child = spawn(cmdExe, args, {
  stdio: "inherit",
  cwd: here,
  env: childEnv,
});

say("");
say("=================================================================", C.c);
say("  🌐 网页版 AI 连接配置 (ChatGPT / Claude.ai / 网页客户端)", C.c);
say("=================================================================", C.c);
if (tunnelMode === "custom" && !customHost) {
  say(`  Cloudflare Service : HTTP -> http://127.0.0.1:${port}`, C.y);
  if (lanIps.length > 0) {
    say(`  局域网回源地址      : ${lanIps.map((ip) => `http://${ip}:${port}`).join(", ")}`, C.y);
  }
  say("  网页 AI 填写格式    : https://<你在Cloudflare绑定的域名>/mcp", C.y);
} else if (tunnelMode === "local") {
  say("  当前为仅本机模式，未对外生成公网地址。", C.d);
} else {
  say(`  MCP URL  : ${publicUrl}/mcp`, C.y);
  if (tunnelMode === "custom") {
    say(`  回源地址 : http://127.0.0.1:${port} (Cloudflare Service 指向此地址)`, C.c);
  }
}
say(`  Auth Key : ${apiKey ? apiKey + "  (支持 Bearer / x-api-key)" : "未开启 (可直接连接)"}`, C.y);

say("");
say("=================================================================", C.c);
say("  💻 本地 Agent 连接方式 (Antigravity / Cursor / Claude Code / VS Code)", C.c);
say("=================================================================", C.c);
say(`  Streamable HTTP : http://127.0.0.1:${port}/mcp`, C.g);
say(`  SSE 兼容地址    : http://127.0.0.1:${port}/sse`, C.g);
if (apiKey) {
  say(`  请求头 Headers  : { "Authorization": "Bearer ${apiKey}" }`, C.y);
} else {
  say("  请求头 Headers  : 无需鉴权 (直接填 serverUrl/url 即可)", C.d);
}
say("  💡 提示：本地 Agent 连上面的 http://127.0.0.1:" + port + "/mcp 时，所有调用日志都会实时显示在本窗口；", C.d);
say("           也支持在本地 Agent 配置 stdio 命令直接拉起：--stdio（无需先手开窗口）。", C.d);

say("");
say("=================================================================", C.c);
say(`  🔐 Cookie    : 本地保留 ${cookieTtlDays === 0 ? "不限时长" : cookieTtlDays + " 天"} (每 ${cookieKeepAliveMin} 分钟保活刷新)`, C.d);
say(`  💾 Downloads : ${downloadDir}`, C.d);
say(`  ⚙️  Config    : ${cfgPath}`, C.d);
say("  📋 日志图例  : 🔐认证  📂浏览  🔍检索  ✏️编辑  📦文件  🧪编译  ⬇️下载  💬批注", C.d);
say("=================================================================", C.c);
say("  终端保持开启中 (Ctrl+C 停止服务) — 等待调用...", C.c);
say("");

let stopping = false;
async function stopTree(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  tunnelManager.stop();
  try {
    await gateway.stop();
  } catch {
    // ignore
  }
  if (child && !child.killed && child.pid) {
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
      } else {
        child.kill(signal);
      }
    } catch {
      // already gone
    }
  }
  process.exit(0);
}

child.on("exit", (code) => {
  say("");
  say(`[Gateway upstream exited with code ${code}]`, C.y);
  tunnelManager.stop();
  void gateway.stop().finally(() => process.exit(code ?? 0));
});

process.on("SIGINT", () => void stopTree("SIGINT"));
process.on("SIGTERM", () => void stopTree("SIGTERM"));
process.on("SIGHUP", () => void stopTree("SIGHUP"));
process.on("exit", () => {
  tunnelManager.stop();
  if (!stopping && child?.pid) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // nothing to clean up
    }
  }
});
