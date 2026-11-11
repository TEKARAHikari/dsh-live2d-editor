/**
 * 动作（.motion3.json）：按 Cubism 官方解析器（CubismWebFramework `cubismmotion.ts`）的实现读写。
 *
 * Curves[i] = { Target: "Parameter", Id, Segments }
 * Segments  = [t0, v0, 类型, ...]  —— 头两个数是第一帧的 (时间, 值)，之后每段：
 *   0 Linear        → x, y
 *   1 Bezier        → cx1, cy1, cx2, cy2, x, y
 *   2 Stepped       → x, y
 *   3 InverseStepped→ x, y
 * Meta.TotalSegmentCount = 曲线段数合计，Meta.TotalPointCount = 关键帧点合计。
 */

export const SEGMENT_LINEAR = 0;
export const SEGMENT_BEZIER = 1;
export const SEGMENT_STEPPED = 2;
export const SEGMENT_INVERSE_STEPPED = 3;

const BEZIER_SAMPLES = 8;

function round4(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

function clampTo(value, range) {
  if (!range) return value;
  return Math.min(Math.max(value, range[0]), range[1]);
}

/** 关键帧归一化：按时间升稳序、同一时刻后写入的为准、数值取四位小数。 */
export function normalizeKeys(keys) {
  const list = [];
  for (const key of keys || []) {
    const time = Number(key.time);
    const value = Number(key.value);
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    if (time < 0) continue;
    list.push({ time: round4(time), value: round4(value) });
  }
  list.sort((a, b) => a.time - b.time || a.value - b.value);
  const out = [];
  for (const key of list) {
    if (out.length > 0 && out[out.length - 1].time === key.time) out[out.length - 1] = key;
    else out.push(key);
  }
  return out;
}

/**
 * 生成 motion3 对象。
 * @param {{fps?: number, duration?: number, loop?: boolean, tracks: Array<{id: string, keys: Array<{time: number, value: number}>}>}} input
 */
export function buildMotion3(input) {
  const fps = Number.isFinite(Number(input.fps)) && Number(input.fps) > 0 ? Number(input.fps) : 30;

  // 先归一化并算出真实时长，再把「只有一帧」的曲线拖到时长末尾——
  // 否则导出的曲线没有段（Segments 只有首点），时长信息也就丢了。
  const prepared = [];
  let lastTime = 0;
  for (const track of input.tracks || []) {
    if (!track || typeof track.id !== "string") continue;
    const keys = normalizeKeys(track.keys);
    if (keys.length === 0) continue;
    lastTime = Math.max(lastTime, keys[keys.length - 1].time);
    prepared.push({ id: track.id, keys });
  }

  const asked = Number(input.duration);
  const duration = Number.isFinite(asked) && asked > 0 ? asked : lastTime;
  for (const track of prepared) {
    const keys = track.keys;
    if (keys.length === 1 && keys[0].time < duration) {
      keys.push({ time: duration, value: keys[0].value });
      lastTime = Math.max(lastTime, duration);
    }
  }

  const curves = [];
  let totalSegmentCount = 0;
  let totalPointCount = 0;

  for (const track of prepared) {
    const keys = track.keys;
    const segments = [keys[0].time, keys[0].value];
    totalPointCount += 1;
    for (let i = 1; i < keys.length; i++) {
      segments.push(SEGMENT_LINEAR, keys[i].time, keys[i].value);
      totalPointCount += 1;
      totalSegmentCount += 1;
    }
    curves.push({ Target: "Parameter", Id: track.id, Segments: segments });
  }

  return {
    Version: 3,
    Meta: {
      Duration: round4(duration > 0 ? duration : 0.01),
      Fps: fps,
      Loop: input.loop !== false,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: totalSegmentCount,
      TotalPointCount: totalPointCount,
      UserDataCount: 0,
      TotalUserDataSize: 0
    },
    Curves: curves
  };
}

/** 多关键帧快照 → 每参数一条曲线。frames: [{time, values: {id: value}}] */
export function tracksFromKeyframes(frames) {
  const byId = new Map();
  for (const frame of frames || []) {
    const time = Number(frame.time);
    if (!Number.isFinite(time) || !frame.values) continue;
    for (const id of Object.keys(frame.values)) {
      const value = Number(frame.values[id]);
      if (!Number.isFinite(value)) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ time, value });
    }
  }
  const tracks = [];
  for (const [id, keys] of byId) tracks.push({ id, keys: normalizeKeys(keys) });
  tracks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tracks;
}

function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * 解析 motion3（字符串或对象）→ {fps, duration, loop, tracks}。
 * Bezier 段按 8 点等距采样展开成折线；坏文件返回 null。
 */
export function parseMotion3(source) {
  let json = source;
  if (typeof source === "string") {
    try {
      json = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!json || !Array.isArray(json.Curves)) return null;
  const meta = json.Meta || {};
  const tracks = [];

  for (const curve of json.Curves) {
    if (!curve || curve.Target !== "Parameter" || typeof curve.Id !== "string") continue;
    const segments = Array.isArray(curve.Segments) ? curve.Segments : [];
    if (segments.length < 2) continue;
    const keys = [{ time: Number(segments[0]), value: Number(segments[1]) }];
    if (!Number.isFinite(keys[0].time) || !Number.isFinite(keys[0].value)) continue;
    let position = 2;
    while (position + 2 < segments.length + 1 && position < segments.length) {
      const type = Number(segments[position]);
      const prev = keys[keys.length - 1];
      if (type === SEGMENT_LINEAR || type === SEGMENT_STEPPED || type === SEGMENT_INVERSE_STEPPED) {
        if (position + 2 >= segments.length) break;
        const x = Number(segments[position + 1]);
        const y = Number(segments[position + 2]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) break;
        if (type === SEGMENT_LINEAR) {
          keys.push({ time: x, value: y });
        } else if (type === SEGMENT_STEPPED) {
          // 保持上一帧的值到段尾才跳变：段尾前一瞬补一个同值点
          const eps = Math.max(1e-4, (x - prev.time) / 1000);
          keys.push({ time: Math.max(prev.time, x - eps), value: prev.value });
          keys.push({ time: x, value: y });
        } else {
          // 反阶跃：进段就跳到新值
          keys[keys.length - 1] = { time: prev.time, value: y };
          keys.push({ time: x, value: y });
        }
        position += 3;
      } else if (type === SEGMENT_BEZIER) {
        if (position + 6 >= segments.length) break;
        const cx1 = Number(segments[position + 1]);
        const cy1 = Number(segments[position + 2]);
        const cx2 = Number(segments[position + 3]);
        const cy2 = Number(segments[position + 4]);
        const x = Number(segments[position + 5]);
        const y = Number(segments[position + 6]);
        for (let i = 1; i <= BEZIER_SAMPLES; i++) {
          const t = i / BEZIER_SAMPLES;
          keys.push({
            time: bezierPoint(prev.time, cx1, cx2, x, t),
            value: bezierPoint(prev.value, cy1, cy2, y, t)
          });
        }
        position += 7;
      } else {
        break;
      }
    }
    tracks.push({ id: curve.Id, keys: normalizeKeys(keys) });
  }

  return {
    fps: Number.isFinite(Number(meta.Fps)) && Number(meta.Fps) > 0 ? Number(meta.Fps) : 30,
    duration: Number.isFinite(Number(meta.Duration)) ? Number(meta.Duration) : 0,
    loop: meta.Loop !== false,
    tracks
  };
}

/** 在 time 处线性采样，返回 {id: value}。时间在首帧前取首帧，末帧后取末帧。 */
export function sampleTracks(tracks, time) {
  const out = {};
  for (const track of tracks || []) {
    const keys = track.keys;
    if (!keys || keys.length === 0) continue;
    if (keys.length === 1 || time <= keys[0].time) {
      out[track.id] = keys[0].value;
      continue;
    }
    const last = keys[keys.length - 1];
    if (time >= last.time) {
      out[track.id] = last.value;
      continue;
    }
    let low = 0;
    let high = keys.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (keys[mid].time <= time) low = mid;
      else high = mid;
    }
    const a = keys[low];
    const b = keys[high];
    const span = b.time - a.time;
    const ratio = span === 0 ? 0 : (time - a.time) / span;
    out[track.id] = a.value + (b.value - a.value) * ratio;
  }
  return out;
}

/** 采样结果夹到参数范围里（播放时用）。 */
export function clampSampled(values, ranges) {
  const out = {};
  for (const id of Object.keys(values)) out[id] = clampTo(values[id], ranges ? ranges[id] : undefined);
  return out;
}

/** 动作里出现过哪些参数 id。既接受解析后的 {tracks}，也接受 motion3 对象 {Curves}。 */
export function motionParameterIds(motion) {
  if (!motion) return [];
  if (Array.isArray(motion.tracks)) return motion.tracks.map((track) => track.id);
  if (Array.isArray(motion.Curves)) return motion.Curves.map((curve) => curve.Id).filter((id) => typeof id === "string");
  return [];
}
