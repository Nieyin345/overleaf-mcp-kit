import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, "..");
const bundledNode = path.join(kitRoot, "node", "node.exe");
const nodeExe = existsSync(bundledNode) ? bundledNode : process.execPath;

async function getFreePort() {
    return await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const p = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => resolve(p));
        });
    });
}

async function createSamplePdfBuffer() {
    // Minimal valid 1-page PDF (ASCII) with text "Hello Overleaf Preview"
    const stream = "BT /F1 18 Tf 72 720 Td (Hello Overleaf Preview) Tj ET";
    const objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
        `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj\n`,
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const obj of objects) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += obj;
    }
    const xrefPos = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i < offsets.length; i++) {
        pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    return Buffer.from(pdf, "ascii");
}

async function testMcpStdioTools() {
    console.log("[test] 1. MCP stdio handshake & tool list...");
    const transport = new StdioClientTransport({
        command: nodeExe,
        args: ["server/index.js"],
        cwd: kitRoot,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const ping = await client.callTool({ name: "ping", arguments: {} });
    assert.match(ping.content[0].text, /^pong \(overleaf-mcp v/);

    const list = await client.listTools();
    const names = new Set(list.tools.map((t) => t.name));
    const expected = [
        "ping", "auth_status", "list_projects", "open_project", "list_files", "read_file",
        "edit_file", "find_and_replace", "multi_replace", "search_in_project", "compile", "read_log",
        "list_comments", "read_comment_thread", "add_comment", "reply_comment", "resolve_comment", "reopen_comment",
        "list_tracked_changes", "accept_changes", "reject_changes",
        "create_folder", "create_doc", "upload_file", "delete_entity", "rename_entity", "move_entity",
        "download_file", "download_project", "download_output", "preview_pdf",
    ];
    for (const name of expected) {
        assert.ok(names.has(name), `Missing expected MCP tool: ${name}`);
    }
    // Verify Gemini / strict OpenAPI schema compatibility across all tools
    const forbiddenKeys = new Set(["$schema", "default", "additionalProperties"]);
    const walkSchema = (node, toolName) => {
        if (Array.isArray(node)) {
            for (const item of node) walkSchema(item, toolName);
            return;
        }
        if (!node || typeof node !== "object") return;
        for (const [k, v] of Object.entries(node)) {
            assert.ok(!forbiddenKeys.has(k), `Tool '${toolName}' schema leaked unsupported key '${k}'`);
            if (k === "minimum") assert.notEqual(v, Number.MIN_SAFE_INTEGER, `Tool '${toolName}' leaked MIN_SAFE_INTEGER`);
            if (k === "maximum") assert.notEqual(v, Number.MAX_SAFE_INTEGER, `Tool '${toolName}' leaked MAX_SAFE_INTEGER`);
            walkSchema(v, toolName);
        }
    };
    for (const tool of list.tools) {
        assert.equal(tool.execution, undefined, `Tool '${tool.name}' should not emit forbidden task execution metadata`);
        walkSchema(tool.inputSchema, tool.name);
        if (tool.outputSchema) walkSchema(tool.outputSchema, tool.name);
    }
    const listProjectsTool = list.tools.find((t) => t.name === "list_projects");
    assert.equal(listProjectsTool.inputSchema.properties.limit.minimum, 1);
    assert.equal(listProjectsTool.inputSchema.properties.limit.maximum, 500);
    await client.close();
    console.log(`[PASS] Verified all ${expected.length} MCP tools & Gemini-compatible schemas over stdio.`);
}

async function testGatewayAndArtifacts() {
    console.log("[test] 2. GatewayServer + ArtifactStore + mcp-proxy end-to-end...");
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "ol-gw-test-"));
    const artifactDir = path.join(tmpBase, "artifacts");
    const downloadDir = path.join(tmpBase, "downloads");

    const { ArtifactStore } = await import("../server/storage/ArtifactStore.js");
    const { GatewayServer } = await import("../gateway/GatewayServer.js");

    const store = new ArtifactStore({
        artifactDir,
        downloadDir,
        publicUrl: "https://example.test",
        artifactTtlMs: 60_000,
    });

    const pdfBuf = await createSamplePdfBuffer();
    const bundle = await store.putPreviewBundle({
        projectId: "proj1234",
        projectName: "Test Paper",
        pdfBuffer: pdfBuf,
        pagePngs: [{ page: 1, buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
        compileSummary: {
            error_count: 0,
            warning_count: 1,
            total_pages: 1,
            compile_time_ms: 420,
            first_errors: [],
        },
    });
    assert.ok(bundle.previewUrl.startsWith("https://example.test/preview/"));
    assert.ok(bundle.downloadUrl.endsWith("/output.pdf"));

    const internalPort = await getFreePort();
    const publicPort = await getFreePort();
    const proxyChild = spawn(
        nodeExe,
        [
            "node_modules/mcp-proxy/dist/bin/mcp-proxy.mjs",
            "--host", "127.0.0.1",
            "--port", String(internalPort),
            "--stateless",
            "--sessionIdleTimeout", "0",
            "--", "./node/node.exe", "server/index.js",
        ],
        { cwd: kitRoot, stdio: ["ignore", "pipe", "pipe"] }
    );

    const gateway = new GatewayServer({
        port: publicPort,
        host: "127.0.0.1",
        upstreamHost: "127.0.0.1",
        upstreamPort: internalPort,
        artifactDir,
    });

    try {
        await gateway.start();

        // Wait briefly for mcp-proxy to listen
        let initialized = false;
        for (let i = 0; i < 40; i++) {
            try {
                const probe = await fetch(`http://127.0.0.1:${publicPort}/mcp`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method: "initialize",
                        params: {
                            protocolVersion: "2025-03-26",
                            capabilities: {},
                            clientInfo: { name: "gw-test", version: "1.0.0" },
                        },
                    }),
                });
                if (probe.status !== 502) {
                    assert.equal(probe.status, 200);
                    initialized = true;
                    break;
                }
            }
            catch {
                // retry
            }
            await new Promise((r) => setTimeout(r, 150));
        }
        assert.ok(initialized, "mcp-proxy failed to initialize through GatewayServer");

        // Stale/unknown Mcp-Session-Id must still succeed in stateless mode (no 404 Session not found)
        const toolsWithStaleSid = await fetch(`http://127.0.0.1:${publicPort}/mcp`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                "Mcp-Session-Id": "4d075022-df1a-41f7-9be1-ba5e68540095",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        });
        assert.equal(toolsWithStaleSid.status, 200, "POST /mcp with stale Mcp-Session-Id must succeed in stateless mode");

        // Test MCP HTTP probe endpoints (HEAD /mcp -> 200, GET /mcp -> 405, DELETE /mcp -> 405, /healthz -> 200)
        const headMcp = await fetch(`http://127.0.0.1:${publicPort}/mcp`, { method: "HEAD" });
        assert.equal(headMcp.status, 200, "HEAD /mcp should return 200 for Web AI health probes");
        assert.ok(headMcp.headers.get("mcp-protocol-version"));
        const getMcpNoSid = await fetch(`http://127.0.0.1:${publicPort}/mcp`, { method: "GET" });
        assert.equal(getMcpNoSid.status, 405, "GET /mcp should return 405 in stateless mode");
        const getMcpWithSid = await fetch(`http://127.0.0.1:${publicPort}/mcp`, {
            method: "GET",
            headers: { "Mcp-Session-Id": "4d075022-df1a-41f7-9be1-ba5e68540095" },
        });
        assert.equal(getMcpWithSid.status, 405, "GET /mcp with stale sid should return 405 in stateless mode");
        const delMcp = await fetch(`http://127.0.0.1:${publicPort}/mcp`, {
            method: "DELETE",
            headers: { "Mcp-Session-Id": "4d075022-df1a-41f7-9be1-ba5e68540095" },
        });
        assert.equal(delMcp.status, 405, "DELETE /mcp should return 405 (not 404) in stateless mode");
        const hzRes = await fetch(`http://127.0.0.1:${publicPort}/healthz`);
        assert.equal(hzRes.status, 200);

        // Test preview HTML & PDF download
        const prevRes = await fetch(`http://127.0.0.1:${publicPort}/preview/${bundle.token}`);
        assert.equal(prevRes.status, 200);
        const prevHtml = await prevRes.text();
        assert.match(prevHtml, /Test Paper/);

        const pdfRes = await fetch(`http://127.0.0.1:${publicPort}/artifacts/${bundle.token}/output.pdf`);
        assert.equal(pdfRes.status, 200);
        assert.equal(pdfRes.headers.get("content-type"), "application/pdf");
        const gotBytes = Buffer.from(await pdfRes.arrayBuffer());
        assert.equal(Buffer.compare(gotBytes, pdfBuf), 0);

        // Test bad token & missing file
        const badTok = await fetch(`http://127.0.0.1:${publicPort}/artifacts/not-a-token/output.pdf`);
        assert.equal(badTok.status, 400);
        const missingFile = await fetch(`http://127.0.0.1:${publicPort}/artifacts/${bundle.token}/secret.txt`);
        assert.equal(missingFile.status, 404);

        console.log("[PASS] GatewayServer proxied /mcp and served /preview + /artifacts securely.");
    }
    finally {
        await gateway.stop();
        proxyChild.kill("SIGKILL");
        await fs.rm(tmpBase, { recursive: true, force: true });
    }
}

async function testMockOverleafWorkflow() {
    console.log("[test] 3. Mock Overleaf HTTP+Socket workflow (upload, create, delete, download, preview_pdf)...");
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "ol-mock-"));
    const appDataDir = path.join(tmpBase, "appdata");
    const artifactDir = path.join(tmpBase, "artifacts");
    const downloadDir = path.join(tmpBase, "downloads");
    const port = await getFreePort();
    const pdfBuf = await createSamplePdfBuffer();

    // Seed cookie.json so discoverCookie skips Chrome launch
    const cookieDir = path.join(appDataDir, "overleaf-mcp");
    await fs.mkdir(cookieDir, { recursive: true });
    await fs.writeFile(
        path.join(cookieDir, "cookie.json"),
        JSON.stringify({
            hosts: {
                [`127.0.0.1:${port}`]: { cookie: "overleaf_session2=mock-cookie", savedAt: Date.now() },
            },
        })
    );

    // Stateful mock project tree
    const rootFolder = {
        _id: "root0001",
        name: "rootFolder",
        folders: [],
        docs: [{ _id: "doc00001", name: "main.tex" }],
        fileRefs: [],
    };
    const docContents = new Map([["doc00001", "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}"]]);
    const docVersions = new Map([["doc00001", 1]]);
    const fileContents = new Map();
    let seq = 100;
    const events = [];

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        const p = url.pathname;
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const rawBody = Buffer.concat(chunks);

        if (req.method === "GET" && p === "/project") {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<meta name="ol-user_id" content="user001"><meta name="ol-usersEmail" content="ai@test.local"><meta name="ol-csrfToken" content="csrf123">`);
            return;
        }
        if (req.method === "GET" && p.startsWith("/socket.io/1/")) {
            res.writeHead(200, {
                "Content-Type": "text/plain",
                "Set-Cookie": "GCLB=sticky-v2; Path=/",
            });
            res.end("sid123:60:60:websocket");
            return;
        }
        if (req.method === "POST" && p === "/project/proj000001/folder") {
            const body = JSON.parse(rawBody.toString("utf8"));
            const id = `fld${++seq}`;
            const findFolder = (f) => {
                if (f._id === body.parent_folder_id) return f;
                for (const sub of f.folders) {
                    const hit = findFolder(sub);
                    if (hit) return hit;
                }
                return null;
            };
            const parent = findFolder(rootFolder);
            parent.folders.push({ _id: id, name: body.name, folders: [], docs: [], fileRefs: [] });
            events.push(`mkdir:${body.name}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ _id: id, name: body.name }));
            return;
        }
        if (req.method === "POST" && p === "/project/proj000001/doc") {
            const body = JSON.parse(rawBody.toString("utf8"));
            const id = `doc${++seq}`;
            const findFolder = (f) => {
                if (f._id === body.parent_folder_id) return f;
                for (const sub of f.folders) {
                    const hit = findFolder(sub);
                    if (hit) return hit;
                }
                return null;
            };
            const parent = findFolder(rootFolder);
            parent.docs.push({ _id: id, name: body.name });
            docContents.set(id, "");
            docVersions.set(id, 0);
            events.push(`mkdoc:${body.name}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ _id: id, name: body.name }));
            return;
        }
        if (req.method === "POST" && p === "/project/proj000001/upload") {
            const folderId = url.searchParams.get("folder_id");
            const ct = req.headers["content-type"] ?? "";
            assert.ok(ct.includes("multipart/form-data"), "Upload must be multipart/form-data");
            assert.ok(folderId, "folder_id must be in query string");
            const bodyStr = rawBody.toString("latin1");
            const nameMatch = bodyStr.match(/name="name"\r\n\r\n([^\r\n]+)/);
            const filename = nameMatch ? nameMatch[1] : "uploaded.bin";
            const id = `file${++seq}`;
            const findFolder = (f) => {
                if (f._id === folderId) return f;
                for (const sub of f.folders) {
                    const hit = findFolder(sub);
                    if (hit) return hit;
                }
                return null;
            };
            const parent = findFolder(rootFolder);
            parent.fileRefs.push({ _id: id, name: filename });
            fileContents.set(id, Buffer.from("PNGDATA"));
            events.push(`upload:${filename}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, entity_id: id, entity_type: "file" }));
            return;
        }
        if (req.method === "DELETE" && /^\/project\/proj000001\/(doc|file|folder)\//.test(p)) {
            const [, , , kind, id] = p.split("/");
            let found = false;
            const removeFrom = (f) => {
                const dLen = f.docs.length;
                f.docs = f.docs.filter((d) => d._id !== id);
                if (f.docs.length !== dLen) found = true;
                const fLen = f.fileRefs.length;
                f.fileRefs = f.fileRefs.filter((x) => x._id !== id);
                if (f.fileRefs.length !== fLen) found = true;
                const subLen = f.folders.length;
                f.folders = f.folders.filter((sub) => sub._id !== id);
                if (f.folders.length !== subLen) found = true;
                for (const sub of f.folders) removeFrom(sub);
            };
            removeFrom(rootFolder);
            if (!found) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
                return;
            }
            events.push(`delete:${kind}:${id}`);
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "POST" && /^\/project\/proj000001\/(doc|file|folder)\/[^/]+\/move$/.test(p)) {
            const [, , , kind, id] = p.split("/");
            const body = JSON.parse(rawBody.toString("utf8"));
            let movedItem = null;
            const extractFrom = (f) => {
                for (const [key, arr] of [["docs", f.docs], ["fileRefs", f.fileRefs], ["folders", f.folders]]) {
                    const idx = arr.findIndex((x) => x._id === id);
                    if (idx >= 0) {
                        movedItem = { key, item: arr.splice(idx, 1)[0] };
                        return;
                    }
                }
                for (const sub of f.folders) extractFrom(sub);
            };
            const findFolder = (f) => {
                if (f._id === body.folder_id) return f;
                for (const sub of f.folders) {
                    const hit = findFolder(sub);
                    if (hit) return hit;
                }
                return null;
            };
            extractFrom(rootFolder);
            const dest = findFolder(rootFolder);
            assert.ok(movedItem && dest, `move target not found (${kind}:${id} -> ${body.folder_id})`);
            dest[movedItem.key].push(movedItem.item);
            events.push(`move:${kind}:${id}`);
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "POST" && /^\/project\/proj000001\/(doc|file|folder)\/[^/]+\/rename$/.test(p)) {
            const [, , , , id] = p.split("/");
            const body = JSON.parse(rawBody.toString("utf8"));
            const renameIn = (f) => {
                for (const d of f.docs) if (d._id === id) d.name = body.name;
                for (const x of f.fileRefs) if (x._id === id) x.name = body.name;
                for (const sub of f.folders) {
                    if (sub._id === id) sub.name = body.name;
                    renameIn(sub);
                }
            };
            renameIn(rootFolder);
            events.push(`rename:${body.name}`);
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "GET" && p === "/project/proj000001/download/zip") {
            res.writeHead(200, { "Content-Type": "application/zip" });
            res.end(Buffer.from("PK\x03\x04mockzip"));
            return;
        }
        if (req.method === "POST" && p === "/project/proj000001/compile") {
            const body = JSON.parse(rawBody.toString("utf8"));
            assert.notEqual(body.rootResourcePath, null, "compile must never send rootResourcePath: null (Overleaf Zod rejects null with HTTP 400)");
            if (body.rootResourcePath !== undefined) {
                assert.equal(typeof body.rootResourcePath, "string");
                assert.ok(body.rootResourcePath.length > 0);
            }
            assert.equal(body.rootResourcePath, "main.tex", "compile without root_doc should default to active rootDocPath");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "success",
                clsiServerId: "clsi-1",
                compileGroup: "grp-1",
                timings: { compile: 120, compileE2E: 150 },
                outputFiles: [
                    { path: "output.pdf", url: "/project/proj000001/output/output.pdf", type: "pdf" },
                    { path: "output.log", url: "/project/proj000001/output/output.log", type: "log" },
                ],
            }));
            return;
        }
        if (req.method === "GET" && p === "/project/proj000001/output/output.log") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("This is pdfTeX\nOutput written on output.pdf (1 page).\n");
            return;
        }
        if (req.method === "GET" && p === "/project/proj000001/output/output.pdf") {
            assert.equal(url.searchParams.get("clsiserverid"), "clsi-1");
            res.writeHead(200, { "Content-Type": "application/pdf" });
            res.end(pdfBuf);
            return;
        }
        if (req.method === "POST" && /^\/project\/proj000001\/doc\/[^/]+\/thread\/[^/]+\/messages$/.test(p)) {
            const threadId = p.split("/")[6];
            const body = JSON.parse(rawBody.toString("utf8"));
            events.push(`comment:${threadId}:${body.content.length}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (req.method === "GET" && p.startsWith("/project/proj000001/file/")) {
            const id = p.split("/").pop();
            res.writeHead(200, { "Content-Type": "application/octet-stream" });
            res.end(fileContents.get(id) ?? Buffer.from(""));
            return;
        }
        res.writeHead(404);
        res.end("Not found");
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.send("1::");
            ws.send(`5:::{"name":"joinProjectResponse","args":[{"project":{"_id":"proj000001","name":"MockPaper","rootDoc_id":"doc00001","rootFolder":[${JSON.stringify(rootFolder)}]},"permissionsLevel":"owner","protocolVersion":2}]}`);
            ws.on("message", (msg) => {
                const s = msg.toString("utf8");
                if (s === "2::") return;
                const m = s.match(/^5:(\d+)\+::([\s\S]+)$/);
                if (!m) return;
                const ackId = m[1];
                const { name, args } = JSON.parse(m[2]);
                if (name === "joinProject") {
                    // Simulate Overleaf v2 behavior: already-joined socket NEVER acks subsequent joinProject emits!
                    // Any caller relying on emit("joinProject") on an already-joined socket will time out.
                    return;
                }
                else if (name === "joinDoc") {
                    const docId = args[0];
                    const lines = (docContents.get(docId) ?? "").split("\n");
                    const ver = docVersions.get(docId) ?? 0;
                    ws.send(`6:::${ackId}+${JSON.stringify([null, lines, ver, [], {}])}`);
                }
                else if (name === "applyOtUpdate") {
                    const [docId, upd] = args;
                    let text = docContents.get(docId) ?? "";
                    for (const op of upd.op) {
                        if (op.i !== undefined) {
                            text = text.slice(0, op.p) + op.i + text.slice(op.p);
                        }
                        else if (op.d !== undefined) {
                            text = text.slice(0, op.p) + text.slice(op.p + op.d.length);
                        }
                    }
                    docContents.set(docId, text);
                    docVersions.set(docId, (docVersions.get(docId) ?? 0) + 1);
                    ws.send(`6:::${ackId}+${JSON.stringify([null])}`);
                }
            });
        });
    });

    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

    const transport = new StdioClientTransport({
        command: nodeExe,
        args: ["server/index.js"],
        cwd: kitRoot,
        env: {
            ...process.env,
            APPDATA: appDataDir,
            OL_BASE_URL: `http://127.0.0.1:${port}`,
            OL_PUBLIC_URL: "https://example.test",
            OL_ARTIFACT_DIR: artifactDir,
            OL_DOWNLOAD_DIR: downloadDir,
        },
    });

    const client = new Client({ name: "mock-test", version: "1.0.0" }, { capabilities: {} });
    try {
        await client.connect(transport);

        // Check auth_status against mock Overleaf
        const authRes = await client.callTool({ name: "auth_status", arguments: { verify: true } });
        assert.ok(!authRes.isError, authRes.content[0].text);
        assert.match(authRes.content[0].text, /ai@test\.local/);

        // Open project
        const openRes = await client.callTool({ name: "open_project", arguments: { project_id: "proj000001" } });
        assert.ok(!openRes.isError, openRes.content[0].text);

        // Upload binary image into nested folder
        const upRes = await client.callTool({
            name: "upload_file",
            arguments: {
                path: "figures/chart.png",
                content_base64: Buffer.from("PNGDATA").toString("base64"),
            },
        });
        assert.ok(!upRes.isError, upRes.content[0].text);

        // Create doc with initial content
        const docRes = await client.callTool({
            name: "create_doc",
            arguments: {
                path: "chapters/intro.tex",
                content: "\\section{Intro}\nHello world.",
            },
        });
        assert.ok(!docRes.isError, docRes.content[0].text);

        // Verify list_files shows newly created items immediately
        const filesRes = await client.callTool({ name: "list_files", arguments: {} });
        assert.match(filesRes.content[0].text, /figures\/chart\.png/);
        assert.match(filesRes.content[0].text, /chapters\/intro\.tex/);

        // Rename doc
        const renRes = await client.callTool({
            name: "rename_entity",
            arguments: { path: "chapters/intro.tex", new_name: "intro_v2.tex" },
        });
        assert.ok(!renRes.isError, renRes.content[0].text);

        // Batch edit via multi_replace & search_in_project
        const mrRes = await client.callTool({
            name: "multi_replace",
            arguments: {
                path: "chapters/intro_v2.tex",
                edits: [
                    { old_string: "\\section{Intro}", new_string: "\\section{Introduction}" },
                    { old_string: "Hello world.", new_string: "Hello Overleaf MCP!" },
                ],
            },
        });
        assert.ok(!mrRes.isError, mrRes.content[0].text);

        const searchRes = await client.callTool({
            name: "search_in_project",
            arguments: { query: "Overleaf MCP", context_lines: 1 },
        });
        assert.ok(!searchRes.isError, searchRes.content[0].text);
        assert.match(searchRes.content[0].text, /chapters\/intro_v2\.tex/);

        // Add anchored review comment
        const cmtRes = await client.callTool({
            name: "add_comment",
            arguments: {
                path: "chapters/intro_v2.tex",
                quote: "Hello Overleaf MCP!",
                content: "Please double-check this phrasing.",
            },
        });
        assert.ok(!cmtRes.isError, cmtRes.content[0].text);
        assert.match(cmtRes.content[0].text, /Added comment thread/);

        // Protect root doc deletion
        const delRoot = await client.callTool({ name: "delete_entity", arguments: { path: "main.tex" } });
        assert.ok(delRoot.isError, "Root doc deletion should require force:true");

        // Delete uploaded file
        const delFile = await client.callTool({ name: "delete_entity", arguments: { path: "figures/chart.png" } });
        assert.ok(!delFile.isError, delFile.content[0].text);

        // Create empty folder explicitly, verify immediate tree sync, move a doc in/out, and delete empty folder
        const mkFldRes = await client.callTool({ name: "create_folder", arguments: { path: "__mcp_tool_test_20261115" } });
        assert.ok(!mkFldRes.isError, mkFldRes.content[0].text);
        const mkSubDocRes = await client.callTool({
            name: "create_doc",
            arguments: { path: "__mcp_tool_test_20261115/temp_note.tex", content: "temp" },
        });
        assert.ok(!mkSubDocRes.isError, mkSubDocRes.content[0].text);
        const mvRes = await client.callTool({
            name: "move_entity",
            arguments: { path: "__mcp_tool_test_20261115/temp_note.tex", destination_folder: "chapters" },
        });
        assert.ok(!mvRes.isError, mvRes.content[0].text);
        const delEmptyFld = await client.callTool({ name: "delete_entity", arguments: { path: "__mcp_tool_test_20261115" } });
        assert.ok(!delEmptyFld.isError, delEmptyFld.content[0].text);

        // Out-of-band server deletion -> client gets 404 on DELETE -> refreshes cleanly and succeeds as already_absent
        const oobDocRes = await client.callTool({ name: "create_doc", arguments: { path: "chapters/gone.tex", content: "x" } });
        assert.ok(!oobDocRes.isError, oobDocRes.content[0].text);
        const chapFld = rootFolder.folders.find((f) => f.name === "chapters");
        chapFld.docs = chapFld.docs.filter((d) => d.name !== "gone.tex");
        const delGone = await client.callTool({ name: "delete_entity", arguments: { path: "chapters/gone.tex" } });
        assert.ok(!delGone.isError, delGone.content[0].text);

        // Non-empty folder requires recursive: true
        const delNonEmptyFail = await client.callTool({ name: "delete_entity", arguments: { path: "chapters" } });
        assert.ok(delNonEmptyFail.isError, "Non-empty folder should refuse delete without recursive: true");
        const delRecursiveOk = await client.callTool({ name: "delete_entity", arguments: { path: "chapters", recursive: true } });
        assert.ok(!delRecursiveOk.isError, delRecursiveOk.content[0].text);

        // Compile directly WITHOUT root_doc (must not send rootResourcePath: null)
        const cmpRes = await client.callTool({ name: "compile", arguments: {} });
        assert.ok(!cmpRes.isError, cmpRes.content[0].text);
        assert.match(cmpRes.content[0].text, /Built cleanly/);

        // Download project zip
        const zipRes = await client.callTool({ name: "download_project", arguments: {} });
        assert.ok(!zipRes.isError, zipRes.content[0].text);
        assert.match(zipRes.content[0].text, /https:\/\/example\.test\/artifacts\//);

        // Compile & Preview PDF (checks PNG rendering + text extraction + preview URL)
        const prevRes = await client.callTool({
            name: "preview_pdf",
            arguments: { pages: "1", dpi: 100, include_text: true },
        });
        assert.ok(!prevRes.isError, prevRes.content[0].text);
        assert.match(prevRes.content[0].text, /https:\/\/example\.test\/preview\//);
        assert.match(prevRes.content[0].text, /Hello Overleaf Preview/);
        assert.ok(prevRes.content.some((c) => c.type === "image" && c.mimeType === "image/png"), "preview_pdf should emit PNG image block");

        // Download compile output
        const outRes = await client.callTool({ name: "download_output", arguments: { output_file: "output.pdf" } });
        assert.ok(!outRes.isError, outRes.content[0].text);
        assert.match(outRes.content[0].text, /output\.pdf/);

        console.log("[PASS] Full mock Overleaf workflow succeeded (events:", events.join(", "), ")");
    }
    finally {
        await client.close().catch(() => undefined);
        wss.close();
        server.close();
        await fs.rm(tmpBase, { recursive: true, force: true });
    }
}

async function testTunnelAndFallbackPreview() {
    console.log("[test] 4. TunnelManager mode resolution & fallback PDF iframe preview...");
    const { TunnelManager } = await import("../gateway/TunnelManager.js");
    const { ArtifactStore } = await import("../server/storage/ArtifactStore.js");

    assert.deepEqual(TunnelManager.resolveMode({ HOSTNAME: "" }), { mode: "quick", hostname: "" });
    assert.deepEqual(TunnelManager.resolveMode({ HOSTNAME: "https://a.example.com/" }), { mode: "custom", hostname: "a.example.com" });
    assert.deepEqual(TunnelManager.resolveMode({ HOSTNAME: "a.example.com", TUNNEL_MODE: "quick" }), { mode: "quick", hostname: "" });
    assert.deepEqual(TunnelManager.resolveMode({ HOSTNAME: "a.example.com", TUNNEL_MODE: "local" }), { mode: "local", hostname: "" });

    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "ol-fallback-"));
    const artifactDir = path.join(tmpBase, "artifacts");
    const downloadDir = path.join(tmpBase, "downloads");
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, ".public-url"), "https://abc-xyz.trycloudflare.com", "utf8");

    const store = new ArtifactStore({ artifactDir, downloadDir, artifactTtlMs: 60_000 });
    const pdfBuf = await createSamplePdfBuffer();
    const bundle = await store.putPreviewBundle({
        projectId: "proj9999",
        projectName: "NoPopplerTest",
        pdfBuffer: pdfBuf,
        pagePngs: [],
        compileSummary: { error_count: 0, warning_count: 0, total_pages: 1, first_errors: [] },
    });
    assert.equal(bundle.previewUrl, `https://abc-xyz.trycloudflare.com/preview/${bundle.token}`);
    const html = await fs.readFile(path.join(artifactDir, bundle.token, "preview.html"), "utf8");
    assert.match(html, /<iframe src="\/artifacts\/[a-f0-9]+\/output\.pdf"/);

    await fs.rm(tmpBase, { recursive: true, force: true });
    console.log("[PASS] TunnelManager & bare-PC PDF iframe preview verified.");
}

async function testCookiePersistenceAndToolLogging() {
    console.log("[test] 5. StartupConfigPrompt, Set-Cookie rotation persistence & ToolExecutionLogger...");
    const { StartupConfigPrompt } = await import("../gateway/StartupPrompt.js");
    const { ToolExecutionLogger } = await import("../server/util/toolLogger.js");
    const { mergeSetCookiesDetailed } = await import("../server/util/cookies.js");
    const { applyResponseCookies } = await import("../server/session/identity.js");
    const { loadStored, saveStored } = await import("../server/auth/cookieStore.js");

    assert.equal(StartupConfigPrompt.normalizeHostname("https://ol.example.com/"), "ol.example.com");
    const nonInt = new StartupConfigPrompt({ TUNNEL_MODE: "custom", HOSTNAME: "ol.example.com", PORT: 8080 }).resolveNonInteractive();
    assert.deepEqual(nonInt, { tunnelMode: "custom", hostname: "ol.example.com", port: 8080, prompted: false });

    const lines = [];
    const tl = new ToolExecutionLogger((l) => lines.push(l));
    const wrapped = tl.wrapHandler("upload_file", async () => ({
        content: [{ type: "text", text: "Uploaded ok" }],
    }));
    await wrapped({ path: "a.png", content_base64: "AAAA" });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /📦 \[文件\].*upload_file.*<base64:4B>/);
    assert.match(lines[1], /└─.*✅ \d+ms.*Uploaded ok/);

    const prevAppData = process.env.APPDATA;
    const prevTtl = process.env.OL_COOKIE_TTL_DAYS;
    const tmpApp = await fs.mkdtemp(path.join(os.tmpdir(), "ol-cookie-ttl-"));
    try {
        process.env.APPDATA = tmpApp;
        process.env.OL_COOKIE_TTL_DAYS = "60";
        const testUrl = "https://mock-cookie.test";
        await saveStored(testUrl, "overleaf_session2=initial_tok; GCLB=1");
        const fakeHeaders = {
            getSetCookie: () => ["overleaf_session2=rotated_tok; Path=/; HttpOnly", "GCLB=2; Path=/"],
        };
        const merged = mergeSetCookiesDetailed("overleaf_session2=initial_tok; GCLB=1", fakeHeaders);
        assert.equal(merged.changed, true);
        assert.equal(merged.hasSessionUpdate, true);
        await applyResponseCookies(testUrl, "overleaf_session2=initial_tok; GCLB=1", fakeHeaders);
        const reloaded = await loadStored(testUrl);
        assert.ok(reloaded?.cookie.includes("overleaf_session2=rotated_tok"), "rotated session cookie should persist");
        assert.ok(reloaded.localExpiresAt > Date.now() + 50 * 86_400_000, "localExpiresAt should honor 60-day TTL");
    }
    finally {
        process.env.APPDATA = prevAppData;
        if (prevTtl === undefined)
            delete process.env.OL_COOKIE_TTL_DAYS;
        else
            process.env.OL_COOKIE_TTL_DAYS = prevTtl;
        await fs.rm(tmpApp, { recursive: true, force: true });
    }
    console.log("[PASS] StartupConfigPrompt, Set-Cookie renewal persistence & ToolExecutionLogger verified.");
}

await testMcpStdioTools();
await testGatewayAndArtifacts();
await testMockOverleafWorkflow();
await testTunnelAndFallbackPreview();
await testCookiePersistenceAndToolLogging();
console.log("\nALL TESTS PASSED.");
