// Ausschnitte und Vorlagen prüfen.  Aufruf: node test/features.test.js
const F = require('../web/static/features.js');

let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log('   ✗', msg); } };
const near = (a, b) => Math.abs(a - b) < 1e-6;

// 1. Vorlagen: eindeutige ids, Schnitte überlappen sich nicht und liegen im Hilfsrahmen
const ids = new Set();
for (const t of F.TEMPLATES) {
  ok(!ids.has(t.id), `doppelte Vorlage ${t.id}`);
  ids.add(t.id);
  const f = { type: 'tpl', tpl: t.id, x: 0, y: 0, rot: 0 };
  const cuts = F.shapes(f).filter((s) => !s.guide);
  const frame = F.shapes(f).find((s) => s.guide);
  ok(cuts.length > 0, `${t.id}: keine Schnitte`);
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      const [ax, ay] = F.halfExtent(cuts[i]), [bx, by] = F.halfExtent(cuts[j]);
      const hit = Math.abs(cuts[i].x - cuts[j].x) < ax + bx && Math.abs(cuts[i].y - cuts[j].y) < ay + by;
      // Kreis neben Kreis: genauer über den Abstand
      const circles = cuts[i].k === 'circle' && cuts[j].k === 'circle';
      const overlap = circles ? Math.hypot(cuts[i].x - cuts[j].x, cuts[i].y - cuts[j].y) < (cuts[i].d + cuts[j].d) / 2 : hit;
      ok(!overlap, `${t.id}: Schnitt ${i} und ${j} überlappen`);
    }
    if (frame) {
      const [ex, ey] = F.halfExtent(cuts[i]);
      ok(Math.abs(cuts[i].x) + ex <= frame.w / 2 + 1e-6 && Math.abs(cuts[i].y) + ey <= frame.h / 2 + 1e-6, `${t.id}: Schnitt ${i} außerhalb des Rahmens`);
    }
  }
}

// 2. Drehen und Spiegeln
const r = F.shapes({ type: 'rect', x: 10, y: 20, w: 8, h: 2, r: 0, rot: 90 })[0];
ok(near(r.x, 10) && near(r.y, 20) && r.rot === 90, 'Rechteck gedreht');
const [ex, ey] = F.halfExtent(r);
ok(near(ex, 1) && near(ey, 4), 'Ausdehnung gedrehtes Rechteck');
const pi = { type: 'tpl', tpl: 'pi', x: 0, y: 0, rot: 30 };   // Bohrbild nicht mittig → Spiegeln sichtbar
const a = F.shapes(pi), b = F.shapes({ ...pi, rot: -30, flip: true });
ok(a.every((s, i) => near(s.x, -b[i].x) && near(s.y, b[i].y)), 'Spiegeln (Gegenseite) = x gespiegelt');

// 3. Lochraster
ok(F.shapes({ type: 'grid', x: 0, y: 0, d: 3, nx: 5, ny: 4, px: 6, py: 6, rot: 0 }).length === 20, 'Raster 5×4');
const hex = F.shapes({ type: 'grid', x: 0, y: 0, d: 3, nx: 5, ny: 4, px: 6, py: 5, rot: 0, hex: true });
ok(hex.length === 5 + 4 + 5 + 4, 'versetztes Raster');
const lb = F.localBox({ type: 'grid', x: 0, y: 0, d: 3, nx: 5, ny: 4, px: 6, py: 6, rot: 0 });
ok(near(lb.x1 - lb.x0, 27) && near(lb.y1 - lb.y0, 21), 'Rastergröße');

// 4. Vielecke: Langloch ohne doppelte Punkte, Pfad endet geschlossen
const sl = F.loop(F.shapes({ type: 'slot', x: 0, y: 0, w: 20, h: 6, rot: 0 })[0]);
ok(sl.every((p, i) => { const q = sl[(i + 1) % sl.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9; }), 'Langloch ohne doppelte Punkte');
ok(/Z$/.test(F.rectPath({ k: 'rect', x: 0, y: 0, w: 10, h: 4, r: 1, rot: 15 })), 'Pfad geschlossen');

console.log(`${F.TEMPLATES.length} Vorlagen geprüft`);
console.log(bad ? `\n${bad} Fehler` : 'alles in Ordnung');
process.exit(bad ? 1 : 0);
