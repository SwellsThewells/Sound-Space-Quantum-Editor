# SSQE Web Editor

A browser port of the Sound Space Quantum Editor in `Editor/New SSQE`. It runs entirely in the
browser and uses the [web player](../Web%20Player) for playtesting.

## Running

Serve the repository root (both `Web Editor` and `Web Player` need to be reachable) and open
`Web Editor/index.html`:

```
python3 -m http.server 8000   # from the repository root
# then open http://localhost:8000/Web%20Editor/
```

Opening `index.html` directly from disk mostly works. The changelog and the default SSPM cover
need a web server, because browsers block `fetch` for local files.

## What's included

The menu, create, settings, keybinds and editor screens are drawn on a canvas with the same
layouts, fonts, textures and control styles as the desktop editor, so they look the same at any
window size. BPM Setup, Bookmarks, BPM Tapper and Export SSPM use the layouts from the desktop
editor's Avalonia windows, and message boxes look like the desktop editor's.

- **Menu:** Create New Map, Load Map, Paste Map, Settings, and the open-maps bar. Open maps and
  their audio are kept in the browser (IndexedDB), standing in for the editor's `cached/` folder,
  so they're still there after a reload.
- **Grid:**
  - Place notes by clicking, dragging or using the grid keys (QWE/ASD/ZXC, or the numpad).
  - Quantum placement with the divisor and X/Y offsets, or the old quantum snap.
  - Select and drag notes.
  - Approach squares, grid numbers and letters, the autoplay cursor and the bezier preview.
- **Track:**
  - Waveform, notes with their position marker, and beat ticks for the beat divisor.
  - Drag timing points, scrub by dragging, and right-drag to box-select.
  - Drag notes in time, with snapping.
  - Hit sounds and metronome during playback.
- **Timeline:** note, timing point and object ticks, bookmarks (click for the start, right-click
  for the end), and the visible track range.
- **Panels:**
  - Options, Timing, Patterns, Playtest, Snapping, Graphics and Export, with the same settings as
    the desktop editor.
  - Patterns include flips, rotate, scale, bezier with anchors, and stored patterns on 0-9.
- **Windows:**
  - BPM setup: add, update, delete and move points, adjust notes, BPM tapper, and timing import
    from osu! and `.chart`.
  - Bookmarks, plus copying and pasting bookmarks as text.
- **Extra objects:**
  - Beats, mines, glides and fevers placed with the grid keys.
  - Lyrics, with a live preview.
  - Note easing.
- **Editing:**
  - Undo and redo, copy, cut and paste (including paste reversed and apply-on-paste), select all,
    delete.
  - Create BPM from two selected notes, and all the default keybinds (rebindable in Settings).
- **Files:**
  - Opens `.txt` maps (legacy and `ssmapv2`) with their `.ini`, `.sspm` (v1 and v2), Rhythia `.rhm` (with
    their song and cover) and `.osu`.
  - Saves `.txt` and `.ini` in the same format as the desktop editor.
  - Exports SSPM v2 and Rhythia `.rhm` (pick **Rhythia (RHM)** in the Export tab's dropdown).
- **Saving:** in Chromium-based browsers, Save As can write to a folder you pick, and later saves
  and autosaves go to the same files. In other browsers the `.txt` and `.ini` are downloaded.
- **3D Mode** (Graphics tab, web only): notes fly out from the middle of the grid towards their cell,
  like in game, instead of fading in on it. **3D Hit Effect** makes notes keep growing as they fade
  after being hit, and **3D Grid Opacity** sets how see-through the grid is while 3D Mode is on.
- **Auto mapper** (Patterns tab, web only): every map you import (in the editor or the map player)
  teaches it how far and where notes move for each time gap, and how dense maps are. **AUTO MAP**
  fills from the timeline's position up to the next note (or the end of the song): it finds the hits
  in the song, snaps them to the BPM if there is one, and places notes the way the learned maps do.
  **Difficulty** (1-10) sets how dense the map is: 1 is about 1.5 notes a second, 5 about 5.5 and 10
  about 30 with fast streams (like Tasukete maps); between the song's hits it streams where the song is
  busy. **Density %** scales that further.
  If the map already has notes, their patterns are followed (they decide most moves), so new parts
  continue the way you've been mapping. It's one undo step.
  **LEARN FROM MAPS** teaches it from many map files at once.
- **Grid Zoom** (Graphics tab, web only): makes the 3x3 grid bigger or smaller (50-200%).
- **Grid cursor image** (Settings > Graphics, web only): replaces the square cursor that follows the
  notes on the grid (Autoplay in the Graphics tab) with any image or animated GIF, at any size.
- **Editor background** (Settings > Colors, web only): pick the default background, your own image
  (**LOAD IMAGE**) or one of the map player's worlds.
- **Playtest background and note mesh** (Settings > Player, web only): the same 3D worlds and custom
  `.obj` note mesh as the map player's Visuals settings, shared with it, plus Uncap Playtest FPS,
  Disable Background Effects and Realistic Autoplay (Alt + playtest uses the map player's learning bot).
- **Playtest:** Play From Start and Play Here open the web player on top of the editor. Hold Alt
  while clicking to watch autoplay. Esc returns to the editor.

## Differences from the desktop editor

- Ctrl+T is reserved by browsers, so BPM Setup defaults to **Alt+T**. You can rebind it in
  Settings.
- Some settings only affect the desktop renderer, so they're on the Settings screen but have no
  effect: VSync, FPS limits, anti-aliasing, font scale, waveform detail and squircle detail.
- Open Editor Folder, the Rhythia and Novastra paths, Detect BPM and Paste ADOFAI Timings show a
  message saying they aren't available.
- Map VFX objects are kept when you load and save a map, but there's no VFX editing UI. The
  desktop editor's "Edit Map VFX" button isn't wired up either.
- Missing from the web version:
  - Exporting to PHXM, NPK (Novastra) and QEMZ.
  - Importing PHXM, NPK, QEM, QEMZ, PHZ and VMAP.
  - Playtesting in external games (Rhythia, Novastra).
  - Downloading Roblox audio.
  - BPM detection and ADOFAI timing import.
  - Converting audio to MP3.
  - Discord status, auto-updates and save history backups.
- Tempo changes use the browser's pitch-preserving playback rate instead of SoundTouch.
