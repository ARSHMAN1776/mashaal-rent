// Runs the app on your own computer: npm run dev
// Data is saved in the .data folder, separate from the online version.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { handle } from "../src/server/core";
import { fileStore } from "../src/server/file-store";

const PORT = Number(process.env.PORT) || 8765;
const PUBLIC_DIR = resolve("public");
const kv = fileStore(resolve(".data"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");
      const response = await handle(
        new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }),
        kv,
      );
      res.statusCode = response.status;
      response.headers.forEach((value, key) => { if (key !== "set-cookie") res.setHeader(key, value); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("Set-Cookie", cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }

    const file = resolve(join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC_DIR + sep)) throw new Error("outside public");
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Mashaal Rent a Car is running at http://127.0.0.1:${PORT}\n  Press Ctrl+C to stop.\n`);
});
