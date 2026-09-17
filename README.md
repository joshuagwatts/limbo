# LIMBO — a portal universe (prototype)

A playable browser prototype of the LIMBO portal-universe game concept:
you are a **wisp** drifting through a dark Nexus hub. Four portal rings —
each showing a real Holowatts artwork — lead into four **realms**, where the
artwork wraps around you as a 360° sky. Gather the 5 echo orbs in each realm
(20 total). When a realm's echoes are all collected, it becomes *attuned*.

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
- Three.js r160 loads from the unpkg CDN — the page needs internet access.

## Controls

| Input | Action |
|---|---|
| WASD / arrow keys | fly (camera-relative) |
| Mouse drag | look around (no pointer-lock, works in iframes) |
| Space / E | rise |
| Shift / Q | sink |
| M | mute / unmute |
| Touch | left-half virtual joystick = fly, right-half drag = look |

Fly into a portal ring to travel. Fly into a glowing echo orb to collect it.

## What's in the box

- `index.html` — page + HUD overlays + Three.js importmap (pinned r160)
- `css/style.css` — dark minimal UI, wide-tracked typography
- `js/game.js` — scenes, wisp flight, portals, echoes, transitions
- `js/audio.js` — generative ambient pad (retuned per realm) + echo chimes
- `assets/realm1.jpg` … `realm4.jpg` — the four realm artworks (downscaled ≤2048px)
  - realm1 **PRISM DEEP** — *Colorful Worlds*
  - realm2 **MIRROR TIDE** — *Rainbow Deathstar*
  - realm3 **CHROME VEIL** — *BubbleFairy*
  - realm4 **STILL POINT** — *Mind Body n Soul*

## Prototype scope (what was kept simple)

- Single-player only; echo progress persists for the session (in-memory).
- 4 realms instead of 59 — the builder functions take any artwork, so scaling
  up is mostly a content pass.
- Third-person follow camera with dreamy inertia rather than full 6-DOF sim.
- Touch controls are functional but basic; desktop is the primary target.
- No VR mode, no multiplayer, no persistence backend — those are phase 2+.
