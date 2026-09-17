# LIMBO — a portal universe (prototype)

A playable browser prototype of the LIMBO portal-universe game concept:
you are a **wisp** drifting through a dark Nexus hub. Four portal rings —
each showing a real Holowatts artwork — lead into four **realms**, where the
artwork hangs as one giant flat piece floating in the void. Gather the 5
echo orbs in each realm (20 total). When a realm's echoes are all collected,
it becomes *attuned*.

Drift with others: **serverless P2P multiplayer** (WebRTC via Trystero —
no server, no backend, no accounts) plus **room-local text chat**. Each
location (Nexus + 4 realms) is its own room; you see and chat with whoever
is drifting in the same place as you.

Everything is static files — no build step, no backend, no audio files
(all sound is synthesized live with WebAudio).

## Run it locally

```bash
cd ~/workspace/limbo
python3 -m http.server 8000
# open http://localhost:8000
```

(A plain `file://` open won't work — ES modules + the Three.js CDN import
require http.)

## Deploy to GitHub Pages

1. Create a new GitHub repo (e.g. `holowatts/limbo`).
2. Push the contents of this folder to the `main` branch, at the repo root:
   ```bash
   cd ~/workspace/limbo
   git init -b main
   git add .
   git commit -m "LIMBO prototype"
   git remote add origin git@github.com:holowatts/limbo.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch**,
   select `main` and `/ (root)`, Save.
4. It'll be live at `https://holowatts.github.io/limbo/` in a minute or two.

Notes:
- All paths are relative, so it works identically locally and on Pages.
- Three.js r160 loads from the unpkg CDN, Trystero loads from the esm.sh
  CDN — the page needs internet access.

## Multiplayer + chat (how it works)

- **No server.** Multiplayer runs on [Trystero](https://github.com/dmotz/trystero)'s
  `torrent` strategy: peers find each other through public BitTorrent
  trackers and then talk directly over WebRTC. Works from static hosting.
- **One room per location:** `limbo-nexus`, `limbo-realm-1` … `limbo-realm-4`
  (all under the app id `limbo_by_holowatts`). Portal hops leave the old
  room and join the new one, so you only ever see/speak to drifters who are
  *where you are*.
- Your wisp position + name broadcasts ~12Hz; remote wisps render as glowing
  spheres with floating name tags (capped at 15), eased for smoothness.
- **Chat:** press **T** (or tap the chat box on mobile) to type, **Enter** to
  send, **Esc** to close. Messages are room-local (140 chars). Peer
  join/leave shows as quiet system lines ("nova drifted in").
- **Graceful:** if the CDN or WebRTC is unreachable, the game plays exactly
  like the single-player prototype — no errors, no blocking.

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
