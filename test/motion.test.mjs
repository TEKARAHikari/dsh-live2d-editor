import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMotion3,
  clampSampled,
  motionParameterIds,
  normalizeKeys,
  parseMotion3,
  sampleTracks,
  tracksFromKeyframes
} from "../src/motion.mjs";

const RANGES = { ParamAngleX: [-30, 30], ParamEyeLOpen: [0, 1] };

test("motion3 的 Segments 布局与 Meta 计数符合官方解析器", () => {
  const motion = buildMotion3({
    fps: 30,
    duration: 2,
    loop: true,
    tracks: [
      { id: "ParamAngleX", keys: [{ time: 0, value: 0 }, { time: 1, value: 15 }, { time: 2, value: 0 }] },
      { id: "ParamEyeLOpen", keys: [{ time: 0, value: 1 }] }
    ]
  });
  assert.equal(motion.Version, 3);
  assert.equal(motion.Meta.CurveCount, 2);
  assert.equal(motion.Meta.Duration, 2);
  assert.equal(motion.Meta.Fps, 30);
  assert.equal(motion.Meta.Loop, true);
  assert.equal(motion.Meta.AreBeziersRestricted, true);
  // ParamAngleX：首点 + 两段线性；ParamEyeLOpen：只有一帧，会被拖到时长末尾
  assert.deepEqual(motion.Curves[0], {
    Target: "Parameter",
    Id: "ParamAngleX",
    Segments: [0, 0, 0, 1, 15, 0, 2, 0]
  });
  assert.deepEqual(motion.Curves[1].Segments, [0, 1, 0, 2, 1]);
  assert.equal(motion.Meta.TotalSegmentCount, 3);
  assert.equal(motion.Meta.TotalPointCount, 5);
  assert.equal(motion.Meta.UserDataCount, 0);
  assert.equal(motion.Meta.TotalUserDataSize, 0);
});

test("关键帧归一化：排序、同时刻后者胜、负数丢弃", () => {
  const keys = normalizeKeys([
    { time: 2, value: 5 },
    { time: 0, value: 1 },
    { time: 2, value: 9 },
    { time: -1, value: 3 },
    { time: Number.NaN, value: 4 }
  ]);
  assert.deepEqual(keys, [{ time: 0, value: 1 }, { time: 2, value: 9 }]);
});

test("build → parse 往返保留关键帧", () => {
  const tracks = [
    { id: "ParamAngleX", keys: [{ time: 0, value: 0 }, { time: 0.5, value: 12.5 }, { time: 1.25, value: -3 }] },
    { id: "ParamEyeLOpen", keys: [{ time: 0, value: 1 }, { time: 1.25, value: 0 }] }
  ];
  const parsed = parseMotion3(JSON.stringify(buildMotion3({ fps: 60, duration: 1.25, loop: false, tracks })));
  assert.equal(parsed.fps, 60);
  assert.equal(parsed.duration, 1.25);
  assert.equal(parsed.loop, false);
  assert.equal(parsed.tracks.length, 2);
  assert.deepEqual(parsed.tracks[0].keys, [
    { time: 0, value: 0 },
    { time: 0.5, value: 12.5 },
    { time: 1.25, value: -3 }
  ]);
});

test("parseMotion3 拒绝坏输入，跳过非 Parameter 曲线", () => {
  assert.equal(parseMotion3("not json"), null);
  assert.equal(parseMotion3(JSON.stringify({ Curves: null })), null);
  const parsed = parseMotion3(JSON.stringify({
    Meta: { Fps: 24 },
    Curves: [
      { Target: "Model", Id: "Opacity", Segments: [0, 1] },
      { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 0, 1, 10] }
    ]
  }));
  assert.equal(parsed.tracks.length, 1);
  assert.equal(parsed.fps, 24);
  assert.deepEqual(parsed.tracks[0].keys, [{ time: 0, value: 0 }, { time: 1, value: 10 }]);
});

test("Bezier 段按折线采样，端点准确", () => {
  const parsed = parseMotion3(JSON.stringify({
    Meta: { Fps: 30, Duration: 1 },
    Curves: [
      { Target: "Parameter", Id: "ParamAngleX", Segments: [0, 0, 1, 0.3, 5, 0.6, 5, 1, 0] }
    ]
  }));
  const keys = parsed.tracks[0].keys;
  assert.equal(keys.length, 9, "首点 + 8 个采样");
  assert.equal(keys[0].time, 0);
  assert.equal(keys[0].value, 0);
  assert.ok(Math.abs(keys[keys.length - 1].time - 1) < 1e-6);
  assert.ok(Math.abs(keys[keys.length - 1].value) < 1e-6);
});

test("Stepped 段在段尾才跳变", () => {
  const parsed = parseMotion3(JSON.stringify({
    Meta: { Fps: 30, Duration: 1 },
    Curves: [
      { Target: "Parameter", Id: "ParamEyeLOpen", Segments: [0, 1, 2, 1, 0] }
    ]
  }));
  const keys = parsed.tracks[0].keys;
  assert.equal(keys[keys.length - 1].value, 0);
  assert.equal(keys[keys.length - 1].time, 1);
  assert.equal(keys[keys.length - 2].value, 1, "跳到 0 之前一直是 1");
  assert.ok(keys[keys.length - 2].time < 1);
});

test("sampleTracks 线性插值并在两端夹住", () => {
  const tracks = [{ id: "ParamAngleX", keys: [{ time: 0, value: 0 }, { time: 1, value: 10 }, { time: 2, value: 0 }] }];
  assert.equal(sampleTracks(tracks, -1).ParamAngleX, 0);
  assert.equal(sampleTracks(tracks, 0.5).ParamAngleX, 5);
  assert.equal(sampleTracks(tracks, 1.5).ParamAngleX, 5);
  assert.equal(sampleTracks(tracks, 99).ParamAngleX, 0);
  assert.equal(sampleTracks([{ id: "A", keys: [{ time: 0.5, value: 3 }] }], 0).A, 3);
  assert.deepEqual(sampleTracks([], 1), {});
});

test("clampSampled 夹到参数范围", () => {
  assert.deepEqual(clampSampled({ ParamAngleX: 99, ParamEyeLOpen: -1 }, RANGES), { ParamAngleX: 30, ParamEyeLOpen: 0 });
  assert.deepEqual(clampSampled({ ParamAngleX: 5 }), { ParamAngleX: 5 });
});

test("多关键帧快照 → 每参数一条曲线，并列出出现过的参数", () => {
  const frames = [
    { time: 0, values: { ParamAngleX: 0 } },
    { time: 1, values: { ParamAngleX: 10, ParamEyeLOpen: 0 } }
  ];
  const tracks = tracksFromKeyframes(frames);
  assert.deepEqual(tracks.map((track) => track.id), ["ParamAngleX", "ParamEyeLOpen"]);
  const motion = buildMotion3({ fps: 30, duration: 1, tracks });
  assert.equal(motion.Meta.CurveCount, 2);
  assert.deepEqual(motionParameterIds(motion), ["ParamAngleX", "ParamEyeLOpen"]);
  assert.deepEqual(tracksFromKeyframes([]), []);
});
