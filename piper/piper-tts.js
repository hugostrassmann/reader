/* Piper-Sprachausgabe im Browser (läuft komplett auf dem Gerät).
   Die Berechnung passiert in piper-worker.js im Hintergrund, damit die Seite nie stockt.
   Benötigt im selben Ordner: piper-worker.js, ort.wasm.min.js, ort-wasm-simd.wasm, piper_phonemize.{js,wasm,data}.
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
  function supported() { return typeof WebAssembly === 'object' && typeof Worker !== 'undefined' && typeof caches !== 'undefined' && typeof BigInt64Array !== 'undefined'; }

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
    if (worker) worker.postMessage({type: 'drop', voice: id});
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

  /* ---------- Worker ---------- */
  var worker = null, nextId = 1, pending = {};
  function failAll(err) {
    var p = pending; pending = {};
    for (var k in p) p[k].reject(err);
  }
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(DIR + 'piper-worker.js');
    worker.onmessage = function (e) {
      var d = e.data, p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error));
    };
    worker.onerror = function (e) {
      var err = new Error('Worker-Fehler: ' + ((e && e.message) || 'unbekannt'));
      try { worker.terminate(); } catch (x) {}
      worker = null;
      failAll(err);
    };
    return worker;
  }
  function call(msg) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = {resolve: resolve, reject: reject};
      msg.id = id;
      try { getWorker().postMessage(msg); } catch (e) { delete pending[id]; reject(e); }
    });
  }
  function warm(id) { return call({type: 'warm', voice: id}); }
  /* Gibt {url, seconds} zurück (oder {empty:true}). Aufrufe laufen im Worker nacheinander. */
  function speak(id, text) {
    return call({type: 'speak', voice: id, text: text}).then(function (r) {
      if (r && r.blob) return {url: URL.createObjectURL(r.blob), seconds: r.seconds, ms: r.ms};
      return null;
    });
  }

  window.PiperTTS = {
    voices: VOICES, supported: supported, stored: stored, download: download, remove: remove,
    warm: warm, speak: speak, config: cfg
  };
})();
