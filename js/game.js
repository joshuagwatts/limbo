/* ============================================================
   LIMBO — a portal universe (prototype)
   Fly a wisp through the Nexus into 4 art-realms, gather echoes.
   Drift with others: serverless P2P multiplayer (Trystero) + chat.

   Controls: WASD / arrows fly · mouse-drag look · SPACE/SHIFT or
   E/Q rise/sink · T chat · M mute · touch: left-half joystick,
   right-half drag
   ============================================================ */

import * as THREE from 'three';
import { AudioEngine } from './audio.js?v=4';
import { LimboNet } from './net.js?v=13';
import { quantizeUp, estimateBpm, OnsetDetector, playSynthNote } from './jam.js?v=13';

/* ---------------- configuration ---------------- */

const REALM_DEFS = [
  { key: 'realm1', name: 'PRISM DEEP',  file: 'assets/realm1.jpg', fog: 0x1a0b2e, accent: 0xff4fd8, root: 130.81 },
  { key: 'realm2', name: 'MIRROR TIDE', file: 'assets/realm2.jpg', fog: 0x0a1030, accent: 0x7a5cff, root: 146.83 },
  { key: 'realm3', name: 'CHROME VEIL', file: 'assets/realm3.jpg', fog: 0x031018, accent: 0x37e6ff, root: 164.81 },
  { key: 'realm4', name: 'STILL POINT', file: 'assets/realm4.jpg', fog: 0x06231c, accent: 0x2dffb3, root: 196.0  },
];
const NEXUS_DEF = { key: 'nexus', name: 'THE NEXUS', root: 110.0 };

// Print shop: every realm's artwork is a real giclée print. One base URL so
// the store can move from the temp domain to shop.holowatts.com later
// without touching the rows below.
const SHOP_BASE = 'https://newvjk-az.myshopify.com';
const REALM_PRINT = {
  realm1: { title: 'Colorful Worlds' },
  realm2: { title: 'Rainbow Deathstar' },
  realm3: { title: 'BubbleFairy' },
  realm4: { title: 'Mind Body n Soul' },
};
function printUrl(realmKey) {
  const t = (REALM_PRINT[realmKey] && REALM_PRINT[realmKey].title) || '';
  return SHOP_BASE + '/search?q=' + encodeURIComponent(t);
}

const ECHOES_PER_REALM = 5;
const TOTAL_ECHOES = REALM_DEFS.length * ECHOES_PER_REALM;
/* The sound room (build 12): a 5th portal and a social space, NOT a
   progression realm — no echoes, no attunement, so none of the
   REALM_DEFS-based math (echo totals, unlock thresholds, prints) moves. */
const SOUND_DEF = { key: 'soundroom', name: 'SOUND ROOM', accent: 0xffc24d, root: 98.0 };
const SOUND_ROOM_KEY = SOUND_DEF.key; // world key used by goTo()
const NEXUS_BOUND = 40;       // horizontal leash in the hub
const PORTAL_TRIGGER = 3.0;   // wisp-to-portal distance that teleports
const ECHO_TRIGGER = 2.6;     // wisp-to-echo distance that collects
const MAX_REMOTE = 15;        // cap on rendered remote wisps

/* ---------------- dom ---------------- */

const canvas      = document.getElementById('scene');
const fadeEl      = document.getElementById('fade');
const titleCardEl = document.getElementById('title-card');
const attunedEl   = document.getElementById('attuned');
const realmNameEl = document.getElementById('realm-name');
const echoCountEl = document.getElementById('echo-counter');
const hintEl      = document.getElementById('controls-hint');
const muteEl      = document.getElementById('mute-label');
const loadingEl   = document.getElementById('loading');
const overlayEl   = document.getElementById('start-overlay');
const driftBtn    = document.getElementById('drift-btn');
const joyBase     = document.getElementById('joy-base');
const joyKnob     = document.getElementById('joy-knob');
const nameInput   = document.getElementById('name-input');
const chatLog     = document.getElementById('chat-log');
const chatInput   = document.getElementById('chat-input');
const chatSend    = document.getElementById('chat-send');
const chatToggle  = document.getElementById('chat-toggle');
const peerCountEl = document.getElementById('peer-count');
const gearBtn       = document.getElementById('gear-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const soundToggle   = document.getElementById('sound-toggle');
const settingsName  = document.getElementById('settings-name');
const settingsDebug = document.getElementById('settings-debug');
const unlockToastEl = document.getElementById('unlock-toast');
const wispSkinsEl   = document.getElementById('wisp-skins');
const wispHatsEl    = document.getElementById('wisp-hats');
const wispTrailStylesEl = document.getElementById('wisp-trail-styles');
const wispTrailColorsEl = document.getElementById('wisp-trail-colors');
const printsListEl  = document.getElementById('prints-list');
const friendsListEl   = document.getElementById('friends-list');
const friendsLiveEl   = document.getElementById('friends-live');
const friendAddInput  = document.getElementById('friend-add-input');
const friendAddBtn    = document.getElementById('friend-add-btn');

/* ---------------- multiplayer state ---------------- */

const net = new LimboNet();
const peerLayer = new THREE.Group(); // remote wisps, re-parented per scene
const peerVisuals = new Map();       // peerId -> {group, bob, tag, target, name, phase}
let myName = 'drifter';
let started = false;                 // true once past the start overlay
let chatFocused = false;
let netTimer = 0;
try { myName = localStorage.getItem('limbo_name') || 'drifter'; } catch (e) { /* ignore */ }
if (nameInput && myName !== 'drifter') nameInput.value = myName;

function roomKeyFor(worldKey) {
  if (worldKey === 'nexus') return 'limbo-nexus';
  if (worldKey === SOUND_ROOM_KEY) return 'limbo-realm-5';
  return 'limbo-realm-' + worldKey.replace('realm', '');
}

/* ---------------- tiny utils ---------------- */

// Deterministic RNG so echo layouts are stable between visits.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Soft radial glow texture, tinted per-use via material color.
function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// Floating text sprite (portal labels). Thin, tracked, elegant.
function makeLabel(text, size = 44) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = `300 ${size}px system-ui, -apple-system, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  try { g.letterSpacing = '14px'; } catch (e) { /* older browsers */ }
  g.fillStyle = 'rgba(235,240,255,0.85)';
  g.shadowColor = 'rgba(150,190,255,0.8)';
  g.shadowBlur = 18;
  g.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(9, 2.25, 1);
  return sp;
}

/* ---------------- renderer / camera ---------------- */

// If WebGL is unavailable (old browser, headless test rig) the constructor
// throws — show a message instead of leaving a dead "loading…" screen.
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (err) {
  loadingEl.firstElementChild.textContent = 'limbo needs WebGL — try another browser';
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 600);
const clock = new THREE.Clock();
const glowTex = makeGlowTexture();
const audio = new AudioEngine();

/* ---------------- player: the wisp ---------------- */

const wisp = new THREE.Group();
const wispCore = new THREE.Mesh(
  new THREE.SphereGeometry(0.32, 20, 14),
  new THREE.MeshBasicMaterial({ color: 0xeaf6ff })
);
const wispGlow = new THREE.Sprite(
  new THREE.SpriteMaterial({ map: glowTex, color: 0x9fd8ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
);
wispGlow.scale.set(3.2, 3.2, 1);
const wispLight = new THREE.PointLight(0xaad4ff, 50, 45, 1.8);
wisp.add(wispCore, wispGlow, wispLight);

const vel = new THREE.Vector3();   // wisp velocity (dreamy inertia)
let yaw = 0, pitch = -0.05;        // look direction

/* ---------------- trails ----------------
   Three earnable styles, all cheap CPU point buffers with additive
   blending (head bright -> tail black = invisible):
   - ribbon: the classic fading point trail (default)
   - comet: sparkles emitted along the path that drift and fade out
   - ghost: two wide soft ribbons weaving side to side (dreamy)
   makeTrail(n, sizeScale) -> { group, setStyle, setColor, update, clear }.
   The local wisp gets a full 60-segment trail; remote drifters get a
   shorter 24-segment one (hidden beyond 150m for perf). */

const TRAIL_STYLES = {
  ribbon: { name: 'Ribbon', req: null },
  comet:  { name: 'Comet',  req: 'collect 10 echoes' },
  ghost:  { name: 'Ghost',  req: 'attune 2 realms' },
};
const TRAIL_COLORS = {
  white: { name: 'Moonlight', hex: 0xbfe2ff, req: null },
  prism: { name: 'Prism',     hex: 0xff4fd8, req: 'attune PRISM DEEP' },
  tide:  { name: 'Tide',      hex: 0x7a5cff, req: 'attune MIRROR TIDE' },
  volt:  { name: 'Volt',      hex: 0x37e6ff, req: 'attune CHROME VEIL' },
  sage:  { name: 'Sage',      hex: 0x2dffb3, req: 'attune STILL POINT' },
  gold:  { name: 'Gold',      hex: 0xffe9a8, req: 'attune all 4 realms' },
};
const TRAIL_STYLE_ORDER = ['ribbon', 'comet', 'ghost'];
const TRAIL_COLOR_ORDER = ['white', 'prism', 'tide', 'volt', 'sage', 'gold'];
const REALM_TRAIL_COLOR = { realm1: 'prism', realm2: 'tide', realm3: 'volt', realm4: 'sage' };

function makeTrail(n, sizeScale) {
  const group = new THREE.Group();
  const color = new THREE.Color(0xbfe2ff);
  let style = 'ribbon';

  function fadeInto(arr) {
    for (let i = 0; i < n; i++) {
      const f = Math.pow(i / (n - 1), 1.6); // i=0 tail .. i=n-1 head
      arr[i * 3] = color.r * f;
      arr[i * 3 + 1] = color.g * f;
      arr[i * 3 + 2] = color.b * f;
    }
  }
  function ribbonPoints(size, opacity) {
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    fadeInto(col);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size: size * sizeScale, vertexColors: true, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.frustumCulled = false;
    return { pts, pos, col, geo };
  }

  const R = ribbonPoints(0.45, 0.85);          // ribbon style
  const G1 = ribbonPoints(0.9, 0.35);          // ghost: left weave
  const G2 = ribbonPoints(0.9, 0.35);          // ghost: right weave

  // comet: n sparkles, each with velocity + remaining life
  const cPos = new Float32Array(n * 3), cCol = new Float32Array(n * 3);
  const cVel = new Float32Array(n * 3), cLife = new Float32Array(n);
  const COMET_LIFE = 0.9;
  let cCursor = 0, cEmitT = 0;
  const cGeo = new THREE.BufferGeometry();
  cGeo.setAttribute('position', new THREE.BufferAttribute(cPos, 3));
  cGeo.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
  const comet = new THREE.Points(cGeo, new THREE.PointsMaterial({
    size: 0.3 * sizeScale, vertexColors: true, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  comet.frustumCulled = false;

  group.add(R.pts, G1.pts, G2.pts, comet);

  let pushT = 0, tG = 0;

  function pushRibbon(P, x, y, z) {
    P.pos.copyWithin(0, 3); // drop oldest
    const o = (n - 1) * 3;
    P.pos[o] = x; P.pos[o + 1] = y; P.pos[o + 2] = z;
    P.geo.attributes.position.needsUpdate = true;
  }

  function setStyle(s) {
    style = TRAIL_STYLES[s] ? s : 'ribbon';
    R.pts.visible = style === 'ribbon';
    comet.visible = style === 'comet';
    G1.pts.visible = G2.pts.visible = style === 'ghost';
  }
  function setColor(hex) {
    color.setHex(hex);
    for (const P of [R, G1, G2]) { fadeInto(P.col); P.geo.attributes.color.needsUpdate = true; }
    // comet particles re-tint live from `color` as they fade
  }
  function clear(pos) {
    for (const P of [R, G1, G2]) {
      for (let i = 0; i < n; i++) { P.pos[i * 3] = pos.x; P.pos[i * 3 + 1] = pos.y; P.pos[i * 3 + 2] = pos.z; }
      P.geo.attributes.position.needsUpdate = true;
    }
    cLife.fill(0); cCol.fill(0);
    cGeo.attributes.position.needsUpdate = true;
    cGeo.attributes.color.needsUpdate = true;
  }
  function update(pos, dt) {
    tG += dt;
    if (style === 'ribbon') {
      pushT += dt;
      if (pushT < 0.035) return;
      pushT = 0;
      pushRibbon(R, pos.x, pos.y, pos.z);
    } else if (style === 'comet') {
      cEmitT += dt;
      while (cEmitT > 0.05) {
        cEmitT -= 0.05;
        const i = cCursor; cCursor = (cCursor + 1) % n;
        cPos[i * 3] = pos.x; cPos[i * 3 + 1] = pos.y; cPos[i * 3 + 2] = pos.z;
        const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.4;
        cVel[i * 3] = Math.cos(a) * sp;
        cVel[i * 3 + 1] = (Math.random() - 0.2) * 1.2;
        cVel[i * 3 + 2] = Math.sin(a) * sp;
        cLife[i] = COMET_LIFE;
      }
      const drag = Math.max(0, 1 - dt * 1.5);
      for (let i = 0; i < n; i++) {
        if (cLife[i] <= 0) continue;
        cLife[i] -= dt;
        const f = Math.max(cLife[i], 0) / COMET_LIFE;
        cPos[i * 3] += cVel[i * 3] * dt;
        cPos[i * 3 + 1] += cVel[i * 3 + 1] * dt;
        cPos[i * 3 + 2] += cVel[i * 3 + 2] * dt;
        cVel[i * 3] *= drag; cVel[i * 3 + 1] *= drag; cVel[i * 3 + 2] *= drag;
        cCol[i * 3] = color.r * f; cCol[i * 3 + 1] = color.g * f; cCol[i * 3 + 2] = color.b * f;
      }
      cGeo.attributes.position.needsUpdate = true;
      cGeo.attributes.color.needsUpdate = true;
    } else { // ghost: two soft ribbons with a slow lateral weave
      pushT += dt;
      if (pushT < 0.05) return;
      pushT = 0;
      const wx = Math.cos(tG * 1.3) * 0.55, wz = Math.sin(tG * 1.3) * 0.55;
      pushRibbon(G1, pos.x + wx, pos.y, pos.z + wz);
      pushRibbon(G2, pos.x - wx, pos.y, pos.z - wz);
    }
  }

  setStyle('ribbon');
  return { group, setStyle, setColor, update, clear, getStyle: () => style };
}

// Local trail (full length). Thin wrappers keep the old call sites working.
const localTrail = makeTrail(60, 1);
function retintTrail(hex) { localTrail.setColor(hex); }
function clearTrail() { localTrail.clear(wisp.position); }
function pushTrail(dt) { localTrail.update(wisp.position, dt); }

/* ---------------- wisp customization: skins & hats ----------------
   Attuning a realm (all 5 echoes) unlocks cosmetics. Unlocks + equipped
   look persist in localStorage; the equipped look broadcasts to other
   drifters ~12Hz so remote wisps render with the right skin + hat. */

const SKINS = {
  drifter:    { name: 'Drifter',    core: 0xeaf6ff, glow: 0x9fd8ff, light: 0xaad4ff, trail: 0xbfe2ff, req: null },
  prism:      { name: 'Prism',      core: 0xffd9f2, glow: 0xff4fd8, light: 0xff4fd8, trail: 0xff8fdc, req: 'attune PRISM DEEP' },
  tide:       { name: 'Tide',       core: 0xded4ff, glow: 0x7a5cff, light: 0x7a5cff, trail: 0x9d86ff, req: 'attune MIRROR TIDE' },
  volt:       { name: 'Volt',       core: 0xd4f7ff, glow: 0x37e6ff, light: 0x37e6ff, trail: 0x6fe8ff, req: 'attune CHROME VEIL' },
  sage:       { name: 'Sage',       core: 0xd6ffea, glow: 0x2dffb3, light: 0x2dffb3, trail: 0x66ffbe, req: 'attune STILL POINT' },
  voidwalker: { name: 'Voidwalker', core: 0xfff9e8, glow: 0xffe9a8, light: 0xffdf8a, trail: 0xffe9a8, req: 'attune all 4 realms' },
};
const HATS = {
  none:  { name: 'Bare',      req: null },
  party: { name: 'Party Hat', req: 'attune 1 realm' },
  top:   { name: 'Top Hat',   req: 'attune 2 realms' },
  crown: { name: 'Crown',     req: 'attune all 4 realms' },
};
const REALM_SKIN = { realm1: 'prism', realm2: 'tide', realm3: 'volt', realm4: 'sage' };
const SKIN_ORDER = ['drifter', 'prism', 'tide', 'volt', 'sage', 'voidwalker'];
const HAT_ORDER = ['none', 'party', 'top', 'crown'];

// limbo_unlocks: { attuned:[realmKeys], skins:[ids], hats:[ids], trailStyles:[ids], trailColors:[ids] }
// limbo_wisp:   { skin, hat, trailStyle, trailColor } — equipped look
function loadUnlocks() {
  const d = { attuned: [], skins: ['drifter'], hats: [], trailStyles: ['ribbon'], trailColors: ['white'] };
  try {
    const raw = JSON.parse(localStorage.getItem('limbo_unlocks') || 'null');
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.attuned)) d.attuned = raw.attuned.filter((k) => REALM_DEFS.some((r) => r.key === k));
      if (Array.isArray(raw.skins)) d.skins = ['drifter', ...raw.skins.filter((s) => SKINS[s] && s !== 'drifter')];
      if (Array.isArray(raw.hats)) d.hats = raw.hats.filter((h) => HATS[h] && h !== 'none');
      if (Array.isArray(raw.trailStyles)) d.trailStyles = ['ribbon', ...raw.trailStyles.filter((t) => TRAIL_STYLES[t] && t !== 'ribbon')];
      if (Array.isArray(raw.trailColors)) d.trailColors = ['white', ...raw.trailColors.filter((t) => TRAIL_COLORS[t] && t !== 'white')];
    }
  } catch (e) { /* ignore — defaults */ }
  return d;
}
function saveUnlocks() {
  try { localStorage.setItem('limbo_unlocks', JSON.stringify(unlocks)); } catch (e) { /* ignore */ }
}
function loadWisp() {
  const d = { skin: 'drifter', hat: 'none', trailStyle: 'ribbon', trailColor: 'white' };
  try {
    const raw = JSON.parse(localStorage.getItem('limbo_wisp') || 'null');
    if (raw && SKINS[raw.skin]) d.skin = raw.skin;
    if (raw && HATS[raw.hat]) d.hat = raw.hat;
    if (raw && TRAIL_STYLES[raw.trailStyle]) d.trailStyle = raw.trailStyle;
    if (raw && TRAIL_COLORS[raw.trailColor]) d.trailColor = raw.trailColor;
  } catch (e) { /* ignore — defaults */ }
  return d;
}
function saveWisp() {
  try { localStorage.setItem('limbo_wisp', JSON.stringify(equipped)); } catch (e) { /* ignore */ }
}
let unlocks = loadUnlocks();
let equipped = loadWisp();

function applySkin(skinId) {
  const s = SKINS[skinId] || SKINS.drifter;
  wispCore.material.color.setHex(s.core);
  wispGlow.material.color.setHex(s.glow);
  wispLight.color.setHex(s.light);
  // Trail color is its own customization now (applyTrail) — skins no longer re-tint it.
}

// Dress the local trail in the equipped style + color.
function applyTrail() {
  localTrail.setStyle(equipped.trailStyle);
  const c = TRAIL_COLORS[equipped.trailColor] || TRAIL_COLORS.white;
  localTrail.setColor(c.hex);
}

function buildHat(hatId) {
  const g = new THREE.Group();
  if (hatId === 'party') {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.5, 20),
      new THREE.MeshBasicMaterial({ color: 0xff4fd8 })
    );
    cone.position.y = 0.25;
    const pompom = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
    );
    pompom.position.y = 0.53;
    g.add(cone, pompom);
  } else if (hatId === 'top') {
    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.05, 24),
      new THREE.MeshBasicMaterial({ color: 0x1a1d26 })
    );
    const crownM = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.42, 24),
      new THREE.MeshBasicMaterial({ color: 0x23262f })
    );
    crownM.position.y = 0.23;
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.205, 0.205, 0.08, 24),
      new THREE.MeshBasicMaterial({ color: 0x7a5cff })
    );
    band.position.y = 0.07;
    g.add(brim, crownM, band);
  } else if (hatId === 'crown') {
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.24, 0.26, 0.18, 24),
      new THREE.MeshBasicMaterial({ color: 0xd9a441 })
    );
    band.position.y = 0.09;
    g.add(band);
    for (let i = 0; i < 6; i++) {
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.055, 0.22, 8),
        new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
      );
      const a = (i / 6) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.22, 0.28, Math.sin(a) * 0.22);
      g.add(spike);
    }
  }
  return g;
}

let wispHat = null;
function applyHat(hatId) {
  if (wispHat) { wisp.remove(wispHat); wispHat = null; }
  if (hatId && hatId !== 'none' && HATS[hatId]) {
    wispHat = buildHat(hatId);
    wispHat.position.y = 0.42; // sits atop the 0.32-radius core
    wisp.add(wispHat);
  }
}

function showUnlockToast(lines) {
  if (!unlockToastEl || !lines.length) return;
  unlockToastEl.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    unlockToastEl.appendChild(div);
  }
  unlockToastEl.classList.remove('show');
  void unlockToastEl.offsetWidth; // restart CSS animation
  unlockToastEl.classList.add('show');
}

// Called the moment a realm attunes (all 5 echoes). Grants are idempotent —
// re-attuning across sessions replays the shimmer but not the unlock toast.
function onRealmAttuned(realmKey, realmName) {
  const isNew = !unlocks.attuned.includes(realmKey);
  if (isNew) unlocks.attuned.push(realmKey);
  const fresh = [];
  const skinId = REALM_SKIN[realmKey];
  if (skinId && !unlocks.skins.includes(skinId)) {
    unlocks.skins.push(skinId);
    fresh.push(`${SKINS[skinId].name} skin unlocked`);
  }
  const n = unlocks.attuned.length;
  for (const [hatId, need] of [['party', 1], ['top', 2], ['crown', 4]]) {
    if (n >= need && !unlocks.hats.includes(hatId)) {
      unlocks.hats.push(hatId);
      fresh.push(`${HATS[hatId].name} unlocked`);
    }
  }
  if (n >= 4 && !unlocks.skins.includes('voidwalker')) {
    unlocks.skins.push('voidwalker');
    fresh.push('Voidwalker skin unlocked');
  }
  const tc = REALM_TRAIL_COLOR[realmKey];
  if (tc && !unlocks.trailColors.includes(tc)) {
    unlocks.trailColors.push(tc);
    fresh.push(`${TRAIL_COLORS[tc].name} trail unlocked`);
  }
  if (n >= 2 && !unlocks.trailStyles.includes('ghost')) {
    unlocks.trailStyles.push('ghost');
    fresh.push('Ghost trail unlocked');
  }
  if (n >= 4 && !unlocks.trailColors.includes('gold')) {
    unlocks.trailColors.push('gold');
    fresh.push('Gold trail unlocked');
  }
  saveUnlocks();
  if (fresh.length) {
    const printTitle = (REALM_PRINT[realmKey] && REALM_PRINT[realmKey].title) || '';
    const lines = [`${realmName} attuned`, ...fresh];
    if (printTitle) lines.push(`own "${printTitle}" — PRINTS in settings`);
    showUnlockToast(lines);
    addSystemLine(`${realmName} attuned — ${fresh.join(' · ').toLowerCase()}`);
  }
  renderWispSection();
  renderPrintsSection();
}

// Settings panel "WISP" section: skin swatches + hat buttons + trail styles
// + trail colors. Locked items show their requirement; tapping an owned
// item equips it immediately.
function renderWispSection() {
  if (!wispSkinsEl || !wispHatsEl || !wispTrailStylesEl || !wispTrailColorsEl) return;
  wispSkinsEl.innerHTML = '';
  for (const id of SKIN_ORDER) {
    const s = SKINS[id];
    const owned = unlocks.skins.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-swatch' + (equipped.skin === id ? ' equipped' : '') + (owned ? '' : ' locked');
    const hex = '#' + s.glow.toString(16).padStart(6, '0');
    b.style.setProperty('--sw', owned ? hex : '#3a4152');
    b.title = owned ? s.name : `${s.name} — ${s.req}`;
    b.setAttribute('aria-label', b.title);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = owned ? s.name : s.req;
    b.append(dot, lbl);
    if (owned) b.addEventListener('click', () => {
      equipped.skin = id; saveWisp(); applySkin(id); renderWispSection(); b.blur();
    });
    wispSkinsEl.appendChild(b);
  }
  wispHatsEl.innerHTML = '';
  for (const id of HAT_ORDER) {
    const h = HATS[id];
    const owned = id === 'none' || unlocks.hats.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-hat' + (equipped.hat === id ? ' equipped' : '') + (owned ? '' : ' locked');
    b.title = owned ? h.name : `${h.name} — ${h.req}`;
    b.setAttribute('aria-label', b.title);
    b.textContent = owned ? h.name : h.req;
    if (owned) b.addEventListener('click', () => {
      equipped.hat = id; saveWisp(); applyHat(id); renderWispSection(); b.blur();
    });
    wispHatsEl.appendChild(b);
  }
  wispTrailStylesEl.innerHTML = '';
  for (const id of TRAIL_STYLE_ORDER) {
    const ts = TRAIL_STYLES[id];
    const owned = unlocks.trailStyles.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-hat' + (equipped.trailStyle === id ? ' equipped' : '') + (owned ? '' : ' locked');
    b.title = owned ? ts.name : `${ts.name} — ${ts.req}`;
    b.setAttribute('aria-label', b.title);
    b.textContent = owned ? ts.name : ts.req;
    if (owned) b.addEventListener('click', () => {
      equipped.trailStyle = id; saveWisp(); applyTrail(); renderWispSection(); b.blur();
    });
    wispTrailStylesEl.appendChild(b);
  }
  wispTrailColorsEl.innerHTML = '';
  for (const id of TRAIL_COLOR_ORDER) {
    const tc = TRAIL_COLORS[id];
    const owned = unlocks.trailColors.includes(id);
    const b = document.createElement('button');
    b.className = 'wisp-swatch' + (equipped.trailColor === id ? ' equipped' : '') + (owned ? '' : ' locked');
    const hex = '#' + tc.hex.toString(16).padStart(6, '0');
    b.style.setProperty('--sw', owned ? hex : '#3a4152');
    b.title = owned ? tc.name : `${tc.name} — ${tc.req}`;
    b.setAttribute('aria-label', b.title);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = owned ? tc.name : tc.req;
    b.append(dot, lbl);
    if (owned) b.addEventListener('click', () => {
      equipped.trailColor = id; saveWisp(); applyTrail(); renderWispSection(); b.blur();
    });
    wispTrailColorsEl.appendChild(b);
  }
}

// Settings panel "PRINTS" section: each realm's artwork as a real giclée
// print. Attuned realms get a small ✓. Buttons open the shop in a new tab.
function renderPrintsSection() {
  if (!printsListEl) return;
  printsListEl.innerHTML = '';
  for (const r of REALM_DEFS) {
    const p = REALM_PRINT[r.key];
    if (!p) continue;
    const row = document.createElement('div');
    row.className = 'print-row';
    const dot = document.createElement('span');
    dot.className = 'print-dot';
    dot.style.background = '#' + r.accent.toString(16).padStart(6, '0');
    const label = document.createElement('span');
    label.className = 'print-title';
    const attuned = unlocks.attuned.includes(r.key);
    label.textContent = (attuned ? '✓ ' : '') + p.title;
    const btn = document.createElement('button');
    btn.className = 'print-btn';
    btn.textContent = 'own the print';
    btn.addEventListener('click', () => {
      window.open(printUrl(r.key), '_blank', 'noopener');
      btn.blur();
    });
    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(btn);
    printsListEl.appendChild(row);
  }
}

/* ---------------- friends + live presence (build 11) ----------------
   Friends are just names in localStorage ('limbo_friends'). "Live" means
   we recently heard their heartbeat in the lobby room. The join button
   portals to their realm through the same goTo() the Nexus portals use. */

let friends = [];
try {
  const rawFriends = JSON.parse(localStorage.getItem('limbo_friends') || '[]');
  if (Array.isArray(rawFriends)) {
    friends = rawFriends
      .filter((n) => typeof n === 'string')
      .map((n) => n.trim().slice(0, 16))
      .filter(Boolean);
  }
} catch (e) { friends = []; }
function saveFriends() {
  try { localStorage.setItem('limbo_friends', JSON.stringify(friends)); } catch (e) { /* ignore */ }
}
function addFriend(name) {
  const clean = String(name || '').trim().slice(0, 16);
  if (!clean) return false;
  const lc = clean.toLowerCase();
  if (lc === myName.toLowerCase()) return false; // adding yourself is a no-op
  if (friends.some((f) => f.toLowerCase() === lc)) return false; // no duplicates
  friends.push(clean);
  saveFriends();
  renderFriendsSection();
  return true;
}
function removeFriend(name) {
  const lc = String(name || '').toLowerCase();
  const before = friends.length;
  friends = friends.filter((f) => f.toLowerCase() !== lc);
  if (friends.length !== before) { saveFriends(); renderFriendsSection(); }
}

// Freshest heartbeat wins when two drifters share a name.
function livePresenceFor(name) {
  const lc = String(name || '').toLowerCase();
  let best = null;
  for (const [pid, p] of net.lobbyPeers) {
    if (String(p.name).toLowerCase() === lc && (!best || p.lastSeen > best.lastSeen)) {
      best = { peerId: pid, name: p.name, room: p.room, dj: p.dj || null, lastSeen: p.lastSeen };
    }
  }
  return best;
}
function realmDisplayName(key) {
  if (key === 'nexus') return NEXUS_DEF.name;
  if (key === SOUND_ROOM_KEY) return SOUND_DEF.name;
  const d = REALM_DEFS.find((r) => r.key === key);
  return d ? d.name : String(key || '').toUpperCase();
}

function renderFriendsSection() {
  if (!friendsListEl) return;
  friendsListEl.innerHTML = '';
  const rows = friends.map((name) => ({ name, live: livePresenceFor(name) }));
  rows.sort((a, b) =>
    (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  let liveCount = 0;
  for (const { name, live } of rows) {
    if (live) liveCount++;
    const row = document.createElement('div');
    row.className = 'friend-row';
    const dot = document.createElement('span');
    dot.className = 'friend-dot' + (live ? ' live' : '');
    const nm = document.createElement('span');
    nm.className = 'friend-name';
    nm.textContent = name;
    row.appendChild(dot);
    row.appendChild(nm);
    if (live) {
      const where = document.createElement('span');
      where.className = 'friend-realm';
      // A DJing friend shows "on the decks" instead of the room name.
      where.textContent = live.dj ? '\u{1F534} on the decks' : realmDisplayName(live.room);
      const join = document.createElement('button');
      join.className = 'friend-join';
      join.textContent = 'join';
      join.setAttribute('aria-label', `join ${name} in ${realmDisplayName(live.room)}`);
      join.addEventListener('click', () => {
        setSettings(false);
        goTo(live.room);
        join.blur();
      });
      row.appendChild(where);
      row.appendChild(join);
    }
    const x = document.createElement('button');
    x.className = 'friend-remove';
    x.textContent = '×';
    x.setAttribute('aria-label', `remove ${name} from friends`);
    x.addEventListener('click', () => { removeFriend(name); x.blur(); });
    row.appendChild(x);
    friendsListEl.appendChild(row);
  }
  if (friendsLiveEl) friendsLiveEl.textContent = liveCount > 0 ? `— ${liveCount} drifting now` : '';
}

/* ---------------- sound room: DJ slot + listeners (build 12) ----------------
   One DJ at a time. The DJ shares desktop audio (Chrome tab share); the
   room claims resolve through net's djClaim channel (earliest fresh claim
   wins) and the audio rides Trystero's media API (addTrack/onPeerTrack).
   Listeners hear the same room-wide mix. An analyser on either side feeds
   the room's bass-reactive lights. */

const djLineEl = document.getElementById('dj-line');
const decksBtn = document.getElementById('decks-btn');

const dj = {
  active: false,      // WE hold the decks
  stream: null,       // our captured desktop audio (DJ side)
  track: null,
  node: null,         // DJ-side analyser source node
  analyser: null,
  analyserData: null,
  listenPeerId: null, // whose track we're hearing (listener side)
  listenNode: null,
  listenAnalyser: null,
  listenAnalyserData: null,
  listenAudioEl: null,
};
let djBassSmooth = 0; // 0..1, eased — drives the room pulse
let djAudioRetryArmed = false;

/* Small FFT on a stream; the room only cares about bass. Reuses the game's
   AudioContext when the generative engine is running. */
function makeAnalyserFor(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    try { ctx = audio.ctx || null; } catch (e) {}
    if (!ctx) {
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const node = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64; // 32 bins; bass lives in the first few
    node.connect(analyser);
    return { node, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
  } catch (e) {
    return null;
  }
}

function detachDjAnalyser() {
  if (dj.node) { try { dj.node.disconnect(); } catch (e) {} dj.node = null; }
  dj.analyser = null;
  dj.analyserData = null;
}

/* Listener side: play the DJ's stream room-wide (not spatialized). */
function attachDjListener(stream) {
  detachDjListener();
  const el = document.createElement('audio');
  el.srcObject = stream;
  el.autoplay = true;
  el.playsInline = true;
  try { el.muted = audio.muted; } catch (e) {}
  dj.listenAudioEl = el;
  const a = makeAnalyserFor(stream);
  if (a) {
    dj.listenNode = a.node;
    dj.listenAnalyser = a.analyser;
    dj.listenAnalyserData = a.data;
  }
  const tryPlay = () => el.play().catch(() => {
    // Autoplay policy: wait for the next gesture, then try again.
    if (djAudioRetryArmed) return;
    djAudioRetryArmed = true;
    const retry = () => {
      djAudioRetryArmed = false;
      window.removeEventListener('pointerdown', retry);
      if (dj.listenAudioEl === el) tryPlay();
    };
    window.addEventListener('pointerdown', retry);
  });
  tryPlay();
}

function detachDjListener() {
  if (dj.listenAudioEl) {
    try { dj.listenAudioEl.pause(); } catch (e) {}
    dj.listenAudioEl.srcObject = null;
    dj.listenAudioEl = null;
  }
  if (dj.listenNode) { try { dj.listenNode.disconnect(); } catch (e) {} dj.listenNode = null; }
  dj.listenAnalyser = null;
  dj.listenAnalyserData = null;
  dj.listenPeerId = null;
}

/* Earliest fresh claim wins — ours included when we hold the decks. */
function djWinner() {
  let best = null;
  if (net.myDjClaim) best = { name: myName, isSelf: true, t: net.myDjClaim.t };
  for (const [pid, c] of net.djClaims) {
    if (!best || c.t < best.t) best = { name: c.name, isSelf: false, peerId: pid, t: c.t };
  }
  return best;
}

function renderDjHud() {
  const inRoom = !!(active && active.key === SOUND_ROOM_KEY);
  if (jamBtn) jamBtn.style.display = inRoom ? '' : 'none';
  if (decksBtn) {
    decksBtn.style.display = inRoom ? '' : 'none';
    if (inRoom) decksBtn.textContent = dj.active ? 'leave the decks' : 'take the decks';
  }
  if (!djLineEl) return;
  if (!inRoom) {
    djLineEl.textContent = '';
    djLineEl.style.display = 'none';
    return;
  }
  const w = djWinner();
  if (w) {
    const n = net.peers.size + 1;
    djLineEl.textContent = `\u{1F3A7} ${w.name} is on the decks \u00B7 ${n} listening`;
  } else {
    djLineEl.textContent = 'the decks are open';
  }
  djLineEl.style.display = '';
}

async function takeDecks() {
  if (dj.active) return true;
  if (!active || active.key !== SOUND_ROOM_KEY) return false;
  const coarse = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  const gdm = navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia;
  if (!gdm) {
    const note = coarse
      ? 'the decks need desktop Chrome \u2014 phones are for listening \u{1F3A7}'
      : 'this browser can\u2019t share tab audio \u2014 the decks stay open';
    showUnlockToast([note]);
    addSystemLine(note);
    return false;
  }
  let disp;
  try {
    // Video is requested for the picker UI on some browsers; stopped at once.
    disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    addSystemLine('the decks stay open \u2014 screen share was dismissed');
    return false;
  }
  try {
    const vids = disp.getVideoTracks ? disp.getVideoTracks() : [];
    vids.forEach((v) => { try { v.stop(); } catch (e) {} });
  } catch (e) {}
  const auds = disp.getAudioTracks ? disp.getAudioTracks() : [];
  const track = auds[0];
  if (!track) {
    addSystemLine('no audio came through \u2014 share a tab with sound playing');
    return false;
  }
  dj.stream = disp;
  dj.track = track;
  dj.active = true;
  const a = makeAnalyserFor(disp);
  if (a) { dj.node = a.node; dj.analyser = a.analyser; dj.analyserData = a.data; }
  track.onended = () => stopDecks(); // user stopped sharing from the browser UI
  if (net.enabled) {
    net.djStart(track, disp);
    net.setDj(SOUND_ROOM_KEY); // friends see "on the decks" in the lobby heartbeat
  }
  jamOnBecomeDj(); // start the shared beat clock (broadcasts only when net is up)
  addSystemLine('you\u2019re on the decks \u2014 share a tab with music playing');
  renderDjHud();
  renderFriendsSection();
  return true;
}

function stopDecks(yielded = false, byName = '') {
  if (!dj.active) return;
  dj.active = false;
  jamStopClock(); // the grid dies with the DJ — a new DJ starts a fresh one
  jamStopRecorder(); // the sampler's ring buffer dies with the stream
  detachDjAnalyser();
  try { if (dj.track) dj.track.stop(); } catch (e) {}
  dj.track = null;
  dj.stream = null;
  net.djStop(); // release the claim + pull the track
  net.setDj(null);
  if (yielded && byName) {
    showUnlockToast([`${byName} took the decks`]);
    addSystemLine(`${byName} took the decks`);
  } else if (!yielded) {
    addSystemLine('you stepped away from the decks');
  }
  renderDjHud();
  renderFriendsSection();
}

/* ---------------- jam room (build 13) ----------------
   The sound room becomes a jam space. THE CORE TRICK: instrument audio
   is never streamed — the internet can't do real-time jam latency
   (~500ms round trips). Instead, tiny note/pad events ride Trystero's
   data channel and EVERY client synthesizes the sound locally with
   WebAudio, scheduled against a shared beat clock. Your own notes play
   instantly (zero latency for you); everyone else's land quantized on
   the grid. It feels tight because the timing happens on-device.

   Protocol (sound-room room only, fire-and-forget):
     jamClock {bpm, startWall, by}  — DJ -> room. startWall is a
       Date.now() epoch for beat 0; beat = (now - startWall) * bpm/60000.
       Re-broadcast on BPM change, DJ takeover, and every 15s while
       DJing (keeps late joiners on the grid).
     jamNote {n, midi, vel, beat, w, c, r} — any jammer -> room. beat is
       the target beat on the shared clock (null = free-time, play now).
       w/c/r carry the sender's patch (wave, cutoff, resonance) so every
       client renders the same timbre. v1 choice: patch rides each note
       (3 tiny fields) instead of a separate jamPatch message.
     jamPad {n, pad, beat, lenBars} — pad trigger. The loop audio itself
       is NEVER sent: every client grabs its own local copy of the same
       DJ stream (see the ring buffer below), so triggers quantized to
       the bar stay musical within network jitter. Honest v1.

   The DJ is the clock master. No DJ -> clock stopped; the synth still
   plays free-time locally (heard by all, unsynced). */

const jamBtn = document.getElementById('jam-btn');
const jamPanel = document.getElementById('jam-panel');
const jamCloseBtn = document.getElementById('jam-close');
const jamBpmEl = document.getElementById('jam-bpm');
const jamClockDotEl = document.getElementById('jam-clock-dot');
const jamClockStatusEl = document.getElementById('jam-clock-status');
const jamTapEl = document.getElementById('jam-tap');
const jamBpmDownEl = document.getElementById('jam-bpm-down');
const jamBpmUpEl = document.getElementById('jam-bpm-up');
const jamKeysEl = document.getElementById('jam-keys');
const jamGrabEl = document.getElementById('jam-grab');
const jamPadsEl = document.getElementById('jam-pads');
const jamHintEl = document.getElementById('jam-hint');
const jamJammersEl = document.getElementById('jam-jammers');

const jam = {
  open: false,
  bpm: 120,
  startWall: null, // Date.now() epoch of beat 0; null = clock stopped
  clockBy: null, // whose clock we're following
  manual: false, // DJ overrode BPM this session (auto-detect paused)
  wave: 'sawtooth',
  cutoff: 1800,
  reso: 5,
  pads: [null, null, null, null], // AudioBuffers, local to this client
  padRound: 0, // next pad to fill on grab (round-robin)
  rec: null, // ring-buffer recorder on the DJ stream
  jammers: new Map(), // name -> last note/pad timestamp (30s window)
  detector: null, // OnsetDetector, while we're the DJ
  detStable: 0,
  detLast: null,
};
const jamQueue = []; // pending {beat, play(audioTime)} — the lookahead scheduler's list
let jamVoicesSpawned = 0; // diagnostic counter for the test hook
let jamTaps = []; // tap-tempo timestamps

/* Current beat on the shared clock, or null when the clock is stopped. */
function jamBeatNow() {
  if (jam.startWall == null) return null;
  return (Date.now() - jam.startWall) * jam.bpm / 60000;
}

/* AudioContext timestamp for a beat. Clamped to "now" — a beat in the
   past (late-arriving event) plays immediately rather than throwing. */
function jamAudioTimeForBeat(beat) {
  const ctx = audio.ctx;
  if (!ctx || jam.startWall == null) return null;
  const wallMs = jam.startWall + (beat * 60000) / jam.bpm;
  return ctx.currentTime + Math.max(0, (wallMs - Date.now()) / 1000);
}

function jamEnqueue(ev) {
  jamQueue.push(ev);
}

/* Lookahead scheduler: every 25ms, schedule any queued event whose time
   falls within the next 120ms. The standard WebAudio pattern — absorbs
   network jitter so remote notes land on the grid. */
function jamSchedulerTick() {
  if (!jamQueue.length) return;
  const ctx = audio.ctx;
  if (!ctx || jamBeatNow() == null) {
    // Clock vanished mid-queue: flush immediately, never strand notes.
    while (jamQueue.length) {
      const ev = jamQueue.shift();
      try { ev.play(ctx ? ctx.currentTime + 0.01 : 0); } catch (e) {}
    }
    return;
  }
  jamQueue.sort((a, b) => a.beat - b.beat);
  const horizon = ctx.currentTime + 0.12;
  while (jamQueue.length) {
    const at = jamAudioTimeForBeat(jamQueue[0].beat);
    if (at == null || at > horizon) break;
    const ev = jamQueue.shift();
    try { ev.play(Math.max(at, ctx.currentTime + 0.005)); } catch (e) {}
  }
}
setInterval(jamSchedulerTick, 25);

/* Render one synth note through the shared-voice builder. Every note
   spawns fresh nodes — no voice stealing, so overlapping notes from
   several jammers just layer. */
function jamRenderNote(midi, vel, audioTime, patch) {
  const ctx = audio.ctx;
  if (!ctx || !audio.master) return;
  jamVoicesSpawned++;
  playSynthNote(ctx, audio.master, {
    midi,
    vel,
    time: audioTime,
    wave: (patch && patch.w) || jam.wave,
    cutoff: (patch && patch.c) || jam.cutoff,
    resonance: (patch && patch.r) || jam.reso,
  });
}

/* YOUR note: plays locally immediately (zero latency for you) and
   broadcasts quantized to the next 16th so the room hears it on-grid. */
function jamPlayLocal(midi, vel = 0.9) {
  const ctx = audio.ctx;
  jamRenderNote(midi, vel, ctx ? ctx.currentTime + 0.01 : 0, null);
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 0.25) : null;
  if (net.enabled && net.sendJamNote && active && active.key === SOUND_ROOM_KEY) {
    try {
      net.sendJamNote({
        n: myName, midi, vel, beat,
        w: jam.wave, c: Math.round(jam.cutoff), r: jam.reso,
      });
    } catch (e) { /* ignore */ }
  }
  jamMarkJammer(myName);
  renderJamJammers();
}

/* Someone else's note: schedule it on the grid (or play now, free-time). */
function handleJamNote(d, peerId) {
  if (!d || !Number.isFinite(Number(d.midi))) return;
  const midi = Math.max(0, Math.min(127, Math.round(Number(d.midi))));
  const vel = Math.max(0.05, Math.min(1.2, Number(d.vel) || 0.9));
  const name = String(d.n || 'drifter').slice(0, 16);
  const beat = d.beat == null ? null : Number(d.beat);
  const patch = {
    w: ['sawtooth', 'square', 'mix'].includes(d.w) ? d.w : 'sawtooth',
    c: Number.isFinite(Number(d.c)) ? Number(d.c) : 1800,
    r: Number.isFinite(Number(d.r)) ? Number(d.r) : 5,
  };
  jamMarkJammer(name);
  renderJamJammers();
  if (beat != null && Number.isFinite(beat) && jamBeatNow() != null) {
    jamEnqueue({ beat, play: (at) => jamRenderNote(midi, vel, at, patch) });
  } else {
    jamRenderNote(midi, vel, audio.ctx ? audio.ctx.currentTime + 0.01 : 0, patch);
  }
}

/* Pad trigger from a peer: play OUR local copy of that loop. Clients
   that never grabbed the loop have nothing in the slot — skipped
   silently. */
function handleJamPad(d, peerId) {
  if (!d || !Number.isInteger(d.pad) || d.pad < 0 || d.pad > 3) return;
  const name = String(d.n || 'drifter').slice(0, 16);
  const buf = jam.pads[d.pad];
  jamMarkJammer(name);
  renderJamJammers();
  if (!buf) return;
  const beat = d.beat == null ? null : Number(d.beat);
  if (beat != null && Number.isFinite(beat) && jamBeatNow() != null) {
    jamEnqueue({ beat, play: (at) => jamPlayPad(d.pad, at) });
  } else if (audio.ctx) {
    jamPlayPad(d.pad, audio.ctx.currentTime + 0.01);
  }
}

/* Clock from the room: only the current DJ's clock counts. Stale clocks
   from a deposed DJ are ignored — the new DJ's grid takes over. */
function handleJamClock(d, peerId) {
  if (!d || !Number.isFinite(Number(d.bpm)) || !Number.isFinite(Number(d.startWall))) return;
  const w = djWinner();
  if (!w || w.isSelf) return; // we never follow our own echo
  if (w.peerId !== peerId) return; // not the DJ's clock
  jam.bpm = Math.max(60, Math.min(200, Number(d.bpm)));
  jam.startWall = Number(d.startWall);
  jam.clockBy = String(d.by || w.name).slice(0, 16);
  renderJamTransport();
}

function jamBroadcastClock() {
  if (!dj.active || !net.enabled || !net.sendJamClock) return;
  if (jam.startWall == null) return;
  try {
    net.sendJamClock({ bpm: jam.bpm, startWall: jam.startWall, by: myName });
  } catch (e) { /* ignore */ }
}

/* Set the tempo. Phase-preserving: the grid doesn't jump — the current
   beat stays continuous under the new BPM. */
function jamSetBpm(bpm, opts = {}) {
  const { manual = false, broadcast = true } = opts;
  bpm = Math.max(60, Math.min(200, Math.round(Number(bpm) * 10) / 10));
  if (!Number.isFinite(bpm)) return;
  const nowBeat = jamBeatNow();
  jam.bpm = bpm;
  jam.startWall = Date.now() - (nowBeat != null ? nowBeat : 0) * (60000 / bpm);
  if (manual) jam.manual = true; // DJ override pauses auto-detect for the session
  if (broadcast) jamBroadcastClock();
  renderJamTransport();
}

function jamStopClock() {
  jam.startWall = null;
  jam.clockBy = null;
  renderJamTransport();
}

/* We just took the decks: fresh grid, auto-detect armed for this session. */
function jamOnBecomeDj() {
  jam.manual = false;
  jam.detector = new OnsetDetector();
  jam.detStable = 0;
  jam.detLast = null;
  jamTaps = [];
  jam.startWall = Date.now();
  jam.clockBy = myName;
  jamBroadcastClock();
  renderJamTransport();
}

/* Tap tempo: 3+ taps set the BPM from the median interval. Any manual
   tempo move pauses auto-detect for the rest of the DJ session. */
function jamTapTempo() {
  if (!dj.active) return;
  const now = Date.now();
  if (jamTaps.length && now - jamTaps[jamTaps.length - 1] > 2000) jamTaps = [];
  jamTaps.push(now);
  if (jamTaps.length > 6) jamTaps.shift();
  if (jamTaps.length >= 3) {
    const iv = [];
    for (let i = 1; i < jamTaps.length; i++) iv.push(jamTaps[i] - jamTaps[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    if (med > 240 && med < 1200) jamSetBpm(60000 / med, { manual: true });
  }
  if (jamTapEl) {
    jamTapEl.classList.add('tapped');
    setTimeout(() => jamTapEl.classList.remove('tapped'), 120);
  }
}

/* Auto-BPM: once a second, feed the DJ stream's analyser to the onset
   detector and adopt a stable new estimate. Runs only while WE are the
   DJ and only until a manual override. */
function jamDetectTick() {
  if (!dj.active || jam.manual) return;
  const an = dj.analyser;
  if (!an) return;
  if (!jam.detector) jam.detector = new OnsetDetector();
  const est = estimateBpm(jam.detector.process(an));
  if (est == null) return;
  const r = Math.round(est);
  if (Math.abs(r - Math.round(jam.bpm)) <= 2) {
    jam.detStable = 0;
    jam.detLast = null;
    return;
  }
  if (jam.detLast === r) jam.detStable++;
  else { jam.detLast = r; jam.detStable = 1; }
  // Adopt only if the estimate persists ~4s — no jumpy tempos.
  if (jam.detStable >= 4) {
    jamSetBpm(r);
    jam.detStable = 0;
    jam.detLast = null;
  }
}
setInterval(jamDetectTick, 1000);

/* ---------------- sampler: ring buffer on the DJ stream ----------------
   A ScriptProcessorNode taps the DJ stream (ours when we're on the
   decks, the remote one when we're listening) into a 12s mono ring
   buffer. "Grab loop" copies the last 2 bars (or 4s with no clock) into
   the next pad. ScriptProcessor is deprecated but universally supported;
   an AudioWorklet ring would be the upgrade path — capture latency is
   irrelevant here since we only ever read the buffer on demand. */

function jamStopRecorder() {
  const rec = jam.rec;
  jam.rec = null;
  if (!rec) return;
  try { rec.proc.onaudioprocess = null; } catch (e) {}
  try { rec.src.disconnect(); } catch (e) {}
  try { rec.proc.disconnect(); } catch (e) {}
  try { rec.sink.disconnect(); } catch (e) {}
}

function jamEnsureRecorder() {
  const stream =
    dj.stream || (dj.listenAudioEl && dj.listenAudioEl.srcObject) || null;
  if (!stream) return null;
  if (jam.rec && jam.rec.stream === stream) return jam.rec;
  jamStopRecorder();
  try {
    const ctx = audio.ctx;
    if (!ctx || typeof ctx.createScriptProcessor !== 'function') return null;
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 2, 1);
    const ringLen = Math.floor(ctx.sampleRate * 12);
    const rec = { stream, ctx, src, proc, ring: new Float32Array(ringLen), w: 0, sink: null };
    const sink = ctx.createGain();
    sink.gain.value = 0; // ScriptProcessor needs a connected output to run
    rec.sink = sink;
    proc.onaudioprocess = (e) => {
      const ib = e.inputBuffer;
      const c0 = ib.getChannelData(0);
      const c1 = ib.numberOfChannels > 1 ? ib.getChannelData(1) : null;
      for (let i = 0; i < c0.length; i++) {
        rec.ring[rec.w] = c1 ? (c0[i] + c1[i]) * 0.5 : c0[i];
        rec.w = (rec.w + 1) % ringLen;
      }
    };
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    jam.rec = rec;
    return rec;
  } catch (e) {
    return null;
  }
}

function jamGrabLoop() {
  const rec = jamEnsureRecorder();
  if (!rec) {
    showUnlockToast(['need the decks live to sample \u{1F3A7}']);
    renderJamSamplerHint();
    return false;
  }
  const clockOn = jamBeatNow() != null;
  const lenSec = clockOn ? (8 * 60) / jam.bpm : 4; // 2 bars, or 4s free-time
  const ctx = rec.ctx;
  const n = Math.max(1, Math.min(Math.floor(lenSec * ctx.sampleRate), rec.ring.length));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const out = buf.getChannelData(0);
  let r = (((rec.w - n) % rec.ring.length) + rec.ring.length) % rec.ring.length;
  for (let i = 0; i < n; i++) {
    out[i] = rec.ring[r];
    r = (r + 1) % rec.ring.length;
  }
  const slot = jam.padRound;
  jam.pads[slot] = buf;
  jam.padRound = (jam.padRound + 1) % jam.pads.length;
  addSystemLine(`loop grabbed — pad ${slot + 1} is loaded`);
  renderJamPads();
  renderJamSamplerHint();
  return true;
}

function jamPlayPad(i, audioTime) {
  const ctx = audio.ctx;
  const buf = jam.pads[i];
  if (!ctx || !buf || !audio.master) return;
  try {
    const t = Math.max(audioTime || 0, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.85;
    src.connect(g);
    g.connect(audio.master);
    src.start(t);
  } catch (e) { /* ignore */ }
}

/* Tap a pad: quantized to the next bar (or immediately, no clock).
   The trigger is broadcast; every client plays its OWN local copy. */
function jamTriggerPad(i) {
  if (!jam.pads[i]) {
    showUnlockToast(['pad empty — grab a loop first']);
    return false;
  }
  const beatNow = jamBeatNow();
  const beat = beatNow != null ? quantizeUp(beatNow, 4) : null;
  if (net.enabled && net.sendJamPad && active && active.key === SOUND_ROOM_KEY) {
    try {
      net.sendJamPad({ n: myName, pad: i, beat, lenBars: beatNow != null ? 2 : 0 });
    } catch (e) { /* ignore */ }
  }
  if (beat != null) jamEnqueue({ beat, play: (at) => jamPlayPad(i, at) });
  else if (audio.ctx) jamPlayPad(i, audio.ctx.currentTime + 0.01);
  jamMarkJammer(myName);
  renderJamJammers();
  return true;
}

/* ---------------- who's jamming ---------------- */

function jamMarkJammer(name) {
  jam.jammers.set(String(name || 'drifter').slice(0, 16), Date.now());
}

function renderJamJammers() {
  if (!jamJammersEl) return;
  const now = Date.now();
  const names = [];
  for (const [n, t] of jam.jammers) {
    if (now - t < 30000) names.push(n);
    else jam.jammers.delete(n);
  }
  jamJammersEl.textContent = names.length
    ? 'jamming now: ' + names.join(', ')
    : 'the room is quiet — play something \u{1F3B9}';
}
setInterval(() => { if (jam.open) renderJamJammers(); }, 5000);

/* ---------------- jam panel UI ---------------- */

function setJamPanel(open) {
  jam.open = !!open;
  if (jamPanel) jamPanel.classList.toggle('open', jam.open);
  chatFocused = jam.open; // reuse the chat guard: keys never fly the wisp mid-jam
  if (jam.open) {
    renderJamTransport();
    renderJamPads();
    renderJamSamplerHint();
    renderJamJammers();
  }
}

function renderJamTransport() {
  if (!jamPanel) return;
  if (jamBpmEl) jamBpmEl.textContent = Math.round(jam.bpm);
  const on = jam.startWall != null;
  if (jamClockStatusEl) {
    jamClockStatusEl.textContent = !on
      ? 'clock stopped'
      : dj.active
        ? `you're the clock · ${jam.manual ? 'manual' : 'auto-detect'}`
        : `synced · ${jam.clockBy || 'dj'}`;
  }
  if (jamClockDotEl) jamClockDotEl.classList.toggle('live', on);
  // Only the DJ sets the tempo.
  const canSet = dj.active;
  for (const b of [jamTapEl, jamBpmDownEl, jamBpmUpEl]) {
    if (b) {
      b.disabled = !canSet;
      b.title = canSet ? '' : 'the DJ sets the tempo';
    }
  }
}

function renderJamPads() {
  if (!jamPadsEl) return;
  jamPadsEl.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const b = document.createElement('button');
    b.className = 'jam-pad' + (jam.pads[i] ? ' loaded' : '');
    b.textContent = jam.pads[i] ? `${i + 1}` : '·';
    b.setAttribute('aria-label', jam.pads[i] ? `play loop ${i + 1}` : `pad ${i + 1} (empty)`);
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); jamTriggerPad(i); });
    jamPadsEl.appendChild(b);
  }
}

function renderJamSamplerHint() {
  if (!jamHintEl) return;
  const live = !!(dj.stream || (dj.listenAudioEl && dj.listenAudioEl.srcObject));
  jamHintEl.textContent = !live
    ? 'need the decks live to sample \u{1F3A7}'
    : jam.pads.every((p) => !p)
      ? 'grab a loop from the decks, then tap a pad on the bar'
      : '';
}

function buildJamKeys() {
  if (!jamKeysEl) return;
  jamKeysEl.innerHTML = '';
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let i = 0; i <= 12; i++) {
    const midi = 60 + i; // one chromatic octave, C4–C5
    const black = [1, 3, 6, 8, 10].includes(i % 12);
    const b = document.createElement('button');
    b.className = 'jam-key' + (black ? ' black' : '');
    b.textContent = black ? '' : names[i % 12];
    b.setAttribute('aria-label', names[i % 12] + (4 + Math.floor(i / 12)));
    // pointerdown (not click): notes fire the instant the finger lands.
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); jamPlayLocal(midi, 0.9); });
    jamKeysEl.appendChild(b);
  }
}

if (jamBtn) {
  jamBtn.addEventListener('click', () => {
    setJamPanel(!jam.open);
    jamBtn.blur();
  });
}
if (jamCloseBtn) jamCloseBtn.addEventListener('click', () => setJamPanel(false));
if (jamTapEl) jamTapEl.addEventListener('click', () => { jamTapTempo(); jamTapEl.blur(); });
if (jamBpmDownEl) jamBpmDownEl.addEventListener('click', () => { jamSetBpm(jam.bpm - 1, { manual: true }); jamBpmDownEl.blur(); });
if (jamBpmUpEl) jamBpmUpEl.addEventListener('click', () => { jamSetBpm(jam.bpm + 1, { manual: true }); jamBpmUpEl.blur(); });
if (jamGrabEl) jamGrabEl.addEventListener('click', () => { jamGrabLoop(); jamGrabEl.blur(); });
document.querySelectorAll('.jam-wave').forEach((b) => {
  b.addEventListener('click', () => {
    jam.wave = b.dataset.wave || 'sawtooth';
    document.querySelectorAll('.jam-wave').forEach((x) =>
      x.classList.toggle('sel', x === b));
    b.blur();
  });
});
{
  const first = document.querySelector('.jam-wave');
  if (first) first.classList.add('sel');
}
const jamCutoffEl = document.getElementById('jam-cutoff');
const jamResoEl = document.getElementById('jam-reso');
if (jamCutoffEl) jamCutoffEl.addEventListener('input', () => { jam.cutoff = Number(jamCutoffEl.value) || 1800; });
if (jamResoEl) jamResoEl.addEventListener('input', () => { jam.reso = Number(jamResoEl.value) || 0; });


if (decksBtn) {
  decksBtn.addEventListener('click', () => {
    if (dj.active) stopDecks();
    else takeDecks();
    decksBtn.blur();
  });
}

// Boot: dress the wisp in the saved look; net reads the equipped look
// for every ~12Hz broadcast so peers see it too.
applySkin(equipped.skin);
applyHat(equipped.hat);
applyTrail();
renderWispSection(); // populate the settings WISP section for first open
renderPrintsSection(); // populate the settings PRINTS section
renderFriendsSection(); // populate the settings FRIENDS section
buildJamKeys(); // one-octave synth keyboard for the jam panel
net.cosmetics = () => {
  const tc = TRAIL_COLORS[equipped.trailColor] || TRAIL_COLORS.white;
  return {
    s: equipped.skin,
    h: equipped.hat,
    t: equipped.trailStyle,
    c: tc.hex.toString(16).padStart(6, '0'),
  };
};

/* ---------------- world builders ---------------- */

const worlds = {};
let active = null; // the world object the wisp currently inhabits

function makeStars(count, rMin, rMax, size, color) {
  const pos = new Float32Array(count * 3);
  const rnd = mulberry32(count * 7919);
  for (let i = 0; i < count; i++) {
    const r = rMin + rnd() * (rMax - rMin);
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

// Slow-drifting dust motes with per-point phase (updated on CPU; counts are modest).
function makeDust(count, radius, color, size) {
  const pos = new Float32Array(count * 3);
  const base = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const rnd = mulberry32(count * 104729 + 7);
  for (let i = 0; i < count; i++) {
    const r = Math.cbrt(rnd()) * radius;
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    base[i * 3] = r * Math.sin(ph) * Math.cos(th);
    base[i * 3 + 1] = (rnd() - 0.5) * radius * 0.8;
    base[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    phase[i] = rnd() * Math.PI * 2;
  }
  pos.set(base);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return { pts, base, phase, count };
}

// A portal ring: torus + art disc + glow + label. Faces `lookTarget`.
function makePortal(artTexture, accent, labelText, ringR = 2.2, tube = 0.16) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(ringR, tube, 16, 64),
    new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.4, metalness: 0.7, roughness: 0.3 })
  );
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(ringR - 0.12, 48),
    new THREE.MeshBasicMaterial({ map: artTexture })
  );
  disc.position.z = -0.06;
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: accent, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  glow.scale.set(ringR * 4.6, ringR * 4.6, 1);
  glow.position.z = -0.8;
  group.add(ring, disc, glow);
  if (labelText) {
    const label = makeLabel(labelText);
    label.position.y = ringR + 1.6;
    group.add(label);
  }
  return { group, ring };
}

/* Procedural portal art for the sound room: amber EQ bars on dark. */
function makeSoundTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#0a0703';
  g.fillRect(0, 0, 256, 256);
  const rnd = mulberry32(4242);
  const n = 18;
  for (let i = 0; i < n; i++) {
    const h = 40 + rnd() * 150;
    const x = 14 + i * ((256 - 28) / n);
    const w = (256 - 28) / n - 6;
    const grad = g.createLinearGradient(0, 256 - h, 0, 256);
    grad.addColorStop(0, '#ffc24d');
    grad.addColorStop(1, '#ff7a3d');
    g.fillStyle = grad;
    g.globalAlpha = 0.92;
    g.fillRect(x, 256 - 14 - h, w, h);
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------- the sound room (build 12) ----------------
   A 5th portal off the Nexus: a social listening space with a DJ booth
   and the four realm artworks hanging as a gallery. No echoes, no
   attunement — the room is for hanging out, not progression. */
function buildSoundRoom(textures) {
  const accent = SOUND_DEF.accent;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020204);
  scene.fog = new THREE.FogExp2(0x0a0610, 0.012);
  scene.add(new THREE.AmbientLight(0x99aacc, 0.5));

  // Floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(34, 48),
    new THREE.MeshStandardMaterial({ color: 0x0b0b12, roughness: 0.9, metalness: 0.1 })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Four walls.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x080810, roughness: 1 });
  const wallGeo = new THREE.PlaneGeometry(68, 18);
  const walls = [
    { p: [0, 9, -34], r: 0 },
    { p: [34, 9, 0], r: Math.PI / 2 },
    { p: [0, 9, 34], r: Math.PI },
    { p: [-34, 9, 0], r: -Math.PI / 2 },
  ];
  for (const w of walls) {
    const m = new THREE.Mesh(wallGeo, wallMat);
    m.position.set(...w.p);
    m.rotation.y = w.r;
    scene.add(m);
  }

  // Gallery: the four realm artworks, framed, one per wall.
  const galleryFiles = [];
  const frameDefs = [
    { def: REALM_DEFS[0], p: [0, 8, -33.7], r: 0 },
    { def: REALM_DEFS[1], p: [33.7, 8, 0], r: -Math.PI / 2 },
    { def: REALM_DEFS[2], p: [0, 8, 33.7], r: Math.PI },
    { def: REALM_DEFS[3], p: [-33.7, 8, 0], r: Math.PI / 2 },
  ];
  for (const f of frameDefs) {
    const tex = textures[f.def.key];
    const img = tex && tex.image ? tex.image : null;
    const aspect = img ? img.width / img.height : 1;
    const AW = 15, AH = Math.min(AW / aspect, 11);
    const frame = new THREE.Group();
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(AW + 1.2, AH + 1.2),
      new THREE.MeshStandardMaterial({ color: f.def.accent, emissive: f.def.accent, emissiveIntensity: 0.25, roughness: 0.4, metalness: 0.6 })
    );
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(AW, AH),
      new THREE.MeshBasicMaterial({ map: tex })
    );
    art.position.z = 0.08;
    frame.add(back, art);
    frame.position.set(...f.p);
    frame.rotation.y = f.r;
    scene.add(frame);
    galleryFiles.push(f.def.file);
  }

  // DJ booth: platform, two decks, mixer, amber glow.
  const booth = new THREE.Group();
  const boothMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.6, metalness: 0.4 });
  const platform = new THREE.Mesh(new THREE.BoxGeometry(11, 1, 5), boothMat);
  platform.position.y = 0.5;
  booth.add(platform);
  const deckGeo = new THREE.CylinderGeometry(1.6, 1.6, 0.5, 32);
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x1c1c26, roughness: 0.4, metalness: 0.7 });
  for (const dx of [-2.6, 2.6]) {
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.position.set(dx, 1.3, 0);
    booth.add(deck);
    const platter = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 0.56, 32),
      new THREE.MeshStandardMaterial({ color: 0x0a0a10, roughness: 0.3, metalness: 0.8 })
    );
    platter.position.set(dx, 1.3, 0);
    booth.add(platter);
  }
  const mixer = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 1.6), boothMat);
  mixer.position.set(0, 1.3, 0.4);
  booth.add(mixer);
  const boothGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: accent, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  boothGlow.scale.set(16, 10, 1);
  boothGlow.position.y = 3.4;
  booth.add(boothGlow);
  booth.position.set(0, 0, -24);
  scene.add(booth);

  // Accent lights that pulse with the music (see update + setBass).
  const lightA = new THREE.PointLight(accent, 1.2, 60);
  lightA.position.set(-12, 9, -8);
  const lightB = new THREE.PointLight(accent, 1.2, 60);
  lightB.position.set(12, 9, -8);
  scene.add(lightA, lightB);

  const dust = makeDust(200, 40, accent, 0.6);
  scene.add(dust.pts);

  // Return portal to the Nexus.
  const { group, ring } = makePortal(makeSoundTexture(), accent, 'RETURN', 1.7, 0.14);
  group.position.set(0, 3, 26);
  group.lookAt(0, 5, 10);
  scene.add(group);
  const portals = [{ group, ring, pos: group.position.clone(), target: 'nexus', phase: 0.6, baseY: 3 }];

  return {
    key: SOUND_DEF.key, name: SOUND_DEF.name, root: SOUND_DEF.root,
    scene, portals, echoes: [],
    gallery: galleryFiles, // realm artwork files on the walls — tests check these are real
    spawn: new THREE.Vector3(0, 2, 20), spawnYaw: 0, // face the booth (-Z)
    bound: 'realm',
    anim: { dust, lightA, lightB, boothGlow, bass: 0 },
    attunedShown: true, // n/a: no echoes here, nothing to attune
    setBass(v) { this.anim.bass = Math.max(0, Math.min(1, v)); },
    update(dt, t) {
      const { dust, lightA, lightB, boothGlow } = this.anim;
      const bass = this.anim.bass;
      dust.pts.rotation.y += dt * 0.02;
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.3;
        pt.ring.rotation.z -= dt * 0.15;
        pt.pos.copy(pt.group.position);
      }
      // The room breathes with the music; idle when nobody's on the decks.
      const pulse = 1 + bass * 2.2 + Math.sin(t * 1.4) * 0.08;
      lightA.intensity = 1.2 * pulse;
      lightB.intensity = 1.2 * (2 - pulse) + 1.2 + bass; // counter-phase shimmer
      boothGlow.material.opacity = 0.4 + bass * 0.5;
      const gs = 16 + bass * 6;
      boothGlow.scale.set(gs, gs * 0.62, 1);
      scene.fog.density = 0.012 + bass * 0.008;
    },
  };
}

function buildNexus(textures) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020204);
  scene.fog = new THREE.FogExp2(0x050508, 0.01);
  scene.add(new THREE.AmbientLight(0x8899bb, 0.6));

  const starsFar = makeStars(900, 130, 240, 1.6, 0xbfd4ff);
  const starsNear = makeStars(320, 60, 130, 2.4, 0xffffff);
  const dust = makeDust(220, 45, 0x8fa8ff, 0.5);
  scene.add(starsFar, starsNear, dust.pts);

  const portals = [];
  // The 4 realm portals + the sound room portal (build 12).
  const portalDefs = REALM_DEFS.map((def) => ({
    key: def.key, name: def.name, accent: def.accent, tex: textures[def.key],
  })).concat([{
    key: SOUND_DEF.key, name: SOUND_DEF.name, accent: SOUND_DEF.accent,
    tex: makeSoundTexture(),
  }]);
  portalDefs.forEach((def, i) => {
    const a = (i / portalDefs.length) * Math.PI * 2;
    const { group, ring } = makePortal(def.tex, def.accent, def.name);
    group.position.set(Math.cos(a) * 16, 2.5, Math.sin(a) * 16);
    group.lookAt(0, 2.5, 0);
    scene.add(group);
    portals.push({ group, ring, pos: group.position.clone(), target: def.key, phase: i * 1.7, baseY: 2.5 });
  });

  return {
    key: 'nexus', name: NEXUS_DEF.name, root: NEXUS_DEF.root,
    scene, portals, echoes: [],
    spawn: new THREE.Vector3(0, 2, 0), spawnYaw: -Math.PI / 2, // face first portal (+X)
    bound: 'nexus',
    anim: { starsFar, starsNear, dust },
    attunedShown: true, // n/a in nexus
    update(dt, t) {
      const { starsFar, starsNear, dust } = this.anim;
      starsFar.rotation.y += dt * 0.004;
      starsNear.rotation.y -= dt * 0.007;
      const p = dust.pts.geometry.attributes.position.array;
      for (let i = 0; i < dust.count; i++) {
        p[i * 3 + 1] = dust.base[i * 3 + 1] + Math.sin(t * 0.25 + dust.phase[i]) * 1.6;
        p[i * 3] = dust.base[i * 3] + Math.cos(t * 0.18 + dust.phase[i]) * 1.2;
      }
      dust.pts.geometry.attributes.position.needsUpdate = true;
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.35;
        pt.ring.rotation.z += dt * 0.18;
        pt.pos.copy(pt.group.position); // keep trigger point in sync
      }
    },
  };
}

function buildRealm(def, texture) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020204);
  scene.fog = new THREE.FogExp2(def.fog, 0.012);
  scene.add(new THREE.AmbientLight(0x99aacc, 0.5));

  // The realm: ONE big flat artwork floating in the dark void.
  // Gently bowed (edges recede a touch) for a hint of immersion —
  // never wrapped; the full frame always faces you.
  const aspect = texture.image.width / texture.image.height;
  const ART_W = 76;
  const ART_H = Math.min(ART_W / aspect, 54);
  const artGeo = new THREE.PlaneGeometry(ART_W, ART_H, 64, 1);
  {
    const p = artGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      p.setZ(i, -0.0022 * x * x);
    }
    artGeo.computeVertexNormals();
  }
  const art = new THREE.Mesh(artGeo, new THREE.MeshBasicMaterial({ map: texture, fog: true }));
  art.position.set(0, 7, -46);
  scene.add(art);

  // Soft backlit halo so the piece glows against the void.
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(ART_W + 12, ART_H + 12),
    new THREE.MeshBasicMaterial({ map: glowTex, color: def.accent, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  halo.position.set(0, 7, -46.9);
  scene.add(halo);

  const dust = makeDust(200, 60, def.accent, 0.6);
  scene.add(dust.pts);

  // 5 echo orbs at deterministic, reachable positions in front of the art.
  const rnd = mulberry32(def.key.length * 31337 + 11);
  const echoes = [];
  const spawn = new THREE.Vector3(0, 2, 22);
  for (let i = 0; i < ECHOES_PER_REALM; i++) {
    let pos;
    for (let tries = 0; tries < 40; tries++) {
      pos = new THREE.Vector3((rnd() - 0.5) * 56, -2 + rnd() * 22, -34 + rnd() * 44);
      if (pos.distanceTo(spawn) > 9) break;
    }
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true })
    );
    mesh.position.copy(pos);
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTex, color: def.accent, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    glow.scale.set(3.6, 3.6, 1);
    glow.position.copy(pos);
    scene.add(mesh, glow);
    echoes.push({ mesh, glow, basePos: pos.clone(), phase: rnd() * Math.PI * 2, collected: false, burstT: null });
  }

  // Return portal back to the Nexus, off to one side of the artwork.
  const { group, ring } = makePortal(texture, def.accent, 'RETURN', 1.7, 0.14);
  group.position.set(30, 3, -10);
  group.lookAt(0, 5, -30);
  scene.add(group);
  const portals = [{ group, ring, pos: group.position.clone(), target: 'nexus', phase: 0.6, baseY: 3 }];

  return {
    key: def.key, name: def.name, root: def.root,
    scene, portals, echoes,
    spawn, spawnYaw: 0, // face the artwork (-Z)
    bound: 'realm',
    anim: { dust },
    attunedShown: false,
    update(dt, t) {
      const { dust } = this.anim;
      dust.pts.rotation.y += dt * 0.02;
      for (const pt of this.portals) {
        pt.group.position.y = pt.baseY + Math.sin(t * 0.8 + pt.phase) * 0.3;
        pt.ring.rotation.z -= dt * 0.15;
        pt.pos.copy(pt.group.position);
      }
      let got = 0;
      for (const e of this.echoes) {
        if (e.collected && e.burstT === null) continue;
        if (e.burstT !== null) {
          // pickup burst: scale up + fade out, then vanish
          e.burstT += dt;
          const s = 1 + e.burstT * 7;
          e.mesh.scale.set(s, s, s);
          e.mesh.material.opacity = Math.max(0, 1 - e.burstT / 0.45);
          e.glow.material.opacity = Math.max(0, 0.8 - e.burstT / 0.45);
          if (e.burstT > 0.45) { e.mesh.visible = false; e.glow.visible = false; e.burstT = null; }
          continue;
        }
        got++;
        e.mesh.position.y = e.basePos.y + Math.sin(t * 1.3 + e.phase) * 0.6;
        e.glow.position.y = e.mesh.position.y;
        e.mesh.rotation.y += dt * 0.8;
        e.glow.material.opacity = 0.6 + Math.sin(t * 2.2 + e.phase) * 0.25;
      }
      // "REALM ATTUNED" once all five are gathered
      if (got === 0 && !this.attunedShown) {
        this.attunedShown = true;
        attunedEl.classList.remove('show');
        void attunedEl.offsetWidth; // restart CSS animation
        attunedEl.classList.add('show');
        onRealmAttuned(this.key, this.name); // unlocks: skin + hat thresholds
      }
    },
  };
}

/* ---------------- loading + boot ---------------- */

const manager = new THREE.LoadingManager();
const loader = new THREE.TextureLoader(manager);
const textures = {};
const failedTextures = new Set();
for (const def of REALM_DEFS) {
  // onError only marks the failure — the manager still settles the item,
  // so one bad download can never wedge the loading screen forever.
  const tex = loader.load(
    def.file,
    undefined,
    undefined,
    () => failedTextures.add(def.key)
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  textures[def.key] = tex;
}

// Generative stand-in: buildRealm reads texture.image, which is undefined
// when a download fails — substitute so boot can never throw on it.
function makePlaceholderTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 256, 40, 256, 256, 380);
  grad.addColorStop(0, '#241b4d');
  grad.addColorStop(1, '#04040c');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let booted = false;
function finishBoot() {
  if (booted) return;
  booted = true;
  clearTimeout(bootTimeout);
  // Anything that failed (or never settled) becomes a placeholder.
  for (const def of REALM_DEFS) {
    if (!textures[def.key].image) textures[def.key] = makePlaceholderTexture();
  }
  try {
    worlds.nexus = buildNexus(textures);
    for (const def of REALM_DEFS) worlds[def.key] = buildRealm(def, textures[def.key]);
    worlds[SOUND_DEF.key] = buildSoundRoom(textures);
  } catch (err) {
    // Last resort: say so on screen instead of a dead "loading…" hang.
    loadingEl.firstElementChild.textContent = 'limbo failed to wake — reload to try again';
    console.error('[limbo] world build failed:', err);
    return;
  }

  active = worlds.nexus;
  active.scene.add(wisp, localTrail.group, peerLayer);
  wisp.position.copy(active.spawn);
  yaw = active.spawnYaw;
  clearTrail();
  renderDjHud(); // decks button starts hidden (we boot in the Nexus)

  loadingEl.classList.add('done');
  driftBtn.disabled = false;
  driftBtn.textContent = 'click to drift';
  requestAnimationFrame(loop);
}
manager.onProgress = (url, loaded, total) => {
  loadingEl.firstElementChild.textContent = `summoning limbo · ${loaded}/${total}`;
};
manager.onError = (url) => console.warn('[limbo] texture failed:', url);
manager.onLoad = finishBoot;
// Safety net: image loads have no timeout, so a stalled connection could
// leave the manager waiting forever — boot anyway after 30s.
const bootTimeout = setTimeout(finishBoot, 30000);

/* ---------------- input: keys ---------------- */

const keys = {};
window.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (e.code === 'Escape' && settingsOpen) { setSettings(false); return; }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // typing in chat / name field
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
  if (e.code === 'KeyM') {
    setMuted(audio.toggleMute());
  }
  if (e.code === 'KeyT' && started && !chatFocused) {
    e.preventDefault();
    chatInput.focus();
  }
  if (e.code === 'KeyD' && started && !chatFocused) setSettings(!settingsOpen);
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

/* ---------------- chat ----------------
   Room-local text chat. Messages only *display* for peers within
   PROXIMITY_R meters (receiver-side filter on the last-known wisp
   positions, broadcast at 12Hz) — distant chatter arrives as a faint
   hint instead. Own messages always show. */

const PROXIMITY_R = 40; // meters — chat only carries this far
const CHAT_HISTORY_CAP = 100;
const BUBBLE_SECS = 4; // floating bubble lifetime above the sender's wisp

const peerPositions = new Map(); // peerId -> THREE.Vector3 (last wisp broadcast)
const chatHistory = []; // {name, text, time, sys, self, distant} — this session, capped
let lastDistantHint = 0;

function recordChat(name, text, sys = false, self = false, distant = false) {
  chatHistory.push({ name, text, time: new Date(), sys, self, distant });
  if (chatHistory.length > CHAT_HISTORY_CAP) chatHistory.shift();
}

function renderChatLine(name, text, sys = false) {
  const div = document.createElement('div');
  div.className = 'chat-line' + (sys ? ' sys' : '');
  if (sys) {
    div.textContent = text;
  } else {
    const n = document.createElement('span');
    n.className = 'chat-name';
    n.textContent = name;
    div.appendChild(n);
    div.appendChild(document.createTextNode(' \u00B7 ' + text));
  }
  chatLog.appendChild(div);
  while (chatLog.children.length > CHAT_HISTORY_CAP) chatLog.removeChild(chatLog.firstChild);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addChatLine(name, text, sys = false, self = false) {
  recordChat(name, text, sys, self, false);
  renderChatLine(name, text, sys);
}

function addSystemLine(text) {
  addChatLine('', text, true);
}

function sendChatLine() {
  const text = chatInput.value.trim().slice(0, 140);
  if (!text) { chatInput.blur(); return; }
  addChatLine(myName, text, false, true);
  if (net.enabled && net.sendChat) {
    net.say(text);
  } else {
    addSystemLine('the void is quiet \u2014 no connection to send with');
  }
  chatInput.value = '';
  // On touch devices the keyboard's action key may not fire Enter — the
  // send button covers that — and after sending we dismiss the keyboard.
  if (window.matchMedia && matchMedia('(pointer: coarse)').matches) chatInput.blur();
}

/* Floating speech bubble above a peer's wisp, ~4s. Only when on screen. */
function makeChatBubble(text) {
  const shown = String(text).slice(0, 90);
  const maxChars = 24;
  const words = shown.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line.trim()); line = w; }
    else line += ' ' + w;
    if (lines.length === 3) break;
  }
  if (line.trim() && lines.length < 3) lines.push(line.trim());
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = '300 26px system-ui, -apple-system, sans-serif';
  g.font = font;
  const wMax = Math.max(...lines.map((l) => g.measureText(l).width), 40);
  c.width = Math.ceil(wMax + 44);
  c.height = lines.length * 36 + 40;
  const g2 = c.getContext('2d');
  const r = 16;
  g2.fillStyle = 'rgba(6,10,24,0.88)';
  g2.strokeStyle = 'rgba(159,216,255,0.5)';
  g2.lineWidth = 2;
  g2.beginPath();
  if (g2.roundRect) g2.roundRect(2, 2, c.width - 4, c.height - 4, r);
  else g2.rect(2, 2, c.width - 4, c.height - 4);
  g2.fill();
  g2.stroke();
  g2.font = font;
  g2.fillStyle = 'rgba(235,240,255,0.95)';
  g2.textBaseline = 'top';
  lines.forEach((l, i) => g2.fillText(l, 22, 18 + i * 36));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, fog: false,
  }));
  const s = 0.028;
  sp.scale.set(c.width * s, c.height * s, 1);
  return sp;
}

const _projV = new THREE.Vector3();
function showChatBubble(peerId, text) {
  const pv = peerVisuals.get(peerId);
  if (!pv) return;
  // Only when the sender is actually on screen.
  _projV.copy(pv.group.position);
  _projV.y += 2.9;
  _projV.project(camera);
  if (_projV.z > 1 || Math.abs(_projV.x) > 1 || Math.abs(_projV.y) > 1) return;
  if (pv.bubble) pv.group.remove(pv.bubble.sprite);
  const sprite = makeChatBubble(text);
  sprite.position.y = 2.9;
  pv.group.add(sprite);
  pv.bubble = { sprite, expires: clock.elapsedTime + BUBBLE_SECS };
}

chatInput.addEventListener('focus', () => {
  chatFocused = true;
  for (const k in keys) keys[k] = false; // never fly while typing
});
chatInput.addEventListener('blur', () => { chatFocused = false; });
chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep game keys out of the window handler
  if (e.key === 'Enter') sendChatLine();
  else if (e.key === 'Escape') chatInput.blur();
});

// Send button — the touch path. Phone keyboards often dismiss instead of
// firing Enter on a bare input, so without this mobile chat can't send.
chatSend.addEventListener('click', () => { sendChatLine(); chatSend.blur(); });

// Toggleable history panel (speech-bubble button).
let chatLogOpen = true;
chatToggle.addEventListener('click', () => {
  chatLogOpen = !chatLogOpen;
  chatLog.classList.toggle('hidden', !chatLogOpen);
  chatToggle.classList.toggle('off', !chatLogOpen);
  if (chatLogOpen) chatLog.scrollTop = chatLog.scrollHeight;
  chatToggle.blur();
});

// Enter in the name field starts the drift.
nameInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' && !driftBtn.disabled) driftBtn.click();
});

/* ---------------- input: mouse drag-look (no pointer lock) ---------------- */

let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lastX) * 0.0032;
  pitch -= (e.clientY - lastY) * 0.0032;
  pitch = Math.max(-1.45, Math.min(1.45, pitch));
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener('mouseup', () => { dragging = false; });

/* ---------------- input: touch (left joystick / right look) ---------------- */

const joy = { id: null, ax: 0, ay: 0, x: 0, y: 0 };   // move stick, -1..1
const look = { id: null, lx: 0, ly: 0 };              // look drag
canvas.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    if (t.clientX < window.innerWidth / 2 && joy.id === null) {
      joy.id = t.identifier; joy.ax = t.clientX; joy.ay = t.clientY; joy.x = 0; joy.y = 0;
      joyBase.style.display = 'block';
      joyBase.style.left = t.clientX + 'px';
      joyBase.style.top = t.clientY + 'px';
      joyKnob.style.transform = 'translate(-50%,-50%)';
    } else if (look.id === null) {
      look.id = t.identifier; look.lx = t.clientX; look.ly = t.clientY;
    }
  }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) {
      joy.x = Math.max(-1, Math.min(1, (t.clientX - joy.ax) / 55));
      joy.y = Math.max(-1, Math.min(1, (t.clientY - joy.ay) / 55));
      joyKnob.style.transform = `translate(calc(-50% + ${joy.x * 32}px), calc(-50% + ${joy.y * 32}px))`;
    } else if (t.identifier === look.id) {
      yaw -= (t.clientX - look.lx) * 0.0042;
      pitch -= (t.clientY - look.ly) * 0.0042;
      pitch = Math.max(-1.45, Math.min(1.45, pitch));
      look.lx = t.clientX; look.ly = t.clientY;
    }
  }
  e.preventDefault();
}, { passive: false });
function endTouch(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.id = null; joy.x = 0; joy.y = 0; joyBase.style.display = 'none'; }
    if (t.identifier === look.id) look.id = null;
  }
}
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

/* ---------------- portal transitions ---------------- */

let transitioning = false;
let lastTransition = -10;

function showTitleCard(name) {
  titleCardEl.textContent = name;
  titleCardEl.classList.add('show');
  setTimeout(() => titleCardEl.classList.remove('show'), 2400);
}

function goTo(key) {
  if (transitioning || !worlds[key]) return;
  // Leaving the sound room: step away from the decks automatically.
  if (active && active.key === SOUND_ROOM_KEY && key !== SOUND_ROOM_KEY) stopDecks();
  transitioning = true;
  fadeEl.classList.add('on');
  setTimeout(() => {
    active = worlds[key];
    active.scene.add(wisp, localTrail.group, peerLayer); // re-parents from the previous scene
    clearPeerVisuals();                       // old room's drifters stay in the old room
    net.join(roomKeyFor(active.key));         // hop to this location's P2P room
    net.setPresence(myName, active.key);      // lobby heartbeat: we're elsewhere now
    updatePeerCount();
    wisp.position.copy(active.spawn);
    vel.set(0, 0, 0);
    yaw = active.spawnYaw;
    pitch = -0.05;
    clearTrail();
    realmNameEl.textContent = active.name;
    audio.setRoot(active.root);
    showTitleCard(active.name);
    renderDjHud(); // show/hide the decks button + DJ line for this room
    fadeEl.classList.remove('on');
    lastTransition = clock.elapsedTime;
    setTimeout(() => { transitioning = false; }, 700);
  }, 650);
}

/* ---------------- echoes ---------------- */

let collectedTotal = 0;
function collectEcho(echo) {
  echo.collected = true;
  echo.burstT = 0;
  collectedTotal++;
  echoCountEl.textContent = `ECHOES ${collectedTotal} / ${TOTAL_ECHOES}`;
  audio.chime(collectedTotal);
  // Earnable trail style: 10 total echoes unlocks the Comet trail.
  if (collectedTotal >= 10 && !unlocks.trailStyles.includes('comet')) {
    unlocks.trailStyles.push('comet');
    saveUnlocks();
    showUnlockToast(['10 echoes gathered', 'Comet trail unlocked']);
    addSystemLine('10 echoes gathered — comet trail unlocked');
    renderWispSection();
  }
}

/* ---------------- remote drifters (multiplayer visuals) ---------------- */

const peerCoreGeo = new THREE.SphereGeometry(0.32, 16, 12);

// Floating name tag above a remote wisp.
function makeNameTag(name) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = '300 40px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  try { g.letterSpacing = '10px'; } catch (e) { /* older browsers */ }
  g.fillStyle = 'rgba(235,240,255,0.9)';
  g.shadowColor = 'rgba(150,190,255,0.8)';
  g.shadowBlur = 14;
  g.fillText(name, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sp.scale.set(6.4, 1.6, 1);
  return sp;
}

// Stable per-peer tint so you can tell drifters apart.
function peerColor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.65, 0.72);
}

function createPeerVisual(id, name) {
  const color = peerColor(id); // fallback tint for old clients without skins
  const group = new THREE.Group();
  const bob = new THREE.Group();
  const core = new THREE.Mesh(peerCoreGeo, new THREE.MeshBasicMaterial({ color }));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  glow.scale.set(3.4, 3.4, 1);
  const tag = makeNameTag(name);
  tag.position.y = 1.8;
  bob.add(core, glow);
  group.add(bob, tag);
  return { id, group, bob, core, glow, hat: null, tag, target: new THREE.Vector3(), name, skin: null, hatId: null, trailObj: makeTrail(24, 0.9), trailStyle: null, trailColor: null, phase: Math.random() * Math.PI * 2 };
}

// Dress a remote wisp in the peer's equipped skin (unknown id = old client,
// keep the stable per-peer hash tint). Hats ride the existing bob group.
function applyPeerSkin(pv, skinId) {
  const s = SKINS[skinId];
  if (s) {
    pv.core.material.color.setHex(s.core);
    pv.glow.material.color.setHex(s.glow);
  } else {
    const c = peerColor(pv.id);
    pv.core.material.color.copy(c);
    pv.glow.material.color.copy(c);
  }
}
function applyPeerHat(pv, hatId) {
  if (pv.hat) { pv.bob.remove(pv.hat); pv.hat = null; }
  if (hatId && hatId !== 'none' && HATS[hatId]) {
    pv.hat = buildHat(hatId);
    pv.hat.position.y = 0.55;
    pv.bob.add(pv.hat);
  }
}

// Dress a remote wisp's trail in the peer's equipped style + color.
// Unknown/missing style -> ribbon; missing color (old clients) -> the stable
// per-peer hash tint, so every drifter still gets a playful trail.
function applyPeerTrail(pv, styleId, hexStr) {
  const t = pv.trailObj;
  if (!t) return;
  t.setStyle(styleId || 'ribbon');
  let hex = null;
  if (typeof hexStr === 'string' && /^[0-9a-fA-F]{6}$/.test(hexStr)) hex = parseInt(hexStr, 16);
  if (hex === null || Number.isNaN(hex)) hex = peerColor(pv.id).getHex();
  t.setColor(hex);
}

function retagPeer(pv, name) {
  pv.group.remove(pv.tag);
  pv.tag = makeNameTag(name);
  pv.tag.position.y = 1.8;
  pv.group.add(pv.tag);
}

function clearPeerVisuals() {
  for (const pv of peerVisuals.values()) {
    peerLayer.remove(pv.group);
    if (pv.trailObj) peerLayer.remove(pv.trailObj.group);
  }
  peerVisuals.clear();
  peerPositions.clear(); // new room, new neighborhood
}

/* "DRIFTERS HERE" with a discovery state: while we're online, alone, and
   still inside the discovery window (~45s from room join) show a soft
   pulsing "finding others" so the wait reads as working, not broken.
   After the window, settle into a calm "just you in this realm". */
const DISCOVERY_WINDOW_MS = 45000;
function updatePeerCount() {
  const n = net.peerCount() + 1;
  let cls = '', suffix = '';
  if (net.enabled && net.peerCount() === 0) {
    const elapsed = Date.now() - (net.joinedAt || Date.now());
    if (elapsed < DISCOVERY_WINDOW_MS) { cls = 'searching'; suffix = ' \u00B7 finding others'; }
    else { cls = 'settled'; suffix = ' \u00B7 just you in this realm'; }
  }
  peerCountEl.textContent = `DRIFTERS HERE: ${n}${suffix}`;
  peerCountEl.className = cls;
}
setInterval(updatePeerCount, 1000);

function handleWisp(id, d) {
  if (!d || !Array.isArray(d.p)) return;
  const nm = String(d.n || 'drifter').slice(0, 16) || 'drifter';
  peerPositions.set(id, new THREE.Vector3(d.p[0], d.p[1], d.p[2])); // proximity table
  let pv = peerVisuals.get(id);
  if (!pv) {
    if (peerVisuals.size >= MAX_REMOTE) return; // render cap; count still tracks
    pv = createPeerVisual(id, nm);
    pv.skin = d.s || null; applyPeerSkin(pv, pv.skin);
    pv.hatId = d.h || null; applyPeerHat(pv, pv.hatId);
    pv.trailStyle = d.t || null; pv.trailColor = d.c || null;
    applyPeerTrail(pv, pv.trailStyle, pv.trailColor);
    pv.target.set(d.p[0], d.p[1], d.p[2]);
    pv.group.position.copy(pv.target); // snap on first sight
    pv.trailObj.clear(pv.group.position); // no streak from the origin
    peerVisuals.set(id, pv);
    peerLayer.add(pv.group);
    peerLayer.add(pv.trailObj.group);
    addSystemLine(`${nm} drifted in`);
    updatePeerCount();
  } else {
    pv.target.set(d.p[0], d.p[1], d.p[2]);
    if (pv.name !== nm) { pv.name = nm; retagPeer(pv, nm); }
    const s = d.s || null, h = d.h || null;
    if (pv.skin !== s) { pv.skin = s; applyPeerSkin(pv, s); }
    if (pv.hatId !== h) { pv.hatId = h; applyPeerHat(pv, h); }
    const ts = d.t || null, tc = d.c || null;
    if (pv.trailStyle !== ts || pv.trailColor !== tc) {
      pv.trailStyle = ts; pv.trailColor = tc;
      applyPeerTrail(pv, ts, tc);
    }
  }
}

function handlePeerLeave(id) {
  const pv = peerVisuals.get(id);
  if (pv) {
    addSystemLine(`${pv.name} drifted away`);
    peerLayer.remove(pv.group);
    if (pv.trailObj) peerLayer.remove(pv.trailObj.group);
    peerVisuals.delete(id);
  }
  peerPositions.delete(id);
  // DJ slot: if we were listening to them, the music stops.
  if (dj.listenPeerId === id) {
    detachDjListener();
    renderDjHud();
  }
  updatePeerCount();
}

// Wire the net callbacks once; rooms are (re)joined on start + portal hops.
net.onWispCb = handleWisp;
net.onPeerLeaveCb = handlePeerLeave;
net.onChatCb = (d, peerId) => {
  if (!d) return;
  const nm = String(d.n || 'drifter').slice(0, 16) || 'drifter';
  const tx = String(d.t || '').slice(0, 140);
  if (!tx) return;
  // Proximity chat: only display peers within earshot. Unknown position
  // (no wisp yet) is treated as near — better than dropping a greeting.
  const pos = peerId ? peerPositions.get(peerId) : null;
  const dist = pos ? wisp.position.distanceTo(pos) : 0;
  if (dist <= PROXIMITY_R) {
    addChatLine(nm, tx);
    if (peerId) showChatBubble(peerId, tx);
  } else {
    recordChat(nm, tx, false, false, true); // kept in history, marked distant
    const now = Date.now();
    if (now - lastDistantHint > 15000) {
      lastDistantHint = now;
      addSystemLine('you sense distant chatter\u2026');
    }
  }
};
net.onQuietCb = () =>
  addSystemLine('the void is quiet here — drift to the Nexus to find other drifters');
net.onPresenceCb = () => { if (settingsOpen) renderFriendsSection(); };
// DJ slot (build 12): claims changed — re-resolve the slot, yield if beaten.
net.onDjCb = () => {
  const w = djWinner();
  if (dj.active && w && !w.isSelf) {
    stopDecks(true, w.name); // their claim is earlier: yield gracefully
    return;
  }
  if (!dj.active && !w) {
    detachDjListener(); // decks empty: stop any audio
    jamStopRecorder();
    jamStopClock(); // no DJ, no clock
  }
  renderDjHud();
  if (settingsOpen) renderFriendsSection();
};
// Someone's audio track arrived — listen only if they're the current DJ.
net.onRemoteTrackCb = (track, stream, peerId) => {
  if (!active || active.key !== SOUND_ROOM_KEY) return;
  const w = djWinner();
  if (w && !w.isSelf && w.peerId !== peerId) return; // not the DJ's track
  attachDjListener(stream); // starts with detachDjListener, so set the peer after
  dj.listenPeerId = peerId;
  addSystemLine(`${w ? w.name : 'a drifter'} is on the decks \u{1F3A7}`);
  renderDjHud();
};

// Jam room (build 13): clock/note/pad events -> local synthesis.
net.onJamClockCb = handleJamClock;
net.onJamNoteCb = handleJamNote;
net.onJamPadCb = handleJamPad;
net.onJamTickCb = () => jamBroadcastClock(); // 15s clock re-broadcast while we hold the decks

/* ---------------- settings panel ----------------
   Gear button opens it; D key is a desktop shortcut to the same panel.
   panel. Holds the net debug readout, sound toggle, and drifter name. */

let settingsOpen = false;
function setSettings(open) {
  settingsOpen = open;
  settingsPanel.classList.toggle('open', open);
  if (open) {
    settingsName.value = myName;
    soundToggle.textContent = audio.muted ? 'OFF' : 'ON';
    renderWispSection();
    renderFriendsSection();
    updateDebugHud();
  }
}
function setMuted(muted) {
  muteEl.textContent = muted ? 'SOUND OFF' : 'SOUND ON';
  soundToggle.textContent = muted ? 'OFF' : 'ON';
  if (dj.listenAudioEl) { try { dj.listenAudioEl.muted = muted; } catch (e) {} }
  try { localStorage.setItem('limbo_muted', muted ? '1' : ''); } catch (e) { /* ignore */ }
}
gearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setSettings(!settingsOpen);
  gearBtn.blur();
});
settingsClose.addEventListener('click', () => setSettings(false));
soundToggle.addEventListener('click', () => {
  setMuted(audio.toggleMute());
  soundToggle.blur();
});
settingsName.addEventListener('change', () => {
  const raw = settingsName.value.trim().slice(0, 16) || 'drifter';
  myName = raw;
  net.name = raw; // live: future wisp broadcasts + chat carry the new name
  net.setPresence(raw, active ? active.key : 'nexus'); // lobby heartbeat carries the new name too
  try { localStorage.setItem('limbo_name', raw); } catch (e) { /* ignore */ }
  if (nameInput) nameInput.value = raw;
  addSystemLine(`you are now known as ${raw}`);
  settingsName.blur();
});
// Add a drifter to the friends list by name (Enter works too).
friendAddBtn.addEventListener('click', () => {
  if (addFriend(friendAddInput.value)) friendAddInput.value = '';
  friendAddBtn.blur();
});
friendAddInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep game keys out of the window handler
  if (e.key === 'Enter') {
    if (addFriend(friendAddInput.value)) friendAddInput.value = '';
    friendAddInput.blur();
  } else if (e.key === 'Escape') friendAddInput.blur();
});
// Typing a name isn't flying: reuse the chat field's "don't fly" guard.
friendAddInput.addEventListener('focus', () => {
  chatFocused = true;
  for (const k in keys) keys[k] = false;
});
friendAddInput.addEventListener('blur', () => { chatFocused = false; });

/* ---------------- debug readout (lives in the settings panel) ----------------
   Diagnoses multiplayer live on the device: ICE states, candidate types
   (host/srflx/relay — 'relay' means TURN allocation worked), selected
   pair, and trystero's own join-error text. Works with zero peers. */

const debugHud = document.createElement('div');
debugHud.id = 'debug-hud';
settingsDebug.appendChild(debugHud); // styled by #debug-hud in style.css

async function updateDebugHud() {
  if (!settingsOpen) return;
  let s;
  try {
    s = await net.getDebugSnapshot();
  } catch (e) {
    debugHud.textContent = 'debug snapshot failed: ' + e.message;
    return;
  }
  const L = [];
  L.push(`LIMBO net debug · build ${s.build} · ${s.enabled ? 'online' : 'OFFLINE (single-player)'}`);
  L.push(`strategy: ${s.strategy} · room: ${s.roomKey}`);
  L.push(`peers: ${s.peerCount} · turn user: ${s.turnUser}`);
  // (a) relay websocket connectivity — open vs shut per pinned relay
  if (s.relays) {
    L.push('relays: ' + s.relays.map((r) => `${r.host}${r.open ? '✓' : '✗'}`).join(' '));
  } else {
    L.push('relays: n/a (torrent strategy)');
  }
  // (b)+(c) discovery & handshake stages per observed peer id
  if (s.hsPeers && s.hsPeers.length) {
    L.push('discovery: ' + s.hsPeers.map((h) =>
      `${h.id}:${h.stage}${h.initiator === true ? '(init)' : ''} sig↓${h.sigIn}↑${h.sigOut}`
    ).join(' · '));
  } else {
    L.push('discovery: no peer announces seen yet');
  }
  // recent nostr wire frames (dir/topic[/peer])
  if (s.frames && s.frames.length) {
    L.push('wire: ' + s.frames.slice(-8).join(' '));
  }
  if (s.peers.length === 0) {
    L.push('no peer connections — signaling found nobody (or room not joined yet)');
  }
  for (const p of s.peers) {
    L.push(`— peer ${p.id}`);
    L.push(`  ice:${p.ice} gather:${p.gathering} conn:${p.conn}`);
    L.push(`  local candidates: ${p.localTypes.length ? p.localTypes.join(',') : '(none yet)'}`);
    L.push(`  selected pair: ${p.selectedType}`);
  }
  if (s.lastJoinError) {
    L.push(`LAST JOIN ERROR [${s.lastJoinError.at}] peer ${s.lastJoinError.peerId}:`);
    L.push(`  ${s.lastJoinError.error}`);
  }
  debugHud.textContent = L.join('\n');
}
setInterval(updateDebugHud, 1000);

/* ---------------- start ---------------- */

let hintTimer = null;
driftBtn.addEventListener('click', () => {
  const raw = (nameInput.value || '').trim().slice(0, 16) || 'drifter';
  myName = raw;
  try { localStorage.setItem('limbo_name', raw); } catch (e) { /* ignore */ }
  audio.init(active ? active.root : NEXUS_DEF.root);
  try { if (localStorage.getItem('limbo_muted')) setMuted(audio.toggleMute()); } catch (e) { /* ignore */ }
  overlayEl.classList.add('gone');
  started = true;
  hintTimer = setTimeout(() => hintEl.classList.add('gone'), 15000);
  // Multiplayer: best-effort — the game plays exactly like v1 without it.
  net.boot(myName).then((ok) => {
    if (ok) {
      net.setPresence(myName, active.key);
      net.joinLobby(); // shared presence room: who's live, where
      net.join(roomKeyFor(active.key));
      updatePeerCount();
    } else {
      addSystemLine('the void is quiet tonight — drifting solo');
    }
  });
});

/* ---------------- per-frame ---------------- */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _camWant = new THREE.Vector3();
const _lookAt = new THREE.Vector3();

function updatePlayer(dt) {
  // Camera-relative flight axes.
  const cp = Math.cos(pitch);
  _fwd.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

  _move.set(0, 0, 0);
  let ix = 0, iz = 0, iy = 0;
  if (!chatFocused) { // never fly while typing in chat
    if (keys.KeyW || keys.ArrowUp) iz += 1;
    if (keys.KeyS || keys.ArrowDown) iz -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.Space || keys.KeyE) iy += 1;
    if (keys.ShiftLeft || keys.ShiftRight || keys.KeyQ) iy -= 1;
  }
  ix += joy.x; iz -= joy.y; // touch joystick (up = forward)

  _move.addScaledVector(_fwd, iz).addScaledVector(_right, ix);
  _move.y += iy * 0.9;
  if (_move.lengthSq() > 0) {
    _move.normalize();
    vel.addScaledVector(_move, 26 * dt);
  }

  // Dreamy inertia: exponential damping, then clamp speed.
  vel.multiplyScalar(Math.exp(-2.4 * dt));
  const sp = vel.length();
  if (sp > 16) vel.multiplyScalar(16 / sp);

  wisp.position.addScaledVector(vel, dt);

  // Keep the wisp inside its world.
  if (active.bound === 'realm') {
    wisp.position.x = Math.max(-52, Math.min(52, wisp.position.x));
    wisp.position.y = Math.max(-8, Math.min(36, wisp.position.y));
    wisp.position.z = Math.max(-54, Math.min(32, wisp.position.z));
  } else {
    const hx = wisp.position.x, hz = wisp.position.z;
    const hd = Math.hypot(hx, hz);
    if (hd > NEXUS_BOUND) {
      wisp.position.x = (hx / hd) * NEXUS_BOUND;
      wisp.position.z = (hz / hd) * NEXUS_BOUND;
    }
    wisp.position.y = Math.max(-6, Math.min(30, wisp.position.y));
  }

  // Wisp idle breathing.
  const b = 1 + Math.sin(clock.elapsedTime * 2.1) * 0.07;
  wispCore.scale.set(b, b, b);

  // Third-person follow camera with soft lag.
  _camWant.copy(wisp.position).addScaledVector(_fwd, -7).add(new THREE.Vector3(0, 2.2, 0));
  camera.position.lerp(_camWant, 1 - Math.exp(-8 * dt));
  _lookAt.copy(wisp.position).addScaledVector(_fwd, 8);
  camera.lookAt(_lookAt);

  pushTrail(dt);
}

function checkPortals() {
  if (transitioning) return;
  if (clock.elapsedTime - lastTransition < 1.2) return; // settle after arriving
  for (const p of active.portals) {
    if (wisp.position.distanceTo(p.pos) < PORTAL_TRIGGER) {
      goTo(p.target);
      return;
    }
  }
}

function checkEchoes() {
  if (transitioning || active.bound === 'nexus') return;
  for (const e of active.echoes) {
    if (!e.collected && wisp.position.distanceTo(e.mesh.position) < ECHO_TRIGGER) {
      collectEcho(e);
    }
  }
}

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05); // clamp huge tabs
  const t = clock.elapsedTime;

  active.update(dt, t);

  // Sound room reactivity (build 12): bass energy from the DJ stream —
  // ours when we're on the decks, the remote one when we're listening.
  {
    let target = 0;
    const an = dj.analyser || dj.listenAnalyser;
    const data = dj.analyserData || dj.listenAnalyserData;
    if (an && data) {
      try {
        an.getByteFrequencyData(data);
        let s = 0, n = 0;
        for (let i = 1; i < 8 && i < data.length; i++) { s += data[i]; n++; }
        target = n ? (s / n / 255) * 1.6 : 0;
      } catch (e) {}
    }
    djBassSmooth += (Math.min(1, target) - djBassSmooth) * Math.min(1, dt * 6);
    if (active.key === SOUND_ROOM_KEY && active.setBass) active.setBass(djBassSmooth);
  }

  updatePlayer(dt);
  checkPortals();
  checkEchoes();

  // Multiplayer: broadcast our wisp, ease remote wisps toward their targets.
  if (started) {
    netTimer += dt;
    if (netTimer >= 1 / 12) {
      netTimer = 0;
      net.broadcast(wisp.position);
    }
    const k = 1 - Math.exp(-9 * dt);
    for (const pv of peerVisuals.values()) {
      pv.group.position.lerp(pv.target, k);
      pv.bob.position.y = Math.sin(t * 2.2 + pv.phase) * 0.3;      // Floating chat bubbles: rise, fade, vanish after BUBBLE_SECS.
      // Remote trails: short + low-res, skipped beyond 150m for perf.
      const pd = pv.group.position.distanceTo(wisp.position);
      const showTrail = pd < 150;
      pv.trailObj.group.visible = showTrail;
      if (showTrail) pv.trailObj.update(pv.group.position, dt);
      if (pv.bubble) {
        const remain = pv.bubble.expires - t;
        if (remain <= 0) {
          pv.group.remove(pv.bubble.sprite);
          pv.bubble = null;
        } else {
          pv.bubble.sprite.position.y = 2.9 + (1 - remain / BUBBLE_SECS) * 1.2;
          pv.bubble.sprite.material.opacity = Math.min(1, remain / 1.2);
        }
      }
    }
    // Local hat: gentle bob + sway so it feels worn, not glued on.
    if (wispHat) {
      wispHat.position.y = 0.42 + Math.sin(t * 2.2) * 0.05;
      wispHat.rotation.y = Math.sin(t * 0.7) * 0.12;
    }
  }

  renderer.render(active.scene, camera);
}

/* ---------------- resize ---------------- */

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* Test + diagnostics hook: exposes multiplayer internals so automated
   tests (and future debugging) can drive the chat/proximity paths
   without needing a real second peer. */
window.__limbo = {
  net,
  wisp,
  camera,
  peerVisuals,
  chatHistory: () => chatHistory.slice(),
  myName: () => myName,
  setPeerPos: (id, x, y, z) => peerPositions.set(id, new THREE.Vector3(x, y, z)),
  getPeerPos: (id) => peerPositions.get(id),
  handleWisp,
  showChatBubble,
  PROXIMITY_R,
  build: net.build,
  // customization (build 8) + trails (build 9)
  SKINS,
  HATS,
  SKIN_ORDER,
  HAT_ORDER,
  TRAIL_STYLES,
  TRAIL_COLORS,
  TRAIL_STYLE_ORDER,
  TRAIL_COLOR_ORDER,
  unlocks: () => JSON.parse(JSON.stringify(unlocks)),
  equipped: () => ({ ...equipped }),
  grantAttunement: onRealmAttuned,
  applySkin,
  applyHat,
  applyTrail,
  localTrail,
  applyPeerTrail,
  collectEcho,
  renderWispSection,
  // friends + live presence (build 11)
  getFriends: () => friends.slice(),
  addFriend,
  removeFriend,
  renderFriendsSection,
  goTo,
  activeKey: () => (active ? active.key : null),
  setPresence: (n, r) => net.setPresence(n, r),
  presencePayload: () => net._presencePayload(),
  lobbyPeers: () => [...net.lobbyPeers.entries()].map(([id, p]) => ({ id, ...p })),
  lobbyMap: () => net.lobbyPeers, // live map: tests time-travel lastSeen for expiry
  notePresence: (id, d) => net._notePresence(id, d),
  sweepLobby: (now) => net._sweepLobby(now),
  joinLobby: () => net.joinLobby(),
  // sound room + DJ slot (build 12)
  SOUND_DEF,
  worldKeys: () => Object.keys(worlds),
  nexusPortals: () => (worlds.nexus ? worlds.nexus.portals.map((p) => p.target) : []),
  galleryFiles: () => (worlds.soundroom && worlds.soundroom.gallery ? worlds.soundroom.gallery.slice() : []),
  takeDecks,
  stopDecks,
  djState: () => ({
    active: dj.active,
    winner: djWinner(),
    claims: [...net.djClaims.entries()].map(([id, c]) => ({ id, ...c })),
    listening: !!dj.listenAudioEl,
    listenPeerId: dj.listenPeerId,
    bass: djBassSmooth,
  }),
  noteDjClaim: (id, d) => net._noteDjClaim(id, d),
  sweepDj: (now) => net._sweepDjClaims(now),
  djClaimPayload: () => net._djClaimPayload(),
  setDj: (r) => net.setDj(r),
  livePresenceFor,
  renderDjHud,
  remoteTrack: (track, stream, peerId) => net._onRemoteTrack(track, stream, peerId),
  // jam room (build 13)
  jamState: () => ({
    open: jam.open,
    bpm: jam.bpm,
    clockOn: jam.startWall != null,
    by: jam.clockBy,
    manual: jam.manual,
    wave: jam.wave,
    cutoff: jam.cutoff,
    reso: jam.reso,
    padsLoaded: jam.pads.map((b) => !!b),
    voices: jamVoicesSpawned,
    queue: jamQueue.length,
    jammers: [...jam.jammers.keys()],
  }),
  jamBeatNow,
  jamQuantize: (q) => {
    const n = jamBeatNow();
    return n == null ? null : quantizeUp(n, q);
  },
  jamSetBpm: (b, o) => jamSetBpm(b, o || {}),
  jamBroadcastClock: () => jamBroadcastClock(),
  jamClockMsg: () => ({ bpm: jam.bpm, startWall: jam.startWall, by: myName }),
  jamTestClock: (bpm, startWallAgoMs) => {
    jam.bpm = bpm;
    jam.startWall = Date.now() - startWallAgoMs;
    renderJamTransport();
  },
  jamNote: (d, pid) => handleJamNote(d, pid),
  jamPad: (d, pid) => handleJamPad(d, pid),
  jamClockIn: (d, pid) => handleJamClock(d, pid),
  jamPlayLocal: (m, v) => jamPlayLocal(m, v),
  jamGrabLoop: () => jamGrabLoop(),
  jamTriggerPad: (i) => jamTriggerPad(i),
  jamOnBecomeDj: () => jamOnBecomeDj(),
  jamStopClock: () => jamStopClock(),
  jamDetectTick: () => jamDetectTick(),
  jamEstimateBpm: (o) => estimateBpm(o),
  newOnsetDetector: () => new OnsetDetector(),
  setJamPanel: (o) => setJamPanel(o),
  jamOpen: () => jam.open,
  jamAudioTimeForBeat: (b) => jamAudioTimeForBeat(b),
  // test helper: simulate holding the decks without real media capture
  jamSimulateDj: (on) => { dj.active = !!on; renderDjHud(); renderJamTransport(); },
};
