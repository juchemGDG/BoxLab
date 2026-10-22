/* Boxlab – STL-Dateien lesen (binär und ASCII) und auswerten.
 *
 * Ein Modell besteht nur aus Dreiecken: pos = [x0,y0,z0, x1,y1,z1, x2,y2,z2, …] in mm.
 * Die Lage in der Box ist R (3×3, nur 90°-Drehungen, Zeilen hintereinander) und o (Verschiebung):
 * Weltpunkt = R·p + o. Die Datei hat keine Browser-Abhängigkeit (node test/stl.test.js).
 */
(function (root) {
  'use strict';

  /** ArrayBuffer → Float32Array der Eckpunkte. Wirft bei unlesbaren Dateien. */
  function parse(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (n > 0 && 84 + n * 50 === buf.byteLength) {      // binär: 80 Byte Kopf, Anzahl, je Dreieck 50 Byte
        const pos = new Float32Array(n * 9);
        for (let i = 0; i < n; i++) {
          const at = 84 + i * 50 + 12;                    // Normale (12 Byte) überspringen – sie wird neu berechnet
          for (let j = 0; j < 9; j++) pos[i * 9 + j] = dv.getFloat32(at + j * 4, true);
        }
        return pos;
      }
    }
    const text = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(buf) : Buffer.from(buf).toString('latin1');
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
    if (!out.length || out.length % 9 || out.some((v) => !isFinite(v))) throw new Error('keine gültige STL-Datei');
    return new Float32Array(out);
  }

  /** Umschließender Quader der Eckpunkte: { min:[x,y,z], max:[x,y,z] }. */
  function bounds(pos) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = pos[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    return { min, max };
  }

  /** Eckpunkte mit Flächennormale je Dreieck verschränkt (x,y,z,nx,ny,nz) – für WebGL. */
  function interleave(pos) {
    const out = new Float32Array(pos.length * 2);
    for (let i = 0; i < pos.length; i += 9) {
      const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
      const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      for (let k = 0; k < 3; k++) {
        const o = (i / 3 + k) * 6;
        out.set([pos[i + k * 3], pos[i + k * 3 + 1], pos[i + k * 3 + 2], nx, ny, nz], o);
      }
    }
    return out;
  }

  const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** Drehung um 90° um die Achse 'x' | 'y' | 'z', angewendet nach R. */
  function rotate(R, axis) {
    const Q = axis === 'x' ? [1, 0, 0, 0, 0, -1, 0, 1, 0] : axis === 'y' ? [0, 0, 1, 0, 1, 0, -1, 0, 0] : [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const o = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(Q[r * 3] * R[c] + Q[r * 3 + 1] * R[3 + c] + Q[r * 3 + 2] * R[6 + c]);
    return o;
  }
  const apply = (R, p) => [0, 1, 2].map((r) => R[r * 3] * p[0] + R[r * 3 + 1] * p[1] + R[r * 3 + 2] * p[2]);

  /** Quader nach der Drehung R (exakt, da nur 90°-Drehungen). */
  function rotatedBounds(R, b) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
      const q = apply(R, [x, y, z]);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], q[a]); max[a] = Math.max(max[a], q[a]); }
    }
    return { min, max };
  }

  /**
   * Schneidet oder berührt ein Dreieck die Ebene axis = value innerhalb des Rechtecks rect?
   * rect = [[lo, hi], [lo, hi]] für die beiden anderen Achsen (in Reihenfolge x, y, z ohne axis).
   * Geprüft wird jedes Dreieck des Modells in Lage (R, o).
   */
  function hitsPlane(pos, R, o, axis, value, rect) {
    const others = [0, 1, 2].filter((a) => a !== axis);
    const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const x = pos[i + k * 3], y = pos[i + k * 3 + 1], z = pos[i + k * 3 + 2];
        for (let r = 0; r < 3; r++) P[k][r] = R[r * 3] * x + R[r * 3 + 1] * y + R[r * 3 + 2] * z + o[r];
      }
      const d = P.map((p) => p[axis] - value);
      if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
      // Schnittstrecke: Punkte auf den Kanten mit Vorzeichenwechsel (und Ecken in der Ebene)
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      const take = (p) => others.forEach((a, j) => { lo[j] = Math.min(lo[j], p[a]); hi[j] = Math.max(hi[j], p[a]); });
      for (let k = 0; k < 3; k++) {
        const a = P[k], b = P[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
        if (da === 0) take(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const s = da / (da - db);
          take([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]);
        }
      }
      // Berühren zählt mit: ein Modell, das auf dem Boden steht und die Wand kreuzt, liegt genau auf dem Rand
      if (lo[0] <= rect[0][1] && hi[0] >= rect[0][0] && lo[1] <= rect[1][1] && hi[1] >= rect[1][0]) return true;
    }
    return false;
  }

  /**
   * „Schatten“ des Modells (Lage R, o) auf ein Teil: Tiefenbild in Teilkoordinaten.
   * pose = Lage des Teils (o, U, V, N wie geometry.js), t = Dicke, w × h = Teilgröße, s = Pixel je mm.
   * depth[r·cols + c] = kleinster Abstand des Modells zur Plattenoberfläche (mm), Infinity = kein Schatten.
   */
  function shadow(pos, R, o, pose, t, w, h, s) {
    const cols = Math.max(1, Math.ceil(w * s)), rows = Math.max(1, Math.ceil(h * s));
    const depth = new Float32Array(cols * rows).fill(Infinity);
    const { U, V, N } = pose, O = pose.o;
    const q = new Float64Array(9);                        // je Ecke: u, v in Pixeln, Abstand in mm
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const x = pos[i + k * 3], y = pos[i + k * 3 + 1], z = pos[i + k * 3 + 2];
        const px = R[0] * x + R[1] * y + R[2] * z + o[0] - O[0];
        const py = R[3] * x + R[4] * y + R[5] * z + o[1] - O[1];
        const pz = R[6] * x + R[7] * y + R[8] * z + o[2] - O[2];
        q[k * 3] = (px * U[0] + py * U[1] + pz * U[2]) * s;
        q[k * 3 + 1] = (px * V[0] + py * V[1] + pz * V[2]) * s;
        q[k * 3 + 2] = Math.max(0, Math.abs(px * N[0] + py * N[1] + pz * N[2] - t / 2) - t / 2);
      }
      const x0 = q[0], y0 = q[1], x1 = q[3], y1 = q[4], x2 = q[6], y2 = q[7];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-12) continue;                 // steht senkrecht zur Platte: kein Beitrag
      const c0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), c1 = Math.min(cols - 1, Math.ceil(Math.max(x0, x1, x2)));
      const r0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), r1 = Math.min(rows - 1, Math.ceil(Math.max(y0, y1, y2)));
      for (let r = r0; r <= r1; r++) {
        const cy = r + 0.5;
        for (let c = c0; c <= c1; c++) {
          const cx = c + 0.5;
          const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
          const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const d = w0 * q[2] + w1 * q[5] + w2 * q[8], at = r * cols + c;
          if (d < depth[at]) depth[at] = d;
        }
      }
    }
    return { cols, rows, depth };
  }

  const api = { parse, bounds, interleave, rotate, apply, rotatedBounds, hitsPlane, shadow, ID };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxStl = api;
})(typeof window !== 'undefined' ? window : globalThis);
