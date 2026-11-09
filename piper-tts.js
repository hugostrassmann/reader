/* Piper-Sprachausgabe im Browser (läuft komplett auf dem Gerät).
   Benötigt: ort.wasm.min.js, ort-wasm-simd.wasm, piper_phonemize.{js,wasm,data} im selben Ordner.
   Die Stimmen werden einmal geladen und danach lokal gespeichert (Cache Storage). */
(function () {
  'use strict';
  var SCRIPT = document.currentScript && document.currentScript.src;
  var DIR = new URL('.', SCRIPT || location.href).href;
  var HF = [
    'https://huggingface.co/rhasspy/piper-voices/resolve/main/',
    'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/'
  ];
  var VOICES = [
    {id: 'de_DE-thorsten-medium', path: 'de/de_DE/thorsten/medium/de_DE-thorsten-medium', label: 'Thorsten (Mann, natürlich)'},
    {id: 'de_DE-thorsten-high', path: 'de/de_DE/thorsten/high/de_DE-thorsten-high', label: 'Thorsten (Mann, höchste Qualität)'},
    {id: 'de_DE-kerstin-low', path: 'de/de_DE/kerstin/low/de_DE-kerstin-low', label: 'Kerstin (Frau)'},
    {id: 'de_DE-ramona-low', path: 'de/de_DE/ramona/low/de_DE-ramona-low', label: 'Ramona (Frau)'}
  ];
  var CACHE = 'piper-voices-v1';
  var KEY = 'https://piper.local/';
  var cfg = {hfBases: HF}; // für Tests überschreibbar

  function voiceById(id) { for (var i = 0; i < VOICES.length; i++) if (VOICES[i].id === id) return VOICES[i]; return null; }
  function supported() { return typeof WebAssembly === 'object' && typeof caches !== 'undefined' && typeof BigInt64Array !== 'undefined'; }

  var scripts = {};
  function loadScript(src) {
    if (scripts[src]) return scripts[src];
    scripts[src] = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { delete scripts[src]; rej(new Error('Datei fehlt: ' + src)); };
      document.head.appendChild(s);
    });
    return scripts[src];
  }

  /* ---------- Speicher ---------- */
  async function cacheOpen() { return caches.open(CACHE); }
  async function stored(id) {
    try {
      var c = await cacheOpen();
      var a = await c.match(KEY + id + '.onnx'), b = await c.match(KEY + id + '.json');
      return !!(a && b);
    } catch (e) { return false; }
  }
  async function remove(id) {
    try { var c = await cacheOpen(); await c.delete(KEY + id + '.onnx'); await c.delete(KEY + id + '.json'); } catch (e) {}
    delete loaded[id];
  }
  async function fetchProgress(url, onProg) {
    var r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var total = +r.headers.get('Content-Length') || 0, got = 0, parts = [];
    if (!r.body || !r.body.getReader) { var b = await r.blob(); onProg && onProg(b.size, b.size); return b; }
    var rd = r.body.getReader();
    for (;;) {
      var x = await rd.read();
      if (x.done) break;
      parts.push(x.value); got += x.value.length;
      onProg && onProg(got, total);
    }
    return new Blob(parts);
  }
  async function download(id, onProg) {
    var v = voiceById(id);
    if (!v) throw new Error('Unbekannte Stimme');
    var lastErr = null;
    for (var i = 0; i < cfg.hfBases.length; i++) {
      try {
        var base = cfg.hfBases[i] + v.path;
        var js = await fetchProgress(base + '.onnx.json');
        var onnx = await fetchProgress(base + '.onnx', onProg);
        var c = await cacheOpen();
        await c.put(KEY + id + '.json', new Response(js, {headers: {'Content-Type': 'application/json'}}));
        await c.put(KEY + id + '.onnx', new Response(onnx, {headers: {'Content-Type': 'application/octet-stream'}}));
        return true;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Download fehlgeschlagen');
  }

  /* ---------- Phonemizer (espeak-ng als WebAssembly) ---------- */
  var phonP = null, phonInst = null, printSink = null;
  async function phonLoad() {
    if (phonP) return phonP;
    phonP = (async function () {
      await loadScript(DIR + 'piper_phonemize.js');
      var rs = await Promise.all([fetch(DIR + 'piper_phonemize.wasm'), fetch(DIR + 'piper_phonemize.data')]);
      if (!rs[0].ok || !rs[1].ok) throw new Error('Sprachdaten fehlen');
      var wasm = await rs[0].arrayBuffer(), data = await rs[1].arrayBuffer();
      return {mod: await WebAssembly.compile(wasm), data: data};
    })();
    phonP.catch(function () { phonP = null; });
    return phonP;
  }
  async function phonInstance() {
    if (phonInst) return phonInst;
    var p = await phonLoad();
    phonInst = await window.createPiperPhonemize({
      print: function (l) { if (printSink) printSink.push(l); },
      printErr: function () {},
      locateFile: function (f) { return DIR + f; },
      getPreloadedPackage: function () { return p.data; },
      instantiateWasm: function (imports, ok) {
        WebAssembly.instantiate(p.mod, imports).then(function (inst) { ok(inst, p.mod); });
        return {};
      }
    });
    return phonInst;
  }
  /* Zerlegt die Ausgabe des Phonemizers in Sätze aus Lauten (Zeichen). */
  function splitSentences(json) {
    var ids = json.phoneme_ids || [], ph = json.phonemes || [];
    var sentences = [], k = 0, i = 0;
    while (i < ids.length) {
      if (ids[i] !== 1) { i++; continue; }           // Satzanfang
      i++;
      var cur = [];
      while (i + 1 < ids.length) {
        var tok = ids[i + 1]; i += 2;
        if (tok === 2) break;                          // Satzende
        if (k < ph.length) cur.push(ph[k]);
        k++;
      }
      if (cur.length) sentences.push(cur);
    }
    if (!sentences.length && ph.length) sentences.push(ph.slice());
    return sentences;
  }
  async function phonemize(text, lang) {
    var args = ['-l', lang, '--input', JSON.stringify([{text: text}]), '--espeak_data', '/espeak-ng-data'];
    for (var attempt = 0; attempt < 2; attempt++) {
      var out = [];
      try {
        var inst = await phonInstance();
        printSink = out;
        inst.callMain(args.slice());
        printSink = null;
        var sentences = [];
        for (var i = 0; i < out.length; i++) {
          try { var j = JSON.parse(out[i]); if (j) sentences = sentences.concat(splitSentences(j)); } catch (e) {}
        }
        if (sentences.length) return sentences;
        phonInst = null; // leeres Ergebnis: Instanz neu aufbauen und einmal wiederholen
      } catch (e) { printSink = null; phonInst = null; if (attempt) throw e; }
    }
    return [];
  }

  /* ---------- Modell (ONNX Runtime) ---------- */
  var loaded = {};
  async function ortLoad() {
    await loadScript(DIR + 'ort.wasm.min.js');
    var ort = window.ort;
    ort.env.wasm.wasmPaths = DIR;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    return ort;
  }
  function load(id, onStatus) {
    if (loaded[id]) return loaded[id];
    loaded[id] = (async function () {
      var c = await cacheOpen();
      var rj = await c.match(KEY + id + '.json'), ro = await c.match(KEY + id + '.onnx');
      if (!rj || !ro) throw new Error('Stimme ist nicht geladen');
      onStatus && onStatus('Stimme wird vorbereitet …');
      var conf = await rj.json();
      var results = await Promise.all([ortLoad(), ro.arrayBuffer(), phonLoad()]);
      var ort = results[0];
      var session = await ort.InferenceSession.create(new Uint8Array(results[1]), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
      return {ort: ort, session: session, conf: conf};
    })();
    loaded[id].catch(function () { delete loaded[id]; });
    return loaded[id];
  }

  /* ---------- Sprechen ---------- */
  var chain = Promise.resolve();
  function wav(pcm, sr) {
    var n = pcm.length, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
    function s(o, t) { for (var i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); }
    s(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); s(8, 'WAVE'); s(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    s(36, 'data'); dv.setUint32(40, n * 2, true);
    var fade = Math.min(Math.floor(sr * 0.004), n >> 1);
    for (var i = 0; i < n; i++) {
      var v = pcm[i];
      if (i < fade) v *= i / fade; else if (i >= n - fade) v *= (n - 1 - i) / fade;
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    return new Blob([buf], {type: 'audio/wav'});
  }
  function toIds(sentence, map) {
    var pad = map['_'] || [0], bos = map['^'] || [1], eos = map['$'] || [2], ids = [].concat(bos);
    for (var i = 0; i < sentence.length; i++) {
      var m = map[sentence[i]];
      if (!m) continue;                                // Laut kennt diese Stimme nicht
      ids = ids.concat(pad, m);
    }
    return ids.concat(pad, eos);
  }
  async function infer(m, ids, rate) {
    var ort = m.ort, inf = m.conf.inference || {};
    var feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, function (x) { return BigInt(x); }), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([
        inf.noise_scale != null ? inf.noise_scale : 0.667,
        (inf.length_scale != null ? inf.length_scale : 1) / (rate || 1),
        inf.noise_w != null ? inf.noise_w : 0.8
      ]), [3])
    };
    if (m.conf.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
    var res = await m.session.run(feeds);
    return res.output.data;
  }
  async function run(id, text, rate) {
    var m = await load(id);
    var sentences = await phonemize(text, (m.conf.espeak && m.conf.espeak.voice) || 'de');
    if (!sentences.length) return null;
    var sr = m.conf.audio.sample_rate, parts = [], total = 0;
    var gap = new Float32Array(Math.round(sr * 0.22 / (rate || 1)));
    for (var i = 0; i < sentences.length; i++) {
      var ids = toIds(sentences[i], m.conf.phoneme_id_map || {});
      if (ids.length < 4) continue;
      if (parts.length) { parts.push(gap); total += gap.length; }
      var pcm = await infer(m, ids, rate);
      parts.push(pcm); total += pcm.length;
    }
    if (!total) return null;
    var all = new Float32Array(total), o = 0;
    for (var j = 0; j < parts.length; j++) { all.set(parts[j], o); o += parts[j].length; }
    return {blob: wav(all, sr), seconds: total / sr};
  }
  /* Gibt {url, seconds} zurück. Aufrufe laufen nacheinander, nie gleichzeitig. */
  function speak(id, text, rate) {
    var p = chain.then(function () { return run(id, text, rate); });
    chain = p.catch(function () {});
    return p.then(function (r) { return r ? {url: URL.createObjectURL(r.blob), seconds: r.seconds} : null; });
  }
  function warm(id, onStatus) { return load(id, onStatus); }

  window.PiperTTS = {
    voices: VOICES, supported: supported, stored: stored, download: download, remove: remove,
    warm: warm, speak: speak, config: cfg
  };
})();
