import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, "..");
const distDir = path.join(kitRoot, "dist");
const portableDir = path.join(distDir, "Overleaf-MCP-Portable");
const payloadStageDir = path.join(distDir, "_payload_stage");

function findCsc() {
    const candidates = [
        "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
        "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    throw new Error("Could not find .NET csc.exe");
}

function findCloudflared() {
    const candidates = [
        path.join(kitRoot, "bin", "cloudflared.exe"),
        "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
        "C:\\Program Files\\cloudflared\\cloudflared.exe",
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return null;
}

async function copyFilteredNodeModules(srcDir, dstDir) {
    await fs.mkdir(dstDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of entries) {
        const name = entry.name;
        const srcPath = path.join(srcDir, name);
        const dstPath = path.join(dstDir, name);

        if (entry.isDirectory()) {
            // Skip @netique (already copied & extended into server/) and .bin
            if (name === "@netique" || name === ".bin") continue;
            await copyFilteredNodeModules(srcPath, dstPath);
        } else if (entry.isFile()) {
            const lower = name.toLowerCase();
            if (lower.endsWith(".map") || lower.endsWith(".d.ts") || lower.endsWith(".tsbuildinfo")) continue;
            await fs.copyFile(srcPath, dstPath);
        }
    }
}

async function copyRuntimeFiles(targetDir, { includeConfigAndDocs }) {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.cp(path.join(kitRoot, "node"), path.join(targetDir, "node"), { recursive: true });
    await fs.cp(path.join(kitRoot, "server"), path.join(targetDir, "server"), { recursive: true });
    await fs.cp(path.join(kitRoot, "gateway"), path.join(targetDir, "gateway"), { recursive: true });
    await copyFilteredNodeModules(path.join(kitRoot, "node_modules"), path.join(targetDir, "node_modules"));
    await fs.copyFile(path.join(kitRoot, "launcher.mjs"), path.join(targetDir, "launcher.mjs"));
    await fs.copyFile(path.join(kitRoot, "package.json"), path.join(targetDir, "package.json"));

    const cfPath = findCloudflared();
    if (cfPath) {
        await fs.mkdir(path.join(targetDir, "bin"), { recursive: true });
        await fs.copyFile(cfPath, path.join(targetDir, "bin", "cloudflared.exe"));
        console.log(`[build] bundled cloudflared.exe from ${cfPath}`);
    } else {
        console.warn("[build] WARN: cloudflared.exe not found; Quick Tunnel will require system cloudflared.");
    }

    if (includeConfigAndDocs) {
        const defaultConfig = {
            PORT: 0,
            HOSTNAME: "",
            TUNNEL_MODE: "auto",
            AUTH_MODE: "auto",
            APIKEY: "",
            PROMPT_ON_START: true,
            AUTO_LOGIN_ON_START: true,
            COOKIE_TTL_DAYS: 30,
            COOKIE_KEEPALIVE_MIN: 180,
        };
        await fs.writeFile(path.join(targetDir, "config.json"), JSON.stringify(defaultConfig, null, 2) + "\n", "utf8");
        await fs.writeFile(path.join(targetDir, "使用说明.txt"), buildReadme(), "utf8");
    }
}

function buildReadme() {
    return [
        "==========================================",
        "  Overleaf MCP Gateway (终端交互版)",
        "==========================================",
        "",
        "【快速开始（无需域名 & 支持固定域名/IP）】",
        "1. 双击运行 Overleaf-MCP.exe（或 Overleaf-MCP-SingleFile.exe）",
        "2. 启动后终端会询问本次连接方式：",
        "   [1] 临时公网地址：自动启动 Quick Tunnel，直接生成临时 https://*.trycloudflare.com/mcp 与 API Key。",
        "   [2] 固定域名 / IP：监听指定本地端口，终端直接展示 http://127.0.0.1:<端口>（及本机局域网 IP），",
        "       你到 Cloudflare Zero Trust -> Public Hostname 将 Service 指向该地址即可。",
        "   [3] 仅本机使用：只监听 127.0.0.1。",
        "3. 连接方式选定后会自动检测 Overleaf 登录状态；如未登录或已失效，直接弹出隔离版 Chrome 登录窗口。",
        "4. 在网页版 AI 填入控制台展示的 MCP URL 与 API Key，终端保持开启即可实时查看 HTTP 请求与 MCP 工具调用日志。",
        "",
        "【本地 Agent 接入方式（Antigravity / Cursor / Claude Code / VS Code）】",
        "- 方式 A（推荐：复用常驻终端，所有调用实时打印 emoji 日志）：",
        "  先双击运行 EXE 保持终端开启，在本地 Agent 的 MCP 配置里填入 HTTP URL：",
        "    \"url\": \"http://127.0.0.1:<控制台显示的端口>/mcp\"",
        "    （若开启了 API Key，再加请求头 Authorization: Bearer <API Key> 或 x-api-key）",
        "- 方式 B（免手开终端，本地 Agent 自动拉起 stdio）：",
        "  在本地 Agent 的 MCP 配置中填写 command 为本 EXE 路径，args 为 [\"--stdio\"]，",
        "  例如：{\"command\": \"C:\\\\路径\\\\Overleaf-MCP-SingleFile.exe\", \"args\": [\"--stdio\"]}",
        "",
        "【常用配置（config.json）】",
        "- PROMPT_ON_START    : true（默认）启动时终端交互选择连接方式；false 则直接按配置文件自动启动",
        "- PORT               : 0 表示自动选择空闲端口；固定域名模式建议设为如 8080",
        "- HOSTNAME           : 固定域名（如 overleaf.example.com）；留空亦可只展示本机监听端口",
        "- TUNNEL_MODE        : auto（默认）| quick | custom | local",
        "- APIKEY             : Quick Tunnel 模式下留空会自动生成并保存到 auto-apikey.txt",
        "- AUTO_LOGIN_ON_START: true（默认）启动时自动检测登录状态",
        "- COOKIE_TTL_DAYS    : 本地 Cookie 最大保留天数（默认 30，设为 0 表示不限制本地时长）",
        "- COOKIE_KEEPALIVE_MIN: 后台定时保活与 Set-Cookie 刷新周期（分钟，默认 180，设为 0 关闭）",
        "- OL_BASE_URL        : 可选，自建 Overleaf CE 地址（默认 https://www.overleaf.com）",
        "",
        "【数据目录说明】",
        "- 若使用单文件版 Overleaf-MCP.exe，配置与下载文件保存在：",
        "  %LOCALAPPDATA%\\Overleaf-MCP\\",
        "  （如果把自己的 config.json 放在 EXE 同级目录，则会优先读取同级目录）",
        "",
    ].join("\r\n");
}

function zipDir(srcDir, outZip) {
    if (existsSync(outZip)) {
        execFileSync("powershell.exe", ["-NoProfile", "-Command", "Remove-Item -Force $env:ZIP_OUT"], {
            env: { ...process.env, ZIP_OUT: outZip },
        });
    }
    const ps = "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:ZIP_SRC, $env:ZIP_OUT, [System.IO.Compression.CompressionLevel]::Optimal, $false)";
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], {
        stdio: "inherit",
        env: { ...process.env, ZIP_SRC: srcDir, ZIP_OUT: outZip },
    });
}

async function main() {
    const csc = findCsc();
    await fs.rm(distDir, { recursive: true, force: true });
    await fs.mkdir(distDir, { recursive: true });

    console.log("[build] 1/4 Staging portable folder...");
    await copyRuntimeFiles(portableDir, { includeConfigAndDocs: true });

    console.log("[build] 2/4 Compiling portable Overleaf-MCP.exe...");
    execFileSync(
        csc,
        [
            "/nologo",
            "/optimize+",
            "/platform:x64",
            "/target:exe",
            `/out:${path.join(portableDir, "Overleaf-MCP.exe")}`,
            path.join(here, "JobRunner.cs"),
            path.join(here, "OverleafMcpLauncher.cs"),
        ],
        { stdio: "inherit" }
    );

    console.log("[build] 3/4 Creating Overleaf-MCP-Portable.zip...");
    const portableZip = path.join(distDir, "Overleaf-MCP-Portable.zip");
    zipDir(portableDir, portableZip);

    console.log("[build] 4/4 Building single-file Overleaf-MCP-SingleFile.exe...");
    await copyRuntimeFiles(payloadStageDir, { includeConfigAndDocs: false });
    const payloadZip = path.join(distDir, "payload.zip");
    zipDir(payloadStageDir, payloadZip);

    const payloadBytes = await fs.readFile(payloadZip);
    const bundleVersion = createHash("sha256").update(payloadBytes).digest("hex").slice(0, 16);

    const singleTemplate = await fs.readFile(path.join(here, "OverleafMcpSingleFile.cs"), "utf8");
    const renderedCs = path.join(distDir, "_SingleFileRendered.cs");
    await fs.writeFile(renderedCs, singleTemplate.replace("__BUNDLE_VERSION__", bundleVersion), "utf8");

    const singleExe = path.join(distDir, "Overleaf-MCP-SingleFile.exe");
    execFileSync(
        csc,
        [
            "/nologo",
            "/optimize+",
            "/platform:x64",
            "/target:exe",
            "/r:System.IO.Compression.dll",
            "/r:System.IO.Compression.FileSystem.dll",
            `/resource:${payloadZip},payload.zip`,
            `/out:${singleExe}`,
            path.join(here, "JobRunner.cs"),
            renderedCs,
        ],
        { stdio: "inherit" }
    );

    await fs.rm(payloadStageDir, { recursive: true, force: true });
    await fs.rm(payloadZip, { force: true });
    await fs.rm(renderedCs, { force: true });

    const singleStat = await fs.stat(singleExe);
    const zipStat = await fs.stat(portableZip);
    console.log("");
    console.log("[build] DONE!");
    console.log(`  Portable Folder : ${portableDir}`);
    console.log(`  Portable ZIP    : ${portableZip} (${(zipStat.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  Single-File EXE : ${singleExe} (${(singleStat.size / 1024 / 1024).toFixed(2)} MB)`);
}

await main();
