/**
 * 表情（.exp3.json）：Cubism 标准格式，只读写官方字段。
 *
 * 根对象：{ Type: "Live2D Expression", FadeInTime, FadeOutTime, Parameters: [{Id, Value, Blend}] }
 * Blend ∈ "Add"（在默认值上加）| "Multiply"（在默认值上乘）| "Overwrite"（直接覆盖）。
 * 依据 CubismWebFramework `cubismexpressionmotion.ts`。
 */

export const EXPRESSION_TYPE = "Live2D Expression";
export const BLEND_ADD = "Add";
export const BLEND_MULTIPLY = "Multiply";
export const BLEND_OVERWRITE = "Overwrite";

const BLENDS = new Set([BLEND_ADD, BLEND_MULTIPLY, BLEND_OVERWRITE]);

function clampTo(value, range) {
  const min = range ? range[0] : -Infinity;
  const max = range ? range[1] : Infinity;
  return Math.min(Math.max(value, min), max);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * 用当前姿态生成表情。
 * @param {{name?: string, values: object, defaults: object, ranges?: object, blend?: string, fadeIn?: number, fadeOut?: number}} input
 */
export function buildExpression(input) {
  const name = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : "Expression";
  const values = input.values || {};
  const defaults = input.defaults || {};
  const ranges = input.ranges || {};
  const blend = BLENDS.has(input.blend) ? input.blend : BLEND_ADD;
  const parameters = [];

  for (const id of Object.keys(values)) {
    const target = Number(values[id]);
    if (!Number.isFinite(target)) continue;
    const base = typeof defaults[id] === "number" ? defaults[id] : 0;
    const range = ranges[id];
    // 先把目标值夹进参数范围，再换算成 Add/Multiply 的相对量：
    // 直接夹相对量会把「闭眼」这种 -0.8 的偏移夹成 0，表情就丢了。
    const clamped = clampTo(target, range);
    let value;
    if (blend === BLEND_OVERWRITE) value = clamped;
    else if (blend === BLEND_MULTIPLY) value = base === 0 ? 1 : clamped / base;
    else value = clamped - base;
    value = round4(value);
    // Add/Multiply 里 0 和 1 分别是「不变」，写进去只会让文件变长
    if (blend === BLEND_ADD && value === 0) continue;
    if (blend === BLEND_MULTIPLY && value === 1) continue;
    parameters.push({ Id: id, Value: value, Blend: blend });
  }

  return {
    Type: EXPRESSION_TYPE,
    FadeInTime: typeof input.fadeIn === "number" ? input.fadeIn : 0.5,
    FadeOutTime: typeof input.fadeOut === "number" ? input.fadeOut : 0.5,
    Parameters: parameters
  };
}

/**
 * 解析 .exp3.json（字符串或对象），坏文件返回 null。
 * @returns {{name: string|null, fadeIn: number, fadeOut: number, parameters: Array<{id: string, value: number, blend: string}>}|null}
 */
export function parseExpression(source) {
  let json = source;
  if (typeof source === "string") {
    try {
      json = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!json || typeof json !== "object") return null;
  if (json.Type !== undefined && json.Type !== EXPRESSION_TYPE) return null;
  const list = Array.isArray(json.Parameters) ? json.Parameters : [];
  const parameters = [];
  for (const item of list) {
    if (!item || typeof item.Id !== "string") continue;
    const value = Number(item.Value);
    if (!Number.isFinite(value)) continue;
    parameters.push({
      id: item.Id,
      value,
      blend: BLENDS.has(item.Blend) ? item.Blend : BLEND_ADD
    });
  }
  if (parameters.length === 0) return null;
  return {
    name: typeof json.Name === "string" ? json.Name : null,
    fadeIn: Number.isFinite(Number(json.FadeInTime)) ? Number(json.FadeInTime) : 0.5,
    fadeOut: Number.isFinite(Number(json.FadeOutTime)) ? Number(json.FadeOutTime) : 0.5,
    parameters
  };
}

/**
 * 把表情解析成「绝对参数值」，用于在编辑器里预览/应用。
 * base 是默认值：Cubism 里表情是在默认值上叠加的。
 */
export function resolveExpression(expression, defaults, ranges) {
  const out = {};
  if (!expression) return out;
  for (const parameter of expression.parameters) {
    const base = typeof defaults[parameter.id] === "number" ? defaults[parameter.id] : 0;
    const range = ranges ? ranges[parameter.id] : undefined;
    if (parameter.blend === BLEND_OVERWRITE) out[parameter.id] = clampTo(parameter.value, range);
    else if (parameter.blend === BLEND_MULTIPLY) out[parameter.id] = clampTo(base * parameter.value, range);
    else out[parameter.id] = clampTo(base + parameter.value, range);
  }
  return out;
}
