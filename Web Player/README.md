# SSQE Web Player

An HTML/JavaScript (WebGL2) port of the Sound Space map player in `Map Player/SSQE Player`.
It runs entirely in the browser, with no install and no server-side code.

## Running

Open `index.html` in a modern browser (Chrome, Edge or Firefox), or serve the folder from any
static host:

```
cd "Web Player"
python3 -m http.server 8000   # then open http://localhost:8000
```

1. Load a map: choose a `.txt` file, or paste map data in the `id,x|y|ms,x|y|ms,...` format
   (the same format the editor writes to `assets/temp/tempmap.txt`).
2. Optionally load the song (any format your browser can decode: mp3, ogg, wav and so on).
   Without audio the map plays silently.
3. Optionally load a `.qer` replay.
4. Click **Play**, **Autoplay** or **Watch replay**.

You can also drag files onto the page. **Generate demo map** creates a random map for testing.

## Controls

These match the desktop player:

| Key | Action |
| --- | --- |
| Esc / hold R | Quit |
| Tab | Restart |
| Space | Pause, then hold to unpause |
| Scroll | Adjust offset |
| Ctrl+U | Unfocus (release the mouse) |
| Left click | Focus (lock the mouse) |
| F11 | Toggle fullscreen |

While the mouse is locked, the browser uses the first Esc press to release it. Press Esc again to quit.

## Settings

All of the desktop player's gameplay settings are available on the menu and saved in the browser
(localStorage). **Import editor settings.txt** loads the editor's `settings.txt`, so the web
player uses the same configuration as the desktop one.

## Port notes

- Gameplay logic (note timing, hit detection, health, autoplay spline, camera modes, replay
  playback) is a direct port of `MainWindow.cs`, `GuiWindowMain.cs` and `Camera.cs`.
- Rendering uses the original shaders, converted to GLSL ES 3.00, and the original note and
  cursor model geometry.
- Tempo uses the browser's pitch-preserving `playbackRate` in place of SoundTouch.
- The browser decides the frame rate (`requestAnimationFrame`), so the FPS limit and VSync
  settings are not available.
- `assets/main.ttf` is Source Sans Pro Bold (SIL Open Font License), the same font the desktop
  player uses.
