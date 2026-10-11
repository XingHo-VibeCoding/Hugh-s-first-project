// 把 PDF 某一页渲染成图片，用来肉眼核对原始排版
// 用法：node scripts/pdf-page-image.js <文件.pdf> <页码(1起)>

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const FILE = process.argv[2];
const PAGE = parseInt(process.argv[3] || "5", 10);

(async () => {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8899/importer-lab.html", { waitUntil: "networkidle0" });

  const b64 = fs.readFileSync(FILE).toString("base64");
  const out = await page.evaluate(async (b64, pageNo) => {
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(a) }).promise;
    const p = await doc.getPage(pageNo);
    const viewport = p.getViewport({ scale: 2.2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await p.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
    return canvas.toDataURL("image/png");
  }, b64, PAGE);

  const name = "page-" + PAGE + ".png";
  fs.writeFileSync(name, Buffer.from(out.split(",")[1], "base64"));
  console.log("已保存：" + path.resolve(name));
  await browser.close();
})().catch((e) => { console.error("失败：", e.message); process.exit(1); });