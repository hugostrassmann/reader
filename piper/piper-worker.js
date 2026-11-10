/* Rechnet die Piper-Stimme im Hintergrund, damit die Seite nie stockt. */
'use strict';
var CACHE = 'piper-voices-v1';
var KEY = 'https://piper.local/';
var DIR = new URL('.', self.location.href).href;
var GAP_SECONDS = 0.12; // Pause zwischen Sätzen innerhalb eines Stücks

var ortP = null;
function ortLoad() {
  if (ortP) return ortP;
  ortP = Promise.resolve().then(function () {
    importScripts(DIR + 'ort.wasm.min.js');
    var ort = self.ort;
    ort.env.wasm.wasmPaths = DIR;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    return ort;
  });
  ortP.catch(function () { ortP = null; });
  return ortP;
}

var phonP = null, phonInst = null, printSink = null;
function phonLoad() {
  if (phonP) return phonP;
  phonP = (async function () {
    importScripts(DIR + 'piper_phonemize.js');
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
  phonInst = await self.createPiperPhonemize({
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
function splitSentences(json) {
  var ids = json.phoneme_ids || [], ph = json.phonemes || [];
  var sentences = [], k = 0, i = 0;
  while (i < ids.length) {
    if (ids[i] !== 1) { i++; continue; }
    i++;
    var cur = [];
    while (i + 1 < ids.length) {
      var tok = ids[i + 1]; i += 2;
      if (tok === 2) break;
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
      phonInst = null;
    } catch (e) { printSink = null; phonInst = null; if (attempt) throw e; }
  }
  return [];
}

var loaded = {};
function stage(name, p) { return Promise.resolve(p).catch(function (e) { throw new Error(name + ': ' + String((e && e.message) || e)); }); }
function load(id) {
  if (loaded[id]) return loaded[id];
  loaded[id] = (async function () {
    var c = await stage('Speicher öffnen', caches.open(CACHE));
    var rj = await c.match(KEY + id + '.json'), ro = await c.match(KEY + id + '.onnx');
    if (!rj || !ro) throw new Error('Stimme ist nicht gespeichert');
    var conf = await stage('Einstellungen lesen', rj.json());
    var ort = await stage('Rechenprogramm laden', ortLoad());
    var buf = await stage('Modell lesen', ro.arrayBuffer());
    await stage('Sprachdaten laden', phonLoad());
    var session = await stage('Modell starten (' + Math.round(buf.byteLength / 1048576) + ' MB)', ort.InferenceSession.create(new Uint8Array(buf), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'}));
    return {ort: ort, session: session, conf: conf};
  })();
  loaded[id].catch(function () { delete loaded[id]; });
  return loaded[id];
}

function toIds(sentence, map) {
  var pad = map['_'] || [0], bos = map['^'] || [1], eos = map['$'] || [2], ids = [].concat(bos);
  for (var i = 0; i < sentence.length; i++) {
    var m = map[sentence[i]];
    if (!m) continue;
    ids = ids.concat(pad, m);
  }
  return ids.concat(pad, eos);
}
async function infer(m, ids) {
  var ort = m.ort, inf = m.conf.inference || {};
  var feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, function (x) { return BigInt(x); }), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([
      inf.noise_scale != null ? inf.noise_scale : 0.667,
      inf.length_scale != null ? inf.length_scale : 1,
      inf.noise_w != null ? inf.noise_w : 0.8
    ]), [3])
  };
  if (m.conf.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  var res = await m.session.run(feeds);
  return res.output.data;
}
/* Schneidet Stille am Anfang und Ende ab, damit der Satzwechsel nahtlos klingt. */
function trim(pcm, sr) {
  var peak = 0, i;
  for (i = 0; i < pcm.length; i++) { var v = Math.abs(pcm[i]); if (v > peak) peak = v; }
  var th = Math.max(0.006, peak * 0.03), a = 0, b = pcm.length - 1;
  while (a < b && Math.abs(pcm[a]) < th) a++;
  while (b > a && Math.abs(pcm[b]) < th) b--;
  a = Math.max(0, a - Math.round(sr * 0.03));
  b = Math.min(pcm.length - 1, b + Math.round(sr * 0.05));
  return pcm.subarray(a, b + 1);
}
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
async function run(id, text) {
  var m = await load(id), t0 = Date.now();
  var sentences = await phonemize(text, (m.conf.espeak && m.conf.espeak.voice) || 'de');
  if (!sentences.length) return null;
  var sr = m.conf.audio.sample_rate, parts = [], total = 0;
  var gap = new Float32Array(Math.round(sr * GAP_SECONDS));
  for (var i = 0; i < sentences.length; i++) {
    var ids = toIds(sentences[i], m.conf.phoneme_id_map || {});
    if (ids.length < 4) continue;
    var pcm = trim(await infer(m, ids), sr);
    if (parts.length) { parts.push(gap); total += gap.length; }
    parts.push(pcm); total += pcm.length;
  }
  if (!total) return null;
  var all = new Float32Array(total), o = 0;
  for (var j = 0; j < parts.length; j++) { all.set(parts[j], o); o += parts[j].length; }
  return {blob: wav(all, sr), seconds: total / sr, ms: Date.now() - t0};
}

var chain = Promise.resolve();
self.onmessage = function (e) {
  var d = e.data;
  if (d.type === 'drop') { delete loaded[d.voice]; return; }
  var work = chain.then(function () {
    if (d.type === 'warm') return load(d.voice).then(function () { return {}; });
    if (d.type === 'speak') return run(d.voice, d.text).then(function (r) { return r || {empty: true}; });
    throw new Error('Unbekannte Anfrage');
  });
  chain = work.catch(function () {});
  work.then(function (r) { self.postMessage({id: d.id, ok: true, result: r}); },
            function (err) { self.postMessage({id: d.id, ok: false, error: String((err && err.message) || err)}); });
};
