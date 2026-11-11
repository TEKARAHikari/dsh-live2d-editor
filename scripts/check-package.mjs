// 包体检：装之前先看「发出去的到底是什么」。
//   · package.json 的 dsh 字段、exports、files 是否自洽
//   · 产物是否带齐（index.js / lib/client.js / patch / 文档）
//   · npm pack --dry-run 的文件清单里有没有漏或多
//   · 大文件不该进包（build/、assets/ 源文件）
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const problems = [];

function check(condition, message) {
  if (!condition) problems.push(message);
}

// package.json
check(pkg.name === "dsh-live2d-editor", "包名应为 dsh-live2d-editor");
check(pkg.private === true, "本地插件应当 private: true");
check(pkg.type === "module", "应当是 ESM 包");
check(pkg.main === "./index.js", "main 应指向 index.js");
check(pkg.exports && pkg.exports["./client"] === "./lib/client.js", "exports 里要暴露 ./client");
check(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === "./cordis.patch.yml", "dsh.bundle.patch 缺失");
check(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === "web", "dsh.client.platform 应为 web");
check(pkg.dsh && pkg.dsh.compatibility && typeof pkg.dsh.compatibility.dsh === "string", "缺 dsh.compatibility");
check(pkg.engines && pkg.engines.node, "缺 engines.node");

// 产物
const required = ["index.js", "lib/client.js", "cordis.patch.yml", "README.md", "LICENSE", "NOTICE"];
for (const file of required) check(existsSync(join(ROOT, file)), "缺少文件：" + file);

if (existsSync(join(ROOT, "lib/client.js"))) {
  const bundle = readFileSync(join(ROOT, "lib/client.js"), "utf8");
  check(bundle.includes('id: "dsh-live2d-editor"'), "bundle id 不对");
  check(bundle.includes('"shell.overlay"'), "bundle 没有注册 shell.overlay");
  check(bundle.includes("Live2DCubismCore"), "bundle 里没有内联 Cubism Core");
  check(bundle.includes("MODEL_MANIFEST"), "bundle 里没有内置模型");
  const size = statSync(join(ROOT, "lib/client.js")).size;
  check(size > 500_000 && size < 4_000_000, "bundle 体积异常：" + size + " 字节");
}

// 补丁内容
try {
  const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8");
  check(/insert:/.test(patch), "cordis.patch.yml 缺少 insert");
  check(/name: dsh-live2d-editor/.test(patch), "cordis.patch.yml 的行名与包名不一致");
} catch {
  problems.push("cordis.patch.yml 不可读");
}

// npm pack 清单（Windows 下 .cmd 需要 shell，所以统一走 execSync）
let packed = [];
try {
  const output = execSync("npm pack --dry-run --json", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(output);
  packed = (parsed[0] && parsed[0].files ? parsed[0].files : []).map((entry) => entry.path);
} catch (error) {
  problems.push("npm pack --dry-run 失败：" + String(error.message || error).split("\n")[0]);
}

if (packed.length > 0) {
  for (const file of required) check(packed.includes(file), "npm 包里没有：" + file);
  const leaks = packed.filter((path) => /^(build|assets|src|scripts|ref|tools)\//.test(path) || /\.tgz$/.test(path));
  check(leaks.length === 0, "这些不该进包：" + leaks.join(", "));
  const bundleEntry = packed.find((path) => path === "lib/client.js");
  check(Boolean(bundleEntry), "npm 包里没有 lib/client.js");
}

const report = {
  ok: problems.length === 0,
  problems,
  files: packed.length,
  packedBytes: (() => {
    try {
      return execSync("npm pack --dry-run --json", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).length;
    } catch {
      return 0;
    }
  })(),
  bundle: existsSync(join(ROOT, "lib/client.js")) ? statSync(join(ROOT, "lib/client.js")).size : 0
};
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok ? 0 : 1);
