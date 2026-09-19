# LIMBO — album drop folder (build 33)

The **endless journey** room plays this folder front-to-back as a shared
listening party while drifters fly through the biomes.

## How to add the album

1. Export each track as an `.mp3` (numbered so the order is obvious):
   `01-into-the-drift.mp3`, `02-neon-horizon.mp3`, … and drop the files here.
2. Copy `album.example.json` to `album.json` and fill in the track list —
   the titles shown in the room come from this file.

## How it works

- The room probes each file's length once at load. If `album.json` is
  missing or empty, the room silently falls back to the generative ambient —
  nothing breaks, the journey still flies.
- Playback is locked to a fixed epoch (2026-01-01 00:00 UTC): the album
  loops forever and **every drifter hears the same track at the same
  offset** — no leader, no sync code, a true listening party.
- Music priority in the journey room: **live jukebox > hosted album >
  generative ambient**. When someone plays a jukebox track, the album
  ducks out; when the jukebox goes quiet, the album takes over again.
- The biome world shifts on track changes: every track of the album gets
  its own stretch of mountain / city / desert / digital.
