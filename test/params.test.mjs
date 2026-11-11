import assert from "node:assert/strict";
import test from "node:test";
import {
  applyValues,
  buildParameterRows,
  buildPartRows,
  clamp,
  defaultValueMap,
  diffFromDefaults,
  formatValue,
  parameterNameMap,
  parameterStep,
  partNameMap,
  rangeMap,
  resetRows,
  snapshotValues
} from "../src/params.mjs";

function fakeParameters() {
  return {
    ids: ["ParamAngleX", "ParamEyeLOpen", "ParamUnknown"],
    minimumValues: new Float32Array([-30, 0, -1]),
    maximumValues: new Float32Array([30, 1, 1]),
    defaultValues: new Float32Array([0, 1, 0.5]),
    values: new Float32Array([12, 0.4, 0.5])
  };
}

const CDI3 = {
  Parameters: [
    { Id: "ParamAngleX", GroupId: "", Name: "角度 X" },
    { Id: "ParamEyeLOpen", GroupId: "", Name: "左眼 开闭" }
  ],
  Parts: [{ Id: "Part", Name: "LED.psd" }]
};

test("clamp 认反向区间并把非数字压到下限", () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  assert.equal(clamp(5, 10, 0), 5);
  assert.equal(clamp(Number.NaN, -3, 3), -3);
});

test("parameterStep 给出整进步长", () => {
  assert.equal(parameterStep(-30, 30), 0.5);
  assert.equal(parameterStep(0, 1), 0.005);
  assert.equal(parameterStep(0, 0), 0.01);
});

test("cdi3 名称映射：缺名字时回落到 Id", () => {
  const names = parameterNameMap(CDI3);
  assert.equal(names.ParamAngleX, "角度 X");
  assert.equal(names.ParamEyeLOpen, "左眼 开闭");
  assert.deepEqual(parameterNameMap(null), {});
  assert.equal(partNameMap(CDI3).Part, "LED.psd");
});

test("buildParameterRows 把 Core 数组整理成行", () => {
  const rows = buildParameterRows(fakeParameters(), CDI3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    id: "ParamAngleX",
    index: 0,
    name: "角度 X",
    min: -30,
    max: 30,
    default: 0,
    value: 12,
    step: 0.5
  });
  assert.equal(rows[2].name, "ParamUnknown", "cdi3 里没有的 Id 用 Id 本身");
});

test("buildPartRows 在模型没有 parts 时返回空数组", () => {
  assert.deepEqual(buildPartRows(null, CDI3), []);
  const rows = buildPartRows({ ids: ["Part"], opacities: new Float32Array([0.5]) }, CDI3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "LED.psd");
  assert.equal(rows[0].opacity, 0.5);
});

test("快照 / 默认值 / 范围 / 复位", () => {
  const rows = buildParameterRows(fakeParameters(), CDI3);
  assert.deepEqual(snapshotValues(rows), { ParamAngleX: 12, ParamEyeLOpen: 0.4, ParamUnknown: 0.5 });
  assert.deepEqual(defaultValueMap(rows), { ParamAngleX: 0, ParamEyeLOpen: 1, ParamUnknown: 0.5 });
  assert.deepEqual(rangeMap(rows).ParamAngleX, [-30, 30]);
  assert.deepEqual(resetRows(rows).map((row) => row.value), [0, 1, 0.5]);
});

test("applyValues 夹值且不动入参", () => {
  const rows = buildParameterRows(fakeParameters(), CDI3);
  const next = applyValues(rows, { ParamAngleX: 999, ParamEyeLOpen: -2, ParamUnknown: Number.NaN });
  assert.equal(next[0].value, 30);
  assert.equal(next[1].value, 0);
  assert.equal(next[2].value, 0.5, "NaN 保持原值");
  assert.equal(rows[0].value, 12, "原数组没被改");
});

test("diffFromDefaults 只留变化过的参数", () => {
  const diff = diffFromDefaults(
    { ParamAngleX: 12, ParamEyeLOpen: 1, ParamUnknown: 0.50001 },
    { ParamAngleX: 0, ParamEyeLOpen: 1, ParamUnknown: 0.5 }
  );
  assert.deepEqual(diff, { ParamAngleX: 12 });
});

test("formatValue 按步长裁小数", () => {
  assert.equal(formatValue(0.5, 0.5), "0.5");
  assert.equal(formatValue(12, 0.5), "12");
  assert.equal(formatValue(1.2300001, 0.005), "1.23");
  assert.equal(formatValue(Number.NaN, 0.5), "0");
});
