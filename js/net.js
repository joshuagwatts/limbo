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
/* Bump on every deploy — shown in the debug HUD (press D) so we can tell
   whether a phone is actually running the latest code or a cached copy. */
const BUILD = '3';

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
    this.peers = new Map(); // peerId -> true (presence in current room)
    this.name = 'drifter';
    this.sendWisp = null;
    this.sendChat = null;
    this.onWispCb = null; // (peerId, {p:[x,y,z], n:name})
    this.onChatCb = null; // ({n:name, t:text}, peerId)
    this.onPeerLeaveCb = null; // (peerId)
    this.onQuietCb = null; // () — fired once per room visit when alone too long
    this.fallbackTimer = null;
    this.quietTimer = null;
    this.quietFired = false;
    this.lastJoinError = null; // {error, peerId, at} from trystero onJoinError
  }

  cleanName(n) {
    return String(n || 'drifter').trim().slice(0, MAX_NAME) || 'drifter';
  }

  get mod() {
    return this.mods[this.stratIdx];
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
    this.quietFired = false;
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
      const room = (this.room = this.mod.joinRoom(
        {
          appId: APP_ID,
          rtcConfig: this.rtcConfig,
          // Trystero calls this when SDP was exchanged but the peer
          // connection failed — carries the real reason (ICE/TURN/etc).
          onJoinError: (details) => {
            this.lastJoinError = {
              error: String((details && details.error) || details || 'unknown'),
              peerId: details && details.peerId ? String(details.peerId).slice(0, 8) : '?',
              at: new Date().toLocaleTimeString(),
            };
          },
        },
        this.roomKey
      ));
      const [sendWisp, onWisp] = room.makeAction('wisp');
      const [sendChat, onChat] = room.makeAction('chat');
      this.sendWisp = sendWisp;
      this.sendChat = sendChat;
      onWisp((d, id) => {
        if (this.onWispCb) this.onWispCb(id, d);
      });
      onChat((d, id) => {
        if (this.onChatCb) this.onChatCb(d, id);
      });
      room.onPeerJoin((id) => {
        this.peers.set(id, true);
        this._clearFallbackTimer(); // someone made it — signaling works
      });
      room.onPeerLeave((id) => {
        this.peers.delete(id);
        if (this.onPeerLeaveCb) this.onPeerLeaveCb(id);
      });
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
      this._joinWithStrategy();
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
  }

  /* Broadcast our wisp position + name (~12Hz from the game loop). */
  broadcast(pos) {
    if (!this.enabled || !this.sendWisp) return;
    try {
      this.sendWisp({
        p: [r1(pos.x), r1(pos.y), r1(pos.z)],
        n: this.name,
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
    };
  }
}

function r1(v) {
  return Math.round(v * 10) / 10;
}
