// Categorized, colorized & emoji-formatted MCP tool terminal logger.
// Writes exclusively to stderr so stdout remains pure MCP JSON-RPC.

const USE_COLOR = !process.env.NO_COLOR;
const ANSI = {
    reset: USE_COLOR ? "\x1b[0m" : "",
    bold: USE_COLOR ? "\x1b[1m" : "",
    dim: USE_COLOR ? "\x1b[90m" : "",
    red: USE_COLOR ? "\x1b[31m" : "",
    green: USE_COLOR ? "\x1b[32m" : "",
    yellow: USE_COLOR ? "\x1b[33m" : "",
    blue: USE_COLOR ? "\x1b[34m" : "",
    magenta: USE_COLOR ? "\x1b[35m" : "",
    cyan: USE_COLOR ? "\x1b[36m" : "",
    brightBlue: USE_COLOR ? "\x1b[94m" : "",
    brightMagenta: USE_COLOR ? "\x1b[95m" : "",
    brightCyan: USE_COLOR ? "\x1b[96m" : "",
};

const CATEGORIES = {
    auth: { icon: "🔐", label: "认证", color: ANSI.cyan },
    browse: { icon: "📂", label: "浏览", color: ANSI.brightBlue },
    search: { icon: "🔍", label: "检索", color: ANSI.magenta },
    edit: { icon: "✏️ ", label: "编辑", color: ANSI.yellow },
    files: { icon: "📦", label: "文件", color: ANSI.green },
    compile: { icon: "🧪", label: "编译", color: ANSI.brightCyan },
    download: { icon: "⬇️ ", label: "下载", color: ANSI.blue },
    comment: { icon: "💬", label: "批注", color: ANSI.brightMagenta },
    other: { icon: "🔧", label: "工具", color: ANSI.cyan },
};

const TOOL_CATEGORY_MAP = {
    ping: "auth",
    auth_status: "auth",
    list_projects: "browse",
    open_project: "browse",
    list_files: "browse",
    read_file: "browse",
    search_in_project: "search",
    edit_file: "edit",
    find_and_replace: "edit",
    multi_replace: "edit",
    list_tracked_changes: "edit",
    accept_changes: "edit",
    reject_changes: "edit",
    create_doc: "files",
    create_folder: "files",
    upload_file: "files",
    delete_entity: "files",
    rename_entity: "files",
    move_entity: "files",
    compile: "compile",
    read_log: "compile",
    preview_pdf: "compile",
    download_file: "download",
    download_project: "download",
    download_output: "download",
    list_comments: "comment",
    read_comment_thread: "comment",
    add_comment: "comment",
    reply_comment: "comment",
    resolve_comment: "comment",
    reopen_comment: "comment",
};

function nowTime() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
}

function formatArgValue(key, val) {
    if (key === "content_base64" && typeof val === "string") {
        return `<base64:${val.length}B>`;
    }
    if (typeof val === "string") {
        const compact = val.replace(/\s+/g, " ").trim();
        const sliced = compact.length > 60 ? `${compact.slice(0, 56)}…` : compact;
        return JSON.stringify(sliced);
    }
    if (Array.isArray(val)) {
        return `[${val.length}项]`;
    }
    if (val && typeof val === "object") {
        return `{${Object.keys(val).length}键}`;
    }
    return String(val);
}

function summarizeOutput(res) {
    if (!res || !Array.isArray(res.content))
        return "(无文本输出)";
    const textParts = [];
    let imageCount = 0;
    for (const item of res.content) {
        if (item?.type === "text" && typeof item.text === "string") {
            textParts.push(item.text);
        }
        else if (item?.type === "image") {
            imageCount += 1;
        }
    }
    const joined = textParts.join(" | ").replace(/\s+/g, " ").trim();
    const preview = joined.length > 180 ? `${joined.slice(0, 176)}…` : joined;
    const imgSuffix = imageCount > 0 ? ` 🖼️+${imageCount}` : "";
    return `${preview || "(非文本内容)"}${imgSuffix}`;
}

export class ToolExecutionLogger {
    constructor(writeLine = (line) => process.stderr.write(`${line}\n`)) {
        this.writeLine = writeLine;
    }

    static getCategory(toolName) {
        const key = TOOL_CATEGORY_MAP[toolName] ?? "other";
        return CATEGORIES[key];
    }

    formatArgs(args) {
        if (!args || typeof args !== "object")
            return "";
        const pairs = [];
        for (const [k, v] of Object.entries(args)) {
            if (v === undefined)
                continue;
            pairs.push(`${ANSI.dim}${k}=${ANSI.reset}${formatArgValue(k, v)}`);
        }
        return pairs.join(" ");
    }

    wrapHandler(toolName, handler) {
        const cat = ToolExecutionLogger.getCategory(toolName);
        return async (args, extra) => {
            const startedAt = Date.now();
            const argStr = this.formatArgs(args);
            const argPart = argStr ? `  ${argStr}` : "";
            this.writeLine(
                `${ANSI.dim}${nowTime()}${ANSI.reset} ${cat.color}${cat.icon} [${cat.label}] ${ANSI.bold}${toolName}${ANSI.reset}${argPart}`
            );
            try {
                const res = await handler(args, extra);
                const ms = Date.now() - startedAt;
                const summary = summarizeOutput(res);
                if (res?.isError) {
                    this.writeLine(
                        `   ${ANSI.dim}└─${ANSI.reset} ${ANSI.red}❌ FAIL (${ms}ms)${ANSI.reset} ${ANSI.dim}│${ANSI.reset} ${ANSI.red}${summary}${ANSI.reset}`
                    );
                }
                else {
                    this.writeLine(
                        `   ${ANSI.dim}└─${ANSI.reset} ${ANSI.green}✅ ${ms}ms${ANSI.reset} ${ANSI.dim}│${ANSI.reset} ${summary}`
                    );
                }
                return res;
            }
            catch (err) {
                const ms = Date.now() - startedAt;
                const msg = err instanceof Error ? err.message : String(err);
                this.writeLine(
                    `   ${ANSI.dim}└─${ANSI.reset} ${ANSI.red}💥 THROW (${ms}ms)${ANSI.reset} ${ANSI.dim}│${ANSI.reset} ${ANSI.red}${msg}${ANSI.reset}`
                );
                throw err;
            }
        };
    }
}

/**
 * Instruments `server.registerTool` so every registered MCP tool emits
 * structured categorized logs to stderr for the live gateway console.
 */
export function instrumentToolLogging(server, toolLogger = new ToolExecutionLogger()) {
    const origRegister = server.registerTool.bind(server);
    server.registerTool = (name, config, handler) => {
        if (typeof handler === "function") {
            return origRegister(name, config, toolLogger.wrapHandler(name, handler));
        }
        return origRegister(name, config, handler);
    };
    return server;
}
