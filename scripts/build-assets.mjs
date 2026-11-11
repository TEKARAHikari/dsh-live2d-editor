// 把一个导出的 Live2D 运行时目录打成 build/model-assets.mjs：
// moc3 转 base64、图集转 data URL、cdi3 原样带上，供 build-client.mjs 内联。
//
//   node scripts/build-assets.mjs [--runtime DIR] [--output PATH]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createManifest, normalizeModel3, readMocVersion, describeAssets } from "../src/manifest.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function argOf(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const runtimeDir = resolve(ROOT, argOf("--runtime", "assets/LED-live2d"));
const outputPath = resolve(ROOT, argOf("--output", "build/model-assets.mjs"));

function fail(message) {
  console.error("build-assets: " + message);
  process.exit(1);
}

function sha256(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

if (!existsSync(runtimeDir)) fail(`运行时目录不存在：${runtimeDir}`);
const { readdirSync } = await import("node:fs");
const entries = readdirSync(runtimeDir);
const model3Name = entries.find((name) => /\.model3\.json$/i.test(name)) || entries.find((name) => name === "model3.json");
if (!model3Name) fail(`在 ${runtimeDir} 里找不到 *.model3.json`);

const model3Path = join(runtimeDir, model3Name);
const model3 = JSON.parse(readFileSync(model3Path, "utf8"));
const refs = normalizeModel3(model3);

const mocPath = join(runtimeDir, refs.moc);
if (!existsSync(mocPath)) fail(`model3.json 指向的 moc3 不存在：${refs.moc}`);
const mocBytes = readFileSync(mocPath);
const mocVersion = readMocVersion(mocBytes);
if (mocVersion === 0) fail(`moc3 头部不对（应当是 MOC3）：${refs.moc}`);

const textures = [];
for (const reference of refs.textures) {
  const texturePath = join(runtimeDir, reference);
  if (!existsSync(texturePath)) fail(`model3.json 指向的图集不存在：${reference}`);
  const bytes = readFileSync(texturePath);
  const ext = reference.toLowerCase().endsWith(".webp") ? "webp" : "png";
  textures.push(`data:image/${ext};base64,` + bytes.toString("base64"));
}

let cdi3 = null;
if (refs.displayInfo) {
  const cdi3Path = join(runtimeDir, refs.displayInfo);
  if (existsSync(cdi3Path)) cdi3 = JSON.parse(readFileSync(cdi3Path, "utf8"));
}

const manifest = createManifest({
  model3,
  moc3: mocBytes.toString("base64"),
  textures,
  cdi3,
  name: refs.moc.replace(/\.moc3$/i, "")
});

const header = [
  "// 由 scripts/build-assets.mjs 生成，勿手改。",
  `// 源：${model3Path}`,
  `// moc3：${refs.moc}（v${mocVersion}，${mocBytes.length} 字节，${sha256(mocBytes)}）`,
  `// 图集：${refs.textures.join(", ") || "无"}`,
  `// 摘要：${describeAssets(manifest)}`
].join("\n");

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, header + "\nconst manifest = " + JSON.stringify(manifest) + ";\nexport default manifest;\n");
console.log(JSON.stringify({
  output: outputPath,
  bytes: readFileSync(outputPath).length,
  model: manifest.name,
  moc3Version: mocVersion,
  moc3Bytes: mocBytes.length,
  textures: textures.length,
  cdi3Parameters: cdi3 && Array.isArray(cdi3.Parameters) ? cdi3.Parameters.length : 0
}, null, 1));
