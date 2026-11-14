(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), empty = $('empty'), fileInput = $('file');
  const state = { img: null, imgUrl: null, result: null, mode: 'outline', hl: -1, job: 0, worker: null, view: null, timer: 0 };

  // ---------- воркер из исходника фабрики (работает и с file://) ----------
  const workerUrl = URL.createObjectURL(new Blob([
    'const __algo=(' + CBNAlgo.factory.toString() + ')();' +
    'self.onmessage=function(e){const m=e.data;try{' +
    'const res=__algo.process(m.rgba,m.w,m.h,m.opts,function(s,p){self.postMessage({type:"progress",id:m.id,stage:s,p:p});});' +
    'self.postMessage({type:"done",id:m.id,res:res});' +
    '}catch(err){self.postMessage({type:"error",id:m.id,message:String(err&&err.stack||err)});}};',
  ], { type: 'text/javascript' }));

  function setProgress(text, p) {
    $('progress').classList.toggle('on', text !== null);
    if (text !== null) { $('progText').textContent = text; $('progBar').style.width = Math.round(p * 100) + '%'; }
  }

  // ---------- загрузка ----------
  // HEIC/HEIF: Safari открывает сам, остальным браузерам подгружаем декодер по требованию
  const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic-to@1.6.6/dist/iife/heic-to.js';
  let heicLib = null;
  const isImageFile = (f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name || '');
  async function looksLikeHeic(blob) {
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const tag = String.fromCharCode(...b.subarray(4, 12));
    return /^ftyp(heic|heix|heim|heis|hevc|hevx|hevm|hevs|mif1|msf1)/.test(tag);
  }
  function loadHeicLib() {
    if (!heicLib) heicLib = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = HEIC_LIB;
      sc.onload = () => (window.HeicTo ? res(window.HeicTo) : rej(new Error('no HeicTo')));
      sc.onerror = () => { heicLib = null; rej(new Error('network')); };
      document.head.appendChild(sc);
    });
    return heicLib;
  }
  async function decode(blob) {
    try { return { img: await createImageBitmap(blob), blob }; } catch (e) { /* не умеет сам */ }
    if (!(await looksLikeHeic(blob))) throw new Error('format');
    setProgress('Декодирование HEIC', 0.05);
    let HeicTo;
    try { HeicTo = await loadHeicLib(); } catch (e) { throw new Error('heic-lib'); }
    const jpg = await HeicTo({ blob, type: 'image/jpeg', quality: 0.95 });
    return { img: await createImageBitmap(jpg), blob: jpg };
  }
  async function loadBlob(blob) {
    try {
      const d = await decode(blob);
      if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
      state.img = d.img;
      state.imgUrl = URL.createObjectURL(d.blob);
      state.view = null; state.hl = -1;
      empty.style.display = 'none';
      run();
    } catch (e) {
      setProgress(null);
      alert(e.message === 'heic-lib'
        ? 'Не удалось загрузить декодер HEIC — проверьте подключение к интернету.'
        : 'Не удалось открыть изображение. Поддерживаются JPG, PNG, WebP, HEIC.');
    }
  }
  $('pick').onclick = empty.onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) loadBlob(fileInput.files[0]); fileInput.value = ''; };
  addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
  addEventListener('dragleave', () => document.body.classList.remove('drag'));
  addEventListener('drop', (e) => {
    e.preventDefault(); document.body.classList.remove('drag');
    const f = [...e.dataTransfer.files].find(isImageFile);
    if (f) loadBlob(f);
  });
  addEventListener('paste', (e) => {
    const it = [...(e.clipboardData ? e.clipboardData.items : [])].find((x) => x.type.startsWith('image/'));
    if (it) loadBlob(it.getAsFile());
  });

  // уменьшение по шагам — без алиасинга на больших фото
  function rasterize(img, crop, tw, th) {
    let src = img, r = crop;
    while (r.w / 2 > tw * 1.2) {
      const c = document.createElement('canvas');
      c.width = Math.round(r.w / 2); c.height = Math.round(r.h / 2);
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      src = c; r = { x: 0, y: 0, w: c.width, h: c.height };
    }
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, tw, th);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, tw, th);
    return g.getImageData(0, 0, tw, th);
  }

  // ---------- лист ----------
  const PAPER = { A5: [148, 210], A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4] };
  // раскладка в миллиметрах: поля, место под картинку и под палитру из K цветов
  function pageLayout(K) {
    let [pw, ph] = PAPER[$('paper').value];
    const o = $('orient').value;
    if (o === 'land' || (o === 'auto' && state.img && state.img.width > state.img.height)) [pw, ph] = [ph, pw];
    const m = 8, cw = pw - 2 * m, sw = 11, sh = 7, gap = 2;
    let rows = 0, cols = 0, legH = 0;
    if ($('legend').checked && K > 0) {
      const maxCols = Math.max(1, Math.floor((cw + gap) / (sw + gap)));
      rows = Math.ceil(K / maxCols); cols = Math.ceil(K / rows);
      legH = rows * (sh + gap) - gap + 4;
    }
    return { pw, ph, m, cw, ch: ph - 2 * m - legH, legH, rows, cols, sw, sh, gap };
  }
  function cropRect() {
    const iw = state.img.width, ih = state.img.height;
    if (!$('crop').checked) return { x: 0, y: 0, w: iw, h: ih };
    const L = pageLayout(+$('colors').value), a = L.cw / L.ch;
    if (iw / ih > a) { const w = Math.round(ih * a); return { x: Math.round((iw - w) / 2), y: 0, w, h: ih }; }
    const h = Math.round(iw / a);
    return { x: 0, y: Math.round((ih - h) / 2), w: iw, h };
  }

  function run() {
    if (!state.img) return;
    const detail = +$('detail').value, colors = +$('colors').value, noise = +$('noise').value;
    const crop = cropRect();
    const long = Math.round(Math.min(720 + (detail - 1) / 9 * 680, Math.max(crop.w, crop.h, 320) * 1.5));
    const sc = long / Math.max(crop.w, crop.h);
    const w = Math.max(8, Math.round(crop.w * sc)), h = Math.max(8, Math.round(crop.h * sc));
    const data = rasterize(state.img, crop, w, h);
    if (state.worker) state.worker.terminate();
    const worker = (state.worker = new Worker(workerUrl));
    const id = ++state.job;
    setProgress('Подготовка', 0);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== state.job) return;
      if (m.type === 'progress') setProgress(m.stage, m.p);
      else if (m.type === 'done') {
        setProgress(null);
        const sameSize = state.result && state.result.w === m.res.w && state.result.h === m.res.h;
        if (!sameSize) state.view = null;
        state.result = m.res; state.crop = crop; render();
      }
      else { setProgress(null); console.error(m.message); alert('Ошибка обработки: ' + m.message.split('\n')[0]); }
    };
    worker.postMessage({ id, rgba: data.data, w, h, opts: { colors, detail, noise } }, [data.data.buffer]);
  }

  // ---------- SVG ----------
  const lineWidth = (res) => +$('lineW').value * Math.max(res.w, res.h) / 1000;
  // насыщенность контура: 100 — почти чёрный, 5 — едва заметный серый; номера всегда бледнее линий
  const gray = (v) => { const h = Math.round(v).toString(16).padStart(2, '0'); return '#' + h + h + h; };
  const lineLevel = () => 255 - (+$('lineC').value / 100) * 225;
  const lineColor = () => gray(lineLevel());
  const numColor = () => gray(Math.min(lineLevel() + (255 - lineLevel()) * 0.2, 248));
  const textOn = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] > 140 ? '#000' : '#fff');

  function numsMarkup(res) {
    const long = Math.max(res.w, res.h), minF = long * 0.0058, maxF = long * 0.017;
    const out = [];
    for (let i = 0; i < res.nums.length; i += 4) {
      const n = res.nums[i + 3] + 1;
      const fs = Math.min(maxF, Math.max(minF, res.nums[i + 2] * (n > 9 ? 0.95 : 1.25)));
      out.push('<text x="' + res.nums[i].toFixed(1) + '" y="' + res.nums[i + 1].toFixed(1) + '" font-size="' + fs.toFixed(1) + '" dy=".35em">' + n + '</text>');
    }
    return out.join('');
  }
  function bodyMarkup(res, mode, forExport) {
    const lw = lineWidth(res);
    let s = '<rect x="0" y="0" width="' + res.w + '" height="' + res.h + '" fill="#fff"/>';
    if (!forExport) {
      const c = state.crop;
      s += '<svg class="orig" x="0" y="0" width="' + res.w + '" height="' + res.h + '" viewBox="' + c.x + ' ' + c.y + ' ' + c.w + ' ' + c.h + '" preserveAspectRatio="none">' +
        '<image href="' + state.imgUrl + '" x="0" y="0" width="' + state.img.width + '" height="' + state.img.height + '"/></svg>';
    }
    if (!forExport || mode === 'color') {
      s += '<g class="fills" fill-rule="evenodd" stroke-width="' + (lw * 0.6 + 0.4).toFixed(2) + '" stroke-linejoin="round">';
      res.palette.forEach((c, k) => { s += '<path data-k="' + k + '" fill="' + c.hex + '" stroke="' + c.hex + '" d="' + res.fills[k] + '"/>'; });
      s += '</g>';
    }
    if (!forExport || mode !== 'color') {
      s += '<path class="lines" fill="none" stroke="' + lineColor() + '" stroke-width="' + lw.toFixed(2) + '" stroke-linejoin="round" stroke-linecap="round" d="' + res.lines + '"/>';
      if (!forExport || $('showNums').checked)
        s += '<g class="nums" font-family="Helvetica, Arial, sans-serif" fill="' + numColor() + '" text-anchor="middle">' + numsMarkup(res) + '</g>';
    }
    return s;
  }

  function render() {
    const res = state.result;
    const pad = Math.max(res.w, res.h) * 0.02;
    if (!state.view) state.view = { x: -pad, y: -pad, w: res.w + 2 * pad, h: res.h + 2 * pad };
    stage.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg">' + bodyMarkup(res, state.mode, false) + '</svg>';
    applyView(); applyMode();
    const pal = $('palette');
    pal.innerHTML = '';
    res.palette.forEach((c, k) => {
      const b = document.createElement('button');
      b.textContent = k + 1; b.style.background = c.hex; b.style.color = textOn(c.rgb);
      b.title = c.hex + ' · ' + (c.share * 100).toFixed(1) + '% площади';
      b.onclick = () => { state.hl = state.hl === k ? -1 : k; applyMode(); };
      pal.appendChild(b);
    });
    $('stats').textContent = 'Областей: ' + res.regions + ' · цветов: ' + res.palette.length + ' · ' + (res.ms / 1000).toFixed(1) + ' с';
    for (const id of ['dlSvg', 'dlPng', 'print']) $(id).disabled = false;
    $('hint').hidden = false;
  }
  function applyView() {
    const svg = stage.firstElementChild, v = state.view;
    if (svg) svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
  }
  function applyMode() {
    const svg = stage.firstElementChild;
    if (!svg) return;
    svg.setAttribute('class', 'm-' + state.mode + ($('showNums').checked ? '' : ' nonums'));
    svg.querySelectorAll('.fills path').forEach((p) => p.classList.toggle('hl', +p.dataset.k === state.hl));
    [...$('palette').children].forEach((b, k) => b.classList.toggle('on', k === state.hl));
    [...$('mode').children].forEach((b) => b.classList.toggle('on', b.dataset.m === state.mode));
  }

  // ---------- управление ----------
  const showVal = (id) => { $(id + 'Out').textContent = id === 'noise' && $(id).value === '0' ? 'выкл' : $(id).value; };
  for (const id of ['colors', 'detail', 'noise']) {
    $(id).oninput = () => { showVal(id); clearTimeout(state.timer); state.timer = setTimeout(run, 350); };
  }
  $('lineW').oninput = () => {
    $('lineWOut').textContent = (+$('lineW').value).toFixed(1);
    const svg = stage.firstElementChild;
    if (!svg || !state.result) return;
    const lw = lineWidth(state.result);
    svg.querySelector('.lines').setAttribute('stroke-width', lw.toFixed(2));
    svg.querySelector('.fills').setAttribute('stroke-width', (lw * 0.6 + 0.4).toFixed(2));
  };
  $('lineC').oninput = () => {
    $('lineCOut').textContent = $('lineC').value + '%';
    const svg = stage.firstElementChild;
    if (!svg || !state.result) return;
    svg.querySelector('.lines').setAttribute('stroke', lineColor());
    svg.querySelector('.nums').setAttribute('fill', numColor());
  };
  $('mode').onclick = (e) => { if (e.target.dataset.m) { state.mode = e.target.dataset.m; applyMode(); } };
  $('showNums').onchange = applyMode;

  // масштаб и сдвиг через viewBox — картинка остаётся векторно-чёткой
  function svgPoint(e) {
    const r = stage.getBoundingClientRect(), v = state.view;
    const s = Math.max(v.w / r.width, v.h / r.height);
    return { s, x: v.x + v.w / 2 + (e.clientX - r.left - r.width / 2) * s, y: v.y + v.h / 2 + (e.clientY - r.top - r.height / 2) * s };
  }
  stage.addEventListener('wheel', (e) => {
    if (!state.result) return;
    e.preventDefault();
    const p = svgPoint(e), v = state.view, long = Math.max(state.result.w, state.result.h);
    let f = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    f = Math.min(Math.max(f, (long / 40) / v.w), (long * 1.6) / v.w);
    v.x = p.x - (p.x - v.x) * f; v.y = p.y - (p.y - v.y) * f; v.w *= f; v.h *= f;
    applyView();
  }, { passive: false });
  let dragPt = null;
  stage.addEventListener('pointerdown', (e) => { if (state.result) { dragPt = { x: e.clientX, y: e.clientY }; stage.setPointerCapture(e.pointerId); } });
  stage.addEventListener('pointermove', (e) => {
    if (!dragPt) return;
    const s = svgPoint(e).s;
    state.view.x -= (e.clientX - dragPt.x) * s; state.view.y -= (e.clientY - dragPt.y) * s;
    dragPt = { x: e.clientX, y: e.clientY };
    applyView();
  });
  stage.addEventListener('pointerup', () => (dragPt = null));
  stage.addEventListener('dblclick', () => { if (state.result) { state.view = null; const res = state.result, pad = Math.max(res.w, res.h) * 0.02; state.view = { x: -pad, y: -pad, w: res.w + 2 * pad, h: res.h + 2 * pad }; applyView(); } });

  // ---------- экспорт ----------
  const f2 = (v) => (Math.round(v * 100) / 100).toString();
  // страница выбранного формата: картинка вписана в поля, палитра (если включена) под ней
  function exportSvg() {
    const res = state.result, mode = state.mode === 'color' ? 'color' : 'outline';
    const K = res.palette.length, L = pageLayout(K);
    const sc = Math.min(L.cw / res.w, L.ch / res.h), iw = res.w * sc, ih = res.h * sc;
    const ix = L.m + (L.cw - iw) / 2, iy = L.m + (L.ch - ih) / 2;
    const pad = lineWidth(res) / 2 + 0.5;
    let leg = '';
    if (L.legH) {
      leg = '<g font-family="Helvetica, Arial, sans-serif" font-weight="bold" text-anchor="middle" font-size="3.6">';
      res.palette.forEach((c, k) => {
        const row = Math.floor(k / L.cols), inRow = Math.min(L.cols, K - row * L.cols);
        const x = L.m + (L.cw - (inRow * (L.sw + L.gap) - L.gap)) / 2 + (k % L.cols) * (L.sw + L.gap);
        const y = iy + ih + 4 + row * (L.sh + L.gap);
        leg += '<rect x="' + f2(x) + '" y="' + f2(y) + '" width="' + L.sw + '" height="' + L.sh + '" rx="1.2" fill="' + c.hex + '" stroke="#4a4a4a" stroke-width="0.2"/>' +
          '<text x="' + f2(x + L.sw / 2) + '" y="' + f2(y + L.sh / 2) + '" dy=".35em" fill="' + textOn(c.rgb) + '">' + (k + 1) + '</text>';
      });
      leg += '</g>';
    }
    return { W: L.pw, H: L.ph, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + L.pw + 'mm" height="' + L.ph + 'mm" viewBox="0 0 ' + L.pw + ' ' + L.ph + '">' +
      '<rect x="0" y="0" width="' + L.pw + '" height="' + L.ph + '" fill="#fff"/>' +
      '<svg x="' + f2(ix) + '" y="' + f2(iy) + '" width="' + f2(iw) + '" height="' + f2(ih) + '" viewBox="' + f2(-pad) + ' ' + f2(-pad) + ' ' + f2(res.w + 2 * pad) + ' ' + f2(res.h + 2 * pad) + '">' +
      bodyMarkup(res, mode, true) + '</svg>' + leg + '</svg>' };
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $('dlSvg').onclick = () => download(new Blob([exportSvg().svg], { type: 'image/svg+xml' }), 'raskraska.svg');
  $('dlPng').onclick = () => {
    const ex = exportSvg(), url = URL.createObjectURL(new Blob([ex.svg], { type: 'image/svg+xml' }));
    const img = new Image();
    img.onload = () => {
      const k = Math.min(300 / 25.4, 5000 / Math.max(ex.W, ex.H)), c = document.createElement('canvas');
      c.width = Math.round(ex.W * k); c.height = Math.round(ex.H * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => download(b, 'raskraska.png'), 'image/png');
    };
    img.src = url;
  };
  $('print').onclick = () => {
    const ex = exportSvg();
    // страница без полей браузера: поля уже заложены в раскладку; -1 мм, чтобы не появлялся пустой второй лист
    $('print-root').innerHTML = '<style>@page{size:' + ex.W + 'mm ' + ex.H + 'mm;margin:0}' +
      '@media print{#print-root>svg{max-width:' + ex.W + 'mm;max-height:' + (ex.H - 1) + 'mm}}</style>' + ex.svg;
    setTimeout(() => window.print(), 50);
  };
  for (const id of ['paper', 'orient', 'crop', 'legend']) {
    $(id).onchange = () => {
      $('orient').disabled = false;
      if ($('crop').checked || id === 'crop') run();
    };
  }

  // для отладки: ?src=путь&colors=..&detail=..
  const q = new URLSearchParams(location.search);
  for (const id of ['colors', 'detail', 'noise', 'lineW']) if (q.get(id)) { $(id).value = q.get(id); showVal(id); }
  if (q.get('lineC')) { $('lineC').value = q.get('lineC'); $('lineCOut').textContent = $('lineC').value + '%'; }
  for (const id of ['paper', 'orient']) if (q.get(id)) $(id).value = q.get(id);
  for (const id of ['crop', 'legend']) if (q.get(id)) $(id).checked = q.get(id) === '1';
  if (q.get('mode')) state.mode = q.get('mode');
  if (q.get('src')) fetch(q.get('src')).then((r) => r.blob()).then(loadBlob);
  window.__cbn = state;
})();
