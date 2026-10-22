// STL lesen, drehen, Schnitt mit Ebenen.  Aufruf: node test/stl.test.js
const S = require('../web/static/stl.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log('   ✗', msg); } };
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

// Würfel 10 × 20 × 30 mm ab (0, 0, 0) als 12 Dreiecke
function cube(w, d, h) {
  const v = (x, y, z) => [x * w, y * d, z * h];
  const quads = [[[0,0,0],[1,0,0],[1,1,0],[0,1,0]], [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], [[0,0,0],[1,0,0],[1,0,1],[0,0,1]],
                 [[0,1,0],[1,1,0],[1,1,1],[0,1,1]], [[0,0,0],[0,1,0],[0,1,1],[0,0,1]], [[1,0,0],[1,1,0],[1,1,1],[1,0,1]]];
  const tris = [];
  for (const q of quads) tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
  return tris.map((t) => t.map((p) => v(...p)));
}
const tris = cube(10, 20, 30);

// 1. binär
const bin = new ArrayBuffer(84 + tris.length * 50);
const dv = new DataView(bin);
dv.setUint32(80, tris.length, true);
tris.forEach((t, i) => t.forEach((p, k) => p.forEach((c, a) => dv.setFloat32(84 + i * 50 + 12 + (k * 3 + a) * 4, c, true))));
const pb = S.parse(bin);
ok(pb.length === 12 * 9, 'binär: 12 Dreiecke');
const b = S.bounds(pb);
ok(same(b.min, [0, 0, 0]) && same(b.max, [10, 20, 30]), 'binär: Quader');

// 2. ASCII (auch "solid" mit Leerzeilen und Exponenten)
const ascii = 'solid wuerfel\n' + tris.map((t) => ' facet normal 0 0 0\n  outer loop\n' +
  t.map((p) => `   vertex ${p.map((c) => c.toExponential()).join(' ')}\n`).join('') + '  endloop\n endfacet\n').join('') + 'endsolid\n';
const pa = S.parse(new TextEncoder().encode(ascii).buffer);
ok(pa.length === pb.length && pa.every((v, i) => v === pb[i]), 'ASCII = binär');
let threw = false;
try { S.parse(new TextEncoder().encode('kein stl').buffer); } catch (e) { threw = true; }
ok(threw, 'ungültige Datei wird abgelehnt');

// 3. Drehen: viermal um jede Achse = keine Drehung; Quader nach Drehung
for (const ax of ['x', 'y', 'z']) {
  let R = S.ID;
  for (let i = 0; i < 4; i++) R = S.rotate(R, ax);
  ok(same(R, S.ID), `4 × 90° um ${ax}`);
}
const rb = S.rotatedBounds(S.rotate(S.ID, 'x'), b);     // y → z, z → −y
ok(same(rb.min, [0, -30, 0]) && same(rb.max, [10, 0, 20]), 'Quader nach Drehung um x');

// 4. Normalen zeigen nach außen und sind Einheitsvektoren
const il = S.interleave(pb);
ok(il.length === pb.length * 2, 'verschränkt');
ok(Math.abs(Math.hypot(il[3], il[4], il[5]) - 1) < 1e-6, 'Normale normiert');

// 5. Schnitt mit Ebene: Würfel bei x ∈ [0, 10]
ok(S.hitsPlane(pb, S.ID, [0, 0, 0], 0, 5, [[0, 20], [0, 30]]), 'Ebene x=5 schneidet');
ok(!S.hitsPlane(pb, S.ID, [0, 0, 0], 0, 12, [[0, 20], [0, 30]]), 'Ebene x=12 schneidet nicht');
ok(!S.hitsPlane(pb, S.ID, [0, 0, 0], 0, 5, [[25, 40], [0, 30]]), 'Ebene x=5 außerhalb des Rechtecks');
ok(S.hitsPlane(pb, S.ID, [100, 0, 0], 0, 105, [[0, 20], [0, 30]]), 'verschoben');

// 6. Schatten auf eine Vorderwand (y ∈ [0, 3], Oberkante z = 60): Würfel bei x 5..15, y 13..33, z 3..33
const front = { o: [0, 0, 60], U: [1, 0, 0], V: [0, 0, -1], N: [0, 1, 0] };
const sh = S.shadow(pb, S.ID, [5, 13, 3], front, 3, 100, 60, 2);
let px = 0, dmin = Infinity, u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
sh.depth.forEach((d, i) => {
  if (!isFinite(d)) return;
  px++; dmin = Math.min(dmin, d);
  const c = i % sh.cols, r = Math.floor(i / sh.cols);
  u0 = Math.min(u0, c); u1 = Math.max(u1, c); v0 = Math.min(v0, r); v1 = Math.max(v1, r);
});
ok(sh.cols === 200 && sh.rows === 120, 'Schatten: Bildgröße');
ok(px === 10 * 30 * 4, `Schatten: Fläche 10 × 30 mm (${px / 4} mm²)`);
ok(Math.abs(dmin - 10) < 1e-6, `Schatten: nächster Abstand 10 mm (${dmin})`);
ok(u0 === 10 && u1 === 29 && v0 === 54 && v1 === 113, `Schatten: Lage u ${u0}..${u1}, v ${v0}..${v1}`);
// Rückwand (Normale zeigt nach innen gespiegelt): Abstand bleibt positiv
const back = { o: [100, 47, 60], U: [-1, 0, 0], V: [0, 0, -1], N: [0, 1, 0] };
let dBack = Infinity;
S.shadow(pb, S.ID, [5, 13, 3], back, 3, 100, 60, 2).depth.forEach((d) => { dBack = Math.min(dBack, d); });
ok(Math.abs(dBack - 14) < 1e-6, `Schatten Rückwand: Abstand 14 mm (${dBack})`);

console.log(bad ? `\n${bad} Fehler` : 'alles in Ordnung');
process.exit(bad ? 1 : 0);
