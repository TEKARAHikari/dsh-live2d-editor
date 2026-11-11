// Live2D 视口渲染器（WebGL，直接用 Cubism Core 的 Model 数据）。
//
// 与 dsh-led-pet 的 led-live2d-viewer.js 同源做法，但这个版本是「编辑器用」的：
//   · 支持多张图集（按 drawables.textureIndices 分派）
//   · 缩放 / 平移 / 线框 / 截图
//   · 每帧按 renderOrders 升序绘制（重导入的 ArtMesh 追加在后面，索引序会画反）
//   · 参数 / 部件读写全部走 Core，不做任何 CSS 或顶点位移假装变形
//
// 已知不支持（会在控制台说一次）：Clipping Mask 与混合模式，LED 模型两者都没用到。

(function () {
  "use strict";

  var GAZE_NAME = "ParamAngleX";
  var MASK_WARNED = false;

  function b64ToBuffer(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  var VS = [
    "attribute vec2 aPos;",
    "attribute vec2 aUv;",
    "uniform vec2 uScale;",
    "uniform vec2 uOffset;",
    "varying vec2 vUv;",
    "void main() {",
    "  vUv = vec2(aUv.x, 1.0 - aUv.y);",
    "  gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0);",
    "}"
  ].join("\n");

  var FS = [
    "precision mediump float;",
    "varying vec2 vUv;",
    "uniform sampler2D uTex;",
    "uniform float uAlpha;",
    "uniform float uWire;",
    "void main() {",
    "  vec4 c = texture2D(uTex, vUv);",
    "  float a = c.a * uAlpha;",
    "  if (uWire > 0.5) {",
    "    gl_FragColor = vec4(0.29, 0.62, 1.0, 0.85);",
    "    return;",
    "  }",
    "  if (a < 0.003) discard;",
    "  gl_FragColor = vec4(c.rgb, a);",
    "}"
  ].join("\n");

  function compile(gl, type, src) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("shader: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function createLive2DViewport(canvas, manifest, options) {
    var opts = options || {};
    var core = opts.core || (typeof window !== "undefined" ? window.Live2DCubismCore : null);
    if (!core) throw new Error("Live2DCubismCore 未加载");
    if (!manifest || !manifest.moc3) throw new Error("模型缺少 moc3");

    var mocBuffer = b64ToBuffer(manifest.moc3);
    var moc = core.Moc.fromArrayBuffer(mocBuffer);
    var model = core.Model.fromMoc(moc);
    var gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      preserveDrawingBuffer: true
    });
    if (!gl) throw new Error("WebGL 不可用");

    var program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("link: " + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    var aPos = gl.getAttribLocation(program, "aPos");
    var aUv = gl.getAttribLocation(program, "aUv");
    var uScale = gl.getUniformLocation(program, "uScale");
    var uOffset = gl.getUniformLocation(program, "uOffset");
    var uTex = gl.getUniformLocation(program, "uTex");
    var uAlpha = gl.getUniformLocation(program, "uAlpha");
    var uWire = gl.getUniformLocation(program, "uWire");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);

    var parameterIds = Array.prototype.slice.call(model.parameters.ids);
    var parameterIndex = {};
    for (var pi = 0; pi < parameterIds.length; pi++) parameterIndex[parameterIds[pi]] = pi;

    var drawables = model.drawables;
    var drawableCount = drawables.count;
    var textureIndices = drawables.textureIndices;

    var renderOrder = [];
    (function buildOrder() {
      for (var i = 0; i < drawableCount; i++) renderOrder.push(i);
      var orders = drawables.renderOrders;
      if (!orders || orders.length !== drawableCount) return;
      renderOrder.sort(function (a, b) {
        return orders[a] - orders[b] || a - b;
      });
    })();

    // 每帧都上传顶点，UV 与索引是静态的
    var meshes = [];
    for (var d = 0; d < drawableCount; d++) {
      var indices = drawables.indices[d];
      var mesh = {
        posBuffer: gl.createBuffer(),
        uvBuffer: gl.createBuffer(),
        indexBuffer: gl.createBuffer(),
        indexCount: indices.length
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, drawables.vertexUvs[d], gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      meshes.push(mesh);
    }

    var maskWarning = 0;
    (function checkMasks() {
      var counts = drawables.maskCounts;
      if (!counts) return;
      for (var i = 0; i < counts.length; i++) if (counts[i] > 0) maskWarning++;
    })();

    // 图集
    var atlas = [];
    var sources = Array.isArray(manifest.textures) ? manifest.textures : [];
    for (var t = 0; t < sources.length; t++) {
      var texture = gl.createTexture();
      var slot = { texture: texture, ready: false, failed: false };
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      (function (slotRef) {
        var img = new Image();
        img.onload = function () {
          try {
            gl.bindTexture(gl.TEXTURE_2D, slotRef.texture);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            slotRef.ready = true;
            if (typeof opts.onTextureReady === "function") opts.onTextureReady(slotRef);
          } catch (error) {
            slotRef.failed = true;
          }
        };
        img.onerror = function () {
          slotRef.failed = true;
        };
        img.src = sources[t];
        if (typeof img.decode === "function") img.decode().catch(function () {});
      })(slot);
      atlas.push(slot);
    }

    // 绑定姿势包围盒 + 视角
    model.update();
    var bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (var b = 0; b < drawableCount; b++) {
      var positions = drawables.vertexPositions[b];
      for (var v = 0; v < positions.length; v += 2) {
        if (positions[v] < bounds.minX) bounds.minX = positions[v];
        if (positions[v] > bounds.maxX) bounds.maxX = positions[v];
        if (positions[v + 1] < bounds.minY) bounds.minY = positions[v + 1];
        if (positions[v + 1] > bounds.maxY) bounds.maxY = positions[v + 1];
      }
    }
    if (!isFinite(bounds.minX)) bounds = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

    var view = { zoom: 1, panX: 0, panY: 0, wireframe: false, padding: 0.94 };
    var dpr = 1;

    function resize() {
      var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
      var cssWidth = (rect && rect.width) || canvas.clientWidth || 480;
      var cssHeight = (rect && rect.height) || canvas.clientHeight || 600;
      dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      var width = Math.max(1, Math.round(cssWidth * dpr));
      var height = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function projection() {
      var boxW = Math.max(1e-3, bounds.maxX - bounds.minX);
      var boxH = Math.max(1e-3, bounds.maxY - bounds.minY);
      var cx = (bounds.minX + bounds.maxX) / 2;
      var cy = (bounds.minY + bounds.maxY) / 2;
      var fit = Math.min(canvas.width / boxW, canvas.height / boxH) * view.padding * view.zoom;
      return {
        sx: (2 * fit) / canvas.width,
        sy: (2 * fit) / canvas.height,
        ox: -cx * ((2 * fit) / canvas.width) + view.panX,
        oy: -cy * ((2 * fit) / canvas.height) + view.panY
      };
    }

    function setParam(id, value) {
      var index = parameterIndex[id];
      if (index === undefined) return false;
      var min = model.parameters.minimumValues[index];
      var max = model.parameters.maximumValues[index];
      model.parameters.values[index] = Math.min(Math.max(value, min), max);
      return true;
    }

    function getParam(id) {
      var index = parameterIndex[id];
      return index === undefined ? undefined : model.parameters.values[index];
    }

    function setPartOpacity(id, value) {
      var ids = model.parts && model.parts.ids;
      if (!ids) return false;
      for (var i = 0; i < ids.length; i++) {
        if (ids[i] === id) {
          model.parts.opacities[i] = Math.min(Math.max(value, 0), 1);
          return true;
        }
      }
      return false;
    }

    function render() {
      resize();
      model.update();
      gl.clear(gl.COLOR_BUFFER_BIT);
      var p = projection();
      gl.useProgram(program);
      gl.uniform2f(uScale, p.sx, p.sy);
      gl.uniform2f(uOffset, p.ox, p.oy);
      gl.uniform1f(uWire, view.wireframe ? 1 : 0);
      gl.enableVertexAttribArray(aPos);
      gl.enableVertexAttribArray(aUv);

      for (var k = 0; k < renderOrder.length; k++) {
        var index = renderOrder[k];
        var mesh = meshes[index];
        var positions = drawables.vertexPositions[index];
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvBuffer);
        gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 0, 0);

        var textureIndex = textureIndices ? textureIndices[index] : 0;
        var slot = atlas[textureIndex] || atlas[0];
        if (!slot || !slot.ready) continue;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, slot.texture);
        gl.uniform1i(uTex, 0);
        gl.uniform1f(uAlpha, drawables.opacities ? drawables.opacities[index] : 1);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
        gl.drawElements(view.wireframe ? gl.LINES : gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_SHORT, 0);
      }
    }

    function texturesReady() {
      for (var i = 0; i < atlas.length; i++) if (!atlas[i].ready) return false;
      return atlas.length > 0;
    }

    return {
      core: core,
      model: model,
      gl: gl,
      bounds: bounds,
      parameterIds: parameterIds,
      parameterIndex: parameterIndex,
      drawableCount: drawableCount,
      textureCount: atlas.length,
      maskWarning: maskWarning,
      setParam: setParam,
      getParam: getParam,
      setPartOpacity: setPartOpacity,
      render: render,
      resize: resize,
      texturesReady: texturesReady,
      getView: function () {
        return { zoom: view.zoom, panX: view.panX, panY: view.panY, wireframe: view.wireframe };
      },
      setZoom: function (zoom) {
        view.zoom = Math.min(8, Math.max(0.2, zoom));
      },
      setPan: function (x, y) {
        view.panX = x;
        view.panY = y;
      },
      panBy: function (dx, dy) {
        view.panX += dx;
        view.panY += dy;
      },
      setWireframe: function (on) {
        view.wireframe = !!on;
      },
      resetView: function () {
        view.zoom = 1;
        view.panX = 0;
        view.panY = 0;
      },
      snapshot: function () {
        return canvas.toDataURL("image/png");
      },
      warnMasks: function () {
        var masked = maskWarning;
        if (masked > 0 && !MASK_WARNED && typeof console !== "undefined") {
          MASK_WARNED = true;
          console.warn("[dsh-live2d-editor] 剪裁遮罩（Clipping Mask）尚未实现：" + masked + " 个对象会露出来");
        }
        return masked;
      },
      dispose: function () {
        try {
          for (var i = 0; i < meshes.length; i++) {
            gl.deleteBuffer(meshes[i].posBuffer);
            gl.deleteBuffer(meshes[i].uvBuffer);
            gl.deleteBuffer(meshes[i].indexBuffer);
          }
          for (var j = 0; j < atlas.length; j++) gl.deleteTexture(atlas[j].texture);
          gl.deleteProgram(program);
        } catch (error) {
          /* 释放失败不影响关闭面板 */
        }
        try {
          model.release();
          moc.release();
        } catch (error) {
          /* 同上 */
        }
      }
    };
  }

  if (typeof window !== "undefined") {
    window.createLive2DEditorViewport = createLive2DViewport;
  }
})();
