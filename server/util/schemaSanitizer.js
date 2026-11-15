import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Normalizes MCP tool definitions and JSON Schemas produced by Zod v4 / MCP SDK
 * into the strict OpenAPI / JSON Schema subset accepted by both Google Gemini
 * (Connected Apps / Vertex) and OpenAI / Anthropic / local MCP clients.
 */
export class ToolSchemaSanitizer {
    /**
     * Recursively strips schema keywords that strict Gemini FunctionDeclaration
     * validators reject (`$schema`, `default`, `additionalProperties`, and Zod's
     * ±2^53 safe-integer sentinels) while keeping genuine validation bounds.
     */
    sanitizeSchemaNode(node) {
        if (Array.isArray(node)) {
            return node.map((item) => this.sanitizeSchemaNode(item));
        }
        if (!node || typeof node !== "object") {
            return node;
        }

        const out = {};
        for (const [key, val] of Object.entries(node)) {
            if (key === "$schema" || key === "default") {
                continue;
            }
            if (key === "additionalProperties") {
                if (val === false || (val && typeof val === "object" && !Array.isArray(val) && Object.keys(val).length === 0)) {
                    continue;
                }
            }
            if (key === "minimum" && val === SAFE_INT_MIN) {
                continue;
            }
            if (key === "maximum" && val === SAFE_INT_MAX) {
                continue;
            }
            out[key] = this.sanitizeSchemaNode(val);
        }
        return out;
    }

    sanitizeTool(tool) {
        if (!tool || typeof tool !== "object") {
            return tool;
        }
        const cleaned = { ...tool };
        if (cleaned.inputSchema && typeof cleaned.inputSchema === "object") {
            cleaned.inputSchema = this.sanitizeSchemaNode(cleaned.inputSchema);
        }
        if (cleaned.outputSchema && typeof cleaned.outputSchema === "object") {
            cleaned.outputSchema = this.sanitizeSchemaNode(cleaned.outputSchema);
        }
        if (cleaned.execution && typeof cleaned.execution === "object" && cleaned.execution.taskSupport === "forbidden") {
            delete cleaned.execution;
        }
        return cleaned;
    }

    sanitizeListToolsResult(result) {
        if (!result || !Array.isArray(result.tools)) {
            return result;
        }
        return {
            ...result,
            tools: result.tools.map((tool) => this.sanitizeTool(tool)),
        };
    }

    /**
     * Intercepts `McpServer`'s underlying `ListToolsRequestSchema` handler registration
     * so every `tools/list` response is sanitized before leaving the MCP server.
     */
    install(mcpServer) {
        const lowServer = mcpServer?.server;
        if (!lowServer || typeof lowServer.setRequestHandler !== "function") {
            return mcpServer;
        }
        const origSetRequestHandler = lowServer.setRequestHandler.bind(lowServer);
        lowServer.setRequestHandler = (requestSchema, handler) => {
            if (requestSchema === ListToolsRequestSchema && typeof handler === "function") {
                return origSetRequestHandler(requestSchema, async (request, extra) => {
                    const res = await handler(request, extra);
                    return this.sanitizeListToolsResult(res);
                });
            }
            return origSetRequestHandler(requestSchema, handler);
        };
        return mcpServer;
    }
}

export function installSchemaSanitizer(mcpServer, sanitizer = new ToolSchemaSanitizer()) {
    return sanitizer.install(mcpServer);
}
