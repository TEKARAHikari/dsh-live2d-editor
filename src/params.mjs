/** 参数与部件：把 Cubism Core 的扁平数组整理成编辑器要用的行，全部纯函数。 */

/** 把 value 夹到 [min, max]；min/max 反过来也认。 */
export function clamp(value, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** 滑块步长：整段范围 200 格，夹在 0.001~1 之间并取整齐值。 */
export function parameterStep(min, max) {
  const range = Math.abs(max - min);
  if (!Number.isFinite(range) || range === 0) return 0.01;
  const raw = range / 200;
  const nice = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  for (const candidate of nice) if (raw <= candidate) return candidate;
  return 1;
}

/** cdi3 里 `Parameters[]` 的 Id→显示名。没有 cdi3 时给空表。 */
export function parameterNameMap(cdi3) {
  const map = {};
  const list = cdi3 && Array.isArray(cdi3.Parameters) ? cdi3.Parameters : [];
  for (const item of list) {
    if (!item || typeof item.Id !== "string") continue;
    map[item.Id] = typeof item.Name === "string" && item.Name.length > 0 ? item.Name : item.Id;
  }
  return map;
}

/** cdi3 里 `Parts[]` 的 Id→显示名。 */
export function partNameMap(cdi3) {
  const map = {};
  const list = cdi3 && Array.isArray(cdi3.Parts) ? cdi3.Parts : [];
  for (const item of list) {
    if (!item || typeof item.Id !== "string") continue;
    map[item.Id] = typeof item.Name === "string" && item.Name.length > 0 ? item.Name : item.Id;
  }
  return map;
}

/**
 * Cubism Core 的 `model.parameters` → 编辑器行。
 * @param {{ids: string[], minimumValues: Float32Array, maximumValues: Float32Array, defaultValues: Float32Array, values: Float32Array}} parameters
 * @param {object|null} cdi3
 */
export function buildParameterRows(parameters, cdi3) {
  const names = parameterNameMap(cdi3);
  const ids = Array.from(parameters.ids || []);
  const rows = [];
  // Core 的 values 是 Float32Array：0.4 会变成 0.4000000059604645。
  // 行数据是要给人看、也要进 exp3/motion3 的，统一收到 1e-5。
  const trim = (value) => Math.round(value * 100000) / 100000;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    const min = trim(Number(parameters.minimumValues[index]));
    const max = trim(Number(parameters.maximumValues[index]));
    const def = trim(Number(parameters.defaultValues[index]));
    rows.push({
      id,
      index,
      name: names[id] || id,
      min,
      max,
      default: def,
      value: trim(Number(parameters.values[index])),
      step: parameterStep(min, max)
    });
  }
  return rows;
}

/** Cubism Core 的 `model.parts` → 行；没有 parts 的模型返回空数组。 */
export function buildPartRows(parts, cdi3) {
  if (!parts || !parts.ids) return [];
  const names = partNameMap(cdi3);
  const ids = Array.from(parts.ids);
  const rows = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    rows.push({
      id,
      index,
      name: names[id] || id,
      opacity: Number(parts.opacities[index])
    });
  }
  return rows;
}

/** 行数组 → {id: value} 快照。 */
export function snapshotValues(rows) {
  const out = {};
  for (const row of rows) out[row.id] = row.value;
  return out;
}

/** 行数组 → {id: 默认值}。 */
export function defaultValueMap(rows) {
  const out = {};
  for (const row of rows) out[row.id] = row.default;
  return out;
}

/** 行数组 → {id: [min, max]}，导出动作/表情时夹值用。 */
export function rangeMap(rows) {
  const out = {};
  for (const row of rows) out[row.id] = [row.min, row.max];
  return out;
}

/** 把 {id: value} 写回行数组，返回新数组（不修改入参）。 */
export function applyValues(rows, values) {
  return rows.map((row) => {
    const next = values[row.id];
    if (typeof next !== "number" || !Number.isFinite(next)) return row;
    return { ...row, value: clamp(next, row.min, row.max) };
  });
}

/** 全部回到默认值，返回新数组。 */
export function resetRows(rows) {
  return rows.map((row) => ({ ...row, value: row.default }));
}

/** 只保留和默认值不同的项（导出表情时瘦身用）。 */
export function diffFromDefaults(values, defaults, epsilon = 1e-4) {
  const out = {};
  for (const id of Object.keys(values)) {
    const base = typeof defaults[id] === "number" ? defaults[id] : 0;
    if (Math.abs(values[id] - base) > epsilon) out[id] = values[id];
  }
  return out;
}

/** 数值显示：按步长决定小数位，去掉多余的 0。 */
export function formatValue(value, step) {
  if (!Number.isFinite(value)) return "0";
  const stepText = String(step);
  const decimals = stepText.includes(".") ? Math.min(4, stepText.split(".")[1].length) : 0;
  const text = value.toFixed(decimals);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}
