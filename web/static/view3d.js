/* Boxlab – 3D-Vorschau (WebGL, ohne Bibliothek).
 *
 * Jedes Teil wird um die Materialstärke aufgedickt und mit BoxGeo.place an seinen Platz
 * in der Box gesetzt; die Explosionsansicht schiebt es entlang place().out nach außen.
 *
 * Die großen Flächen haben beliebig viele Löcher. Statt sie in Dreiecke zu zerlegen,
 * markiert der Stencil-Puffer den Umriss (Bit 1, gerade/ungerade über einen Fächer) und die
 * Löcher (Bit 4; alle Löcher sind konvex, ihre Fächer decken jedes Pixel genau einmal);
 * danach färbt ein Rechteck über der Fläche nur die Pixel "Umriss, kein Loch".
 */
(function (root) {
  'use strict';
  const G = root.BoxGeo;
  const FE = root.BoxFeat;

  const FOV = 35 * Math.PI / 180;
  const HOME = { yaw: -2.15, pitch: 0.5 };       // von vorn links, leicht von oben
  const COL = {
    face: [0.91, 0.80, 0.62], faceHi: [0.76, 0.86, 1.0],
    side: [0.78, 0.62, 0.42], sideHi: [0.52, 0.66, 0.96],
    edge: [0.30, 0.23, 0.16], edgeSel: [0.15, 0.39, 0.92],
    stl: [0.40, 0.76, 0.66], stlBad: [0.93, 0.42, 0.36],
  };
  const Z = [0, 0, 0];

  // ── Vektoren und Matrizen (column-major wie WebGL) ───────────────
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => scl(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    }
    return o;
  }
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  /** Sichtmatrix aus Kamerabasis: s rechts, u oben, f Blickrichtung. */
  function viewMatrix(eye, s, u, f) {
    return new Float32Array([s[0], u[0], -f[0], 0, s[1], u[1], -f[1], 0, s[2], u[2], -f[2], 0,
      -dot(s, eye), -dot(u, eye), dot(f, eye), 1]);
  }
  const modelOf = (L, off) => new Float32Array([...L.U, 0, ...L.V, 0, ...L.N, 0,
    L.o[0] + off[0], L.o[1] + off[1], L.o[2] + off[2], 1]);

  // ── Teile als Dreiecke, Kanten und Stencil-Flächen (Teilkoordinaten u, v, w) ──
  const rectLoop = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];

  function bbox(loops) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pts of loops) {
      for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    return [x0, y0, x1, y1];
  }

  function inPoly(pts, x, y) {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  function partMesh(part, feats, t) {
    const fill = [], side = [], lines = [];
    const vtx = (arr, u, v, w, n) => arr.push(u, v, w, n[0], n[1], n[2]);
    const loops = [
      { pts: part.outline, corners: true },
      ...part.holes.map((h) => (h.type === 'circle'
        ? { pts: FE.loop({ k: 'circle', x: h.x, y: h.y, d: h.d }), corners: false }
        : { pts: rectLoop(h), corners: true })),
    ];
    for (const f of feats) {
      for (const s of FE.shapes(f)) {
        if (!s.guide) loops.push({ pts: FE.loop(s), corners: s.k === 'rect' && !s.r, fid: f.id });
      }
    }

    // Seitenflächen und Kanten (Kanten eines Elements liegen zusammen, für die Markierung)
    const featLines = [];
    for (const L of loops) {
      const p = L.pts, first = lines.length / 6;
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const n = norm([b[1] - a[1], a[0] - b[0], 0]);
        vtx(side, a[0], a[1], 0, n); vtx(side, b[0], b[1], 0, n); vtx(side, b[0], b[1], t, n);
        vtx(side, a[0], a[1], 0, n); vtx(side, b[0], b[1], t, n); vtx(side, a[0], a[1], t, n);
        for (const w of [0, t]) { vtx(lines, a[0], a[1], w, Z); vtx(lines, b[0], b[1], w, Z); }
        if (L.corners) { vtx(lines, a[0], a[1], 0, Z); vtx(lines, a[0], a[1], t, Z); }
      }
      if (L.fid == null) continue;
      const prev = featLines[featLines.length - 1];
      if (prev && prev.fid === L.fid) prev.count = lines.length / 6 - prev.first;
      else featLines.push({ fid: L.fid, first, count: lines.length / 6 - first });
    }

    // Vorder- und Rückfläche: Umriss als Fächer, Löcher als Dreiecke, Rechteck zum Färben
    const cut = loops.slice(1).map((L) => L.pts);
    const [x0, y0, x1, y1] = bbox([part.outline, ...cut]);
    const faces = [];
    for (const w of [0, t]) {
      const n = [0, 0, w ? 1 : -1];
      const at = () => fill.length / 6;
      const o0 = at();
      for (const q of part.outline) vtx(fill, q[0], q[1], w, n);
      const h0 = at();
      for (const pts of cut) {
        for (let i = 1; i < pts.length - 1; i++) for (const q of [pts[0], pts[i], pts[i + 1]]) vtx(fill, q[0], q[1], w, n);
      }
      const q0 = at();
      for (const q of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) vtx(fill, q[0], q[1], w, n);
      faces.push({ outline: [o0, part.outline.length], holes: [h0, q0 - h0], quad: q0 });
    }
    return { fill: new Float32Array(fill), side: new Float32Array(side), lines: new Float32Array(lines), faces, featLines, cut };
  }

  // ── Shader ───────────────────────────────────────────────────────
  const VS = `attribute vec3 aPos; attribute vec3 aNrm;
uniform mat4 uMvp; uniform mat3 uNrm; varying vec3 vN;
void main() { vN = uNrm * aNrm; gl_Position = uMvp * vec4(aPos, 1.0); }`;
  const FS = `precision mediump float;
uniform vec3 uColor; uniform vec3 uLight; uniform float uLit; varying vec3 vN;
void main() {
  if (uLit < 0.5) { gl_FragColor = vec4(uColor, 1.0); return; }
  vec3 n = normalize(vN);
  float s = 0.46 + 0.4 * abs(dot(n, uLight)) + 0.16 * abs(n.z);
  gl_FragColor = vec4(uColor * s, 1.0);
}`;

  function program(gl) {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aNrm');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  /**
   * 3D-Ansicht im Canvas anlegen. opts.onPick(partId | null) bei Klick auf ein Teil.
   * Rückgabe null, wenn der Browser kein WebGL kann.
   */
  function create(canvas, opts) {
    let gl = null;
    try { gl = canvas.getContext('webgl', { antialias: true, stencil: true }); } catch (e) { /* kein WebGL */ }
    if (!gl) return null;
    const prog = program(gl);
    gl.useProgram(prog);
    const loc = {};
    for (const n of ['uMvp', 'uNrm', 'uColor', 'uLight', 'uLit']) loc[n] = gl.getUniformLocation(prog, n);
    gl.enableVertexAttribArray(0);
    gl.enableVertexAttribArray(1);
    gl.enable(gl.STENCIL_TEST);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);                         // Kanten liegen sichtbar auf den Flächen
    gl.depthFunc(gl.LEQUAL);

    const st = {
      parts: [], feats: [], P: null, dirty: false, dimKey: '',
      hiPart: null, hiFeat: null, explode: 0, showTop: true,
      yaw: HOME.yaw, pitch: HOME.pitch, dist: 500, target: [0, 0, 0],
      auto: true, needFit: true,                    // auto: Kamera folgt der Box, bis der Nutzer zoomt
    };
    let meshes = [];
    let queued = false;
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };

    function rebuildMeshes() {
      for (const m of meshes) for (const b of Object.values(m.buf)) gl.deleteBuffer(b);
      meshes = [];
      st.dirty = false;
      if (!st.P) return;
      for (const part of st.parts) {
        const g = partMesh(part, st.feats.filter((f) => f.part === part.id), st.P.t);
        const buf = {};
        for (const k of ['fill', 'side', 'lines']) {
          buf[k] = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf[k]);
          gl.bufferData(gl.ARRAY_BUFFER, g[k], gl.STATIC_DRAW);
        }
        meshes.push({ part, L: G.place(st.P, part), buf, nSide: g.side.length / 6, nLines: g.lines.length / 6,
          faces: g.faces, featLines: g.featLines, cut: g.cut });
      }
    }

    const shown = (m) => st.showTop || !m.part.lid;
    function offsetOf(m) {
      const P = st.P, e = st.explode * 0.6 * Math.max(P.W, P.D, P.H);
      const k = m.part.id === 'insert' ? 1.35 : m.part.lid ? 1.8 : m.part.kind === 'divider' ? 0.9 : 1;
      return scl(m.L.out, e * k);
    }

    // ── Kamera ──
    function basis() {
      const cp = Math.cos(st.pitch);
      const dir = [cp * Math.cos(st.yaw), cp * Math.sin(st.yaw), Math.sin(st.pitch)];
      const eye = add(st.target, scl(dir, st.dist));
      const f = scl(dir, -1);
      const s = norm(cross(f, [0, 0, 1]));
      return { eye, f, s, u: cross(s, f) };
    }
    function camera(aspect) {
      const c = basis();
      const proj = perspective(FOV, aspect, Math.max(st.dist * 0.01, 0.1), st.dist * 20 + 1000);
      c.aspect = aspect;
      c.vp = mul(proj, viewMatrix(c.eye, c.s, c.u, c.f));
      return c;
    }
    function fit(aspect) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const m of meshes) {
        if (!shown(m)) continue;
        const o = add(m.L.o, offsetOf(m));
        for (const u of [0, m.part.w]) for (const v of [0, m.part.h]) for (const w of [0, st.P.t]) {
          const p = add(o, add(scl(m.L.U, u), add(scl(m.L.V, v), scl(m.L.N, w))));
          for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
        }
      }
      if (!isFinite(lo[0])) return;
      st.target = scl(add(lo, hi), 0.5);
      const R = 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
      const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * aspect));
      st.dist = (R / Math.sin(half)) * 1.02;
    }

    // ── Zeichnen ──
    function bind(buf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    }

    function fillFace(f) {
      // 1. Umriss und Löcher in den Stencil (ohne Farbe/Tiefe)
      gl.disable(gl.DEPTH_TEST);
      gl.colorMask(false, false, false, false);
      gl.depthMask(false);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.stencilMask(1);
      gl.drawArrays(gl.TRIANGLE_FAN, f.outline[0], f.outline[1]);
      if (f.holes[1]) {                             // Löcher setzen Bit 4 (Überlappungen bleiben Loch)
        gl.stencilMask(4);
        gl.stencilFunc(gl.ALWAYS, 4, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.drawArrays(gl.TRIANGLES, f.holes[0], f.holes[1]);
      }
      // 2. Fläche färben, wo Umriss und kein Loch; Stencil dabei zurücksetzen
      gl.enable(gl.DEPTH_TEST);
      gl.colorMask(true, true, true, true);
      gl.depthMask(true);
      gl.stencilMask(0xff);
      gl.stencilFunc(gl.EQUAL, 1, 5);
      gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
      gl.drawArrays(gl.TRIANGLE_FAN, f.quad, 4);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    }

    function drawPart(m, cam) {
      const hi = m.part.id === st.hiPart;
      gl.uniformMatrix4fv(loc.uMvp, false, mul(cam.vp, modelOf(m.L, offsetOf(m))));
      gl.uniformMatrix3fv(loc.uNrm, false, new Float32Array([...m.L.U, ...m.L.V, ...m.L.N]));
      gl.uniform1f(loc.uLit, 1);
      bind(m.buf.fill);
      gl.uniform3fv(loc.uColor, hi ? COL.faceHi : COL.face);
      for (const f of m.faces) fillFace(f);
      bind(m.buf.side);
      gl.uniform3fv(loc.uColor, hi ? COL.sideHi : COL.side);
      gl.drawArrays(gl.TRIANGLES, 0, m.nSide);
      bind(m.buf.lines);
      gl.uniform1f(loc.uLit, 0);
      gl.uniform3fv(loc.uColor, COL.edge);
      gl.drawArrays(gl.LINES, 0, m.nLines);
      for (const fl of m.featLines) {
        if (fl.fid !== st.hiFeat) continue;
        gl.uniform3fv(loc.uColor, COL.edgeSel);
        gl.drawArrays(gl.LINES, fl.first, fl.count);
      }
    }

    function draw() {
      queued = false;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;                         // ausgeblendet
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      if (st.dirty) rebuildMeshes();
      if (st.needFit) { fit(w / h); st.needFit = false; }

      gl.viewport(0, 0, cw, ch);
      gl.colorMask(true, true, true, true); gl.depthMask(true); gl.stencilMask(0xff);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      const cam = camera(w / h);
      gl.uniform3fv(loc.uLight, norm(add(scl(cam.f, -1), add(scl(cam.u, 0.45), scl(cam.s, -0.3)))));
      for (const m of meshes) if (shown(m)) drawPart(m, cam);
      if (stl.buf && stl.show && stl.R) drawStl(cam);
    }

    // ── STL-Modell: Lage R (Zeilen, nur 90°-Drehungen) und o, rot wenn es nicht passt ──
    const stl = { buf: null, n: 0, R: null, o: null, bad: false, show: true };
    function drawStl(cam) {
      const R = stl.R, o = stl.o;
      const model = new Float32Array([R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, o[0], o[1], o[2], 1]);
      gl.uniformMatrix4fv(loc.uMvp, false, mul(cam.vp, model));
      gl.uniformMatrix3fv(loc.uNrm, false, new Float32Array([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]));
      gl.uniform1f(loc.uLit, 1);
      gl.uniform3fv(loc.uColor, stl.bad ? COL.stlBad : COL.stl);
      bind(stl.buf);
      gl.drawArrays(gl.TRIANGLES, 0, stl.n);
    }

    // ── Anklicken: Strahl gegen die beiden Flächen jedes Teils ──
    function pick(cx, cy) {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const nx = ((cx - r.left) / r.width) * 2 - 1, ny = 1 - ((cy - r.top) / r.height) * 2;
      const c = basis(), th = Math.tan(FOV / 2), aspect = r.width / r.height;
      const d = norm(add(c.f, add(scl(c.s, nx * th * aspect), scl(c.u, ny * th))));
      let best = null, bestS = Infinity;
      for (const m of meshes) {
        if (!shown(m)) continue;
        const o = add(m.L.o, offsetOf(m)), N = m.L.N;
        const den = dot(d, N);
        if (Math.abs(den) < 1e-9) continue;
        for (const w of [0, st.P.t]) {
          const s = dot(sub(add(o, scl(N, w)), c.eye), N) / den;
          if (s <= 0 || s >= bestS) continue;
          const p = sub(add(c.eye, scl(d, s)), o);
          const u = dot(p, m.L.U), v = dot(p, m.L.V);
          if (inPoly(m.part.outline, u, v) && !m.cut.some((pts) => inPoly(pts, u, v))) { bestS = s; best = m.part.id; }
        }
      }
      return best;
    }

    // ── Bedienung: Ziehen dreht, Shift/rechte Taste/zwei Finger verschieben, Rad/Pinch zoomt ──
    const ptrs = new Map();
    let gest = null;
    function pan(dx, dy) {
      const c = basis(), k = (2 * st.dist * Math.tan(FOV / 2)) / (canvas.clientHeight || 1);
      st.target = add(st.target, add(scl(c.s, -dx * k), scl(c.u, dy * k)));
    }
    const zoom = (f) => { st.dist = Math.min(1e5, Math.max(5, st.dist * f)); };
    const two = () => {
      const [a, b] = [...ptrs.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 2) { gest = { type: 'pinch', ...two() }; return; }
      const panning = e.shiftKey || e.ctrlKey || e.metaKey || e.button === 1 || e.button === 2;
      gest = { type: panning ? 'pan' : 'orbit', x: e.clientX, y: e.clientY, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gest) return;
      if (gest.type === 'pinch') {
        if (ptrs.size < 2) return;
        const t = two();
        if (t.d > 0 && gest.d > 0) zoom(gest.d / t.d);
        pan(t.x - gest.x, t.y - gest.y);
        Object.assign(gest, t);
        st.auto = false; schedule();
        return;
      }
      const dx = e.clientX - gest.x, dy = e.clientY - gest.y;
      if (!gest.moved && Math.hypot(dx, dy) < 4) return;
      gest.moved = true;
      gest.x = e.clientX; gest.y = e.clientY;
      if (gest.type === 'orbit') {
        st.yaw -= dx * 0.008;
        st.pitch = Math.max(-1.5, Math.min(1.5, st.pitch + dy * 0.008));
      } else {
        pan(dx, dy);
        st.auto = false;
      }
      schedule();
    });
    const end = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (gest && gest.type !== 'pinch' && !gest.moved && e.type === 'pointerup') opts.onPick(pick(e.clientX, e.clientY));
      if (!ptrs.size) gest = null;
      else if (gest && gest.type === 'pinch') gest = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      st.auto = false; schedule();
    }, { passive: false });
    canvas.addEventListener('dblclick', () => api.resetView());
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    if (root.ResizeObserver) new ResizeObserver(() => { if (st.auto) st.needFit = true; schedule(); }).observe(canvas);

    const api = {
      /** Teile (aus BoxGeo.build), Löcher/Rechtecke und P = { W, D, H, t, lid }. */
      setModel(parts, feats, P) {
        const key = [P.W, P.D, P.H, P.t, P.lid].join();
        if (key !== st.dimKey) { st.dimKey = key; st.auto = true; }
        st.parts = parts; st.feats = feats; st.P = P; st.dirty = true;
        if (st.auto) st.needFit = true;
        schedule();
      },
      setHighlight(partId, featId) {
        if (partId === st.hiPart && featId === st.hiFeat) return;
        st.hiPart = partId; st.hiFeat = featId; schedule();
      },
      /** STL-Dreiecke (BoxStl.interleave) laden; null entfernt das Modell. */
      setStl(data) {
        if (stl.buf) gl.deleteBuffer(stl.buf);
        stl.buf = null; stl.n = 0;
        if (data) {
          stl.buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, stl.buf);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
          stl.n = data.length / 6;
        }
        schedule();
      },
      setStlPose(R, o, bad) { stl.R = R; stl.o = o; stl.bad = !!bad; schedule(); },
      setStlShow(v) { stl.show = v; schedule(); },
      setExplode(v) { st.explode = v; if (st.auto) st.needFit = true; schedule(); },
      setShowTop(v) { st.showTop = v; schedule(); },
      fit() { st.auto = true; st.needFit = true; schedule(); },
      resetView() { st.yaw = HOME.yaw; st.pitch = HOME.pitch; api.fit(); },
      redraw: schedule,
    };
    return api;
  }

  root.Box3D = { create };
})(window);
