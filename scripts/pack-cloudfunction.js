#!/usr/bin/env node
/**
 * scripts/pack-cloudfunction.js —— 把 cloudfunctions/api 打成部署用的 zip
 *
 * 【为什么需要这个脚本】—— Day 27 踩坑记录
 *
 *   云函数部署的是**这个 zip**，不是仓库里的 .js 源码。
 *   改完源码如果不重新打包，线上跑的还是老代码 ——
 *   而且**没有任何报错**，一切看起来都正常。
 *
 *   Day 23~27 我改了云函数 5 次（校验逻辑、错误分级、学分粒度…），
 *   一次都没重新打包。结果：
 *     本地代码：学分必须是 0.25 的倍数
 *     线上代码：学分必须是 0.5 的倍数   ← 跑了 5 天前的老版本
 *
 *   排查方法是直接打线上 API：
 *     POST credits:0.25 → 返回"学分必须是 0.5 的倍数"
 *   这一条就证明了"线上 ≠ 本地"。
 *
 * 【规矩】
 *   改完 cloudfunctions/api/ 下任何文件 → 跑这个脚本 → 手动上传部署。
 *   index.zip 不进 git（是构建产物），所以每次都要重新生成。
 *
 * 用法：node scripts/pack-cloudfunction.js
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "cloudfunctions", "api");
const OUT = path.join(SRC, "index.zip");

// ---- 收集要打包的文件 ----
// 注意：只打包 .js 和 package.json，别把 index.zip 自己打进去
const ENTRIES = [];
function walk(dir, rel) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const relPath = rel ? rel + "/" + name : name;
    if (fs.statSync(full).isDirectory()) {
      walk(full, relPath);
    } else if (name.endsWith(".js") || name === "package.json") {
      ENTRIES.push({ abs: full, rel: relPath });
    }
  }
}
walk(SRC, "");
ENTRIES.sort((a, b) => (a.rel < b.rel ? -1 : 1));

if (!ENTRIES.length) {
  console.error("✗ 没找到要打包的文件，检查 SRC 路径：", SRC);
  process.exit(1);
}

// ---- CRC32（zip 格式要求）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- 组装 zip ----
const locals = [];
const centrals = [];
let offset = 0;

for (const e of ENTRIES) {
  const nameBuf = Buffer.from(e.rel, "utf8");
  const data = fs.readFileSync(e.abs);
  const crc = crc32(data);
  const deflated = zlib.deflateRawSync(data);
  // 压缩后反而更大就用原始数据（省事，避免 zip 变大）
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;

  // local file header
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);            // version needed
  lfh.writeUInt16LE(0x0800, 6);        // flags：UTF-8 文件名
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt16LE(0, 10);            // mod time
  lfh.writeUInt16LE(0x21, 12);         // mod date（固定值，保证可复现）
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(body.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  locals.push(lfh, nameBuf, body);

  // central directory
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);            // version made by
  cdh.writeUInt16LE(20, 6);            // version needed
  cdh.writeUInt16LE(0x0800, 8);
  cdh.writeUInt16LE(method, 10);
  cdh.writeUInt16LE(0, 12);
  cdh.writeUInt16LE(0x21, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(body.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 38);            // external attrs
  cdh.writeUInt32LE(offset, 42);
  centrals.push(cdh, nameBuf);

  offset += lfh.length + nameBuf.length + body.length;
}

// central directory 结束记录
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(ENTRIES.length, 8);
end.writeUInt16LE(ENTRIES.length, 10);
let cdSize = 0;
centrals.forEach((b) => { cdSize += b.length; });
end.writeUInt32LE(cdSize, 12);
end.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...locals, ...centrals, end]);
fs.writeFileSync(OUT, zip);

// ---- 输出报告 ----
console.log("✓ 已打包：" + path.relative(ROOT, OUT));
console.log("  大小：" + zip.length + " 字节");
console.log("  文件数：" + ENTRIES.length);
ENTRIES.forEach((e) => console.log("    · " + e.rel));

// ---- 自检：确认关键改动真的进去了 ----
console.log("");
console.log("自检（看 zip 里的代码是不是最新版）：");
const zipText = ENTRIES.map((e) => fs.readFileSync(e.abs, "utf8")).join("\n");
const checks = [
  ["学分 0.25 校验", /学分必须是 0\.25 的倍数/],
  ["学分类型校验（B-002）", /学分必须是数字/],
  ["学分上限常量", /MAX_CREDITS/]
];
let bad = 0;
for (const [label, re] of checks) {
  const hit = re.test(zipText);
  console.log("  " + (hit ? "✓" : "✗") + " " + label);
  if (!hit) bad++;
}
console.log("");
if (bad > 0) {
  console.log("⚠️ 有 " + bad + " 项没找到 —— 线上跑的可能是老代码，部署后记得实测一次。");
} else {
  console.log("全部命中，zip 里是最新代码。");
}
console.log("");
console.log("下一步：把 " + path.relative(ROOT, OUT) + " 上传到 CloudBase 控制台并部署。");