# LIMBO — a portal universe (prototype)

A playable browser prototype of the LIMBO portal-universe game concept:
you are a **wisp** drifting through a dark Nexus hub. Four portal rings —
each showing a real Holowatts artwork — lead into four **realms**, where the
artwork hangs as one giant flat piece floating in the void. Gather the 5
echo orbs in each realm (20 total). When a realm's echoes are all collected,
it becomes *attuned*.

Drift with others: **serverless P2P multiplayer** (WebRTC via Trystero —
no server, no backend, no accounts) plus **room-local proximity text
chat**. Each location (Nexus + 4 realms + the sound room) is its own room; you see and chat
with whoever is drifting in the same place as you.

Attuning a realm (all 5 echoes) unlocks **wisp customization**: each realm
grants its own wisp skin, and attunement milestones grant hats (party hat,
top hat, crown) and trail styles/colors (ribbon, comet, ghost). Pick your
look in the settings panel — other drifters see your skin, hat, and trail
too. All cosmetics are earned by playing; nothing is paid.

The settings panel also has a **PRINTS** section: each realm's artwork is a
real giclée print in the shop, one tap away.

The **FRIENDS** section keeps a local friends list and shows who's live:
every client heartbeats into a shared lobby room, so you can see which
realm a friend is drifting in and hop straight to them.

The Nexus has a 5th portal — the **SOUND ROOM**, a social listening space
with the four realm artworks hanging as a gallery. One drifter at a time
can **take the decks** (tab audio over WebRTC in a desktop browser) while
everyone in the room hears the mix; the room's lights pulse with the bass.
When tab audio fails (Brave blocks it, for one), a chooser offers mic/line-in
or playing an audio file instead — the decks never dead-end.
Friends who are DJing show "on the decks" in the friends list.

The sound room is also a **JAM ROOM**: a pocket synth (one chromatic octave,
waveform + filter controls), a 4-pad **sampler** that grabs loops from the
DJ's stream, and **auto-BPM detection** listening to the music. The DJ is
the shared beat clock — note and pad events are tiny messages and every
client synthesizes the sound locally on the grid, so the jam feels tight
despite network latency. Tap tempo + BPM steppers let the DJ override the
tempo; the friends list shows who's jamming.

Everything is static files — no build step, no backend, no audio files
(all sound is synthesized live with WebAudio).

## Building together

The repo is public — clone it and run it locally, same as above. There is no
build step: edit the files, refresh the browser, done.

**Deploying:** GitHub Pages serves the `main` branch, so pushing to `main`
deploys automatically (takes ~1 minute; watch the Actions tab go green).
**Every deploy must bump the version** or phones will keep running the cached
old copy: `BUILD` in `js/net.js`, `js/game.js?v=N` in `index.html`, and
`./net.js?v=N` in `js/game.js` (keep all three `N`s in sync — currently 10).
`audio.js` only needs a bump when it actually changes.

One rule: talk before pushing to `main` — there's an automated builder on
Joshua's side that works from its own copy and uploads through the GitHub web
UI, so coordinate to avoid stepping on each other's deploys.

## Run it locally

```bash
cd ~/workspace/limbo
python3 -m http.server 8000
# open http://localhost:8000
```

(A plain `file://` open won't work — ES modules + the Three.js CDN import
require http.)

## Deploy to GitHub Pages

Already live at `https://joshuagwatts.github.io/limbo/` — Pages is set to
**Deploy from a branch**, `main` / `/ (root)`. Push to `main` and it
redeploys in about a minute. Remember the version bump (see above).

Notes:
- All paths are relative, so it works identically locally and on Pages.
- Three.js r160 loads from the unpkg CDN, Trystero loads from the esm.sh
  CDN — the page needs internet access.

## Multiplayer + chat (how it works)

- **No server.** Multiplayer runs on [Trystero](https://github.com/dmotz/trystero):
  peers find each other through public BitTorrent trackers, then talk
  directly over WebRTC. Works from static hosting.
- **NAT traversal (why 2-player works on phones).** Trystero core ships
  STUN-only ICE, which fails behind symmetric NAT (mobile carriers / CGNAT).
  `net.js` adds TURN via the OpenRelay **static-auth** scheme (standard
  coturn TURN REST API — the same one Nextcloud Talk / Jitsi use):
  credentials are derived client-side with WebCrypto HMAC-SHA1 from the
  shared secret, valid 24h, refreshed automatically on long sessions.
  `rtcConfig` *replaces* Trystero's default iceServers, so the config also
  carries its own STUN entries:
  `stun:stun.cloudflare.com:3478` + `stun:stun.l.google.com:19302`,
  then `turn:staticauth.openrelay.metered.ca:80`/`:443` and
  `turns:staticauth.openrelay.metered.ca:443`. (The old fixed
  `openrelayproject`/`openrelayproject` password is stale — never used.)
- **Signaling fallback.** If no peer appears within 15s of joining a room,
  the client leaves and rejoins the *same* room key via Trystero's `nostr`
  strategy (`https://esm.sh/@trystero-p2p/nostr@0.25.4` — version-pinned, like
  the torrent strategy, so a silent esm.sh "latest" drift can't break the
  import shape). Both clients run identical logic, so they converge on
  whichever strategy works. One fallback only.
- **One room per location:** `limbo-nexus`, `limbo-realm-1` … `limbo-realm-4`
  (all under the app id `limbo_by_holowatts`). Portal hops leave the old
  room and join the new one, so you only ever see/speak to drifters who are
  *where you are*.
- Your wisp position + name broadcasts ~12Hz; remote wisps render as glowing
  spheres with floating name tags (capped at 15), eased for smoothness.
- **Chat:** tap the chat box (or press **T**) to type, **Enter** to send,
  **Esc** to close. Messages are room-local, 140 chars, and **proximity-based**:
  you only hear drifters within ~40m of you — a message from farther away
  shows as a faint "you sense distant chatter…" hint. The speech-bubble
  button opens the session's chat history; incoming messages also float as
  bubbles above the sender's wisp for a few seconds. Peer join/leave shows
  as quiet system lines ("nova drifted in"). Alone in a realm
  room for 20s and you'll get one gentle nudge: "the void is quiet here —
  drift to the Nexus to find other drifters".
- **Graceful:** if the CDN or WebRTC is unreachable, the game plays exactly
  like the single-player prototype — no errors, no blocking.
- **Debug readout** lives in the settings panel (gear button, or **D** on
  desktop). Live overlay showing the build stamp (so you can confirm a phone
  is running the latest deploy and not a cached copy), signaling strategy, room key, peer count, and — for
  each peer connection — ICE state, gathering state, local candidate types
  (`host`/`srflx`/`relay`), the selected pair type, and trystero's own
  join-error text. `relay` in local candidates = TURN allocation worked;
  host+srflx only = TURN is dead. Updates every second while open.
- **Cache-busting.** `index.html` loads `js/game.js?v=N` and game.js imports
  `./net.js?v=N` — bump `N` (and `BUILD` in `net.js`) on every deploy,
  because mobile browsers aggressively cache the old bundle and a stale
  copy looks exactly like "multiplayer still broken".

## Controls

| Input | Action |
|---|---|
| WASD / arrow keys | fly (camera-relative) |
| Mouse drag | look around (no pointer-lock, works in iframes) |
| Space / E | rise |
| Shift / Q | sink |
| T | chat with drifters in your realm (Enter sends, Esc closes) |
| M | mute / unmute |
| Touch | left-half virtual joystick = fly, right-half drag = look; tap chat box to type |

Fly into a portal ring to travel. Fly into a glowing echo orb to collect it.

## What's in the box

- `index.html` — page + HUD overlays + Three.js importmap (pinned r160)
- `css/style.css` — dark minimal UI, wide-tracked typography
- `js/game.js` — scenes, wisp flight, portals, echoes, transitions, multiplayer rendering, chat
- `js/net.js` — serverless P2P layer (Trystero WebRTC rooms, graceful offline fallback)
- `js/audio.js` — generative ambient pad (retuned per realm) + echo chimes
- `assets/realm1.jpg` … `realm4.jpg` — the four realm artworks (downscaled ≤2048px)
  - realm1 **PRISM DEEP** — *Colorful Worlds*
  - realm2 **MIRROR TIDE** — *Rainbow Deathstar*
  - realm3 **CHROME VEIL** — *BubbleFairy*
  - realm4 **STILL POINT** — *Mind Body n Soul*

## Prototype scope (what was kept simple)

- Echo progress persists for the session only (in-memory).
- 4 realms instead of 59 — the builder functions take any artwork, so scaling
  up is mostly a content pass.
- Third-person follow camera with dreamy inertia rather than full 6-DOF sim.
- Touch controls are functional but basic; desktop is the primary target.
- No VR mode, no persistence backend — those are phase 2+.
