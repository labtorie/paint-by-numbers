/*
 * Ядро генератора раскрасок по номерам.
 *
 * Конвейер (всё в перцептивном пространстве Oklab):
 *  1. билатеральное сглаживание — убирает шум/текстуру, не трогая края;
 *  2. карта значимости — где в кадре структура (лицо, глаза, контуры), а где фон;
 *  3. палитра — взвешенный k-means со сжатием плотности, чтобы маленькие,
 *     но важные цвета не съедались большими однотонными площадями;
 *  4. разметка — не «ближайший цвет» (постеризация), а минимизация энергии
 *     Поттса с учётом краёв: границы областей ложатся на реальные контуры;
 *  5. слияние областей с адаптивным порогом: в значимых и контрастных местах
 *     допускаются мелкие области, на фоне — только крупные;
 *  6. векторизация: общие границы трассируются один раз, сглаживаются
 *     и превращаются в кривые Безье — без «лесенок» и щелей.
 *
 * Фабрика самодостаточна: её исходник превращается в Web Worker через Blob.
 */
(function (root) {
  function algoFactory() {
    'use strict';
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const lerp = (a, b, t) => a + (b - a) * t;

    // ---------- цвет ----------
    const LIN = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const c = i / 255;
      LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    function toOklab(rgba, n) {
      const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const al = rgba[j + 3] / 255;
        let r = LIN[rgba[j]], g = LIN[rgba[j + 1]], b = LIN[rgba[j + 2]];
        if (al < 1) { r = r * al + 1 - al; g = g * al + 1 - al; b = b * al + 1 - al; }
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        L[i] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
        A[i] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
        B[i] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
      }
      return [L, A, B];
    }
    function oklabToRgb(L, a, b) {
      const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
      const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
      const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
      const lin = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ];
      return lin.map((c) => {
        c = clamp(c, 0, 1);
        c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        return Math.round(clamp(c, 0, 1) * 255);
      });
    }

    // ---------- 1. билатеральный фильтр ----------
    function bilateral(L, A, B, w, h, radius, sigmaS, sigmaR, iters, tick) {
      const n = w * h;
      let sL = L, sA = A, sB = B;
      let dL = new Float32Array(n), dA = new Float32Array(n), dB = new Float32Array(n);
      const ox = [], oy = [], ow = [];
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius + 1) continue;
          ox.push(dx); oy.push(dy);
          ow.push(Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS)));
        }
      const taps = ox.length;
      const LUTN = 2048, maxD2 = 12 * sigmaR * sigmaR, scale = LUTN / maxD2;
      const lut = new Float32Array(LUTN);
      for (let i = 0; i < LUTN; i++) lut[i] = Math.exp(-(i / scale) / (2 * sigmaR * sigmaR));
      for (let it = 0; it < iters; it++) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const cl = sL[i], ca = sA[i], cb = sB[i];
            let sl = 0, sa = 0, sb = 0, sw = 0;
            for (let k = 0; k < taps; k++) {
              const xx = x + ox[k], yy = y + oy[k];
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const j = yy * w + xx;
              const l = sL[j], a = sA[j], b = sB[j];
              const q = (((l - cl) * (l - cl) + (a - ca) * (a - ca) + (b - cb) * (b - cb)) * scale) | 0;
              if (q >= LUTN) continue;
              const wg = ow[k] * lut[q];
              sl += l * wg; sa += a * wg; sb += b * wg; sw += wg;
            }
            dL[i] = sl / sw; dA[i] = sa / sw; dB[i] = sb / sw;
          }
          if ((y & 63) === 0) tick((it + y / h) / iters);
        }
        if (it === 0) { sL = dL; sA = dA; sB = dB; dL = new Float32Array(n); dA = new Float32Array(n); dB = new Float32Array(n); }
        else { let t = sL; sL = dL; dL = t; t = sA; sA = dA; dA = t; t = sB; sB = dB; dB = t; }
      }
      return [sL, sA, sB];
    }

    // ---------- 2. карта значимости ----------
    function boxBlur(src, w, h, r) {
      const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const o = y * w; let s = 0, c = 0;
        for (let x = 0; x <= Math.min(r, w - 1); x++) { s += src[o + x]; c++; }
        for (let x = 0; x < w; x++) {
          tmp[o + x] = s / c;
          const add = x + r + 1, rem = x - r;
          if (add < w) { s += src[o + add]; c++; }
          if (rem >= 0) { s -= src[o + rem]; c--; }
        }
      }
      for (let x = 0; x < w; x++) {
        let s = 0, c = 0;
        for (let y = 0; y <= Math.min(r, h - 1); y++) { s += tmp[y * w + x]; c++; }
        for (let y = 0; y < h; y++) {
          out[y * w + x] = s / c;
          const add = y + r + 1, rem = y - r;
          if (add < h) { s += tmp[add * w + x]; c++; }
          if (rem >= 0) { s -= tmp[rem * w + x]; c--; }
        }
      }
      return out;
    }
    function importanceMap(L, A, B, w, h) {
      const n = w * h, g = new Float32Array(n);
      for (let y = 0; y < h; y++) {
        const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
        for (let x = 0; x < w; x++) {
          const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x;
          const a = y * w + x0, b = y * w + x1, c = y0 * w + x, d = y1 * w + x;
          const gx = (L[b] - L[a]) ** 2 + (A[b] - A[a]) ** 2 + (B[b] - B[a]) ** 2;
          const gy = (L[d] - L[c]) ** 2 + (A[d] - A[c]) ** 2 + (B[d] - B[c]) ** 2;
          g[y * w + x] = Math.sqrt(gx + gy);
        }
      }
      const r = Math.max(3, Math.round(Math.max(w, h) / 45));
      let imp = boxBlur(boxBlur(boxBlur(g, w, h, r), w, h, r), w, h, r);
      const sample = [];
      for (let i = 0; i < n; i += 13) sample.push(imp[i]);
      sample.sort((p, q) => p - q);
      const hi = sample[Math.floor(sample.length * 0.96)] || 1e-6;
      const lo = sample[Math.floor(sample.length * 0.1)] || 0;
      const span = Math.max(hi - lo, 1e-6);
      for (let i = 0; i < n; i++) imp[i] = Math.pow(clamp((imp[i] - lo) / span, 0, 1), 0.8);
      return imp;
    }

    // ---------- 3. палитра ----------
    function buildPalette(L, A, B, imp, n, K) {
      const NB = 40, total = NB * NB * NB;
      const bw = new Float64Array(total), bl = new Float64Array(total), ba = new Float64Array(total), bb = new Float64Array(total);
      for (let i = 0; i < n; i++) {
        const li = clamp((L[i] * NB) | 0, 0, NB - 1);
        const ai = clamp(((A[i] + 0.6) / 1.2 * NB) | 0, 0, NB - 1);
        const bi = clamp(((B[i] + 0.6) / 1.2 * NB) | 0, 0, NB - 1);
        const k = (li * NB + ai) * NB + bi, wg = 1 + 2.5 * imp[i];
        bw[k] += wg; bl[k] += L[i] * wg; ba[k] += A[i] * wg; bb[k] += B[i] * wg;
      }
      const pl = [], pa = [], pb = [], pw = [];
      for (let k = 0; k < total; k++) if (bw[k] > 0) {
        pl.push(bl[k] / bw[k]); pa.push(ba[k] / bw[k]); pb.push(bb[k] / bw[k]);
        // сжатие плотности: большие ровные площади не должны забирать все цвета
        pw.push(Math.pow(bw[k], 0.72));
      }
      const P = pl.length;
      K = Math.min(K, P);
      const cl = new Float64Array(K), ca = new Float64Array(K), cb = new Float64Array(K);
      const minD = new Float64Array(P).fill(Infinity);
      let first = 0;
      for (let i = 1; i < P; i++) if (pw[i] > pw[first]) first = i;
      let pick = first;
      for (let k = 0; k < K; k++) {
        cl[k] = pl[pick]; ca[k] = pa[pick]; cb[k] = pb[pick];
        let best = -1, bi = 0;
        for (let i = 0; i < P; i++) {
          const d = (pl[i] - cl[k]) ** 2 + (pa[i] - ca[k]) ** 2 + (pb[i] - cb[k]) ** 2;
          if (d < minD[i]) minD[i] = d;
          const sc = minD[i] * Math.sqrt(pw[i]);
          if (sc > best) { best = sc; bi = i; }
        }
        pick = bi;
      }
      const asg = new Int32Array(P);
      for (let it = 0; it < 40; it++) {
        const sl = new Float64Array(K), sa = new Float64Array(K), sb = new Float64Array(K), sw = new Float64Array(K);
        let moved = 0;
        for (let i = 0; i < P; i++) {
          let best = Infinity, bk = 0;
          for (let k = 0; k < K; k++) {
            const d = (pl[i] - cl[k]) ** 2 + (pa[i] - ca[k]) ** 2 + (pb[i] - cb[k]) ** 2;
            if (d < best) { best = d; bk = k; }
          }
          if (asg[i] !== bk) { asg[i] = bk; moved++; }
          minD[i] = best;
          sl[bk] += pl[i] * pw[i]; sa[bk] += pa[i] * pw[i]; sb[bk] += pb[i] * pw[i]; sw[bk] += pw[i];
        }
        for (let k = 0; k < K; k++) {
          if (sw[k] > 0) { cl[k] = sl[k] / sw[k]; ca[k] = sa[k] / sw[k]; cb[k] = sb[k] / sw[k]; }
          else {
            let bi = 0;
            for (let i = 1; i < P; i++) if (minD[i] * pw[i] > minD[bi] * pw[bi]) bi = i;
            cl[k] = pl[bi]; ca[k] = pa[bi]; cb[k] = pb[bi]; minD[bi] = 0; moved++;
          }
        }
        if (it > 3 && moved === 0) break;
      }
      return { l: cl, a: ca, b: cb, K };
    }

    function assignNearest(L, A, B, n, pal) {
      const labels = new Uint8Array(n), K = pal.K;
      for (let i = 0; i < n; i++) {
        let best = Infinity, bk = 0;
        const l = L[i], a = A[i], b = B[i];
        for (let k = 0; k < K; k++) {
          const d = (l - pal.l[k]) ** 2 + (a - pal.a[k]) ** 2 + (b - pal.b[k]) ** 2;
          if (d < best) { best = d; bk = k; }
        }
        labels[i] = bk;
      }
      return labels;
    }

    // ---------- 4. разметка: модель Поттса с учётом краёв (ICM) ----------
    function potts(labels, L, A, B, imp, w, h, pal, lambda, sigmaE, iters, tick) {
      const n = w * h;
      const NX = [1, 1, 0, -1, -1, -1, 0, 1], NY = [0, 1, 1, 1, 0, -1, -1, -1];
      const NW = [1, 0.7071, 1, 0.7071, 1, 0.7071, 1, 0.7071];
      const LUTN = 1024, maxD2 = 14 * sigmaE * sigmaE, scale = LUTN / maxD2;
      const lut = new Float32Array(LUTN);
      for (let i = 0; i < LUTN; i++) lut[i] = Math.exp(-(i / scale) / (2 * sigmaE * sigmaE));
      const cL = new Int32Array(9), cW = new Float32Array(9);
      for (let it = 0; it < iters; it++) {
        let changed = 0;
        const rev = it & 1;
        for (let yy = 0; yy < h; yy++) {
          const y = rev ? h - 1 - yy : yy;
          for (let xx = 0; xx < w; xx++) {
            const x = rev ? w - 1 - xx : xx;
            const i = y * w + x, cur = labels[i];
            const l = L[i], a = A[i], b = B[i];
            let nc = 0, same = true;
            for (let k = 0; k < 8; k++) {
              const px = x + NX[k], py = y + NY[k];
              if (px < 0 || py < 0 || px >= w || py >= h) continue;
              const j = py * w + px, lab = labels[j];
              if (lab !== cur) same = false;
              const q = (((L[j] - l) ** 2 + (A[j] - a) ** 2 + (B[j] - b) ** 2) * scale) | 0;
              const wg = q >= LUTN ? 0 : NW[k] * lut[q];
              let c = 0;
              while (c < nc && cL[c] !== lab) c++;
              if (c === nc) { cL[nc] = lab; cW[nc] = wg; nc++; } else cW[c] += wg;
            }
            if (same) continue;
            const lam = lambda * (1 - 0.6 * imp[i]);
            let wCur = 0;
            for (let c = 0; c < nc; c++) if (cL[c] === cur) wCur = cW[c];
            let best = cur;
            let bestCost = (l - pal.l[cur]) ** 2 + (a - pal.a[cur]) ** 2 + (b - pal.b[cur]) ** 2 - lam * wCur;
            for (let c = 0; c < nc; c++) {
              const lab = cL[c];
              if (lab === cur) continue;
              const cost = (l - pal.l[lab]) ** 2 + (a - pal.a[lab]) ** 2 + (b - pal.b[lab]) ** 2 - lam * cW[c];
              if (cost < bestCost - 1e-9) { bestCost = cost; best = lab; }
            }
            if (best !== cur) { labels[i] = best; changed++; }
          }
        }
        tick((it + 1) / iters);
        if (changed < n * 0.0004) break;
      }
    }

    // ---------- связные компоненты ----------
    function components(labels, w, h) {
      const n = w * h, rid = new Int32Array(n).fill(-1), stack = new Int32Array(n);
      const regLabel = [], area = [];
      let count = 0;
      for (let s = 0; s < n; s++) {
        if (rid[s] >= 0) continue;
        const lab = labels[s];
        let sp = 0, ar = 0;
        stack[sp++] = s; rid[s] = count;
        while (sp > 0) {
          const p = stack[--sp]; ar++;
          const x = p % w;
          if (x > 0 && rid[p - 1] < 0 && labels[p - 1] === lab) { rid[p - 1] = count; stack[sp++] = p - 1; }
          if (x < w - 1 && rid[p + 1] < 0 && labels[p + 1] === lab) { rid[p + 1] = count; stack[sp++] = p + 1; }
          if (p >= w && rid[p - w] < 0 && labels[p - w] === lab) { rid[p - w] = count; stack[sp++] = p - w; }
          if (p < n - w && rid[p + w] < 0 && labels[p + w] === lab) { rid[p + w] = count; stack[sp++] = p + w; }
        }
        regLabel.push(lab); area.push(ar); count++;
      }
      return { rid, count, regLabel, area };
    }

    // расстояние до ближайшей границы области (chamfer)
    function distanceMap(rid, w, h) {
      const n = w * h, d = new Float32Array(n), D1 = 1, D2 = 1.4142;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = y * w + x, r = rid[i];
          const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
            rid[i - 1] !== r || rid[i + 1] !== r || rid[i - w] !== r || rid[i + w] !== r;
          d[i] = edge ? 0.5 : 1e9;
        }
      for (let y = 1; y < h; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          let v = d[i];
          if (d[i - 1] + D1 < v) v = d[i - 1] + D1;
          if (d[i - w] + D1 < v) v = d[i - w] + D1;
          if (d[i - w - 1] + D2 < v) v = d[i - w - 1] + D2;
          if (d[i - w + 1] + D2 < v) v = d[i - w + 1] + D2;
          d[i] = v;
        }
      for (let y = h - 2; y >= 0; y--)
        for (let x = w - 2; x >= 1; x--) {
          const i = y * w + x;
          let v = d[i];
          if (d[i + 1] + D1 < v) v = d[i + 1] + D1;
          if (d[i + w] + D1 < v) v = d[i + w] + D1;
          if (d[i + w + 1] + D2 < v) v = d[i + w + 1] + D2;
          if (d[i + w - 1] + D2 < v) v = d[i + w - 1] + D2;
          d[i] = v;
        }
      return d;
    }

    // ---------- 5. слияние областей ----------
    // mode 'area': адаптивный порог площади; mode 'thin': области тоньше minThick
    function mergeRegions(labels, L, A, B, imp, w, h, pal, P, mode) {
      const n = w * h, K = pal.K;
      const bc = new Float64Array(K);
      let totalMerged = 0;
      for (let pass = 0; pass < 24; pass++) {
        const cc = components(labels, w, h);
        const { rid, count, regLabel, area } = cc;
        let cand = [];
        if (mode === 'area') {
          for (let r = 0; r < count; r++) if (area[r] < P.minArea) cand.push(r);
        } else {
          const dm = distanceMap(rid, w, h), mx = new Float32Array(count);
          for (let i = 0; i < n; i++) if (dm[i] > mx[rid[i]]) mx[rid[i]] = dm[i];
          for (let r = 0; r < count; r++) if (mx[r] < P.minThick) cand.push(r);
        }
        if (!cand.length) break;
        const start = new Int32Array(count + 1);
        for (let i = 0; i < n; i++) start[rid[i] + 1]++;
        for (let r = 0; r < count; r++) start[r + 1] += start[r];
        const pos = start.slice(0, count), order = new Int32Array(n);
        for (let i = 0; i < n; i++) order[pos[rid[i]]++] = i;
        cand.sort((p, q) => area[p] - area[q]);
        const touched = new Uint8Array(count);
        let merged = 0;
        for (const r of cand) {
          if (touched[r]) continue;
          const own = regLabel[r], ar = area[r];
          let sl = 0, sa = 0, sb = 0, si = 0, border = 0;
          const nbLabs = [], nbRegs = [];
          for (let t = start[r]; t < start[r + 1]; t++) {
            const p = order[t], x = p % w;
            sl += L[p]; sa += A[p]; sb += B[p]; si += imp[p];
            for (let k = 0; k < 4; k++) {
              let q;
              if (k === 0) { if (x === 0) continue; q = p - 1; }
              else if (k === 1) { if (x === w - 1) continue; q = p + 1; }
              else if (k === 2) { if (p < w) continue; q = p - w; }
              else { if (p >= n - w) continue; q = p + w; }
              if (rid[q] === r) continue;
              const lab = labels[q];
              if (bc[lab] === 0) nbLabs.push(lab);
              bc[lab]++; border++;
              nbRegs.push(rid[q]);
            }
          }
          if (!border) continue;
          sl /= ar; sa /= ar; sb /= ar; si /= ar;
          let cmin = Infinity;
          for (const lab of nbLabs) {
            const d = Math.sqrt((pal.l[own] - pal.l[lab]) ** 2 + (pal.a[own] - pal.a[lab]) ** 2 + (pal.b[own] - pal.b[lab]) ** 2);
            if (d < cmin) cmin = d;
          }
          // «чернильная» деталь: резко отличается от всех соседей и темнее (или светлее) каждого из них —
          // контур, зрачок, блик. Промежуточные полоски сглаживания под это не попадают.
          let ink = false;
          if (P.keepInk && cmin > P.inkC) {
            let dark = true, light = true;
            for (const lab of nbLabs) {
              if (bc[lab] < border * 0.08) continue;
              const dl = pal.l[lab] - pal.l[own];
              if (dl < P.inkDL) dark = false;
              if (dl > -P.inkDL) light = false;
            }
            ink = dark || light;
          }
          let keep = mode === 'thin' && ink;
          if (mode === 'area') {
            // значимое место и сильный контраст с соседями → деталь, а не шум
            const fc = Math.max(1 / (1 + (cmin / P.contrastRef) ** 2), 0.22);
            const thr = Math.max(P.minAbs, P.minArea * (1 - 0.62 * si) * fc);
            keep = ar >= thr || (ink && ar >= P.inkMin);
          }
          if (!keep) {
            let best = Infinity, bl = own;
            for (const lab of nbLabs) {
              const d = Math.sqrt((sl - pal.l[lab]) ** 2 + (sa - pal.a[lab]) ** 2 + (sb - pal.b[lab]) ** 2);
              const sc = d * (1.5 - 0.5 * bc[lab] / border);
              if (sc < best) { best = sc; bl = lab; }
            }
            for (let t = start[r]; t < start[r + 1]; t++) labels[order[t]] = bl;
            touched[r] = 1;
            for (const q of nbRegs) if (regLabel[q] === bl) touched[q] = 1;
            merged++;
          }
          for (const lab of nbLabs) bc[lab] = 0;
        }
        totalMerged += merged;
        if (!merged) break;
      }
      return totalMerged;
    }

    // ---------- шум: ложные линии ----------
    // Сквозные линии трёх видов, каждая — нулевой уровень гладкой функции на всей картинке:
    //   • длинные волнистые линии от края до края;
    //   • замкнутые «силуэты»-обманки (искажённые овалы);
    //   • изолинии случайного рельефа — похожи на границы настоящих цветовых пятен.
    // Каждая линия переключает свой бит в номере ячейки, поэтому она непрерывна
    // и проходит сквозь любые области, а не обрывается на их границах.
    function noiseCells(w, h, level, seed) {
      let s = seed >>> 0;
      const rnd = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const n = w * h, long = Math.max(w, h), t = clamp((level - 1) / 9, 0, 1);
      const field = (cs) => {
        const gw = Math.ceil(w / cs) + 2, gh = Math.ceil(h / cs) + 2, g = new Float32Array(gw * gh);
        for (let i = 0; i < g.length; i++) g[i] = rnd() * 2 - 1;
        const out = new Float32Array(n);
        for (let y = 0; y < h; y++) {
          const fy = y / cs, y0 = fy | 0;
          let ty = fy - y0; ty = ty * ty * (3 - 2 * ty);
          for (let x = 0; x < w; x++) {
            const fx = x / cs, x0 = fx | 0;
            let tx = fx - x0; tx = tx * tx * (3 - 2 * tx);
            const i = y0 * gw + x0, a = g[i], b = g[i + 1], c = g[i + gw], d = g[i + gw + 1];
            out[y * w + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
          }
        }
        return out;
      };
      const B0 = field(long * 0.3), B1 = field(long * 0.3), B2 = field(long * 0.21);
      const S0 = field(long * 0.07), S1 = field(long * 0.07);
      const mix = (k) => {
        const v = [];
        let l = 0;
        for (let i = 0; i < k; i++) { v.push(rnd() * 2 - 1); l += v[i] * v[i]; }
        l = Math.sqrt(l) || 1;
        return v.map((x) => x / l);
      };
      const cell = new Int32Array(n);
      const usedBits = new Set();
      const cut = (fn) => {
        let b;
        do { b = 1 + ((rnd() * 0x3ffffe) | 0); } while (usedBits.has(b));
        usedBits.add(b);
        for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (fn(x, y, i) > 0) cell[i] ^= b;
      };
      const nLines = Math.round(lerp(3, 13, t)), nBlobs = Math.round(lerp(2, 11, t)), nFields = Math.round(lerp(1, 3, t));
      for (let k = 0; k < nLines; k++) {
        const th = rnd() * Math.PI, cs = Math.cos(th), sn = Math.sin(th);
        const cx = (0.1 + 0.8 * rnd()) * w, cy = (0.1 + 0.8 * rnd()) * h;
        const [a, b, c] = mix(3), [d, e] = mix(2), amp = long * (0.05 + 0.07 * rnd()), amp2 = long * 0.012;
        cut((x, y, i) => (x - cx) * cs + (y - cy) * sn + amp * (a * B0[i] + b * B1[i] + c * B2[i]) + amp2 * (d * S0[i] + e * S1[i]));
      }
      for (let k = 0; k < nBlobs; k++) {
        const cx = rnd() * w, cy = rnd() * h, r = long * (0.06 + 0.17 * rnd()), ex = 0.7 + 0.6 * rnd();
        const [a, b, c] = mix(3), [d, e] = mix(2);
        cut((x, y, i) => Math.hypot((x - cx) * ex, (y - cy) / ex) - r * (1 + 0.5 * (a * B0[i] + b * B1[i] + c * B2[i]) + 0.09 * (d * S0[i] + e * S1[i])));
      }
      for (let k = 0; k < nFields; k++) {
        const [a, b, c] = mix(3), [d, e] = mix(2);
        const levels = rnd() < 0.5 ? [-0.18, 0.18] : [-0.3, 0, 0.3];
        for (const lv of levels)
          cut((x, y, i) => a * B0[i] + b * B1[i] + c * B2[i] + 0.06 * (d * S0[i] + e * S1[i]) - lv);
      }
      return cell;
    }
    // слишком мелкие и тонкие обрезки возвращаются к соседнему куску того же цвета
    function mergePieces(key, w, h, minArea, minThick) {
      const n = w * h;
      for (let pass = 0; pass < 16; pass++) {
        const { rid, count, regLabel, area } = components(key, w, h);
        const dm = distanceMap(rid, w, h), mx = new Float32Array(count);
        for (let i = 0; i < n; i++) if (dm[i] > mx[rid[i]]) mx[rid[i]] = dm[i];
        const cand = [];
        for (let r = 0; r < count; r++) if (area[r] < minArea || mx[r] < minThick) cand.push(r);
        if (!cand.length) break;
        const start = new Int32Array(count + 1);
        for (let i = 0; i < n; i++) start[rid[i] + 1]++;
        for (let r = 0; r < count; r++) start[r + 1] += start[r];
        const pos = start.slice(0, count), order = new Int32Array(n);
        for (let i = 0; i < n; i++) order[pos[rid[i]]++] = i;
        cand.sort((p, q) => area[p] - area[q]);
        const touched = new Uint8Array(count);
        let merged = 0;
        for (const r of cand) {
          if (touched[r]) continue;
          const own = regLabel[r] & 255, nb = new Map();
          for (let t = start[r]; t < start[r + 1]; t++) {
            const p = order[t], x = p % w;
            for (let k = 0; k < 4; k++) {
              let q;
              if (k === 0) { if (x === 0) continue; q = p - 1; }
              else if (k === 1) { if (x === w - 1) continue; q = p + 1; }
              else if (k === 2) { if (p < w) continue; q = p - w; }
              else { if (p >= n - w) continue; q = p + w; }
              const rq = rid[q];
              if (rq === r || (key[q] & 255) !== own) continue;
              const e = nb.get(rq);
              if (e) e.c++; else nb.set(rq, { c: 1, q });
            }
          }
          let best = null, br = -1;
          for (const [rq, e] of nb) if (!touched[rq] && (!best || e.c > best.c)) { best = e; br = rq; }
          if (!best) continue;
          const nk = key[best.q];
          for (let t = start[r]; t < start[r + 1]; t++) key[order[t]] = nk;
          touched[r] = 1; touched[br] = 1; merged++;
        }
        if (!merged) break;
      }
    }

    // ---------- 6. векторизация ----------
    function smoothPolyline(P, cnt, closed, iters) {
      let src = P, dst = new Float64Array(P.length);
      for (let it = 0; it < iters * 2; it++) {
        const f = it & 1 ? -0.34 : 0.5; // Таубин: сглаживает без усадки мелких контуров
        for (let i = 0; i < cnt; i++) {
          if (!closed && (i === 0 || i === cnt - 1)) { dst[2 * i] = src[2 * i]; dst[2 * i + 1] = src[2 * i + 1]; continue; }
          const p = (i - 1 + cnt) % cnt, q = (i + 1) % cnt;
          dst[2 * i] = src[2 * i] + f * ((src[2 * p] + src[2 * q]) / 2 - src[2 * i]);
          dst[2 * i + 1] = src[2 * i + 1] + f * ((src[2 * p + 1] + src[2 * q + 1]) / 2 - src[2 * i + 1]);
        }
        const t = src; src = dst; dst = t;
      }
      return src;
    }
    function rdp(P, cnt, eps) {
      const keep = new Uint8Array(cnt);
      keep[0] = keep[cnt - 1] = 1;
      const stack = [0, cnt - 1];
      while (stack.length) {
        const b = stack.pop(), a = stack.pop();
        if (b - a < 2) continue;
        const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
        let md = -1, mi = -1;
        for (let i = a + 1; i < b; i++) {
          const px = P[2 * i] - ax, py = P[2 * i + 1] - ay;
          let d;
          if (len2 < 1e-12) d = px * px + py * py;
          else { const c = px * dy - py * dx; d = (c * c) / len2; }
          if (d > md) { md = d; mi = i; }
        }
        if (md > eps * eps) { keep[mi] = 1; stack.push(a, mi, mi, b); }
      }
      const out = [];
      for (let i = 0; i < cnt; i++) if (keep[i]) out.push(P[2 * i], P[2 * i + 1]);
      return out;
    }
    const fmt = (v) => {
      const s = (Math.round(v * 100) / 100).toString();
      return s;
    };

    function vectorize(rid, w, h, regLabel, K, smoothIters, eps, tick, regInk) {
      const W1 = w + 1, H1 = h + 1;
      const hc = new Uint8Array(w * H1), vc = new Uint8Array(W1 * h);
      let total = 0;
      for (let y = 0; y <= h; y++)
        for (let x = 0; x < w; x++) {
          const a = y > 0 ? rid[(y - 1) * w + x] : -1, b = y < h ? rid[y * w + x] : -1;
          if (a !== b) { hc[y * w + x] = 1; total++; }
        }
      for (let y = 0; y < h; y++)
        for (let x = 0; x <= w; x++) {
          const a = x > 0 ? rid[y * w + x - 1] : -1, b = x < w ? rid[y * w + x] : -1;
          if (a !== b) { vc[y * W1 + x] = 1; total++; }
        }
      // направления: 0=E, 1=S, 2=W, 3=N
      const has = (x, y, d) =>
        d === 0 ? x < w && hc[y * w + x] === 1 :
        d === 1 ? y < h && vc[y * W1 + x] === 1 :
        d === 2 ? x > 0 && hc[y * w + x - 1] === 1 :
                  y > 0 && vc[(y - 1) * W1 + x] === 1;
      const deg = new Uint8Array(W1 * H1);
      for (let y = 0; y <= h; y++)
        for (let x = 0; x <= w; x++)
          deg[y * W1 + x] = (has(x, y, 0) ? 1 : 0) + (has(x, y, 1) ? 1 : 0) + (has(x, y, 2) ? 1 : 0) + (has(x, y, 3) ? 1 : 0);
      const hChain = new Int32Array(w * H1).fill(-1), vChain = new Int32Array(W1 * h).fill(-1);
      const hFwd = new Uint8Array(w * H1), vFwd = new Uint8Array(W1 * h);
      const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
      const pix = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : rid[y * w + x]);
      const leftPix = (x, y, d) => (d === 0 ? pix(x, y - 1) : d === 1 ? pix(x, y) : d === 2 ? pix(x - 1, y) : pix(x - 1, y - 1));
      const rightPix = (x, y, d) => (d === 0 ? pix(x, y) : d === 1 ? pix(x - 1, y) : d === 2 ? pix(x - 1, y - 1) : pix(x, y - 1));
      const crackChain = (x, y, d) => (d === 0 ? hChain[y * w + x] : d === 1 ? vChain[y * W1 + x] : d === 2 ? hChain[y * w + x - 1] : vChain[(y - 1) * W1 + x]);
      const crackFwd = (x, y, d) => (d === 0 ? hFwd[y * w + x] === 1 : d === 1 ? vFwd[y * W1 + x] === 1 : d === 2 ? hFwd[y * w + x - 1] === 0 : vFwd[(y - 1) * W1 + x] === 0);
      const setCrack = (x, y, d, c) => {
        if (d === 0) { hChain[y * w + x] = c; hFwd[y * w + x] = 1; }
        else if (d === 1) { vChain[y * W1 + x] = c; vFwd[y * W1 + x] = 1; }
        else if (d === 2) { hChain[y * w + x - 1] = c; hFwd[y * w + x - 1] = 0; }
        else { vChain[(y - 1) * W1 + x] = c; vFwd[(y - 1) * W1 + x] = 0; }
      };

      const pts = new Int32Array(total * 2 + 16);
      let np = 0;
      const cStart = [], cLen = [], cD0 = [], cDL = [], cLeft = [], cRight = [];
      const trace = (x0, y0, d0) => {
        const c = cStart.length, start = np;
        let x = x0, y = y0, d = d0;
        pts[np++] = y * W1 + x;
        cLeft.push(leftPix(x, y, d)); cRight.push(rightPix(x, y, d));
        for (;;) {
          setCrack(x, y, d, c);
          x += DX[d]; y += DY[d];
          pts[np++] = y * W1 + x;
          if (deg[y * W1 + x] !== 2 || (x === x0 && y === y0)) break;
          const back = (d + 2) & 3;
          let nd = -1;
          for (let k = 0; k < 4; k++) if (k !== back && has(x, y, k)) { nd = k; break; }
          d = nd;
        }
        cStart.push(start); cLen.push(np - start); cD0.push(d0); cDL.push(d);
      };
      for (let pass = 0; pass < 2; pass++)
        for (let y = 0; y <= h; y++)
          for (let x = 0; x <= w; x++) {
            const dg = deg[y * W1 + x];
            if (dg === 0 || (pass === 0) === (dg === 2)) continue;
            for (let d = 0; d < 4; d++) if (has(x, y, d) && crackChain(x, y, d) < 0) trace(x, y, d);
          }
      const nc = cStart.length;
      tick(0.3);

      // геометрия цепочек → строки путей (вперёд и назад)
      const fwdStr = new Array(nc), revStr = new Array(nc), sPt = new Array(nc), ePt = new Array(nc), isClosed = new Uint8Array(nc);
      for (let c = 0; c < nc; c++) {
        const s = cStart[c], m = cLen[c];
        const closed = deg[pts[s]] === 2;
        const border = cLeft[c] < 0 || cRight[c] < 0;
        let Q;
        if (border) {
          const P = new Float64Array(m * 2);
          for (let i = 0; i < m; i++) { P[2 * i] = pts[s + i] % W1; P[2 * i + 1] = (pts[s + i] / W1) | 0; }
          Q = rdp(P, m, 0.01);
        } else if (!closed) {
          const cnt = m + 1, P = new Float64Array(cnt * 2);
          P[0] = pts[s] % W1; P[1] = (pts[s] / W1) | 0;
          for (let i = 0; i < m - 1; i++) {
            const a = pts[s + i], b = pts[s + i + 1];
            P[2 * i + 2] = ((a % W1) + (b % W1)) / 2;
            P[2 * i + 3] = (((a / W1) | 0) + ((b / W1) | 0)) / 2;
          }
          P[2 * cnt - 2] = pts[s + m - 1] % W1; P[2 * cnt - 1] = (pts[s + m - 1] / W1) | 0;
          Q = rdp(smoothPolyline(P, cnt, false, smoothIters), cnt, eps);
        } else {
          const cnt = m - 1;
          let P = new Float64Array(cnt * 2);
          for (let i = 0; i < cnt; i++) {
            const a = pts[s + i], b = pts[s + i + 1];
            P[2 * i] = ((a % W1) + (b % W1)) / 2;
            P[2 * i + 1] = (((a / W1) | 0) + ((b / W1) | 0)) / 2;
          }
          P = smoothPolyline(P, cnt, true, smoothIters);
          const P2 = new Float64Array(cnt * 2 + 2);
          P2.set(P.subarray(0, cnt * 2)); P2[cnt * 2] = P[0]; P2[cnt * 2 + 1] = P[1];
          Q = rdp(P2, cnt + 1, eps);
        }
        const M = Q.length / 2; // для замкнутых Q[M-1] == Q[0]
        const cyc = closed && !border && M > 3;
        isClosed[c] = cyc ? 1 : 0;
        const linear = border || M < 3;
        sPt[c] = fmt(Q[0]) + ' ' + fmt(Q[1]);
        ePt[c] = fmt(Q[2 * M - 2]) + ' ' + fmt(Q[2 * M - 1]);
        let f = '', r = '';
        if (linear) {
          for (let i = 1; i < M; i++) f += 'L' + fmt(Q[2 * i]) + ' ' + fmt(Q[2 * i + 1]);
          for (let i = M - 2; i >= 0; i--) r += 'L' + fmt(Q[2 * i]) + ' ' + fmt(Q[2 * i + 1]);
        } else {
          // Catmull-Rom → кубические Безье; длина «усов» — треть своего сегмента (без петель и выбросов)
          const ux = new Float64Array(M), uy = new Float64Array(M);
          for (let i = 0; i < M; i++) {
            let p = i - 1, q = i + 1;
            if (cyc) { if (p < 0) p = M - 2; if (q > M - 1) q = 1; }
            else { if (p < 0) p = 0; if (q > M - 1) q = M - 1; }
            const dx = Q[2 * q] - Q[2 * p], dy = Q[2 * q + 1] - Q[2 * p + 1];
            const dl = Math.hypot(dx, dy) || 1;
            ux[i] = dx / dl; uy[i] = dy / dl;
          }
          const seg = (i0, i1, sg) => {
            const k = (sg * Math.hypot(Q[2 * i1] - Q[2 * i0], Q[2 * i1 + 1] - Q[2 * i0 + 1])) / 3;
            return 'C' + fmt(Q[2 * i0] + k * ux[i0]) + ' ' + fmt(Q[2 * i0 + 1] + k * uy[i0]) + ' ' +
              fmt(Q[2 * i1] - k * ux[i1]) + ' ' + fmt(Q[2 * i1 + 1] - k * uy[i1]) + ' ' +
              fmt(Q[2 * i1]) + ' ' + fmt(Q[2 * i1 + 1]);
          };
          for (let i = 0; i < M - 1; i++) f += seg(i, i + 1, 1);
          for (let i = M - 1; i > 0; i--) r += seg(i, i - 1, -1);
        }
        fwdStr[c] = f; revStr[c] = r;
      }
      tick(0.7);

      // контуры областей: обход с областью слева
      const visF = new Uint8Array(nc), visR = new Uint8Array(nc);
      const fillParts = [], inkParts = [];
      for (let k = 0; k < K; k++) fillParts.push([]);
      for (let c = 0; c < nc; c++)
        for (let rev = 0; rev < 2; rev++) {
          const reg = rev ? cRight[c] : cLeft[c];
          if (reg < 0 || (rev ? visR : visF)[c]) continue;
          const parts = [];
          parts.push('M' + (rev ? ePt[c] : sPt[c]));
          let cc = c, rr = rev, guard = 0;
          do {
            (rr ? visR : visF)[cc] = 1;
            parts.push(rr ? revStr[cc] : fwdStr[cc]);
            let v, d;
            if (!rr) { v = pts[cStart[cc] + cLen[cc] - 1]; d = cDL[cc]; }
            else { v = pts[cStart[cc]]; d = (cD0[cc] + 2) & 3; }
            const x = v % W1, y = (v / W1) | 0;
            let nd;
            if (leftPix(x, y, d) !== reg) nd = (d + 3) & 3;
            else if (rightPix(x, y, d) !== reg) nd = d;
            else nd = (d + 1) & 3;
            cc = crackChain(x, y, nd);
            rr = crackFwd(x, y, nd) ? 0 : 1;
          } while (!(cc === c && rr === rev) && ++guard < 5e6 && cc >= 0);
          parts.push('Z');
          const ring = parts.join('');
          fillParts[regLabel[reg]].push(ring);
          if (regInk && regInk[reg]) inkParts.push(ring);
        }
      const lineParts = [];
      for (let c = 0; c < nc; c++) lineParts.push('M' + sPt[c] + fwdStr[c] + (isClosed[c] ? 'Z' : ''));
      tick(1);
      return { fills: fillParts.map((p) => p.join('')), lines: lineParts.join(''), ink: inkParts.join(''), chains: nc };
    }

    // ---------- сборка ----------
    function process(rgba, w, h, opts, progress) {
      const t0 = Date.now();
      const n = w * h;
      const t = clamp((opts.detail - 1) / 9, 0, 1);
      const S = Math.max(w, h) / 1000;
      const stage = (name, a, b) => (p) => progress(name, a + (b - a) * p);
      progress('Подготовка', 0.01);
      let [L, A, B] = toOklab(rgba, n);

      const radius = clamp(Math.round(3 * S), 2, 4);
      [L, A, B] = bilateral(L, A, B, w, h, radius, 0.5 + 1.4 * S, lerp(0.07, 0.034, t), t < 0.45 ? 3 : 2, stage('Сглаживание с сохранением краёв', 0.02, 0.38));

      // оттенок для восприятия важнее, чем его доля в евклидовом расстоянии Oklab:
      // растягиваем хроматические оси, чтобы палитра не сливала разные по тону цвета
      const CS = 1.7;
      for (let i = 0; i < n; i++) { A[i] *= CS; B[i] *= CS; }

      progress('Карта значимости', 0.39);
      const imp = importanceMap(L, A, B, w, h);

      progress('Подбор палитры', 0.42);
      let pal = buildPalette(L, A, B, imp, n, clamp(opts.colors | 0, 2, 64));
      const labels = assignNearest(L, A, B, n, pal);

      potts(labels, L, A, B, imp, w, h, pal, lerp(0.0034, 0.001, t), 0.045, 7, stage('Разметка областей', 0.46, 0.66));

      progress('Слияние мелких областей', 0.67);
      const minArea = n * Math.exp(lerp(Math.log(1 / 1400), Math.log(1 / 13000), t));
      // чувствительность контуров 1..10 → cu 0..1 (−1 — режим выключен): чем выше, тем слабее контраст и мельче деталь,
      // которые ещё считаются контуром
      const cu = opts.contours > 0 ? clamp((opts.contours - 1) / 9, 0, 1) : -1;
      const MP = { minArea, minAbs: Math.max(5, minArea * 0.07), contrastRef: 0.13, minThick: lerp(3.0, 1.8, t) * Math.max(S, 0.6), keepInk: cu >= 0, inkC: lerp(0.3, 0.09, cu), inkDL: lerp(0.14, 0.05, cu), inkMin: Math.max(3, lerp(8, 3, cu) * S * S) };
      mergeRegions(labels, L, A, B, imp, w, h, pal, MP, 'area');
      for (let k = 0; k < 2; k++) {
        if (!mergeRegions(labels, L, A, B, imp, w, h, pal, MP, 'thin')) break;
        mergeRegions(labels, L, A, B, imp, w, h, pal, MP, 'area');
      }

      // палитра по фактическим областям, нумерация от светлого к тёмному
      progress('Уточнение палитры', 0.78);
      const K0 = pal.K, sl = new Float64Array(K0), sa = new Float64Array(K0), sb = new Float64Array(K0), cnt = new Float64Array(K0);
      for (let i = 0; i < n; i++) { const k = labels[i]; sl[k] += L[i]; sa[k] += A[i]; sb[k] += B[i]; cnt[k]++; }
      const used = [];
      for (let k = 0; k < K0; k++) if (cnt[k] > 0) used.push(k);
      used.sort((p, q) => sl[q] / cnt[q] - sl[p] / cnt[p]);
      const remap = new Int32Array(K0).fill(-1);
      used.forEach((k, i) => (remap[k] = i));
      for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
      const K = used.length;
      const palette = used.map((k) => {
        const rgb = oklabToRgb(sl[k] / cnt[k], sa[k] / cnt[k] / CS, sb[k] / cnt[k] / CS);
        return { rgb, hex: '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join(''), share: cnt[k] / n };
      });

      // шум: крупные области режутся на куски того же цвета
      let key = labels;
      const noise = clamp(+opts.noise || 0, 0, 10);
      if (noise > 0) {
        progress('Ложные линии', 0.79);
        const cell = noiseCells(w, h, noise, 0x9e3779b9);
        key = new Int32Array(n);
        for (let i = 0; i < n; i++) key[i] = cell[i] * 256 + labels[i];
        // порог обрезков ниже обычного: чем реже линия рвётся, тем хуже читается сюжет
        mergePieces(key, w, h, MP.minArea * 0.7, MP.minThick);
      }

      // Контуры: в тёмных областях отделяем тонкие части (штрихи, обводку, точки) от толстых.
      // Тонкая часть — то, что исчезает при морфологическом «открытии» радиусом inkR: пиксель ближе inkR
      // к границе своего цвета и дальше inkR от «ядра» (точек, где радиус ≥ inkR). Толстые части той же
      // области остаются обычными областями с номером.
      const INK = 0x40000000;
      const palL = used.map((k) => sl[k] / cnt[k]);
      if (cu >= 0) {
        progress('Контуры', 0.795);
        const inkR = Math.max(2.5, Math.max(w, h) * lerp(0.003, 0.006, cu)), inkL = lerp(0.3, 0.48, cu);
        const dl = distanceMap(labels, w, h);
        const dc = new Float32Array(n);
        let any = false;
        for (let i = 0; i < n; i++) {
          const dark = palL[labels[i]] < inkL;
          if (dark) any = true;
          dc[i] = dark && dl[i] >= inkR ? 0 : 1e9;
        }
        if (any) {
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const i = y * w + x;
              let v = dc[i];
              if (x > 0 && dc[i - 1] + 1 < v) v = dc[i - 1] + 1;
              if (y > 0) {
                if (dc[i - w] + 1 < v) v = dc[i - w] + 1;
                if (x > 0 && dc[i - w - 1] + 1.4142 < v) v = dc[i - w - 1] + 1.4142;
                if (x < w - 1 && dc[i - w + 1] + 1.4142 < v) v = dc[i - w + 1] + 1.4142;
              }
              dc[i] = v;
            }
          for (let y = h - 1; y >= 0; y--)
            for (let x = w - 1; x >= 0; x--) {
              const i = y * w + x;
              let v = dc[i];
              if (x < w - 1 && dc[i + 1] + 1 < v) v = dc[i + 1] + 1;
              if (y < h - 1) {
                if (dc[i + w] + 1 < v) v = dc[i + w] + 1;
                if (x < w - 1 && dc[i + w + 1] + 1.4142 < v) v = dc[i + w + 1] + 1.4142;
                if (x > 0 && dc[i + w - 1] + 1.4142 < v) v = dc[i + w - 1] + 1.4142;
              }
              dc[i] = v;
            }
          if (key === labels) key = Int32Array.from(labels);
          for (let i = 0; i < n; i++)
            if (palL[labels[i]] < inkL && dl[i] < inkR && dc[i] > inkR + 1.5) key[i] |= INK;
          // мелкие «уголки», срезанные у толстых областей, возвращаем обратно
          const c0 = components(key, w, h), touch = new Uint8Array(c0.count);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const i = y * w + x;
              for (const j of [x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1]) {
                if (j < 0 || c0.rid[i] === c0.rid[j] || labels[i] !== labels[j]) continue;
                if ((key[i] & INK) !== (key[j] & INK)) { touch[c0.rid[i]] = 1; touch[c0.rid[j]] = 1; }
              }
            }
          const small = 3 * inkR * inkR;
          for (let i = 0; i < n; i++)
            if (key[i] & INK && touch[c0.rid[i]] && c0.area[c0.rid[i]] < small) key[i] &= ~INK;
        }
      }

      progress('Расстановка номеров', 0.8);
      const cc = components(key, w, h);
      const inkFlag = new Uint8Array(cc.count);
      for (let r = 0; r < cc.count; r++) { inkFlag[r] = cc.regLabel[r] & INK ? 1 : 0; cc.regLabel[r] &= 255; }
      const dm = distanceMap(cc.rid, w, h);
      const bestD = new Float32Array(cc.count), bestI = new Int32Array(cc.count);
      for (let i = 0; i < n; i++) { const r = cc.rid[i]; if (dm[i] > bestD[r]) { bestD[r] = dm[i]; bestI[r] = i; } }
      // Номера. Первый — в самой «просторной» точке области. Дополнительные — в других
      // локальных максимумах карты расстояний, если до уже поставленных номеров далеко
      // или между ними узкий перешеек / граница (отдельная «доля» той же области).
      const long = Math.max(w, h);
      const minR = long * 0.0065, sFar = long * 0.2, sNear = long * 0.045, maxPer = 14;
      // тонкая тёмная часть печатается готовой заливкой, если она темнее почти всего, с чем граничит
      let regInk = null;
      if (cu >= 0) {
        const bord = new Float32Array(cc.count), bad = new Float32Array(cc.count);
        const edge = (i, j) => {
          const r = cc.rid[i], q = cc.rid[j];
          if (r === q) return;
          const la = cc.regLabel[r], lb = cc.regLabel[q];
          if (la === lb) return;
          bord[r]++; bord[q]++;
          if (palL[lb] < palL[la] + MP.inkDL) bad[r]++;
          if (palL[la] < palL[lb] + MP.inkDL) bad[q]++;
        };
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (x < w - 1) edge(i, i + 1);
            if (y < h - 1) edge(i, i + w);
          }
        regInk = new Uint8Array(cc.count);
        for (let r = 0; r < cc.count; r++)
          if (inkFlag[r] && bord[r] > 0 && bad[r] <= 0.3 * bord[r]) regInk[r] = 1;
      }
      const placed = new Array(cc.count);
      for (let r = 0; r < cc.count; r++) placed[r] = [bestI[r]];
      const candI = [];
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x, d = dm[i];
          if (d < minR) continue;
          if (d < dm[i - 1] || d < dm[i + 1] || d < dm[i - w] || d < dm[i + w] ||
              d < dm[i - w - 1] || d < dm[i - w + 1] || d < dm[i + w - 1] || d < dm[i + w + 1]) continue;
          candI.push(i);
        }
      candI.sort((p, q) => dm[q] - dm[p]);
      for (const c of candI) {
        const r = cc.rid[c], list = placed[r];
        if (list.length >= maxPer) continue;
        const cx = c % w, cy = (c / w) | 0, rc = dm[c];
        let ok = true;
        for (let k = 0; k < list.length && ok; k++) {
          const a = list[k], ax = a % w, ay = (a / w) | 0;
          const dist = Math.hypot(cx - ax, cy - ay);
          if (dist < sNear) { ok = false; break; }
          if (dist >= sFar) continue;
          // между «близко» и «далеко»: смотрим, есть ли перешеек на прямой между точками
          const steps = Math.ceil(dist), lim = 0.45 * Math.min(rc, dm[a]);
          let split = false;
          for (let t = 1; t < steps; t++) {
            const j = Math.round(cy + ((ay - cy) * t) / steps) * w + Math.round(cx + ((ax - cx) * t) / steps);
            if (cc.rid[j] !== r || dm[j] < lim) { split = true; break; }
          }
          if (!split) ok = false;
        }
        if (ok) list.push(c);
      }
      const numList = [];
      for (let r = 0; r < cc.count; r++) {
        if (regInk && regInk[r]) continue;
        for (const i of placed[r]) numList.push((i % w) + 0.5, ((i / w) | 0) + 0.5, dm[i], cc.regLabel[r]);
      }
      const nums = new Float32Array(numList);

      const vec = vectorize(cc.rid, w, h, cc.regLabel, K, 10, 0.2, stage('Векторизация контуров', 0.82, 0.99), regInk);
      progress('Готово', 1);
      return { w, h, palette, fills: vec.fills, lines: vec.lines, ink: vec.ink, nums, regions: cc.count, ms: Date.now() - t0 };
    }

    return { process };
  }

  root.CBNAlgo = { factory: algoFactory };
  if (typeof module !== 'undefined' && module.exports) module.exports = { factory: algoFactory };
})(typeof self !== 'undefined' ? self : globalThis);
