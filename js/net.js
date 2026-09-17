/* LIMBO — serverless multiplayer via Trystero (WebRTC P2P, no server).
 *
 * One Trystero room per location ('limbo-nexus', 'limbo-realm-1' …).
 * The strategy modules are loaded with dynamic import inside boot() so a
 * blocked/unreachable CDN degrades gracefully to single-player — the game
 * never depends on this file succeeding.
 *
 * NAT TRAVERSAL — Trystero core ships STUN-only ICE servers, which cannot
 * punch through symmetric NAT (mobile carriers / CGNAT — i.e. phones). We
 * add TURN via the OpenRelay static-auth scheme (standard coturn TURN REST
 * API, the same one Nextcloud Talk / Jitsi use): credentials are derived
 * client-side with WebCrypto HMAC-SHA1, no signup needed. NOTE: Trystero
 * REPLACES its default iceServers with ours when rtcConfig is passed
 * (core: new RTCPeerConnection({iceServers: defaults, ...rtcConfig})), so
 * we include STUN entries ourselves. The old fixed openrelayproject /
 * openrelayproject password pair is stale — do not use it.
 *
 * SIGNALING FALLBACK — torrent trackers first; if no peer shows up within
 * 15s we leave and rejoin the SAME room key via the Nostr strategy. Both
 * clients run identical logic, so they converge on the same strategy.
 */

const APP_ID = 'limbo_by_holowatts';
const MAX_NAME = 16;
const NEXUS_ROOM = 'limbo-nexus';
/* Shared presence room: every client joins it at boot and heartbeats
   {name, realm} here. Presence ONLY — no wisps, no chat — so the friends
   list can show who's live and where without joining every realm room. */
const LOBBY_ROOM = 'limbo-lobby';
const PRESENCE_INTERVAL_MS = 15000; // heartbeat cadence
const PRESENCE_EXPIRE_MS = 45000;   // silent this long -> considered gone
const PRESENCE_SWEEP_MS = 10000;    // how often expired entries are reaped
/* Sound room (build 12): room key for the DJ/social space, and the DJ
   claim protocol — one DJ at a time, earliest fresh claim wins. */
const SOUND_ROOM_KEY = 'limbo-realm-5';
const DJ_CLAIM_INTERVAL_MS = 15000; // claim heartbeat while holding the decks
const DJ_CLAIM_EXPIRE_MS = 45000;   // silent this long -> claim dropped
/* Bump on every deploy — shown in the debug HUD (press D) so we can tell
   whether a phone is actually running the latest code or a cached copy. */
const BUILD = '13';

/* No peers after this long -> switch signaling strategy (once). */
const FALLBACK_AFTER_MS = 15000;
/* Alone in a realm room this long -> suggest the Nexus (once per visit). */
const QUIET_AFTER_MS = 20000;

const STRATEGIES = [
  // Pinned to 0.25.4: unpinned esm.sh URLs resolve "latest", which could
  // silently change the module's export shape and break the import.
  { name: 'torrent', url: 'https://esm.sh/@trystero-p2p/torrent@0.25.4' },
  { name: 'nostr', url: 'https://esm.sh/@trystero-p2p/nostr@0.25.4' },
];

/* Nostr relay pinning — the 0.25.4 nostr strategy picks 5 relays
   deterministically from its 28 defaults, seeded by appId. For our appId
   that set included two flaky relays (nostr.sathoarder.com, schnorr.me —
   both timed out in testing), so we pin the 3 reliable ones. Verified in
   the module source: getRelays(config, defaults, 5) returns
   config.relayConfig.urls when set. */
const NOSTR_RELAYS = [
  'wss://yabu.me/v2',
  'wss://relay02.lnfi.network',
  'wss://relay.sigit.io',
];

/* OpenRelay static-auth (no signup): time-limited HMAC-SHA1 credentials. */
const TURN_HOST = 'staticauth.openrelay.metered.ca';
const TURN_SECRET = 'openrelayprojectsecret';
const TURN_TTL_S = 24 * 3600; // credentials valid 24h

async function makeTurnCreds() {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_S;
  const username = `${expiry}:limbo`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TURN_SECRET),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(username)
  );
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { username, password: btoa(bin), expiry };
}

function buildIceServers(creds) {
  return [
    // STUN first (cheap, direct); Trystero's defaults are replaced, so ours
    // must be complete.
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
    // TURN relay for symmetric NATs — UDP then TCP flavors.
    {
      urls: [`turn:${TURN_HOST}:80`, `turn:${TURN_HOST}:443`],
      username: creds.username,
      credential: creds.password,
    },
    {
      urls: `turns:${TURN_HOST}:443`,
      username: creds.username,
      credential: creds.password,
    },
  ];
}

export class LimboNet {
  constructor() {
    this.build = BUILD; // deploy stamp, shown in the debug HUD
    this.enabled = false;
    this.mods = []; // lazy-loaded strategy modules, indexed like STRATEGIES
    this.stratIdx = 0; // which signaling strategy is currently in use
    this.rtcConfig = null;
    this.turnCreds = null;
    this.selfId = null;
    this.room = null;
    this.roomKey = null;
    this.joinedAt = 0; // discovery window start (drives the "finding others" UI)
    this.peers = new Map(); // peerId -> true (presence in current room)
    this.name = 'drifter';
    this.sendWisp = null;
    this.sendChat = null;
    this.cosmetics = null; // () => ({s: skinId, h: hatId, t: trailStyle, c: trailHex6}) — set by game.js
    this.onWispCb = null; // (peerId, {p:[x,y,z], n:name, s:skin, h:hat})
    this.onChatCb = null; // ({n:name, t:text}, peerId)
    this.onPeerLeaveCb = null; // (peerId)
    this.onQuietCb = null; // () — fired once per room visit when alone too long
    // --- lobby presence (build 11) ---
    this.lobbyRoom = null;
    this.sendPresence = null;
    this.lobbyPeers = new Map(); // peerId -> {name, room, lastSeen}
    this.onPresenceCb = null; // () — lobby roster changed (heartbeat/expire)
    this.presenceName = 'drifter';
    this.presenceRoom = 'nexus';
    this.presenceDj = null; // roomKey where we're DJing, or null — rides the heartbeat
    this._presenceTimer = null;
    this._sweepTimer = null;
    // --- DJ slot (build 12) ---
    this.sendDjClaim = null;
    this.djClaims = new Map(); // peerId -> {name, t, lastSeen}
    this.myDjClaim = null; // {t} while WE hold the decks
    this.djMedia = null; // {track, stream} while we stream audio
    this._djTimer = null;
    this.onDjCb = null; // () — DJ claims changed (claim/release/expire/yield)
    this.onRemoteTrackCb = null; // (track, stream, peerId) — someone's audio arrived
    // --- jam room (build 13) ---
    this.sendJamClock = null; // (data) — {bpm, startWall, by}, DJ -> room
    this.sendJamNote = null; // (data) — {n, midi, vel, beat}, any jammer -> room
    this.sendJamPad = null; // (data) — {n, pad, beat, lenBars}, any jammer -> room
    this.onJamClockCb = null; // (data, peerId)
    this.onJamNoteCb = null; // (data, peerId)
    this.onJamPadCb = null; // (data, peerId)
    this.onJamTickCb = null; // () — fires on our 15s DJ heartbeat while we hold the decks
    this.fallbackTimer = null;
    this.quietTimer = null;
    this.quietFired = false;
    this.lastJoinError = null; // {error, peerId, at} from trystero onJoinError
    // --- handshake-stage diagnostics (debug HUD) ---
    this.hsPeers = new Map(); // shortId -> {stage, firstSeen, lastSeen, sigIn, sigOut, initiator}
    this.nostrFrames = []; // ring buffer of recent nostr EVENT frames (compact strings)
    this.relayHosts = NOSTR_RELAYS.map((u) => {
      try {
        return new URL(u).host;
      } catch (e) {
        return u;
      }
    });
    this._installWsTap();
  }

  cleanName(n) {
    return String(n || 'drifter').trim().slice(0, MAX_NAME) || 'drifter';
  }

  get mod() {
    return this.mods[this.stratIdx];
  }

  /* One-time WebSocket wrapper that taps nostr signaling frames for the
     debug HUD. Trystero 0.25.4 exposes no event for "saw a peer announce"
     or per-relay socket state, so we observe the wire directly: the nostr
     module creates its sockets via `new WebSocket(url)`, and our subclass
     logs EVENT frames to/from our pinned relay hosts. Everything else
     passes through to the native WebSocket untouched. Installed before the
     strategy module is dynamically imported, so its sockets get wrapped. */
  _installWsTap() {
    try {
      if (typeof window === 'undefined' || !window.WebSocket) return;
      if (window.__limboNostrTap) return; // installed already
      const hosts = this.relayHosts;
      const note = (dir, url, data) => {
        try {
          this._noteNostrFrame(dir, url, data);
        } catch (e) {
          /* diagnostics must never break networking */
        }
      };
      const NativeWS = window.WebSocket;
      class TapWS extends NativeWS {
        constructor(url, protocols) {
          super(url, protocols);
          try {
            if (hosts.some((h) => String(url).indexOf(h) !== -1)) {
              this.addEventListener('message', (ev) =>
                note('in', String(url), String(ev.data))
              );
              const rawSend = this.send.bind(this);
              this.send = (data) => {
                note('out', String(url), String(data));
                return rawSend(data);
              };
            }
          } catch (e) {
            /* never break the socket */
          }
        }
      }
      window.WebSocket = TapWS;
      window.__limboNostrTap = true;
    } catch (e) {
      /* tap is optional */
    }
  }

  /* Parse one nostr frame (relay<->client). Incoming frames look like
     ["EVENT", subId, {kind, tags, content, pubkey}]; outgoing look like
     ["EVENT", {kind, tags, content}]. The "x" tag is an opaque topic hash,
     so we label frames by content shape instead: announce content is just
     {"peerId"}, signal content carries offer/answer payloads. */
  _noteNostrFrame(dir, url, data) {
    if (!data || data.charCodeAt(0) !== 91) return; // must start with '['
    if (data.indexOf('"EVENT"') === -1) return;
    let arr;
    try {
      arr = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!Array.isArray(arr) || arr[0] !== 'EVENT') return;
    const ev =
      arr[1] && typeof arr[1] === 'object' && typeof arr[1].kind === 'number'
        ? arr[1]
        : arr[2] && typeof arr[2] === 'object'
          ? arr[2]
          : null;
    if (!ev || typeof ev.kind !== 'number') return;
    let topicKind = '?';
    let peerId = null;
    if (typeof ev.content === 'string') {
      try {
        const c = JSON.parse(ev.content);
        if (c && c.peerId) {
          peerId = String(c.peerId).slice(0, 8);
          topicKind = c.offer || c.answer || c.offerId ? 'signal' : 'announce';
        }
      } catch (e) {}
    }
    const now = new Date().toLocaleTimeString();
    this.nostrFrames.push(
      `${dir}/${topicKind}${peerId ? '/' + peerId : ''}`
    );
    if (this.nostrFrames.length > 14) this.nostrFrames.shift();
    if (peerId && (topicKind === 'announce' || topicKind === 'signal')) {
      const selfShort = this.selfId ? String(this.selfId).slice(0, 8) : null;
      const isSelf = selfShort && peerId === selfShort;
      const rec = this.hsPeers.get(peerId) || {
        stage: 'seen',
        firstSeen: now,
        lastSeen: now,
        sigIn: 0,
        sigOut: 0,
        initiator: null,
      };
      if (isSelf) {
        // Our own announce echoed back by the relay — proves the relay
        // round-trips; not another player.
        rec.stage = 'self';
      } else if (topicKind === 'announce' && rec.stage === 'seen') rec.stage = 'discovered';
      if (topicKind === 'signal') {
        if (dir === 'in') rec.sigIn++;
        else rec.sigOut++;
        if (rec.stage === 'seen' || rec.stage === 'discovered') rec.stage = 'signaling';
      }
      rec.lastSeen = now;
      this.hsPeers.set(peerId, rec);
    }
  }

  /* Which pinned nostr relays actually have an open socket. Uses the
     module's own exported getRelaySockets() (0.25.4 exports it) — no
     guessing at internals. NOTE: despite the name it returns a plain
     {url: WebSocket} object, not a Map (verified live). Returns null when
     the nostr strategy isn't the active one. */
  _getRelayStatus() {
    try {
      const mod = this.mod;
      if (!mod || typeof mod.getRelaySockets !== 'function') return null;
      const m = mod.getRelaySockets();
      const entries =
        m && typeof m.forEach === 'function' ? [...m.entries()] : Object.entries(m || {});
      return entries.map(([url, ws]) => ({
        host: String(url).replace(/^wss:\/\//, ''),
        open: !!ws && ws.readyState === 1,
      }));
    } catch (e) {
      return null;
    }
  }

  _hsTouch(id, stage) {
    const now = new Date().toLocaleTimeString();
    const rec = this.hsPeers.get(id) || {
      stage,
      firstSeen: now,
      lastSeen: now,
      sigIn: 0,
      sigOut: 0,
      initiator: null,
    };
    rec.stage = stage;
    rec.lastSeen = now;
    this.hsPeers.set(id, rec);
    return rec;
  }

  /* Loads the first strategy + TURN credentials. Resolves true/false. */
  async boot(name) {
    this.name = this.cleanName(name);
    try {
      this.turnCreds = await makeTurnCreds();
      this.rtcConfig = { iceServers: buildIceServers(this.turnCreds) };
      this.mods[0] = await import(STRATEGIES[0].url);
      this.selfId = this.mods[0].selfId;
      this.enabled = true;
    } catch (err) {
      this.enabled = false; // offline / CDN blocked: single-player
    }
    return this.enabled;
  }

  /* Refresh TURN credentials when they're close to expiring (long sessions). */
  async _refreshTurnCreds() {
    const now = Math.floor(Date.now() / 1000);
    if (!this.turnCreds || now > this.turnCreds.expiry - 600) {
      this.turnCreds = await makeTurnCreds();
      this.rtcConfig = { iceServers: buildIceServers(this.turnCreds) };
    }
  }

  /* Leave the current room (if any) and join a new one. */
  async join(roomKey) {
    if (!this.enabled) return;
    this.leave();
    this.roomKey = roomKey;
    this.joinedAt = Date.now(); // discovery window start (drives the "finding others" UI)
    this.quietFired = false;
    this.hsPeers.clear(); // fresh diagnostics per room visit
    this.nostrFrames.length = 0;
    try {
      await this._refreshTurnCreds();
    } catch (e) {
      /* keep going with existing creds; worst case TURN rejects and we
         fall back to STUN-only behavior for this room */
    }
    this._joinWithStrategy();
    this._armFallbackTimer();
    this._armQuietTimer();
  }

  _joinWithStrategy() {
    try {
      const isNostr = STRATEGIES[this.stratIdx].name === 'nostr';
      const room = (this.room = this.mod.joinRoom(
        {
          appId: APP_ID,
          rtcConfig: this.rtcConfig,
          // Pin the 3 reliable nostr relays (verified config key in the
          // 0.25.4 module source: getRelays uses config.relayConfig.urls).
          ...(isNostr ? { relayConfig: { urls: NOSTR_RELAYS } } : {}),
          // Trystero calls this when SDP was exchanged but the peer
          // connection failed — carries the real reason (ICE/TURN/etc).
          onJoinError: (details) => {
            this.lastJoinError = {
              error: String((details && details.error) || details || 'unknown'),
              peerId: details && details.peerId ? String(details.peerId).slice(0, 8) : '?',
              at: new Date().toLocaleTimeString(),
            };
          },
          // Fires per peer during the WebRTC handshake, BEFORE onPeerJoin
          // (which only fires after the data channel fully connects). The
          // core composes this with its internal handshake handler, so
          // observing here is safe. Lets the HUD tell "discovered but
          // handshake stalled" apart from "never discovered".
          onPeerHandshake: (peerId, _send, _receive, isInitiator) => {
            const id = String(peerId).slice(0, 8);
            const rec = this._hsTouch(id, 'handshaking');
            rec.initiator = !!isInitiator;
          },
        },
        this.roomKey
      ));
      // Trystero 0.25.x API: makeAction returns an action OBJECT (not a
      // [send, receive] tuple), and room event handlers are property
      // assignments (not method calls). The old call style throws.
      const wispAction = room.makeAction('wisp');
      const chatAction = room.makeAction('chat');
      this.sendWisp = (data) => wispAction.send(data);
      this.sendChat = (data) => chatAction.send(data);
      wispAction.onMessage = (d, info) => {
        if (this.onWispCb) this.onWispCb(info && info.peerId, d);
      };
      chatAction.onMessage = (d, info) => {
        if (this.onChatCb) this.onChatCb(d, info && info.peerId);
      };
      /* DJ slot (build 12): claim protocol on every room (cheap; only the
         sound room ever uses it) + the media transport for the DJ's audio.
         Trystero 0.25.4 media API, verified against the published types:
           room.addTrack(track, stream, {target?}) -> Promise<void>[]
           room.removeTrack(track)
           room.onPeerTrack = (track, stream, peerId, metadata?) => void */
      const djAction = room.makeAction('djClaim');
      this.sendDjClaim = (data) => djAction.send(data);
      djAction.onMessage = (d, info) =>
        this._noteDjClaim(info && info.peerId, d);
      room.onPeerTrack = (track, stream, peerId) =>
        this._onRemoteTrack(track, stream, peerId);
      /* Jam room (build 13): clock/note/pad events. Fire-and-forget —
         every client synthesizes the sound locally, so these stay tiny.
         Created on every room like the DJ actions (cheap); only the
         sound room ever uses them. */
      const jamClockAction = room.makeAction('jamClock');
      const jamNoteAction = room.makeAction('jamNote');
      const jamPadAction = room.makeAction('jamPad');
      this.sendJamClock = (data) => jamClockAction.send(data);
      this.sendJamNote = (data) => jamNoteAction.send(data);
      this.sendJamPad = (data) => jamPadAction.send(data);
      jamClockAction.onMessage = (d, info) => {
        if (this.onJamClockCb) this.onJamClockCb(d, info && info.peerId);
      };
      jamNoteAction.onMessage = (d, info) => {
        if (this.onJamNoteCb) this.onJamNoteCb(d, info && info.peerId);
      };
      jamPadAction.onMessage = (d, info) => {
        if (this.onJamPadCb) this.onJamPadCb(d, info && info.peerId);
      };
      room.onPeerJoin = (id) => {
        this.peers.set(id, true);
        this._hsTouch(String(id).slice(0, 8), 'joined');
        this._clearFallbackTimer(); // someone made it — signaling works
        // Late joiner while we're DJing: send them the audio track too.
        if (this.djMedia && this.roomKey === SOUND_ROOM_KEY && this.room === room) {
          try {
            const p = this.room.addTrack(this.djMedia.track, this.djMedia.stream, { target: String(id) });
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch (e) { /* best effort */ }
        }
      };
      room.onPeerLeave = (id) => {
        this.peers.delete(id);
        if (this.djClaims.delete(String(id)) && this.onDjCb) this.onDjCb();
        if (this.onPeerLeaveCb) this.onPeerLeaveCb(id);
      };
    } catch (err) {
      this.enabled = false;
      this.room = null;
    }
  }

  _clearFallbackTimer() {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  /* If nobody shows up on the current strategy, try the next one on the
     same room key. Both clients run this, so they converge. One shot. */
  _armFallbackTimer() {
    this._clearFallbackTimer();
    this.fallbackTimer = setTimeout(async () => {
      this.fallbackTimer = null;
      if (this.peers.size > 0) return;
      if (this.stratIdx >= STRATEGIES.length - 1) return; // nowhere left
      const next = this.stratIdx + 1;
      try {
        if (!this.mods[next]) this.mods[next] = await import(STRATEGIES[next].url);
      } catch (e) {
        return; // new strategy unreachable — stay where we are
      }
      this.stratIdx = next;
      this.selfId = this.mods[next].selfId;
      if (this.room) {
        try {
          this.room.leave();
        } catch (e) {
          /* ignore */
        }
        this.room = null;
      }
      this.peers.clear();
      this.sendWisp = this.sendChat = null;
      this.sendJamClock = this.sendJamNote = this.sendJamPad = null;
      this._joinWithStrategy();
      // Keep presence on the working strategy too: the lobby rejoins with
      // the new selfId; stale entries are dropped by the rejoin.
      if (this.lobbyRoom) {
        this._leaveLobby();
        this.joinLobby();
      }
      // Keep the DJ stream on the working strategy too (claim time is
      // preserved — we never stopped holding the decks).
      if (this.djMedia && this.room && this.roomKey === SOUND_ROOM_KEY) {
        try {
          const p = this.room.addTrack(this.djMedia.track, this.djMedia.stream);
          if (Array.isArray(p)) p.forEach((x) => x && x.catch && x.catch(() => {}));
        } catch (e) { /* best effort */ }
      }
      // no re-arm: single fallback, both sides converge identically
    }, FALLBACK_AFTER_MS);
  }

  /* Suggest the Nexus when a player sits alone in a realm room. */
  _armQuietTimer() {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (
        !this.quietFired &&
        this.peers.size === 0 &&
        this.roomKey &&
        this.roomKey !== NEXUS_ROOM &&
        this.onQuietCb
      ) {
        this.quietFired = true;
        this.onQuietCb();
      }
    }, QUIET_AFTER_MS);
  }

  leave() {
    this._clearFallbackTimer();
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    // Release the decks BEFORE the room goes away so listeners clear us.
    if (this.myDjClaim) this._sendDjRelease();
    this._stopDjTimers();
    this.myDjClaim = null;
    this.djMedia = null;
    this.sendDjClaim = null;
    this.djClaims.clear();
    if (this.room) {
      try {
        this.room.leave();
      } catch (e) {
        /* ignore */
      }
      this.room = null;
    }
    this.peers.clear();
    this.sendWisp = null;
    this.sendChat = null;
    this.sendJamClock = null;
    this.sendJamNote = null;
    this.sendJamPad = null;
  }

  /* ---------------- lobby presence (build 11) ----------------
     A second room joined once at boot. Heartbeats carry {n, r, t} only.
     leave()/join() never touch it — it survives realm hops. */

  /* Update what our heartbeat says, and re-broadcast immediately.
     No-op until the lobby is joined. game.js calls this on boot,
     realm change, and drifter-name change. */
  setPresence(name, roomKey) {
    this.presenceName = this.cleanName(name);
    this.presenceRoom = String(roomKey || 'nexus').slice(0, 16);
    this._presenceTick();
  }

  _presencePayload() {
    const p = { n: this.presenceName, r: this.presenceRoom, t: Date.now() };
    if (this.presenceDj) p.dj = this.presenceDj; // only when DJing — stays tiny
    return p;
  }

  _presenceTick() {
    if (!this.enabled || !this.sendPresence) return;
    try {
      this.sendPresence(this._presencePayload());
    } catch (e) {
      /* ignore */
    }
  }

  _notePresence(peerId, data) {
    try {
      if (!data || !peerId) return;
      if (String(peerId) === String(this.selfId)) return; // never list ourselves
      const name = this.cleanName(data.n);
      const room = String(data.r || 'nexus').slice(0, 16);
      const dj = typeof data.dj === 'string' && data.dj ? String(data.dj).slice(0, 16) : null;
      this.lobbyPeers.set(String(peerId), { name, room, dj, lastSeen: Date.now() });
      if (this.onPresenceCb) this.onPresenceCb();
    } catch (e) {
      /* ignore */
    }
  }

  /* Drop entries silent longer than PRESENCE_EXPIRE_MS. `now` is
     injectable so tests can time-travel instead of waiting 45s. */
  _sweepLobby(now) {
    const t = typeof now === 'number' ? now : Date.now();
    let dropped = 0;
    for (const [id, p] of this.lobbyPeers) {
      if (t - p.lastSeen > PRESENCE_EXPIRE_MS) {
        this.lobbyPeers.delete(id);
        dropped++;
      }
    }
    if (dropped > 0 && this.onPresenceCb) this.onPresenceCb();
  }

  joinLobby() {
    if (!this.enabled || this.lobbyRoom) return;
    try {
      const isNostr = STRATEGIES[this.stratIdx].name === 'nostr';
      const room = (this.lobbyRoom = this.mod.joinRoom(
        {
          appId: APP_ID,
          rtcConfig: this.rtcConfig,
          ...(isNostr ? { relayConfig: { urls: NOSTR_RELAYS } } : {}),
        },
        LOBBY_ROOM
      ));
      const presenceAction = room.makeAction('presence');
      this.sendPresence = (data) => presenceAction.send(data);
      presenceAction.onMessage = (d, info) =>
        this._notePresence(info && info.peerId, d);
      // A newcomer joining mid-session gets our heartbeat right away.
      room.onPeerJoin = () => this._presenceTick();
      this._presenceTick(); // announce ourselves on entry
      this._presenceTimer = setInterval(
        () => this._presenceTick(),
        PRESENCE_INTERVAL_MS
      );
      this._sweepTimer = setInterval(() => this._sweepLobby(), PRESENCE_SWEEP_MS);
    } catch (e) {
      this.lobbyRoom = null;
      this.sendPresence = null;
    }
  }

  _leaveLobby() {
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
    if (this.lobbyRoom) {
      try {
        this.lobbyRoom.leave();
      } catch (e) {
        /* ignore */
      }
      this.lobbyRoom = null;
    }
    this.sendPresence = null;
    this.lobbyPeers.clear();
  }

  /* ---------------- DJ slot (build 12) ----------------
     One DJ at a time per sound-room room. Claims carry {n, t}; the earliest
     fresh claim wins. Claims heartbeat every 15s while DJing and expire
     after 45s of silence (tab closed, etc). Audio goes over Trystero's
     media API (addTrack / onPeerTrack), not the data channel. */

  /* What our heartbeat says about DJing: roomKey where we're on the decks,
     or null. Re-broadcasts immediately. */
  setDj(roomKey) {
    this.presenceDj = roomKey ? String(roomKey).slice(0, 16) : null;
    this._presenceTick();
  }

  _djClaimPayload() {
    return { n: this.name, t: this.myDjClaim ? this.myDjClaim.t : Date.now() };
  }

  _noteDjClaim(peerId, d) {
    try {
      if (!peerId || String(peerId) === String(this.selfId)) return;
      if (!d || typeof d !== 'object') return;
      const id = String(peerId);
      if (d.rel) {
        // Explicit release: decks are open again.
        if (this.djClaims.delete(id) && this.onDjCb) this.onDjCb();
        return;
      }
      const t = Number(d.t);
      if (!Number.isFinite(t)) return;
      this.djClaims.set(id, {
        name: this.cleanName(d.n),
        t,
        lastSeen: Date.now(),
      });
      if (this.onDjCb) this.onDjCb();
    } catch (e) { /* ignore */ }
  }

  /* Drop claims silent longer than DJ_CLAIM_EXPIRE_MS. `now` is injectable
     so tests can time-travel instead of waiting 45s. */
  _sweepDjClaims(now) {
    const t = typeof now === 'number' ? now : Date.now();
    let dropped = 0;
    for (const [id, c] of this.djClaims) {
      if (t - c.lastSeen > DJ_CLAIM_EXPIRE_MS) {
        this.djClaims.delete(id);
        dropped++;
      }
    }
    if (dropped > 0 && this.onDjCb) this.onDjCb();
  }

  // Heartbeat tick while we hold the decks: re-claim + reap stale claims.
  _djTick() {
    if (!this.myDjClaim) return;
    try {
      if (this.sendDjClaim) this.sendDjClaim(this._djClaimPayload());
    } catch (e) { /* ignore */ }
    this._sweepDjClaims();
    // Jam clock re-broadcast (build 13): keeps late joiners on the grid.
    try {
      if (this.onJamTickCb) this.onJamTickCb();
    } catch (e) { /* ignore */ }
  }

  _stopDjTimers() {
    if (this._djTimer) {
      clearInterval(this._djTimer);
      this._djTimer = null;
    }
  }

  _sendDjRelease() {
    try {
      if (this.sendDjClaim) this.sendDjClaim({ n: this.name, t: Date.now(), rel: 1 });
    } catch (e) { /* ignore */ }
  }

  /* Start DJing: claim the decks and push our audio track to every peer in
     the room. Idempotent-ish: calling twice keeps the original claim time. */
  djStart(track, stream) {
    if (!this.enabled || !this.room || this.roomKey !== SOUND_ROOM_KEY) return false;
    if (!this.myDjClaim) this.myDjClaim = { t: Date.now() };
    this.djMedia = { track, stream };
    try {
      const p = this.room.addTrack(track, stream);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      else if (Array.isArray(p)) p.forEach((x) => x && x.catch && x.catch(() => {}));
    } catch (e) { /* track push failed; the claim still holds the slot */ }
    this._stopDjTimers();
    this._djTimer = setInterval(() => this._djTick(), DJ_CLAIM_INTERVAL_MS);
    this._djTick(); // announce immediately
    return true;
  }

  /* Stop DJing: release the claim, pull the track, clear timers. Safe to
     call when not DJing. */
  djStop() {
    this._stopDjTimers();
    if (this.myDjClaim) this._sendDjRelease();
    this.myDjClaim = null;
    if (this.djMedia && this.room) {
      try {
        this.room.removeTrack(this.djMedia.track);
      } catch (e) { /* ignore */ }
    }
    this.djMedia = null;
  }

  _onRemoteTrack(track, stream, peerId) {
    if (!track) return;
    try {
      if (this.onRemoteTrackCb) this.onRemoteTrackCb(track, stream, peerId);
    } catch (e) { /* ignore */ }
  }

  /* Broadcast our wisp position + name + equipped look (~12Hz from the
     game loop). game.js sets this.cosmetics so peers can render our skin,
     hat, and trail; short string ids keep the payload tiny. */
  broadcast(pos) {
    if (!this.enabled || !this.sendWisp) return;
    let s = 'drifter', h = 'none', t = 'ribbon', c = 'bfe2ff';
    try {
      const csm = (typeof this.cosmetics === 'function') ? this.cosmetics() : null;
      if (csm) {
        if (csm.s) s = String(csm.s).slice(0, 16);
        if (csm.h) h = String(csm.h).slice(0, 16);
        if (csm.t) t = String(csm.t).slice(0, 16);
        if (csm.c) c = String(csm.c).slice(0, 6);
      }
    } catch (e) { /* ignore */ }
    try {
      this.sendWisp({
        p: [r1(pos.x), r1(pos.y), r1(pos.z)],
        n: this.name,
        s,
        h,
        t,
        c,
      });
    } catch (e) {
      /* ignore */
    }
  }

  say(text) {
    if (!this.enabled || !this.sendChat) return;
    try {
      this.sendChat({ n: this.name, t: String(text).slice(0, 140) });
    } catch (e) {
      /* ignore */
    }
  }

  peerCount() {
    return this.peers.size;
  }

  /* Raw RTCPeerConnections keyed by peerId (trystero's getPeers() returns
     a plain object: peerId -> RTCPeerConnection). Empty when signaling has
     found nobody — which is itself diagnostic. */
  getPeerConnections() {
    try {
      return this.room ? this.room.getPeers() : {};
    } catch (e) {
      return {};
    }
  }

  /* Snapshot for the debug HUD (press D). Works with zero peers — that's
     the whole point. localTypes tells us whether TURN allocation worked:
     'relay' present = TURN is alive; host+srflx only = TURN is dead. */
  async getDebugSnapshot() {
    const pcs = this.getPeerConnections();
    const peers = [];
    for (const [id, pc] of Object.entries(pcs)) {
      const info = {
        id: String(id).slice(0, 8),
        ice: '?',
        gathering: '?',
        conn: '?',
        localTypes: [],
        selectedType: 'none',
      };
      try {
        info.ice = pc.iceConnectionState || '?';
        info.gathering = pc.iceGatheringState || '?';
        info.conn = pc.connectionState || '?';
        const stats = await pc.getStats();
        const localById = new Map();
        const types = new Set();
        let selectedLocalId = null;
        stats.forEach((s) => {
          if (s.type === 'local-candidate') {
            localById.set(s.id, s.candidateType || '?');
            if (s.candidateType) types.add(s.candidateType);
          } else if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') {
            selectedLocalId = s.localCandidateId;
          }
        });
        info.localTypes = [...types].sort();
        if (selectedLocalId && localById.has(selectedLocalId)) {
          info.selectedType = localById.get(selectedLocalId);
        }
      } catch (e) {
        info.ice = 'stats-err';
      }
      peers.push(info);
    }
    return {
      build: this.build,
      enabled: this.enabled,
      strategy: STRATEGIES[this.stratIdx] ? STRATEGIES[this.stratIdx].name : '?',
      roomKey: this.roomKey || '(none)',
      peerCount: this.peers.size,
      peers,
      lastJoinError: this.lastJoinError,
      turnUser: this.turnCreds ? this.turnCreds.username : '(none)',
      // Handshake-stage diagnostics: relay socket state, per-peer
      // discovery/handshake stage, recent nostr wire frames.
      relays: this._getRelayStatus(),
      hsPeers: [...this.hsPeers.entries()].map(([id, r]) => ({
        id,
        stage: r.stage,
        sigIn: r.sigIn,
        sigOut: r.sigOut,
        initiator: r.initiator,
        lastSeen: r.lastSeen,
      })),
      frames: this.nostrFrames.slice(),
    };
  }
}

function r1(v) {
  return Math.round(v * 10) / 10;
}
