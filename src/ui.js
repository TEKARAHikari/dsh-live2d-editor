// dsh-live2d-editor — 浏览器半边（React 组件 + 面板逻辑）。
//
// 依赖注入面（由 scripts/build-client.mjs 在同一作用域里提供）：
//   React / h                 —— 宿主模块表里的 react
//   CORE_SRC                  —— Live2D Cubism Core 源码字符串（间接 eval 载入）
//   MODEL_MANIFEST            —— 内置模型（lib 里打包进来的 moc3 + 图集 + cdi3）
//   createLive2DViewport      —— src/viewport.js
//   buildParameterRows 等纯函数 —— src/params.mjs / expression.mjs / motion.mjs / manifest.mjs

var NS = "dsh-live2d-editor";
var STYLE_ID = NS + "-style";
var STORE_KEY = NS + "/v1";
var BLENDS = [
  { value: "Add", label: "加算" },
  { value: "Multiply", label: "乘算" },
  { value: "Overwrite", label: "覆盖" }
];

function coreReady(core) {
  // emscripten 的 wasm 是异步就绪的：eval 完那一拍里 ccall 还没有 _em，
  // 直接调 Moc.fromArrayBuffer 会报 "reading 'apply'"。用一次无副作用的
  // 版本查询来判定「运行时起来了没有」。
  try {
    core.Version.csmGetVersion();
    return true;
  } catch (error) {
    return false;
  }
}

function ensureCore() {
  if (typeof window !== "undefined" && window.Live2DCubismCore) return window.Live2DCubismCore;
  // 只能间接 eval：<script> 注入会让 Core 半初始化，间接 eval 在全局作用域执行。
  (0, eval)(CORE_SRC);
  if (!window.Live2DCubismCore) throw new Error("Cubism Core 载入失败");
  return window.Live2DCubismCore;
}

function readStore(key) {
  try {
    var raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    /* 存储满了也不能抛 */
  }
}

function downloadText(name, text) {
  var blob = new Blob([text], { type: "application/json;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  setTimeout(function () {
    URL.revokeObjectURL(url);
    if (link.parentNode) link.parentNode.removeChild(link);
  }, 1000);
}

function downloadDataUrl(name, dataUrl) {
  var link = document.createElement("a");
  link.href = dataUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  setTimeout(function () {
    if (link.parentNode) link.parentNode.removeChild(link);
  }, 1000);
}

function fileToText(file) {
  return file.text ? file.text() : new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result)); };
    reader.onerror = function () { reject(new Error("读取失败：" + file.name)); };
    reader.readAsText(file);
  });
}

function fileToDataUrl(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result)); };
    reader.onerror = function () { reject(new Error("读取失败：" + file.name)); };
    reader.readAsDataURL(file);
  });
}

function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var bytes = new Uint8Array(reader.result);
      var chunk = 0x8000;
      var parts = [];
      for (var i = 0; i < bytes.length; i += chunk) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
      }
      resolve(btoa(parts.join("")));
    };
    reader.onerror = function () { reject(new Error("读取失败：" + file.name)); };
    reader.readAsArrayBuffer(file);
  });
}

function stamp() {
  var now = new Date();
  var pad = function (value) { return String(value).padStart(2, "0"); };
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" + pad(now.getHours()) + pad(now.getMinutes());
}

function safeFileName(text) {
  return String(text || "model").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "model";
}

/** 从若干 File 里凑出一个 manifest；找不到必需文件就抛带中文说明的错误。 */
async function manifestFromFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []);
  if (files.length === 0) throw new Error("没有选择文件");
  var byName = {};
  for (var i = 0; i < files.length; i++) byName[files[i].name] = files[i];

  var model3File = null;
  for (var j = 0; j < files.length; j++) {
    if (/\.model3\.json$/i.test(files[j].name)) { model3File = files[j]; break; }
  }
  if (!model3File) throw new Error("请选中 .model3.json（moc3 与图集一起选上更省事）");

  var model3 = JSON.parse(await fileToText(model3File));
  var refs = normalizeModel3(model3);
  var mocFile = byName[referenceName(refs.moc)];
  if (!mocFile) {
    for (var k = 0; k < files.length; k++) if (/\.moc3$/i.test(files[k].name)) { mocFile = files[k]; break; }
  }
  if (!mocFile) throw new Error("缺少 moc3：" + refs.moc);

  var textures = [];
  for (var t = 0; t < refs.textures.length; t++) {
    var ref = refs.textures[t];
    var file = byName[referenceName(ref)];
    if (!file && t === 0) {
      for (var u = 0; u < files.length; u++) if (/\.(png|webp|jpg|jpeg)$/i.test(files[u].name)) { file = files[u]; break; }
    }
    if (!file) throw new Error("缺少图集：" + ref);
    textures.push(await fileToDataUrl(file));
  }
  var cdi3 = null;
  if (refs.displayInfo) {
    var cdi3File = byName[referenceName(refs.displayInfo)];
    if (cdi3File) cdi3 = JSON.parse(await fileToText(cdi3File));
  }
  return createManifest({
    model3: model3,
    moc3: await fileToBase64(mocFile),
    textures: textures,
    cdi3: cdi3,
    name: referenceName(refs.moc).replace(/\.moc3$/i, "")
  });
}

function uniqueFrameTimes(tracks) {
  var seen = {};
  var times = [];
  for (var i = 0; i < tracks.length; i++) {
    var keys = tracks[i].keys;
    for (var j = 0; j < keys.length; j++) {
      var time = Math.round(keys[j].time * 1000) / 1000;
      if (seen[time]) continue;
      seen[time] = true;
      times.push(time);
    }
  }
  times.sort(function (a, b) { return a - b; });
  return times;
}

function framesFromTracks(tracks) {
  return uniqueFrameTimes(tracks).map(function (time) {
    return { time: time, values: sampleTracks(tracks, time) };
  });
}

function clampTime(time, duration) {
  if (!Number.isFinite(time)) return 0;
  return Math.min(Math.max(time, 0), Math.max(0, duration));
}

function Live2DEditor() {
  var useState = React.useState;
  var useRef = React.useRef;
  var useEffect = React.useEffect;
  var useMemo = React.useMemo;

  var openState = useState(false);
  var open = openState[0];
  var setOpen = openState[1];

  var statusState = useState("模型加载中…");
  var status = statusState[0];
  var setStatus = statusState[1];

  var errorState = useState("");
  var error = errorState[0];
  var setError = errorState[1];

  var manifestState = useState(MODEL_MANIFEST && MODEL_MANIFEST.moc3 ? MODEL_MANIFEST : null);
  var manifest = manifestState[0];
  var setManifest = manifestState[1];

  var rowsState = useState([]);
  var rows = rowsState[0];
  var setRows = rowsState[1];

  var partsState = useState([]);
  var parts = partsState[0];
  var setParts = partsState[1];

  var infoState = useState(null);
  var info = infoState[0];
  var setInfo = infoState[1];

  var queryState = useState("");
  var query = queryState[0];
  var setQuery = queryState[1];

  var tabState = useState("params");
  var tab = tabState[0];
  var setTab = tabState[1];

  var wireState = useState(false);
  var wire = wireState[0];
  var setWire = wireState[1];

  var zoomState = useState(100);
  var zoom = zoomState[0];
  var setZoom = zoomState[1];

  var exprState = useState([]);
  var exprList = exprState[0];
  var setExprList = exprState[1];

  var exprNameState = useState("新表情");
  var exprName = exprNameState[0];
  var setExprName = exprNameState[1];

  var blendState = useState("Add");
  var blend = blendState[0];
  var setBlend = blendState[1];

  var framesState = useState([]);
  var frames = framesState[0];
  var setFrames = framesState[1];

  var fpsState = useState(30);
  var fps = fpsState[0];
  var setFps = fpsState[1];

  var durationState = useState(3);
  var duration = durationState[0];
  var setDuration = durationState[1];

  var loopState = useState(true);
  var loop = loopState[0];
  var setLoop = loopState[1];

  var playingState = useState(false);
  var playing = playingState[0];
  var setPlaying = playingState[1];

  var timeState = useState(0);
  var time = timeState[0];
  var setTime = timeState[1];

  var noticeState = useState("");
  var notice = noticeState[0];
  var setNotice = noticeState[1];

  var canvasRef = useRef(null);
  var viewRef = useRef(null);
  var dirtyRef = useRef(true);
  var rowsRef = useRef([]);
  var dragRef = useRef(null);
  var wireRef = useRef(false);
  var zoomRef = useRef(1);
  var modelInputRef = useRef(null);
  var exprInputRef = useRef(null);
  var motionInputRef = useRef(null);

  var playRef = useRef({ playing: false, time: 0, frames: [], fps: 30, duration: 3, loop: true });

  var tracksRef = useRef([]);
  var rangesRef = useRef({});

  rowsRef.current = rows;
  playRef.current.playing = playing;
  playRef.current.frames = frames;
  playRef.current.fps = fps;
  playRef.current.duration = duration;
  playRef.current.loop = loop;

  var defaults = useMemo(function () { return defaultValueMap(rows); }, [rows]);
  var ranges = useMemo(function () { return rangeMap(rows); }, [rows]);
  var tracks = useMemo(function () { return tracksFromKeyframes(frames); }, [frames]);
  tracksRef.current = tracks;
  rangesRef.current = ranges;

  // ── 打开面板：载入模型（Core 的 wasm 异步就绪，所以轮询到能用为止）─────
  useEffect(function () {
    if (!open || !manifest) return undefined;
    var cancelled = false;
    var view = null;
    var attempts = 0;

    var start = function () {
      if (cancelled) return;
      try {
        var core = ensureCore();
        if (!coreReady(core)) {
          attempts++;
          if (attempts > 200) throw new Error("Cubism Core 一直没有初始化");
          window.setTimeout(start, 25);
          return;
        }
        if (!canvasRef.current) return;
        view = createLive2DViewport(canvasRef.current, manifest, {
          core: core,
          onTextureReady: function () { dirtyRef.current = true; }
        });
        viewRef.current = view;
        setRows(buildParameterRows(view.model.parameters, manifest.cdi3));
        setParts(buildPartRows(view.model.parts, manifest.cdi3));
        setInfo({
          name: manifest.name,
          drawables: view.drawableCount,
          textures: view.textureCount,
          masks: view.warnMasks()
        });
        view.setWireframe(wireRef.current);
        view.setZoom(zoomRef.current || 1);
        dirtyRef.current = true;
        setStatus(describeAssets(manifest));
        setError("");
      } catch (failure) {
        setError(String((failure && failure.message) || failure));
      }
    };
    start();

    return function () {
      cancelled = true;
      viewRef.current = null;
      if (view) view.dispose();
    };
  }, [open, manifest]);

  // ── 每个模型的本地存储（表情 + 动作） ──────────────────────────────────
  useEffect(function () {
    if (!open || !manifest) return;
    var saved = readStore(STORE_KEY + "/" + manifest.name);
    setExprList(saved && Array.isArray(saved.expressions) ? saved.expressions : []);
    if (saved && Array.isArray(saved.frames)) setFrames(saved.frames);
    else setFrames([]);
    if (saved && Number.isFinite(saved.fps)) setFps(saved.fps);
    if (saved && Number.isFinite(saved.duration)) setDuration(saved.duration);
    if (saved && typeof saved.loop === "boolean") setLoop(saved.loop);
  }, [open, manifest]);

  useEffect(function () {
    if (!open || !manifest) return;
    writeStore(STORE_KEY + "/" + manifest.name, {
      expressions: exprList,
      frames: frames,
      fps: fps,
      duration: duration,
      loop: loop
    });
  }, [open, manifest, exprList, frames, fps, duration, loop]);

  // ── 帧循环：渲染 + 播放 ─────────────────────────────────────────────────
  useEffect(function () {
    if (!open) return undefined;
    var stopped = false;
    var lastPaint = 0;
    var handle = 0;

    var step = function (now) {
      if (stopped) return;
      var view = viewRef.current;
      var state = playRef.current;
      if (view) {
        if (state.playing) {
          var dt = lastPaint ? (now - lastPaint) / 1000 : 0;
          lastPaint = now;
          var total = Math.max(0.01, state.duration);
          var next = state.time + dt;
          if (next > total) next = state.loop ? next % total : total;
          state.time = next;
          var sampled = clampSampled(sampleTracks(tracksRef.current, next), rangesRef.current);
          var ids = Object.keys(sampled);
          for (var i = 0; i < ids.length; i++) view.setParam(ids[i], sampled[ids[i]]);
          dirtyRef.current = true;
          if (now - (state.lastPush || 0) > 100) {
            state.lastPush = now;
            setTime(next);
            setRows(function (previous) { return applyValues(previous, sampled); });
            if (!state.loop && next >= total) {
              state.playing = false;
              setPlaying(false);
            }
          }
        } else {
          lastPaint = 0;
        }
        if (dirtyRef.current) {
          view.render();
          dirtyRef.current = false;
        }
      }
      handle = window.requestAnimationFrame(step);
    };
    handle = window.requestAnimationFrame(step);
    return function () {
      stopped = true;
      window.cancelAnimationFrame(handle);
    };
  }, [open]);

  var tracksRef = useRef([]);
  var rangesRef = useRef({});
  tracksRef.current = tracks;
  rangesRef.current = ranges;

  // ── 视口尺寸变化 ────────────────────────────────────────────────────────
  useEffect(function () {
    if (!open || typeof ResizeObserver === "undefined") return undefined;
    var node = canvasRef.current;
    if (!node) return undefined;
    var observer = new ResizeObserver(function () { dirtyRef.current = true; });
    observer.observe(node);
    return function () { observer.disconnect(); };
  }, [open, manifest]);

  useEffect(function () {
    wireRef.current = wire;
    var view = viewRef.current;
    if (view) {
      view.setWireframe(wire);
      dirtyRef.current = true;
    }
  }, [wire]);

  // 滚轮缩放：React 的 onWheel 是 passive，preventDefault 会被忽略，所以挂原生监听
  useEffect(function () {
    if (!open) return undefined;
    var node = canvasRef.current;
    if (!node) return undefined;
    var handler = function (event) {
      event.preventDefault();
      var view = viewRef.current;
      if (!view) return;
      var factor = event.deltaY > 0 ? 0.9 : 1.1;
      view.setZoom(view.getView().zoom * factor);
      zoomRef.current = view.getView().zoom;
      setZoom(Math.round(zoomRef.current * 100));
      dirtyRef.current = true;
    };
    node.addEventListener("wheel", handler, { passive: false });
    return function () { node.removeEventListener("wheel", handler); };
  }, [open, manifest]);

  useEffect(function () {
    if (!open) return undefined;
    var onKey = function (event) {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return function () { window.removeEventListener("keydown", onKey); };
  }, [open]);

  // ── 参数 / 部件操作 ─────────────────────────────────────────────────────
  function setParameter(id, value) {
    var view = viewRef.current;
    if (view) view.setParam(id, value);
    setRows(function (previous) { return applyValues(previous, { [id]: value }); });
    dirtyRef.current = true;
  }

  function resetParameter(id) {
    var view = viewRef.current;
    var row = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) row = rows[i];
    if (!row) return;
    if (view) view.setParam(id, row.default);
    setRows(function (previous) { return applyValues(previous, { [id]: row.default }); });
    dirtyRef.current = true;
  }

  function resetAll() {
    var view = viewRef.current;
    var next = resetRows(rows);
    if (view) for (var i = 0; i < next.length; i++) view.setParam(next[i].id, next[i].default);
    setRows(next);
    setNotice("已全部复位");
    dirtyRef.current = true;
  }

  function setPart(id, opacity) {
    var view = viewRef.current;
    if (view) view.setPartOpacity(id, opacity);
    setParts(function (previous) {
      return previous.map(function (row) { return row.id === id ? { ...row, opacity: opacity } : row; });
    });
    dirtyRef.current = true;
  }

  // ── 表情 ────────────────────────────────────────────────────────────────
  function captureExpression() {
    var values = snapshotValues(rows);
    var expression = buildExpression({
      name: exprName,
      values: values,
      defaults: defaults,
      ranges: ranges,
      blend: blend,
      fadeIn: 0.5,
      fadeOut: 0.5
    });
    if (expression.Parameters.length === 0) {
      setNotice("当前姿态和默认值一样，没有可记录的变化");
      return;
    }
    setExprList(function (previous) {
      return previous.concat([{ name: exprName || "表情", blend: blend, json: expression, when: stamp() }]);
    });
    setNotice("已记录表情「" + (exprName || "表情") + "」，共 " + expression.Parameters.length + " 个参数");
  }

  function applyExpression(item) {
    var resolved = resolveExpression({ parameters: item.json.Parameters.map(function (parameter) {
      return { id: parameter.Id, value: parameter.Value, blend: parameter.Blend };
    }) }, defaults, ranges);
    var view = viewRef.current;
    var ids = Object.keys(resolved);
    for (var i = 0; i < ids.length; i++) if (view) view.setParam(ids[i], resolved[ids[i]]);
    setRows(function (previous) { return applyValues(previous, resolved); });
    setNotice("已应用表情「" + item.name + "」");
    dirtyRef.current = true;
  }

  function exportExpression(item) {
    downloadText(safeFileName(item.name) + "-" + item.when + ".exp3.json", JSON.stringify(item.json, null, 1));
    setNotice("已导出 " + item.name + ".exp3.json");
  }

  function removeExpression(index) {
    setExprList(function (previous) { return previous.filter(function (_, i) { return i !== index; }); });
  }

  async function importExpressionFile(files) {
    var file = (files || [])[0];
    if (!file) return;
    try {
      var parsed = parseExpression(await fileToText(file));
      if (!parsed) throw new Error("不是可用的 exp3.json");
      var expression = {
        Type: "Live2D Expression",
        FadeInTime: parsed.fadeIn,
        FadeOutTime: parsed.fadeOut,
        Parameters: parsed.parameters.map(function (parameter) {
          return { Id: parameter.id, Value: parameter.value, Blend: parameter.blend };
        })
      };
      var name = (file.name || "导入表情").replace(/\.exp3\.json$/i, "");
      setExprList(function (previous) { return previous.concat([{ name: name, blend: parsed.parameters[0].blend, json: expression, when: stamp() }]); });
      setNotice("已导入表情「" + name + "」");
    } catch (failure) {
      setError(String((failure && failure.message) || failure));
    }
  }

  // ── 动作 ────────────────────────────────────────────────────────────────
  function addKeyframe() {
    var values = snapshotValues(rows);
    var at = Math.round(clampTime(time, duration) * 100) / 100;
    setFrames(function (previous) {
      var kept = previous.filter(function (frame) { return Math.abs(frame.time - at) > 1e-6; });
      kept.push({ time: at, values: values });
      kept.sort(function (a, b) { return a.time - b.time; });
      return kept;
    });
    setNotice("已在 " + at.toFixed(2) + "s 打关键帧");
  }

  function removeLastKeyframe() {
    setFrames(function (previous) {
      if (previous.length === 0) return previous;
      return previous.slice(0, previous.length - 1);
    });
  }

  function clearFrames() {
    setFrames([]);
    setTime(0);
    playRef.current.time = 0;
    setNotice("已清空关键帧");
  }

  function scrubTo(value) {
    var at = clampTime(Number(value), duration);
    playRef.current.time = at;
    setTime(at);
    var sampled = clampSampled(sampleTracks(tracks, at), ranges);
    var view = viewRef.current;
    var ids = Object.keys(sampled);
    for (var i = 0; i < ids.length; i++) if (view) view.setParam(ids[i], sampled[ids[i]]);
    setRows(function (previous) { return applyValues(previous, sampled); });
    dirtyRef.current = true;
  }

  function togglePlay() {
    if (!playing) {
      playRef.current.time = 0;
      setTime(0);
      playRef.current.lastPush = 0;
    }
    playRef.current.playing = !playing;
    setPlaying(!playing);
  }

  function exportMotion() {
    if (frames.length === 0) {
      setNotice("还没有关键帧，先在时间轴上打一帧");
      return;
    }
    var motion = buildMotion3({ fps: fps, duration: duration, loop: loop, tracks: tracksFromKeyframes(frames) });
    downloadText(safeFileName(manifest ? manifest.name : "model") + "-" + stamp() + ".motion3.json", JSON.stringify(motion, null, 1));
    setNotice("已导出 motion3（" + motion.Meta.CurveCount + " 条曲线 / " + motion.Meta.TotalPointCount + " 个关键点）");
  }

  async function importMotionFile(files) {
    var file = (files || [])[0];
    if (!file) return;
    try {
      var parsed = parseMotion3(await fileToText(file));
      if (!parsed || parsed.tracks.length === 0) throw new Error("不是可用的 motion3.json");
      var imported = framesFromTracks(parsed.tracks);
      setFrames(imported);
      setFps(parsed.fps);
      setDuration(parsed.duration > 0 ? parsed.duration : imported[imported.length - 1].time);
      setLoop(parsed.loop);
      setTime(0);
      playRef.current.time = 0;
      setNotice("已导入动作：" + parsed.tracks.length + " 条曲线（Bezier 段已采样成折线）");
    } catch (failure) {
      setError(String((failure && failure.message) || failure));
    }
  }

  // ── 模型导入 / 截图 ─────────────────────────────────────────────────────
  async function importModel(files) {
    try {
      setStatus("正在读取模型…");
      var next = await manifestFromFiles(files);
      setManifest(next);
      setError("");
    } catch (failure) {
      setError(String((failure && failure.message) || failure));
      setStatus(manifest ? describeAssets(manifest) : "没有模型");
    }
  }

  function snapshot() {
    var view = viewRef.current;
    if (!view) return;
    downloadDataUrl(safeFileName(manifest ? manifest.name : "model") + "-" + stamp() + ".png", view.snapshot());
    setNotice("已保存截图");
  }

  function resetView() {
    var view = viewRef.current;
    if (!view) return;
    view.resetView();
    zoomRef.current = 1;
    setZoom(100);
    dirtyRef.current = true;
  }

  // ── 指针交互 ────────────────────────────────────────────────────────────
  function onPointerDown(event) {
    var view = viewRef.current;
    if (!view) return;
    dragRef.current = { x: event.clientX, y: event.clientY, panX: view.getView().panX, panY: view.getView().panY };
    if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    var drag = dragRef.current;
    var view = viewRef.current;
    if (!drag || !view) return;
    var dx = (event.clientX - drag.x) * 2 / Math.max(1, event.currentTarget.clientWidth);
    var dy = -(event.clientY - drag.y) * 2 / Math.max(1, event.currentTarget.clientHeight);
    view.setPan(drag.panX + dx, drag.panY + dy);
    dirtyRef.current = true;
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  // ── 过滤后的列表 ────────────────────────────────────────────────────────
  var visibleRows = useMemo(function () {
    var text = query.trim().toLowerCase();
    if (!text) return rows;
    return rows.filter(function (row) {
      return row.id.toLowerCase().indexOf(text) >= 0 || row.name.toLowerCase().indexOf(text) >= 0;
    });
  }, [rows, query]);

  // ── 渲染 ────────────────────────────────────────────────────────────────
  if (!open) {
    return h("button", {
      type: "button",
      className: "l2de-launch",
      title: "打开 Live2D 编辑器",
      onClick: function () { setOpen(true); }
    }, "L2D");
  }

  var parameterPanel = h("div", { className: "l2de-col l2de-left" },
    h("div", { className: "l2de-search" },
      h("input", {
        type: "search",
        placeholder: "搜索参数 / 部件 ID",
        value: query,
        onChange: function (event) { setQuery(event.target.value); }
      })
    ),
    h("div", { className: "l2de-tabs" },
      h("button", {
        type: "button",
        "data-on": tab === "params" ? "true" : "false",
        onClick: function () { setTab("params"); }
      }, "参数 " + rows.length),
      h("button", {
        type: "button",
        "data-on": tab === "parts" ? "true" : "false",
        onClick: function () { setTab("parts"); }
      }, "部件 " + parts.length),
      h("button", {
        type: "button",
        className: "l2de-reset-all",
        onClick: resetAll,
        title: "全部参数回到默认值"
      }, "复位")
    ),
    tab === "params"
      ? h("div", { className: "l2de-list" }, visibleRows.map(function (row) {
          return h("div", { className: "l2de-row", key: row.id },
            h("div", { className: "l2de-row-head", title: row.id },
              h("span", { className: "l2de-row-name" }, row.name),
              h("span", { className: "l2de-row-id" }, row.id)
            ),
            h("div", { className: "l2de-row-body" },
              h("input", {
                type: "range",
                min: row.min,
                max: row.max,
                step: row.step,
                value: row.value,
                onChange: function (event) { setParameter(row.id, Number(event.target.value)); }
              }),
              h("input", {
                type: "number",
                className: "l2de-number",
                min: row.min,
                max: row.max,
                step: row.step,
                value: Math.round(row.value * 1000) / 1000,
                onChange: function (event) { setParameter(row.id, Number(event.target.value)); }
              }),
              h("button", {
                type: "button",
                className: "l2de-mini",
                title: "回到默认值 " + row.default,
                onClick: function () { resetParameter(row.id); }
              }, "⏮")
            )
          );
        }))
      : h("div", { className: "l2de-list" }, parts.length === 0
          ? h("p", { className: "l2de-empty" }, "这个模型没有部件（Parts）")
          : parts.map(function (row) {
              return h("div", { className: "l2de-row", key: row.id },
                h("div", { className: "l2de-row-head", title: row.id },
                  h("span", { className: "l2de-row-name" }, row.name),
                  h("span", { className: "l2de-row-id" }, row.id)
                ),
                h("div", { className: "l2de-row-body" },
                  h("input", {
                    type: "range", min: 0, max: 1, step: 0.01, value: row.opacity,
                    onChange: function (event) { setPart(row.id, Number(event.target.value)); }
                  }),
                  h("span", { className: "l2de-opacity" }, Math.round(row.opacity * 100) + "%")
                )
              );
            }))
  );

  var stage = h("div", { className: "l2de-col l2de-center" },
    h("div", { className: "l2de-stage" },
      h("canvas", {
        ref: canvasRef,
        className: "l2de-canvas",
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: onPointerUp,
        onPointerCancel: onPointerUp,
        onDoubleClick: resetView
      })
    ),
    h("div", { className: "l2de-stagebar" },
      h("span", null, info ? info.drawables + " 个绘制对象 · " + info.textures + " 张图集" : "—"),
      h("span", null, "缩放 " + zoom + "%"),
      h("button", { type: "button", className: "l2de-mini", onClick: resetView }, "复位视角"),
      h("button", {
        type: "button", className: "l2de-mini",
        "data-on": wire ? "true" : "false",
        onClick: function () { setWire(!wire); }
      }, "线框"),
      h("button", { type: "button", className: "l2de-mini", onClick: snapshot }, "截图")
    )
  );

  var right = h("div", { className: "l2de-col l2de-right" },
    h("section", { className: "l2de-card" },
      h("header", null, "表情", h("span", { className: "l2de-hint" }, "exp3.json")),
      h("div", { className: "l2de-inline" },
        h("input", {
          type: "text", value: exprName,
          onChange: function (event) { setExprName(event.target.value); },
          placeholder: "表情名"
        }),
        h("select", { value: blend, onChange: function (event) { setBlend(event.target.value); } },
          BLENDS.map(function (item) { return h("option", { key: item.value, value: item.value }, item.label); })
        )
      ),
      h("div", { className: "l2de-inline" },
        h("button", { type: "button", onClick: captureExpression }, "记录当前姿态"),
        h("button", { type: "button", onClick: function () { exprInputRef.current && exprInputRef.current.click(); } }, "导入")
      ),
      h("div", { className: "l2de-chips" }, exprList.length === 0
        ? h("span", { className: "l2de-empty" }, "还没有表情")
        : exprList.map(function (item, index) {
            return h("span", { className: "l2de-chip", key: item.name + "-" + index },
              h("button", { type: "button", className: "l2de-chip-main", onClick: function () { applyExpression(item); } }, item.name),
              h("button", { type: "button", className: "l2de-chip-act", title: "导出 exp3", onClick: function () { exportExpression(item); } }, "↓"),
              h("button", { type: "button", className: "l2de-chip-act", title: "删除", onClick: function () { removeExpression(index); } }, "×")
            );
          }))
    ),
    h("section", { className: "l2de-card" },
      h("header", null, "动作", h("span", { className: "l2de-hint" }, "motion3.json")),
      h("div", { className: "l2de-inline" },
        h("label", null, "FPS", h("input", {
          type: "number", min: 1, max: 120, value: fps,
          onChange: function (event) { setFps(Math.max(1, Math.min(120, Number(event.target.value) || 30))); }
        })),
        h("label", null, "时长", h("input", {
          type: "number", min: 0.1, max: 120, step: 0.1, value: duration,
          onChange: function (event) { setDuration(Math.max(0.1, Number(event.target.value) || 3)); }
        })),
        h("label", { className: "l2de-check" }, h("input", {
          type: "checkbox", checked: loop,
          onChange: function (event) { setLoop(event.target.checked); }
        }), "循环")
      ),
      h("div", { className: "l2de-timeline" },
        h("input", {
          type: "range", min: 0, max: duration, step: 0.01, value: time,
          onChange: function (event) { scrubTo(event.target.value); }
        }),
        h("span", { className: "l2de-time" }, time.toFixed(2) + "s")
      ),
      h("div", { className: "l2de-inline" },
        h("button", { type: "button", onClick: togglePlay }, playing ? "暂停" : "播放"),
        h("button", { type: "button", onClick: addKeyframe }, "打关键帧"),
        h("button", { type: "button", onClick: removeLastKeyframe }, "删末帧"),
        h("button", { type: "button", onClick: clearFrames }, "清空")
      ),
      h("div", { className: "l2de-inline" },
        h("button", { type: "button", onClick: exportMotion }, "导出动作"),
        h("button", { type: "button", onClick: function () { motionInputRef.current && motionInputRef.current.click(); } }, "导入动作")
      ),
      h("div", { className: "l2de-chips" }, frames.length === 0
        ? h("span", { className: "l2de-empty" }, "0 帧")
        : frames.map(function (frame, index) {
            return h("button", {
              type: "button",
              className: "l2de-key",
              key: "k" + index,
              title: "跳到 " + frame.time + "s",
              onClick: function () { scrubTo(frame.time); }
            }, frame.time.toFixed(2));
          }))
    )
  );

  var dialog = h("div", { className: "l2de-dialog", role: "dialog", "aria-label": "Live2D 编辑器" },
    h("header", { className: "l2de-head" },
      h("div", { className: "l2de-title" },
        h("b", null, "Live2D 编辑器"),
        h("span", { className: "l2de-sub" }, status)
      ),
      h("div", { className: "l2de-actions" },
        h("button", { type: "button", onClick: function () { modelInputRef.current && modelInputRef.current.click(); } }, "导入模型"),
        h("button", { type: "button", onClick: function () { setOpen(false); } }, "关闭")
      )
    ),
    error ? h("div", { className: "l2de-error" }, error) : null,
    h("div", { className: "l2de-body" }, parameterPanel, stage, right),
    h("footer", { className: "l2de-foot" },
      h("span", null, notice || "滚轮缩放 · 拖动平移 · 双击复位视角"),
      h("span", null, info && info.masks > 0 ? info.masks + " 个对象带剪裁遮罩（暂不支持）" : "参数改动即时生效")
    )
  );

  return h("div", {
    className: "l2de-overlay",
    onMouseDown: function (event) {
      if (event.target === event.currentTarget) setOpen(false);
    }
  },
    dialog,
    h("input", {
      ref: modelInputRef, type: "file", multiple: true, style: { display: "none" },
      accept: ".json,.moc3,.png,.webp",
      onChange: function (event) {
        var files = event.target.files;
        event.target.value = "";
        if (files && files.length > 0) importModel(files);
      }
    }),
    h("input", {
      ref: exprInputRef, type: "file", style: { display: "none" }, accept: ".json",
      onChange: function (event) {
        var files = event.target.files;
        event.target.value = "";
        if (files && files.length > 0) importExpressionFile(files);
      }
    }),
    h("input", {
      ref: motionInputRef, type: "file", style: { display: "none" }, accept: ".json",
      onChange: function (event) {
        var files = event.target.files;
        event.target.value = "";
        if (files && files.length > 0) importMotionFile(files);
      }
    })
  );
}

// ── 样式 ──────────────────────────────────────────────────────────────────
// 颜色只取宿主真实存在的 --dsw-alias-* token，取不到就用兜底色，深浅色都跟着宿主走。
var EDITOR_CSS = [
  // 侧边小标签：贴在窗口右缘内侧（让开滚动条），避开右下角的桌宠与底部输入框
  ".l2de-launch{position:fixed;right:14px;top:42%;z-index:60;width:26px;height:88px;padding:0;",
  "border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));",
  "background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f2328);",
  "font:600 12px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.18em;writing-mode:vertical-rl;",
  "cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.14);transition:transform .12s ease,background .12s ease}",
  ".l2de-launch:hover{transform:translateX(-2px);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}",
  ".l2de-overlay{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;",
  "background:rgba(12,14,18,.46);backdrop-filter:blur(2px)}",
  ".l2de-dialog{display:flex;flex-direction:column;width:min(1180px,94vw);height:min(780px,88vh);",
  "border-radius:16px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#fff);",
  "color:var(--dsw-alias-label-primary,#1f2328);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));",
  "box-shadow:0 24px 64px rgba(0,0,0,.34);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}",
  ".l2de-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;",
  "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}",
  ".l2de-title{display:flex;flex-direction:column;gap:2px;min-width:0}",
  ".l2de-title b{font-size:15px;letter-spacing:.02em}",
  ".l2de-sub{font-size:12px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".l2de-actions{display:flex;gap:8px;flex:none}",
  ".l2de-error{margin:0 16px;padding:8px 10px;border-radius:8px;font-size:12px;",
  "background:rgba(220,80,80,.14);color:#c0392b}",
  ".l2de-body{flex:1;display:grid;grid-template-columns:290px minmax(0,1fr) 320px;gap:10px;padding:10px 12px;min-height:0}",
  ".l2de-col{min-height:0;min-width:0;display:flex;flex-direction:column;gap:8px}",
  ".l2de-left,.l2de-right{overflow:hidden}",
  ".l2de-search input,.l2de-inline input[type=text],.l2de-inline input[type=number],.l2de-inline select",
  "{width:100%;height:28px;padding:0 8px;border-radius:7px;font:inherit;color:inherit;",
  "background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14))}",
  ".l2de-tabs{display:flex;gap:6px;align-items:center}",
  ".l2de-tabs button{height:26px;padding:0 10px;border-radius:7px;font:inherit;cursor:pointer;color:inherit;",
  "border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent}",
  ".l2de-tabs button[data-on=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07));font-weight:600}",
  ".l2de-tabs .l2de-reset-all{margin-left:auto}",
  ".l2de-list{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}",
  ".l2de-row{display:flex;flex-direction:column;gap:3px}",
  ".l2de-row-head{display:flex;align-items:baseline;gap:6px;min-width:0}",
  ".l2de-row-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".l2de-row-id{font-size:10px;opacity:.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
  ".l2de-row-body{display:flex;align-items:center;gap:6px}",
  ".l2de-row-body input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-label-primary,#3a7afe)}",
  ".l2de-number{width:64px;height:22px;padding:0 4px;font-size:11px;border-radius:5px;color:inherit;",
  "background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14))}",
  ".l2de-mini{height:22px;min-width:22px;padding:0 6px;border-radius:6px;font:inherit;font-size:11px;cursor:pointer;",
  "color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:transparent}",
  ".l2de-mini[data-on=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.08));font-weight:600}",
  ".l2de-opacity{font-size:11px;opacity:.6;width:34px;text-align:right}",
  ".l2de-center{gap:6px}",
  ".l2de-stage{flex:1;min-height:0;border-radius:12px;overflow:hidden;",
  "background:repeating-conic-gradient(rgba(127,127,127,.10) 0% 25%,transparent 0% 50%) 0 0/18px 18px,",
  "var(--dsw-alias-bg-layer-2,#fff)}",
  ".l2de-canvas{display:block;width:100%;height:100%;cursor:grab;touch-action:none}",
  ".l2de-canvas:active{cursor:grabbing}",
  ".l2de-stagebar{display:flex;align-items:center;gap:8px;font-size:11px;opacity:.75;flex-wrap:wrap}",
  ".l2de-stagebar span:first-child{margin-right:auto}",
  ".l2de-right{overflow-y:auto}",
  ".l2de-card{display:flex;flex-direction:column;gap:7px;padding:10px;border-radius:10px;",
  "border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}",
  ".l2de-card header{display:flex;align-items:baseline;gap:8px;font-weight:600;font-size:12px}",
  ".l2de-hint{font-size:10px;font-weight:400;opacity:.5}",
  ".l2de-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
  ".l2de-inline>input[type=text]{flex:1;min-width:90px}",
  ".l2de-inline label{display:flex;align-items:center;gap:4px;font-size:11px;opacity:.8}",
  ".l2de-inline label input[type=number]{width:58px;height:24px;padding:0 4px;border-radius:5px;color:inherit;",
  "background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14))}",
  ".l2de-inline button,.l2de-chip button,.l2de-key{height:26px;padding:0 9px;border-radius:7px;font:inherit;",
  "font-size:12px;cursor:pointer;color:inherit;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));",
  "background:transparent}",
  ".l2de-inline button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
  ".l2de-chips{display:flex;flex-wrap:wrap;gap:5px;max-height:112px;overflow-y:auto}",
  ".l2de-chip{display:inline-flex;align-items:stretch;border-radius:7px;overflow:hidden;",
  "border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14))}",
  ".l2de-chip button{border:0;border-radius:0}",
  ".l2de-chip-main{padding:0 8px}",
  ".l2de-chip-act{width:22px;padding:0;opacity:.65;border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))!important}",
  ".l2de-timeline{display:flex;align-items:center;gap:8px}",
  ".l2de-timeline input[type=range]{flex:1;min-width:0}",
  ".l2de-time{font-size:11px;opacity:.7;width:52px;text-align:right;font-variant-numeric:tabular-nums}",
  ".l2de-key{font-variant-numeric:tabular-nums}",
  ".l2de-empty{font-size:11px;opacity:.55;margin:0}",
  ".l2de-foot{display:flex;justify-content:space-between;gap:12px;padding:8px 16px;font-size:11px;opacity:.62;",
  "border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}"
].join("\n");

function installEditorStyles() {
  var previous = document.getElementById(STYLE_ID);
  if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
  var style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = EDITOR_CSS;
  (document.head || document.documentElement).appendChild(style);
  return function () {
    if (style.parentNode) style.parentNode.removeChild(style);
  };
}
