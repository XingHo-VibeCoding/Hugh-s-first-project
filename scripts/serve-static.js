#!/usr/bin/env node
/**
 * scripts/serve-static.js —— 起一个本地静态服务（带 no-store）
 *
 * 【为什么需要它】
 * 培养方案解析（pdf.js）必须在**浏览器里**跑，纯 Node 跑不了。
 * 所以需要一个本地 HTTP 服务把项目目录喂给 Chromium。
 *
 * 【为什么内置 no-store】
 * 调试网页时最烦的就是「改了代码但页面没变」——
 * 浏览器和 CDN 都按 URL 认文件，URL 没变就一直吐旧副本。
 * 这个服务一律 `Cache-Control: no-store`，改完刷新就生效。
 * （本项目 B-006 就是这个坑，当时线上没设缓存，回退演练被缓存骗了两次。）
 *
 * 【为什么不用 `python -m http.server`】
 * 两个实测问题：
 * 1. Windows 上某些端口（如 8901）会报 `WinError 10013`
 *    —— 那是 Windows 的端口排除范围，不是端口冲突
 * 2. 服务不设 no-store，会被浏览器缓存骗
 *
 * 用法：
 *   node scripts/serve-static.js <根目录> [端口]
 * 例：
 *   node scripts/serve-static.js "C:\Users\...\my-first-project" 8899
 *
 * 然后浏览器打开 http://127.0.0.1:8899/index.html
 *
 * ⚠️ 本机注意：部分环境会清理后台进程，
 *    所以「起服务」和「跑测试」最好在同一条命令里做：
 *      node scripts/serve-static.js . 8899 & SRV=$!
 *      node scripts/xxx.js http://127.0.0.1:8899/...
 *      kill $SRV
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2] || ".");
const PORT = Number(process.argv[3] || 8899);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

http
  .createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";

    // 防目录穿越：解析后必须仍在 ROOT 之内
    const f = path.resolve(path.join(ROOT, p));
    if (!f.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("403");
    }

    fs.readFile(f, (e, d) => {
      if (e) {
        res.writeHead(404);
        return res.end("404 " + p);
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(d);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log("静态服务已启动 http://127.0.0.1:" + PORT + "  根目录=" + ROOT);
  });