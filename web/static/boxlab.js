/* Boxlab – Editor für Lasercut-Boxen (Browser).
 * Geometrie steckt in geometry.js (BoxGeo); hier: Modell, Oberfläche, SVG-Ansicht, Export. */
'use strict';

// ══════════════════════════════════════════════════════════════
//  Modell
// ══════════════════════════════════════════════════════════════
const G = window.BoxGeo;
const FE = window.BoxFeat;
const byId = (id) => document.getElementById(id);
const STORE_KEY = 'boxlab.model.v1';
const DISPLAY_GAP = 80;                 // Abstand der Teile in der Ansicht (mm), Platz für Maße

const defaultModel = () => ({
  box: { W: 160, D: 100, H: 60, t: 3, f: 12, k: 0, lid: 'none', c: 0.2, measure: 'outer' },   // lid: siehe LID_INFO
  dividers: [],        // { id, dir:'x'|'y', pos }   pos = Mitte der Wand ab Außenkante
  model: null,         // STL in der Box: { name, R, x, y, z, gap } – Geometrie siehe STL (nicht gespeichert)
  features: [],        // { id, part, type, x, y, rot, flip, … }   x,y = Mitte im Teil, Formen: features.js
                       //   hole: d · rect: w, h, r · slot: w, h · grid: d, nx, ny, px, py, hex · tpl: tpl
  nextId: 1,
});

let M = defaultModel();
let BUILD = { parts: [], warnings: [] };
let BUILD3D = { parts: [], warnings: [] };   // ohne Schnittfuge – für die 3D-Vorschau
let PARTS = new Map();
let SHEET = { w: 0, h: 0 };

const round2 = (v) => Math.round(v * 100) / 100;
const num = (v) => String(round2(v)).replace('.', ',');
const parseNum = (s) => parseFloat(String(s).trim().replace(',', '.'));

/** Deckelarten: Name und kurze Erklärung für die Seitenleiste. */
const LID_INFO = {
  none:  { name: 'offen',          hint: 'Ohne Deckel, Wände oben glatt.' },
  fixed: { name: 'geschlossen',    hint: 'Deckel fest mit Zinken verbunden – zum Verkleben.' },
  lift:  { name: 'Deckel zum Abnehmen', hint: 'Liegt auf den Wänden. Den Einsatz unter den Deckel kleben – er hält ihn in Position.' },
  slide: { name: 'Schiebedeckel',  hint: 'Läuft in Schlitzen der Seitenwände und lässt sich nach vorn herausziehen. Vorderwand ist dafür niedriger.' },
  hinge: { name: 'Klappdeckel',    hint: 'Zapfen am Deckel drehen in runden Löchern der Seitenwände. Deckel beim Zusammenbauen mit einsetzen.' },
};
/** Ältere Dateien: closed:true/false → lid; fehlendes Spiel ergänzen. */
function normBox(b) {
  if (!LID_INFO[b.lid]) b.lid = b.closed ? 'fixed' : 'none';
  delete b.closed;
  if (!(b.c >= 0)) b.c = 0.2;
  return b;
}

/** Außenmaße aus den eingegebenen Maßen (außen oder innen). */
function outerDims() {
  const b = M.box, inner = b.measure === 'inner';
  return {
    W: b.W + (inner ? 2 * b.t : 0),
    D: b.D + (inner ? 2 * b.t : 0),
    H: b.H + (inner ? G.heightLoss(b.lid, b.t, b.c) : 0),
    t: b.t,
  };
}
function setOuter(axis, v) {
  const b = M.box, inner = b.measure === 'inner';
  const off = !inner ? 0 : axis === 'H' ? G.heightLoss(b.lid, b.t, b.c) : 2 * b.t;
  b[axis] = round2(v - off);
}

function rebuild() {
  const P = { ...outerDims(), f: M.box.f, k: M.box.k, lid: M.box.lid, c: M.box.c, dividers: M.dividers };
  BUILD = G.build(P);
  BUILD3D = P.k ? G.build({ ...P, k: 0 }) : BUILD;
  SHEET = G.layout(BUILD.parts, DISPLAY_GAP);
  PARTS = new Map(BUILD.parts.map((p) => [p.id, p]));
  if (sel != null && !selFeature()) sel = null;
  if (hotPart && !PARTS.has(hotPart)) hotPart = null;
  sync3D();
  syncStl();
}

// ── Rückgängig / Wiederholen / Autosave ───────────────────────
let undoStack = [], redoStack = [];
function pushUndo() {
  undoStack.push(JSON.stringify(M));
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}
function restore(json) {
  M = JSON.parse(json);
  rebuild(); refresh();
}
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(M)); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(M)); restore(redoStack.pop()); }
function autosave() { try { localStorage.setItem(STORE_KEY, JSON.stringify(M)); } catch (e) { /* privater Modus */ } }

/** Nach jeder Änderung: neu berechnen, zeichnen, Seitenleiste abgleichen. */
function changed() { rebuild(); refresh(); autosave(); }
function refresh() { syncSidebar(); updateChrome(); scheduleRender(); highlight3D(); }

// ══════════════════════════════════════════════════════════════
//  Auswahl & Werkzeuge
// ══════════════════════════════════════════════════════════════
let sel = null;                       // id des markierten Elements
let hotPart = null;                   // angeklicktes Teil (in 2D und 3D hervorgehoben)
let tool = 'select';                  // 'select' | 'hole' | 'rect' | 'slot' | 'grid' | 'tpl'
let tplId = FE.TEMPLATES[0].id;       // gewählte Bauteil-Vorlage
const last = { d: 5, w: 10, h: 5 };  // zuletzt benutzte Größen
const selFeature = () => M.features.find((f) => f.id === sel && PARTS.has(f.part)) || null;

const TYPE_NAMES = { hole: 'Loch', rect: 'Rechteck', slot: 'Langloch', grid: 'Lochraster', tpl: 'Bauteil' };
const featName = (f) => (f.type === 'tpl' ? (FE.template(f.tpl) || {}).name || 'Bauteil' : TYPE_NAMES[f.type] || 'Element');
const toolName = (t) => (t === 'tpl' ? FE.template(tplId).name : TYPE_NAMES[t]);

function setTool(t) {
  tool = t;
  byId('sheet').className.baseVal = t === 'select' ? '' : 'tool-add';
  document.querySelectorAll('.palette-card').forEach((c) => c.classList.toggle('active', c.dataset.tool === t && t !== 'select'));
  if (t !== 'select') setStatus(`Auf ein Teil klicken, um „${toolName(t)}“ zu setzen`);
}
function select(id) {
  if (id != null && id !== sel) byId('sidebar-scroll').scrollTop = 0;
  if (id != null) hotPart = null;
  sel = id; refresh();
}
/** Ganzes Teil markieren (Klick auf eine Platte in 2D oder 3D); null hebt auf. */
function pickPart(id) {
  hotPart = id; sel = null; refresh();
  const p = id && PARTS.get(id);
  if (p) setStatus(`${p.name} · ${num(p.w)} × ${num(p.h)} mm`);
}

/** Startwerte je Art (Größen, die nicht zur Art gehören, stören nicht). */
function featureDefaults(type) {
  if (type === 'hole') return { d: last.d };
  if (type === 'rect') return { w: last.w, h: last.h, r: 0 };
  if (type === 'slot') return { w: 20, h: 6 };
  if (type === 'grid') return { d: 4, nx: 6, ny: 4, px: 6, py: 6, hex: false };
  return { tpl: tplId };
}
function addFeature(type, partId, x, y) {
  pushUndo();
  const f = { id: M.nextId++, part: partId, type, x: round2(x), y: round2(y), rot: 0, ...featureDefaults(type) };
  M.features.push(f);
  sel = f.id;
  setTool('select');
  changed();
  setStatus(`${featName(f)} gesetzt – Maße anklicken zum Ändern` + (type === 'hole' ? '' : ', Griff oben dreht'));
}
function deleteSelected() {
  const f = selFeature(); if (!f) return;
  pushUndo();
  M.features = M.features.filter((g) => g.id !== f.id);
  sel = null; changed();
}
function duplicateSelected() {
  const f = selFeature(); if (!f) return;
  pushUndo();
  const c = { ...f, id: M.nextId++, x: round2(f.x + 5), y: round2(f.y + 5) };
  M.features.push(c); sel = c.id; changed();
}
const OPPOSITE = { front: 'back', back: 'front', left: 'right', right: 'left', bottom: 'top', top: 'bottom' };
function copyToOpposite() {
  const f = selFeature(); if (!f) return;
  const opp = OPPOSITE[f.part], p = PARTS.get(opp);
  if (!p) { setStatus('Keine Gegenseite vorhanden'); return; }
  pushUndo();
  const c = { ...f, id: M.nextId++, part: opp, x: round2(p.w - f.x), rot: round2(-(f.rot || 0)), flip: !f.flip };
  M.features.push(c); sel = c.id; changed();
  setStatus('Auf ' + p.name + ' kopiert (gespiegelt)');
}
/** Element waagrecht ('x') oder senkrecht ('y') mittig auf sein Teil setzen. */
function centerSelected(axis) {
  const f = selFeature(); if (!f) return;
  const p = PARTS.get(f.part);
  pushUndo(); f[axis] = round2((axis === 'x' ? p.w : p.h) / 2); changed();
}
/** Lochraster oder Vorlage in einzelne Löcher/Rechtecke zerlegen. */
function explodeSelected() {
  const f = selFeature(); if (!f) return;
  pushUndo();
  const ids = [];
  for (const s of FE.shapes(f)) {
    if (s.guide) continue;
    const g = { id: M.nextId++, part: f.part, x: round2(s.x), y: round2(s.y), rot: 0 };
    if (s.k === 'circle') Object.assign(g, { type: 'hole', d: round2(s.d) });
    else Object.assign(g, { type: 'rect', w: round2(s.w), h: round2(s.h), r: round2(s.r), rot: round2(((s.rot % 360) + 360) % 360) });
    M.features.push(g); ids.push(g.id);
  }
  M.features = M.features.filter((g) => g.id !== f.id);
  sel = null; changed();
  setStatus(`${featName(f)} in ${ids.length} Einzelteile aufgelöst`);
}

/** Liegt das Element nicht vollständig im Teil? (Hilfslinien zählen nicht) */
function featBad(f) {
  const p = PARTS.get(f.part); if (!p) return false;
  return FE.shapes(f).some((s) => {
    if (s.guide) return false;
    const [ex, ey] = FE.halfExtent(s);
    return s.x - ex < -1e-6 || s.y - ey < -1e-6 || s.x + ex > p.w + 1e-6 || s.y + ey > p.h + 1e-6;
  });
}

// ══════════════════════════════════════════════════════════════
//  Maße ändern (Maßlinien und Felder)
// ══════════════════════════════════════════════════════════════
/** Wert für einen Maßschlüssel setzen. Rückgabe: true bei Erfolg. */
function applyDim(key, v) {
  if (!isFinite(v)) return false;
  const [kind, a, b] = key.split(':');
  if (kind === 'box') {
    if (v <= 0) return false;
    pushUndo(); setOuter(a, v); changed(); return true;
  }
  if (kind === 'div') {
    const d = M.dividers.find((x) => String(x.id) === a); if (!d) return false;
    pushUndo(); d.pos = round2(v); changed(); return true;
  }
  if (kind === 'f') {
    const f = M.features.find((x) => String(x.id) === a); if (!f) return false;
    if (['d', 'w', 'h', 'px', 'py'].includes(b) && v <= 0) return false;
    if (b === 'r' && v < 0) return false;
    if (b === 'nx' || b === 'ny') { v = Math.round(v); if (v < 1 || v > 50) return false; }
    pushUndo();
    if (b === 'rot') f.rot = round2(((v % 360) + 360) % 360);
    else {
      f[b] = round2(v);
      if (f.type === 'hole' || f.type === 'rect') { if (b === 'd' || b === 'w' || b === 'h') last[b] = f[b]; }
    }
    changed(); return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
//  Ansicht (Zoom/Pan) und Zeichnen
// ══════════════════════════════════════════════════════════════
const view = { x: 20, y: 40, s: 2 };
let showDims = true;
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function fitView() {
  const c = byId('canvas-container');
  const w = c.clientWidth, h = c.clientHeight;
  if (!w || !h || !SHEET.w) return;
  const pad = 70;
  view.s = Math.max(0.05, Math.min((w - 2 * pad) / SHEET.w, (h - 2 * pad - 30) / SHEET.h));
  view.x = (w - SHEET.w * view.s) / 2;
  view.y = (h - SHEET.h * view.s) / 2 + 10;
  scheduleRender();
}
function zoomAt(px, py, factor) {
  const ns = Math.max(0.05, Math.min(80, view.s * factor));
  const k = ns / view.s;
  view.x = px - (px - view.x) * k;
  view.y = py - (py - view.y) * k;
  view.s = ns;
  scheduleRender();
}
function toSheet(clientX, clientY) {
  const r = byId('sheet').getBoundingClientRect();
  return { x: (clientX - r.left - view.x) / view.s, y: (clientY - r.top - view.y) / view.s };
}
function partAt(sx, sy) {
  for (const p of BUILD.parts) {
    if (sx >= p.ox && sx <= p.ox + p.w && sy >= p.oy && sy <= p.oy + p.h) return p;
  }
  return null;
}

const pathOf = (pts) => 'M' + pts.map((p) => p[0].toFixed(3) + ' ' + p[1].toFixed(3)).join('L') + 'Z';
const rectPath = (r) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`;

/** Maßlinie zwischen zwei Punkten (Blattkoordinaten). o: edit, cls, tx, ty, anchor */
function dim(key, x1, y1, x2, y2, label, o) {
  o = o || {};
  const px = 1 / view.s, fs = 11 * px, tk = 4 * px;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-9;
  const nx = -dy / len, ny = dx / len;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const tx = o.tx != null ? o.tx : (horizontal ? mx : mx + 6 * px);
  const ty = o.ty != null ? o.ty : (horizontal ? my - 5 * px : my);
  const anchor = o.anchor || (horizontal ? 'middle' : 'start');
  const cls = 'dim' + (o.edit ? ' edit' : ' fixed') + (o.cls ? ' ' + o.cls : '');
  const data = o.edit ? ` data-dim="${key}" data-ax="${tx}" data-ay="${ty}" data-val="${o.val}"` : (key ? ` data-fixed="1"` : '');
  return `<g class="${cls}"${data}>` +
    `<line class="hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${14 * px}"/>` +
    `<line class="vis" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` +
    `<line class="vis" x1="${x1 - nx * tk}" y1="${y1 - ny * tk}" x2="${x1 + nx * tk}" y2="${y1 + ny * tk}"/>` +
    `<line class="vis" x1="${x2 - nx * tk}" y1="${y2 - ny * tk}" x2="${x2 + nx * tk}" y2="${y2 + ny * tk}"/>` +
    `<text x="${tx}" y="${ty}" font-size="${fs}" text-anchor="${anchor}" dominant-baseline="${horizontal && o.tx == null ? 'auto' : 'middle'}" stroke-width="${3 * px}">${label}</text></g>`;
}

function render() {
  const svg = byId('sheet');
  const px = 1 / view.s;
  let out = `<g transform="translate(${view.x} ${view.y}) scale(${view.s})">`;
  let dims = '';

  for (const p of BUILD.parts) {
    let d = pathOf(p.outline);
    out += `<g class="part" transform="translate(${p.ox} ${p.oy})">`;
    out += `<path class="plate${p.id === hotPart ? ' pick' : ''}" data-part="${p.id}" fill-rule="evenodd" d="${d}"/>`;
    for (const h of p.holes) {
      out += h.type === 'circle' ? `<circle class="slot" cx="${h.x}" cy="${h.y}" r="${h.d / 2}"/>` : `<path class="slot" d="${rectPath(h)}"/>`;
    }
    const shadow = SHADOW.get(p.id);
    if (shadow) out += `<image class="shadow" href="${shadow.url}" x="0" y="0" width="${p.w}" height="${p.h}" preserveAspectRatio="none"/>`;

    for (const f of M.features) {
      if (f.part !== p.id) continue;
      const bad = featBad(f) ? ' bad' : '';
      const on = f.id === sel ? ' sel' : '';
      out += `<g class="feat${on}${bad}" data-fid="${f.id}">`;
      // Trefferfläche: umschließendes Rechteck (mindestens 18 px), mit dem Element gedreht
      const b = FE.localBox(f);
      const padX = Math.max(4 * px, (18 * px - (b.x1 - b.x0)) / 2), padY = Math.max(4 * px, (18 * px - (b.y1 - b.y0)) / 2);
      out += `<rect class="hitc" x="${f.x + b.x0 - padX}" y="${f.y + b.y0 - padY}" width="${b.x1 - b.x0 + 2 * padX}" height="${b.y1 - b.y0 + 2 * padY}"` +
             ` fill="transparent" transform="rotate(${f.rot || 0} ${f.x} ${f.y})"/>`;
      for (const s of FE.shapes(f)) {
        const cls = s.guide ? 'guide' : 'shape';
        out += s.k === 'circle' ? `<circle class="${cls}" cx="${s.x}" cy="${s.y}" r="${s.d / 2}"/>` : `<path class="${cls}" d="${FE.rectPath(s)}"/>`;
      }
      out += '</g>';
    }
    out += `<text class="pname" x="${p.w / 2}" y="${p.h + 15 * px}" font-size="${11 * px}" text-anchor="middle">${p.name}` +
      (shadow ? `<tspan class="pdist"> · Modell ${num(shadow.dmin)} mm entfernt</tspan>` : '') + `</text>`;
    out += '</g>';

    if (showDims) dims += plateDims(p);
  }

  // Auswahl: Griff und Maße
  const f = selFeature();
  if (f) {
    const p = PARTS.get(f.part);
    if (f.type !== 'hole') {
      const [ex, ey] = handleAt(f, 0), [hx, hy] = handleAt(f, 22 * px);
      out += `<g transform="translate(${p.ox} ${p.oy})"><line class="hline" x1="${ex}" y1="${ey}" x2="${hx}" y2="${hy}"/>` +
             `<circle class="handle" data-handle="${f.id}" cx="${hx}" cy="${hy}" r="${7 * px}"/></g>`;
    }
    dims += featureDims(f, p);
  }
  out += dims + '</g>';
  svg.innerHTML = out;
}

/** Gesamtmaße eines Teils (anklickbar) und – am Boden – die Zwischenwand-Positionen. */
function plateDims(p) {
  const px = 1 / view.s;
  const o = (k, v) => ({ edit: !!k, val: v });
  let s = '';
  const ky = (axis) => (axis ? 'box:' + axis : null);
  const wk = ky(p.dims.w), hk = ky(p.dims.h);
  const ty = p.oy - 16 * px;
  s += dim(wk, p.ox, ty, p.ox + p.w, ty, num(p.w), o(wk, outerDims()[p.dims.w]));
  const tx = p.ox - 16 * px;
  s += dim(hk, tx, p.oy, tx, p.oy + p.h, num(p.h), { ...o(hk, hk ? outerDims()[p.dims.h] : 0), tx: tx - 6 * px, anchor: 'end' });

  if (p.id === 'bottom') {
    let i = 0, j = 0;
    for (const d of M.dividers) {
      if (d.dir === 'x') {
        const y = p.oy + p.h + (30 + 18 * i++) * px;
        s += dim('div:' + d.id, p.ox, y, p.ox + d.pos, y, num(d.pos), { edit: true, val: d.pos, cls: 'divdim' });
      } else {
        const x = p.ox + p.w + (18 + 38 * j++) * px;
        s += dim('div:' + d.id, x, p.oy + p.h, x, p.oy + p.h - d.pos, num(d.pos), { edit: true, val: d.pos, cls: 'divdim', tx: x + 6 * px });
      }
    }
  }
  return s;
}

/** Drehgriff: Punkt über der Oberkante des Elements (Abstand off), in Teilkoordinaten. */
function handleAt(f, off) {
  const b = FE.localBox(f), u = (b.x0 + b.x1) / 2, v = b.y0 - off;
  const a = (f.rot || 0) * Math.PI / 180;
  return [f.x + u * Math.cos(a) - v * Math.sin(a), f.y + u * Math.sin(a) + v * Math.cos(a)];
}

/** Maße des markierten Elements. Positionen in Teilkoordinaten, gezeichnet in Blattkoordinaten. */
function featureDims(f, p) {
  const px = 1 / view.s;
  const X = (x) => p.ox + x, Y = (y) => p.oy + y;
  const base = (k, v, extra) => ({ edit: true, val: v, cls: 'fdim', ...extra });
  let s = '';
  s += dim(`f:${f.id}:x`, X(0), Y(f.y), X(f.x), Y(f.y), num(f.x), base(null, f.x));
  s += dim(`f:${f.id}:y`, X(f.x), Y(0), X(f.x), Y(f.y), num(f.y), base(null, f.y));

  if (f.type === 'hole') {
    const r = f.d / 2, c = Math.SQRT1_2;
    s += dim(`f:${f.id}:d`, X(f.x - r * c), Y(f.y - r * c), X(f.x + r * c), Y(f.y + r * c), 'Ø ' + num(f.d),
             base(null, f.d, { tx: X(f.x + r * c) + 8 * px, ty: Y(f.y - r * c) - 8 * px, anchor: 'start' }));
  } else {
    if (f.type === 'rect' || f.type === 'slot') {
      const a = f.rot * Math.PI / 180, ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux;
      const w2 = f.w / 2, h2 = f.h / 2, off = 9 * px;
      const P = (du, dv) => [X(f.x + ux * du + vx * dv), Y(f.y + uy * du + vy * dv)];
      // Breite: oberhalb der Oberkante
      const [a1x, a1y] = P(-w2, -h2 - off), [a2x, a2y] = P(w2, -h2 - off), [at, au] = P(0, -h2 - off - 8 * px);
      s += dim(`f:${f.id}:w`, a1x, a1y, a2x, a2y, num(f.w), base(null, f.w, { tx: at, ty: au, anchor: 'middle' }));
      // Höhe: rechts der Seite
      const [b1x, b1y] = P(w2 + off, -h2), [b2x, b2y] = P(w2 + off, h2), [bt, bu] = P(w2 + off + 6 * px, 0);
      s += dim(`f:${f.id}:h`, b1x, b1y, b2x, b2y, num(f.h), base(null, f.h, { tx: bt, ty: bu, anchor: 'start' }));
    }
    // Winkel am Griff
    const [gx, gy] = handleAt(f, 22 * px), hx = X(gx), hy = Y(gy);
    const ang = `<g class="dim edit fdim" data-dim="f:${f.id}:rot" data-ax="${hx + 12 * px}" data-ay="${hy}" data-val="${f.rot || 0}">` +
      `<text x="${hx + 12 * px}" y="${hy}" font-size="${11 * px}" dominant-baseline="middle" stroke-width="${3 * px}">${num(f.rot || 0)}°</text></g>`;
    s += ang;
  }
  return s;
}

// ══════════════════════════════════════════════════════════════
//  Maß-Eingabe (Klick auf eine Maßlinie)
// ══════════════════════════════════════════════════════════════
let editKey = null;
function openDimEdit(key, ax, ay, val) {
  const inp = byId('dim-edit');
  editKey = key;
  inp.hidden = false;
  inp.value = key.endsWith(':rot') ? String(round2(val)).replace('.', ',') : num(val);
  inp.style.left = Math.max(4, view.x + ax * view.s - 43) + 'px';
  inp.style.top = Math.max(4, view.y + ay * view.s - 16) + 'px';
  inp.focus(); inp.select();
}
function closeDimEdit(commit) {
  const inp = byId('dim-edit');
  if (inp.hidden) return;
  const key = editKey;
  editKey = null;
  inp.hidden = true;
  if (commit && key) {
    const v = parseNum(inp.value);
    if (!applyDim(key, v)) setStatus('Ungültiger Wert');
  }
}

// ══════════════════════════════════════════════════════════════
//  Zeiger-Eingaben auf der Zeichenfläche
// ══════════════════════════════════════════════════════════════
const pointers = new Map();
let gesture = null;     // aktuelle Aktion: pan | drag | rotate | pinch

function snapv(v) {
  const g = parseFloat(byId('grid-size').value);
  return byId('toggle-snap').checked && g > 0 ? Math.round(v / g) * g : v;
}

function initCanvas() {
  const svg = byId('sheet');

  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-dim]')) { closeDimEdit(true); return; }   // Klick folgt
    closeDimEdit(true);
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) { startPinch(); return; }

    const handle = e.target.closest('[data-handle]');
    const featEl = e.target.closest('[data-fid]');
    const pt = toSheet(e.clientX, e.clientY);

    if (handle) {
      gesture = { type: 'rotate', rot0: (selFeature() || {}).rot, undone: false };
    } else if (featEl && tool === 'select') {
      const f = M.features.find((g) => g.id === +featEl.dataset.fid);
      if (f) {
        select(f.id);
        gesture = { type: 'drag', id: f.id, sx: pt.x, sy: pt.y, fx: f.x, fy: f.y, undone: false };
      }
    } else if (tool !== 'select') {
      const p = partAt(pt.x, pt.y);
      if (p) addFeature(tool, p.id, snapv(pt.x - p.ox), snapv(pt.y - p.oy));
      else setStatus('Bitte auf ein Teil klicken');
    } else {
      gesture = { type: 'pan', x: e.clientX, y: e.clientY, sx: pt.x, sy: pt.y, moved: false };
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;

    if (gesture.type === 'pinch') { movePinch(); return; }
    if (gesture.type === 'pan') {
      const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
      if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
      gesture.moved = true;
      view.x += dx; view.y += dy; gesture.x = e.clientX; gesture.y = e.clientY;
      svg.classList.add('panning');
      scheduleRender();
      return;
    }
    const f = selFeature(); if (!f) return;
    const p = PARTS.get(f.part), pt = toSheet(e.clientX, e.clientY);
    if (gesture.type === 'drag') {
      const nx = round2(snapv(gesture.fx + pt.x - gesture.sx)), ny = round2(snapv(gesture.fy + pt.y - gesture.sy));
      if (nx === f.x && ny === f.y) return;
      if (!gesture.undone) { const keep = { x: f.x, y: f.y }; f.x = gesture.fx; f.y = gesture.fy; pushUndo(); f.x = keep.x; f.y = keep.y; gesture.undone = true; }
      f.x = nx; f.y = ny;
    } else if (gesture.type === 'rotate') {
      let deg = Math.atan2(pt.x - (p.ox + f.x), -(pt.y - (p.oy + f.y))) * 180 / Math.PI;
      deg = e.altKey ? deg : Math.round(deg / 5) * 5;
      deg = round2(((deg % 360) + 360) % 360);
      if (deg === f.rot) return;
      if (!gesture.undone) { f.rot = gesture.rot0; pushUndo(); gesture.undone = true; }
      f.rot = deg;
    }
    syncProps(); scheduleRender(); sync3D();
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    svg.classList.remove('panning');
    if (gesture && gesture.type === 'pan' && !gesture.moved) {
      const p = partAt(gesture.sx, gesture.sy);
      if (p || sel != null || hotPart) pickPart(p ? p.id : null);
    }
    if (gesture && (gesture.type === 'drag' || gesture.type === 'rotate') && gesture.undone) { rebuild(); refresh(); autosave(); }
    if (pointers.size < 2 && gesture && gesture.type === 'pinch') gesture = null;
    if (!pointers.size) gesture = null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  svg.addEventListener('click', (e) => {
    const el = e.target.closest('[data-dim]');
    if (el) openDimEdit(el.dataset.dim, +el.dataset.ax, +el.dataset.ay, +el.dataset.val);
    else if (e.target.closest('[data-fixed]')) setStatus('Dieses Maß ergibt sich aus Box-Höhe und Materialstärke');
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(e.clientX - r.left, e.clientY - r.top, f);
  }, { passive: false });

  byId('zoom-in').onclick = () => { const c = byId('canvas-container'); zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.3); };
  byId('zoom-out').onclick = () => { const c = byId('canvas-container'); zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.3); };
  window.addEventListener('resize', scheduleRender);

  const inp = byId('dim-edit');
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeDimEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDimEdit(false); }
  });
  inp.addEventListener('blur', () => closeDimEdit(true));
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  gesture = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
function movePinch() {
  const [a, b] = [...pointers.values()]; if (!b) return;
  const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const r = byId('sheet').getBoundingClientRect();
  view.x += mx - gesture.mx; view.y += my - gesture.my;
  if (gesture.d > 0) zoomAt(mx - r.left, my - r.top, d / gesture.d);
  gesture.d = d; gesture.mx = mx; gesture.my = my;
  scheduleRender();
}

// ══════════════════════════════════════════════════════════════
//  Seitenleiste
// ══════════════════════════════════════════════════════════════
const ICONS = {
  select: '<svg class="palette-shape" width="34" height="34" viewBox="0 0 34 34"><path d="M9 6l0 19 5-5 4 8 3-1.5-4-8 7 0z" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  hole:   '<svg class="palette-shape" width="34" height="34" viewBox="0 0 34 34"><rect x="3" y="5" width="28" height="24" rx="3" fill="#334155" stroke="#94a3b8"/><circle cx="17" cy="17" r="6.5" fill="#1e293b" stroke="#5eead4" stroke-width="2"/></svg>',
  rect:   '<svg class="palette-shape" width="34" height="34" viewBox="0 0 34 34"><rect x="3" y="5" width="28" height="24" rx="3" fill="#334155" stroke="#94a3b8"/><rect x="9" y="12" width="16" height="9" fill="#1e293b" stroke="#5eead4" stroke-width="2" transform="rotate(-14 17 17)"/></svg>',
  slot:   '<svg class="palette-shape" width="34" height="34" viewBox="0 0 34 34"><rect x="3" y="5" width="28" height="24" rx="3" fill="#334155" stroke="#94a3b8"/><rect x="8" y="13.5" width="18" height="7" rx="3.5" fill="#1e293b" stroke="#5eead4" stroke-width="2"/></svg>',
  grid:   '<svg class="palette-shape" width="34" height="34" viewBox="0 0 34 34"><rect x="3" y="5" width="28" height="24" rx="3" fill="#334155" stroke="#94a3b8"/><g fill="#1e293b" stroke="#5eead4" stroke-width="1.5"><circle cx="10" cy="12" r="2"/><circle cx="17" cy="12" r="2"/><circle cx="24" cy="12" r="2"/><circle cx="13.5" cy="17" r="2"/><circle cx="20.5" cy="17" r="2"/><circle cx="10" cy="22" r="2"/><circle cx="17" cy="22" r="2"/><circle cx="24" cy="22" r="2"/></g></svg>',
  tpl:    '<svg class="palette-shape" width="34" height="34" viewBox="0 0 34 34"><rect x="3" y="5" width="28" height="24" rx="3" fill="#334155" stroke="#94a3b8"/><rect x="7" y="9" width="20" height="16" rx="1.5" fill="none" stroke="#94a3b8" stroke-dasharray="2 1.5"/><g fill="#1e293b" stroke="#5eead4" stroke-width="1.5"><circle cx="17" cy="17" r="4.5"/><circle cx="10" cy="12" r="1.3"/><circle cx="24" cy="12" r="1.3"/><circle cx="10" cy="22" r="1.3"/><circle cx="24" cy="22" r="1.3"/></g></svg>',
};
const TOOLS = [
  { tool: 'select', name: 'Auswählen', hint: 'Elemente verschieben, Maße anklicken' },
  { tool: 'hole',   name: 'Loch',      hint: 'auf ein Teil ziehen · Durchmesser frei' },
  { tool: 'rect',   name: 'Rechteck',  hint: 'auf ein Teil ziehen · drehbar, Ecken rund' },
  { tool: 'slot',   name: 'Langloch',  hint: 'Griffmulde, Kabeldurchführung' },
  { tool: 'grid',   name: 'Lochraster', hint: 'Lüftung, Lautsprecher · gerade oder versetzt' },
];

function paletteCard(tool, name, hint) {
  const c = document.createElement('div');
  c.className = 'palette-card';
  c.dataset.tool = tool;
  c.innerHTML = ICONS[tool] + `<div class="palette-text"><div class="palette-name"></div><div class="palette-hint"></div></div>`;
  c.querySelector('.palette-name').textContent = name;
  c.querySelector('.palette-hint').textContent = hint;
  c.addEventListener('pointerdown', (e) => paletteDown(e, tool, c));
  return c;
}

function buildPalette() {
  const pal = byId('palette');
  pal.innerHTML = '';
  for (const t of TOOLS) pal.appendChild(paletteCard(t.tool, t.name, t.hint));

  // Bauteil-Vorlagen: Auswahl + eine Karte zum Ziehen
  const selEl = byId('tpl-select');
  const groups = new Map();
  for (const t of FE.TEMPLATES) {
    if (!groups.has(t.group)) { const g = document.createElement('optgroup'); g.label = t.group; groups.set(t.group, g); selEl.appendChild(g); }
    const o = document.createElement('option'); o.value = t.id; o.textContent = t.name;
    groups.get(t.group).appendChild(o);
  }
  const card = paletteCard('tpl', FE.template(tplId).name, 'auf ein Teil ziehen · drehbar');
  byId('tpl-card').replaceWith(card);
  card.id = 'tpl-card';
  selEl.value = tplId;
  selEl.addEventListener('change', () => {
    tplId = selEl.value;
    card.querySelector('.palette-name').textContent = FE.template(tplId).name;
    if (tool === 'tpl') setTool('tpl');
  });
}

let ghost = null;
function paletteDown(e, t, card) {
  if (t === 'select') { setTool('select'); return; }
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  let dragging = false;
  const move = (ev) => {
    if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6) {
      dragging = true;
      ghost = document.createElement('div');
      ghost.id = 'drag-ghost'; ghost.className = t === 'hole' ? '' : 'rect';
      document.body.appendChild(ghost);
      byId('sidebar').classList.remove('open');
    }
    if (dragging) {
      ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      document.querySelectorAll('.plate.hot').forEach((n) => n.classList.remove('hot'));
      const pe = el && el.closest && el.closest('[data-part]');
      if (pe) pe.classList.add('hot');
    }
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (ghost) { ghost.remove(); ghost = null; }
    document.querySelectorAll('.plate.hot').forEach((n) => n.classList.remove('hot'));
    if (!dragging) { setTool(tool === t ? 'select' : t); return; }
    const r = byId('sheet').getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    const pt = toSheet(ev.clientX, ev.clientY), p = partAt(pt.x, pt.y);
    if (p) addFeature(t, p.id, snapv(pt.x - p.ox), snapv(pt.y - p.oy));
    else setStatus('Bitte auf ein Teil ablegen');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function setField(id, v) {
  const el = byId(id);
  if (document.activeElement !== el) el.value = v;
}

function syncSidebar() {
  const b = M.box;
  setField('in-W', b.W); setField('in-D', b.D); setField('in-H', b.H);
  setField('in-t', b.t); setField('in-f', b.f); setField('in-k', b.k);
  setField('in-measure', b.measure);
  setField('in-lid', b.lid); setField('in-c', b.c);
  byId('row-play').hidden = !['lift', 'slide', 'hinge'].includes(b.lid);
  byId('lid-hint').textContent = LID_INFO[b.lid].hint;
  setField('cnt-x', M.dividers.filter((d) => d.dir === 'x').length);
  setField('cnt-y', M.dividers.filter((d) => d.dir === 'y').length);

  const list = byId('div-list');
  if (!list.contains(document.activeElement)) {
    list.innerHTML = '';
    M.dividers.forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'div-row';
      row.innerHTML = `<div class="div-name">Zwischenwand ${i + 1}<small>${d.dir === 'x' ? 'teilt Breite · von links' : 'teilt Tiefe · von vorn'}</small></div>` +
        `<input type="number" step="1" value="${d.pos}" aria-label="Position"><button class="icon-btn" title="Entfernen">✕</button>`;
      row.querySelector('input').addEventListener('change', (e) => applyDim('div:' + d.id, parseNum(e.target.value)));
      row.querySelector('button').addEventListener('click', () => removeDivider(d.id));
      list.appendChild(row);
    });
  }
  syncStlPanel();
  syncProps();
}

function propField(label, key, val, step) {
  return `<label>${label}<input type="number" step="${step || 0.5}" data-key="${key}" value="${round2(val || 0)}"></label>`;
}
/** Eingabefelder je Art: [Beschriftung, Schlüssel, Schrittweite] in Zeilen zu 2 oder 3. */
const PROP_ROWS = {
  hole: [[['Durchmesser', 'd', 0.1]]],
  rect: [[['Breite', 'w', 0.5], ['Höhe', 'h', 0.5], ['Winkel °', 'rot', 5]], [['Eckenradius', 'r', 0.5]]],
  slot: [[['Länge', 'w', 0.5], ['Breite', 'h', 0.5], ['Winkel °', 'rot', 5]]],
  grid: [[['Ø Loch', 'd', 0.1], ['Abstand X', 'px', 0.5], ['Abstand Y', 'py', 0.5]],
         [['Spalten', 'nx', 1], ['Reihen', 'ny', 1], ['Winkel °', 'rot', 5]]],
  tpl:  [[['Winkel °', 'rot', 5]]],
};
function syncProps() {
  const f = selFeature(), wrap = byId('props-wrap'), box = byId('props');
  wrap.hidden = !f;
  if (!f) return;
  if (box.contains(document.activeElement) && box.dataset.fid === String(f.id) && box.dataset.type === f.type) {
    box.querySelectorAll('input[data-key]').forEach((i) => { if (i !== document.activeElement) i.value = round2(f[i.dataset.key] || 0); });
    return;
  }
  const p = PARTS.get(f.part);
  box.dataset.fid = f.id; box.dataset.type = f.type;
  const rows = (PROP_ROWS[f.type] || []).map((row) =>
    `<div class="field-grid${row.length === 3 ? '' : ' two'}">${row.map(([l, k, st]) => propField(l, k, f[k], st)).join('')}</div>`).join('');
  const canOpp = OPPOSITE[f.part] && PARTS.get(OPPOSITE[f.part]);
  box.innerHTML =
    `<div class="muted small"><span class="fname"></span> auf: <b>${p.name}</b></div>` + rows +
    (f.type === 'grid' ? `<label class="check"><input type="checkbox" data-bool="hex"${f.hex ? ' checked' : ''}> Reihen versetzt (Wabe)</label>` : '') +
    (f.type === 'tpl' ? `<div class="muted small">Richtwerte – vor dem Lasern am Bauteil nachmessen. Gestrichelt: Umriss des Bauteils (wird nicht geschnitten).</div>` : '') +
    `<div class="field-grid two">${propField('X von links', 'x', f.x, 1)}${propField('Y von oben', 'y', f.y, 1)}</div>` +
    `<div class="btn-row"><button class="btn-side" data-act="cx" title="Waagrecht mittig auf das Teil">↔ Mitte</button>` +
    `<button class="btn-side" data-act="cy" title="Senkrecht mittig auf das Teil">↕ Mitte</button></div>` +
    `<div class="btn-row"><button class="btn-side" data-act="dup">Duplizieren</button>` +
    (f.type !== 'hole' ? `<button class="btn-side" data-act="rot">90° drehen</button>` : '') + `</div>` +
    (f.type === 'grid' || f.type === 'tpl' ? `<div class="btn-row"><button class="btn-side" data-act="explode" title="In einzelne Löcher/Rechtecke zerlegen, die sich einzeln ändern lassen">In Einzelteile auflösen</button></div>` : '') +
    `<div class="btn-row"><button class="btn-side" data-act="opp"${canOpp ? '' : ' disabled'}>Auf Gegenseite</button>` +
    `<button class="btn-side danger" data-act="del">Löschen</button></div>`;
  box.querySelector('.fname').textContent = featName(f);
  box.querySelectorAll('input[data-key]').forEach((i) =>
    i.addEventListener('change', (e) => { if (!applyDim(`f:${f.id}:${i.dataset.key}`, parseNum(e.target.value))) syncProps(); }));
  box.querySelectorAll('input[data-bool]').forEach((i) =>
    i.addEventListener('change', () => { pushUndo(); f[i.dataset.bool] = i.checked; changed(); }));
  box.querySelectorAll('[data-act]').forEach((bt) => bt.addEventListener('click', () => {
    const a = bt.dataset.act;
    if (a === 'dup') duplicateSelected();
    else if (a === 'del') deleteSelected();
    else if (a === 'opp') copyToOpposite();
    else if (a === 'rot') applyDim(`f:${f.id}:rot`, (f.rot || 0) + 90);
    else if (a === 'cx') centerSelected('x');
    else if (a === 'cy') centerSelected('y');
    else if (a === 'explode') explodeSelected();
  }));
}

function updateChrome() {
  const o = outerDims(), b = M.box;
  const nd = M.dividers.length;
  byId('breadcrumb').textContent =
    `Box ${num(o.W)} × ${num(o.D)} × ${num(o.H)} mm · ${LID_INFO[b.lid].name}` +
    (nd ? ` · ${nd} ${nd > 1 ? 'Zwischenwände' : 'Zwischenwand'}` : '');
  byId('btn-delete').disabled = !selFeature();
  byId('v3-top-wrap').hidden = b.lid === 'none';
  byId('btn-undo').disabled = !undoStack.length;
  byId('btn-redo').disabled = !redoStack.length;

  const w = BUILD.warnings.concat(STL_ISSUES);
  const bad = M.features.filter((f) => PARTS.has(f.part) && featBad(f)).length;
  if (bad) w.push(`${bad} Element${bad > 1 ? 'e liegen' : ' liegt'} nicht ganz im Teil (rot markiert).`);
  const el = byId('warnings');
  el.hidden = !w.length;
  el.textContent = w.length ? '⚠ ' + w.join('  ·  ') : '';
}

let statusTimer = null;
function setStatus(msg) {
  const s = byId('status');
  s.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { s.textContent = 'Bereit'; }, 6000);
}

// ── Box-Felder und Zwischenwände ──────────────────────────────
function initSidebarInputs() {
  const bindBox = (id, key, min) => {
    byId(id).addEventListener('change', (e) => {
      const v = parseNum(e.target.value);
      if (!isFinite(v) || v < min) { syncSidebar(); return; }
      pushUndo(); M.box[key] = v; changed();
    });
  };
  bindBox('in-W', 'W', 1); bindBox('in-D', 'D', 1); bindBox('in-H', 'H', 1);
  bindBox('in-t', 't', 0.5); bindBox('in-f', 'f', 2);
  byId('in-k').addEventListener('change', (e) => {
    const v = parseNum(e.target.value);
    if (!isFinite(v) || v < 0 || v > 1) { syncSidebar(); return; }
    pushUndo(); M.box.k = v; changed();
  });
  byId('in-measure').addEventListener('change', (e) => {
    // Außenmaße bleiben gleich, nur die Darstellung wechselt
    const o = outerDims();
    pushUndo(); M.box.measure = e.target.value;
    for (const a of ['W', 'D', 'H']) setOuter(a, o[a]);
    changed();
  });
  byId('in-lid').addEventListener('change', (e) => {
    const o = outerDims();
    pushUndo(); M.box.lid = e.target.value;
    setOuter('H', o.H);                     // Außenhöhe bleibt, Innenmaß passt sich an
    changed();
  });
  byId('in-c').addEventListener('change', (e) => {
    const v = parseNum(e.target.value);
    if (!isFinite(v) || v < 0 || v > 2) { syncSidebar(); return; }
    const o = outerDims();
    pushUndo(); M.box.c = v;
    setOuter('H', o.H);
    changed();
  });

  byId('cnt-x').addEventListener('change', (e) => setDividerCount('x', parseInt(e.target.value, 10)));
  byId('cnt-y').addEventListener('change', (e) => setDividerCount('y', parseInt(e.target.value, 10)));
  byId('add-x').addEventListener('click', () => addDivider('x'));
  byId('add-y').addEventListener('click', () => addDivider('y'));

  byId('toggle-dims').addEventListener('change', (e) => { showDims = e.target.checked; scheduleRender(); });
}

function setDividerCount(dir, n) {
  if (!isFinite(n) || n < 0) { syncSidebar(); return; }
  n = Math.min(n, 12);
  const o = outerDims(), L = dir === 'x' ? o.W : o.D;
  pushUndo();
  const mine = M.dividers.filter((d) => d.dir === dir);
  const pos = G.evenPositions(L, o.t, n).map(round2);
  for (let i = mine.length; i < n; i++) M.dividers.push({ id: M.nextId++, dir, pos: 0 });
  const keep = M.dividers.filter((d) => d.dir === dir).slice(0, n);
  const drop = new Set(M.dividers.filter((d) => d.dir === dir).slice(n).map((d) => d.id));
  M.dividers = M.dividers.filter((d) => !drop.has(d.id));
  keep.forEach((d, i) => { d.pos = pos[i]; });
  M.features = M.features.filter((f) => !f.part.startsWith('div_') || !drop.has(+f.part.slice(4)));
  changed();
}
function addDivider(dir) {
  const o = outerDims(), L = dir === 'x' ? o.W : o.D;
  const ps = [0, ...M.dividers.filter((d) => d.dir === dir).map((d) => d.pos).sort((a, b) => a - b), L];
  let best = 0, at = L / 2;
  for (let i = 1; i < ps.length; i++) if (ps[i] - ps[i - 1] > best) { best = ps[i] - ps[i - 1]; at = (ps[i] + ps[i - 1]) / 2; }
  pushUndo();
  M.dividers.push({ id: M.nextId++, dir, pos: round2(at) });
  changed();
}
function removeDivider(id) {
  pushUndo();
  M.dividers = M.dividers.filter((d) => d.id !== id);
  M.features = M.features.filter((f) => f.part !== 'div_' + id);
  changed();
}

// ══════════════════════════════════════════════════════════════
//  3D-Modell (STL): laden, in der Box platzieren, prüfen
// ══════════════════════════════════════════════════════════════
const ST = window.BoxStl;
let STL = null;                       // { name, pos, bounds } – nur im Speicher und in IndexedDB, nicht in der JSON-Datei
let STL_ISSUES = [];

/**
 * Lage in der Box (Welt wie geometry.js: x von links, y von vorn, z von unten außen).
 * M.model.x/y = Mitte des Modells, z = Abstand über dem Innenboden.
 */
function stlPlacement() {
  const m = M.model;
  if (!m || !STL || STL.name !== m.name) return null;
  const rb = ST.rotatedBounds(m.R, STL.bounds);
  const size = [0, 1, 2].map((a) => rb.max[a] - rb.min[a]);
  const min = [m.x - size[0] / 2, m.y - size[1] / 2, M.box.t + m.z];
  return { R: m.R, o: min.map((v, a) => v - rb.min[a]), min, max: min.map((v, a) => v + size[a]), size };
}

/** Ragt das Modell aus dem Innenraum oder stößt es an eine Zwischenwand? */
function checkStl() {
  STL_ISSUES = [];
  const pl = stlPlacement();
  if (!pl || !BUILD.parts.length) return;
  const o = outerDims(), t = o.t;
  const top = o.H - G.heightLoss(M.box.lid, t, M.box.c) + t;          // Unterkante Deckel
  const out = [];
  [[t, o.W - t, 'links', 'rechts'], [t, o.D - t, 'vorn', 'hinten'], [t, top, 'unten', 'oben']].forEach(([lo, hi, a, b], i) => {
    if (pl.min[i] < lo - 1e-6) out.push(`${a} ${num(lo - pl.min[i])} mm`);
    if (pl.max[i] > hi + 1e-6) out.push(`${b} ${num(pl.max[i] - hi)} mm`);
  });
  if (out.length) STL_ISSUES.push(`3D-Modell ragt aus dem Innenraum (${out.join(', ')}).`);
  for (const p of BUILD.parts) {
    if (p.kind !== 'divider') continue;
    const d = p.divider, axis = d.dir === 'x' ? 0 : 1, Hb = p.pose.o[2];
    const rect = [[t, (axis === 0 ? o.D : o.W) - t], [t, Hb]];
    const hit = [-t / 2, 0, t / 2].some((off) => {
      const at = d.pos + off;
      return pl.min[axis] <= at && pl.max[axis] >= at && ST.hitsPlane(STL.pos, pl.R, pl.o, axis, at, rect);
    });
    if (hit) STL_ISSUES.push(`3D-Modell stößt an ${p.name}.`);
  }
}

function syncStl() {
  checkStl();
  const pl = stlPlacement();
  if (V3) V3.setStlPose(pl ? pl.R : null, pl ? pl.o : null, STL_ISSUES.length > 0);
  scheduleShadows();
}

// ── Schatten des Modells auf den Teilen (2D): dunkel = nah an der Platte ──
const SHADOW_RANGE = 12;              // mm: ab diesem Abstand zum nächsten Punkt nur noch blass
let showShadow = true;
let SHADOW = new Map();               // Teil-id → { url, dmin }
let shadowKey = '', shadowTimer = null;

function scheduleShadows() {
  const pl = stlPlacement();
  const key = pl && showShadow
    ? JSON.stringify([M.model.name, pl.R, pl.o, M.box.t, BUILD.parts.map((p) => [p.id, p.w, p.h, p.pose.o, p.pose.N])]) : '';
  if (key === shadowKey) return;
  shadowKey = key;
  clearTimeout(shadowTimer);
  if (!key) { setShadows(new Map()); return; }
  shadowTimer = setTimeout(() => computeShadows(key, pl), 30);     // erst die Oberfläche aktualisieren lassen
}
function setShadows(next) {
  for (const s of SHADOW.values()) URL.revokeObjectURL(s.url);
  SHADOW = next;
  scheduleRender();
}
async function computeShadows(key, pl) {
  const jobs = BUILD.parts.map((p) => {
    const sh = ST.shadow(STL.pos, pl.R, pl.o, p.pose, M.box.t, p.w, p.h, Math.min(8, 1024 / Math.max(p.w, p.h)));
    let dmin = Infinity;
    for (const d of sh.depth) if (d < dmin) dmin = d;
    if (!isFinite(dmin)) return null;
    const cv = document.createElement('canvas');
    cv.width = sh.cols; cv.height = sh.rows;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(sh.cols, sh.rows), px = img.data;
    for (let i = 0; i < sh.depth.length; i++) {
      const d = sh.depth[i];
      if (!isFinite(d)) continue;
      const f = 1 - Math.min(1, (d - dmin) / SHADOW_RANGE);
      px[i * 4] = 13; px[i * 4 + 1] = 148; px[i * 4 + 2] = 136; px[i * 4 + 3] = Math.round(255 * (0.12 + 0.6 * f * f));
    }
    ctx.putImageData(img, 0, 0);
    return new Promise((res) => cv.toBlob((b) => res([p.id, { url: URL.createObjectURL(b), dmin }])));
  });
  const next = new Map((await Promise.all(jobs)).filter(Boolean));
  if (key !== shadowKey) { for (const s of next.values()) URL.revokeObjectURL(s.url); return; }   // inzwischen veraltet
  setShadows(next);
}

function setStlGeometry(name, pos) {
  STL = { name, pos, bounds: ST.bounds(pos) };
  if (V3) V3.setStl(ST.interleave(pos));
}

// Die letzte STL im Browser ablegen, damit sie ein Neuladen der Seite übersteht
function stlDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('boxlab', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('stl');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function stlStore(name, buf) {
  try { (await stlDb()).transaction('stl', 'readwrite').objectStore('stl').put({ name, buf }, 'current'); } catch (e) { /* ohne IndexedDB: Datei neu laden */ }
}
async function stlRestore() {
  try {
    const db = await stlDb();
    const rec = await new Promise((res, rej) => {
      const r = db.transaction('stl').objectStore('stl').get('current');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    if (rec && M.model && rec.name === M.model.name) { setStlGeometry(rec.name, ST.parse(rec.buf)); rebuild(); refresh(); }
  } catch (e) { /* ignorieren – Hinweis in der Seitenleiste bleibt */ }
}

async function loadStlFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const pos = ST.parse(buf);
    setStlGeometry(file.name, pos);
    stlStore(file.name, buf);
    const o = outerDims();
    pushUndo();
    M.model = { name: file.name, R: ST.ID.slice(), x: round2(o.W / 2), y: round2(o.D / 2), z: 0, gap: M.model ? M.model.gap : 2 };
    changed();
    if (byId('views').className === 'mode-2d') setViewMode('split');
    setStatus(`${file.name} geladen – ${pos.length / 9} Dreiecke`);
  } catch (err) {
    showModal('STL laden nicht möglich', `${file.name}: ${err.message}`);
  }
}

function setModelValue(key, v) {
  if (!M.model || !isFinite(v) || (key === 'gap' && v < 0)) { syncSidebar(); return; }
  pushUndo(); M.model[key] = round2(v); changed();
}
function rotateModel(axis) {
  if (!M.model) return;
  pushUndo(); M.model.R = ST.rotate(M.model.R, axis); changed();
}
/** Box so groß machen, dass das Modell mit Abstand hineinpasst (unten liegt es auf). */
function fitBoxToModel() {
  const pl = stlPlacement(); if (!pl) return;
  const g = M.model.gap, t = M.box.t;
  pushUndo();
  setOuter('W', pl.size[0] + 2 * g + 2 * t);
  setOuter('D', pl.size[1] + 2 * g + 2 * t);
  setOuter('H', pl.size[2] + g + G.heightLoss(M.box.lid, t, M.box.c));
  const o = outerDims();
  Object.assign(M.model, { x: round2(o.W / 2), y: round2(o.D / 2), z: 0 });
  changed(); fitView(); if (V3) V3.fit();
  setStatus('Box an das Modell angepasst');
}

function syncStlPanel() {
  const m = M.model, have = !!stlPlacement();
  byId('stl-props').hidden = !have;
  byId('stl-remove-row').hidden = !m;
  byId('v3-stl-wrap').hidden = !have;
  const info = byId('stl-info');
  if (!m) { info.textContent = 'Bauteil als STL (in mm) laden, in der Box platzieren und prüfen, ob es passt.'; return; }
  if (!have) { info.textContent = `Modell „${m.name}“ – bitte die STL-Datei neu laden.`; return; }
  const s = stlPlacement().size, big = Math.max(...s);
  info.textContent = `${m.name} · ${s.map(num).join(' × ')} mm` +
    (big < 3 || big > 2000 ? ' – ungewöhnliche Größe: ist die STL in Millimetern?' : '');
  setField('stl-x', m.x); setField('stl-y', m.y); setField('stl-z', m.z); setField('stl-gap', m.gap);
}

function initStl() {
  byId('stl-load').onclick = () => byId('stl-input').click();
  byId('stl-input').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadStlFile(f); };
  for (const k of ['x', 'y', 'z', 'gap']) byId('stl-' + k).addEventListener('change', (e) => setModelValue(k, parseNum(e.target.value)));
  document.querySelectorAll('[data-stl-rot]').forEach((b) => b.addEventListener('click', () => rotateModel(b.dataset.stlRot)));
  byId('stl-center').onclick = () => { const o = outerDims(); if (!M.model) return; pushUndo(); M.model.x = round2(o.W / 2); M.model.y = round2(o.D / 2); changed(); };
  byId('stl-floor').onclick = () => setModelValue('z', 0);
  byId('stl-fit').onclick = fitBoxToModel;
  byId('stl-remove').onclick = () => { pushUndo(); M.model = null; changed(); };
  byId('v3-stl').addEventListener('change', (e) => { if (V3) V3.setStlShow(e.target.checked); });
  byId('stl-shadow').addEventListener('change', (e) => { showShadow = e.target.checked; scheduleShadows(); });

  // Dateien aufs Fenster ziehen: .stl als Modell, .json als Box
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (/\.stl$/i.test(f.name)) loadStlFile(f);
    else if (/\.json$/i.test(f.name)) f.text().then(loadJson);
  });
}

// ══════════════════════════════════════════════════════════════
//  3D-Vorschau (view3d.js) und Umschalter 2D / 2D+3D / 3D
// ══════════════════════════════════════════════════════════════
const VIEW_KEY = 'boxlab.view';
let V3 = null;

function sync3D() {
  if (V3) V3.setModel(BUILD3D.parts, M.features, { ...outerDims(), lid: M.box.lid, c: M.box.c });
}
function highlight3D() {
  const f = selFeature();
  const id = f ? f.part : hotPart;
  if (V3) V3.setHighlight(id, f ? f.id : null);
  const p = id && PARTS.get(id), label = byId('v3-label');
  label.hidden = !p;
  if (p) label.textContent = f ? `${featName(f)} auf ${p.name}` : `${p.name} · ${num(p.w)} × ${num(p.h)} mm`;
}

function setViewMode(mode) {
  byId('views').className = 'mode-' + mode;
  document.querySelectorAll('#view-seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
  try { localStorage.setItem(VIEW_KEY, mode); } catch (e) { /* privater Modus */ }
  requestAnimationFrame(() => { fitView(); if (V3) V3.redraw(); });
}

function init3D() {
  try { V3 = window.Box3D.create(byId('gl'), { onPick: pickPart }); } catch (e) { V3 = null; }
  if (!V3) { byId('v3-nogl').hidden = false; byId('v3-panel').hidden = true; byId('v3-hint').hidden = true; }
  else {
    byId('v3-explode').addEventListener('input', (e) => V3.setExplode(+e.target.value));
    byId('v3-top').addEventListener('change', (e) => V3.setShowTop(e.target.checked));
    byId('v3-reset').addEventListener('click', () => V3.resetView());
  }
  document.querySelectorAll('#view-seg button').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.view)));
  let mode = null;
  try { mode = localStorage.getItem(VIEW_KEY); } catch (e) { /* ignorieren */ }
  if (!['2d', 'split', '3d'].includes(mode)) mode = window.innerWidth >= 1100 ? 'split' : '2d';
  setViewMode(mode);
}

// ══════════════════════════════════════════════════════════════
//  Dateien: Speichern, Laden, SVG-Export
// ══════════════════════════════════════════════════════════════
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const baseName = () => { const o = outerDims(); return `box_${round2(o.W)}x${round2(o.D)}x${round2(o.H)}`; };

function saveJson() {
  const data = { app: 'boxlab', version: 1, model: M };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), baseName() + '.json');
  setStatus('Gespeichert');
}
function loadJson(text) {
  try {
    const d = JSON.parse(text);
    const m = d.model || d;
    if (!m.box || typeof m.box.W !== 'number') throw new Error('keine Boxlab-Datei');
    const base = defaultModel();
    pushUndo();
    M = { ...base, ...m, box: { ...base.box, ...normBox({ ...m.box }) } };
    M.dividers = Array.isArray(m.dividers) ? m.dividers : [];
    M.features = Array.isArray(m.features) ? m.features : [];
    if (!M.model || !Array.isArray(M.model.R)) M.model = null;
    M.nextId = Math.max(M.nextId || 1, ...M.dividers.map((x) => x.id + 1), ...M.features.map((x) => x.id + 1));
    sel = null; changed(); fitView();
    setStatus('Geladen');
  } catch (err) {
    showModal('Laden nicht möglich', 'Die Datei konnte nicht gelesen werden: ' + err.message);
  }
}

/** Fertiges SVG (mm) für den Lasercutter: nur Schnittgeometrie, optional Beschriftung. */
function buildSvg(opt) {
  const parts = BUILD.parts.map((p) => ({ ...p }));
  const lay = G.layout(parts, opt.gap, opt.width || 0);
  const m = 2;
  const W = lay.w + 2 * m, H = lay.h + 2 * m;
  const sw = opt.stroke, col = opt.color;
  const f3 = (v) => (Math.round(v * 1000) / 1000);
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f3(W)}mm" height="${f3(H)}mm" viewBox="0 0 ${f3(W)} ${f3(H)}">\n` +
    `<title>Boxlab ${baseName()}</title>\n` +
    `<g fill="none" stroke="${col}" stroke-width="${sw}" stroke-linejoin="miter">\n`;
  for (const p of parts) {
    s += `<g id="${p.id}" transform="translate(${f3(p.ox + m)} ${f3(p.oy + m)})">\n`;
    s += `<path d="${pathOf(p.outline)}"/>\n`;
    for (const h of p.holes) {
      s += h.type === 'circle' ? `<circle cx="${f3(h.x)}" cy="${f3(h.y)}" r="${f3(h.d / 2)}"/>\n`
        : `<path d="${rectPath({ x: f3(h.x), y: f3(h.y), w: f3(h.w), h: f3(h.h) })}"/>\n`;
    }
    for (const f of M.features) {
      if (f.part !== p.id) continue;
      for (const q of FE.shapes(f)) {
        if (q.guide) continue;
        s += q.k === 'circle' ? `<circle cx="${f3(q.x)}" cy="${f3(q.y)}" r="${f3(q.d / 2)}"/>\n` : `<path d="${FE.rectPath(q, f3)}"/>\n`;
      }
    }
    s += `</g>\n`;
  }
  s += `</g>\n`;
  if (opt.labels) {
    s += `<g fill="#0000ff" stroke="none" font-family="Helvetica, Arial, sans-serif" font-size="4">\n`;
    for (const p of parts) s += `<text x="${f3(p.ox + m + p.w / 2)}" y="${f3(p.oy + m + p.h / 2)}" text-anchor="middle">${p.name}</text>\n`;
    s += `</g>\n`;
  }
  return s + `</svg>\n`;
}

function showExport() {
  const o = outerDims();
  const lay = G.layout(BUILD.parts.map((p) => ({ ...p })), +byId('ex-gap').value || 4, +byId('ex-width').value || 0);
  byId('ex-info').textContent = `${BUILD.parts.length} Teile · Bogen ca. ${num(lay.w + 4)} × ${num(lay.h + 4)} mm. Maße und Hilfslinien werden nicht exportiert.`;
  byId('export-modal').style.display = 'flex';
}
function doExport() {
  const opt = {
    color: byId('ex-color').value,
    stroke: Math.max(0.001, parseFloat(byId('ex-stroke').value) || 0.1),
    gap: Math.max(0, parseFloat(byId('ex-gap').value) || 0),
    width: parseFloat(byId('ex-width').value) || 0,
    labels: byId('ex-labels').checked,
  };
  if (!BUILD.parts.length) { showModal('Export nicht möglich', 'Die Box hat keine gültigen Maße.'); return; }
  downloadBlob(new Blob([buildSvg(opt)], { type: 'image/svg+xml' }), baseName() + '.svg');
  byId('export-modal').style.display = 'none';
  setStatus('SVG exportiert');
}

// ══════════════════════════════════════════════════════════════
//  Dialoge, Menü, Desktop-Version
// ══════════════════════════════════════════════════════════════
function showModal(title, msg) {
  byId('modal-title').textContent = title;
  byId('modal-body').textContent = msg;
  byId('modal').style.display = 'flex';
}
const closeMenu = () => { byId('menubar').classList.remove('open'); };

// Desktop: Pakete (optional, wie beim PAP-Editor) + PWA + Offline-Datei
const GITHUB_REPO = 'juchemGDG/BoxLab';   // Pakete aus dem neuesten GitHub-Release; leer = nur lokale Dateien in downloads/
const DOWNLOADS = [
  { os: 'macOS',   file: 'Boxlab.dmg',                 hint: 'Apple Silicon (M1 und neuer) · .dmg' },
  { os: 'Windows', file: 'Boxlab-windows.zip',         hint: 'entpacken, Boxlab.exe starten · .zip' },
  { os: 'Linux',   file: 'Boxlab-linux-x86_64.tar.gz', hint: 'entpacken & starten · .tar.gz' },
];
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

function showDesktop() {
  closeMenu();
  byId('download-modal').style.display = 'flex';
  const meta = byId('dl-install-meta');
  meta.textContent = installEvent ? 'ein Klick' : 'Anleitung anzeigen';
  const pk = byId('download-pkgs');
  pk.innerHTML = '';
  const info = byId('download-version');
  info.textContent = '';
  const rows = {};
  for (const item of DOWNLOADS) {
    const a = document.createElement('a');
    a.className = 'download-item missing';
    a.innerHTML = '<span class="download-os"></span><span class="download-meta">noch nicht verfügbar</span>';
    a.firstChild.textContent = item.os;
    rows[item.file] = a; pk.appendChild(a);
  }
  const enable = (item, href, extra) => {
    const a = rows[item.file];
    a.href = href; a.setAttribute('download', item.file); a.classList.remove('missing');
    a.lastChild.textContent = item.hint + (extra ? ' · ' + extra : '');
  };
  const local = () => DOWNLOADS.forEach((item) =>
    fetch('downloads/' + item.file, { method: 'HEAD' }).then((r) => { if (r.ok) enable(item, 'downloads/' + item.file); }).catch(() => {}));
  if (!GITHUB_REPO) { local(); byId('download-note').textContent = 'Native Pakete (.dmg/.exe/.tar.gz) werden mit desktop/build_desktop.* gebaut und in web/static/downloads/ abgelegt.'; return; }
  fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((rel) => {
      info.textContent = 'Aktuelle Version: ' + rel.tag_name;
      const assets = Object.fromEntries((rel.assets || []).map((x) => [x.name, x]));
      for (const item of DOWNLOADS) if (assets[item.file]) enable(item, assets[item.file].browser_download_url);
    }).catch(local);
}

function installApp() {
  if (installEvent) { installEvent.prompt(); installEvent.userChoice.finally(() => { installEvent = null; }); return; }
  const ua = navigator.userAgent;
  let how = 'Chrome/Edge: Symbol „App installieren“ rechts in der Adressleiste.\nSafari (macOS): Ablage → „Zum Dock hinzufügen“.\nSafari (iPad/iPhone): Teilen-Symbol → „Zum Home-Bildschirm“.';
  if (/iPad|iPhone/.test(ua)) how = 'Teilen-Symbol in Safari → „Zum Home-Bildschirm“.';
  else if (/Chrome|Edg/.test(ua)) how = 'Symbol „App installieren“ rechts in der Adressleiste (oder Menü ⋮ → „Boxlab installieren“).\nHinweis: funktioniert nur über https:// oder localhost.';
  else if (/Safari/.test(ua)) how = 'Ablage → „Zum Dock hinzufügen“.';
  showModal('Als App installieren', how);
}

/** Alles in eine einzige HTML-Datei packen, die ohne Server funktioniert. */
async function downloadOffline() {
  try {
    const get = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u); return r.text(); };
    let [html, css] = await Promise.all([get('index.html'), get('boxlab.css')]);
    const tag = /<script src="([\w-]+\.js)[^"]*"><\/script>/g;
    const names = [...html.matchAll(tag)].map((m) => m[1]);
    const code = new Map(await Promise.all(names.map(async (n) => [n, await get(n)])));
    const safe = (t) => t.replace(/<\/script/gi, '<\\/script');
    html = html
      .replace(/<link rel="manifest"[^>]*>\s*/, '')
      .replace(/<link rel="stylesheet" href="boxlab\.css[^"]*">/, () => `<style>\n${css}\n</style>`)
      .replace(tag, (m, n) => `<script>\n${safe(code.get(n))}\n</script>`);
    downloadBlob(new Blob([html], { type: 'text/html' }), 'Boxlab-Offline.html');
    setStatus('Offline-Datei geladen – einfach per Doppelklick öffnen');
  } catch (e) {
    showModal('Offline-Datei', 'Die Datei konnte nicht erzeugt werden. Bitte die Seite über einen Webserver (nicht per file://) öffnen.');
  }
}

function initChrome() {
  const sb = byId('sidebar');
  byId('sidebar-toggle').onclick = () => sb.classList.toggle('open');
  byId('sidebar-overlay').onclick = () => sb.classList.remove('open');
  byId('menu-toggle').onclick = () => byId('menubar').classList.toggle('open');
  byId('menu-overlay').onclick = closeMenu;

  byId('btn-undo').onclick = undo;
  byId('btn-redo').onclick = redo;
  byId('btn-fit').onclick = () => { closeMenu(); fitView(); if (V3) V3.fit(); };
  byId('btn-new').onclick = () => {
    closeMenu();
    if (!confirm('Neue Box beginnen? Nicht gespeicherte Änderungen gehen verloren (Rückgängig bleibt möglich).')) return;
    pushUndo(); M = defaultModel(); sel = null; changed(); fitView();
  };
  byId('btn-load').onclick = () => { closeMenu(); byId('file-input').click(); };
  byId('file-input').onchange = (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const r = new FileReader(); r.onload = () => loadJson(String(r.result)); r.readAsText(file);
  };
  byId('btn-save').onclick = () => { closeMenu(); saveJson(); };
  byId('btn-svg').onclick = () => { closeMenu(); showExport(); };
  byId('btn-desktop').onclick = showDesktop;
  byId('btn-delete').onclick = deleteSelected;
  byId('btn-help-side').onclick = () => { sb.classList.remove('open'); byId('help-modal').style.display = 'flex'; };
  byId('help-close').onclick = () => { byId('help-modal').style.display = 'none'; };
  byId('modal-close').onclick = () => { byId('modal').style.display = 'none'; };
  byId('download-close').onclick = () => { byId('download-modal').style.display = 'none'; };
  byId('dl-install').onclick = installApp;
  byId('dl-offline').onclick = downloadOffline;
  byId('ex-cancel').onclick = () => { byId('export-modal').style.display = 'none'; };
  byId('ex-ok').onclick = doExport;
  ['ex-gap', 'ex-width'].forEach((id) => byId(id).addEventListener('input', showExport));

  document.querySelectorAll('.overlay').forEach((o) => o.addEventListener('pointerdown', (e) => {
    if (e.target === o) o.style.display = 'none';
  }));

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      document.querySelectorAll('.overlay').forEach((o) => { o.style.display = 'none'; });
      if (!typing) { setTool('select'); if (sel != null || hotPart) pickPart(null); }
      return;
    }
    if (typing) return;
    const f = selFeature();
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (f) { e.preventDefault(); deleteSelected(); } }
    else if (e.key.toLowerCase() === 'f' && !mod) fitView();
    else if (e.key.toLowerCase() === 'r' && f && f.type !== 'hole') applyDim(`f:${f.id}:rot`, (f.rot || 0) + 90);
    else if (f && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const st = e.shiftKey ? 10 : 1;
      pushUndo();
      if (e.key === 'ArrowLeft') f.x = round2(f.x - st);
      if (e.key === 'ArrowRight') f.x = round2(f.x + st);
      if (e.key === 'ArrowUp') f.y = round2(f.y - st);
      if (e.key === 'ArrowDown') f.y = round2(f.y + st);
      changed();
    }
  });
}

// ══════════════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════════════
function init() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const m = JSON.parse(raw);
      if (m && m.box) { const b = defaultModel(); M = { ...b, ...m, box: { ...b.box, ...normBox({ ...m.box }) } }; }
    }
  } catch (e) { /* ignorieren */ }

  buildPalette();
  initSidebarInputs();
  initChrome();
  initCanvas();
  init3D();
  initStl();
  rebuild();
  refresh();
  fitView();
  if (M.model) stlRestore();
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
