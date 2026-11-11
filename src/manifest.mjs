/**
 * 模型清单（manifest）：把 model3.json / moc3 / 图集 / cdi3 收成一个对象，
 * 编辑器和打包脚本共用同一套归一化逻辑。
 *
 * manifest = {
 *   name, moc3 (base64), textures (dataURL[]), cdi3 (对象|null),
 *   model3 (对象|null), sources { moc3, textures[], displayInfo }
 * }
 */

function basename(path) {
  const text = String(path || "").replace(/\\/g, "/");
  const index = text.lastIndexOf("/");
  return index >= 0 ? text.slice(index + 1) : text;
}

/** model3.json 里的相对路径 → 文件名（浏览器里只能按文件名匹配 File） */
export function referenceName(reference) {
  return basename(reference);
}

/** 取 model3.json 的文件引用；没有就抛，错误信息直接给用户看。 */
export function normalizeModel3(model3) {
  if (!model3 || typeof model3 !== "object") throw new Error("model3.json 不是对象");
  const refs = model3.FileReferences;
  if (!refs || typeof refs !== "object") throw new Error("model3.json 缺少 FileReferences");
  const moc = typeof refs.Moc === "string" ? refs.Moc : null;
  if (!moc) throw new Error("model3.json 的 FileReferences.Moc 缺失");
  const textures = Array.isArray(refs.Textures) ? refs.Textures.filter((item) => typeof item === "string") : [];
  return {
    version: Number(model3.Version) || 3,
    moc,
    textures,
    displayInfo: typeof refs.DisplayInfo === "string" ? refs.DisplayInfo : null,
    physics: typeof refs.Physics === "string" ? refs.Physics : null,
    motions: refs.Motions || null,
    expressions: refs.Expressions || null
  };
}

/** moc3 头部：`MOC3` + 小端版本号。 */
export function readMocVersion(bytes) {
  if (!bytes || bytes.length < 8) return 0;
  if (bytes[0] !== 0x4d || bytes[1] !== 0x4f || bytes[2] !== 0x43 || bytes[3] !== 0x33) return 0;
  return bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
}

export function createManifest(input) {
  const model3 = input.model3 || null;
  const refs = model3 ? normalizeModel3(model3) : { moc: input.name + ".moc3", textures: [], displayInfo: null };
  return {
    name: input.name || basename(refs.moc).replace(/\.moc3$/i, "") || "model",
    moc3: input.moc3 || "",
    textures: Array.isArray(input.textures) ? input.textures : [],
    cdi3: input.cdi3 || null,
    model3,
    sources: {
      moc3: refs.moc,
      textures: refs.textures,
      displayInfo: refs.displayInfo
    }
  };
}

/** 装模前的体检，返回问题列表（空数组 = 可以装）。 */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest) return ["没有模型数据"];
  if (!manifest.moc3) problems.push("缺少 moc3 数据");
  else {
    const length = manifest.moc3.length;
    if (length < 64) problems.push("moc3 数据过短");
  }
  if (!Array.isArray(manifest.textures) || manifest.textures.length === 0) problems.push("缺少图集（texture）");
  return problems;
}

/** 给状态栏用的一句话摘要。 */
export function describeAssets(manifest) {
  if (!manifest) return "";
  const textureCount = Array.isArray(manifest.textures) ? manifest.textures.length : 0;
  return `${manifest.name} · moc3 ${manifest.moc3 ? Math.round((manifest.moc3.length * 3) / 4 / 1024) : 0}KB · ${textureCount} 张图集`;
}

/** 参数总数（优先 cdi3，没有就读 Core 的行数）。 */
export function cdi3Counts(cdi3) {
  return {
    parameters: cdi3 && Array.isArray(cdi3.Parameters) ? cdi3.Parameters.length : 0,
    parts: cdi3 && Array.isArray(cdi3.Parts) ? cdi3.Parts.length : 0
  };
}
