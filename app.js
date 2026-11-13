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
  function rasterize(img, tw, th) {
    let src = img, sw = img.width, sh = img.height;
    while (sw / 2 > tw * 1.2) {
      const c = document.createElement('canvas');
      c.width = sw = Math.round(sw / 2); c.height = sh = Math.round(sh / 2);
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      g.drawImage(src, 0, 0, sw, sh); src = c;
    }
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.fillRect(0, 0, tw, th);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, tw, th);
    return g.getImageData(0, 0, tw, th);
  }

  function run() {
    if (!state.img) return;
    const detail = +$('detail').value, colors = +$('colors').value;
    const long = Math.round(Math.min(720 + (detail - 1) / 9 * 680, Math.max(state.img.width, state.img.height, 320) * 1.5));
    const sc = long / Math.max(state.img.width, state.img.height);
    const w = Math.max(8, Math.round(state.img.width * sc)), h = Math.max(8, Math.round(state.img.height * sc));
    const data = rasterize(state.img, w, h);
    if (state.worker) state.worker.terminate();
    const worker = (state.worker = new Worker(workerUrl));
    const id = ++state.job;
    setProgress('Подготовка', 0);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== state.job) return;
      if (m.type === 'progress') setProgress(m.stage, m.p);
      else if (m.type === 'done') { setProgress(null); state.result = m.res; render(); }
      else { setProgress(null); console.error(m.message); alert('Ошибка обработки: ' + m.message.split('\n')[0]); }
    };
    worker.postMessage({ id, rgba: data.data, w, h, opts: { colors, detail } }, [data.data.buffer]);
  }

  // ---------- SVG ----------
  const lineWidth = (res) => +$('lineW').value * Math.max(res.w, res.h) / 1000;
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
    if (!forExport) s += '<image class="orig" href="' + state.imgUrl + '" x="0" y="0" width="' + res.w + '" height="' + res.h + '" preserveAspectRatio="none"/>';
    if (!forExport || mode === 'color') {
      s += '<g class="fills" fill-rule="evenodd" stroke-width="' + (lw * 0.6 + 0.4).toFixed(2) + '" stroke-linejoin="round">';
      res.palette.forEach((c, k) => { s += '<path data-k="' + k + '" fill="' + c.hex + '" stroke="' + c.hex + '" d="' + res.fills[k] + '"/>'; });
      s += '</g>';
    }
    if (!forExport || mode !== 'color') {
      s += '<path class="lines" fill="none" stroke="#4a4a4a" stroke-width="' + lw.toFixed(2) + '" stroke-linejoin="round" stroke-linecap="round" d="' + res.lines + '"/>';
      if (!forExport || $('showNums').checked)
        s += '<g class="nums" font-family="Helvetica, Arial, sans-serif" fill="#6b6b6b" text-anchor="middle">' + numsMarkup(res) + '</g>';
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
  for (const id of ['colors', 'detail']) {
    $(id).oninput = () => { $(id + 'Out').textContent = $(id).value; clearTimeout(state.timer); state.timer = setTimeout(run, 350); };
  }
  $('lineW').oninput = () => {
    $('lineWOut').textContent = (+$('lineW').value).toFixed(1);
    const svg = stage.firstElementChild;
    if (!svg || !state.result) return;
    const lw = lineWidth(state.result);
    svg.querySelector('.lines').setAttribute('stroke-width', lw.toFixed(2));
    svg.querySelector('.fills').setAttribute('stroke-width', (lw * 0.6 + 0.4).toFixed(2));
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
  function exportSvg() {
    const res = state.result, mode = state.mode === 'color' ? 'color' : 'outline';
    const u = res.w / 100, pad = 2 * u;
    const K = res.palette.length, cols = Math.min(K, 12), cell = res.w / cols, sw = Math.min(cell * 0.8, 6.5 * u), rowH = sw * 0.62 + 1.2 * u;
    const rows = Math.ceil(K / cols), legH = rows * rowH + 2 * u;
    const W = res.w + 2 * pad, H = res.h + legH + 2 * pad;
    let leg = '<g font-family="Helvetica, Arial, sans-serif" font-weight="bold" text-anchor="middle" font-size="' + (sw * 0.3).toFixed(1) + '">';
    res.palette.forEach((c, k) => {
      const x = (k % cols) * cell + (cell - sw) / 2, y = res.h + 2 * u + Math.floor(k / cols) * rowH, hgt = sw * 0.62;
      leg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + sw.toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="' + (u * 0.6).toFixed(1) + '" fill="' + c.hex + '" stroke="#4a4a4a" stroke-width="' + (u * 0.1).toFixed(2) + '"/>' +
        '<text x="' + (x + sw / 2).toFixed(1) + '" y="' + (y + hgt / 2).toFixed(1) + '" dy=".35em" fill="' + textOn(c.rgb) + '">' + (k + 1) + '</text>';
    });
    leg += '</g>';
    return { W, H, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + W.toFixed(0) + '" height="' + H.toFixed(0) + '" viewBox="' + (-pad) + ' ' + (-pad) + ' ' + W + ' ' + H + '">' +
      '<rect x="' + (-pad) + '" y="' + (-pad) + '" width="' + W + '" height="' + H + '" fill="#fff"/>' + bodyMarkup(res, mode, true) + leg + '</svg>' };
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
      const k = 3508 / Math.max(ex.W, ex.H), c = document.createElement('canvas');
      c.width = Math.round(ex.W * k); c.height = Math.round(ex.H * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => download(b, 'raskraska.png'), 'image/png');
    };
    img.src = url;
  };
  $('print').onclick = () => {
    const ex = exportSvg();
    $('print-root').innerHTML = '<style>@page{size:A4 ' + (ex.W > ex.H ? 'landscape' : 'portrait') + ';margin:8mm}</style>' +
      ex.svg.replace(/ width="\d+" height="\d+"/, '');
    setTimeout(() => window.print(), 50);
  };

  // для отладки: ?src=путь&colors=..&detail=..
  const q = new URLSearchParams(location.search);
  for (const id of ['colors', 'detail', 'lineW']) if (q.get(id)) { $(id).value = q.get(id); $(id + 'Out').textContent = $(id).value; }
  if (q.get('mode')) state.mode = q.get('mode');
  if (q.get('src')) fetch(q.get('src')).then((r) => r.blob()).then(loadBlob);
  window.__cbn = state;
})();
