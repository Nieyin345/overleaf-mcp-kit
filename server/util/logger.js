// All logging goes to stderr — stdout is reserved for the MCP JSON-RPC channel.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.OL_MCP_LOG_LEVEL ?? "info"] ?? LEVELS.info;
const USE_COLOR = !process.env.NO_COLOR;

const C = {
    reset: USE_COLOR ? "\x1b[0m" : "",
    dim: USE_COLOR ? "\x1b[90m" : "",
    yellow: USE_COLOR ? "\x1b[33m" : "",
    red: USE_COLOR ? "\x1b[31m" : "",
};

const LEVEL_BADGE = {
    debug: "🐞",
    info: "ℹ️ ",
    warn: "⚠️ ",
    error: "❌",
};

function timePrefix() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
}

function log(level, msg, extra) {
    if (LEVELS[level] < threshold)
        return;
    const text = extra === undefined
        ? msg
        : `${msg} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
    const color = level === "error" ? C.red : level === "warn" ? C.yellow : C.dim;
    const badge = LEVEL_BADGE[level] ?? "•";
    const line = `   ${C.dim}${timePrefix()}${C.reset} ${color}${badge} ${text}${C.reset}`;
    process.stderr.write(line + "\n");
}

export const logger = {
    debug: (m, e) => log("debug", m, e),
    info: (m, e) => log("info", m, e),
    warn: (m, e) => log("warn", m, e),
    error: (m, e) => log("error", m, e),
};
