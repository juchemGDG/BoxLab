// Voxel-Test: Teile werden in 3D zurückgerechnet; es darf keine Überlappung und
// (bei den Außenwänden) keine Lücke geben.  Aufruf: node test/geometry.test.js
const G = require('../web/static/geometry.js');

function inPoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inHole = (h, u, v) => (h.type === 'circle'
  ? Math.hypot(u - h.x, v - h.y) < h.d / 2
  : u > h.x && u < h.x + h.w && v > h.y && v < h.y + h.h);
const inPart = (p, u, v) => inPoly(p.outline, u, v) && !p.holes.some((h) => inHole(h, u, v));

/** Welche Zellen müssen bei Spiel 0 gefüllt sein? (Außenwände, Boden, Deckel je Art) */
function shell(P) {
  const { W, D, H, t } = P, lid = P.lid || (P.closed ? 'fixed' : 'none');
  const walls = (x, y, z) => x < t || x > W - t || y > D - t || z < t;
  if (lid === 'slide') {
    const z0 = H - 3 * t;
    return (x, y, z) => walls(x, y, z) || (y < t && z < z0) || (z > z0 && z < z0 + t);
  }
  if (lid === 'hinge') {
    const r = Math.SQRT1_2 * t, yp = D - t - r, zp = H - 1.5 * t;
    return (x, y, z) => {
      if ((x < t || x > W - t) && Math.hypot(y - yp, z - zp) < r + 0.5) return false;   // Lager: Zapfen eckig, Loch rund
      return walls(x, y, z) || (y < t && z < H - 2 * t) || (z > H - 2 * t && z < H - t && y < yp + t / 2);
    };
  }
  const top = lid === 'fixed' || lid === 'lift';
  return (x, y, z) => walls(x, y, z) || y < t || (top && z > H - t);
}

/** Welt → Teilkoordinaten (u, v, w). */
function toLocal(L, x, y, z) {
  const r = [x - L.o[0], y - L.o[1], z - L.o[2]];
  const dot = (a) => r[0] * a[0] + r[1] * a[1] + r[2] * a[2];
  return [dot(L.U), dot(L.V), dot(L.N)];
}

function run(name, P) {
  const { parts, warnings } = G.build(P);
  const { W, D, H, t } = P;
  let fail = 0;
  const err = (m) => { fail++; if (fail < 8) console.log('   ✗', m); };

  // 1. Umrisse achsparallel und geschlossen
  for (const p of parts) {
    for (let i = 0; i < p.outline.length; i++) {
      const a = p.outline[i], b = p.outline[(i + 1) % p.outline.length];
      if (Math.abs(a[0] - b[0]) > 1e-7 && Math.abs(a[1] - b[1]) > 1e-7) err(`${p.id}: schräge Kante`);
    }
    const xs = p.outline.map((q) => q[0]), ys = p.outline.map((q) => q[1]);
    if (Math.abs(Math.min(...xs)) > 1e-7 || Math.abs(Math.min(...ys)) > 1e-7 ||
        Math.abs(Math.max(...xs) - p.w) > 1e-7 || Math.abs(Math.max(...ys) - p.h) > 1e-7)
      err(`${p.id}: Umriss ${Math.min(...xs)}..${Math.max(...xs)} x ${Math.min(...ys)}..${Math.max(...ys)} statt ${p.w}x${p.h}`);
  }

  // 2. Voxel – jedes Teil über G.place in die Box gesetzt (dieselbe Lage nutzt die 3D-Vorschau)
  const s = 0.5;
  const cells = new Map();
  const claim = (x, y, z, id) => {
    const key = `${x},${y},${z}`;
    if (cells.has(key)) err(`Überlappung ${id} / ${cells.get(key)} bei (${x},${y},${z})`);
    else cells.set(key, id);
  };
  const forBox = (x0, x1, y0, y1, z0, z1, fn) => {
    for (let x = x0 + s / 2; x < x1; x += s)
      for (let y = y0 + s / 2; y < y1; y += s)
        for (let z = z0 + s / 2; z < z1; z += s) fn(x, y, z);
  };
  for (const p of parts) {
    const L = G.place(P, p);
    const at = (u, v, w) => L.o.map((o, i) => o + u * L.U[i] + v * L.V[i] + w * L.N[i]);
    const corners = [at(0, 0, 0), at(p.w, p.h, t)];
    const lo = [0, 1, 2].map((i) => Math.min(corners[0][i], corners[1][i]));
    const hi = [0, 1, 2].map((i) => Math.max(corners[0][i], corners[1][i]));
    forBox(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2], (x, y, z) => {
      const [u, v] = toLocal(L, x, y, z);
      if (inPart(p, u, v)) claim(x, y, z, p.id);
    });
  }

  // 3. Außenhaut vollständig? (nur ohne Spiel – mit Spiel sind kleine Fugen gewollt)
  if (!P.c) {
    const onShell = shell(P);
    let gaps = 0;
    forBox(0, W, 0, D, 0, H, (x, y, z) => {
      if (onShell(x, y, z) && !cells.has(`${x},${y},${z}`)) { gaps++; if (gaps < 4) err(`Lücke bei (${x},${y},${z})`); }
    });
    if (gaps) err(`${gaps} Lückenzellen`);
  }

  // 4. Beweglicher Deckel: darf beim Öffnen nirgends anstoßen
  const lid = parts.find((p) => p.id === 'top');
  const others = parts.filter((p) => p !== lid);
  const hits = (x, y, z) => others.some((p) => {
    const [u, v, w] = toLocal(p.pose, x, y, z);
    return w > 0 && w < t && inPart(p, u, v);
  });
  if (P.lid === 'slide') {
    // herausziehen nach vorn: in Halbmillimeter-Schritten bleibt das Raster gleich
    for (const s of [0.5, 5, 20, D / 2, D - 3 * t]) {
      let n = 0;
      for (const [key, id] of cells) {
        if (id !== 'top') continue;
        const [x, y, z] = key.split(',').map(Number);
        const o = cells.get(`${x},${y - Math.round(s * 2) / 2},${z}`);
        if (o && o !== 'top') n++;
      }
      if (n) err(`Schiebedeckel stößt nach ${s} mm an (${n} Zellen)`);
    }
  }
  if (P.lid === 'hinge') {
    // aufklappen um die Zapfenachse; geprüft wird der hintere Bereich des Deckels
    const yp = D - t - Math.SQRT1_2 * t - (P.c || 0), zp = H - 1.5 * t;
    for (const deg of [10, 30, 45, 60, 75, 90]) {
      const a = deg * Math.PI / 180;
      let n = 0;
      forBox(0, W, yp - 3 * t, D, H - 2 * t, H - t, (x, y, z) => {
        const [u, v] = toLocal(lid.pose, x, y, z);
        if (!inPart(lid, u, v)) return;
        const dy = y - yp, dz = z - zp;
        if (hits(x, yp + dy * Math.cos(a) + dz * Math.sin(a), zp - dy * Math.sin(a) + dz * Math.cos(a))) n++;
      });
      if (n) err(`Klappdeckel stößt bei ${deg}° an (${n} Punkte)`);
    }
  }

  console.log(`${fail ? '✗' : '✓'} ${name}: ${parts.length} Teile, ${cells.size} Zellen${warnings.length ? ', Warnungen: ' + warnings.join(' | ') : ''}`);
  return fail;
}

const base = { W: 120, D: 80, H: 60, t: 3, f: 10, k: 0 };
let bad = 0;
bad += run('offen', { ...base, closed: false, dividers: [] });
bad += run('geschlossen', { ...base, closed: true, dividers: [] });
bad += run('offen + 2 Längswände', { ...base, closed: false, dividers: [{ id: 1, dir: 'x', pos: 40 }, { id: 2, dir: 'x', pos: 80 }] });
bad += run('offen + Kreuz', { ...base, closed: false, dividers: [{ id: 1, dir: 'x', pos: 60 }, { id: 2, dir: 'y', pos: 40 }] });
bad += run('geschlossen + Kreuz', { ...base, closed: true, dividers: [{ id: 1, dir: 'x', pos: 45 }, { id: 2, dir: 'y', pos: 30 }, { id: 3, dir: 'y', pos: 55 }] });
bad += run('krumme Maße', { W: 203, D: 101, H: 47, t: 3, f: 13, k: 0, closed: true, dividers: [{ id: 1, dir: 'x', pos: 100 }] });
bad += run('dünn 2 mm', { W: 100, D: 100, H: 40, t: 2, f: 8, k: 0, closed: false, dividers: [{ id: 1, dir: 'y', pos: 50 }] });
const cross = [{ id: 1, dir: 'x', pos: 45 }, { id: 2, dir: 'y', pos: 40 }];
for (const [lid, label] of [['lift', 'zum Abnehmen'], ['slide', 'Schiebedeckel'], ['hinge', 'Klappdeckel']]) {
  bad += run(`${label}`, { ...base, lid, c: 0, dividers: [] });
  bad += run(`${label} + Kreuz`, { ...base, lid, c: 0, dividers: cross });
  bad += run(`${label}, Spiel 0,3`, { ...base, lid, c: 0.3, dividers: cross });
  bad += run(`${label}, krumme Maße`, { W: 203, D: 101, H: 47, t: 3, f: 13, k: 0, lid, c: 0, dividers: [{ id: 1, dir: 'x', pos: 100 }] });
}
console.log(bad ? `\n${bad} Fehler` : '\nalles in Ordnung');
console.log('evenPositions(120,3,2):', G.evenPositions(120, 3, 2));
process.exit(bad ? 1 : 0);
