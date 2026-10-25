import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { root } from "./content.mjs";

const directory = await realpath(path.join(root, "dist"));
const port = Number(process.env.PORT || 4174);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};
const server = http.createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    let filename = path.resolve(directory, "." + pathname);
    let relative = path.relative(directory, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if ((await stat(filename)).isDirectory()) {
      if (!url.pathname.endsWith("/")) {
        response
          .writeHead(308, { Location: url.pathname + "/" + url.search })
          .end();
        return;
      }
      filename = path.join(filename, "index.html");
    }
    filename = await realpath(filename);
    relative = path.relative(directory, filename);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const content = await readFile(filename);
    response.writeHead(200, {
      "Content-Type":
        types[path.extname(filename).toLowerCase()] ||
        "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) {
    const status =
      error instanceof URIError
        ? 400
        : ["ENOENT", "ENOTDIR"].includes(error.code)
          ? 404
          : 500;
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(
      status === 404 ? "页面不存在，请返回首页选择作品。" : "无法读取页面。",
    );
  }
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Local: http://127.0.0.1:${port}/ (serving dist/ only)`),
);
