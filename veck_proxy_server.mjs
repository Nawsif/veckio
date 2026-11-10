import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { request as requestHTTPS } from "node:https";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseURL, upstreamURL, relayRedirect } from "./veck-relay.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const assetPath = /^\/(?:index\.html|sdk\.js|main\.css|bg\.webp|logo\.webp|(?:Build|StreamingAssets|favicon|s|screenshots)\/.*)$/;
const types = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".wasm": "application/wasm", ".ico": "image/x-icon",
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"
};

function proxyHeaders(headers, upgrading = false) {
    const result = { ...headers };
    for (const name of (headers.connection || "").toLowerCase().split(/\s*,\s*/)) {
        if (!upgrading || name !== "upgrade") delete result[name];
    }
    for (const name of ["host", "connection", "keep-alive", "proxy-connection",
        "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding"]) {
        delete result[name];
    }
    if (upgrading) result.connection = "Upgrade";
    else delete result.upgrade;
    return result;
}

function isLocalRequest(request) {
    return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host || "") &&
        (!request.headers.origin || request.headers.origin === `http://${request.headers.host}`);
}

async function serveAsset(request, response, pathname) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow: "GET, HEAD" }).end();
        return;
    }
    try {
        const name = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
        const file = resolve(root, "." + name);
        const relative = "/" + file.slice(root.length).split(sep).join("/");
        if (!file.startsWith(root) || !assetPath.test(relative)) {
            response.writeHead(404).end("Not found");
            return;
        }
        const info = await stat(file);
        if (!info.isFile()) {
            response.writeHead(404).end("Not found");
            return;
        }
        response.writeHead(200, {
            "Content-Type": types[extname(file)] || "application/octet-stream",
            "Content-Length": info.size,
            "Cache-Control": "no-cache"
        });
        if (request.method === "HEAD") response.end();
        else createReadStream(file).on("error", () => response.destroy()).pipe(response);
    } catch {
        response.writeHead(404).end("Not found");
    }
}

export function createRelayServer(connect = requestHTTPS) {
    const server = createServer((request, response) => {
        if (!isLocalRequest(request)) {
            response.writeHead(403).end("Game origin is not allowed");
            return;
        }

        const url = parseURL(request.url, "http://localhost");
        if (!url) {
            response.writeHead(400).end("Invalid request URL");
            return;
        }
        if (!url.pathname.startsWith("/proxy/")) {
            void serveAsset(request, response, url.pathname);
            return;
        }
        const target = upstreamURL(url);
        if (!target) {
            response.writeHead(404).end("Unknown relay route");
            return;
        }

        const upstream = connect(target, {
            method: request.method, headers: proxyHeaders(request.headers), timeout: 45000
        }, incoming => {
            const headers = proxyHeaders(incoming.headers);
            if (headers.location) headers.location = relayRedirect(headers.location, target);
            response.writeHead(incoming.statusCode, headers);
            incoming.on("error", () => response.destroy()).pipe(response);
        });
        upstream.on("timeout", () => upstream.destroy(new Error("Upstream timeout")));
        upstream.on("error", () => {
            if (response.headersSent) response.destroy();
            else response.writeHead(502).end("Veck upstream is unreachable");
        });
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
    });

    server.on("upgrade", (request, client, clientHead) => {
        const reject = (status) => client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        if (!isLocalRequest(request)) return reject("403 Forbidden");

        const target = upstreamURL(request.url);
        if (!target || request.headers.upgrade?.toLowerCase() !== "websocket") {
            return reject("404 Not Found");
        }
        const upstream = connect(target, { headers: proxyHeaders(request.headers, true), timeout: 15000 });
        client.on("error", () => upstream.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("timeout", () => upstream.destroy(new Error("Upstream timeout")));
        upstream.on("error", () => reject("502 Bad Gateway"));
        upstream.on("response", response => {
            response.resume();
            reject(`${response.statusCode} ${response.statusMessage}`);
        });
        upstream.on("upgrade", (response, socket, upstreamHead) => {
            socket.setTimeout(0);
            socket.on("error", () => client.destroy());
            socket.on("close", () => client.destroy());
            client.on("close", () => socket.destroy());

            const headers = response.rawHeaders;
            const lines = ["HTTP/1.1 101 Switching Protocols"];
            for (let index = 0; index < headers.length; index += 2) {
                lines.push(`${headers[index]}: ${headers[index + 1]}`);
            }
            client.write(lines.join("\r\n") + "\r\n\r\n");
            if (upstreamHead.length) client.write(upstreamHead);
            if (clientHead.length) socket.write(clientHead);
            client.pipe(socket).pipe(client);
        });
        upstream.end();
    });

    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT || 1234);
    createRelayServer().listen(port, "127.0.0.1", () => {
        console.log(`Veck proxy is running at http://127.0.0.1:${port}/`);
    });
}
