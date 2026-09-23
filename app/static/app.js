// deejai DAW — Web Audio engine + agentic chat.
// The browser is the mixer (volume/pan/mute/solo/nudge live here and are what
// export renders); the backend does the heavy DSP (balance, beat, backing) and
// serves stems.

const ROLE_COLOR = {
  lead: "#ffb27a", harmony: "#7ea7ff", beat: "#ff6b8a",
  pad: "#a98bff", bass: "#5fd0a8", arp: "#ffd166", inst: "#6fe0d0",
};
let instCount = 0;
const COLOR_PALETTE = ["#6fe0d0", "#ff8a5c", "#5cc8ff", "#a98bff", "#5fd0a8", "#ffd166", "#ff6b8a", "#7ea7ff"];
const trackColor = (t) => t.color || ROLE_COLOR[t.meta.role] || "#8b93a3";

// a default set of channel-strip params shared by every track
function defaultChannel() {
  return {
    volume: 1, pan: 0, muted: false, solo: false, nudgeMs: 0,
    eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, reverbSend: 0,
    trimStart: 0, trimEnd: null, fadeIn: 0, fadeOut: 0,
    compAmt: 0, driveAmt: 0, crush: 0, delayTime: 0.25, delayFb: 0.3, delayMix: 0,
    modRate: 3, modDepth: 0, modFb: 0.15,
    automation: { volume: [], pan: [], send: [] }, autoParam: null,
    buffer: null, gain: null, panner: null, send: null, eqLow: null, eqMid: null, eqHigh: null,
    comp: null, shaper: null, crushNode: null, dNode: null, dFb: null, dWet: null,
    mNode: null, mLfo: null, mLfoGain: null, mFb: null, mWet: null,
  };
}

function makeInstrumentTrack(instName, name, notes) {
  instCount++;
  return Object.assign(defaultChannel(), {
    kind: "instrument", instrument: instName || "synth", notes: notes || [], transpose: 0, arp: { on: false, rate: 0.5, mode: "up" },
    meta: { name: name || (instName || "synth") + " " + instCount, role: "inst", kind: "instrument", file: "inst:" + Date.now() + ":" + instCount },
  });
}

function addInstrument(instName) {
  const t = makeInstrumentTrack(instName);
  const pre = snapshot();
  tracks.push(t);
  if (ctx) wireTrack(t);
  renderTrackHeads(); recomputeDuration(); layout(); selectTrack(t);
  pushUndo(pre);
  openPiano(t);
}

// ---- bounce / flatten: render an instrument to a real audio track ----------
const clientBuffers = {};   // meta.file -> AudioBuffer for bounced (client-origin) audio tracks
function makeAudioTrack(name, buffer, color, file) {
  instCount++;
  const f = file || "bounce:" + Date.now() + ":" + instCount;
  clientBuffers[f] = buffer;
  return Object.assign(defaultChannel(), {
    kind: "audio", clientAudio: true, buffer,
    takes: [{ name, buffer }], selRegion: 0, color: color || "#c0a0ff",
    regions: [{ start: 0, offset: 0, length: buffer.duration, fadeIn: 0, fadeOut: 0, take: 0, gain: 1 }],
    meta: { name, role: "bounce", kind: "audio", file: f },
  });
}
async function bounceInstrument(t) {
  if (t.kind !== "instrument" || !t.notes.length) { log("dj", "add some notes to the instrument first, then bounce."); return; }
  const sr = ctx.sampleRate, dur = noteEnd(t) + 0.6;
  status("bouncing…", true); await new Promise((r) => setTimeout(r, 20));
  const oac = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const conv = oac.createConvolver(); conv.buffer = makeImpulse(oac);
  const ret = oac.createGain(); ret.gain.value = 0.9; conv.connect(ret).connect(oac.destination);
  const c = buildChain(oac, t, oac.destination, conv);   // same channel strip + fx as you hear it
  scheduleNotes(oac, t, c.eqLow, 0, 0);
  const buf = await oac.startRendering();
  const pre = snapshot();
  const nt = makeAudioTrack(t.meta.name + " (audio)", buf, t.color);
  tracks.push(nt); if (ctx) wireTrack(nt);
  renderTrackHeads(); recomputeDuration(); layout(); selectTrack(nt); pushUndo(pre);
  status("");
  log("dj", `bounced “${t.meta.name}” to an audio track — the synth part is now audio you can trim, fade, comp, and re-pitch.`);
}
function removeAudioTrack(t) {
  const pre = snapshot();
  tracks = tracks.filter((x) => x !== t);
  if (selectedFile === t.meta.file) selectedFile = tracks[0] && tracks[0].meta.file;
  renderTrackHeads(); recomputeDuration(); layout();
  const sel = selectedTrack(); if (sel) selectTrack(sel);
  pushUndo(pre);   // clientBuffers keeps the audio so undo can restore it
  log("dj", `removed “${t.meta.name}”.`);
}

let ctx = null, master = null;
let session = null;
let tracks = [];                 // { meta, buffer, gain, panner, volume, pan, muted, solo, nudgeMs, canvas }
let sources = [];
let playing = false, startedAt = 0, playFrom = 0, duration = 0, raf = 0, looping = false;
let recLatencyMs = 90;                 // output+buffer latency nudge for recorded takes (ms; user-adjustable)
let loopState = null, loopPump = 0;    // seamless lookahead loop scheduler: { winStart, winEnd, len, nextT }
const LOOP_LOOKAHEAD = 0.35;           // seconds of loop cycles to pre-schedule ahead of the audio clock
let drag = null;   // { t, startX, startNudge } while dragging a region
let selectedFile = null;   // which track the Smart Controls strip is editing
let pxPerSec = 40, userZoomed = false, snapOn = true, tempo = null;   // timeline zoom / grid
let metroOn = false, countInOn = true, beatsPerBar = 4, beatUnit = 4;   // metronome / count-in / time signature (numerator / denominator)
let tempoMap = [], tempoLaneOn = false, tdrag = null, gridTimes = null;   // tempo automation (empty = constant `tempo`)
let monitorOn = false, monStream = null, monSrc = null;                    // input monitoring (live mic through armed track)
const armedTrack = () => tracks.find((t) => t.armed);
let markers = [], cycle = null, cycleOn = false, cycleDrag = null;   // arrangement markers + cycle region
let downbeatAt = null, setDownbeatMode = false;                       // manual grid downbeat (seconds)
let alignSettings = { beat_snap: true, div: 1, tune: 0.5, grid_ref: "" };  // last-applied align settings (match import defaults)
let pianoTrack = null, pianoSel = null, pdrag = null;                 // piano-roll editor state
const ROWH = 14;                                                      // piano-roll row height (px per semitone)

const laneVisibleW = () => Math.max(200, $("#tracks-pane").clientWidth - LANE_X);
const fitPx = () => laneVisibleW() / (duration || 1);
const contentW = () => (duration || 1) * pxPerSec;

function gridSpec() {
  if (tempo && tempo > 30) { const beat = (60 / tempo) * (4 / beatUnit); return { minor: beat, major: beat * beatsPerBar, unit: "bar" }; }
  return { minor: 1, major: 4, unit: "sec" };
}

// tempo at a time (step automation); 0 means "no tempo -> seconds grid"
function tempoAt(t) {
  if (!tempoMap.length) return (tempo && tempo > 30) ? tempo : 0;
  let bpm = tempoMap[0].bpm;
  for (const p of tempoMap) { if (p.t <= t + 1e-9) bpm = p.bpm; else break; }
  return bpm;
}
// beat/bar grid line times across the timeline, tempo-map aware (cached per layout)
function rebuildGrid() {
  const bpm0 = tempoAt(0), lines = [];
  if (!bpm0) {
    let minor = 1, major = 4; if (duration / minor > 1500) minor = major;
    for (let t = 0; t <= duration + 1e-6; t += minor) lines.push({ t, major: Math.abs(t / major - Math.round(t / major)) < 1e-6, beat: Math.round(t) });
    gridTimes = { lines, unit: "sec", major: 4 }; return gridTimes;
  }
  const step = (duration * bpm0 / 60 > 1500) ? beatsPerBar : 1;   // collapse to bars when dense
  let t = 0, beat = 0;
  while (t <= duration + 1e-6 && lines.length < 4000) {
    lines.push({ t, major: beat % beatsPerBar === 0, beat });
    for (let k = 0; k < step; k++) { t += (4 / beatUnit) * 60 / (tempoAt(t) || bpm0); beat++; }
  }
  gridTimes = { lines, unit: "bar", major: beatsPerBar };
  return gridTimes;
}
function gridLines() { if (!gridTimes) rebuildGrid(); return gridTimes; }
function snapTime(t) {
  const gl = gridLines().lines; if (!gl.length) return t;
  let lo = 0, hi = gl.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (gl[mid].t < t) lo = mid + 1; else hi = mid; }
  let best = gl[lo]; if (lo > 0 && Math.abs(gl[lo - 1].t - t) < Math.abs(best.t - t)) best = gl[lo - 1];
  return best.t;
}
// time of a (possibly fractional) beat index, integrating the tempo map
function beatToTime(b) {
  const bpm0 = tempoAt(0) || 100; let t = 0, i = 0;
  for (; i + 1 <= b; i++) t += (4 / beatUnit) * 60 / (tempoAt(t) || bpm0);
  const frac = b - i; if (frac > 0) t += frac * (4 / beatUnit) * 60 / (tempoAt(t) || bpm0);
  return t;
}
const TEMPO_MIN = 40, TEMPO_MAX = 220, TLANE_H = 48;
const bpmToY = (bpm) => (1 - (clamp(bpm, TEMPO_MIN, TEMPO_MAX) - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN)) * (TLANE_H - 8) + 4;
const yToBpm = (y) => Math.round(clamp(TEMPO_MIN + (1 - (y - 4) / (TLANE_H - 8)) * (TEMPO_MAX - TEMPO_MIN), TEMPO_MIN, TEMPO_MAX));
function drawTempoLane() {
  const c = $("#tempo-canvas"); if (!c || $("#tempo-lane").classList.contains("hidden")) return;
  const dpr = window.devicePixelRatio || 1, w = contentW(), h = TLANE_H;
  c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px"; c.style.height = h + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  gridLines().lines.forEach(({ t, major }) => { const x = t * pxPerSec; g.globalAlpha = major ? 0.3 : 0.12; g.strokeStyle = "#2b303b"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); });
  const pts = tempoMap.length ? tempoMap : [{ t: 0, bpm: tempo || 120 }];
  g.globalAlpha = 0.95; g.strokeStyle = "#ffd166"; g.fillStyle = "#ffd166"; g.lineWidth = 1.5; g.beginPath();
  pts.forEach((p, i) => { const y = bpmToY(p.bpm); if (i === 0) g.moveTo(0, y); else g.lineTo(p.t * pxPerSec, y); const nx = i + 1 < pts.length ? pts[i + 1].t * pxPerSec : w; g.lineTo(nx, y); });
  g.stroke();
  g.font = "9px -apple-system, sans-serif";
  tempoMap.forEach((p) => { const x = p.t * pxPerSec, y = bpmToY(p.bpm); g.fillRect(x - 3, y - 3, 6, 6); g.fillText(p.bpm + "", x + 5, y - 4); });
  g.lineWidth = 1; g.globalAlpha = 1;
}

// every beat time (for the metronome; not collapsed to bars)
function metroBeats(from) {
  const bpm0 = tempoAt(0); if (!bpm0) return [];
  const out = []; let t = 0, beat = 0;
  while (t <= duration + 1e-3 && out.length < 100000) {
    if (t >= from - 1e-6) out.push({ t, accent: beat % beatsPerBar === 0 });
    t += (4 / beatUnit) * 60 / (tempoAt(t) || bpm0); beat++;
  }
  return out;
}

function layout() {
  gridTimes = null;   // tempo/duration/zoom may have changed; rebuild the grid lazily
  if (!userZoomed) pxPerSec = fitPx();
  const cw = contentW();
  const ri = $("#ruler-inner"); if (ri) ri.style.width = cw + "px";
  document.querySelectorAll(".lane").forEach((l) => (l.style.width = cw + "px"));
  const tr = $("#tracks"); if (tr) tr.style.width = (LANE_X + cw) + "px";
  drawRuler();
  drawTempoLane();
  tracks.forEach(drawTrack);
  movePlayhead(playFrom);
  drawPiano();
}

function drawRuler() {
  const c = $("#ruler-inner"); if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = contentW(), h = 26;
  c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px"; c.style.height = h + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const gl = gridLines();
  g.strokeStyle = "#2e333f"; g.fillStyle = "#8b93a3"; g.font = "10px -apple-system, sans-serif";
  gl.lines.forEach(({ t, major, beat }) => {
    const x = t * pxPerSec;
    g.globalAlpha = major ? 0.9 : 0.4;
    g.beginPath(); g.moveTo(x, major ? 6 : 15); g.lineTo(x, 26); g.stroke();
    if (major) { g.globalAlpha = 0.85; g.fillText(gl.unit === "bar" ? String(Math.round(beat / gl.major) + 1) : Math.round(t) + "s", x + 3, 11); }
  });
  if (cycle) {   // cycle region band
    g.globalAlpha = 0.2; g.fillStyle = "#5cc8ff";
    g.fillRect(cycle.start * pxPerSec, 0, Math.max(1, (cycle.end - cycle.start) * pxPerSec), h);
    g.globalAlpha = 0.9; g.fillRect(cycle.start * pxPerSec, 0, 1.5, h); g.fillRect(cycle.end * pxPerSec - 1.5, 0, 1.5, h);
  }
  markers.forEach((mk) => {   // arrangement markers
    const x = mk.t * pxPerSec;
    g.globalAlpha = 0.9; g.strokeStyle = "#ffd166"; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillStyle = "#ffd166"; g.font = "9px -apple-system, sans-serif"; g.fillText(mk.name, x + 3, 23);
  });
  if (downbeatAt != null) {   // manual grid downbeat ("1")
    const x = downbeatAt * pxPerSec;
    g.globalAlpha = 1; g.fillStyle = "#5cff9d"; g.strokeStyle = "#5cff9d";
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 8, 0); g.lineTo(x, 8); g.closePath(); g.fill();
    g.font = "bold 9px -apple-system, sans-serif"; g.fillText("1", x + 3, 20);
  }
  g.globalAlpha = 1;
}

const $ = (s) => document.querySelector(s);
const LANE_X = 220;

async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
function status(text, working) {
  const s = $("#status"); s.textContent = text || ""; s.classList.toggle("work", !!working);
}

// ---- session lifecycle -----------------------------------------------------

async function init() {
  log("dj", "loading demo takes… or import your own up top.");
  try { await adopt(await api("/api/session", { use_llm: true }), "balanced the demo takes. talk to me, or import your own."); }
  catch (e) { log("dj", "couldn't start: " + e.message); }
}

async function adopt(res, hello) {
  session = { id: res.id };
  $("#parser").textContent = res.parser;
  await applyProject(res.project);
  if (hello) log("dj", hello);
}

async function applyProject(project, opts = {}) {
  // keepRegions: retain the clip positions/fades the user has arranged for tracks
  // that already exist, instead of snapping them back to the backend's default
  // start. Used when a re-render must not disturb the arrangement (e.g. adding a
  // recorded take). Left off for operations that intentionally reposition
  // (re-align, project load, agent commands).
  const keepRegions = !!opts.keepRegions;
  history = []; future = []; editPre = null; syncUndoBtns();   // structural change resets the undo baseline
  tempo = project.tempo || null;
  if (tempo) { const b = $("#bpm"); if (b) b.value = Math.round(tempo); }
  $("#tempo").textContent = project.tempo ? Math.round(project.tempo) + " BPM" + (project.beat_style ? " · " + project.beat_style.replace(/_/g, " ") : "") : "—";
  $("#key").textContent = project.key ? `${project.key}${project.progression ? " · " + project.progression : ""}` : "—";
  keySharps = keySharpsFromKey(project.key);   // drives key-signature-aware spelling on the score
  $("#drop").classList.add("hidden");

  const prev = Object.fromEntries(tracks.map((t) => [t.meta.file.replace(/\?.*/, ""), t]));
  const insts = tracks.filter((t) => t.kind === "instrument" || t.clientAudio);   // client-only, keep across backend re-renders
  duration = 0;
  tracks = project.tracks.map((meta) => {
    const old = prev[meta.file] || {};
    return {
      meta, buffer: null, gain: null, panner: null, send: null,
      eqLow: null, eqMid: null, eqHigh: null,
      volume: old.volume ?? 1, pan: meta.pan,
      muted: old.muted ?? false, solo: old.solo ?? false,
      nudgeMs: old.nudgeMs ?? 0,
      eqLowDb: old.eqLowDb ?? 0, eqMidDb: old.eqMidDb ?? 0, eqHighDb: old.eqHighDb ?? 0,
      reverbSend: old.reverbSend ?? 0,
      regions: keepRegions && old.regions && old.regions.length ? old.regions.map((r) => ({ ...r })) : [],
      selRegion: keepRegions ? old.selRegion ?? 0 : 0,   // clips: {start, offset, length, fadeIn, fadeOut} (seconds)
      takes: old.takes ?? null,     // comp lanes: [{name, buffer}]
      compAmt: old.compAmt ?? 0, driveAmt: old.driveAmt ?? 0, crush: old.crush ?? 0,   // 0..1
      modRate: old.modRate ?? 3, modDepth: old.modDepth ?? 0, modFb: old.modFb ?? 0.15,
      delayTime: old.delayTime ?? 0.25, delayFb: old.delayFb ?? 0.3, delayMix: old.delayMix ?? 0,
      automation: old.automation ?? { volume: [], pan: [], send: [] }, autoParam: old.autoParam ?? null,
    };
  });
  tracks = tracks.concat(insts);   // re-attach client instrument tracks
  renderTrackHeads();
  await Promise.all(tracks.map(loadBuffer));
  if (ctx) tracks.forEach(wireTrack);
  recomputeDuration();
  layout();
  requestAnimationFrame(layout);   // re-fit once the browser has final pane sizes
}

async function loadBuffer(t) {
  if (t.kind === "instrument") return;   // instruments have notes, not an audio buffer
  if (t.clientAudio) { if (!t.regions || !t.regions.length) t.regions = [{ start: 0, offset: 0, length: t.buffer.duration, fadeIn: 0, fadeOut: 0, take: 0, gain: 1 }]; if (ctx) wireTrack(t); return; }  // bounced audio: buffer already in memory
  const url = `/api/session/${session.id}/file?path=${encodeURIComponent(t.meta.file)}&v=${Date.now()}`;
  const buf = await (await fetch(url)).arrayBuffer();
  t.buffer = await ensureCtx().decodeAudioData(buf);
  if (!t.takes || !t.takes.length) t.takes = [{ name: t.meta.name, buffer: t.buffer }];
  else t.takes[0].buffer = t.buffer;   // primary take is the (re-rendered) backend stem
  if (!t.regions || !t.regions.length) { const trim = t.meta.trim || 0; t.regions = [{ start: t.meta.start || 0, offset: trim, length: Math.max(0.05, t.buffer.duration - trim), fadeIn: 0, fadeOut: 0, take: 0, gain: 1 }]; }
  t.regions.forEach((r) => { if (r.take == null) r.take = 0; if (r.gain == null) r.gain = 1; });
  if (ctx) wireTrack(t);
}
// each track holds regions (clips): {start (timeline s), offset (into buffer s), length s, fadeIn, fadeOut, take}
// and takes (comp lanes): [{name, buffer}]; a region plays takes[r.take]
const regionEnd = (r) => r.start + r.length;
const selectedRegion = (t) => t.regions && t.regions[t.selRegion || 0];
const regionBuffer = (t, r) => (t.takes && t.takes[r.take || 0] ? t.takes[r.take || 0].buffer : t.buffer);

const noteEnd = (t) => t.notes && t.notes.length ? Math.max(...t.notes.map((n) => n.start + n.dur)) : 0;

function recomputeDuration() {
  duration = tracks.reduce((d, t) => {
    if (t.kind === "instrument") return Math.max(d, noteEnd(t));
    if (!t.buffer) return d;
    return t.regions.reduce((m, r) => Math.max(m, regionEnd(r)), d);
  }, 0) || 1;
}

const PR_LO = 36, PR_HI = 84;   // C2..C6 pitch window for the lane mini-view
function drawTrack(t) { if (t.kind === "instrument") drawInstLane(t); else drawWave(t); }

function drawInstLane(t) {
  const c = t.canvas; if (!c) return;
  const dpr = window.devicePixelRatio || 1, w = contentW(), h = c.clientHeight || 86;
  c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  g.strokeStyle = "#2b303b";
  gridLines().lines.forEach(({ t: tt, major }) => { const x = tt * pxPerSec; g.globalAlpha = major ? 0.5 : 0.22; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); });
  const color = trackColor(t);
  g.globalAlpha = 0.95; g.fillStyle = color;
  const span = PR_HI - PR_LO;
  t.notes.forEach((n) => {
    const x = n.start * pxPerSec, ww = Math.max(2, n.dur * pxPerSec);
    const y = (1 - (Math.min(PR_HI, Math.max(PR_LO, n.pitch)) - PR_LO) / span) * (h - 6) + 2;
    g.fillRect(x, y, ww, 3.5);
  });
  if (!t.notes.length) { g.globalAlpha = 0.4; g.fillStyle = "#8b93a3"; g.font = "11px -apple-system, sans-serif"; g.fillText("click to open the piano roll", 8, h / 2); }
  drawAutomation(g, t, w, h);
}

function drawAutomation(g, t, w, h) {
  const param = t.autoParam; if (!param) return;
  const pts = t.automation[param], [lo, hi] = AUTO_RANGE[param];
  const y = (v) => (1 - (v - lo) / (hi - lo)) * (h - 8) + 4;
  g.globalAlpha = 0.95; g.strokeStyle = "#ffd166"; g.fillStyle = "#ffd166"; g.lineWidth = 1.5;
  g.beginPath();
  if (pts.length) {
    g.moveTo(0, y(pts[0].v));
    pts.forEach((p) => g.lineTo(p.t * pxPerSec, y(p.v)));
    g.lineTo(w, y(pts[pts.length - 1].v));
    g.stroke();
    pts.forEach((p) => g.fillRect(p.t * pxPerSec - 3, y(p.v) - 3, 6, 6));
  } else {
    const cur = param === "volume" ? t.volume : param === "pan" ? t.pan : t.reverbSend;
    g.globalAlpha = 0.5; g.setLineDash([4, 4]); g.moveTo(0, y(cur)); g.lineTo(w, y(cur)); g.stroke(); g.setLineDash([]);
    g.globalAlpha = 0.6; g.font = "10px -apple-system, sans-serif"; g.fillText("click to add " + param + " automation", 8, 14);
  }
  g.lineWidth = 1; g.globalAlpha = 1;
}

let apdrag = null;
function autoMouseDown(e, t) {
  const param = t.autoParam, pts = t.automation[param], [lo, hi] = AUTO_RANGE[param];
  const rect = t.canvas.getBoundingClientRect(), x = e.clientX - rect.left, yy = e.clientY - rect.top, h = t.canvas.clientHeight || 86;
  const yToV = (y) => clamp(lo + (1 - (y - 4) / (h - 8)) * (hi - lo), lo, hi);
  const yOf = (v) => (1 - (v - lo) / (hi - lo)) * (h - 8) + 4;
  const pre = snapshot();
  let hit = -1;
  for (let i = 0; i < pts.length; i++) { if (Math.abs(pts[i].t * pxPerSec - x) < 6 && Math.abs(yOf(pts[i].v) - yy) < 6) { hit = i; break; } }
  if (e.altKey || e.button === 2) { if (hit >= 0) { pts.splice(hit, 1); drawTrack(t); recomputeDuration(); layout(); pushUndo(pre); if (playing) play(playFrom); } return; }
  if (hit < 0) {
    let tt = x / pxPerSec; if (snapOn) tt = snapTime(tt);
    const p = { t: Math.max(0, tt), v: yToV(yy) }; pts.push(p); pts.sort((a, b) => a.t - b.t); hit = pts.indexOf(p);
  }
  apdrag = { t, param, pts, i: hit, pre };
  drawTrack(t);
}

function removeInstrument(t) {
  const pre = snapshot();
  if (pianoTrack === t) closePiano();
  tracks = tracks.filter((x) => x !== t);
  if (selectedFile === t.meta.file) selectedFile = tracks[0] && tracks[0].meta.file;
  renderTrackHeads(); recomputeDuration(); layout();
  const sel = selectedTrack(); if (sel) selectTrack(sel);
  pushUndo(pre);
  log("dj", `removed “${t.meta.name}”.`);
}

// ---- piano roll ------------------------------------------------------------

const BLACK = [1, 3, 6, 8, 10];

function openPiano(t) {
  if (!t || t.kind !== "instrument") return;
  pianoTrack = t; pianoSel = null; selectTrack(t);
  $("#piano-name").textContent = t.meta.name;
  $("#piano-inst").value = t.instrument;
  $("#sample-load").hidden = t.instrument !== "sampler";
  $("#tr-val").textContent = ((t.transpose || 0) > 0 ? "+" : "") + (t.transpose || 0);
  $("#piano").classList.remove("hidden");
  $("#piano-playhead").style.height = (PR_HI - PR_LO + 1) * ROWH + "px";
  buildMtk(); syncArpUI(); drawKeys(); drawPiano();
}
function closePiano() { pianoTrack = null; $("#piano").classList.add("hidden"); }
function syncPiano() { if (pianoTrack) { $("#piano-name").textContent = pianoTrack.meta.name; $("#piano-inst").value = pianoTrack.instrument; $("#sample-load").hidden = pianoTrack.instrument !== "sampler"; drawPiano(); } }

function drawKeys() {
  const rows = PR_HI - PR_LO + 1, w = 54, h = rows * ROWH, dpr = window.devicePixelRatio || 1;
  const c = $("#piano-keys"); c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px"; c.style.height = h + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  for (let i = 0; i < rows; i++) {
    const pitch = PR_HI - i, pc = pitch % 12, black = BLACK.includes(pc);
    g.fillStyle = black ? "#12151b" : "#dfe3ea"; g.fillRect(0, i * ROWH, w, ROWH - 0.5);
    if (pc === 0) { g.fillStyle = "#555"; g.font = "9px -apple-system, sans-serif"; g.fillText("C" + (Math.floor(pitch / 12) - 1), 30, i * ROWH + 10); }
  }
}
function drawPiano() {
  if (!pianoTrack) return;
  const rows = PR_HI - PR_LO + 1, dpr = window.devicePixelRatio || 1;
  const w = Math.max(contentW(), $("#piano-scroll").clientWidth), h = rows * ROWH;
  const c = $("#piano-grid"); c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px"; c.style.height = h + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  for (let i = 0; i < rows; i++) {
    const pitch = PR_HI - i, black = BLACK.includes(pitch % 12);
    g.fillStyle = black ? "#171a20" : "#1c2029"; g.fillRect(0, i * ROWH, w, ROWH);
    g.globalAlpha = (pitch % 12 === 0) ? 0.55 : 0.2; g.strokeStyle = "#2b303b";
    g.beginPath(); g.moveTo(0, i * ROWH); g.lineTo(w, i * ROWH); g.stroke();
  }
  g.strokeStyle = "#2b303b";
  gridLines().lines.forEach(({ t: tt, major }) => { const x = tt * pxPerSec; if (x > w) return; g.globalAlpha = major ? 0.55 : 0.22; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); });
  g.globalAlpha = 1;
  pianoTrack.notes.forEach((n) => {
    const x = n.start * pxPerSec, ww = Math.max(3, n.dur * pxPerSec), y = (PR_HI - n.pitch) * ROWH;
    g.globalAlpha = n === pianoSel ? 1 : 0.4 + 0.6 * (n.vel == null ? 0.8 : n.vel);   // opacity = velocity
    g.fillStyle = n === pianoSel ? "#ffd166" : ROLE_COLOR.inst; g.fillRect(x, y + 1, ww, ROWH - 2);
    g.globalAlpha = 0.5; g.strokeStyle = "#0a0c10"; g.strokeRect(x, y + 1, ww, ROWH - 2); g.globalAlpha = 1;
  });
  drawScore();
}

// ---- notation (score) view -------------------------------------------------
let scoreOn = false;
const PC_LETTER_SHARP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];   // sharp spelling: C C# D .. B
const PC_LETTER_FLAT = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];    // flat spelling: C Db D Eb ..
const PC_ISBLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];   // matches the backend key naming
const MAJOR_SIG = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5];   // major tonic pc -> signed key signature (fewest accidentals)
let keySharps = 0;   // signed count from the song key: +sharps / -flats
function keySharpsFromKey(str) {
  if (!str) return 0;
  const parts = String(str).trim().split(/\s+/), pc = PC_NAMES.indexOf(parts[0]);
  if (pc < 0) return 0;
  const major = /^min/i.test(parts[1] || "major") ? (pc + 3) % 12 : pc;   // minor -> relative major
  return MAJOR_SIG[major];
}
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];   // letters sharpened, in order: F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];    // letters flattened, in order: B E A D G C F
function keyAlter(li) {   // the key signature's alteration for a letter (0..6): +1 / -1 / 0
  if (keySharps > 0) return SHARP_ORDER.slice(0, keySharps).includes(li) ? 1 : 0;
  if (keySharps < 0) return FLAT_ORDER.slice(0, -keySharps).includes(li) ? -1 : 0;
  return 0;
}
const HALF = 5, PAD_TOP = 34;                 // px per diatonic half-step; top padding
const yStep = (step) => PAD_TOP + (38 - step) * HALF;   // step 38 = F5 (top treble line)
const LETTER_SEMI = [0, 2, 4, 5, 7, 9, 11];   // diatonic letter -> semitone within octave
const stepToMidiNat = (step) => { const oct = Math.floor(step / 7), li = step - oct * 7; return (oct + 1) * 12 + LETTER_SEMI[li]; };   // natural pitch at a staff step
// staff step + the accidental to DRAW given the key signature: diatonic notes need none, a natural sign cancels the key
function pitchToStaff(midi, flat) {   // -> { step, acc: 'sharp'|'flat'|'natural'|null }
  const pc = ((midi % 12) + 12) % 12, oct = Math.floor(midi / 12) - 1;
  const useFlat = flat || keySharps < 0;
  const letter = PC_ISBLACK[pc] ? (useFlat ? PC_LETTER_FLAT[pc] : PC_LETTER_SHARP[pc]) : PC_LETTER_SHARP[pc];
  const step = oct * 7 + letter, li = ((letter % 7) + 7) % 7;
  const noteAlter = midi - stepToMidiNat(step);   // this pitch vs the natural letter: +1 / 0 / -1
  const kA = keyAlter(li);
  const acc = noteAlter === kA ? null : noteAlter > 0 ? "sharp" : noteAlter < 0 ? "flat" : "natural";
  return { step, acc };
}
const accOffset = (n) => n.pitch - stepToMidiNat(pitchToStaff(n.pitch, n.flat).step);   // +1 sharp, -1 flat, 0 natural
const stepFromY = (y) => Math.round(38 - (y - PAD_TOP) / HALF);
let scoreX0 = 52;   // x where t=0 sits (shifts right to clear the key signature)
const scoreTimeFromX = (x) => { let t = (x - scoreX0) / pxPerSec; if (snapOn) t = snapTime(t); return Math.max(0, t); };
let sdrag = null;   // score-editor drag state
const TREBLE_LINES = [30, 32, 34, 36, 38], BASS_LINES = [18, 20, 22, 24, 26];
function drawScore() {
  const scroll = $("#score-scroll"); if (!scroll || scroll.classList.contains("hidden") || !pianoTrack) return;
  const c = $("#score-canvas"), dpr = window.devicePixelRatio || 1;
  const w = Math.max(contentW() + 40, scroll.clientWidth), h = 190;
  c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px"; c.style.height = h + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  // staff lines
  g.strokeStyle = "#8b93a3"; g.lineWidth = 1; g.globalAlpha = 0.85;
  TREBLE_LINES.concat(BASS_LINES).forEach((s) => { const y = yStep(s); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); });
  // clefs
  g.globalAlpha = 1; g.fillStyle = "#e6e9ef"; g.textBaseline = "alphabetic";
  g.font = "40px serif"; g.fillText("𝄞", 6, yStep(30) + 6);   // 𝄞 treble
  g.font = "34px serif"; g.fillText("𝄢", 8, yStep(24) + 4);   // 𝄢 bass
  // key + time signature (after the clefs); notes and bar lines shift right to clear them
  const sigW = drawKeySig(g), tsW = drawTimeSig(g, 32 + sigW);
  scoreX0 = 52 + sigW + tsW;
  // bar lines from the tempo grid
  gridLines().lines.forEach(({ t, major }) => { if (!major) return; const x = t * pxPerSec + scoreX0 - 12; g.globalAlpha = 0.5; g.strokeStyle = "#2e333f"; g.beginPath(); g.moveTo(x, yStep(38)); g.lineTo(x, yStep(18)); g.stroke(); });
  // notes: split at bar lines into tied segments, then beam runs of eighths/sixteenths that share a beat
  const segs = [], ties = [];
  [...pianoTrack.notes].sort((a, b) => a.start - b.start).forEach((n) => {
    const comps = noteComponents(n), step = pitchToStaff(n.pitch, n.flat).step;
    comps.forEach((cp, i) => {
      const beats = cp.dur / (60 / (tempoAt(cp.start) || 100));
      segs.push({ n, cp, first: i === 0, step, base: noteValue(beats).base, x: cp.start * pxPerSec + scoreX0, y: yStep(step) });
    });
    for (let i = 0; i < comps.length - 1; i++) ties.push([comps[i].start, comps[i + 1].start, step]);
  });
  segs.sort((a, b) => a.x - b.x);
  // bar-scoped accidentals: print one only when the alteration changes within the bar (a natural cancels an earlier sharp/flat)
  const majors = gridLines().lines.filter((l) => l.major).map((l) => l.t);
  const symOf = (alt) => alt > 0 ? "sharp" : alt < 0 ? "flat" : "natural";
  let curBar = -1, running = {}, prevBar = {};
  for (const s of segs) {
    const bar = majors.filter((m) => m <= s.cp.start + 1e-4).length;
    if (bar !== curBar) { prevBar = running; curBar = bar; running = {}; }
    if (!s.first) { s.acc = null; continue; }   // a tied continuation carries the pitch, never re-prints
    const li = ((s.step % 7) + 7) % 7, key = keyAlter(li), noteAlter = s.n.pitch - stepToMidiNat(s.step);
    const firstThisBar = !(s.step in running), eff = firstThisBar ? key : running[s.step];
    if (noteAlter !== eff) { s.acc = symOf(noteAlter); }
    else if (firstThisBar && noteAlter === key && prevBar[s.step] !== undefined && prevBar[s.step] !== key) {
      s.acc = symOf(noteAlter); s.courtesy = true;   // cautionary reminder: this step was altered in the previous bar
    } else { s.acc = null; }
    running[s.step] = noteAlter;
  }
  const groups = []; let cur = null;
  const spanQ = beamSpanQuarters();   // beaming group length (in quarter notes) for the current time signature
  const flush = () => { if (cur) { groups.push(cur); cur = null; } };
  for (const s of segs) {
    if (s.base > 0.5) { flush(); groups.push({ items: [s] }); continue; }   // quarter or longer is never beamed
    const st = s.cp.start, barStart = majors.reduce((acc, m) => (m <= st + 1e-4 ? m : acc), 0);
    const spanSec = spanQ * 60 / (tempoAt(st) || 100);
    const barIdx = majors.filter((m) => m <= st + 1e-4).length;
    const gi = barIdx * 1000 + Math.floor((st - barStart) / spanSec + 1e-4);   // unique per bar + sub-group within the bar
    if (cur && cur.gi === gi && Math.abs(st - cur.end) < 0.02) { cur.items.push(s); cur.end = st + s.cp.dur; }
    else { flush(); cur = { gi, end: st + s.cp.dur, items: [s] }; }
  }
  flush();
  for (const grp of groups) {
    if (grp.gi !== undefined && grp.items.length >= 2) drawBeamGroup(g, grp.items);
    else grp.items.forEach((s) => drawNote(g, s.n, s.cp, s.acc, null, s.courtesy));   // lone note keeps its flag
  }
  for (const [a, b, step] of ties) drawTie(g, a, b, step);
  // rests: a quarter-rest on each empty beat between the first and last note
  const ns = pianoTrack.notes;
  if (ns.length) {
    const firstStart = Math.min(...ns.map((n) => n.start)), lastEnd = Math.max(...ns.map((n) => n.start + n.dur));
    g.globalAlpha = 0.85;
    gridLines().lines.forEach(({ t }) => {
      if (t < firstStart - 1e-3 || t >= lastEnd - 1e-3) return;
      const beat = 60 / (tempoAt(t) || 100);
      if (!ns.some((n) => n.start < t + beat * 0.5 && n.start + n.dur > t + 1e-3)) drawRest(g, t * pxPerSec + scoreX0 + 2, yStep(33));
    });
  }
  g.globalAlpha = 1;
}
// key signature: sharps/flats at their standard staff steps on both clefs; returns px to reserve
function drawKeySig(g) {
  if (!keySharps) return 0;
  const sharp = keySharps > 0, n = Math.abs(keySharps);
  const tSteps = sharp ? [38, 35, 39, 36, 33, 37, 34] : [34, 37, 33, 36, 32, 35, 31];   // treble, order of sharps / flats
  const bSteps = sharp ? [24, 21, 25, 22, 19, 23, 20] : [20, 23, 19, 22, 18, 21, 17];   // bass
  g.globalAlpha = 1; g.fillStyle = "#cfd6e4"; g.font = "15px serif";
  for (let i = 0; i < n; i++) {
    const x = 30 + i * 9;
    g.fillText(sharp ? "♯" : "♭", x, yStep(tSteps[i]) + 5);
    g.fillText(sharp ? "♯" : "♭", x, yStep(bSteps[i]) + 5);
  }
  return n * 9 + 6;
}
// time signature: numerator over denominator, stacked on both clefs; returns px to reserve
function drawTimeSig(g, x0) {
  g.fillStyle = "#cfd6e4"; g.font = "bold 13px serif"; g.textAlign = "center";
  for (const mid of [34, 22]) { g.fillText(beatsPerBar + "", x0 + 6, yStep(mid + 2) + 4); g.fillText(beatUnit + "", x0 + 6, yStep(mid - 2) + 4); }
  g.textAlign = "left";
  return 18;
}
// beaming group length in quarter notes, per the time signature (compound meters group in threes)
function beamSpanQuarters() {
  if (beatUnit >= 8) return (beatsPerBar % 3 === 0 ? 3 : 2) * (4 / beatUnit);   // x/8, x/16: dotted (3 units) if compound, else pair
  return 4 / beatUnit;                                                          // x/4, x/2: one beat unit per group
}
// note value from a beat count, including dotted values
function noteValue(beats) {   // -> { base: 4/2/1/0.5/0.25, dotted }
  const T = [[4, false], [3, true], [2, false], [1.5, true], [1, false], [0.75, true], [0.5, false], [0.375, true], [0.25, false]];
  for (const [b, dot] of T) if (beats >= b - 1e-3) return { base: dot ? b / 1.5 : b, dotted: dot };
  return { base: 0.25, dotted: false };
}
// split a note at bar lines into tied segments so nothing crosses a bar
function noteComponents(n) {
  const bars = gridLines().lines.filter((l) => l.major).map((l) => l.t);
  const comps = []; let s = n.start, rem = n.dur, guard = 0;
  while (rem > 1e-3 && guard++ < 24) {
    const nb = bars.find((t) => t > s + 1e-3);
    const end = Math.min(s + rem, nb === undefined ? Infinity : nb);
    comps.push({ start: s, dur: end - s }); rem -= end - s; s = end;
  }
  return comps.length ? comps : [{ start: n.start, dur: n.dur }];
}
// tie arc between two segment noteheads of the same pitch
function drawTie(g, aStart, bStart, step) {
  const y = yStep(step), x1 = aStart * pxPerSec + scoreX0 + 5, x2 = bStart * pxPerSec + scoreX0 - 5;
  if (x2 - x1 < 4) return;
  g.strokeStyle = ROLE_COLOR.inst; g.lineWidth = 1.3; g.globalAlpha = 0.9;
  g.beginPath(); g.moveTo(x1, y + 5); g.quadraticCurveTo((x1 + x2) / 2, y + 11, x2, y + 5); g.stroke();
  g.globalAlpha = 1; g.lineWidth = 1;
}
// beam a run of eighths/sixteenths: shared-direction stems joined by a flat beam (two beams for sixteenths)
function drawBeamGroup(g, items) {
  const up = items.reduce((a, s) => a + s.step, 0) / items.length < 34;
  const off = up ? 4.5 : -4.5, MIN = 24, MAXRISE = 14, last = items.length - 1;   // min stem length; cap on total beam slant
  const bx = items.map((s) => s.x + off), bx0 = bx[0], xspan = bx[last] - bx0 || 1;
  // least-squares slope through the noteheads, so a run that dips or peaks mid-way still reads true
  const xm = bx.reduce((p, v) => p + v, 0) / bx.length, ym = items.reduce((p, s) => p + s.y, 0) / items.length;
  let sxx = 0, sxy = 0;
  items.forEach((s, i) => { const dx = bx[i] - xm; sxx += dx * dx; sxy += dx * (s.y - ym); });
  let b = sxx > 1e-6 ? sxy / sxx : 0;
  if (items[0].step === items[last].step) b = 0;                                     // equal outer notes -> flat beam (convention)
  if (Math.abs(b * xspan) > MAXRISE) b = Math.sign(b) * MAXRISE / xspan;             // cap the slant
  if (Math.abs(b) < 0.04) b = 0;                                                     // negligible tilt -> flat
  // intercept so the shortest stem is exactly MIN (beam clears every notehead), then snap the end to the staff-step grid
  const stemBase = items.map((s, i) => s.y - b * (bx[i] - bx0));
  let a = up ? Math.min(...stemBase) - MIN : Math.max(...stemBase) + MIN;
  a = PAD_TOP + (up ? Math.floor((a - PAD_TOP) / HALF) : Math.ceil((a - PAD_TOP) / HALF)) * HALF;
  const beamYAt = (x) => a + b * (x - bx0);
  items.forEach((s, i) => drawNote(g, s.n, s.cp, s.acc, { x: bx[i], y1: s.y, y2: beamYAt(bx[i]) }, s.courtesy));
  g.strokeStyle = ROLE_COLOR.inst; g.lineWidth = 3; g.lineCap = "butt";
  g.beginPath(); g.moveTo(bx0, beamYAt(bx0)); g.lineTo(bx[bx.length - 1], beamYAt(bx[bx.length - 1])); g.stroke();   // primary beam
  const doff = up ? 5 : -5, is16 = (s) => s && s.base <= 0.25;   // second beam (parallel), for sixteenths
  for (let i = 0; i < items.length; i++) {
    if (!is16(items[i])) continue;
    const y = beamYAt(bx[i]) + doff;
    if (is16(items[i + 1])) { g.beginPath(); g.moveTo(bx[i], y); g.lineTo(bx[i + 1], beamYAt(bx[i + 1]) + doff); g.stroke(); }
    else if (!is16(items[i - 1])) { const d = i > 0 ? -6 : 6; g.beginPath(); g.moveTo(bx[i], y); g.lineTo(bx[i] + d, y + b * d); g.stroke(); }   // stub for an isolated sixteenth
  }
  g.lineWidth = 1;
}
// hand-drawn quarter rest (the 𝄽 glyph isn't in the available fonts)
function drawRest(g, cx, cy) {
  g.strokeStyle = "#8b93a3"; g.lineWidth = 2.2; g.lineJoin = "round";
  g.beginPath();
  g.moveTo(cx - 3, cy - 9); g.lineTo(cx + 3, cy - 3); g.lineTo(cx - 3, cy + 2); g.lineTo(cx + 3, cy + 8);
  g.stroke();
  g.beginPath(); g.moveTo(cx + 3, cy + 8); g.quadraticCurveTo(cx - 3, cy + 5, cx + 1, cy + 12); g.stroke();
  g.lineWidth = 1;
}
function drawNote(g, n, cp, acc, beam, courtesy) {   // acc: the accidental to print ('sharp'|'flat'|'natural'|null), resolved bar-scoped by the caller
  cp = cp || { start: n.start, dur: n.dur };
  const { step } = pitchToStaff(n.pitch, n.flat);
  const x = cp.start * pxPerSec + scoreX0, y = yStep(step);
  const beats = cp.dur / (60 / (tempoAt(cp.start) || 100));
  const { base, dotted } = noteValue(beats);
  const open = base >= 2, stem = base < 4, flags = base === 0.5 ? 1 : base < 0.5 ? 2 : 0;
  // ledger lines (above F5, below G2, and the middle-C region)
  g.strokeStyle = "#8b93a3"; g.lineWidth = 1; g.globalAlpha = 0.85;
  for (let s = 40; s <= step; s += 2) { const ly = yStep(s); g.beginPath(); g.moveTo(x - 8, ly); g.lineTo(x + 8, ly); g.stroke(); }
  for (let s = 16; s >= step; s -= 2) { const ly = yStep(s); g.beginPath(); g.moveTo(x - 8, ly); g.lineTo(x + 8, ly); g.stroke(); }
  if (step === 28) { const ly = yStep(28); g.beginPath(); g.moveTo(x - 8, ly); g.lineTo(x + 8, ly); g.stroke(); }   // middle C
  g.globalAlpha = 1;
  if (acc) {
    const sym = acc === "flat" ? "♭" : acc === "natural" ? "♮" : "♯";
    g.font = "14px serif";
    if (courtesy) { g.fillStyle = "#8b93a3"; g.fillText("(" + sym + ")", x - 24, y + 5); }   // cautionary, dimmer + parenthesized
    else { g.fillStyle = "#e6e9ef"; g.fillText(sym, x - 16, y + 5); }
  }
  g.save(); g.translate(x, y); g.rotate(-0.28);
  if (open) { g.strokeStyle = ROLE_COLOR.inst; g.lineWidth = 1.7; g.beginPath(); g.ellipse(0, 0, 5.2, 3.5, 0, 0, 2 * Math.PI); g.stroke(); }
  else { g.fillStyle = n === pianoSel ? "#ffd166" : ROLE_COLOR.inst; g.beginPath(); g.ellipse(0, 0, 5.2, 3.5, 0, 0, 2 * Math.PI); g.fill(); }
  g.restore();
  // augmentation dot, just right of the notehead (lifted into the space above for a note on a line)
  if (dotted) { g.fillStyle = n === pianoSel ? "#ffd166" : ROLE_COLOR.inst; g.beginPath(); g.arc(x + 10, y - (step % 2 === 0 ? HALF : 0), 1.7, 0, 2 * Math.PI); g.fill(); }
  if (beam) {   // stem runs to the sloped beam line; the beam replaces the flags
    g.strokeStyle = ROLE_COLOR.inst; g.lineWidth = 1.5; g.beginPath(); g.moveTo(beam.x, beam.y1); g.lineTo(beam.x, beam.y2); g.stroke(); g.lineWidth = 1;
  } else if (stem) {
    const up = step < 34, sx = x + (up ? 4.5 : -4.5), ey = y + (up ? -28 : 28);
    g.strokeStyle = ROLE_COLOR.inst; g.lineWidth = 1.5; g.beginPath(); g.moveTo(sx, y); g.lineTo(sx, ey); g.stroke();
    for (let f = 0; f < flags; f++) { const fy = ey + (up ? f * 6 : -f * 6); g.beginPath(); g.moveTo(sx, fy); g.quadraticCurveTo(sx + 9, fy + (up ? 7 : -7), sx + 7, fy + (up ? 14 : -14)); g.stroke(); }
  }
}

function auditionNote(pitch) {
  const t = selectedTrack(); const inst = (t && t.kind === "instrument") ? t.instrument : "synth";
  const v = startLiveNote(inst, pitch, 0.8); setTimeout(() => v.release(), 300);
}

// ---- keyboard + Web MIDI note input ----------------------------------------

const KEYMAP = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72, o: 73, l: 74 };
let octaveShift = 0;
const heldKeys = {}, midiHeld = {};

function recPos() { return playing ? playFrom + (ctx.currentTime - startedAt) : null; }

// where played/recorded notes go: the armed instrument, else the selected one
function noteTarget() {
  const a = armedTrack(); if (a && a.kind === "instrument") return a;
  const s = selectedTrack(); return (s && s.kind === "instrument") ? s : null;
}
function noteOn(map, id, midi, vel) {
  const t = noteTarget(); if (!t) return;
  if (map[id]) return;
  map[id] = { voice: startLiveNote(t.instrument, midi, vel), midi, startPos: recPos() };
}
function noteOff(map, id, vel) {
  const hk = map[id]; if (!hk) return; hk.voice.release(); delete map[id];
  const t = noteTarget();
  if (hk.startPos != null && playing && t && t.kind === "instrument") {   // record into the armed instrument
    const pre = snapshot();
    t.notes.push({ pitch: hk.midi, start: hk.startPos, dur: Math.max(0.08, (recPos() ?? hk.startPos) - hk.startPos), vel: vel || 0.85 });
    pushUndo(pre); recomputeDuration(); layout(); if (pianoTrack === t) drawPiano();
  }
}
function onMidiMessage(ev) {
  const [st, d1, d2] = ev.data, cmd = st & 0xf0;
  if (cmd === 0x90 && d2 > 0) noteOn(midiHeld, d1, d1, d2 / 127);
  else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) noteOff(midiHeld, d1, 0.8);
}
let midiReady = false;
function setupMidi() {
  if (midiReady || !navigator.requestMIDIAccess) return; midiReady = true;
  navigator.requestMIDIAccess().then((acc) => {
    const bind = () => acc.inputs.forEach((i) => (i.onmidimessage = onMidiMessage));
    bind(); acc.onstatechange = bind;
  }).catch(() => {});
}

// schedule one track's clip (trim + fades) into an audio context; used live and for export
function scheduleRegion(actx, buffer, r, eqIn, t0, from) {
  if (!buffer || r.length <= 0) return null;
  const into = from - r.start;
  if (into >= r.length) return null;
  let when, offset, dur;
  if (into >= 0) { when = t0; offset = r.offset + into; dur = r.length - into; }
  else { when = t0 - into; offset = r.offset; dur = r.length; }
  if (dur <= 0) return null;
  const s = actx.createBufferSource(); s.buffer = buffer;
  const fg = actx.createGain(); s.connect(fg).connect(eqIn);
  const g = fg.gain, fi = r.fadeIn, fo = r.fadeOut, sInto = Math.max(0, into);
  const G = r.gain == null ? 1 : r.gain;
  const startFrac = (fi > 0 ? Math.min(1, sInto / fi) : 1) * G;
  g.setValueAtTime(startFrac, when);
  if (fi > 0 && sInto < fi) g.linearRampToValueAtTime(G, when + (fi - sInto));
  if (fo > 0 && fo < dur) { g.setValueAtTime(G, when + dur - fo); g.linearRampToValueAtTime(0.0001, when + dur); }
  s.start(when, offset, dur);
  return s;
}
function scheduleTrack(actx, t, eqIn, t0, from) {
  const out = [];
  for (const r of t.regions) { const s = scheduleRegion(actx, regionBuffer(t, r), r, eqIn, t0, from); if (s) out.push(s); }
  return out;
}

// ---- automation ------------------------------------------------------------

const AUTO_RANGE = { volume: [0, 1.5], pan: [-1, 1], send: [0, 1] };

function interpAuto(pts, at) {
  if (!pts.length) return null;
  if (at <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (at <= pts[i].t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * ((at - a.t) / ((b.t - a.t) || 1)); }
  }
  return pts[pts.length - 1].v;
}
function scheduleAutoParam(param, pts, gate, from, t0) {
  if (!param || !pts || !pts.length) return false;
  param.cancelScheduledValues(t0);
  param.setValueAtTime(interpAuto(pts, from) * gate, t0);
  pts.forEach((p) => { if (p.t > from) param.linearRampToValueAtTime(Math.max(0.0001, p.v * gate), t0 + (p.t - from)); });
  return true;
}
function scheduleAutomation(t, nodes, from, t0) {
  const gate = t.muted ? 0 : (anySolo() && !t.solo ? 0 : 1);
  scheduleAutoParam(nodes.gain && nodes.gain.gain, t.automation.volume, gate, from, t0);
  scheduleAutoParam(nodes.panner && nodes.panner.pan, t.automation.pan, 1, from, t0);
  scheduleAutoParam(nodes.send && nodes.send.gain, t.automation.send, 1, from, t0);
}

// arpeggiator: expand overlapping-note clusters (chords) into stepped sequences
function arpExpand(notes, spb, rate, mode) {
  if (!notes.length) return notes;
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const clusters = []; let cur = null;
  for (const n of sorted) {
    const end = n.start + n.dur;
    if (cur && n.start < cur.end - 1e-3) { cur.notes.push(n); cur.end = Math.max(cur.end, end); }
    else { cur = { start: n.start, end, notes: [n] }; clusters.push(cur); }
  }
  const step = Math.max(0.05, rate * spb), out = [];
  for (const c of clusters) {
    let pitches = [...new Set(c.notes.map((n) => n.pitch))].sort((a, b) => a - b);
    if (mode === "down") pitches.reverse();
    else if (mode === "updown" && pitches.length > 2) pitches = pitches.concat(pitches.slice(1, -1).reverse());
    const vel = c.notes[0].vel || 0.8;
    let i = 0;
    for (let tt = c.start; tt < c.end - 1e-3; tt += step, i++) out.push({ pitch: pitches[i % pitches.length], start: tt, dur: step * 0.9, vel });
  }
  return out;
}

// schedule an instrument track's notes into an audio context (live + export)
function scheduleNotes(actx, t, eqIn, t0, from) {
  const out = [];
  const tr = t.transpose || 0;
  const src = (t.arp && t.arp.on) ? arpExpand(t.notes, 60 / (tempo || 100), t.arp.rate, t.arp.mode) : t.notes;
  for (const n of src) {
    const rel = n.start - from;
    let when, dur;
    if (rel >= 0) { when = t0 + rel; dur = n.dur; }
    else if (-rel < n.dur) { when = t0; dur = n.dur + rel; }
    else continue;
    out.push(...playVoice(actx, eqIn, t.instrument, n.pitch + tr, when, dur, n.vel, t.sampleBuffer));
  }
  return out;
}

// quantize a note list to a grid (beats), with strength (0..1) and swing (0..0.5)
function quantizeNotes(notes, gridBeats, strength, swing) {
  const step = gridBeats * (60 / (tempo || 100));
  notes.forEach((n) => {
    const idx = Math.round(n.start / step);
    let target = idx * step;
    if (swing && idx % 2 === 1) target += step * swing;
    n.start = Math.max(0, n.start + (target - n.start) * strength);
  });
}

// ---- audio graph -----------------------------------------------------------

let reverbBus = null, masterOut = null, mEqLow = null, mEqHigh = null, mComp = null, mLim = null;
const masterFx = { low: 0, high: 0, comp: 0, limit: false };

// vocal blend bus: every lead/harmony take runs through one shared space + glue +
// air so a stack of voices sits together (defaults transparent until "blend" is up)
let vocalBus = null, blendComp = null, blendAir = null, blendSend = null;
const blend = { space: 0, glue: 0, air: 0 };
const isVocal = (t) => t.meta.role === "lead" || t.meta.role === "harmony";
function buildVocalBus(actx, out, reverbIn) {
  const input = actx.createGain();
  const comp = actx.createDynamicsCompressor(); setComp(comp, blend.glue);
  const air = actx.createBiquadFilter(); air.type = "highshelf"; air.frequency.value = 8000; air.gain.value = blend.air;
  const send = actx.createGain(); send.gain.value = blend.space;
  input.connect(comp).connect(air).connect(out);   // dry stack (glued + air) → master
  air.connect(send).connect(reverbIn);              // one shared reverb space for all voices
  return { input, comp, air, send };
}
function applyBlend() {
  if (blendComp) setComp(blendComp, blend.glue);
  if (blendAir) blendAir.gain.value = blend.air;
  if (blendSend) blendSend.gain.value = blend.space;
}

function setLimiter(c, on) {
  if (on) { c.threshold.value = -1; c.ratio.value = 20; c.knee.value = 0; c.attack.value = 0.002; c.release.value = 0.05; }
  else { c.threshold.value = 0; c.ratio.value = 1; c.knee.value = 0; c.attack.value = 0.003; c.release.value = 0.1; }
}
// master bus: sum -> low/high shelf EQ -> glue comp -> limiter -> fader -> out
function buildMasterFx(actx, sumNode, faderVal) {
  const low = actx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 120; low.gain.value = masterFx.low;
  const high = actx.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 4000; high.gain.value = masterFx.high;
  const comp = actx.createDynamicsCompressor(); setComp(comp, masterFx.comp);
  const lim = actx.createDynamicsCompressor(); setLimiter(lim, masterFx.limit);
  const out = actx.createGain(); out.gain.value = faderVal;
  sumNode.connect(low).connect(high).connect(comp).connect(lim).connect(out);
  return { low, high, comp, lim, out };
}

function makeImpulse(actx, seconds = 2.0, decay = 2.6) {
  const len = Math.floor(actx.sampleRate * seconds);
  const buf = actx.createBuffer(2, len, actx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 1;   // pre-fader sum bus
    const mfx = buildMasterFx(ctx, master, +$("#master").value);
    masterOut = mfx.out; mEqLow = mfx.low; mEqHigh = mfx.high; mComp = mfx.comp; mLim = mfx.lim;
    masterOut.connect(ctx.destination);
    // shared reverb bus: per-track sends -> convolver -> return -> sum bus
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx);
    const ret = ctx.createGain(); ret.gain.value = 0.9;
    conv.connect(ret).connect(master);
    reverbBus = conv;
    const vb = buildVocalBus(ctx, master, conv);   // shared vocal blend bus → sum
    vocalBus = vb.input; blendComp = vb.comp; blendAir = vb.air; blendSend = vb.send;
    masterMeter = ctx.createAnalyser(); masterMeter.fftSize = 256; masterOut.connect(masterMeter);
    tracks.forEach(wireTrack);
  }
  return ctx;
}

// ---- software instruments (synth voices) -----------------------------------

const INSTRUMENTS = {
  synth: { osc: "sawtooth", a: 0.02, d: 0.2, s: 0.7, r: 0.3, filter: 2600, detune: 7, gain: 0.22 },
  keys:  { osc: "triangle", a: 0.005, d: 0.45, s: 0.5, r: 0.4, filter: 4200, detune: 0, gain: 0.3 },
  bass:  { osc: "sine", a: 0.005, d: 0.15, s: 0.85, r: 0.2, filter: 900, detune: 0, gain: 0.34, oct: -1 },
  pluck: { osc: "square", a: 0.002, d: 0.18, s: 0.0, r: 0.14, filter: 3200, detune: 0, gain: 0.2 },
  fm:    { fm: true, ratio: 2.0, index: 320, a: 0.005, d: 0.5, s: 0.35, r: 0.5, gain: 0.28 },
  drums: { drum: true },
  sampler: { sampler: true, base: 60 },
};
const INSTRUMENT_NAMES = Object.keys(INSTRUMENTS);
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// shared short noise buffer per audio context (for drum synthesis)
const _noiseCache = new WeakMap();
function noiseBuffer(actx) {
  let b = _noiseCache.get(actx);
  if (!b) { b = actx.createBuffer(1, actx.sampleRate, actx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; _noiseCache.set(actx, b); }
  return b;
}
// General-MIDI-ish drum map -> synthesized one-shots; returns scheduled source nodes
function playDrum(actx, dest, midi, when, vel) {
  const out = [], v = (vel || 0.9);
  const noise = (dur, hp, lp, peak) => {
    const s = actx.createBufferSource(); s.buffer = noiseBuffer(actx); s.loop = true;
    const g = actx.createGain(); const f = actx.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = (hp + lp) / 2; f.Q.value = 0.7;
    s.connect(f).connect(g).connect(dest);
    g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(peak * v, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    s.start(when); s.stop(when + dur + 0.02); out.push(s); return { g, f };
  };
  const tone = (f0, f1, dur, peak, type) => {
    const o = actx.createOscillator(); o.type = type || "sine"; const g = actx.createGain();
    o.connect(g).connect(dest); o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), when + dur);
    g.gain.setValueAtTime(peak * v, when); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.start(when); o.stop(when + dur + 0.02); out.push(o);
  };
  const pc = midi;
  if (pc === 36 || pc === 35) tone(120, 45, 0.16, 0.9, "sine");                       // kick
  else if (pc === 38 || pc === 40) { tone(190, 120, 0.12, 0.35, "triangle"); noise(0.18, 1200, 4000, 0.5); }  // snare
  else if (pc === 39) { for (let k = 0; k < 3; k++) { const w = when + k * 0.012; const s = actx.createBufferSource(); s.buffer = noiseBuffer(actx); s.loop = true; const g = actx.createGain(); const f = actx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1500; s.connect(f).connect(g).connect(dest); g.gain.setValueAtTime(0.4 * v, w); g.gain.exponentialRampToValueAtTime(0.0001, w + 0.05); s.start(w); s.stop(w + 0.07); out.push(s); } }  // clap
  else if (pc === 42) noise(0.045, 6000, 12000, 0.32);                                // closed hat
  else if (pc === 46) noise(0.30, 6000, 12000, 0.28);                                 // open hat
  else if (pc === 49 || pc === 57) noise(0.7, 3000, 11000, 0.3);                      // crash
  else if (pc === 45 || pc === 47 || pc === 48 || pc === 50) tone(220 + (pc - 45) * 30, 110, 0.2, 0.6, "sine"); // toms
  else tone(200, 120, 0.1, 0.4, "triangle");
  return out;
}

// built-in mallet sample so the sampler makes sound before you load your own
const _malletCache = new WeakMap();
function malletSample(actx) {
  let b = _malletCache.get(actx);
  if (!b) { const sr = actx.sampleRate, len = Math.floor(sr * 0.6); b = actx.createBuffer(1, len, sr); const d = b.getChannelData(0), f = midiToFreq(60);
    for (let i = 0; i < len; i++) { const t = i / sr, env = Math.exp(-t * 6); d[i] = env * (Math.sin(2 * Math.PI * f * t) * 0.6 + Math.sin(2 * Math.PI * f * 2 * t) * 0.25 + Math.sin(2 * Math.PI * f * 3 * t) * 0.12); }
    _malletCache.set(actx, b); }
  return b;
}
function playSampler(actx, dest, p, midi, when, dur, vel, sampleBuf) {
  const buf = sampleBuf || malletSample(actx);
  const s = actx.createBufferSource(); s.buffer = buf; s.playbackRate.value = Math.pow(2, (midi - (p.base || 60)) / 12);
  const g = actx.createGain(); s.connect(g).connect(dest);
  const peak = 0.9 * (vel || 0.8), end = when + Math.max(0.05, dur);
  g.gain.setValueAtTime(peak, when); g.gain.setValueAtTime(peak, end); g.gain.linearRampToValueAtTime(0.0001, end + 0.06);
  s.start(when); s.stop(end + 0.1); return [s];
}

// schedule one note through a synth voice into `dest`; returns the oscillators
function playVoice(actx, dest, instName, midi, when, dur, vel, sampleBuf) {
  const p = INSTRUMENTS[instName] || INSTRUMENTS.synth;
  if (p.drum) return playDrum(actx, dest, midi, when, vel);
  if (p.sampler) return playSampler(actx, dest, p, midi, when, dur, vel, sampleBuf);
  if (p.fm) return playFm(actx, dest, p, midi, when, dur, vel);
  const f = midiToFreq(midi + (p.oct ? p.oct * 12 : 0));
  const g = actx.createGain();
  const lp = actx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = p.filter;
  g.connect(lp).connect(dest);
  const oscs = [];
  const mk = (det) => { const o = actx.createOscillator(); o.type = p.osc; o.frequency.value = f; if (det) o.detune.value = det; o.connect(g); return o; };
  oscs.push(mk(0)); if (p.detune) { oscs.push(mk(p.detune)); oscs.push(mk(-p.detune)); }
  const peak = p.gain * (vel || 0.8) / (p.detune ? 3 : 1);
  const t = when, aEnd = t + p.a, dEnd = aEnd + p.d, rel = t + Math.max(0.06, dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, aEnd);
  g.gain.linearRampToValueAtTime(Math.max(0.0001, peak * p.s), dEnd);
  g.gain.setValueAtTime(Math.max(0.0001, peak * p.s), Math.max(dEnd, rel));
  g.gain.linearRampToValueAtTime(0.0001, rel + p.r);
  oscs.forEach((o) => { o.start(t); o.stop(rel + p.r + 0.03); });
  return oscs;
}

// two-operator FM voice (scheduled); returns oscillator nodes
function playFm(actx, dest, p, midi, when, dur, vel) {
  const f = midiToFreq(midi);
  const g = actx.createGain(); g.connect(dest);
  const carrier = actx.createOscillator(); carrier.type = "sine"; carrier.frequency.value = f;
  const mod = actx.createOscillator(); mod.type = "sine"; mod.frequency.value = f * p.ratio;
  const modGain = actx.createGain(); modGain.gain.value = p.index;
  mod.connect(modGain).connect(carrier.frequency); carrier.connect(g);
  const peak = p.gain * (vel || 0.8), t = when, aEnd = t + p.a, dEnd = aEnd + p.d, rel = t + Math.max(0.06, dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, aEnd);
  g.gain.linearRampToValueAtTime(Math.max(0.0001, peak * p.s), dEnd);
  g.gain.setValueAtTime(Math.max(0.0001, peak * p.s), Math.max(dEnd, rel));
  g.gain.linearRampToValueAtTime(0.0001, rel + p.r);
  [carrier, mod].forEach((o) => { o.start(t); o.stop(rel + p.r + 0.03); });
  return [carrier, mod];
}

// a held (live) note for keyboard/MIDI auditioning; caller calls .release()
function startLiveNote(instName, midi, vel) {
  ensureCtx();
  const t = selectedTrack();
  const dest = (t && t.kind === "instrument" && t.eqLow) ? (wireTrack(t), t.eqLow) : master;
  if (t && t.kind === "instrument" && t.transpose) midi += t.transpose;   // audition matches transposed playback
  const p = INSTRUMENTS[instName] || INSTRUMENTS.synth;
  if (p.drum) { playDrum(ctx, dest, midi, ctx.currentTime + 0.01, vel); return { release() {} }; }
  if (p.sampler) { playSampler(ctx, dest, p, midi, ctx.currentTime + 0.01, 0.4, vel, t && t.sampleBuffer); return { release() {} }; }
  if (p.fm) { playFm(ctx, dest, p, midi, ctx.currentTime + 0.01, 0.25, vel); return { release() {} }; }
  const f = midiToFreq(midi + (p.oct ? p.oct * 12 : 0));
  const g = ctx.createGain();
  const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = p.filter;
  g.connect(lp).connect(dest);
  const oscs = [];
  const mk = (det) => { const o = ctx.createOscillator(); o.type = p.osc; o.frequency.value = f; if (det) o.detune.value = det; o.connect(g); o.start(); return o; };
  oscs.push(mk(0)); if (p.detune) { oscs.push(mk(p.detune)); oscs.push(mk(-p.detune)); }
  const peak = p.gain * (vel || 0.8) / (p.detune ? 3 : 1);
  const now = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(peak, now + p.a);
  g.gain.linearRampToValueAtTime(Math.max(0.0001, peak * p.s), now + p.a + p.d);
  return { release() { const r = ctx.currentTime; g.gain.cancelScheduledValues(r); g.gain.setValueAtTime(g.gain.value, r); g.gain.linearRampToValueAtTime(0.0001, r + p.r); oscs.forEach((o) => o.stop(r + p.r + 0.03)); } };
}

function setComp(comp, amt) {
  comp.threshold.value = amt > 0 ? -6 - amt * 30 : 0;   // 0..-36 dB
  comp.ratio.value = 1 + amt * 7;                        // 1..8 (1 = no compression)
  comp.knee.value = 6; comp.attack.value = 0.005; comp.release.value = 0.12;
}
function driveCurve(amt) {
  const n = 1024, c = new Float32Array(n), k = amt * 100;
  for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = amt > 0 ? (3 + k) * x * 0.35 / (Math.PI + k * Math.abs(x)) : x; }
  return c;
}
// bit-depth reduction (export-safe: pure waveshaper, no realtime-only sample-rate node)
function crushCurve(amt) {
  const n = 2048, c = new Float32Array(n);
  const bits = amt > 0 ? Math.max(2, Math.round(16 - amt * 13)) : 16, levels = Math.pow(2, bits);
  for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = amt > 0 ? Math.round(x * levels / 2) / (levels / 2) : x; }
  return c;
}

// build a per-track channel strip in an AudioContext (live or offline)
// chain: EQ -> compressor -> drive -> gain -> pan -> master, plus reverb + delay sends
function buildChain(actx, t, out, reverbIn) {
  const eqLow = actx.createBiquadFilter(); eqLow.type = "lowshelf"; eqLow.frequency.value = 120; eqLow.gain.value = t.eqLowDb;
  const eqMid = actx.createBiquadFilter(); eqMid.type = "peaking"; eqMid.frequency.value = 1000; eqMid.Q.value = 0.9; eqMid.gain.value = t.eqMidDb;
  const eqHigh = actx.createBiquadFilter(); eqHigh.type = "highshelf"; eqHigh.frequency.value = 4000; eqHigh.gain.value = t.eqHighDb;
  const comp = actx.createDynamicsCompressor(); setComp(comp, t.compAmt);
  const shaper = actx.createWaveShaper(); shaper.curve = driveCurve(t.driveAmt); shaper.oversample = "2x";
  const crushNode = actx.createWaveShaper(); crushNode.curve = crushCurve(t.crush || 0);
  const gain = actx.createGain(); gain.gain.value = effGain(t);
  const panner = actx.createStereoPanner(); panner.pan.value = t.pan;
  const send = actx.createGain(); send.gain.value = t.reverbSend;
  // modulation insert (chorus / flanger): LFO-swept short delay with feedback
  const mNode = actx.createDelay(0.05); mNode.delayTime.value = 0.006;
  const mLfo = actx.createOscillator(); mLfo.type = "sine"; mLfo.frequency.value = t.modRate || 3;
  const mLfoGain = actx.createGain(); mLfoGain.gain.value = (t.modDepth || 0) * 0.005;
  const mFb = actx.createGain(); mFb.gain.value = (t.modDepth ? (t.modFb || 0) : 0);
  const mWet = actx.createGain(); mWet.gain.value = (t.modDepth || 0) * 0.7;
  mLfo.connect(mLfoGain).connect(mNode.delayTime); mLfo.start();
  // per-track delay (echo) with feedback
  const dNode = actx.createDelay(1.0); dNode.delayTime.value = Math.max(0.05, t.delayTime);
  const dFb = actx.createGain(); dFb.gain.value = Math.min(0.85, t.delayFb);
  const dWet = actx.createGain(); dWet.gain.value = t.delayMix;
  eqLow.connect(eqMid).connect(eqHigh).connect(comp).connect(shaper).connect(crushNode).connect(gain);
  crushNode.connect(mNode); mNode.connect(mFb).connect(mNode); mNode.connect(mWet).connect(gain);   // modulation wet
  gain.connect(panner);
  panner.connect(out);
  panner.connect(send).connect(reverbIn);
  panner.connect(dNode); dNode.connect(dFb).connect(dNode); dNode.connect(dWet).connect(out);
  return { eqLow, eqMid, eqHigh, comp, shaper, crushNode, gain, panner, send, dNode, dFb, dWet, mNode, mLfo, mLfoGain, mFb, mWet };
}

function wireTrack(t) {
  if (t.gain) return;
  const out = (isVocal(t) && vocalBus) ? vocalBus : master;   // voices sum on the blend bus
  const c = buildChain(ctx, t, out, reverbBus);
  Object.assign(t, c);
  t.meter = ctx.createAnalyser(); t.meter.fftSize = 256; t.panner.connect(t.meter);   // live meter tap (not in export)
}

// ---- metering (live) -------------------------------------------------------
let masterMeter = null;
const _meterBuf = new Uint8Array(256);
function peakOf(an) {
  if (!an) return 0;
  an.getByteTimeDomainData(_meterBuf);
  let m = 0; for (let i = 0; i < _meterBuf.length; i++) { const d = Math.abs(_meterBuf[i] - 128); if (d > m) m = d; }
  return Math.min(1, m / 128);
}
let masterHold = { v: 0 };
// map a linear peak to a -48..0 dBFS meter fill, with peak-hold decay so
// short transients (drum hits) register instead of slipping between frames
function meterDisplay(peak, hold) {
  hold.v = Math.max(peak, hold.v * 0.9);
  if (hold.v <= 1e-4) return 0;
  const db = 20 * Math.log10(hold.v);
  return Math.max(0, Math.min(1, (db + 48) / 48));
}
function paintMeter(el, p) {
  if (!el) return;
  el.style.width = Math.round(p * 100) + "%";
  el.style.background = p > 0.9 ? "#ff5c5c" : p > 0.7 ? "#ffd166" : "#5fd0a8";
}
function updateMeters() {
  tracks.forEach((t) => {
    if (!t.meterEl) return;
    if (!t._mh) t._mh = { v: 0 };
    if (!playing) t._mh.v = 0;
    paintMeter(t.meterEl, playing ? meterDisplay(peakOf(t.meter), t._mh) : 0);
  });
  if (!playing) masterHold.v = 0;
  paintMeter($("#master-meter > i"), playing ? meterDisplay(peakOf(masterMeter), masterHold) : 0);
}
// spread harmony takes across the stereo field (lead centred) so they don't pile up
function spreadVocals() {
  const harm = tracks.filter((t) => t.meta.role === "harmony");
  harm.forEach((t, i) => {
    const pos = harm.length <= 1 ? 0 : (i / (harm.length - 1)) * 2 - 1;
    t.pan = +(pos * 0.6).toFixed(2);
    if (t.panner) t.panner.pan.value = t.pan; if (t.panEl) t.panEl.value = t.pan;
  });
  tracks.filter((t) => t.meta.role === "lead").forEach((t) => { t.pan = 0; if (t.panner) t.panner.pan.value = 0; if (t.panEl) t.panEl.value = 0; });
}
function autoBlend() {
  const pre = snapshot();
  blend.space = 0.32; blend.glue = 0.42; blend.air = 3.5; applyBlend(); syncBlendUI();
  spreadVocals();
  layout(); if (selectedTrack()) syncSmart(); pushUndo(pre); if (playing) play(playFrom);
  log("dj", "blended the vocals: one shared space, glue compression, a touch of air, harmonies spread across the field.");
}
function syncBlendUI() {
  const set = (id, v, lbl) => { const el = $(id); if (el) { el.value = v; const vv = $(id + "-v"); if (vv) vv.textContent = lbl; } };
  set("#bl-space", blend.space, Math.round(blend.space * 100) + "%");
  set("#bl-glue", blend.glue, Math.round(blend.glue * 100) + "%");
  set("#bl-air", blend.air, (blend.air > 0 ? "+" : "") + blend.air.toFixed(1));
}
function applyMasterFx() {
  if (mEqLow) mEqLow.gain.value = masterFx.low;
  if (mEqHigh) mEqHigh.gain.value = masterFx.high;
  if (mComp) setComp(mComp, masterFx.comp);
  if (mLim) setLimiter(mLim, masterFx.limit);
}
function syncMasterFxUI() {
  const set = (id, v, lbl) => { const el = $(id); if (el) { el.value = v; const vv = $(id + "-v"); if (vv) vv.textContent = lbl; } };
  set("#m-low", masterFx.low, (masterFx.low > 0 ? "+" : "") + masterFx.low);
  set("#m-high", masterFx.high, (masterFx.high > 0 ? "+" : "") + masterFx.high);
  set("#m-comp", masterFx.comp, Math.round(masterFx.comp * 100) + "%");
  const lb = $("#m-limit"); if (lb) lb.classList.toggle("on", masterFx.limit);
}
// live-graph parameter smoothing (only the running ctx graph; the offline export graph keeps direct writes).
// continuous slider writes glide via setTargetAtTime to kill zipper noise; discrete gate changes (mute/solo)
// use a short linear ramp so the level change doesn't click. Guarded so a not-yet-running ctx never throws.
const ctxLive = () => !!ctx && ctx.state === "running";
function liveSet(param, target) {
  if (!param) return;
  if (!ctxLive()) { param.value = target; return; }
  param.setTargetAtTime(target, ctx.currentTime, 0.01);
}
function liveRamp(param, target) {
  if (!param) return;
  if (!ctxLive()) { param.value = target; return; }
  const now = ctx.currentTime;
  param.cancelScheduledValues(now); param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + 0.008);
}
const anySolo = () => tracks.some((t) => t.solo);
function effGain(t) { return t.muted ? 0 : (anySolo() && !t.solo ? 0 : t.volume); }
function applyGain(t, ramp) { if (t.gain) (ramp ? liveRamp : liveSet)(t.gain.gain, effGain(t)); }
function refreshGains() { tracks.forEach((t) => applyGain(t, true)); }
// during playback a scheduled volume ramp would override a fresh mute/solo gate, so re-run the
// gated automation from the current position for tracks that carry a volume curve.
function reapplyAutomationGates() {
  if (!playing || !ctxLive()) return;
  const now = ctx.currentTime, pos = playFrom + (now - startedAt);
  tracks.forEach((t) => { if (t.automation && t.automation.volume && t.automation.volume.length) scheduleAutomation(t, t, pos, now); });
}

// ---- metronome / count-in --------------------------------------------------

function clickAt(when, accent) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine"; o.frequency.value = accent ? 1600 : 1000;
  o.connect(g).connect(master);
  g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.32, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.start(when); o.stop(when + 0.06); return o;
}
function scheduleMetronome(t0, from) {
  if (!metroOn) return;
  metroBeats(from).forEach(({ t, accent }) => sources.push(clickAt(t0 + (t - from), accent)));
}

// ---- seamless loop scheduler -----------------------------------------------
// The active loop window, or null. Cycle region wins over whole-song loop.
function loopWindow() {
  if (cycleOn && cycle && cycle.end - cycle.start > 0.05) return { start: cycle.start, end: cycle.end };
  if (looping && duration > 0.05) return { start: 0, end: duration };
  return null;
}
// clip a region to [winStart, winEnd) in timeline seconds; returns a shallow clone or null
function clipRegionToWindow(r, winStart, winEnd) {
  const rEnd = r.start + r.length;
  const s = Math.max(r.start, winStart), e = Math.min(rEnd, winEnd);
  if (e - s <= 0) return null;
  const cut = s - r.start;                       // seconds trimmed off the front
  return { ...r, start: s, offset: r.offset + cut, length: e - s,
           fadeIn: Math.max(0, r.fadeIn - cut), fadeOut: r.fadeOut };
}
// schedule an instrument's notes for one cycle, clipped to [fromPos, winEnd)
function scheduleNotesWindow(actx, t, eqIn, cycleT0, fromPos, winEnd) {
  const out = [], tr = t.transpose || 0;
  const src = (t.arp && t.arp.on) ? arpExpand(t.notes, 60 / (tempo || 100), t.arp.rate, t.arp.mode) : t.notes;
  for (const n of src) {
    if (n.start >= winEnd) continue;
    const rel = n.start - fromPos;
    let when, dur;
    if (rel >= 0) { when = cycleT0 + rel; dur = n.dur; }
    else if (-rel < n.dur) { when = cycleT0; dur = n.dur + rel; }
    else continue;
    const maxDur = winEnd - Math.max(n.start, fromPos);   // clip the tail to the loop end
    if (maxDur <= 0) continue;
    dur = Math.min(dur, maxDur);
    out.push(...playVoice(actx, eqIn, t.instrument, n.pitch + tr, when, dur, n.vel, t.sampleBuffer));
  }
  return out;
}
// schedule every track's audio/notes for one loop cycle beginning at cycleT0.
// clipStart is the timeline position that maps to cycleT0 (playFrom for the first
// pass, winStart for every full pass after it); winEnd bounds the window.
function scheduleCycleMaterial(cycleT0, clipStart, winEnd) {
  const prune = (s) => { s.onended = () => { const i = sources.indexOf(s); if (i !== -1) sources.splice(i, 1); }; };
  tracks.forEach((t) => {
    if (t.kind === "instrument") { const v = scheduleNotesWindow(ctx, t, t.eqLow, cycleT0, clipStart, winEnd); v.forEach(prune); sources.push(...v); return; }
    if (!t.buffer) return;
    for (const r of t.regions) {
      const c = clipRegionToWindow(r, clipStart, winEnd);
      if (!c) continue;
      const s = scheduleRegion(ctx, regionBuffer(t, r), c, t.eqLow, cycleT0, clipStart);
      if (s) { prune(s); sources.push(s); }
    }
  });
}
// schedule metronome clicks that fall inside [fromPos, winEnd) for one cycle
function scheduleMetronomeWindow(cycleT0, fromPos, winEnd) {
  if (!metroOn) return;
  metroBeats(0).forEach(({ t, accent }) => {
    if (t >= fromPos - 1e-6 && t < winEnd - 1e-6) {
      const o = clickAt(cycleT0 + (t - fromPos), accent);
      o.onended = () => { const i = sources.indexOf(o); if (i !== -1) sources.splice(i, 1); };
      sources.push(o);
    }
  });
}
// pre-roll enough future cycles to cover the lookahead horizon on the audio clock
function loopPumpTick() {
  if (!loopState || !playing || !ctx) return;
  const horizon = ctx.currentTime + LOOP_LOOKAHEAD;
  let guard = 0;
  while (loopState.nextT < horizon && guard++ < 64) {
    const cT = loopState.nextT;
    scheduleCycleMaterial(cT, loopState.winStart, loopState.winEnd);
    scheduleMetronomeWindow(cT, loopState.winStart, loopState.winEnd);
    loopState.nextT += loopState.len;
  }
}

// schedule every track's audio/notes + metronome for a single pass from playFrom to
// duration (the exact original playback path; used for non-loop and whole-song-loop)
function scheduleFullPass(t0) {
  tracks.forEach((t) => {
    if (t.kind === "instrument") { sources.push(...scheduleNotes(ctx, t, t.eqLow, t0, playFrom)); return; }
    if (!t.buffer) return;
    sources.push(...scheduleTrack(ctx, t, t.eqLow, t0, playFrom));
  });
  scheduleMetronome(t0, playFrom);
}

// ---- transport -------------------------------------------------------------

function play(from) {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  stopSources();                            // also cancels any lookahead pump + loop state
  playFrom = from != null ? from : playFrom;
  const win = loopWindow();
  // GB behavior: starting outside the loop window jumps to the window start
  if (win && (playFrom < win.start || playFrom >= win.end - 1e-6)) playFrom = win.start;
  const t0 = ctx.currentTime + 0.06;
  sources = [];
  // wire + gate + automation curves once for the first pass (unchanged for non-loop playback)
  tracks.forEach((t) => { wireTrack(t); applyGain(t); scheduleAutomation(t, t, playFrom, t0); });
  if (win) {
    // seamless loop: schedule the first pass, then pre-roll future cycles on the audio clock.
    // A whole-song loop schedules its first pass exactly as normal playback (no clipping);
    // a sub-region cycle clips the first pass to the cycle end.
    if (win.start <= 1e-6 && win.end >= duration - 1e-6) scheduleFullPass(t0);
    else { scheduleCycleMaterial(t0, playFrom, win.end); scheduleMetronomeWindow(t0, playFrom, win.end); }
    loopState = { winStart: win.start, winEnd: win.end, len: win.end - win.start, nextT: t0 + (win.end - playFrom) };
    loopPumpTick();                         // fill the first lookahead horizon immediately
    loopPump = setInterval(loopPumpTick, 25);
  } else {
    scheduleFullPass(t0);                    // single pass to duration (exact original behavior)
  }
  startedAt = t0; playing = true;
  $("#play").classList.add("playing"); $("#play").textContent = "■";
  tick();
}
let lastPlayheadPos = 0;
function stop() {
  // second Stop (already stopped, playhead still at playFrom) returns to zero
  const atPlayFrom = !playing && Math.abs(lastPlayheadPos - playFrom) < 1e-6;
  stopSources(); playing = false; cancelAnimationFrame(raf);
  $("#play").classList.remove("playing"); $("#play").textContent = "▶";
  if (atPlayFrom) { playFrom = 0; movePlayhead(0); }
  else movePlayhead(playFrom);
  updateMeters();
}
function stopSources() {
  sources.forEach((s) => { try { s.stop(); } catch (e) {} });
  sources = [];
  if (loopPump) { clearInterval(loopPump); loopPump = 0; }   // cancel the lookahead pump
  loopState = null;
}
function tick() {
  const pos = playFrom + (ctx.currentTime - startedAt);
  if (loopState) {
    // audio for every pass is already pre-scheduled; only wrap the visual playhead
    const { winStart, winEnd, len } = loopState;
    const vis = pos >= winEnd ? winStart + ((pos - winStart) % len) : pos;
    movePlayhead(vis);
    updateMeters();
    const pane = $("#tracks-pane"), phx = LANE_X + vis * pxPerSec;
    if (phx < pane.scrollLeft + LANE_X || phx > pane.scrollLeft + pane.clientWidth - 30) pane.scrollLeft = phx - pane.clientWidth / 2;
    raf = requestAnimationFrame(tick);
    return;
  }
  if (pos >= duration) { stop(); playFrom = 0; movePlayhead(0); return; }
  movePlayhead(pos);
  updateMeters();
  const pane = $("#tracks-pane"), phx = LANE_X + pos * pxPerSec;   // keep playhead in view when zoomed
  if (phx < pane.scrollLeft + LANE_X || phx > pane.scrollLeft + pane.clientWidth - 30) pane.scrollLeft = phx - pane.clientWidth / 2;
  raf = requestAnimationFrame(tick);
}
function movePlayhead(pos) {
  lastPlayheadPos = pos;
  $("#playhead").style.left = (LANE_X + Math.max(0, pos) * pxPerSec) + "px";
  if (pianoTrack) $("#piano-playhead").style.left = (Math.max(0, pos) * pxPerSec) + "px";
}
function seekFromEvent(e) {
  if (recording) return;                 // don't move the transport while capturing a take
  if (e.shiftKey || cycleDrag) return;   // shift-drag sets the cycle region instead of seeking
  const r = $("#ruler-inner").getBoundingClientRect();
  const x = e.clientX - r.left;
  if (x < 0) return;
  if (setDownbeatMode) {   // "the 1 is here" — set the grid downbeat instead of seeking
    downbeatAt = Math.max(0, x / pxPerSec); setDownbeatMode = false;
    $("#ruler").classList.remove("armed");
    $("#al-phase").textContent = downbeatAt.toFixed(2) + "s";
    $("#align").classList.remove("hidden");   // reopen the panel, keeping the in-progress selections
    drawRuler(); log("dj", `downbeat set at ${downbeatAt.toFixed(2)}s — re-align to snap to it.`);
    return;
  }
  playFrom = Math.max(0, Math.min(duration, x / pxPerSec));
  movePlayhead(playFrom);
  if (playing) play(playFrom);
}

// ---- track UI --------------------------------------------------------------

function renderTrackHeads() {
  const host = $("#rows"); host.innerHTML = "";
  tracks.forEach((t) => {
    const color = trackColor(t);
    const isLead = t.meta.role === "lead";
    const isInst = t.kind === "instrument";
    const el = document.createElement("div"); el.className = "track";
    const rstart = t.regions && t.regions[t.selRegion || 0] ? Math.round(t.regions[t.selRegion || 0].start * 1000) + " ms" : "0 ms";
    const nTakes = t.takes ? t.takes.length : 1;
    const takeBtn = nTakes > 1
      ? `<button class="rop takecyc" title="comp: switch this region's take">T${(selectedRegion(t) ? (selectedRegion(t).take || 0) : 0) + 1}/${nTakes}</button>`
      : `<button class="rop addtake" title="comp: add your other takes as alternates">⊕T</button>`;
    const lastRow = isInst
      ? '<div class="nudge"><button class="edit-inst" title="edit notes">⣿ piano roll</button><button class="rop bounce" title="flatten to an audio track">⤓</button></div>'
      : `<div class="nudge" title="nudge selected region"><button class="nl">‹</button><span class="val">${rstart}</span><button class="nr">›</button><button class="rop split" title="split at playhead">✂</button><button class="rop dup" title="duplicate region">⧉</button><button class="rop rep" title="loop-repeat region">⟳</button>${takeBtn}</div>`;
    el.innerHTML = `
      <div class="track-head">
        <div class="track-title"><span class="drag-handle" draggable="true" title="drag to reorder">⋮⋮</span><span class="dot${isInst ? " dot-btn" : ""}" style="background:${color}"${isInst ? ' title="click to recolor"' : ""}></span>
          <span class="tname"${isInst ? ' title="double-click to rename"' : ""}>${t.meta.name}</span><span class="role">${t.meta.role}</span>
          ${isInst ? "" : `<button class="lead-star ${isLead ? "is-lead" : ""}" title="set as lead">★</button>`}
          ${isInst || t.clientAudio || t.meta.role === "lead" || t.meta.role === "harmony" ? '<button class="track-x" title="remove track">×</button>' : ""}</div>
        <div class="controls">
          <input class="vol" type="range" min="0" max="1.5" step="0.01" value="${t.volume}" title="volume">
          <span class="mini vdb">${dbLabel(t.volume)}</span>
          <input class="pan" type="range" min="-1" max="1" step="0.02" value="${t.pan}" title="pan">
          <div class="btnrow">
            <button class="sm mute ${t.muted ? "on-m" : ""}">M</button>
            <button class="sm solo ${t.solo ? "on-s" : ""}">S</button>
            <button class="sm autobtn ${t.autoParam ? "on-a" : ""}" title="automation lane">${t.autoParam ? "A:" + t.autoParam[0] : "A"}</button>
            <button class="sm armbtn ${t.armed ? "on-r" : ""}" title="arm for recording">R</button>
          </div>
          <span class="meter"><i></i></span>
        </div>
        ${lastRow}
      </div>
      <div class="lane"><canvas></canvas></div>`;
    host.appendChild(el);
    if (t.meta.file === selectedFile) el.classList.add("selected");
    const q = (s) => el.querySelector(s);
    t.volEl = q(".vol"); t.panEl = q(".pan"); t.vdbEl = q(".vdb"); t.valEl = q(".val");
    t.muteEl = q(".mute"); t.soloEl = q(".solo"); t.meterEl = q(".meter > i");
    t.volEl.addEventListener("pointerdown", beginEdit);
    t.volEl.oninput = (e) => { t.volume = +e.target.value; applyGain(t); t.vdbEl.textContent = dbLabel(t.volume); if (t.meta.file === selectedFile) syncSmart(); };
    t.volEl.onchange = commitEdit;
    t.panEl.addEventListener("pointerdown", beginEdit);
    t.panEl.oninput = (e) => { t.pan = +e.target.value; if (t.panner) liveSet(t.panner.pan, t.pan); if (t.meta.file === selectedFile) syncSmart(); };
    t.panEl.onchange = commitEdit;
    t.muteEl.onclick = (e) => { const p = snapshot(); t.muted = !t.muted; e.target.classList.toggle("on-m", t.muted); refreshGains(); reapplyAutomationGates(); pushUndo(p); };
    t.soloEl.onclick = (e) => { const p = snapshot(); t.solo = !t.solo; e.target.classList.toggle("on-s", t.solo); refreshGains(); reapplyAutomationGates(); pushUndo(p); };
    if (isInst) {
      const dotEl = q(".dot"); dotEl.onclick = (e) => {
        e.stopPropagation(); const pre = snapshot();
        const cur = t.color ? COLOR_PALETTE.indexOf(t.color) : 0;   // first click leaves the default shade
        t.color = COLOR_PALETTE[(cur + 1) % COLOR_PALETTE.length];
        dotEl.style.background = t.color; drawTrack(t); if (pianoTrack === t) drawPiano(); pushUndo(pre);
      };
      const nameEl = q(".tname"); nameEl.ondblclick = (e) => {
        e.stopPropagation(); nameEl.contentEditable = "true"; nameEl.focus();
        try { const rng = document.createRange(); rng.selectNodeContents(nameEl); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rng); } catch (err) {}
        let done = false;
        const finish = (commit) => {
          if (done) return; done = true; nameEl.onblur = null; nameEl.contentEditable = "false";
          const v = nameEl.textContent.trim().slice(0, 40);
          if (commit && v && v !== t.meta.name) { const pre = snapshot(); t.meta.name = v; if (pianoTrack === t) $("#piano-name").textContent = v; syncSmart(); pushUndo(pre); }
          else nameEl.textContent = t.meta.name;
        };
        nameEl.onblur = () => finish(true);
        nameEl.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); finish(true); } else if (ev.key === "Escape") { finish(false); } };
      };
    }
    const star = q(".lead-star"); if (star) star.onclick = () => setLead(t);
    const xb = q(".track-x"); if (xb) xb.onclick = () => (t.kind === "instrument" ? removeInstrument(t) : t.clientAudio ? removeAudioTrack(t) : removeTake(t));
    const AUTO_CYCLE = [null, "volume", "pan", "send"];
    q(".autobtn").onclick = (e) => { const pre = snapshot(); t.autoParam = AUTO_CYCLE[(AUTO_CYCLE.indexOf(t.autoParam) + 1) % 4]; e.target.textContent = t.autoParam ? "A:" + t.autoParam[0] : "A"; e.target.classList.toggle("on-a", !!t.autoParam); drawTrack(t); pushUndo(pre); };
    q(".armbtn").onclick = () => armTrack(t);
    q(".track-head").addEventListener("mousedown", (e) => { if (!e.target.closest("input,button,.drag-handle")) selectTrack(t); });
    const dh = q(".drag-handle");
    dh.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/track", t.meta.file); e.dataTransfer.effectAllowed = "move"; });
    const head = q(".track-head");
    head.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/track")) { e.preventDefault(); head.classList.add("drop-target"); } });
    head.addEventListener("dragleave", () => head.classList.remove("drop-target"));
    head.addEventListener("drop", (e) => { const f = e.dataTransfer.getData("text/track"); if (f) { e.preventDefault(); e.stopPropagation(); head.classList.remove("drop-target"); reorderTracks(f, t.meta.file); } });
    t.canvas = q("canvas");
    q(".lane").addEventListener("mousedown", (e) => {
      selectTrack(t);
      if (t.autoParam) { autoMouseDown(e, t); return; }         // edit automation points
      if (isInst) { openPiano(t); return; }
      startDrag(e, t);
    });
    q(".lane").addEventListener("contextmenu", (e) => e.preventDefault());
    if (!isInst) q(".lane").addEventListener("mousemove", (e) => { if (!t.autoParam) hoverCursor(e, t); });
    if (isInst) { q(".edit-inst").onclick = () => { selectTrack(t); openPiano(t); }; q(".bounce").onclick = () => { selectTrack(t); bounceInstrument(t); }; drawInstLane(t); }
    else {
      q(".nl").onclick = () => { selectTrack(t); nudge(t, -10, q(".val")); };
      q(".nr").onclick = () => { selectTrack(t); nudge(t, +10, q(".val")); };
      q(".split").onclick = () => { selectTrack(t); splitAtPlayhead(t); };
      q(".dup").onclick = () => { selectTrack(t); dupRegion(t); };
      const at = q(".addtake"); if (at) at.onclick = () => { selectTrack(t); addSiblingTakes(t); };
      const tc = q(".takecyc"); if (tc) tc.onclick = () => { selectTrack(t); cycleTake(t); };
      q(".rep").onclick = () => { selectTrack(t); repeatRegion(t); };
      if (t.buffer) drawWave(t);
    }
  });
  const sel = tracks.find((t) => t.meta.file === selectedFile) || tracks[0];
  if (sel) selectTrack(sel);
}

// ---- undo / redo (client mixer + region edits) -----------------------------

let history = [], future = [], editPre = null;
const EDITABLE = ["volume", "pan", "muted", "solo", "eqLowDb", "eqMidDb", "eqHighDb",
  "reverbSend", "compAmt", "driveAmt", "crush", "modRate", "modDepth", "modFb", "delayTime", "delayFb", "delayMix"];

function snapshot() {
  return {
    master: masterOut ? masterOut.gain.value : +$("#master").value, selectedFile,
    masterFx: { ...masterFx }, blend: { ...blend }, markers: markers.map((m) => ({ ...m })), cycle: cycle ? { ...cycle } : null, cycleOn,
    tempoMap: tempoMap.map((p) => ({ ...p })), beatsPerBar, beatUnit, tempo, recLatencyMs,
    tracks: tracks.map((t) => {
      const o = { file: t.meta.file }; EDITABLE.forEach((k) => (o[k] = t[k]));
      o.autoParam = t.autoParam; o.selRegion = t.selRegion;
      o.automation = { volume: t.automation.volume.map((p) => ({ ...p })), pan: t.automation.pan.map((p) => ({ ...p })), send: t.automation.send.map((p) => ({ ...p })) };
      if (t.regions) o.regions = t.regions.map((r) => ({ ...r }));
      if (t.takes) o.takeNames = t.takes.map((k) => k.name);   // to rebuild comp lanes on load
      if (t.kind === "instrument") { o.kind = "instrument"; o.instrument = t.instrument; o.name = t.meta.name; o.color = t.color || null; o.transpose = t.transpose || 0; o.arp = t.arp ? { ...t.arp } : null; o.notes = t.notes.map((n) => ({ ...n })); if (t.sampleBuffer) o.sampleBuffer = t.sampleBuffer; }
      if (t.clientAudio) { o.kind = "audio"; o.name = t.meta.name; o.color = t.color || null; }
      return o;
    }),
  };
}
function applyLiveNodes(t) {
  if (!t.gain) return;
  applyGain(t);
  if (t.panner) t.panner.pan.value = t.pan;
  if (t.eqLow) { t.eqLow.gain.value = t.eqLowDb; t.eqMid.gain.value = t.eqMidDb; t.eqHigh.gain.value = t.eqHighDb; }
  if (t.send) t.send.gain.value = t.reverbSend;
  if (t.comp) setComp(t.comp, t.compAmt);
  if (t.shaper) t.shaper.curve = driveCurve(t.driveAmt);
  if (t.crushNode) t.crushNode.curve = crushCurve(t.crush || 0);
  if (t.mNode) { t.mLfo.frequency.value = t.modRate || 3; t.mLfoGain.gain.value = (t.modDepth || 0) * 0.005; t.mFb.gain.value = (t.modDepth ? (t.modFb || 0) : 0); t.mWet.gain.value = (t.modDepth || 0) * 0.7; }
  if (t.dNode) { t.dNode.delayTime.value = Math.max(0.05, t.delayTime); t.dFb.gain.value = Math.min(0.85, t.delayFb); t.dWet.gain.value = t.delayMix; }
}
function applySnapshot(s) {
  if (s.master != null) { $("#master").value = s.master; if (masterOut) masterOut.gain.value = s.master; $("#master-db").textContent = dbLabel(s.master); }
  if (s.masterFx) { Object.assign(masterFx, s.masterFx); applyMasterFx(); syncMasterFxUI(); }
  if (s.blend) { Object.assign(blend, s.blend); applyBlend(); syncBlendUI(); }
  if (s.markers) markers = s.markers.map((m) => ({ ...m }));
  if ("cycle" in s) cycle = s.cycle ? { ...s.cycle } : null;
  if ("cycleOn" in s) { cycleOn = s.cycleOn; const cb = $("#cycle"); if (cb) cb.classList.toggle("on", cycleOn); }
  if ("tempo" in s) { tempo = s.tempo; const b = $("#bpm"); if (b && tempo) b.value = Math.round(tempo); gridTimes = null; }
  if (s.tempoMap) { tempoMap = s.tempoMap.map((p) => ({ ...p })); gridTimes = null; }
  if (s.beatsPerBar) { beatsPerBar = s.beatsPerBar; const el = $("#bpb"); if (el) el.value = beatsPerBar; gridTimes = null; }
  if (s.beatUnit) { beatUnit = s.beatUnit; const el = $("#bunit"); if (el) el.value = beatUnit; gridTimes = null; }
  if ("recLatencyMs" in s && s.recLatencyMs != null) { recLatencyMs = s.recLatencyMs; const el = $("#recoffset"); if (el) el.value = recLatencyMs; }
  const snapFiles = new Set(s.tracks.map((x) => x.file));
  // instrument + bounced-audio tracks are client-only: drop those not in the snapshot, recreate those missing
  tracks = tracks.filter((t) => (t.kind !== "instrument" && !t.clientAudio) || snapFiles.has(t.meta.file));
  s.tracks.forEach((ts) => {
    if (ts.kind === "instrument" && !tracks.find((t) => t.meta.file === ts.file)) {
      const t = makeInstrumentTrack(ts.instrument, ts.name, (ts.notes || []).map((n) => ({ ...n })));
      t.meta.file = ts.file;
      if (ts.sampleBuffer && ts.sampleBuffer.length) t.sampleBuffer = ts.sampleBuffer;   // reattach real buffer before wiring/rendering
      tracks.push(t); if (ctx) wireTrack(t);
    }
    if (ts.kind === "audio" && !tracks.find((t) => t.meta.file === ts.file) && clientBuffers[ts.file]) {
      const t = makeAudioTrack(ts.name, clientBuffers[ts.file], ts.color, ts.file);
      tracks.push(t); if (ctx) wireTrack(t);
    }
  });
  s.tracks.forEach((ts) => {
    const t = tracks.find((x) => x.meta.file === ts.file); if (!t) return;
    EDITABLE.forEach((k) => { if (ts[k] !== undefined) t[k] = ts[k]; });
    if ("autoParam" in ts) t.autoParam = ts.autoParam;
    if ("selRegion" in ts) t.selRegion = ts.selRegion;
    if (ts.automation) t.automation = { volume: (ts.automation.volume || []).map((p) => ({ ...p })), pan: (ts.automation.pan || []).map((p) => ({ ...p })), send: (ts.automation.send || []).map((p) => ({ ...p })) };
    if (ts.regions) { const nt = t.takes ? t.takes.length : 1; t.regions = ts.regions.map((r) => ({ ...r, take: (r.take || 0) < nt ? (r.take || 0) : 0 })); }
    if (t.kind === "instrument" && ts.notes) t.notes = ts.notes.map((n) => ({ ...n }));
    if (t.kind === "instrument" && ts.sampleBuffer && ts.sampleBuffer.length) t.sampleBuffer = ts.sampleBuffer;
    if (t.kind === "instrument" && ts.transpose != null) t.transpose = ts.transpose;
    if (t.kind === "instrument" && ts.name) t.meta.name = ts.name;
    if (t.kind === "instrument" && "color" in ts) t.color = ts.color;
    if (t.clientAudio && ts.name) t.meta.name = ts.name;
    if (t.clientAudio && "color" in ts) t.color = ts.color;
    if (t.kind === "instrument" && ts.arp) t.arp = { ...ts.arp };
  });
  // restore track order from the snapshot (makes reorder undoable)
  const ordered = s.tracks.map((ts) => tracks.find((t) => t.meta.file === ts.file)).filter(Boolean);
  tracks = ordered.concat(tracks.filter((t) => !ordered.includes(t)));
  if (s.selectedFile) selectedFile = s.selectedFile;
  renderTrackHeads();               // track set may have changed
  tracks.forEach(applyLiveNodes);
  refreshGains(); recomputeDuration(); layout();
  const sel = selectedTrack(); if (sel) selectTrack(sel);
  if (pianoTrack) syncPiano();
  if (playing) play(playFrom);
}
function pushUndo(pre) { history.push(pre); if (history.length > 150) history.shift(); future = []; syncUndoBtns(); }
function beginEdit() { if (!editPre) editPre = snapshot(); }
function commitEdit() { if (editPre) { pushUndo(editPre); editPre = null; } }
function undo() { if (!history.length) return; future.push(snapshot()); applySnapshot(history.pop()); syncUndoBtns(); }
function redo() { if (!future.length) return; history.push(snapshot()); applySnapshot(future.pop()); syncUndoBtns(); }
function syncUndoBtns() {
  const u = $("#undo"), r = $("#redo");
  if (u) u.disabled = !history.length;
  if (r) r.disabled = !future.length;
}

// ---- track selection + Smart Controls strip --------------------------------

function selectTrack(t) {
  selectedFile = t.meta.file;
  document.querySelectorAll("#tracks .track").forEach((el, i) => el.classList.toggle("selected", tracks[i] === t));
  syncSmart();
}
function selectedTrack() { return tracks.find((t) => t.meta.file === selectedFile) || null; }

const panLabel = (p) => Math.abs(p) < 0.05 ? "C" : (p < 0 ? "L" + Math.round(-p * 100) : "R" + Math.round(p * 100));

function syncSmart() {
  const t = selectedTrack();
  const s = $("#smart");
  if (!t) { s.classList.add("disabled"); $("#smart-track").textContent = "—"; return; }
  s.classList.remove("disabled");
  $("#smart-track").textContent = `${t.meta.name} · ${t.meta.role}`;
  const set = (id, v, label) => { $(id).value = v; $(id + "-v").textContent = label; };
  set("#eq-low", t.eqLowDb, (t.eqLowDb > 0 ? "+" : "") + t.eqLowDb);
  set("#eq-mid", t.eqMidDb, (t.eqMidDb > 0 ? "+" : "") + t.eqMidDb);
  set("#eq-high", t.eqHighDb, (t.eqHighDb > 0 ? "+" : "") + t.eqHighDb);
  set("#rv-send", t.reverbSend, Math.round(t.reverbSend * 100) + "%");
  set("#fx-comp", t.compAmt, Math.round(t.compAmt * 100) + "%");
  set("#fx-drive", t.driveAmt, Math.round(t.driveAmt * 100) + "%");
  set("#fx-crush", t.crush, Math.round(t.crush * 100) + "%");
  set("#mod-rate", t.modRate, t.modRate.toFixed(1));
  set("#mod-depth", t.modDepth, Math.round(t.modDepth * 100) + "%");
  set("#mod-fb", t.modFb, Math.round(t.modFb * 100) + "%");
  set("#dl-time", t.delayTime, Math.round(t.delayTime * 1000));
  set("#dl-fb", t.delayFb, Math.round(t.delayFb * 100) + "%");
  set("#dl-mix", t.delayMix, Math.round(t.delayMix * 100) + "%");
  set("#sc-vol", t.volume, dbLabel(t.volume));
  set("#sc-pan", t.pan, panLabel(t.pan));
}
const dbLabel = (v) => v <= 0.001 ? "−∞" : (20 * Math.log10(v) >= 0 ? "+" : "") + (20 * Math.log10(v)).toFixed(1) + " dB";
const nudgeLabel = (ms) => (ms === 0 ? "0 ms" : (ms > 0 ? "+" : "") + ms + " ms");

function nudge(t, deltaMs, valEl) {
  const r = selectedRegion(t); if (!r) return;
  const pre = snapshot();
  r.start = Math.max(0, r.start + deltaMs / 1000);
  valEl.textContent = Math.round(r.start * 1000) + " ms";
  recomputeDuration(); layout();
  if (playing) play(playFrom);
  pushUndo(pre);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function splitAtPlayhead(t) {
  if (!t.buffer) return;
  let pos = playFrom; if (snapOn) pos = snapTime(pos);
  const idx = t.regions.findIndex((r) => pos > r.start + 0.02 && pos < r.start + r.length - 0.02);
  if (idx < 0) { log("dj", "move the playhead over a region (click the ruler), then split."); return; }
  const pre = snapshot();
  const r = t.regions[idx], left = pos - r.start;
  const r2 = { start: pos, offset: r.offset + left, length: r.length - left, fadeIn: 0, fadeOut: r.fadeOut, take: r.take || 0, gain: r.gain == null ? 1 : r.gain };
  r.length = left; r.fadeOut = 0;
  t.regions.splice(idx + 1, 0, r2); t.selRegion = idx + 1;
  recomputeDuration(); layout(); pushUndo(pre); if (playing) play(playFrom);
}

function dupRegion(t) {
  if (!t.buffer || !t.regions.length) return;
  const r = selectedRegion(t); if (!r) return;
  const pre = snapshot();
  t.regions.push({ start: r.start + r.length, offset: r.offset, length: r.length, fadeIn: r.fadeIn, fadeOut: r.fadeOut, take: r.take || 0, gain: r.gain == null ? 1 : r.gain });
  t.selRegion = t.regions.length - 1;
  recomputeDuration(); layout(); pushUndo(pre); if (playing) play(playFrom);
}

// loop-repeat: tile the selected region back-to-back up to the next region (or 4x)
function repeatRegion(t) {
  if (!t.buffer || !t.regions.length) return;
  const r = selectedRegion(t); if (!r || r.length <= 0) return;
  const pre = snapshot();
  const laters = t.regions.filter((x) => x !== r && x.start > r.start + 1e-3).map((x) => x.start);
  let limit = laters.length ? Math.min(...laters) : r.start + r.length * 4;
  if (limit <= r.start + r.length + 0.01) limit = r.start + r.length * 4;   // no gap after it → tile 3 more anyway
  let pos = r.start + r.length, n = 0;
  while (pos + 0.01 < limit && n < 32) { t.regions.push({ start: pos, offset: r.offset, length: r.length, fadeIn: 0, fadeOut: 0, take: r.take || 0, gain: r.gain == null ? 1 : r.gain }); pos += r.length; n++; }
  recomputeDuration(); layout(); pushUndo(pre); if (playing) play(playFrom);
  log("dj", `repeated the region ${n}×.`);
}

// comp: pull the other vocal takes onto this track as alternate lanes.
// then split the region and switch each piece's take to swipe-comp the best bits.
function addSiblingTakes(t) {
  if (!t.buffer) return;
  const have = new Set((t.takes || []).map((k) => k.name));
  const adds = tracks.filter((x) => x !== t && x.buffer && (x.meta.role === "lead" || x.meta.role === "harmony") && !have.has(x.meta.name));
  if (!adds.length) { log("dj", "no other vocal takes to comp from — record or import more first."); return; }
  const pre = snapshot();
  adds.forEach((x) => t.takes.push({ name: x.meta.name, buffer: x.takes && x.takes[0] ? x.takes[0].buffer : x.buffer }));
  renderTrackHeads(); selectTrack(t); pushUndo(pre);
  log("dj", `added ${adds.length} alternate take${adds.length > 1 ? "s" : ""} to “${t.meta.name}”. split a region (✂), then tap T to choose the best take per section.`);
}
function cycleTake(t) {
  const r = selectedRegion(t); if (!r || !t.takes || t.takes.length < 2) return;
  const pre = snapshot();
  r.take = ((r.take || 0) + 1) % t.takes.length;
  // keep the region inside the chosen take's length
  const bl = regionBuffer(t, r).duration; if (r.offset + r.length > bl) r.length = Math.max(0.05, bl - r.offset);
  renderTrackHeads(); selectTrack(t); recomputeDuration(); layout(); pushUndo(pre); if (playing) play(playFrom);
}

// region clipboard + delete + track reorder
let regionClip = null;
function copyRegion(t) {
  const r = selectedRegion(t); if (!t.buffer || !r) return;
  regionClip = { buffer: regionBuffer(t, r), offset: r.offset, length: r.length, fadeIn: r.fadeIn, fadeOut: r.fadeOut, gain: r.gain == null ? 1 : r.gain };
  log("dj", "region copied — paste with ⌘V at the playhead.");
}
function cutRegion(t) { copyRegion(t); deleteRegion(t); }
function pasteRegion(t) {
  if (!regionClip || !t.buffer) return;
  let idx = (t.takes || []).findIndex((k) => k.buffer === regionClip.buffer);
  const pre = snapshot();
  if (idx < 0) { t.takes.push({ name: "pasted", buffer: regionClip.buffer }); idx = t.takes.length - 1; }
  let at = playFrom; if (snapOn) at = snapTime(at);
  t.regions.push({ start: Math.max(0, at), offset: regionClip.offset, length: regionClip.length, fadeIn: regionClip.fadeIn, fadeOut: regionClip.fadeOut, take: idx, gain: regionClip.gain == null ? 1 : regionClip.gain });
  t.selRegion = t.regions.length - 1;
  renderTrackHeads(); recomputeDuration(); layout(); selectTrack(t); pushUndo(pre); if (playing) play(playFrom);
}
function deleteRegion(t) {
  if (!t.buffer || !t.regions.length) return;
  const idx = t.selRegion || 0, pre = snapshot();
  t.regions.splice(idx, 1); t.selRegion = Math.max(0, Math.min(idx, t.regions.length - 1));
  renderTrackHeads(); recomputeDuration(); layout(); selectTrack(t); pushUndo(pre); if (playing) play(playFrom);
}
function reorderTracks(fromFile, toFile) {
  const from = tracks.findIndex((t) => t.meta.file === fromFile), to = tracks.findIndex((t) => t.meta.file === toFile);
  if (from < 0 || to < 0 || from === to) return;
  const pre = snapshot();
  const [m] = tracks.splice(from, 1); tracks.splice(to, 0, m);
  renderTrackHeads(); layout(); const sel = selectedTrack(); if (sel) selectTrack(sel); pushUndo(pre);
}

// which region (and zone) is under the pointer x within a lane
function regionHit(t, x, y, h) {
  const EDGE = 7;
  for (let i = t.regions.length - 1; i >= 0; i--) {
    const r = t.regions[i], offX = r.start * pxPerSec, span = r.length * pxPerSec, rel = x - offX;
    if (rel < -EDGE || rel > span + EDGE) continue;
    let mode = "move";
    if (y < 16 && rel >= 0 && rel <= Math.max(16, r.fadeIn * pxPerSec + 10)) mode = "fadeIn";
    else if (y < 16 && rel <= span && rel >= span - Math.max(16, r.fadeOut * pxPerSec + 10)) mode = "fadeOut";
    else if (rel >= -EDGE && rel <= EDGE) mode = "trimL";
    else if (rel >= span - EDGE && rel <= span + EDGE) mode = "trimR";
    return { r, i, mode };
  }
  return null;
}

function hoverCursor(e, t) {
  if (drag || !t.buffer) return;
  const rect = t.canvas.getBoundingClientRect();
  const hit = regionHit(t, e.clientX - rect.left, e.clientY - rect.top, t.canvas.clientHeight || 86);
  e.currentTarget.style.cursor = !hit ? "default" : hit.mode === "move" ? "grab" : hit.mode.startsWith("fade") ? "crosshair" : "ew-resize";
}

function startDrag(e, t) {
  if (!t.buffer) return;
  e.preventDefault();
  const rect = t.canvas.getBoundingClientRect();
  const hit = regionHit(t, e.clientX - rect.left, e.clientY - rect.top, t.canvas.clientHeight || 86);
  if (!hit) return;
  t.selRegion = hit.i;
  const r = hit.r;
  const mode = e.altKey ? "gain" : hit.mode;   // alt-drag = region gain
  drag = { t, r, mode, startX: e.clientX, startY: e.clientY, moved: false, pre: snapshot(),
    startStart: r.start, startOffset: r.offset, startLength: r.length, startFadeIn: r.fadeIn, startFadeOut: r.fadeOut, startGain: r.gain == null ? 1 : r.gain };
  document.body.style.cursor = mode === "gain" ? "ns-resize" : mode === "move" ? "grabbing" : (mode.startsWith("fade") ? "crosshair" : "ew-resize");
  drawWave(t);
}

function onDrag(e) {
  if (!drag) return;
  const t = drag.t, r = drag.r, dSec = (e.clientX - drag.startX) / pxPerSec;
  if (Math.abs(e.clientX - drag.startX) > 2) drag.moved = true;
  if (drag.mode === "move") {
    let s = drag.startStart + dSec;
    if (snapOn) s = snapTime(s);
    else if (Math.abs(s) < 0.015) s = 0;
    r.start = Math.max(0, s);
    if (t.valEl) t.valEl.textContent = Math.round(r.start * 1000) + " ms";
  } else if (drag.mode === "trimL") {
    // clamp the applied delta so neither r.start nor the take offset crosses 0, and length stays >= 0.05,
    // then derive offset/start/length from that single value (no independent clamps -> no desync at t=0)
    const loApplied = Math.max(-drag.startStart, -drag.startOffset);
    const hiApplied = drag.startLength - 0.05;
    let applied = clamp(dSec, loApplied, hiApplied);
    if (snapOn) applied = clamp(snapTime(drag.startStart + applied) - drag.startStart, loApplied, hiApplied);
    r.offset = drag.startOffset + applied; r.start = drag.startStart + applied; r.length = drag.startLength - applied;
  } else if (drag.mode === "trimR") {
    let len = drag.startLength + dSec;
    if (snapOn) len = snapTime(r.start + drag.startLength + dSec) - r.start;   // snap the region end, keep start fixed
    r.length = clamp(len, 0.05, regionBuffer(t, r).duration - r.offset);
  } else if (drag.mode === "fadeIn") {
    r.fadeIn = clamp(drag.startFadeIn + dSec, 0, r.length - r.fadeOut);   // fadeIn + fadeOut <= length
  } else if (drag.mode === "fadeOut") {
    r.fadeOut = clamp(drag.startFadeOut - dSec, 0, r.length - r.fadeIn);
  } else if (drag.mode === "gain") {
    r.gain = clamp(drag.startGain + (drag.startY - e.clientY) / 120, 0, 2);
    if (Math.abs(e.clientX - drag.startX) > 2 || Math.abs(e.clientY - drag.startY) > 2) drag.moved = true;
  }
  drawWave(t);
}

function endDrag() {
  if (!drag) return;
  const moved = drag.moved, pre = drag.pre; drag = null;
  document.body.style.cursor = "";
  if (!moved) return;                             // a plain click shouldn't disturb playback
  recomputeDuration(); layout();
  if (playing) play(playFrom);
  pushUndo(pre);
}

async function removeTake(t) {
  const vocals = tracks.filter((x) => x.meta.role === "lead" || x.meta.role === "harmony");
  if (vocals.length <= 2) { log("dj", "can't remove — a session needs at least two takes."); return; }
  status("removing take…", true);
  try {
    const res = await api(`/api/session/${session.id}/remove_take?track=${encodeURIComponent(t.meta.name)}`);
    stop(); await applyProject(res.project);
    log("dj", `removed “${t.meta.name}”.`);
  } catch (e) { log("dj", "couldn't remove: " + e.message); }
  finally { status(""); }
}

async function setLead(t) {
  if (t.meta.role === "lead") return;
  status("re-balancing around new lead…", true);
  try {
    const res = await api(`/api/session/${session.id}/lead?track=${encodeURIComponent(t.meta.name)}`);
    stop(); await applyProject(res.project);
  } catch (e) { log("dj", "couldn't set lead: " + e.message); }
  finally { status(""); }
}

function drawWave(t) {
  const c = t.canvas; if (!c || !t.buffer) return;
  const dpr = window.devicePixelRatio || 1;
  const w = contentW(), h = c.clientHeight || 86;
  c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);

  // tempo grid behind everything
  g.strokeStyle = "#2b303b";
  gridLines().lines.forEach(({ t: tt, major }) => { const x = tt * pxPerSec; g.globalAlpha = major ? 0.5 : 0.22; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); });

  // each region: block + trimmed waveform + fades
  const color = trackColor(t);
  const multi = t.takes && t.takes.length > 1;
  t.regions.forEach((r, ri) => {
    const rbuf = regionBuffer(t, r);
    const data = rbuf.getChannelData(0), sr = rbuf.sampleRate;
    const offX = r.start * pxPerSec, span = r.length * pxPerSec;
    const isSel = ri === (t.selRegion || 0);
    g.fillStyle = color; g.globalAlpha = (t === (drag && drag.t) && drag.r === r) ? 0.26 : (isSel ? 0.18 : 0.1);
    g.fillRect(offX, 2, span, h - 4);
    g.globalAlpha = isSel ? 0.95 : 0.6; g.fillRect(offX, 2, 1.5, h - 4); g.fillRect(offX + span - 1.5, 2, 1.5, h - 4);
    const s0samp = r.offset * sr, px2samp = (r.length * sr) / Math.max(1, span);
    const rg = r.gain == null ? 1 : r.gain;
    g.globalAlpha = 0.9;
    for (let x = 0; x < span; x++) {
      let min = 1, max = -1;
      const a = Math.floor(s0samp + x * px2samp), b = Math.floor(s0samp + (x + 1) * px2samp);
      for (let j = a; j < b; j++) { const v = data[j] || 0; if (v < min) min = v; if (v > max) max = v; }
      const px = offX + x; if (px < 0 || px > w) continue;
      const y1 = (1 - (Math.max(-1, max * rg) + 1) / 2) * h, y2 = (1 - (Math.min(1, min * rg) + 1) / 2) * h;
      g.fillRect(px, y1, 1, Math.max(1, y2 - y1));
    }
    if (Math.abs(rg - 1) > 0.01 && span > 30) { g.globalAlpha = 0.9; g.fillStyle = "#0a0c10"; g.fillRect(offX + span - 34, 3, 32, 12); g.fillStyle = color; g.font = "9px -apple-system, sans-serif"; g.fillText((rg >= 1 ? "+" : "") + (20 * Math.log10(rg || 0.0001)).toFixed(0) + "dB", offX + span - 31, 12); g.fillStyle = color; }
    g.globalAlpha = 0.4; g.fillStyle = "#0a0c10";
    if (r.fadeIn > 0) { const fw = r.fadeIn * pxPerSec; g.beginPath(); g.moveTo(offX, 2); g.lineTo(offX + fw, 2); g.lineTo(offX, h - 2); g.closePath(); g.fill(); }
    if (r.fadeOut > 0) { const fw = r.fadeOut * pxPerSec; g.beginPath(); g.moveTo(offX + span, 2); g.lineTo(offX + span - fw, 2); g.lineTo(offX + span, h - 2); g.closePath(); g.fill(); }
    if (multi && span > 26) {   // comp: label which take this region plays
      g.globalAlpha = 0.85; g.fillStyle = "#0a0c10"; g.fillRect(offX + 3, 3, 20, 12);
      g.globalAlpha = 1; g.fillStyle = color; g.font = "9px -apple-system, sans-serif";
      g.fillText("T" + ((r.take || 0) + 1), offX + 6, 12);
    }
    g.fillStyle = color;
  });
  drawAutomation(g, t, w, h);
}

// ---- vocal pitch correction (time-domain PSOLA autotune, beta) -------------
// detect f0 per hop via normalized autocorrelation (80..500 Hz), 0 = unvoiced
function detectF0Track(x, sr) {
  const hop = 512, win = 1024, minP = Math.floor(sr / 500), maxP = Math.floor(sr / 80);
  const frames = Math.max(0, Math.floor((x.length - win - maxP) / hop));
  const f0 = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * hop; let e0 = 0;
    for (let i = 0; i < win; i++) { const v = x[off + i]; e0 += v * v; }
    if (e0 < 1e-4) { f0[f] = 0; continue; }
    let best = 0, bestLag = 0;
    for (let lag = minP; lag <= maxP; lag++) {
      let s = 0; for (let i = 0; i < win; i++) s += x[off + i] * x[off + i + lag];
      const norm = s / (e0 + 1e-9);
      if (norm > best) { best = norm; bestLag = lag; }
    }
    f0[f] = (best > 0.5 && bestLag > 0) ? sr / bestLag : 0;   // clarity gate
  }
  return { f0, hop };
}
const nearestSemitoneRatio = (f0) => { if (f0 <= 0) return 1; const midi = Math.round(69 + 12 * Math.log2(f0 / 440)); return (440 * Math.pow(2, (midi - 69) / 12)) / f0; };
const centsToScale = (f0) => { if (f0 <= 0) return 0; const m = 69 + 12 * Math.log2(f0 / 440); return Math.abs(m - Math.round(m)) * 100; };

// TD-PSOLA: re-space pitch periods toward the nearest semitone, duration preserved
function psolaTune(actx, buffer, strength) {
  const sr = buffer.sampleRate, x = buffer.getChannelData(0), N = x.length;
  const { f0, hop } = detectF0Track(x, sr);
  const f0At = (pos) => f0.length ? (f0[Math.min(f0.length - 1, Math.max(0, Math.round(pos / hop)))] || 0) : 0;
  const defaultP = Math.floor(sr / 160);
  const win = (n, len) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (len - 1));
  // analysis pitch marks spaced by the local period
  const am = [];
  for (let pos = 0; pos < N;) { am.push(pos); const ff = f0At(pos); pos += ff > 0 ? Math.round(sr / ff) : defaultP; }
  const out = new Float32Array(N), norm = new Float32Array(N);
  let ki = 0;
  for (let s = 0, guard = 0; s < N && guard < 4 * N; guard++) {
    while (ki + 1 < am.length && Math.abs(am[ki + 1] - s) < Math.abs(am[ki] - s)) ki++;
    const ff = f0At(am[ki]);
    const inP = ff > 0 ? Math.round(sr / ff) : defaultP;
    let outP = inP;
    if (ff > 0) { const r = nearestSemitoneRatio(ff); outP = Math.max(20, Math.round(inP / (1 + (r - 1) * strength))); }
    const half = inP, len = 2 * half;
    for (let i = 0; i < len; i++) {
      const src = am[ki] - half + i, dst = s - half + i;
      if (src < 0 || src >= N || dst < 0 || dst >= N) continue;
      const w = win(i, len); out[dst] += x[src] * w; norm[dst] += w;
    }
    s += outP;
  }
  let peak = 0;
  for (let i = 0; i < N; i++) { if (norm[i] > 1e-3) out[i] /= norm[i]; const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 1) for (let i = 0; i < N; i++) out[i] /= peak;   // guard against clipping
  const nb = actx.createBuffer(1, N, sr); nb.copyToChannel(out, 0);
  return nb;
}
// mean cents-off-scale over voiced frames (validation + before/after report)
function meanCentsOff(buffer) {
  const { f0 } = detectF0Track(buffer.getChannelData(0), buffer.sampleRate);
  let sum = 0, n = 0; for (const v of f0) if (v > 0) { sum += centsToScale(v); n++; }
  return n ? sum / n : 0;
}
async function applyTune() {
  const t = selectedTrack();
  if (!t || !t.buffer) { log("dj", "select a vocal track first, then tune."); return; }
  const strength = +$("#tune-str").value;
  status("tuning vocal…", true);
  await new Promise((r) => setTimeout(r, 30));   // let the status paint before the heavy pass
  try {
    const src = t.takes[0].buffer;
    const before = meanCentsOff(src);
    const nb = psolaTune(ctx, src, strength);
    const after = meanCentsOff(nb);
    const pre = snapshot();
    t.takes.push({ name: "tuned", buffer: nb });
    const idx = t.takes.length - 1;
    t.regions.forEach((r) => (r.take = idx));
    renderTrackHeads(); recomputeDuration(); layout(); selectTrack(t); pushUndo(pre);
    if (playing) play(playFrom);
    log("dj", `tuned “${t.meta.name}” (beta): off-pitch ${before.toFixed(0)}¢ → ${after.toFixed(0)}¢. tap the take button (T) to A/B against the original.`);
  } catch (e) { log("dj", "tuning failed: " + e.message); }
  finally { status(""); }
}

// ---- export: render the exact graph you hear (mix moves + nudge) -----------

// render the full mix offline (exact live graph) → AudioBuffer; shared by WAV + compressed export
async function renderMix() {
  const sr = ctx.sampleRate;
  const oac = new OfflineAudioContext(2, Math.ceil(duration * sr) + 3 * sr, sr);
  const m = oac.createGain(); m.gain.value = 1;   // pre-fader sum
  const mfx = buildMasterFx(oac, m, +$("#master").value); mfx.out.connect(oac.destination);   // same master bus as live
  const conv = oac.createConvolver(); conv.buffer = makeImpulse(oac);
  const ret = oac.createGain(); ret.gain.value = 0.9; conv.connect(ret).connect(m);
  const vb = buildVocalBus(oac, m, conv);   // same vocal blend bus as live
  tracks.forEach((t) => {
    const busOut = (isVocal(t)) ? vb.input : m;
    if (t.kind === "instrument") { const c = buildChain(oac, t, busOut, conv); scheduleNotes(oac, t, c.eqLow, 0, 0); scheduleAutomation(t, c, 0, 0); return; }
    if (!t.buffer) return;
    const c = buildChain(oac, t, busOut, conv);   // same EQ + reverb send as live
    scheduleTrack(oac, t, c.eqLow, 0, 0);          // same trim + fades as live
    scheduleAutomation(t, c, 0, 0);                // same automation curves as live
  });
  return oac.startRendering();
}
async function exportMix() {
  if (!tracks.some((t) => t.buffer || t.kind === "instrument")) return;
  status("rendering mix…", true);
  downloadWav(await renderMix(), "deejai_mix.wav");
  status("");
}
// compressed "share" export via MediaRecorder (webm/opus, or m4a in Safari)
async function exportCompressed() {
  if (!tracks.some((t) => t.buffer || t.kind === "instrument")) return;
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((mm) => window.MediaRecorder && MediaRecorder.isTypeSupported(mm));
  if (!mime) { log("dj", "this browser can’t encode compressed audio — use “export mix” for a WAV."); return; }
  status("rendering…", true);
  const buf = await renderMix();
  status("encoding…", true);
  ensureCtx(); if (ctx.state === "suspended") await ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: mime }), chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => (rec.onstop = res));
  rec.start(); src.start();
  await new Promise((r) => setTimeout(r, (buf.duration + 0.3) * 1000));
  rec.stop(); await stopped;
  const blob = new Blob(chunks, { type: mime }), ext = mime.includes("mp4") ? "m4a" : "webm";
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "deejai_mix." + ext; a.click();
  status("");
  log("dj", `exported a compressed .${ext} (${Math.round(blob.size / 1024)} KB).`);
  return blob.size;
}
function wavArrayBuffer(buffer) {   // AudioBuffer -> 16-bit PCM WAV bytes
  const ch = buffer.numberOfChannels, len = buffer.length;
  const view = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, "RIFF"); view.setUint32(4, 36 + len * ch * 2, true); wr(8, "WAVE"); wr(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * ch * 2, true);
  view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true); wr(36, "data"); view.setUint32(40, len * ch * 2, true);
  let o = 44;
  const chans = Array.from({ length: ch }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i])); view.setInt16(o, v * 0x7fff, true); o += 2;
  }
  return view.buffer;
}
function downloadWav(buffer, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([wavArrayBuffer(buffer)], { type: "audio/wav" })); a.download = name; a.click();
}
// base64 <-> AudioBuffer, for persisting client-origin audio (bounces, comp takes)
function abToBase64(ab) {
  const b = new Uint8Array(ab); let s = ""; const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
async function base64ToBuffer(b64) {   // raw WAV (v2 projects)
  return ensureCtx().decodeAudioData(b64ToBytes(b64).buffer);
}
// gzip an AudioBuffer's WAV bytes -> base64 (lossless compression for save files)
const canGzip = typeof CompressionStream !== "undefined";
async function clipToBase64(buffer) {
  const wav = wavArrayBuffer(buffer);
  if (!canGzip) return abToBase64(wav);
  const cs = new CompressionStream("gzip"); const w = cs.writable.getWriter(); w.write(new Uint8Array(wav)); w.close();
  return abToBase64(await new Response(cs.readable).arrayBuffer());
}
async function base64ClipToBuffer(b64, gzipped) {
  if (!gzipped) return base64ToBuffer(b64);
  const ds = new DecompressionStream("gzip"); const w = ds.writable.getWriter(); w.write(b64ToBytes(b64)); w.close();
  return ensureCtx().decodeAudioData(await new Response(ds.readable).arrayBuffer());
}

// ---- record-arm + input monitoring -----------------------------------------

function armTrack(t) {
  const was = t.armed;
  tracks.forEach((x) => (x.armed = false));   // one armed at a time (single mic)
  t.armed = !was;
  renderTrackHeads();
  if (t.armed) selectTrack(t); else { const s = selectedTrack(); if (s) selectTrack(s); }
  refreshMonitor();
  log("dj", t.armed ? `armed “${t.meta.name}” — keys/MIDI record here; ● rec overdubs a take onto it.` : `disarmed “${t.meta.name}”.`);
}
async function startMonitor() {
  if (monSrc) return;
  const a = armedTrack(); if (!a) { log("dj", "arm a track (R) first, then monitor."); monitorOn = false; $("#monitor").classList.remove("on"); return; }
  ensureCtx(); if (ctx.state === "suspended") await ctx.resume();
  try { monStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
  catch (e) { log("dj", "mic blocked — allow microphone access to monitor."); monitorOn = false; $("#monitor").classList.remove("on"); return; }
  monSrc = ctx.createMediaStreamSource(monStream);
  wireTrack(a); monSrc.connect(a.eqLow || master);   // hear yourself through the armed track's channel strip
  log("dj", "input monitoring on — use headphones so the mic doesn't pick up the output.");
}
function stopMonitor() {
  if (monSrc) { try { monSrc.disconnect(); } catch (e) {} monSrc = null; }
  if (monStream) { monStream.getTracks().forEach((t) => t.stop()); monStream = null; }
}
function refreshMonitor() { if (monitorOn && armedTrack()) { stopMonitor(); startMonitor(); } else stopMonitor(); }

// ---- in-app recording (overdub) --------------------------------------------

let recording = false, recStream = null, recProc = null, recChunks = [], recCount = 0, recStartPos = 0;

async function toggleRecord() {
  if (recording) return stopRecording();
  ensureCtx();
  if (ctx.state === "suspended") await ctx.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) { log("dj", "mic blocked — allow microphone access to record."); return; }
  recStream = stream;
  recChunks = [];
  if (countInOn) {   // click a bar in before capture starts, so the singer comes in on the beat
    const spb = (4 / beatUnit) * 60 / (tempo || 100);
    for (let i = 0; i < beatsPerBar; i++) clickAt(ctx.currentTime + 0.12 + i * spb, i === 0);
    log("dj", `counting in ${beatsPerBar} beats…`);
    await new Promise((r) => setTimeout(r, (beatsPerBar * spb + 0.12) * 1000));
  }
  const src = ctx.createMediaStreamSource(stream);
  recProc = ctx.createScriptProcessor(4096, 1, 1);
  recProc.onaudioprocess = (e) => recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  const sink = ctx.createGain(); sink.gain.value = 0;         // keep the node alive without output
  src.connect(recProc); recProc.connect(sink); sink.connect(ctx.destination);

  recording = true;
  recStartPos = playFrom;   // punch-in point: where the playhead sits when capture begins (after count-in)
  $("#rec").classList.add("recording"); $("#rec").innerHTML = "■ stop";
  log("dj", "recording… sing over the mix (headphones recommended). hit stop when done.");
  play(recStartPos);  // overdub: roll the existing mix from the punch-in point so the take lands in time
}

async function stopRecording() {
  recording = false;
  $("#rec").classList.remove("recording"); $("#rec").innerHTML = "●&nbsp;rec";
  stop();
  try { recProc.disconnect(); } catch (e) {}
  recStream.getTracks().forEach((t) => t.stop());

  const total = recChunks.reduce((n, c) => n + c.length, 0);
  let buf = new Float32Array(total);
  let off = 0; recChunks.forEach((c) => { buf.set(c, off); off += c.length; });
  // latency compensation: drop the output+buffer latency from the take's front so it
  // aligns to recStartPos (captured audio lags the backing mix by roughly this much)
  const comp = (ctx.baseLatency || 0) + (ctx.outputLatency || 0) + 4096 / ctx.sampleRate + recLatencyMs / 1000;
  const trim = Math.max(0, Math.round(comp * ctx.sampleRate));
  if (trim > 0 && trim < buf.length) buf = buf.subarray(trim);
  const len = buf.length;
  if (len < ctx.sampleRate * 0.3) { log("dj", "that take was too short."); return; }

  const armed = armedTrack();
  if (armed && armed.buffer) {   // record onto the armed track as a new comp lane (no new track)
    const ab = ctx.createBuffer(1, len, ctx.sampleRate); ab.copyToChannel(buf, 0);
    const pre = snapshot();
    if (!armed.takes || !armed.takes.length) armed.takes = [{ name: armed.meta.name, buffer: armed.buffer }];
    armed.takes.push({ name: `recording ${++recCount}`, buffer: ab });
    renderTrackHeads(); selectTrack(armed); pushUndo(pre);
    log("dj", `recorded a new take onto “${armed.meta.name}” — split a region and tap T to comp between takes.`);
    return;
  }

  const blob = wavBlob(buf, ctx.sampleRate);
  const name = `recording ${++recCount}.wav`;
  status("adding your take…", true);
  const before = new Set(tracks.map((t) => t.meta.file.replace(/\?.*/, "")));   // identify the new track after re-render
  const fd = new FormData(); fd.append("file", blob, name); fd.append("name", name);
  try {
    const r = await fetch(`/api/session/${session.id}/add_take`, { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    await applyProject((await r.json()).project, { keepRegions: true });
    // punch-in placement: sit the recorded clip at the playhead where capture began, not at 0
    const nt = tracks.find((t) => !before.has(t.meta.file.replace(/\?.*/, "")));
    if (nt && nt.regions && nt.regions[0] && recStartPos > 0) { nt.regions[0].start = recStartPos; recomputeDuration(); layout(); }
    log("dj", `added “${name}”, balanced and synced with the rest.`);
  } catch (e) { log("dj", "couldn't add the take: " + e.message); }
  finally { status(""); }
}

function wavBlob(samples, sr) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); wr(8, "WAVE"); wr(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); wr(36, "data"); view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) { const v = Math.max(-1, Math.min(1, samples[i])); view.setInt16(o, v * 0x7fff, true); o += 2; }
  return new Blob([view], { type: "audio/wav" });
}

// ---- import your own takes -------------------------------------------------

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => /\.wav$/i.test(f.name));
  if (files.length < 2) { log("dj", "import at least two WAV takes (a lead plus harmonies)."); return; }
  status(`processing ${files.length} takes…`, true);
  const fd = new FormData(); files.forEach((f) => fd.append("files", f));
  try {
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    stop(); await adopt(await r.json(), `loaded ${files.length} of your takes and balanced them.`);
  } catch (e) { log("dj", "import failed: " + e.message); }
  finally { status(""); }
}

// ---- project save / load ---------------------------------------------------

async function saveProject() {
  if (!session) return;
  status("saving…", true);
  try {
    const engine = await (await fetch(`/api/session/${session.id}/bundle`)).json();
    // encode client-origin audio (bounced tracks + extra comp takes) that the engine bundle doesn't carry
    const clips = {};
    for (const t of tracks) {
      if (t.clientAudio && t.buffer) clips[t.meta.file] = await clipToBase64(t.buffer);
      if (t.takes && t.takes.length > 1) for (let i = 1; i < t.takes.length; i++) { if (t.takes[i].buffer) clips[`${t.meta.file}#take${i}`] = await clipToBase64(t.takes[i].buffer); }
      if (t.kind === "instrument" && t.instrument === "sampler" && t.sampleBuffer) clips[`${t.meta.file}#sample`] = await clipToBase64(t.sampleBuffer);
    }
    const project = { version: 2, engine, mix: snapshot(), align: { ...alignSettings, phase: downbeatAt }, clips, clipsCodec: canGzip ? "gzip" : "wav" };
    const blob = new Blob([JSON.stringify(project)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "project.deejai.json"; a.click();
    log("dj", "saved your project to a file.");
  } catch (e) { log("dj", "save failed: " + e.message); }
  finally { status(""); }
}

async function openProject(file) {
  try { await openProjectObj(JSON.parse(await file.text())); }
  catch (e) { log("dj", "open failed: " + e.message); status(""); }
}
async function openProjectObj(proj) {
  status("opening project…", true);
  try {
    const e = proj.engine || {};
    const res = await fetch("/api/load", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lead: e.lead, beat: e.beat, backing: e.backing, takes: e.takes }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    stop();
    const loaded = await res.json();
    session = { id: loaded.id }; $("#parser").textContent = loaded.parser;
    let project = loaded.project;
    if (proj.align) {   // re-apply saved align/tune so placements + tuned audio are restored
      const a = proj.align;
      alignSettings = { beat_snap: !!a.beat_snap, div: a.div ?? 1, tune: a.tune ?? 0, grid_ref: a.grid_ref || "" };
      downbeatAt = (a.phase != null && a.phase >= 0) ? a.phase : null;
      try {
        const rr = await api(`/api/session/${loaded.id}/align?beat_snap=${alignSettings.beat_snap}&div=${alignSettings.div}&tune=${alignSettings.tune}&grid_ref=${encodeURIComponent(alignSettings.grid_ref)}&phase=${downbeatAt != null ? downbeatAt : -1}`);
        project = rr.project;
      } catch (err) { /* fall back to the loaded placement */ }
    }
    // decode persisted client-origin audio (bounced tracks + comp takes)
    const decoded = {}, gz = proj.clipsCodec === "gzip";
    if (proj.clips) for (const [k, v] of Object.entries(proj.clips)) { try { decoded[k] = await base64ClipToBuffer(v, gz); } catch (err) {} }
    Object.keys(decoded).forEach((k) => { if (!k.includes("#take") && !k.includes("#sample")) clientBuffers[k] = decoded[k]; });   // bounced tracks -> registry
    await applyProject(project);
    // rebuild comp lanes on buffer tracks from takeNames + decoded takes (before applySnapshot clamps region.take)
    if (proj.mix) {
      proj.mix.tracks.forEach((ts) => {
        const t = tracks.find((x) => x.meta.file === ts.file);
        if (t && t.buffer && ts.takeNames && ts.takeNames.length > 1) {
          const takes = [{ name: ts.takeNames[0], buffer: t.buffer }];
          for (let i = 1; i < ts.takeNames.length; i++) { const b = decoded[`${ts.file}#take${i}`]; if (b) takes.push({ name: ts.takeNames[i], buffer: b }); }
          t.takes = takes;
        }
        const sb = decoded[`${ts.file}#sample`]; if (sb) ts.sampleBuffer = sb;   // sampler audio -> attached when applySnapshot recreates the instrument track
      });
    }
    log("dj", "opened your project.");
    if (proj.mix) { applySnapshot(proj.mix); history = []; future = []; syncUndoBtns(); }
  } catch (e) { log("dj", "open failed: " + e.message); }
  finally { status(""); }
}

// ---- loop / sound browser --------------------------------------------------
// loops are authored in beats [pitch, beatStart, beatLen, vel] and materialized
// to seconds at the project tempo, so a dropped loop locks to the song.
function beatsToNotes(seq, spb) {
  return seq.map(([pitch, b, len, vel]) => ({ pitch, start: +(b * spb).toFixed(4), dur: +Math.max(0.05, len * spb).toFixed(4), vel: vel || 0.85 }));
}
const _hat8 = [0, .5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5];
// GM drum notes: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 49 crash
function _drumFour() { const s = []; for (let b = 0; b < 8; b++) s.push([36, b, .2, 1]); _hat8.forEach((b) => s.push([42, b, .1, .55])); [1, 3, 5, 7].forEach((b) => s.push([38, b, .2, .9])); return s; }
function _drumBoom() { const s = [[36, 0, .2, 1], [36, 2.5, .2, .9], [36, 4, .2, 1], [36, 6.5, .2, .9]]; _hat8.forEach((b) => s.push([42, b, .1, .5])); [1, 3, 5, 7].forEach((b) => s.push([38, b, .2, .95])); return s; }
function _drumTrap() { const s = [[36, 0, .2, 1], [36, 3, .2, .9], [36, 4, .2, 1], [36, 5.75, .2, .8], [38, 2, .2, .9], [38, 6, .2, .9]]; for (let b = 0; b < 8; b += .5) s.push([42, b, .08, .5]); [1.75, 2.25, 5.5, 5.75, 6.25].forEach((b) => s.push([42, b, .06, .4])); return s; }
function _drumLofi() { const s = [[36, 0, .2, .9], [36, 2.5, .2, .8], [36, 4, .2, .9], [38, 1, .2, .8], [38, 3, .2, .8], [38, 5, .2, .8], [38, 7, .2, .8]]; [.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5].forEach((b) => s.push([42, b + .08, .1, .4])); return s; }
function _drumHouse() { const s = []; for (let b = 0; b < 8; b++) s.push([36, b, .2, 1]); [.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5].forEach((b) => s.push([46, b, .12, .4])); [1, 3, 5, 7].forEach((b) => s.push([39, b, .2, .7])); return s; }
function _drumDisco() { const s = []; for (let b = 0; b < 8; b++) s.push([36, b, .2, 1]); _hat8.forEach((b) => s.push([42, b, .08, .45])); [.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5].forEach((b) => s.push([46, b, .1, .3])); [1, 3, 5, 7].forEach((b) => s.push([38, b, .2, .85])); return s; }
function _drumFunk() { const s = [[36, 0, .2, 1], [36, .75, .2, .8], [36, 2.5, .2, .9], [36, 4, .2, 1], [36, 4.75, .2, .8], [36, 6.5, .2, .9]]; [1, 3, 5, 7].forEach((b) => s.push([38, b, .2, .9])); [1.5, 5.5].forEach((b) => s.push([38, b, .15, .4])); for (let b = 0; b < 8; b += .5) s.push([42, b, .06, .4]); return s; }
function _drumHalf() { const s = [[36, 0, .2, 1], [36, 4, .2, 1], [38, 2, .25, .95], [38, 6, .25, .95]]; _hat8.forEach((b) => s.push([42, b, .08, .4])); return s; }
function _drumBreak() { const s = [[36, 0, .2, 1], [36, .75, .2, .8], [36, 4, .2, .95], [36, 4.75, .2, .8]]; [1, 2.75, 3.5, 5, 6.75, 7.5].forEach((b) => s.push([38, b, .15, .85])); _hat8.forEach((b) => s.push([42, b, .06, .4])); return s; }
function _drumDnb() { const s = [[36, 0, .2, 1], [36, 2.5, .15, .7], [36, 4.5, .2, 1]]; [2, 6].forEach((b) => s.push([38, b, .2, .95])); for (let b = 0; b < 8; b += .5) s.push([42, b, .05, .35]); return s; }
function _drumRock() { const s = []; [0, 2, 2.5, 4, 6, 6.5].forEach((b) => s.push([36, b, .2, 1])); [1, 3, 5, 7].forEach((b) => s.push([38, b, .22, .95])); _hat8.forEach((b) => s.push([42, b, .09, .5])); return s; }
function _drumReg() { const s = []; [0, 1.5, 4, 5.5].forEach((b) => s.push([36, b, .2, 1])); [.75, 1.5, 2.75, 3.5, 4.75, 5.5, 6.75, 7.5].forEach((b) => s.push([38, b, .15, .75])); _hat8.forEach((b) => s.push([42, b, .06, .35])); return s; }
function _drumAfro() { const s = []; [0, 1.5, 3, 4, 5.5, 7].forEach((b) => s.push([36, b, .18, .9])); [1, 3, 5, 7].forEach((b) => s.push([39, b, .15, .55])); [0, .5, 1, 1.75, 2.5, 3.25, 4, 4.5, 5, 5.75, 6.5, 7.25].forEach((b) => s.push([42, b, .06, .4])); return s; }
function _drumDrill() { const s = [[36, 0, .2, 1], [36, 3, .2, .9], [36, 4, .2, 1], [36, 6.75, .2, .85]]; [2, 6].forEach((b) => s.push([38, b, .2, .9])); for (let b = 0; b < 8; b += .5) s.push([42, b, .06, .45]); [1.66, 1.83, 5.66, 5.83].forEach((b) => s.push([42, b, .05, .35])); return s; }
function _drumClap() { const s = [[36, 0, .2, .9], [36, 4, .2, .9]]; [1, 3, 5, 7].forEach((b) => s.push([39, b, .18, .7])); return s; }

// chord progressions (triads / 7ths), two beats per chord over two bars
const PROGS = {
  amin:   [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]],          // i VI III VII (Am F C G)
  pop:    [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]],          // I V vi IV
  uplift: [[60, 64, 67], [53, 57, 60], [57, 60, 64], [55, 59, 62]],          // I IV vi V
  doowop: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]],          // I vi IV V
  epic:   [[53, 57, 60], [55, 59, 62], [57, 60, 64], [60, 64, 67]],          // IV V vi I
  jazz:   [[62, 65, 69, 72], [55, 59, 62, 65], [60, 64, 67, 71], [60, 64, 67, 71]], // ii7 V7 Imaj7
  lofi:   [[60, 64, 67, 71], [57, 60, 64, 67], [62, 65, 69, 72], [55, 59, 62, 65]], // maj7/min7 mellow
  sad:    [[57, 60, 64], [62, 65, 69], [64, 67, 71], [57, 60, 64]],          // i iv v i
};
// generic builders over a progression
function chordLoop(prog, style) {
  const s = [];
  prog.forEach((ch, i) => {
    if (style === "pad") ch.forEach((p) => s.push([p, i * 2, 2, .55]));
    else if (style === "stab") [0, 1].forEach((j) => ch.forEach((p) => s.push([p, i * 2 + j, .35, .7])));
    else if (style === "8ths") for (let j = 0; j < 4; j++) ch.forEach((p) => s.push([p, i * 2 + j * .5, .4, .55]));
  });
  return s;
}
function arpLoop(prog, pat) {
  const s = []; const step = 2 / pat.length;
  prog.forEach((ch, i) => pat.forEach((k, j) => s.push([ch[k % ch.length] + (k >= ch.length ? 12 : 0), i * 2 + j * step, step * .9, .7])));
  return s;
}
function bassLoop(prog, style) {
  const s = [];
  prog.forEach((ch, i) => {
    const r = ch[0] - 12;
    if (style === "root") s.push([r, i * 2, 1, .9], [r, i * 2 + 1.5, .5, .6]);
    else if (style === "octave") s.push([r, i * 2, .5, .9], [r + 12, i * 2 + .5, .5, .6], [r, i * 2 + 1, .5, .85], [r + 12, i * 2 + 1.5, .5, .6]);
    else if (style === "8ths") for (let j = 0; j < 4; j++) s.push([r, i * 2 + j * .5, .45, .7]);
    else if (style === "walk") s.push([r, i * 2, 1, .85], [ch[1] - 12, i * 2 + 1, 1, .7]);
    else if (style === "offbeat") s.push([r, i * 2 + .5, .4, .8], [r, i * 2 + 1.5, .4, .8]);
    else if (style === "sub") s.push([r, i * 2, 2, .95]);
  });
  return s;
}
function _hook() { return [[72, 0, .9, .8], [76, 1, .9, .8], [74, 2, .9, .8], [72, 3, .9, .8], [79, 4, .9, .85], [76, 5, .9, .8], [72, 6, .9, .8], [74, 7, 1.5, .8]]; }
function _hookMinor() { return [[69, 0, .9, .8], [67, 1, .9, .8], [64, 2, .9, .8], [67, 3, .9, .8], [69, 4, .9, .85], [72, 5, .9, .8], [69, 6, .9, .8], [64, 7, 1.2, .8]]; }
function _penta() { const p = [72, 74, 76, 79, 81, 79, 76, 74, 72, 74, 76, 79, 81, 83, 81, 79]; return p.map((n, i) => [n, i * .5, .45, .75]); }
function _callResp() { return [[72, 0, .5, .8], [74, .5, .5, .8], [76, 1, 1, .8], [71, 2, .5, .75], [72, 2.5, .5, .75], [67, 3, 1, .75], [76, 4, .5, .8], [77, 4.5, .5, .8], [79, 5, 1, .85], [74, 6, .5, .75], [72, 6.5, .5, .75], [71, 7, 1, .75]]; }

const LOOPS = [
  // drums
  { id: "d1", cat: "drums", name: "four on the floor", inst: "drums", seq: _drumFour() },
  { id: "d2", cat: "drums", name: "boom bap", inst: "drums", seq: _drumBoom() },
  { id: "d3", cat: "drums", name: "trap hats", inst: "drums", seq: _drumTrap() },
  { id: "d4", cat: "drums", name: "lofi swing", inst: "drums", seq: _drumLofi() },
  { id: "d5", cat: "drums", name: "house", inst: "drums", seq: _drumHouse() },
  { id: "d6", cat: "drums", name: "disco", inst: "drums", seq: _drumDisco() },
  { id: "d7", cat: "drums", name: "funk", inst: "drums", seq: _drumFunk() },
  { id: "d8", cat: "drums", name: "half-time", inst: "drums", seq: _drumHalf() },
  { id: "d9", cat: "drums", name: "breakbeat", inst: "drums", seq: _drumBreak() },
  { id: "d10", cat: "drums", name: "drum & bass", inst: "drums", seq: _drumDnb() },
  { id: "d11", cat: "drums", name: "rock", inst: "drums", seq: _drumRock() },
  { id: "d12", cat: "drums", name: "reggaeton", inst: "drums", seq: _drumReg() },
  { id: "d13", cat: "drums", name: "afrobeat", inst: "drums", seq: _drumAfro() },
  { id: "d14", cat: "drums", name: "drill", inst: "drums", seq: _drumDrill() },
  { id: "d15", cat: "drums", name: "claps only", inst: "drums", seq: _drumClap() },
  // bass
  { id: "b1", cat: "bass", name: "root bass", inst: "bass", seq: bassLoop(PROGS.amin, "root") },
  { id: "b2", cat: "bass", name: "octave pop", inst: "bass", seq: bassLoop(PROGS.pop, "octave") },
  { id: "b3", cat: "bass", name: "walking", inst: "bass", seq: bassLoop(PROGS.jazz, "walk") },
  { id: "b4", cat: "bass", name: "eighths pulse", inst: "bass", seq: bassLoop(PROGS.uplift, "8ths") },
  { id: "b5", cat: "bass", name: "reggae offbeat", inst: "bass", seq: bassLoop(PROGS.amin, "offbeat") },
  { id: "b6", cat: "bass", name: "sub drop", inst: "bass", seq: bassLoop(PROGS.sad, "sub") },
  // chords (rhythmic)
  { id: "c1", cat: "chords", name: "pop stabs", inst: "pluck", seq: chordLoop(PROGS.pop, "stab") },
  { id: "c2", cat: "chords", name: "piano stabs", inst: "keys", seq: chordLoop(PROGS.amin, "stab") },
  { id: "c3", cat: "chords", name: "jazzy stabs", inst: "keys", seq: chordLoop(PROGS.jazz, "stab") },
  { id: "c4", cat: "chords", name: "doo-wop stabs", inst: "pluck", seq: chordLoop(PROGS.doowop, "stab") },
  { id: "c5", cat: "chords", name: "house chords", inst: "pluck", seq: chordLoop(PROGS.pop, "8ths") },
  // pads (sustained)
  { id: "p1", cat: "pad", name: "warm pad", inst: "keys", seq: chordLoop(PROGS.amin, "pad") },
  { id: "p2", cat: "pad", name: "uplifting pad", inst: "synth", seq: chordLoop(PROGS.uplift, "pad") },
  { id: "p3", cat: "pad", name: "lofi keys", inst: "keys", seq: chordLoop(PROGS.lofi, "pad") },
  { id: "p4", cat: "pad", name: "sad pad", inst: "synth", seq: chordLoop(PROGS.sad, "pad") },
  { id: "p5", cat: "pad", name: "epic pad", inst: "synth", seq: chordLoop(PROGS.epic, "pad") },
  // arps
  { id: "a1", cat: "arp", name: "up arp", inst: "synth", seq: arpLoop(PROGS.amin, [0, 1, 2, 1]) },
  { id: "a2", cat: "arp", name: "down arp", inst: "synth", seq: arpLoop(PROGS.pop, [2, 1, 0, 1]) },
  { id: "a3", cat: "arp", name: "octave arp", inst: "synth", seq: arpLoop(PROGS.uplift, [0, 2, 3, 2]) },
  { id: "a4", cat: "arp", name: "trance 16ths", inst: "pluck", seq: arpLoop(PROGS.amin, [0, 1, 2, 1, 0, 1, 2, 1]) },
  { id: "a5", cat: "arp", name: "fm pluck arp", inst: "fm", seq: arpLoop(PROGS.lofi, [0, 1, 2, 1]) },
  { id: "a6", cat: "arp", name: "wide arp", inst: "synth", seq: arpLoop(PROGS.epic, [0, 2, 1, 3]) },
  // melody
  { id: "m1", cat: "melody", name: "simple hook", inst: "keys", seq: _hook() },
  { id: "m2", cat: "melody", name: "minor riff", inst: "synth", seq: _hookMinor() },
  { id: "m3", cat: "melody", name: "pentatonic lead", inst: "keys", seq: _penta() },
  { id: "m4", cat: "melody", name: "call & response", inst: "keys", seq: _callResp() },
];

// ---- drummer: a generated drum performance across the whole song -----------
const DRUMMER_STYLES = { pop: _drumFour, rock: _drumRock, lofi: _drumLofi, trap: _drumTrap, house: _drumHouse, funk: _drumFunk, disco: _drumDisco };
function _drumFill() { const s = []; for (let b = 0; b < 2; b += 0.25) s.push([38, b, 0.18, 0.6 + 0.16 * b]); [45, 47, 50].forEach((p, i) => s.push([p, 1 + i * 0.33, 0.2, 0.85])); return s; }
// build drums for the song: tile a 2-bar (8-beat) groove, add a snare fill every 4th cycle
function timeToBeat(tEnd) { const bpm0 = tempoAt(0) || 100; let t = 0, b = 0; while (t < tEnd && b < 20000) { t += (4 / beatUnit) * 60 / (tempoAt(t) || bpm0); b++; } return b; }
function drummerNotes(seq) { return seq.map(([pitch, b, len, vel]) => { const start = beatToTime(b); return { pitch, start: +start.toFixed(4), dur: +Math.max(0.05, beatToTime(b + len) - start).toFixed(4), vel: vel || 0.85 }; }); }
function generateDrummer(styleKey, intensity) {
  const total = duration > 1 ? duration : 16 * (60 / (tempoAt(0) || 100));
  const cycles = Math.max(1, Math.ceil(timeToBeat(total) / 8));   // follows the tempo map
  const styleFn = DRUMMER_STYLES[styleKey] || _drumFour;
  const seq = [];
  for (let c = 0; c < cycles; c++) {
    const isFill = c % 4 === 3;
    styleFn().forEach(([p, bt, l, v]) => { if (isFill && bt >= 6) return; seq.push([p, c * 8 + bt, l, Math.min(1, v * intensity)]); });
    if (isFill) _drumFill().forEach(([p, bt, l, v]) => seq.push([p, c * 8 + 6 + bt, l, Math.min(1, v * intensity)]));
  }
  return drummerNotes(seq);
}
function createDrummer() {
  const style = $("#dr-style").value, intensity = +$("#dr-int").value;
  const notes = generateDrummer(style, intensity);
  const pre = snapshot();
  const t = makeInstrumentTrack("drums", "Drummer · " + style, notes);
  tracks.push(t); if (ctx) wireTrack(t);
  renderTrackHeads(); recomputeDuration(); layout(); selectTrack(t); pushUndo(pre);
  $("#drummer").classList.add("hidden");
  log("dj", `drummer laid down a ${style} groove across the song. open its piano roll to tweak or change the kit.`);
}

let previewSrcs = [], loopCat = "all";
function loopNotes(loop) { return beatsToNotes(loop.seq, 60 / (tempo || 100)); }
function stopPreview() { previewSrcs.forEach((s) => { try { s.stop(); } catch (e) {} }); previewSrcs = []; }
function previewLoop(loop) {
  ensureCtx(); if (ctx.state === "suspended") ctx.resume();
  stopPreview();
  const t0 = ctx.currentTime + 0.05;
  loopNotes(loop).forEach((n) => previewSrcs.push(...playVoice(ctx, master, loop.inst, n.pitch, t0 + n.start, n.dur, n.vel)));
}
function addLoopToTimeline(loop) {
  let at = playFrom; if (snapOn) at = snapTime(at);
  const notes = loopNotes(loop).map((n) => ({ ...n, start: +(n.start + at).toFixed(4) }));
  const pre = snapshot();
  const t = makeInstrumentTrack(loop.inst, loop.name, notes);
  tracks.push(t); if (ctx) wireTrack(t);
  renderTrackHeads(); recomputeDuration(); layout(); selectTrack(t); pushUndo(pre);
  log("dj", `dropped “${loop.name}” at ${at.toFixed(1)}s as a ${loop.inst} track.`);
}
function renderLoops() {
  const host = $("#loops-list"); if (!host) return;
  host.innerHTML = "";
  LOOPS.filter((l) => loopCat === "all" || l.cat === loopCat).forEach((l) => {
    const row = document.createElement("div"); row.className = "loop-row";
    row.innerHTML = `<button class="loop-play" title="preview">▸</button><span class="loop-name">${l.name}</span><span class="loop-cat">${l.inst}</span><button class="loop-add" title="add to timeline">+</button>`;
    row.querySelector(".loop-play").onclick = () => previewLoop(l);
    row.querySelector(".loop-add").onclick = () => addLoopToTimeline(l);
    row.draggable = true;
    row.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/loop", l.id));
    host.appendChild(row);
  });
}
function toggleLoops() {
  const el = $("#loops"); const open = el.classList.toggle("open");
  $("#loops-btn").classList.toggle("on", open);
  if (open) renderLoops();
}

// ---- chat ------------------------------------------------------------------

function log(who, text) {
  const el = document.createElement("div");
  el.className = "msg " + (who === "you" ? "you" : "dj");
  el.innerHTML = who === "you" ? esc(text) : text.split("\n").map((l) => `<span class="edit">${esc(l)}</span>`).join("<br>");
  $("#log").appendChild(el); $("#log").scrollTop = $("#log").scrollHeight;
}
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function send(text) {
  if (!session || !text.trim()) return;
  log("you", text); status("working…", true);
  try {
    const res = await api(`/api/session/${session.id}/command`, { text });
    res.messages.forEach((m) => log("dj", m));
    const was = playing; stop(); await applyProject(res.project); if (was) play(playFrom);
  } catch (e) { log("dj", "error: " + e.message); }
  finally { status(""); }
}

// ---- wire up ---------------------------------------------------------------

$("#play").onclick = () => (playing ? stop() : play());
$("#rec").onclick = toggleRecord;
$("#monitor").onclick = (e) => { monitorOn = !monitorOn; e.target.classList.toggle("on", monitorOn); if (monitorOn) startMonitor(); else stopMonitor(); };
$("#loop").onclick = (e) => { looping = !looping; e.target.classList.toggle("on", looping); if (playing) play(playFrom); };
$("#master").oninput = (e) => { if (masterOut) liveSet(masterOut.gain, +e.target.value); $("#master-db").textContent = dbLabel(+e.target.value); };
$("#export").onclick = exportMix;
$("#export-c").onclick = exportCompressed;
function populateAlignRef() {
  const sel = $("#al-ref"); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">auto (lead vocal)</option>';
  tracks.filter((t) => t.buffer && (t.meta.role === "lead" || t.meta.role === "harmony")).forEach((t) => {
    const o = document.createElement("option"); o.value = t.meta.name; o.textContent = t.meta.name; sel.appendChild(o);
  });
  sel.value = cur;
}
async function realignTakes() {
  if (!session) return;
  const divv = $("#al-div").value, beat_snap = divv !== "off", div = beat_snap ? +divv : 1, tune = +$("#al-tune").value;
  const ref = $("#al-ref").value, phase = downbeatAt != null ? downbeatAt : -1;
  alignSettings = { beat_snap, div, tune, grid_ref: ref };   // remembered for save/load
  status("re-aligning takes…", true); $("#align").classList.add("hidden");
  try {
    const res = await api(`/api/session/${session.id}/align?beat_snap=${beat_snap}&div=${div}&tune=${tune}&grid_ref=${encodeURIComponent(ref)}&phase=${phase}`);
    const was = playing; stop(); await applyProject(res.project); if (was) play(playFrom);
    log("dj", `re-aligned takes (${ref ? "grid = " + ref + ", " : ""}${beat_snap ? divv === "4" ? "bar/downbeat" : divv + "-beat grid" : "content only"}, pitch-correct ${Math.round(tune * 100)}%).`);
  } catch (e) { log("dj", "re-align failed: " + e.message); }
  finally { status(""); }
}
// tempo track: click to add a tempo point, drag to move/change, alt/right-click to delete
$("#tempo-btn").onclick = (e) => { tempoLaneOn = !tempoLaneOn; $("#tempo-lane").classList.toggle("hidden", !tempoLaneOn); e.target.classList.toggle("on", tempoLaneOn); layout(); };
$("#tempo-canvas").addEventListener("contextmenu", (e) => e.preventDefault());
$("#tempo-canvas").addEventListener("mousedown", (e) => {
  const rect = e.target.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  let hit = -1;
  for (let i = 0; i < tempoMap.length; i++) { if (Math.abs(tempoMap[i].t * pxPerSec - x) < 6 && Math.abs(bpmToY(tempoMap[i].bpm) - y) < 8) { hit = i; break; } }
  const pre = snapshot();
  if (e.altKey || e.button === 2) { if (hit >= 0) { tempoMap.splice(hit, 1); layout(); pushUndo(pre); if (playing) play(playFrom); } return; }
  if (hit < 0) {
    if (!tempoMap.length) tempoMap.push({ t: 0, bpm: tempo || 120 });
    let tt = x / pxPerSec; if (snapOn) tt = snapTime(tt);
    const p = { t: Math.max(0, tt), bpm: yToBpm(y) }; tempoMap.push(p); tempoMap.sort((a, b) => a.t - b.t); hit = tempoMap.indexOf(p);
  }
  tdrag = { i: hit, pre };
  gridTimes = null; drawRuler(); drawTempoLane();
});
document.addEventListener("mousemove", (e) => {
  if (!tdrag) return;
  const rect = $("#tempo-canvas").getBoundingClientRect();
  const p = tempoMap[tdrag.i]; p.bpm = yToBpm(e.clientY - rect.top);
  let tt = (e.clientX - rect.left) / pxPerSec; if (snapOn) tt = snapTime(tt); p.t = Math.max(0, tt);
  tempoMap.sort((a, b) => a.t - b.t); tdrag.i = tempoMap.indexOf(p);
  gridTimes = null; drawRuler(); drawTempoLane();
});
document.addEventListener("mouseup", () => { if (!tdrag) return; const pre = tdrag.pre; tdrag = null; layout(); pushUndo(pre); if (playing) play(playFrom); });
$("#align-btn").onclick = () => {
  populateAlignRef();
  $("#al-div").value = alignSettings.beat_snap ? String(alignSettings.div) : "off";
  $("#al-tune").value = alignSettings.tune; $("#al-tune-v").textContent = Math.round(alignSettings.tune * 100) + "%";
  $("#al-ref").value = alignSettings.grid_ref || "";
  $("#al-phase").textContent = downbeatAt != null ? downbeatAt.toFixed(2) + "s" : "auto";
  $("#align").classList.toggle("hidden");
};
$("#al-setphase").onclick = () => { setDownbeatMode = true; $("#align").classList.add("hidden"); $("#ruler").classList.add("armed"); status("click the ruler where beat 1 is…", true); setTimeout(() => status(""), 2500); };
$("#al-clrphase").onclick = () => { downbeatAt = null; $("#al-phase").textContent = "auto"; drawRuler(); };
$("#align-close").onclick = () => $("#align").classList.add("hidden");
$("#align").onclick = (e) => { if (e.target.id === "align") $("#align").classList.add("hidden"); };
$("#al-tune").oninput = (e) => { $("#al-tune-v").textContent = Math.round(+e.target.value * 100) + "%"; };
$("#al-apply").onclick = realignTakes;
$("#drummer-btn").onclick = () => $("#drummer").classList.toggle("hidden");
$("#drummer-close").onclick = () => $("#drummer").classList.add("hidden");
$("#drummer").onclick = (e) => { if (e.target.id === "drummer") $("#drummer").classList.add("hidden"); };
$("#dr-create").onclick = createDrummer;
$("#help-btn").onclick = () => $("#help").classList.toggle("hidden");
$("#help-close").onclick = () => $("#help").classList.add("hidden");
$("#help").onclick = (e) => { if (e.target.id === "help") $("#help").classList.add("hidden"); };
$("#save").onclick = saveProject;
$("#project-file").onchange = (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ""; };
$("#file").onchange = (e) => importFiles(e.target.files);
$("#ruler").onclick = seekFromEvent;
// cycle region: shift-drag the ruler to set loop bounds
$("#ruler").addEventListener("mousedown", (e) => {
  if (!e.shiftKey) return; e.preventDefault();
  const r = $("#ruler-inner").getBoundingClientRect(), x = Math.max(0, (e.clientX - r.left) / pxPerSec);
  cycleDrag = { start: x, pre: snapshot() }; cycle = { start: x, end: x };
});
document.addEventListener("mousemove", (e) => {
  if (!cycleDrag) return;
  const r = $("#ruler-inner").getBoundingClientRect(), x = Math.max(0, (e.clientX - r.left) / pxPerSec);
  cycle = { start: Math.min(cycleDrag.start, x), end: Math.max(cycleDrag.start, x) }; drawRuler();
});
document.addEventListener("mouseup", () => {
  if (!cycleDrag) return; const pre = cycleDrag.pre; cycleDrag = null;
  if (cycle && cycle.end - cycle.start < 0.05) cycle = null;
  if (cycle) { cycleOn = true; $("#cycle").classList.add("on"); }
  drawRuler(); pushUndo(pre);
  if (playing && (cycleOn || loopState)) play(playFrom);   // re-sync the loop window to the new cycle bounds
});
$("#cycle").onclick = (e) => { const pre = snapshot(); cycleOn = !cycleOn; e.target.classList.toggle("on", cycleOn); if (cycleOn && !cycle) cycle = { start: 0, end: Math.min(4, duration) }; drawRuler(); pushUndo(pre); if (playing) play(playFrom); };
$("#ruler").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const r = $("#ruler-inner").getBoundingClientRect(), x = e.clientX - r.left;
  const i = markers.findIndex((mk) => Math.abs(mk.t * pxPerSec - x) < 8);
  if (i >= 0) { const pre = snapshot(); markers.splice(i, 1); drawRuler(); pushUndo(pre); }
});
$("#add-marker").onclick = () => { const pre = snapshot(); markers.push({ t: playFrom, name: "Section " + (markers.length + 1) }); markers.sort((a, b) => a.t - b.t); drawRuler(); pushUndo(pre); log("dj", `marker added at ${playFrom.toFixed(1)}s (right-click it on the ruler to remove).`); };
document.addEventListener("mousemove", onDrag);
document.addEventListener("mouseup", endDrag);
document.addEventListener("mousemove", (e) => {
  if (!apdrag) return;
  const { t, param, pts } = apdrag, [lo, hi] = AUTO_RANGE[param];
  const rect = t.canvas.getBoundingClientRect(), h = t.canvas.clientHeight || 86;
  let tt = (e.clientX - rect.left) / pxPerSec; if (snapOn) tt = snapTime(tt);
  const v = clamp(lo + (1 - ((e.clientY - rect.top) - 4) / (h - 8)) * (hi - lo), lo, hi);
  const p = pts[apdrag.i]; p.t = Math.max(0, tt); p.v = v; pts.sort((a, b) => a.t - b.t); apdrag.i = pts.indexOf(p);
  drawTrack(t);
});
document.addEventListener("mouseup", () => {
  if (!apdrag) return; const pre = apdrag.pre; apdrag = null;
  recomputeDuration(); layout(); pushUndo(pre); if (playing) play(playFrom);
});

// smart controls -> selected track (live nodes + mirror to the track head)
function _applyEq(prop, node, v, id) {
  const t = selectedTrack(); if (!t) return;
  t[prop] = v; if (t[node]) liveSet(t[node].gain, v);
  $(id).textContent = (v > 0 ? "+" : "") + v;
}
["#eq-low", "#eq-mid", "#eq-high", "#rv-send", "#sc-vol", "#sc-pan",
 "#fx-comp", "#fx-drive", "#fx-crush", "#mod-rate", "#mod-depth", "#mod-fb", "#dl-time", "#dl-fb", "#dl-mix"].forEach((id) => {
  $(id).addEventListener("pointerdown", beginEdit); $(id).addEventListener("change", commitEdit);
});
$("#fx-comp").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.compAmt = +e.target.value; if (t.comp) setComp(t.comp, t.compAmt); $("#fx-comp-v").textContent = Math.round(t.compAmt * 100) + "%"; };
$("#fx-drive").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.driveAmt = +e.target.value; if (t.shaper) t.shaper.curve = driveCurve(t.driveAmt); $("#fx-drive-v").textContent = Math.round(t.driveAmt * 100) + "%"; };
$("#fx-crush").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.crush = +e.target.value; if (t.crushNode) t.crushNode.curve = crushCurve(t.crush); $("#fx-crush-v").textContent = Math.round(t.crush * 100) + "%"; };
$("#mod-rate").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.modRate = +e.target.value; if (t.mLfo) t.mLfo.frequency.value = t.modRate; $("#mod-rate-v").textContent = t.modRate.toFixed(1); };
$("#mod-depth").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.modDepth = +e.target.value; if (t.mNode) { t.mLfoGain.gain.value = t.modDepth * 0.005; t.mFb.gain.value = t.modDepth ? t.modFb : 0; t.mWet.gain.value = t.modDepth * 0.7; } $("#mod-depth-v").textContent = Math.round(t.modDepth * 100) + "%"; };
$("#mod-fb").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.modFb = +e.target.value; if (t.mFb) t.mFb.gain.value = t.modDepth ? t.modFb : 0; $("#mod-fb-v").textContent = Math.round(t.modFb * 100) + "%"; };
$("#dl-time").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.delayTime = +e.target.value; if (t.dNode) t.dNode.delayTime.value = Math.max(0.05, t.delayTime); $("#dl-time-v").textContent = Math.round(t.delayTime * 1000); };
$("#dl-fb").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.delayFb = +e.target.value; if (t.dFb) t.dFb.gain.value = Math.min(0.85, t.delayFb); $("#dl-fb-v").textContent = Math.round(t.delayFb * 100) + "%"; };
$("#dl-mix").oninput = (e) => { const t = selectedTrack(); if (!t) return; t.delayMix = +e.target.value; if (t.dWet) t.dWet.gain.value = t.delayMix; $("#dl-mix-v").textContent = Math.round(t.delayMix * 100) + "%"; };
$("#eq-low").oninput = (e) => _applyEq("eqLowDb", "eqLow", +e.target.value, "#eq-low-v");
$("#eq-mid").oninput = (e) => _applyEq("eqMidDb", "eqMid", +e.target.value, "#eq-mid-v");
$("#eq-high").oninput = (e) => _applyEq("eqHighDb", "eqHigh", +e.target.value, "#eq-high-v");
$("#rv-send").oninput = (e) => {
  const t = selectedTrack(); if (!t) return;
  t.reverbSend = +e.target.value; if (t.send) liveSet(t.send.gain, t.reverbSend);
  $("#rv-send-v").textContent = Math.round(t.reverbSend * 100) + "%";
};
$("#sc-vol").oninput = (e) => {
  const t = selectedTrack(); if (!t) return;
  t.volume = +e.target.value; applyGain(t);
  if (t.volEl) { t.volEl.value = t.volume; t.vdbEl.textContent = dbLabel(t.volume); }
  $("#sc-vol-v").textContent = dbLabel(t.volume);
};
$("#sc-pan").oninput = (e) => {
  const t = selectedTrack(); if (!t) return;
  t.pan = +e.target.value; if (t.panner) liveSet(t.panner.pan, t.pan);
  if (t.panEl) t.panEl.value = t.pan;
  $("#sc-pan-v").textContent = panLabel(t.pan);
};
// master bus fx (independent of the selected track)
$("#m-low").addEventListener("pointerdown", beginEdit); $("#m-low").addEventListener("change", commitEdit);
$("#m-high").addEventListener("pointerdown", beginEdit); $("#m-high").addEventListener("change", commitEdit);
$("#m-comp").addEventListener("pointerdown", beginEdit); $("#m-comp").addEventListener("change", commitEdit);
$("#m-low").oninput = (e) => { masterFx.low = +e.target.value; if (mEqLow) mEqLow.gain.value = masterFx.low; $("#m-low-v").textContent = (masterFx.low > 0 ? "+" : "") + masterFx.low; };
$("#m-high").oninput = (e) => { masterFx.high = +e.target.value; if (mEqHigh) mEqHigh.gain.value = masterFx.high; $("#m-high-v").textContent = (masterFx.high > 0 ? "+" : "") + masterFx.high; };
$("#m-comp").oninput = (e) => { masterFx.comp = +e.target.value; if (mComp) setComp(mComp, masterFx.comp); $("#m-comp-v").textContent = Math.round(masterFx.comp * 100) + "%"; };
$("#m-limit").onclick = () => { const pre = snapshot(); masterFx.limit = !masterFx.limit; if (mLim) setLimiter(mLim, masterFx.limit); $("#m-limit").classList.toggle("on", masterFx.limit); pushUndo(pre); };
// vocal blend bus (global)
["#bl-space", "#bl-glue", "#bl-air"].forEach((id) => { $(id).addEventListener("pointerdown", beginEdit); $(id).addEventListener("change", commitEdit); });
$("#bl-space").oninput = (e) => { blend.space = +e.target.value; if (blendSend) blendSend.gain.value = blend.space; $("#bl-space-v").textContent = Math.round(blend.space * 100) + "%"; };
$("#bl-glue").oninput = (e) => { blend.glue = +e.target.value; if (blendComp) setComp(blendComp, blend.glue); $("#bl-glue-v").textContent = Math.round(blend.glue * 100) + "%"; };
$("#bl-air").oninput = (e) => { blend.air = +e.target.value; if (blendAir) blendAir.gain.value = blend.air; $("#bl-air-v").textContent = (blend.air > 0 ? "+" : "") + blend.air.toFixed(1); };
$("#bl-auto").onclick = autoBlend;
$("#tune-str").oninput = (e) => { $("#tune-str-v").textContent = Math.round(+e.target.value * 100) + "%"; };
$("#tune-apply").onclick = applyTune;
$("#chat-form").onsubmit = (e) => { e.preventDefault(); const v = $("#chat-input").value; $("#chat-input").value = ""; send(v); };
document.querySelectorAll(".quick button").forEach((b) => (b.onclick = () => send(b.dataset.cmd)));
function setZoom(f) { userZoomed = true; pxPerSec = Math.max(4, Math.min(2000, pxPerSec * f)); layout(); }
$("#zoom-in").onclick = () => setZoom(1.6);
$("#zoom-out").onclick = () => setZoom(1 / 1.6);
$("#zoom-fit").onclick = () => { userZoomed = false; layout(); };
$("#snap").onclick = (e) => { snapOn = !snapOn; e.target.classList.toggle("on", snapOn); };
$("#metro").onclick = (e) => { metroOn = !metroOn; e.target.classList.toggle("on", metroOn); if (playing) play(playFrom); };
$("#countin").onclick = (e) => { countInOn = !countInOn; e.target.classList.toggle("on", countInOn); };
$("#recoffset").onchange = (e) => { const v = Math.max(0, Math.min(250, +e.target.value || 0)); recLatencyMs = v; e.target.value = v; };
$("#bpm").onchange = (e) => {
  const pre = snapshot();
  const v = Math.max(40, Math.min(240, +e.target.value || 100));
  if (tempoMap.length) tempoMap[0].bpm = v; else tempo = v;   // a non-empty tempo map overrides `tempo`, so move its first point
  e.target.value = v; $("#tempo").textContent = Math.round(v) + " BPM"; gridTimes = null; layout(); pushUndo(pre); if (playing) play(playFrom);
};
$("#bpb").onchange = (e) => { const pre = snapshot(); beatsPerBar = +e.target.value; gridTimes = null; layout(); pushUndo(pre); if (playing) play(playFrom); };
$("#bunit").onchange = (e) => { const pre = snapshot(); beatUnit = +e.target.value; gridTimes = null; layout(); pushUndo(pre); if (playing) play(playFrom); };
$("#master").addEventListener("pointerdown", beginEdit);
$("#master").addEventListener("change", commitEdit);
$("#undo").onclick = undo;
$("#redo").onclick = redo;
$("#add-inst").onclick = () => { setupMidi(); addInstrument("synth"); };
$("#loops-btn").onclick = toggleLoops;
document.querySelectorAll("#loops-cats button").forEach((b) => (b.onclick = () => {
  loopCat = b.dataset.cat; document.querySelectorAll("#loops-cats button").forEach((x) => x.classList.toggle("on", x === b)); renderLoops();
}));

// piano roll: instrument picker, close, key-scroll sync, note editing
INSTRUMENT_NAMES.forEach((n) => { const o = document.createElement("option"); o.value = n; o.textContent = n; $("#piano-inst").appendChild(o); });
$("#piano-inst").onchange = (e) => { if (!pianoTrack) return; const pre = snapshot(); pianoTrack.instrument = e.target.value; $("#sample-load").hidden = pianoTrack.instrument !== "sampler"; drawInstLane(pianoTrack); pushUndo(pre); };
$("#sample-file").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !pianoTrack) return;
  const pre = snapshot();
  try { pianoTrack.sampleBuffer = await ensureCtx().decodeAudioData(await f.arrayBuffer()); log("dj", `loaded “${f.name}” into the sampler — play it across the keys.`); pushUndo(pre); }
  catch (err) { log("dj", "couldn't load that sample."); }
};
$("#piano-close").onclick = closePiano;
$("#score-btn").onclick = (e) => {
  scoreOn = !scoreOn; e.target.classList.toggle("on", scoreOn);
  $("#score-scroll").classList.toggle("hidden", !scoreOn);
  $("#piano-scroll").classList.toggle("hidden", scoreOn);
  $("#piano-keys").classList.toggle("hidden", scoreOn);
  if (scoreOn) drawScore();
};
$("#score-flat").onclick = () => {
  if (!pianoTrack || !pianoSel) return;
  if (!PC_ISBLACK[((pianoSel.pitch % 12) + 12) % 12]) { log("dj", "flats apply to black-key notes — nudge with ↑/↓ first."); return; }
  const pre = snapshot(); pianoSel.flat = !pianoSel.flat; drawScore(); pushUndo(pre);
};
$("#score-canvas").addEventListener("mousedown", (e) => {
  if (!pianoTrack) return;
  const rect = $("#score-canvas").getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  const pre = snapshot();
  let hit = null;
  for (const n of pianoTrack.notes) { const nx = n.start * pxPerSec + scoreX0, ny = yStep(pitchToStaff(n.pitch, n.flat).step); if (Math.abs(nx - x) < 8 && Math.abs(ny - y) < 7) { hit = n; break; } }
  if (hit) { pianoSel = hit; sdrag = { n: hit, pre, startX: e.clientX, startStart: hit.start, accOff: accOffset(hit) }; }
  else {
    const step = stepFromY(y), time = scoreTimeFromX(x);
    const n = { pitch: clamp(stepToMidiNat(step), 0, 127), start: time, dur: 60 / (tempoAt(time) || 100), vel: 0.8 };
    pianoTrack.notes.push(n); pianoSel = n; sdrag = { n, pre, startX: e.clientX, startStart: n.start, accOff: 0 };
    auditionNote(n.pitch);
  }
  drawScore();
});
document.addEventListener("mousemove", (e) => {
  if (!sdrag) return;
  const rect = $("#score-canvas").getBoundingClientRect();
  sdrag.n.pitch = clamp(stepToMidiNat(stepFromY(e.clientY - rect.top)) + sdrag.accOff, 0, 127);
  let t = sdrag.startStart + (e.clientX - sdrag.startX) / pxPerSec; if (snapOn) t = snapTime(t); sdrag.n.start = Math.max(0, t);
  drawScore();
});
document.addEventListener("mouseup", () => { if (!sdrag) return; const pre = sdrag.pre; sdrag = null; recomputeDuration(); layout(); if (pianoTrack) drawScore(); pushUndo(pre); });

// on-screen musical-typing keyboard (plays + records the selected instrument)
const mtkHeld = {};
function buildMtk() {
  const host = $("#mtk"); if (!host || host.childElementCount) return;
  const WHITE = [0, 2, 4, 5, 7, 9, 11], BLACK = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  const lo = 48, octs = 3, whitePerOct = 7, totalWhite = octs * whitePerOct;
  for (let oct = 0; oct < octs; oct++) {
    for (let wi = 0; wi < whitePerOct; wi++) {
      const midi = lo + oct * 12 + WHITE[wi];
      const k = document.createElement("div"); k.className = "wk"; k.dataset.midi = midi;
      k.style.width = (100 / totalWhite) + "%";
      if (WHITE[wi] === 0) { const lbl = document.createElement("span"); lbl.textContent = "C" + (Math.floor(midi / 12) - 1); k.appendChild(lbl); }
      host.appendChild(k);
    }
  }
  for (let oct = 0; oct < octs; oct++) {   // black keys overlaid between whites
    [1, 3, 6, 8, 10].forEach((semi) => {
      const midi = lo + oct * 12 + semi, whiteIdx = oct * whitePerOct + BLACK[semi];
      const b = document.createElement("div"); b.className = "bk"; b.dataset.midi = midi;
      b.style.left = ((whiteIdx + 1) * (100 / totalWhite)) + "%";
      b.style.width = (100 / totalWhite * 0.62) + "%";
      host.appendChild(b);
    });
  }
  const down = (e) => { const el = e.target.closest("[data-midi]"); if (!el) return; e.preventDefault(); const m = +el.dataset.midi; if (mtkHeld["m" + m]) return; setupMidi(); noteOn(mtkHeld, "m" + m, m, 0.85); el.classList.add("on"); };
  const up = (m, el) => { if (!mtkHeld["m" + m]) return; noteOff(mtkHeld, "m" + m, 0.85); if (el) el.classList.remove("on"); };
  host.addEventListener("pointerdown", down);
  host.addEventListener("pointerup", (e) => { const el = e.target.closest("[data-midi]"); if (el) up(+el.dataset.midi, el); });
  host.addEventListener("pointerleave", () => Object.keys(mtkHeld).forEach((id) => { const m = +id.slice(1); const el = host.querySelector(`[data-midi="${m}"]`); up(m, el); }));
  host.addEventListener("pointerout", (e) => { const el = e.target.closest("[data-midi]"); if (el && !el.contains(e.relatedTarget)) up(+el.dataset.midi, el); });
}
function setTranspose(delta) {
  if (!pianoTrack) return;
  const pre = snapshot();
  pianoTrack.transpose = clamp((pianoTrack.transpose || 0) + delta, -24, 24);
  $("#tr-val").textContent = (pianoTrack.transpose > 0 ? "+" : "") + pianoTrack.transpose;
  pushUndo(pre); if (playing) play(playFrom);
}
$("#tr-down8").onclick = () => setTranspose(-12);
$("#tr-down").onclick = () => setTranspose(-1);
$("#tr-up").onclick = () => setTranspose(1);
$("#tr-up8").onclick = () => setTranspose(12);
function syncArpUI() {
  if (!pianoTrack) return; const a = pianoTrack.arp || { on: false, rate: 0.5, mode: "up" };
  $("#arp-on").classList.toggle("on", a.on); $("#arp-rate").value = a.rate; $("#arp-mode").value = a.mode;
}
$("#arp-on").onclick = () => { if (!pianoTrack) return; const pre = snapshot(); pianoTrack.arp = { ...(pianoTrack.arp || { rate: 0.5, mode: "up" }), on: !(pianoTrack.arp && pianoTrack.arp.on) }; syncArpUI(); pushUndo(pre); if (playing) play(playFrom); };
$("#arp-rate").onchange = (e) => { if (!pianoTrack) return; const pre = snapshot(); pianoTrack.arp = { ...(pianoTrack.arp || { on: false, mode: "up" }), rate: +e.target.value }; pushUndo(pre); if (playing) play(playFrom); };
$("#arp-mode").onchange = (e) => { if (!pianoTrack) return; const pre = snapshot(); pianoTrack.arp = { ...(pianoTrack.arp || { on: false, rate: 0.5 }), mode: e.target.value }; pushUndo(pre); if (playing) play(playFrom); };
$("#q-apply").onclick = () => {
  if (!pianoTrack || !pianoTrack.notes.length) return;
  const pre = snapshot();
  quantizeNotes(pianoTrack.notes, +$("#q-div").value, +$("#q-str").value, +$("#q-swing").value);
  recomputeDuration(); layout(); drawPiano(); drawInstLane(pianoTrack); pushUndo(pre); if (playing) play(playFrom);
  log("dj", "quantized the notes to the grid.");
};
$("#piano-scroll").addEventListener("scroll", () => { $("#piano-keys").style.transform = `translateY(${-$("#piano-scroll").scrollTop}px)`; });
$("#piano-grid").addEventListener("mousedown", (e) => {
  if (!pianoTrack) return;
  const r = $("#piano-grid").getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const pitch = clamp(PR_HI - Math.floor(y / ROWH), PR_LO, PR_HI);
  const pre = snapshot();
  let hit = null, mode = "move";
  for (const n of pianoTrack.notes) {
    const nx = n.start * pxPerSec, nw = Math.max(3, n.dur * pxPerSec), ny = (PR_HI - n.pitch) * ROWH;
    if (x >= nx && x <= nx + nw && y >= ny && y <= ny + ROWH) { hit = n; mode = x >= nx + nw - 6 ? "resize" : "move"; break; }
  }
  if (hit && e.altKey) { pianoSel = hit; pdrag = { n: hit, mode: "vel", startY: e.clientY, startVel: hit.vel == null ? 0.8 : hit.vel, pre }; }
  else if (hit) { pianoSel = hit; pdrag = { n: hit, mode, startX: e.clientX, startStart: hit.start, startDur: hit.dur, pre }; }
  else {
    const step = 60 / (tempoAt(x / pxPerSec) || 100);   // one beat at this point
    let start = x / pxPerSec; if (snapOn) start = snapTime(start);
    const n = { pitch, start: Math.max(0, start), dur: step, vel: 0.8 };
    pianoTrack.notes.push(n); pianoSel = n; pdrag = { n, mode: "resize", startX: e.clientX, startStart: n.start, startDur: n.dur, pre };
    auditionNote(pitch);
  }
  drawPiano();
});
document.addEventListener("mousemove", (e) => {
  if (!pdrag) return;
  const n = pdrag.n;
  if (pdrag.mode === "vel") { n.vel = clamp(pdrag.startVel + (pdrag.startY - e.clientY) / 150, 0.05, 1); drawPiano(); return; }
  const dSec = (e.clientX - pdrag.startX) / pxPerSec;
  if (pdrag.mode === "move") {
    let s = pdrag.startStart + dSec; if (snapOn) s = snapTime(s);
    n.start = Math.max(0, s);
    const r = $("#piano-grid").getBoundingClientRect();
    n.pitch = clamp(PR_HI - Math.floor((e.clientY - r.top) / ROWH), PR_LO, PR_HI);
  } else { let end = n.start + pdrag.startDur + dSec; if (snapOn) end = snapTime(end); n.dur = Math.max(0.05, end - n.start); }
  drawPiano();
});
document.addEventListener("mouseup", () => {
  if (!pdrag) return; const pre = pdrag.pre; pdrag = null;
  recomputeDuration(); layout(); if (pianoTrack) drawInstLane(pianoTrack); pushUndo(pre);
});
window.addEventListener("resize", () => { layout(); });
document.addEventListener("keydown", (e) => {
  const typing = e.target.tagName === "INPUT" || e.target.tagName === "SELECT";
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape" && !$("#help").classList.contains("hidden")) { $("#help").classList.add("hidden"); return; }
  if (mod && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y" && !typing) { e.preventDefault(); redo(); return; }
  if (mod && !typing) {   // region clipboard on the selected buffer track
    const k = e.key.toLowerCase(), t = selectedTrack();
    if (k === "c" && t && t.buffer) { e.preventDefault(); copyRegion(t); return; }
    if (k === "x" && t && t.buffer) { e.preventDefault(); cutRegion(t); return; }
    if (k === "v" && t && t.buffer) { e.preventDefault(); pasteRegion(t); return; }
  }
  if (mod && e.key.toLowerCase() === "t" && !typing) { e.preventDefault(); const t = selectedTrack(); if (t && t.buffer) splitAtPlayhead(t); return; }
  if (mod) return;
  if (e.code === "Space" && !typing) { e.preventDefault(); if (recording) stopRecording(); else if (playing) stop(); else play(); return; }
  // delete selected region on a buffer track (piano-note delete handled below when the roll is open)
  if ((e.key === "Delete" || e.key === "Backspace") && !typing && !(pianoTrack && pianoSel)) {
    const t = selectedTrack();
    if (t && t.buffer && t.regions.length) { e.preventDefault(); deleteRegion(t); return; }
  }
  // delete selected note in the piano roll / score
  if ((e.key === "Delete" || e.key === "Backspace") && pianoTrack && pianoSel && !typing) {
    e.preventDefault(); const pre = snapshot();
    pianoTrack.notes = pianoTrack.notes.filter((n) => n !== pianoSel); pianoSel = null;
    recomputeDuration(); layout(); drawPiano(); drawInstLane(pianoTrack); pushUndo(pre); return;
  }
  // nudge the selected note by a semitone (accidental entry: natural -> sharp/flat)
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && pianoTrack && pianoSel && !typing) {
    e.preventDefault(); const pre = snapshot();
    pianoSel.pitch = clamp(pianoSel.pitch + (e.key === "ArrowUp" ? 1 : -1), 0, 127);
    if (!PC_ISBLACK[((pianoSel.pitch % 12) + 12) % 12]) pianoSel.flat = false;   // naturals have no accidental
    auditionNote(pianoSel.pitch); drawPiano(); drawInstLane(pianoTrack); pushUndo(pre); return;
  }
  // play software instruments from the computer keyboard (records when transport is rolling)
  const k = e.key.toLowerCase();
  if (!typing && (k === "z" || k === "x") ) { octaveShift = clamp(octaveShift + (k === "x" ? 1 : -1), -3, 3); return; }
  if (!typing && KEYMAP[k] !== undefined && !e.repeat) {
    if (noteTarget()) { e.preventDefault(); setupMidi(); noteOn(heldKeys, k, KEYMAP[k] + octaveShift * 12, 0.85); }
  }
});
document.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  if (heldKeys[k]) noteOff(heldKeys, k, 0.85);
});
// drag-and-drop import
const pane = $("#tracks-pane");
["dragover", "dragenter"].forEach((ev) => pane.addEventListener(ev, (e) => { e.preventDefault(); pane.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => pane.addEventListener(ev, (e) => { e.preventDefault(); pane.classList.remove("dragover"); }));
pane.addEventListener("drop", (e) => {
  const loopId = e.dataTransfer.getData("text/loop");
  if (loopId) { const loop = LOOPS.find((l) => l.id === loopId); if (loop) { const r = $("#ruler-inner").getBoundingClientRect(); playFrom = Math.max(0, (e.clientX - r.left) / pxPerSec); addLoopToTimeline(loop); } return; }
  if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
});

init();
