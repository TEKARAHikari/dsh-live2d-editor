// 把 src/ 下的模块拼成一个 DSH 客户端 bundle：lib/client.js
//
// 为什么手写 bundle 而不是上打包器：宿主只加载 ModuleLoader 格式的单文件产物，
// 而这里的依赖面只有 react + 一个 IIFE 渲染器；一个 30 行的拼装脚本比引入整条
// 打包链更容易审。脚本对产物做语法检查，另外用 --check 只校验不写盘。
//
//   node scripts/build-client.mjs [--check]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "lib", "client.js");
const checkOnly = process.argv.includes("--check");

const MODULES = [
  { name: "params", file: "src/params.mjs" },
  { name: "expression", file: "src/expression.mjs" },
  { name: "motion", file: "src/motion.mjs" },
  { name: "manifest", file: "src/manifest.mjs" }
];

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** 去 export 关键字，收集导出的名字（本项目只用 `export function` / `export const`）。 */
function extractModule(source, name) {
  const exported = new Set();
  const functionHits = source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm);
  for (const hit of functionHits) exported.add(hit[1]);
  const constHits = source.matchAll(/^export\s+const\s+([A-Za-z0-9_$]+)/gm);
  for (const hit of constHits) exported.add(hit[1]);
  if (exported.size === 0) throw new Error(`${name}: 没找到任何导出，脚本和源码可能对不上`);
  const stripped = source.replace(/^export\s+/gm, "");
  if (/^export\s+/m.test(stripped) || /\bexport\s+default\b/.test(stripped)) {
    throw new Error(`${name}: 还有没处理掉的 export，构建脚本需要补充规则`);
  }
  return { name, stripped, exported: [...exported] };
}

const modules = MODULES.map((entry) => extractModule(read(entry.file), entry.name));

const coreSource = read("assets/live2dcubismcore.min.js");
const viewportSource = read("src/viewport.js");
const uiSource = read("src/ui.js");
const assetsModulePath = join(ROOT, "build", "model-assets.mjs");
const manifest = (await import("file://" + assetsModulePath.replace(/\\/g, "/"))).default;

const parts = [];
parts.push("// dsh-live2d-editor — 浏览器半边（由 scripts/build-client.mjs 生成，勿手改）");
parts.push("//");
parts.push("// 结构：ModuleLoader bundle → factory 里依次内联 Cubism Core、内置模型、纯逻辑模块、");
parts.push("// WebGL 渲染器、React 面板。纯逻辑在 src/*.mjs 里由 node:test 单独测，构建时去 export 内联。");
parts.push("window.__ModuleLoader__.load({");
parts.push('\tid: "dsh-live2d-editor",');
parts.push("\tfactory: (require) => {");
parts.push("\t\tvar module = { exports: {} };");
parts.push("\t\tvar exports = module.exports;");
parts.push('\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });');
parts.push("");
parts.push('\t\tvar React = require("react");');
parts.push("\t\tvar h = React.createElement;");
parts.push("");
parts.push("\t\t// ── Live2D Cubism Core（Live2D 官方 Redistributable Code）──────────────");
parts.push("\t\t// 只能用间接 eval：<script> 注入会让 emscripten 半初始化，Moc.fromArrayBuffer 报");
parts.push("\t\t// \"Cannot read properties of undefined (reading 'apply')\"。");
parts.push("\t\tvar CORE_SRC = " + JSON.stringify(coreSource) + ";");
parts.push("");
parts.push("\t\t// ── 内置模型（scripts/build-assets.mjs 从 assets/ 生成）────────────────");
parts.push("\t\tvar MODEL_MANIFEST = " + JSON.stringify(manifest) + ";");
parts.push("");

for (const mod of modules) {
  parts.push(`\t\t// ── src/${mod.name}.mjs ─────────────────────────────────────────────`);
  parts.push(`\t\tvar __mod_${mod.name} = (function () {`);
  parts.push(mod.stripped.replace(/^/gm, "\t\t\t").replace(/^\t\t\t$/gm, ""));
  parts.push("\t\t\treturn { " + mod.exported.map((name) => `${name}: ${name}`).join(", ") + " };");
  parts.push("\t\t})();");
  for (const name of mod.exported) parts.push(`\t\tvar ${name} = __mod_${mod.name}.${name};`);
  parts.push("");
}

parts.push("\t\t// ── src/viewport.js（WebGL 视口渲染器）────────────────────────────────");
parts.push(viewportSource.replace(/^/gm, "\t\t"));
parts.push("\t\tvar createLive2DViewport = window.createLive2DEditorViewport;");
parts.push("");
parts.push("\t\t// ── src/ui.js（React 面板）──────────────────────────────────────────");
parts.push(uiSource.replace(/^/gm, "\t\t"));
parts.push("");
parts.push("\t\t// ── 插槽注册 ─────────────────────────────────────────────────────────");
parts.push('\t\texports.inject = ["slots"];');
parts.push("\t\texports.apply = function apply(ctx) {");
parts.push("\t\t\ttry {");
parts.push("\t\t\t\tctx.effect(function () {");
parts.push("\t\t\t\t\treturn installEditorStyles();");
parts.push('\t\t\t\t}, NS + ": stylesheet");');
parts.push("\t\t\t\tctx.effect(function () {");
parts.push('\t\t\t\t\treturn ctx.slots.inject("shell.overlay", function () {');
parts.push("\t\t\t\t\t\treturn ctx.slots.register(");
parts.push("\t\t\t\t\t\t\t{");
parts.push('\t\t\t\t\t\t\t\tname: "shell.overlay",');
parts.push("\t\t\t\t\t\t\t\tid: NS,");
parts.push("\t\t\t\t\t\t\t\torder: 40,");
parts.push("\t\t\t\t\t\t\t\tregistrant: NS,");
parts.push("\t\t\t\t\t\t\t\tinject: function () {");
parts.push("\t\t\t\t\t\t\t\t\treturn {};");
parts.push("\t\t\t\t\t\t\t\t}");
parts.push("\t\t\t\t\t\t\t},");
parts.push("\t\t\t\t\t\t\tLive2DEditor");
parts.push("\t\t\t\t\t\t);");
parts.push("\t\t\t\t\t});");
parts.push('\t\t\t\t}, NS + ": editor overlay");');
parts.push("\t\t\t} catch (error) {");
parts.push("\t\t\t\t// 编辑器不出现是可以接受的；打断宿主渲染不行");
parts.push("\t\t\t\ttry {");
parts.push("\t\t\t\t\tconsole.warn(\"[dsh-live2d-editor] 挂载失败\", error);");
parts.push("\t\t\t\t} catch (ignored) {}");
parts.push("\t\t\t}");
parts.push("\t\t};");
parts.push("");
parts.push("\t\treturn module.exports;");
parts.push("\t}");
parts.push("});");

const bundle = parts.join("\n") + "\n";

try {
  new vm.Script(bundle, { filename: "lib/client.js" });
} catch (error) {
  console.error("build-client: 产物语法错误 " + error.message);
  process.exit(1);
}

const expected = new Map([
  ['id: "dsh-live2d-editor"', "bundle id"],
  ["__ModuleLoader__.load", "模块加载器入口"],
  ['"shell.overlay"', "目标插槽"],
  ["Live2DCubismCore", "内联的 Cubism Core"],
  ["exports.apply", "apply 导出"],
  ["Live2DEditor", "编辑器组件"]
]);
for (const [needle, label] of expected) {
  if (!bundle.includes(needle)) {
    console.error(`build-client: 产物里缺少 ${label}（${needle}）`);
    process.exit(1);
  }
}

const digest = "sha256:" + createHash("sha256").update(bundle).digest("hex");
if (checkOnly) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    current = "";
  }
  const currentDigest = "sha256:" + createHash("sha256").update(current).digest("hex");
  if (currentDigest !== digest) {
    console.error("build-client: lib/client.js 与 src/ 不同步，请运行 npm run build");
    console.error(`  磁盘 ${currentDigest}`);
    console.error(`  期望 ${digest}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ inSync: true, digest, bytes: Buffer.byteLength(bundle) }, null, 1));
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, bundle);
  console.log(JSON.stringify({ output: OUT, bytes: Buffer.byteLength(bundle), digest, modules: modules.map((m) => m.name + ":" + m.exported.length) }, null, 1));
}
