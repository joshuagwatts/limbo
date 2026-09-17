/* LIMBO — serverless multiplayer via Trystero (WebRTC P2P, no server).
 *
 * One Trystero room per location ('limbo-nexus', 'limbo-realm-1' …).
 * The Trystero module is loaded with a dynamic import inside boot() so a
 * blocked/unreachable CDN degrades gracefully to single-player — the game
 * never depends on this file succeeding.
 */

const TRYS_URL = 'https://esm.sh/@trystero-p2p/torrent';
const APP_ID = 'limbo_by_holowatts';
const MAX_NAME = 16;

export class LimboNet {
  constructor() {
    this.enabled = false;
    this.t = null;
    this.selfId = null;
    this.room = null;
    this.roomKey = null;
    this.peers = new Map(); // peerId -> true (presence in current room)
    this.name = 'drifter';
    this.sendWisp = null;
    this.sendChat = null;
    this.onWispCb = null;      // (peerId, {p:[x,y,z], n:name})
    this.onChatCb = null;      // ({n:name, t:text}, peerId)
    this.onPeerLeaveCb = null; // (peerId)
  }

  cleanName(n) {
    return String(n || 'drifter').trim().slice(0, MAX_NAME) || 'drifter';
  }

  /* Loads Trystero and marks the net usable. Resolves true/false. */
  async boot(name) {
    this.name = this.cleanName(name);
    try {
      this.t = await import(TRYS_URL);
      this.selfId = this.t.selfId;
      this.enabled = true;
    } catch (err) {
      this.enabled = false; // offline / CDN blocked: single-player
    }
    return this.enabled;
  }

  /* Leave the current room (if any) and join a new one. */
  join(roomKey) {
    if (!this.enabled) return;
    this.leave();
    this.roomKey = roomKey;
    try {
      const room = (this.room = this.t.joinRoom({ appId: APP_ID }, roomKey));
      const [sendWisp, onWisp] = room.makeAction('wisp');
      const [sendChat, onChat] = room.makeAction('chat');
      this.sendWisp = sendWisp;
      this.sendChat = sendChat;
      onWisp((d, id) => { if (this.onWispCb) this.onWispCb(id, d); });
      onChat((d, id) => { if (this.onChatCb) this.onChatCb(d, id); });
      room.onPeerJoin((id) => this.peers.set(id, true));
      room.onPeerLeave((id) => {
        this.peers.delete(id);
        if (this.onPeerLeaveCb) this.onPeerLeaveCb(id);
      });
    } catch (err) {
      this.enabled = false;
      this.room = null;
    }
  }

  leave() {
    if (this.room) {
      try { this.room.leave(); } catch (e) { /* ignore */ }
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
    } catch (e) { /* ignore */ }
  }

  say(text) {
    if (!this.enabled || !this.sendChat) return;
    try {
      this.sendChat({ n: this.name, t: String(text).slice(0, 140) });
    } catch (e) { /* ignore */ }
  }

  peerCount() {
    return this.peers.size;
  }
}

function r1(v) {
  return Math.round(v * 10) / 10;
}
