/* Boxlab – Ausschnitte: Loch, Rechteck, Langloch, Lochraster und Bauteil-Vorlagen.
 *
 * Ein Element f liegt mit seiner Mitte bei (f.x, f.y) im Teil, ist um f.rot Grad gedreht
 * (SVG-Richtung) und mit f.flip gespiegelt (für die Gegenseite). shapes(f) zerlegt es in
 * einfache Formen in Teilkoordinaten: Kreise und gedrehte, ggf. abgerundete Rechtecke.
 * Formen mit guide:true sind nur Hilfslinien (z. B. Umriss einer Platine), kein Schnitt.
 * Alle Formen sind konvex – darauf verlässt sich die 3D-Vorschau.
 *
 * Die Vorlagenmaße sind Richtwerte für die Frontplatte; vor dem Lasern am Bauteil prüfen.
 */
(function (root) {
  'use strict';

  const C = (x, y, d) => ({ k: 'circle', x, y, d });
  const R = (x, y, w, h, r) => ({ k: 'rect', x, y, w, h, r: r || 0, rot: 0 });
  const guide = (s) => ({ ...s, guide: true });
  /** Vier Löcher im Rechteck dx × dy um (0, 0). */
  const holes4 = (dx, dy, d) => [C(-dx / 2, -dy / 2, d), C(dx / 2, -dy / 2, d), C(-dx / 2, dy / 2, d), C(dx / 2, dy / 2, d)];
  /** Lüfter: Öffnung, vier Schraublöcher, Rahmen als Hilfslinie. */
  const fan = (size, pitch, d) => [C(0, 0, size - 2), ...holes4(pitch, pitch, d), guide(R(0, 0, size, size, 2))];
  /** Platine w × h: Löcher [x, y] in mm ab der linken unteren Ecke (wie in den Datenblättern). */
  const board = (w, h, d, pts) => [...pts.map(([x, y]) => C(x - w / 2, h / 2 - y, d)), guide(R(0, 0, w, h, 2))];

  const TEMPLATES = [
    { id: 'usbc',     group: 'Anschlüsse', name: 'USB-C (Stecker)',            shapes: [R(0, 0, 13, 7, 3)] },
    { id: 'microusb', group: 'Anschlüsse', name: 'Micro-USB (Stecker)',        shapes: [R(0, 0, 11, 8, 1.5)] },
    { id: 'usba',     group: 'Anschlüsse', name: 'USB-A (Buchse)',             shapes: [R(0, 0, 13.5, 6, 0.5)] },
    { id: 'dc',       group: 'Anschlüsse', name: 'Hohlbuchse Einbau (M8)',     shapes: [C(0, 0, 8.2)] },
    { id: 'jack',     group: 'Anschlüsse', name: 'Klinkenbuchse 3,5 mm (M6)',  shapes: [C(0, 0, 6.2)] },
    { id: 'gland12',  group: 'Anschlüsse', name: 'Kabelverschraubung M12',     shapes: [C(0, 0, 12.2)] },
    { id: 'gland16',  group: 'Anschlüsse', name: 'Kabelverschraubung M16',     shapes: [C(0, 0, 16.2)] },

    { id: 'btn12',    group: 'Bedienelemente', name: 'Taster 12 mm',           shapes: [C(0, 0, 12.2)] },
    { id: 'btn16',    group: 'Bedienelemente', name: 'Taster 16 mm',           shapes: [C(0, 0, 16.2)] },
    { id: 'btn19',    group: 'Bedienelemente', name: 'Taster 19 mm',           shapes: [C(0, 0, 19.2)] },
    { id: 'btn22',    group: 'Bedienelemente', name: 'Taster 22 mm',           shapes: [C(0, 0, 22.3)] },
    { id: 'toggle',   group: 'Bedienelemente', name: 'Kippschalter Mini (M6)', shapes: [C(0, 0, 6.3)] },
    { id: 'kcd1',     group: 'Bedienelemente', name: 'Wippschalter KCD1',      shapes: [R(0, 0, 19.2, 13.2, 0)] },
    { id: 'pot',      group: 'Bedienelemente', name: 'Potentiometer (M7)',     shapes: [C(0, 0, 7.2)] },
    { id: 'led3',     group: 'Bedienelemente', name: 'LED 3 mm',               shapes: [C(0, 0, 3.1)] },
    { id: 'led5',     group: 'Bedienelemente', name: 'LED 5 mm',               shapes: [C(0, 0, 5.1)] },

    { id: 'lcd1602',  group: 'Anzeigen', name: 'LCD 16×2 (1602)',
      shapes: [R(0, 0, 71.5, 24.5, 0), ...holes4(75, 31, 3.2), guide(R(0, 0, 80, 36, 1))] },
    { id: 'oled096',  group: 'Anzeigen', name: 'OLED 0,96″ (I²C-Modul)',
      shapes: [R(0, -1, 24, 12.5, 0.5), ...holes4(23.5, 23.8, 2.2), guide(R(0, 0, 27.3, 27.8, 1))] },
    { id: 'oled13',   group: 'Anzeigen', name: 'OLED 1,3″ (I²C-Modul)',
      shapes: [R(0, -1.5, 31, 16.5, 0.5), ...holes4(30.4, 28.5, 3.1), guide(R(0, 0, 35.4, 33.5, 1))] },

    { id: 'fan30',    group: 'Lüfter', name: 'Lüfter 30 mm', shapes: fan(30, 24, 3.2) },
    { id: 'fan40',    group: 'Lüfter', name: 'Lüfter 40 mm', shapes: fan(40, 32, 3.4) },
    { id: 'fan50',    group: 'Lüfter', name: 'Lüfter 50 mm', shapes: fan(50, 40, 4.3) },
    { id: 'fan60',    group: 'Lüfter', name: 'Lüfter 60 mm', shapes: fan(60, 50, 4.3) },
    { id: 'fan80',    group: 'Lüfter', name: 'Lüfter 80 mm', shapes: fan(80, 71.5, 4.3) },

    { id: 'pi',       group: 'Platinen (Bohrbild)', name: 'Raspberry Pi 3/4/5',
      shapes: board(85, 56, 2.75, [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]) },
    { id: 'pizero',   group: 'Platinen (Bohrbild)', name: 'Raspberry Pi Zero',
      shapes: board(65, 30, 2.75, [[3.5, 3.5], [61.5, 3.5], [3.5, 26.5], [61.5, 26.5]]) },
    { id: 'pico',     group: 'Platinen (Bohrbild)', name: 'Raspberry Pi Pico',
      shapes: board(21, 51, 2.1, [[4.8, 2], [16.2, 2], [4.8, 49], [16.2, 49]]) },
  ];
  const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

  /** Lochraster: nx × ny Löcher im Abstand px/py; hex = jede zweite Reihe versetzt (eins weniger). */
  function gridShapes(f) {
    const out = [];
    const nx = Math.max(1, Math.round(f.nx)), ny = Math.max(1, Math.round(f.ny));
    for (let j = 0; j < ny; j++) {
      const off = f.hex && j % 2 === 1;
      const n = off ? nx - 1 : nx;
      for (let i = 0; i < n; i++) out.push(C((i - (nx - 1) / 2) * f.px + (off ? f.px / 2 : 0), (j - (ny - 1) / 2) * f.py, f.d));
    }
    return out;
  }

  /** Formen in Elementkoordinaten (ungedreht, Mitte = 0, 0), gespiegelt falls f.flip. */
  function localShapes(f) {
    let s;
    switch (f.type) {
      case 'hole': s = [C(0, 0, f.d)]; break;
      case 'rect': s = [R(0, 0, f.w, f.h, f.r)]; break;
      case 'slot': s = [R(0, 0, f.w, f.h, Math.min(f.w, f.h) / 2)]; break;
      case 'grid': s = gridShapes(f); break;
      case 'tpl':  s = (BY_ID.get(f.tpl) || { shapes: [] }).shapes; break;
      default:     s = [];
    }
    return f.flip ? s.map((q) => ({ ...q, x: -q.x, rot: -(q.rot || 0) })) : s;
  }

  /** Halbe Ausdehnung einer Form entlang x und y (gedrehte Rechtecke umschließend). */
  function halfExtent(s) {
    if (s.k === 'circle') return [s.d / 2, s.d / 2];
    const a = (s.rot || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), n = Math.abs(Math.sin(a));
    return [c * s.w / 2 + n * s.h / 2, n * s.w / 2 + c * s.h / 2];
  }

  /** Alle Formen des Elements in Teilkoordinaten. */
  function shapes(f) {
    const a = (f.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return localShapes(f).map((q) => ({
      ...q,
      x: f.x + q.x * c - q.y * s,
      y: f.y + q.x * s + q.y * c,
      rot: q.k === 'rect' ? (q.rot || 0) + (f.rot || 0) : 0,
    }));
  }

  /** Umschließendes Rechteck im Elementkoordinatensystem (vor der Drehung). */
  function localBox(f) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of localShapes(f)) {
      const [ex, ey] = halfExtent(q);
      x0 = Math.min(x0, q.x - ex); x1 = Math.max(x1, q.x + ex);
      y0 = Math.min(y0, q.y - ey); y1 = Math.max(y1, q.y + ey);
    }
    return isFinite(x0) ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
  }

  const rad = (s) => Math.max(0, Math.min(s.r || 0, s.w / 2, s.h / 2));

  /** SVG-Pfad eines Rechtecks (gedreht, Ecken gerundet) in Teilkoordinaten. */
  function rectPath(s, fmt) {
    const n = fmt || ((v) => Math.round(v * 1000) / 1000);
    const a = (s.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    const P = (u, v) => n(s.x + u * c - v * sn) + ' ' + n(s.y + u * sn + v * c);
    const w = s.w / 2, h = s.h / 2, r = rad(s);
    if (!r) return `M${P(-w, -h)}L${P(w, -h)}L${P(w, h)}L${P(-w, h)}Z`;
    const A = (u, v) => `A${n(r)} ${n(r)} 0 0 1 ${P(u, v)}`;
    return `M${P(-w + r, -h)}L${P(w - r, -h)}${A(w, -h + r)}L${P(w, h - r)}${A(w - r, h)}` +
      `L${P(-w + r, h)}${A(-w, h - r)}L${P(-w, -h + r)}${A(-w + r, -h)}Z`;
  }

  /** Form als Vieleck (für die 3D-Vorschau). */
  function loop(s) {
    const pts = [];
    if (s.k === 'circle') {
      const r = s.d / 2, n = Math.max(12, Math.min(48, Math.round(s.d * 3)));
      for (let i = 0; i < n; i++) { const t = (i / n) * 2 * Math.PI; pts.push([s.x + r * Math.cos(t), s.y + r * Math.sin(t)]); }
      return pts;
    }
    const a = (s.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    const w = s.w / 2, h = s.h / 2, r = rad(s);
    const local = [];
    if (!r) local.push([-w, -h], [w, -h], [w, h], [-w, h]);
    else {
      const seg = 8;
      const corners = [[w - r, -h + r, -90], [w - r, h - r, 0], [-w + r, h - r, 90], [-w + r, -h + r, 180]];
      for (const [cx, cy, start] of corners) {
        for (let i = 0; i <= seg; i++) {
          const t = (start + (90 * i) / seg) * Math.PI / 180;
          local.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
        }
      }
    }
    for (const [u, v] of local) {
      const q = pts[pts.length - 1];
      if (!q || Math.abs(q[0] - u) + Math.abs(q[1] - v) > 1e-9) pts.push([u, v]);
    }
    return pts.map(([u, v]) => [s.x + u * c - v * sn, s.y + u * sn + v * c]);
  }

  const api = { TEMPLATES, template: (id) => BY_ID.get(id) || null, shapes, localBox, halfExtent, rectPath, loop };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxFeat = api;
})(typeof window !== 'undefined' ? window : globalThis);
