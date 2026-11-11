import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  cdi3Counts,
  createManifest,
  describeAssets,
  normalizeModel3,
  readMocVersion,
  referenceName,
  validateManifest
} from "../src/manifest.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RUNTIME = join(ROOT, "assets", "LED-live2d");
const MODEL3 = JSON.parse(readFileSync(join(RUNTIME, "LED-live2d.model3.json"), "utf8"));

test("model3.json 归一化出 moc / 图集 / 显示信息", () => {
  const refs = normalizeModel3(MODEL3);
  assert.equal(refs.moc, "LED-live2d.moc3");
  assert.deepEqual(refs.textures, ["LED-live2d.2048/texture_00.png"]);
  assert.equal(refs.displayInfo, "LED-live2d.cdi3.json");
  assert.equal(refs.version, 3);
});

test("缺文件引用的 model3 直接报错，信息给人看", () => {
  assert.throws(() => normalizeModel3(null), /不是对象/);
  assert.throws(() => normalizeModel3({}), /FileReferences/);
  assert.throws(() => normalizeModel3({ FileReferences: { Textures: [] } }), /Moc/);
});

test("referenceName 只取文件名（浏览器里按文件名匹配 File）", () => {
  assert.equal(referenceName("LED-live2d.2048/texture_00.png"), "texture_00.png");
  assert.equal(referenceName("a\\b\\c.moc3"), "c.moc3");
  assert.equal(referenceName("plain.json"), "plain.json");
});

test("moc3 版本号：真实文件是 v5", () => {
  const bytes = readFileSync(join(RUNTIME, "LED-live2d.moc3"));
  assert.equal(readMocVersion(bytes), 5);
  assert.equal(readMocVersion(Uint8Array.from([0x4d, 0x4f, 0x43, 0x33])), 0, "太短");
  assert.equal(readMocVersion(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), 0, "magic 不对");
});

test("createManifest / validateManifest / describeAssets", () => {
  const manifest = createManifest({
    model3: MODEL3,
    moc3: "A".repeat(128),
    textures: ["data:image/png;base64,AAAA"],
    cdi3: null,
    name: "LED-live2d"
  });
  assert.equal(manifest.name, "LED-live2d");
  assert.equal(manifest.sources.moc3, "LED-live2d.moc3");
  assert.deepEqual(validateManifest(manifest), []);
  assert.match(describeAssets(manifest), /LED-live2d · moc3 0KB · 1 张图集/);

  assert.deepEqual(validateManifest(null), ["没有模型数据"]);
  assert.equal(validateManifest({ moc3: "A".repeat(128), textures: [] }).length, 1);
  assert.equal(validateManifest({ moc3: "x", textures: [] }).length, 2);
});

test("cdi3 参数/部件计数", () => {
  const cdi3 = JSON.parse(readFileSync(join(RUNTIME, "LED-live2d.cdi3.json"), "utf8"));
  assert.deepEqual(cdi3Counts(cdi3), { parameters: 27, parts: 1 });
  assert.deepEqual(cdi3Counts(null), { parameters: 0, parts: 0 });
});
