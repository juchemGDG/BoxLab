/* Boxlab – Geometrie: erzeugt aus den Boxmaßen die Einzelteile (Umrisse in mm).
 *
 * Alle Teile liegen in eigenen Koordinaten: Ursprung links oben, x nach rechts,
 * y nach unten (SVG-Richtung). Die Datei hat keine Browser-Abhängigkeit und lässt
 * sich auch mit Node testen (node test/geometry.test.js).
 *
 * Verbindungsprinzip (Fingerzinken):
 *  - Vorder-/Rückwand sind außen voll (B×H) und besitzen an den senkrechten Kanten
 *    die "ersten" Zinken. Seitenwände (T−2t breit) greifen dazwischen.
 *  - Boden/Deckel liegen innen (B−2t × T−2t) und greifen mit Zinken in die Wände.
 *  - Zwischenwände stecken mit Zapfen in Schlitzen der Wände und des Bodens;
 *    kreuzen sich zwei Zwischenwände, bekommen sie halbe Kreuzschlitze.
 */
(function (root) {
  'use strict';

  /** Anzahl Segmente: ungerade, möglichst nah an len/target, mindestens minN. */
  function oddCount(len, target, minN) {
    let n = Math.max(1, Math.round(len / Math.max(target, 0.1)));
    if (n % 2 === 0) {
      const lo = n - 1, hi = n + 1;
      n = (lo >= 1 && Math.abs(len / lo - target) <= Math.abs(len / hi - target)) ? lo : hi;
    }
    return Math.max(n, minN || 1);
  }

  /**
   * Zinkenfolge entlang einer Seite der Länge L.
   * Zwischen a und b wechseln sich "Material" (Tiefe mat) und "Lücke" (Tiefe gap) ab;
   * die Enden davor/dahinter übernehmen den Zustand des Nachbarsegments.
   * k = Schnittfuge: Material wächst an jeder Grenze um k/2 in die Lücke.
   * Ergebnis: [[s0, s1, tiefe], ...] von 0 bis L.
   */
  function fingerSegs(L, a, b, f, k, mat, gap, firstMat, minN) {
    const span = b - a;
    const n = oddCount(span, f, minN);
    const w = span / n;
    const bounds = [];
    const states = [];
    for (let i = 0; i < n; i++) {
      bounds.push(a + i * w);
      states.push(firstMat ? i % 2 === 0 : i % 2 === 1);
    }
    bounds.push(b);
    const shifted = bounds.slice();
    for (let j = 1; j < n; j++) {
      shifted[j] += states[j - 1] ? k / 2 : -k / 2;
    }
    shifted[0] = 0;
    shifted[n] = L;
    return states.map((m, i) => [shifted[i], shifted[i + 1], m ? mat : gap]);
  }

  /** Seite aus Zapfen-Intervallen: Zapfen ragen mit Tiefe tabDepth nach außen. */
  function segsFromTabs(L, tabs, tabDepth, k) {
    const segs = [];
    let pos = 0;
    const sorted = tabs.slice().sort((p, q) => p[0] - q[0]);
    for (const [s0, s1] of sorted) {
      const a = Math.max(pos, s0 - k / 2), b = Math.min(L, s1 + k / 2);
      if (a > pos) segs.push([pos, a, 0]);
      segs.push([a, b, tabDepth]);
      pos = b;
    }
    if (pos < L) segs.push([pos, L, 0]);
    return segs;
  }

  /** Bereich [a,b] der Seite durch einen Einschnitt der Tiefe depth ersetzen. */
  function overlay(segs, a, b, depth) {
    const out = [];
    for (const [s0, s1, d] of segs) {
      if (s1 <= a || s0 >= b) { out.push([s0, s1, d]); continue; }
      if (s0 < a) out.push([s0, a, d]);
      if (s1 > b) out.push([b, s1, d]);
    }
    out.push([a, b, depth]);
    out.sort((p, q) => p[0] - q[0]);
    return out;
  }

  /** Umriss aus Grundrechteck + vier Zinkenseiten (im Uhrzeigersinn). */
  function walk(body, sides) {
    const { x: bx, y: by, w: bw, h: bh } = body;
    const pts = [];
    const push = (x, y) => {
      const p = pts[pts.length - 1];
      if (!p || Math.abs(p[0] - x) > 1e-7 || Math.abs(p[1] - y) > 1e-7) pts.push([x, y]);
    };
    for (const [s0, s1, d] of sides.top)              { push(bx + s0, by - d); push(bx + s1, by - d); }
    for (const [s0, s1, d] of sides.right)            { push(bx + bw + d, by + s0); push(bx + bw + d, by + s1); }
    for (const [s0, s1, d] of sides.bottom.slice().reverse()) { push(bx + s1, by + bh + d); push(bx + s0, by + bh + d); }
    for (const [s0, s1, d] of sides.left.slice().reverse())   { push(bx - d, by + s1); push(bx - d, by + s0); }
    return simplify(pts);
  }

  /** Doppelte und auf einer Geraden liegende Punkte entfernen (geschlossener Umriss). */
  function simplify(pts) {
    let p = pts.slice();
    let changed = true;
    while (changed && p.length > 3) {
      changed = false;
      for (let i = 0; i < p.length; i++) {
        const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        const same = Math.abs(b[0] - a[0]) < 1e-7 && Math.abs(b[1] - a[1]) < 1e-7;
        if (Math.abs(cross) < 1e-9 || same) { p.splice(i, 1); changed = true; break; }
      }
    }
    return p;
  }

  const flat = (L) => [[0, L, 0]];

  /** Deckelarten: Außenhöhe minus lichte Innenhöhe (Boden bis Unterkante Deckel). */
  const LIDS = ['none', 'fixed', 'lift', 'slide', 'hinge'];
  function heightLoss(lid, t, c) {
    if (lid === 'fixed') return 2 * t;
    if (lid === 'lift' || lid === 'hinge') return 3 * t;
    if (lid === 'slide') return 4 * t + (c || 0);
    return t;
  }

  /**
   * P = { W, D, H, t, f, k, lid, c, dividers:[{id, dir:'x'|'y', pos}] }
   *   W,D,H  Außenmaße, t Materialstärke, f Zinkenbreite (Richtwert), k Schnittfuge
   *   lid    'none' offen · 'fixed' fest verzinkt · 'lift' zum Abnehmen (mit Einsatz) ·
   *          'slide' Schiebedeckel (läuft in Schlitzen der Seitenwände) ·
   *          'hinge' Klappdeckel (Zapfen drehen in runden Löchern der Seitenwände)
   *   c      Spiel der beweglichen Deckel (mm); ältere Aufrufe mit closed:true = 'fixed'
   *   dir 'x': Zwischenwand teilt die Breite (Position pos von links, Mitte der Wand)
   *   dir 'y': Zwischenwand teilt die Tiefe (Position pos von vorn)
   * Rückgabe: { parts:[{id,name,kind,w,h,outline,holes,dims,pose,lid?}], warnings:[] }
   *   holes: { type:'rect', x, y, w, h } (Ecke links oben) oder { type:'circle', x, y, d } (Mitte)
   */
  function build(P) {
    const { W, D, H, t } = P;
    const k = P.k || 0;
    const f = Math.max(P.f || 10, t);
    const lid = LIDS.includes(P.lid) ? P.lid : (P.closed ? 'fixed' : 'none');
    const c = lid === 'lift' || lid === 'slide' || lid === 'hinge' ? Math.max(0, P.c == null ? 0.2 : P.c) : 0;
    const warnings = [];
    const parts = [];

    if (!(W > 4 * t && D > 4 * t && H > Math.max(3 * t, heightLoss(lid, t, c) + t))) {
      warnings.push('Die Maße sind im Verhältnis zur Materialstärke zu klein.');
      return { parts, warnings };
    }

    const minN = (L) => (L / 3 >= 1.5 * t ? 3 : 1);
    const fing = (L, a, b, mat, gap, firstMat) =>
      fingerSegs(L, a, b, f, k, mat, gap, firstMat, minN(b - a));

    // ── Höhen je Deckelart ───────────────────────────────────────────
    // Hf/Hk: Vorder-/Rückwand, Hs: Seitenwände, Hb: Oberkante der Zwischenwände
    const zSlide = H - 3 * t - c;                     // Schiebedeckel: Unterkante, darüber 2t Steg
    let Hf = H, Hk = H, Hs = H, Hb = H;
    if (lid === 'fixed') Hb = H - t;
    if (lid === 'lift') { Hf = Hk = Hs = H - t; Hb = H - 2 * t; }
    if (lid === 'slide') { Hf = zSlide; Hb = zSlide; }
    if (lid === 'hinge') { Hf = H - 2 * t; Hb = H - 3 * t; }

    // Klappdeckel: Drehachse in der Deckelmitte, so weit vor der Rückwand, dass die Kante frei schwenkt
    const R2 = Math.SQRT1_2 * t;                      // halbe Diagonale des Zapfens t × t
    const yPivot = D - t - R2 - c, zPivot = H - 1.5 * t;
    const yHingeBack = yPivot + t / 2;                // Hinterkante des Klappdeckels
    // Schiebedeckel: breiter Teil läuft bis zum Schlitzende, dahinter eine schmale Zunge
    const slideLen = D - 3 * t;

    // ── Wände ────────────────────────────────────────────────────────
    const fixedTop = lid === 'fixed';
    const wallFB = (Hw) => ({
      top:    fixedTop ? fing(W, t, W - t, 0, -t, true) : flat(W),
      right:  fing(Hw, 0, Hw, 0, -t, true),
      bottom: fing(W, t, W - t, 0, -t, true),
      left:   fing(Hw, 0, Hw, 0, -t, true),
    });
    // Seitenkante der Seitenwand: Zinken nur so hoch wie die Nachbarwand (Hj), darüber deckt sie die Ecke
    const sideEdge = (Hj) => {
      const a = Hs - Hj;
      const segs = fing(Hs, a, Hs, t, 0, false);
      return a > 1e-9 ? overlay(segs, 0, a + k / 2, t) : segs;
    };
    const wallLR = (front) => {
      const s = {
        top:    fixedTop ? fing(D - 2 * t, 0, D - 2 * t, 0, -t, true) : flat(D - 2 * t),
        right:  sideEdge(front === 'right' ? Hf : Hk),
        bottom: fing(D - 2 * t, 0, D - 2 * t, 0, -t, true),
        left:   sideEdge(front === 'left' ? Hf : Hk),
      };
      // Schiebedeckel: Schlitz von der Vorderkante bis zum Anschlag
      if (lid === 'slide') s[front] = overlay(s[front], H - zSlide - t - c, H - zSlide, t - slideLen - c);
      return s;
    };
    const plate = () => ({
      top:    fing(W - 2 * t, 0, W - 2 * t, t, 0, false),
      right:  fing(D - 2 * t, 0, D - 2 * t, t, 0, false),
      bottom: fing(W - 2 * t, 0, W - 2 * t, t, 0, false),
      left:   fing(D - 2 * t, 0, D - 2 * t, t, 0, false),
    });

    // ── Zwischenwände ─────────────────────────────────────────────────
    const divs = (P.dividers || []).filter((d) => d.dir === 'x' || d.dir === 'y');
    const xDivs = divs.filter((d) => d.dir === 'x');
    const yDivs = divs.filter((d) => d.dir === 'y');
    const mid = (t + Hb) / 2;                         // Mitte für die Kreuzschlitze
    const slotW = t - k;                              // gezeichnete Schlitzbreite

    for (const d of divs) {
      const axis = d.dir === 'x' ? W : D;           // entlang dieser Achse liegt pos
      const lo = 3 * t, hi = axis - 3 * t;
      if (d.pos < lo || d.pos > hi) warnings.push(`Zwischenwand bei ${fmt(d.pos)} mm liegt zu nah an der Wand (erlaubt: ${fmt(lo)} bis ${fmt(hi)} mm).`);
    }
    const sortedPos = (arr) => arr.map((d) => d.pos).sort((a, b) => a - b);
    for (const arr of [xDivs, yDivs]) {
      const ps = sortedPos(arr);
      for (let i = 1; i < ps.length; i++) {
        if (ps[i] - ps[i - 1] < 3 * t) warnings.push('Zwei Zwischenwände liegen zu dicht beieinander.');
      }
    }

    // Zapfen an den senkrechten Enden: Bereich z ∈ [t, min(H−t, Hb)], Lücke zuerst
    const endSpan = Math.min(H - t, Hb) - t;
    const nEnd = oddCount(endSpan, f, 3);
    const endW = endSpan / nEnd;
    const endTabsZ = [];                              // [z0, z1] (z von unten)
    for (let i = 1; i < nEnd; i += 2) endTabsZ.push([t + i * endW, t + (i + 1) * endW]);
    if (endW < t) warnings.push('Die Höhe ist zu klein für Zapfen der Zwischenwände.');

    // Zapfen am Boden: je Zwischenwand über ihre Spannweite
    function bottomTabs(span, avoid) {
      const L = span - 2 * t;
      const n = oddCount(L, f, 3);
      const w = L / n;
      const tabs = [];
      for (let i = 1; i < n; i += 2) {
        const u0 = t + i * w, u1 = t + (i + 1) * w;
        const hit = avoid.some((c) => c + t / 2 + k > u0 && c - t / 2 - k < u1);
        if (!hit) tabs.push([u0, u1]);
      }
      return tabs;
    }
    const bottomTabsFor = new Map();                  // id → [[u0,u1],...] in Wandkoordinaten
    for (const d of xDivs) bottomTabsFor.set(d.id, bottomTabs(D, []));
    for (const d of yDivs) bottomTabsFor.set(d.id, bottomTabs(W, xDivs.map((x) => x.pos)));

    // ── Löcher (Schlitze) für Zwischenwände ───────────────────────────
    const rect = (x0, y0, x1, y1) => ({ type: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    const hk = k / 2;
    // Hw = Höhe der Wand (v wird von ihrer Oberkante gemessen)
    const slotsFB = (flip, Hw) => xDivs.flatMap((d) => {
      const at = flip ? W - d.pos : d.pos;
      return endTabsZ.map(([z0, z1]) =>
        rect(at - slotW / 2, Hw - (z1 - hk), at + slotW / 2, Hw - (z0 + hk)));
    });
    const slotsLR = (flip) => yDivs.flatMap((d) => {
      const at = flip ? D - d.pos : d.pos;
      return endTabsZ.map(([z0, z1]) =>
        rect(at - slotW / 2, Hs - (z1 - hk), at + slotW / 2, Hs - (z0 + hk)));
    });
    // Klappdeckel: runde Lager für die Zapfen (Diagonale t·√2 plus Spiel)
    const pivotHole = (flip) => (lid === 'hinge'
      ? [{ type: 'circle', x: flip ? D - yPivot : yPivot, y: Hs - zPivot, d: 2 * (R2 + c) }] : []);
    const slotsBottom = () => {
      const out = [];
      for (const d of xDivs) {
        for (const [u0, u1] of bottomTabsFor.get(d.id)) {
          out.push(rect(d.pos - slotW / 2, D - (u1 - hk), d.pos + slotW / 2, D - (u0 + hk)));
        }
      }
      for (const d of yDivs) {
        for (const [u0, u1] of bottomTabsFor.get(d.id)) {
          out.push(rect(u0 + hk, D - d.pos - slotW / 2, u1 - hk, D - d.pos + slotW / 2));
        }
      }
      return out;
    };

    /**
     * Teil anlegen. pose = Lage in der Box (siehe place): Teilpunkt (u, v), Dicke w ∈ [0, t]
     * liegt bei o + u·U + v·V + w·N; out = Richtung der Explosionsansicht.
     */
    const add = (id, name, kind, w, h, body, sides, holes, dims, pose) => {
      const outline = walk(body, sides);
      parts.push({ id, name, kind, w, h, outline, holes: holes || [], dims: dims || {}, pose });
      return parts[parts.length - 1];
    };
    const down = [0, 0, -1];
    const hDim = (Hw) => (Hw === H ? 'H' : null);     // nur volle Wandhöhe ist als Boxhöhe änderbar

    add('front', 'Vorderwand', 'wall', W, Hf, { x: 0, y: 0, w: W, h: Hf }, wallFB(Hf), slotsFB(false, Hf),
        { w: 'W', h: hDim(Hf) }, { o: [0, 0, Hf], U: [1, 0, 0], V: down, N: [0, 1, 0], out: [0, -1, 0] });
    add('back', 'Rückwand', 'wall', W, Hk, { x: 0, y: 0, w: W, h: Hk }, wallFB(Hk), slotsFB(true, Hk),
        { w: 'W', h: hDim(Hk) }, { o: [W, D - t, Hk], U: [-1, 0, 0], V: down, N: [0, 1, 0], out: [0, 1, 0] });
    add('left', 'Linke Wand', 'wall', D, Hs, { x: t, y: 0, w: D - 2 * t, h: Hs }, wallLR('left'),
        [...slotsLR(false), ...pivotHole(false)],
        { w: 'D', h: hDim(Hs) }, { o: [0, 0, Hs], U: [0, 1, 0], V: down, N: [1, 0, 0], out: [-1, 0, 0] });
    add('right', 'Rechte Wand', 'wall', D, Hs, { x: t, y: 0, w: D - 2 * t, h: Hs }, wallLR('right'),
        [...slotsLR(true), ...pivotHole(true)],
        { w: 'D', h: hDim(Hs) }, { o: [W - t, D, Hs], U: [0, -1, 0], V: down, N: [1, 0, 0], out: [1, 0, 0] });
    add('bottom', 'Boden', 'plate', W, D, { x: t, y: t, w: W - 2 * t, h: D - 2 * t }, plate(), slotsBottom(),
        { w: 'W', h: 'D' }, { o: [0, D, 0], U: [1, 0, 0], V: [0, -1, 0], N: [0, 0, 1], out: [0, 0, -1] });

    // ── Deckel ────────────────────────────────────────────────────────
    const up = [0, 0, 1], flatSides = (w, h) => ({ top: flat(w), right: flat(h), bottom: flat(h), left: flat(w) });
    const lidPose = (o, out) => ({ o, U: [1, 0, 0], V: [0, -1, 0], N: [0, 0, 1], out: out || up });
    let lidPart = null;
    if (lid === 'fixed') {
      lidPart = add('top', 'Deckel', 'plate', W, D, { x: t, y: t, w: W - 2 * t, h: D - 2 * t }, plate(), [],
          { w: 'W', h: 'D' }, lidPose([0, D, H - t]));
    } else if (lid === 'lift') {
      // liegt auf den Wänden; der Einsatz darunter (aufkleben) hält ihn in Position
      lidPart = add('top', 'Deckel', 'plate', W, D, { x: 0, y: 0, w: W, h: D }, flatSides(W, D), [],
          { w: 'W', h: 'D' }, lidPose([0, D, H - t]));
      const wi = W - 2 * t - 2 * c, di = D - 2 * t - 2 * c;
      add('insert', 'Deckel-Einsatz', 'plate', wi, di, { x: 0, y: 0, w: wi, h: di }, flatSides(wi, di), [],
          { w: null, h: null }, lidPose([t + c, D - t - c, H - 2 * t])).lid = true;
    } else if (lid === 'slide') {
      // volle Breite W (läuft durch die Seitenwände), hinten eine Zunge zwischen den Seitenwänden
      const L = D - t - c, tongue = L - slideLen, side = [[0, tongue, 0], [tongue, L, t + c]];
      lidPart = add('top', 'Schiebedeckel', 'plate', W, L, { x: t + c, y: 0, w: W - 2 * t - 2 * c, h: L },
          { top: flat(W - 2 * t - 2 * c), right: side, bottom: flat(W - 2 * t - 2 * c), left: side }, [],
          { w: 'W', h: null }, lidPose([0, L, zSlide], [0, -1, 0]));
    } else if (lid === 'hinge') {
      // zwischen den Seitenwänden; hinten zwei Zapfen t × t durch die Lager der Seitenwände
      const L = yHingeBack, side = [[0, t, t + c], [t, L, 0]];
      lidPart = add('top', 'Klappdeckel', 'plate', W, L, { x: t + c, y: 0, w: W - 2 * t - 2 * c, h: L },
          { top: flat(W - 2 * t - 2 * c), right: side, bottom: flat(W - 2 * t - 2 * c), left: side }, [],
          { w: 'W', h: null }, lidPose([0, L, H - 2 * t]));
    }
    if (lidPart) lidPart.lid = true;

    // Zwischenwände
    const divPart = (d, idx) => {
      const isX = d.dir === 'x';
      const span = isX ? D : W;
      const crossing = (isX ? yDivs : xDivs).map((o) => o.pos);   // Positionen der Gegenwände
      const L = span - 2 * t;
      const endTabsV = endTabsZ.map(([z0, z1]) => [Hb - z1, Hb - z0]);   // v von oben
      // Seitenlänge: Körper reicht von v=0 (z=Hb) bis v=Hb−t (z=t)
      const sideL = Hb - t;
      const sideSegs = segsFromTabs(sideL, endTabsV, t, k);
      let top = flat(L);
      let bottom = segsFromTabs(L, bottomTabsFor.get(d.id).map(([a, b]) => [a - t, b - t]), t, k);
      if (isX) {
        // X-Wand: Kreuzschlitz von oben
        for (const cp of crossing) top = overlay(top, cp - t - slotW / 2, cp - t + slotW / 2, -(Hb - mid));
      } else {
        // Y-Wand: Kreuzschlitz von unten (in der Zapfenreihe)
        for (const cp of crossing) bottom = overlay(bottom, cp - t - slotW / 2, cp - t + slotW / 2, -(mid - t));
      }
      const num = idx + 1;
      const pose = isX
        ? { o: [d.pos - t / 2, 0, Hb], U: [0, 1, 0], V: down, N: [1, 0, 0], out: up }
        : { o: [0, d.pos - t / 2, Hb], U: [1, 0, 0], V: down, N: [0, 1, 0], out: up };
      add('div_' + d.id, `Zwischenwand ${num}`, 'divider', span, Hb,
          { x: t, y: 0, w: L, h: Hb - t },
          { top, right: sideSegs, bottom, left: sideSegs },
          [], isX ? { w: 'D', h: null } : { w: 'W', h: null }, pose)
        .divider = { id: d.id, dir: d.dir, pos: d.pos };
    };
    divs.forEach(divPart);

    return { parts, warnings };
  }

  function fmt(v) { return (Math.round(v * 100) / 100).toString().replace('.', ','); }

  /** Teile zeilenweise auf einem Bogen anordnen. Setzt part.ox / part.oy. */
  function layout(parts, gap, maxWidth) {
    const totalArea = parts.reduce((s, p) => s + (p.w + gap) * (p.h + gap), 0);
    const widest = parts.reduce((m, p) => Math.max(m, p.w), 0);
    const limit = maxWidth || Math.max(widest, Math.sqrt(totalArea) * 1.5);
    let x = 0, y = 0, rowH = 0, sheetW = 0;
    for (const p of parts) {
      if (x > 0 && x + p.w > limit) { x = 0; y += rowH + gap; rowH = 0; }
      p.ox = x; p.oy = y;
      x += p.w + gap;
      rowH = Math.max(rowH, p.h);
      sheetW = Math.max(sheetW, x - gap);
    }
    return { w: sheetW, h: y + rowH };
  }

  /**
   * Lage eines Teils in der fertigen Box. Welt: x nach rechts, y nach hinten, z nach oben,
   * Ursprung vorn links unten. Der Teilpunkt (u, v) liegt in der Dicke w ∈ [0, t] bei
   * o + u·U + v·V + w·N. out = Richtung, in die das Teil in der Explosionsansicht wandert.
   * build() legt die Lage beim Erzeugen fest (part.pose).
   */
  function place(P, part) {
    return part.pose;
  }

  /** Gleichmäßige Positionen (Mitte der Wand) für n Zwischenwände auf der Länge L. */
  function evenPositions(L, t, n) {
    const out = [];
    const c = (L - 2 * t - n * t) / (n + 1);
    for (let i = 1; i <= n; i++) out.push(t + i * c + (i - 1) * t + t / 2);
    return out;
  }

  const api = { build, layout, place, heightLoss, LIDS, evenPositions, oddCount, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BoxGeo = api;
})(typeof window !== 'undefined' ? window : globalThis);
