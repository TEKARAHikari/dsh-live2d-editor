// 下载测试用的 React UMD（只进 build/vendor，不进包）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "build", "vendor");
const FILES = [
  ["react.js", "https://registry.npmmirror.com/react/18.3.1/files/umd/react.production.min.js"],
  ["react-dom.js", "https://registry.npmmirror.com/react-dom/18.3.1/files/umd/react-dom.production.min.js"]
];

mkdirSync(OUT, { recursive: true });
for (const [name, url] of FILES) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`fetch-vendor: ${url} → HTTP ${response.status}`);
    process.exit(1);
  }
  const text = await response.text();
  if (text.length < 5000) {
    console.error(`fetch-vendor: ${name} 内容可疑（${text.length} 字节）`);
    process.exit(1);
  }
  writeFileSync(join(OUT, name), text);
  console.log(`${name} ${text.length} 字节`);
}
