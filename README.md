# SurrealEd — RiotTools

Tools for the **Riot Engine** files used by *The Suffering* (2004) and *The Suffering: Ties That Bind* (2005).

---
### Setup
1. Install **Python 3.8+** (python.org, tick "Add Python to PATH"). No other libraries are needed.
2. Copy the whole **RiotTools** folder into the game folder, next to `Suffering.exe` or `SufferingTTB.exe`.
3. Double-click **`RiotTools\SurrealEd.bat`**. The editor opens in your browser (current Chrome, Edge or Firefox).
   Close the black window to quit.

If RiotTools lives elsewhere: `python RiotEditor.py --game "D:\Games\The Suffering"`.

### What works in this version (0.1)
- **Level tab:** opens any `.lvl` straight from the game files — terrain, objects, textures, baked lighting (`.ldu`),
  point lights, class filter, object picking, rooms/cells/portals/PVS, textured/untextured and wireframe modes, and
  normals drawn as lines (blue = vertex normal from the file, cyan = face normal) on the selected object or, with no
  selection, on objects near the camera target.
- **Properties panel** for the selected object: transform, flags (visible, casts dynamic shadow…) and every class
  property, with template values and the ones the instance overrides. Read-only for now.
- **Move, rotate and scale gizmos** (Unreal-style: `Q` select, `W` move, `E` rotate, `R` scale, space cycles,
  `` ` `` local/world), with grid snapping, undo/redo (`Ctrl+Z` / `Ctrl+Y`) and revert. Changes are written to the
  .lvl with **File → Save level** (`Ctrl+S`). Rotation snaps to whole degrees, as the game stores it.
- **Dynamic shadows** (World Settings → Lighting), as in game: casters by the effective flag (0x1000 → 0x400, else
  template flags bit 0), 256² silhouette from the strongest point light, elevation clamped to 45°, fade between Level
  Properties p14 and p15. Details lets you toggle an object's shadow (preview only, not saved).
- **Editable properties and lights:** in Details, each object's numbers, colours (UMG-style wheel), messages and
  references become fields; visible ones update live (point light colour, intensity and on/off relight the viewport)
  and everything is saved to the .lvl as instance overrides. Lists are still read-only.
- **Game fog** (Viewport rendering → Game fog): linear in depth, end = Sky Properties p2, start = p3 × p2, colour p4.
  World Settings makes the three fields editable with a live preview; "Save to template" writes the sky's .odu, which
  changes **every** level using that sky.
- **Animated materials** (Viewport rendering → Animate materials): Animating Material frames at their fps; Advanced
  Material UV scale/offset plus the `.wdu` scroll curve (water, smoke, sludge; TTB's `.wdu` header differs and is read
  too). Numeric properties get a slider; on/off ones a checkbox.
- **Copy, paste and delete objects** (Edit, or Ctrl+C / Ctrl+V / Ctrl+D / Del, with Ctrl+Z): the copy appears 1 m away
  (or one grid step) and is saved with a new id, a leaf in the cell tree (under the node whose box holds its position)
  and an editor-history row. Deleting is only saved when no link, object property, portal or STOMP track points at
  the object. Copies reuse the source's baked lighting.
- **STOMP in the level:** "Play in level (3D)" in the STOMP tab plays the sequence in the viewport: objects follow
  their keys, the Camera track drives the view (FOV and time scale), visibility, sounds and subtitles fire on time and
  other keys are logged. Untick "Scene camera" to watch from outside. Skinned characters and props play their animation
  keys (channel 0, with blending and locked/free root motion); partial-body channels are not played yet.
- **Lights and hidden objects:** every Point Light has a clickable icon (within 25 m of the camera); flag-0x8 objects
  (not created at level start) are hidden by default; tinted material passes are unlit and tinted, as in game;
  unbaked objects get the level's Ambient Light + Directional Light.
- **Level logic:** in Details, message properties are tagged input/output, message values are named (1 On,
  6 Triggered…) and the "Links" section shows what the object sends, to whom, and which messages each target actually
  hears (amber/blue lines in the viewport; click to go to the object). Both games' message maps were extracted from the
  .rfl files (`Ghidra/Atlas/RiotMessageMaps.py`, `Tools/RiotMessageNames.py`).
- **Asset tabs:** Textures, Models, Animation, **Audio** (waveform, lip-sync curve, subtitle, distances, save WAV),
  **STOMP** (sequences: tracks per level object, typed events, top view, playback with sounds, open the level at the
  object) and **Video** (save .wmv; MP4 preview when `ffmpeg` is on PATH).
- **Sky (skybox)** (Viewport rendering → Sky): Sky / Sun layers are drawn around the camera before the level; the
  dome (p6 = 1) shows the Sky Properties strip (p4 horizon, p5 sky, p6 band, p7 blend); clouds scroll.
- **Performance** (Viewport rendering → Performance): shows the GPU the browser is using (warns on software
  rendering: SwiftShader, llvmpipe, Microsoft Basic Render/WARP), FPS, logic and draw time and draw calls; internal
  resolution 100/75/50%. Off-screen meshes are culled. Adjustable icon size.
- **Particle effects** (Viewport rendering → Particle effects; `Editor/RiotParticles.js`, `Riot/RiotEffects.py`):
  TS1 Particle Fountain, Object Generator (the ones spawning fountains) and Billboard; TTB Particle System - Simple
  (meanings **inferred** from the TTB .rfl), Billboard Light Cone (read from SufferingTTB.exe code) and Billboard.
  Model-less effects get a clickable orange star icon.
  Message-triggered ones play when selected or with "Preview message-triggered effects".
- **Asset tab shortcuts** (Models, Animation, Audio, STOMP, Video): <kbd>W</kbd>/<kbd>S</kbd> (or arrows) move through the
  list, <kbd>Space</kbd> plays/stops. During a STOMP scene, editor markers and invisible collision are hidden.
- The UI starts in English; Portuguese is under **View → Português** (remembered by the browser).
- **Saving** (always backed up): the first time a file changes, the original goes to `SurrealEd Backup/` in the game
  folder (never overwritten). Containers are rewritten keeping the original layout; unchanged files come out
  byte-identical (`python Tools/RiotRoundTrip.py "<game folder>"` checks all 405 files).
  - **Level:** flags (except 0x10, 0x100, 0x8000, which change the record size) and transforms → **File → Save .lvl**
    (Ctrl+S); **File → Restore the original .lvl**.
  - **Textures:** **Import image…** (PNG/JPG of any size, resized to a power of two up to 4096, larger or smaller than the
    original; DXT1/DXT5 compressed in the browser; mipmaps rebuilt when the original has them, as in TTB) and **Restore
    original**. Reload the level to see the new texture there.
- Close the game before saving.

### Controls
Same as the Unreal Editor viewport:
- **Right drag:** look · **right + `W A S D`:** fly, `Q`/`E` down/up, mouse wheel changes speed (8 levels), `Z`/`C` zoom
- **Left drag:** turn and move on the ground · **middle** (or left + right): pan · **wheel:** forward/back
- **`Alt` + left:** orbit · **`Alt` + right:** dolly · **`Alt` + middle:** pan
- **Arrows / PageUp / PageDown:** move without the mouse · **`F`:** frame selection · **`Shift`:** 3× faster · plain click: select

### Code layout
See the table above; every module starts with the documentation of the format it handles (fields, what is confirmed
and the address of the matching function in the game executable). Full reverse-engineering notes: `Docs/RiotEngineNotes.md`.

---

License: MIT (see `LICENSE`). Fan project, not affiliated with Surreal Software, Midway or Warner Bros. No game data is included.
