import assert from "node:assert/strict";
import test from "node:test";
import {
  BLEND_ADD,
  BLEND_MULTIPLY,
  BLEND_OVERWRITE,
  buildExpression,
  parseExpression,
  resolveExpression
} from "../src/expression.mjs";

const DEFAULTS = { ParamAngleX: 0, ParamEyeLOpen: 1, ParamBrowLY: 0, ParamMouthOpenY: 0 };
const RANGES = {
  ParamAngleX: [-30, 30],
  ParamEyeLOpen: [0, 1],
  ParamBrowLY: [-1, 1],
  ParamMouthOpenY: [0, 1]
};

test("加算表情记录的是相对默认值的偏移", () => {
  const expression = buildExpression({
    name: "眨眼",
    values: { ParamAngleX: 12, ParamEyeLOpen: 0.2, ParamBrowLY: 0 },
    defaults: DEFAULTS,
    ranges: RANGES,
    blend: BLEND_ADD
  });
  assert.equal(expression.Type, "Live2D Expression");
  assert.equal(expression.Parameters.length, 2, "没有变化的 ParamBrowLY 不写进去");
  const byId = Object.fromEntries(expression.Parameters.map((item) => [item.Id, item]));
  assert.deepEqual(byId.ParamAngleX, { Id: "ParamAngleX", Value: 12, Blend: BLEND_ADD });
  assert.equal(byId.ParamEyeLOpen.Value, -0.8);
});

test("覆盖表情写绝对值，乘算表情写倍率", () => {
  const overwrite = buildExpression({
    values: { ParamAngleX: 12, ParamEyeLOpen: 0.2 },
    defaults: DEFAULTS, ranges: RANGES, blend: BLEND_OVERWRITE, name: "pose"
  });
  assert.deepEqual(overwrite.Parameters.find((item) => item.Id === "ParamEyeLOpen"), { Id: "ParamEyeLOpen", Value: 0.2, Blend: BLEND_OVERWRITE });

  const multiply = buildExpression({
    values: { ParamEyeLOpen: 0.5 },
    defaults: DEFAULTS, ranges: RANGES, blend: BLEND_MULTIPLY, name: "半闭"
  });
  assert.deepEqual(multiply.Parameters[0], { Id: "ParamEyeLOpen", Value: 0.5, Blend: BLEND_MULTIPLY });
});

test("表情的根字段与默认淡入淡出", () => {
  const expression = buildExpression({ values: { ParamAngleX: 5 }, defaults: DEFAULTS, ranges: RANGES });
  assert.equal(expression.FadeInTime, 0.5);
  assert.equal(expression.FadeOutTime, 0.5);
  assert.equal(expression.Type, "Live2D Expression");
  const faded = buildExpression({ values: { ParamAngleX: 5 }, defaults: DEFAULTS, fadeIn: 0.2, fadeOut: 0.3 });
  assert.equal(faded.FadeInTime, 0.2);
  assert.equal(faded.FadeOutTime, 0.3);
});

test("解析 exp3：正常 / 缺 Type / 坏 JSON / 空参数", () => {
  const text = JSON.stringify({
    Type: "Live2D Expression",
    FadeInTime: 1,
    FadeOutTime: 2,
    Parameters: [
      { Id: "ParamEyeLOpen", Value: -1, Blend: "Add" },
      { Id: "ParamAngleX", Value: 10, Blend: "Overwrite" },
      { Id: "ParamBroken", Value: "x" }
    ]
  });
  const parsed = parseExpression(text);
  assert.equal(parsed.parameters.length, 2);
  assert.equal(parsed.fadeIn, 1);
  assert.equal(parsed.fadeOut, 2);
  assert.deepEqual(parsed.parameters[1], { id: "ParamAngleX", value: 10, blend: BLEND_OVERWRITE });

  assert.equal(parseExpression("{oops"), null);
  assert.equal(parseExpression(JSON.stringify({ Type: "Other", Parameters: [{ Id: "a", Value: 1 }] })), null);
  assert.equal(parseExpression(JSON.stringify({ Type: "Live2D Expression", Parameters: [] })), null);
});

test("build → resolve 能还原绝对姿态（加算/覆盖/乘算）", () => {
  const values = { ParamAngleX: 12, ParamEyeLOpen: 0.25, ParamMouthOpenY: 0.6 };
  for (const blend of [BLEND_ADD, BLEND_OVERWRITE, BLEND_MULTIPLY]) {
    const expression = buildExpression({ values, defaults: DEFAULTS, ranges: RANGES, blend });
    const resolved = resolveExpression(
      {
        parameters: expression.Parameters.map((item) => ({ id: item.Id, value: item.Value, blend: item.Blend }))
      },
      DEFAULTS,
      RANGES
    );
    for (const id of Object.keys(resolved)) {
      assert.ok(Math.abs(resolved[id] - values[id]) < 1e-3, `${blend} ${id}: ${resolved[id]} != ${values[id]}`);
    }
  }
});

test("resolveExpression 把结果夹在参数范围里", () => {
  const resolved = resolveExpression(
    {
      parameters: [
        { id: "ParamEyeLOpen", value: -5, blend: BLEND_ADD },
        { id: "ParamAngleX", value: 100, blend: BLEND_OVERWRITE }
      ]
    },
    DEFAULTS,
    RANGES
  );
  assert.equal(resolved.ParamEyeLOpen, 0);
  assert.equal(resolved.ParamAngleX, 30);
  assert.deepEqual(resolveExpression(null, DEFAULTS, RANGES), {});
});
