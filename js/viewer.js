// Dependency-free WebGL1 3D viewer for the student's STL model + print bed + problem highlights.
// Z is up (matching STL / 3D printer coordinates). Supports orbit (left drag), pan (right/shift drag),
// zoom (wheel/pinch), bed grid rendering, per-triangle color highlighting, and 3D problem edge segments.

// One colour per separate piece when an issue lists `groups`; the legend shows the same swatches.
export const GROUP_COLORS = [[0.98, 0.62, 0.16], [0.76, 0.42, 0.98], [0.25, 0.80, 0.72], [0.96, 0.85, 0.25], [0.98, 0.45, 0.65]];

export class StlViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { antialias: true, alpha: false });
    this.yaw = -0.65;
    this.pitch = 0.52;
    this.dist = 240;
    this.target = [0, 0, 20];
    this.bed = [256, 256, 250];
    this.placedPos = null;
    this.nT = 0;
    this.segCount = 0;
    this.isolated = false;
    this.highlight = null;
    this.isolateTriCount = 0;
    this.segColor = [0.95, 0.25, 0.25];
    this._dirty = true;

    if (!this.gl) return;
    this._initShaders();
    this._initBuffers();
    this._bindEvents();
    this.setBed(this.bed);
    this._loop();
  }

  _initShaders() {
    const gl = this.gl;
    const vsMesh = `
      attribute vec3 aPos;
      attribute vec3 aNorm;
      attribute vec3 aColor;
      uniform mat4 uMVP;
      varying vec3 vNorm;
      varying vec3 vColor;
      varying vec3 vPos;
      void main() {
        vNorm = aNorm;
        vColor = aColor;
        vPos = aPos;
        gl_Position = uMVP * vec4(aPos, 1.0);
      }
    `;
    const fsMesh = `
      precision mediump float;
      varying vec3 vNorm;
      varying vec3 vColor;
      varying vec3 vPos;
      uniform vec3 uEye;
      uniform float uAlpha;
      void main() {
        vec3 N = normalize(vNorm);
        vec3 V = normalize(uEye - vPos);
        // Two-sided lighting so inverted faces are still visible
        if (dot(N, V) < 0.0) N = -N;
        vec3 L1 = normalize(vec3(0.45, -0.55, 0.70));
        vec3 L2 = normalize(vec3(-0.6, 0.5, 0.35));
        float d1 = max(dot(N, L1), 0.0);
        float d2 = max(dot(N, L2), 0.0);
        float hemi = 0.5 + 0.5 * N.z;
        vec3 col = vColor * (0.28 + 0.48 * d1 + 0.20 * d2 + 0.14 * hemi + 0.30 * max(-N.z, 0.0));
        vec3 H = normalize(L1 + V);
        float spec = pow(max(dot(N, H), 0.0), 28.0) * 0.18;
        gl_FragColor = vec4(col + vec3(spec), uAlpha);
      }
    `;
    const vsLine = `
      attribute vec3 aPos;
      attribute vec3 aColor;
      uniform mat4 uMVP;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        gl_Position = uMVP * vec4(aPos, 1.0);
      }
    `;
    const fsLine = `
      precision mediump float;
      varying vec3 vColor;
      void main() {
        gl_FragColor = vec4(vColor, 1.0);
      }
    `;
    this.progMesh = compile(gl, vsMesh, fsMesh);
    this.progLine = compile(gl, vsLine, fsLine);
  }

  _initBuffers() {
    const gl = this.gl;
    this.bufPos = gl.createBuffer();
    this.bufNorm = gl.createBuffer();
    this.bufCol = gl.createBuffer();
    this.bufGridPos = gl.createBuffer();
    this.bufGridCol = gl.createBuffer();
    this.bufSegPos = gl.createBuffer();
    this.bufSegCol = gl.createBuffer();
    this.bufIsolatePos = gl.createBuffer();
    this.bufIsolateNorm = gl.createBuffer();
    this.bufIsolateCol = gl.createBuffer();
    this.bufMarkPos = gl.createBuffer();
    this.bufMarkCol = gl.createBuffer();
    this.labels = [];
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "gap-labels";
    this.canvas.parentElement.appendChild(this.labelLayer);
  }

  setBed(bed) {
    this.bed = bed;
    const [bx, by, bz] = bed;
    const hx = bx / 2, hy = by / 2;
    const pos = [], col = [];
    const pushLine = (x0, y0, z0, x1, y1, z1, r, g, b) => {
      pos.push(x0, y0, z0, x1, y1, z1);
      col.push(r, g, b, r, g, b);
    };
    const step = 20;
    for (let x = - Math.floor(hx / step) * step; x <= hx; x += step) {
      const major = x === 0;
      pushLine(x, -hy, 0, x, hy, 0, major ? 0.28 : 0.17, major ? 0.36 : 0.22, major ? 0.48 : 0.30);
    }
    for (let y = - Math.floor(hy / step) * step; y <= hy; y += step) {
      const major = y === 0;
      pushLine(-hx, y, 0, hx, y, 0, major ? 0.28 : 0.17, major ? 0.36 : 0.22, major ? 0.48 : 0.30);
    }
    // Bed outline + vertical height pillars
    pushLine(-hx, -hy, 0, hx, -hy, 0, 0.35, 0.65, 0.95);
    pushLine(hx, -hy, 0, hx, hy, 0, 0.35, 0.65, 0.95);
    pushLine(hx, hy, 0, -hx, hy, 0, 0.35, 0.65, 0.95);
    pushLine(-hx, hy, 0, -hx, -hy, 0, 0.35, 0.65, 0.95);
    for (const [cx, cy] of [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]) {
      pushLine(cx, cy, 0, cx, cy, bz, 0.18, 0.24, 0.33);
    }
    const gl = this.gl;
    if (!gl) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufGridPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufGridCol);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(col), gl.STATIC_DRAW);
    this.gridVerts = pos.length / 3;
    this._dirty = true;
  }

  setModel(placedPos, size) {
    const gl = this.gl;
    this.placedPos = placedPos;
    this.modelSize = size;
    this.nT = placedPos ? placedPos.length / 9 : 0;
    this.segCount = 0;
    if (!gl || !this.nT) { this._dirty = true; return; }

    // Compute per-vertex facet normals
    const norms = new Float32Array(this.nT * 9);
    for (let t = 0; t < this.nT; t++) {
      const o = t * 9;
      const ux = placedPos[o + 3] - placedPos[o], uy = placedPos[o + 4] - placedPos[o + 1], uz = placedPos[o + 5] - placedPos[o + 2];
      const vx = placedPos[o + 6] - placedPos[o], vy = placedPos[o + 7] - placedPos[o + 1], vz = placedPos[o + 8] - placedPos[o + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (let k = 0; k < 3; k++) {
        norms[o + k * 3] = nx; norms[o + k * 3 + 1] = ny; norms[o + k * 3 + 2] = nz;
      }
    }
    this.normals = norms;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos);
    gl.bufferData(gl.ARRAY_BUFFER, placedPos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufNorm);
    gl.bufferData(gl.ARRAY_BUFFER, norms, gl.STATIC_DRAW);

    this.setHighlight(null);
    this.fitCamera(size);
  }

  _fitGoal(size = [60, 60, 40]) {
    const maxDim = Math.max(size[0] || 60, size[1] || 60, (size[2] || 40) * 1.3, 35);
    return {
      target: [0, 0, (size[2] || 30) * 0.42],
      dist: Math.min(600, Math.max(45, maxDim * 1.95)),
      yaw: -0.68,
      pitch: 0.48,
    };
  }

  fitCamera(size = [60, 60, 40]) {
    this._anim = null;
    Object.assign(this, this._fitGoal(size));
    this._dirty = true;
  }

  // Glide the camera to a goal; jumps straight there if the student prefers reduced motion.
  _flyTo(goal) {
    const wrap = (d) => Math.atan2(Math.sin(d), Math.cos(d)); // turn the short way round
    const to = { target: goal.target, dist: goal.dist, yaw: this.yaw + wrap((goal.yaw ?? this.yaw) - this.yaw), pitch: goal.pitch ?? this.pitch };
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this._anim = null;
      Object.assign(this, to);
    } else {
      this._anim = { from: { target: [...this.target], dist: this.dist, yaw: this.yaw, pitch: this.pitch }, to, t0: performance.now(), ms: 1800 };
    }
    this._dirty = true;
  }

  _stepAnim(now) {
    const a = this._anim;
    if (!a) return;
    const k = Math.min(1, (now - a.t0) / a.ms);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const mix = (x, y) => x + (y - x) * e;
    this.target = a.from.target.map((v, i) => mix(v, a.to.target[i]));
    // Lift away a little mid-flight so the whole workspace passes through view on the way.
    this.dist = mix(a.from.dist, a.to.dist) + Math.sin(Math.PI * e) * Math.max(a.from.dist, a.to.dist) * 0.18;
    this.yaw = mix(a.from.yaw, a.to.yaw);
    this.pitch = mix(a.from.pitch, a.to.pitch);
    if (k >= 1) this._anim = null;
    this._dirty = true;
  }

  // Highlight either `{ faces: [...], color }` or `{ segments: [...], color }` or null (all base color).
  setHighlight(highlight) {
    const gl = this.gl;
    if (!gl || !this.nT) return;
    this.highlight = highlight;
    this._setMarkers(highlight?.markers || []);
    const cols = new Float32Array(this.nT * 9);
    const hasHighlight = !!(highlight && ((highlight.faces && highlight.faces.length) || (highlight.segments && highlight.segments.length)));
    const base = hasHighlight ? [0.42, 0.50, 0.60] : [0.22, 0.72, 0.94];
    for (let i = 0; i < cols.length; i += 3) {
      cols[i] = base[0]; cols[i + 1] = base[1]; cols[i + 2] = base[2];
    }

    const pal = {
      red: [0.98, 0.26, 0.28],
      orange: [0.98, 0.62, 0.16],
      purple: [0.76, 0.42, 0.98],
    };
    const hiCol = pal[highlight?.color || "red"] || pal.red;

    // `groups` colours each separate piece differently; otherwise all faces share one colour.
    const groupPal = GROUP_COLORS;
    const groups = highlight?.groups?.length ? highlight.groups : null;
    if (groups) {
      groups.forEach((faces, gi) => {
        const c = groupPal[gi % groupPal.length];
        for (const t of faces) {
          if (t < 0 || t >= this.nT) continue;
          for (let k = 0; k < 3; k++) cols.set(c, t * 9 + k * 3);
        }
      });
    } else if (highlight?.faces?.length) {
      for (const t of highlight.faces) {
        if (t < 0 || t >= this.nT) continue;
        const o = t * 9;
        for (let k = 0; k < 3; k++) {
          cols[o + k * 3] = hiCol[0]; cols[o + k * 3 + 1] = hiCol[1]; cols[o + k * 3 + 2] = hiCol[2];
        }
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufCol);
    gl.bufferData(gl.ARRAY_BUFFER, cols, gl.DYNAMIC_DRAW);

    const faceSet = new Set(highlight?.faces || []);
    if (!faceSet.size && highlight?.segments?.length) {
      const key = (x, y, z) => `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
      const edges = new Set(highlight.segments.map((s) => {
        const a = key(s[0], s[1], s[2]), b = key(s[3], s[4], s[5]);
        return a < b ? `${a}|${b}` : `${b}|${a}`;
      }));
      for (let t = 0; t < this.nT; t++) {
        const o = t * 9;
        const points = [
          [this.placedPos[o], this.placedPos[o + 1], this.placedPos[o + 2]],
          [this.placedPos[o + 3], this.placedPos[o + 4], this.placedPos[o + 5]],
          [this.placedPos[o + 6], this.placedPos[o + 7], this.placedPos[o + 8]],
        ].map((p) => key(...p));
        if (edges.has(points[0] < points[1] ? `${points[0]}|${points[1]}` : `${points[1]}|${points[0]}`) ||
            edges.has(points[1] < points[2] ? `${points[1]}|${points[2]}` : `${points[2]}|${points[1]}`) ||
            edges.has(points[2] < points[0] ? `${points[2]}|${points[0]}` : `${points[0]}|${points[2]}`)) faceSet.add(t);
      }
    }
    this.isolateFaces = [...faceSet].filter((t) => t >= 0 && t < this.nT);
    this.#updateIsolatedBuffers(cols);

    if (highlight?.segments?.length) {
      const segPos = new Float32Array(highlight.segments.length * 6);
      const segCol = new Float32Array(highlight.segments.length * 6);
      for (let i = 0; i < highlight.segments.length; i++) {
        const s = highlight.segments[i];
        segPos.set(s, i * 6);
        segCol.set([...hiCol, ...hiCol], i * 6);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSegPos);
      gl.bufferData(gl.ARRAY_BUFFER, segPos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufSegCol);
      gl.bufferData(gl.ARRAY_BUFFER, segCol, gl.DYNAMIC_DRAW);
      this.segCount = highlight.segments.length * 2;
    } else {
      this.segCount = 0;
    }
    this._dirty = true;
    return this.isolateFaces.length > 0;
  }

  // "Isolated" = focus on the issue: zoom to it, keep the issue solid and fade the rest of the model.
  // Gap rulers for floating pieces: a vertical line with end ticks (drawn in _render) and a text label.
  _setMarkers(markers) {
    this.markers = markers;
    this.labelLayer.replaceChildren();
    this.labels = markers.map((m) => {
      const el = document.createElement("div");
      el.className = "gap-label";
      el.textContent = m.kind === "bed"
        ? `${m.gap.toFixed(m.gap < 10 ? 1 : 0)} mm above the bed, nothing underneath`
        : `${m.gap < 1 ? m.gap.toFixed(2) : m.gap.toFixed(1)} mm gap`;
      el.hidden = true;
      this.labelLayer.appendChild(el);
      return el;
    });
  }

  _drawMarkers(gl, mvp, w, h) {
    const show = this.isolated && this.markers?.length;
    this.labels.forEach((el) => { el.hidden = !show; });
    if (!show) return;
    const rx = -Math.sin(this.yaw), ry = Math.cos(this.yaw);
    const tick = this.dist * 0.014;
    const pos = [];
    this.markers.forEach((m, i) => {
      pos.push(m.x, m.y, m.z0, m.x, m.y, m.z1);
      for (const z of [m.z0, m.z1]) pos.push(m.x - rx * tick, m.y - ry * tick, z, m.x + rx * tick, m.y + ry * tick, z);
      // label sits beside the middle of the line
      const mx = m.x, my = m.y, mz = (m.z0 + m.z1) / 2;
      const cx = mvp[0] * mx + mvp[4] * my + mvp[8] * mz + mvp[12];
      const cy = mvp[1] * mx + mvp[5] * my + mvp[9] * mz + mvp[13];
      const cw = mvp[3] * mx + mvp[7] * my + mvp[11] * mz + mvp[15];
      const el = this.labels[i];
      if (cw <= 0) { el.hidden = true; return; }
      el.style.left = `${((cx / cw) * 0.5 + 0.5) * 100}%`;
      el.style.top = `${(1 - ((cy / cw) * 0.5 + 0.5)) * 100}%`;
    });
    const col = new Float32Array(pos.length).fill(1);
    for (let i = 2; i < col.length; i += 3) col[i] = 0.25; // yellow
    gl.useProgram(this.progLine);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, "uMVP"), false, mvp);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufMarkPos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufMarkCol);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    bindAttr(gl, this.progLine, "aPos", this.bufMarkPos, 3);
    bindAttr(gl, this.progLine, "aColor", this.bufMarkCol, 3);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.LINES, 0, pos.length / 3);
    gl.enable(gl.DEPTH_TEST);
  }

  setIsolated(isolated) {
    this.isolated = Boolean(isolated && this.isolateFaces?.length);
    if (this.isolated) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const t of this.isolateFaces) {
        for (let k = 0; k < 9; k += 3) {
          const o = t * 9 + k;
          for (let axis = 0; axis < 3; axis++) {
            lo[axis] = Math.min(lo[axis], this.placedPos[o + axis]);
            hi[axis] = Math.max(hi[axis], this.placedPos[o + axis]);
          }
        }
      }
      const maxDim = Math.max(...hi.map((v, i) => Math.max(v - lo[i], 1)));
      const fit = this.modelSize ? this._fitGoal(this.modelSize).dist : 600;
      this._flyTo({ target: lo.map((v, i) => (v + hi[i]) / 2), dist: Math.min(fit, Math.max(40, maxDim * 4.2, fit * 0.5)), ...this._facingAngles() });
    } else if (this.modelSize) {
      this._flyTo(this._fitGoal(this.modelSize));
    }
    this._dirty = true;
    return this.isolated;
  }

  // Camera angles that look at the issue faces head-on (e.g. up at overhangs). Empty when the
  // faces point every which way (a whole part), so the student's current angle is kept.
  _facingAngles() {
    let nx = 0, ny = 0, nz = 0, area = 0;
    for (const t of this.isolateFaces) {
      const o = t * 9, p = this.placedPos;
      const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
      const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
      const a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      nx += this.normals[o] * a; ny += this.normals[o + 1] * a; nz += this.normals[o + 2] * a;
      area += a;
    }
    const len = Math.hypot(nx, ny, nz);
    if (!area || len / area < 0.35) return {};
    return {
      yaw: Math.atan2(ny, nx),
      pitch: Math.max(-1.35, Math.min(1.35, Math.asin(nz / len))),
    };
  }

  #updateIsolatedBuffers(colors) {
    const gl = this.gl;
    const count = this.isolateFaces.length;
    const pos = new Float32Array(count * 9);
    const norm = new Float32Array(count * 9);
    const col = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) {
      const src = this.isolateFaces[i] * 9;
      pos.set(this.placedPos.subarray(src, src + 9), i * 9);
      norm.set(this.normals.subarray(src, src + 9), i * 9);
      col.set(colors.subarray(src, src + 9), i * 9);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufIsolatePos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufIsolateNorm);
    gl.bufferData(gl.ARRAY_BUFFER, norm, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufIsolateCol);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    this.isolateTriCount = count;
  }

  _bindEvents() {
    const c = this.canvas;
    let dragging = false, pan = false, lx = 0, ly = 0;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      dragging = true;
      pan = e.button === 2 || e.shiftKey;
      lx = e.clientX; ly = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (pan) {
        const s = this.dist * 0.0016;
        const rx = -Math.sin(this.yaw), ry = Math.cos(this.yaw);
        this.target[0] -= dx * rx * s;
        this.target[1] -= dx * ry * s;
        this.target[2] += dy * s;
      } else {
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(-1.45, Math.min(1.48, this.pitch + dy * 0.008));
      }
      this._dirty = true;
    });
    const stop = () => { dragging = false; };
    c.addEventListener("pointerup", stop);
    c.addEventListener("pointercancel", stop);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist = Math.max(15, Math.min(900, this.dist * Math.exp(e.deltaY * 0.0012)));
      this._dirty = true;
    }, { passive: false });
    window.addEventListener("resize", () => { this._dirty = true; });
  }

  _loop() {
    const tick = (now) => {
      this._stepAnim(now);
      if (this._dirty) {
        this._dirty = false;
        this._render();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _render() {
    const gl = this.gl;
    if (!gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.06, 0.09, 0.14, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const eye = [
      this.target[0] + this.dist * cp * cy,
      this.target[1] + this.dist * cp * sy,
      this.target[2] + this.dist * sp,
    ];
    const proj = perspective(40 * Math.PI / 180, w / h, 1.0, 2200.0);
    const view = lookAt(eye, this.target, [0, 0, 1]);
    const mvp = mul4(proj, view);

    // Draw bed grid
    gl.useProgram(this.progLine);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, "uMVP"), false, mvp);
    bindAttr(gl, this.progLine, "aPos", this.bufGridPos, 3);
    bindAttr(gl, this.progLine, "aColor", this.bufGridCol, 3);
    gl.drawArrays(gl.LINES, 0, this.gridVerts);

    // Draw model mesh. When focused on an issue, the issue is drawn solid first and the
    // whole model is then drawn faded on top (depth-tested, so it never hides the issue).
    if (this.nT > 0) {
      gl.useProgram(this.progMesh);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progMesh, "uMVP"), false, mvp);
      gl.uniform3fv(gl.getUniformLocation(this.progMesh, "uEye"), eye);
      const alphaLoc = gl.getUniformLocation(this.progMesh, "uAlpha");
      const drawMesh = (pos, norm, col, count, alpha) => {
        gl.uniform1f(alphaLoc, alpha);
        bindAttr(gl, this.progMesh, "aPos", pos, 3);
        bindAttr(gl, this.progMesh, "aNorm", norm, 3);
        bindAttr(gl, this.progMesh, "aColor", col, 3);
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(1.0, 1.0);
        gl.drawArrays(gl.TRIANGLES, 0, count * 3);
        gl.disable(gl.POLYGON_OFFSET_FILL);
      };
      if (this.isolated) {
        drawMesh(this.bufIsolatePos, this.bufIsolateNorm, this.bufIsolateCol, this.isolateTriCount, 1.0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        drawMesh(this.bufPos, this.bufNorm, this.bufCol, this.nT, 0.3);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      } else {
        drawMesh(this.bufPos, this.bufNorm, this.bufCol, this.nT, 1.0);
      }
    }

    this._drawMarkers(gl, mvp);

    // Draw highlighted edge segments on top
    if (this.segCount > 0) {
      gl.useProgram(this.progLine);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.progLine, "uMVP"), false, mvp);
      bindAttr(gl, this.progLine, "aPos", this.bufSegPos, 3);
      bindAttr(gl, this.progLine, "aColor", this.bufSegCol, 3);
      gl.drawArrays(gl.LINES, 0, this.segCount);
    }
  }
}

function compile(gl, vsSrc, fsSrc) {
  const s = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, s(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(prog, s(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(prog);
  return prog;
}

function bindAttr(gl, prog, name, buf, size) {
  const loc = gl.getAttribLocation(prog, name);
  if (loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function mul4(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[0 * 4 + i] * b[j * 4 + 0] +
        a[1 * 4 + i] * b[j * 4 + 1] +
        a[2 * 4 + i] * b[j * 4 + 2] +
        a[3 * 4 + i] * b[j * 4 + 3];
    }
  }
  return out;
}
