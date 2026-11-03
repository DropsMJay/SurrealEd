# The Suffering (PC, GOG) — Riot Engine reverse-engineering notes

Findings from analysing the game files of *The Suffering* (Surreal Software, 2004, Riot Engine).
All offsets are little-endian. Hypotheses that are **not confirmed** are marked as such.

Tools written along the way:

| Tool | Purpose |
|---|---|
| `riot_extract.py` | Unpacks any SRSC package (`*.?du`, `*.lvl`) and converts textures, sounds and strings |
| `riot_fog.py` | Lists and edits the *Sky Properties* objects (fog distance / start / colour), with automatic `.orig` backups |
| `riotobj.py` | Helper library: reads the class table from `Suffering.rfl` and decodes object records |
| `riot_model.py` | Exports `.mdu` models to OBJ + MTL + PNG with textures resolved through the material chain |

---

## 1. Game folder layout

```
The Suffering\
  Suffering.exe        main executable (renderer, engine, hidden debug menu)
  Suffering.rfl        game-code DLL (PE, image base 0x6DB00000): all object classes
  COMMON\              shared packages: FX, Interface, NPCs, Resources, System
  World Common\        shared world packages: World Common, Prison/Asylum/Outdoor Common, Landscape Textures
  LEVELS\<n Name>\     per-level packages + .lvl files
  xvsh\                vertex/pixel shader sources and caches
```

Every "package" is a set of files sharing a base name (e.g. `Interface.adu`, `Interface.tdu`, ...) plus a `.db` text manifest.

---

## 2. The `.db` manifest (plain text)

```
version 1.1
id 10
dvd_resident SV
dependencies 6
..\System\System
..\FX\FX
...
```

- `id` is the **package ID** used by cross-package object references (see §6.4).
- `dependencies` lists packages that must be loaded first, in order.
- `dvd_resident` / `alternate_path ... P2(V) XB(V)` are console leftovers (PS2/Xbox).

Known package IDs:

| Package | ID |
|---|---|
| System | 2 |
| FX | 3 |
| Resources | 4 |
| Interface | 5 |
| Landscape Textures | 6 |
| World Common | 7 |
| Prison Common | 9 |
| NPCs | 10 |
| Outdoor Common | 23 |
| Asylum Common | 29 |
| 0 Prelude Docks / _level | 55 / 56 |

---

## 3. SRSC container (all `*.?du` and `*.lvl` files)

### Header (16 bytes)

| Offset | Type | Meaning |
|---|---|---|
| 0x00 | char[4] | `SRSC` |
| 0x04 | u8, u8 | version `01 01` (1.1) |
| 0x06 | u32 | directory offset (directory is at the end of the file) |
| 0x0A | u32 | number of entries (plain count, **not** count-1 as stated on the XeNTaX wiki) |

### Directory entry (14 bytes)

| Offset | Type | Meaning |
|---|---|---|
| 0x00 | u16 | resource type |
| 0x02 | u32 | resource ID (high word often = class/sub-group, low word = index) |
| 0x06 | u32 | data offset |
| 0x0A | u32 | data size |

- No file names are stored, only IDs.
- The high byte of the resource type is the **category** (0x01 objects, 0x02 models, 0x03 sound, 0x04 text, 0x05 animation, 0x07 fonts).
- Every package contains exactly one type `0x0402` resource (10 bytes, contains `"WI"`): package metadata, purpose unknown.
- Only `.odu` type `0x0103` is zlib-compressed (`78 9C`), plus one isolated `0x0102` record.

### Extensions and resource types

| Ext | Types | Content |
|---|---|---|
| `.tdu` | 0x0040, 0x0041 | Textures; 0x0041 = texture info (name + original source path, e.g. `\\lion\Unspeakable\Graphics\GUI\HUDs\GUI_Suffering_MousePointer.tga`) |
| `.mdu` | 0x0200, 0x0203, 0x0204, 0x0207, 0x0208, 0x0211, 0x0214, 0x0216 | Models, split into 6–8 sub-resources sharing one ID (see §4.5) |
| `.adu` | 0x0501, 0x0502, 0x0504, 0x0505 | Animations |
| `.sdu` | 0x0302 + 0x0303 | Sounds (header + PCM) |
| `.qdu` | 0x0311 | **STOMP sequences** (cinematics): animation tracks such as `Camera`, `Torque`, `Shoe Left` (see §9c) |
| `.odu` | 0x0102, 0x0103 | Object templates (thousands per package) + one zlib table |
| `.xdu` | 0x0400 | Localised strings (UI text, subtitles) |
| `.fdu` | 0x0700 | Fonts |
| `.wdu` | 0x0060 | Class-specific data blobs (heterogeneous: credits text, a PS2-format mesh, lookup curves, ...) |
| `.vdu` | 0x0342 / 0x0343 | Videos: ASF/WMV (WMV2) files, see 9l |
| `.ldu` | 0x0052 | Only in `*_level` packages; probably lightmaps / level lighting (**hypothesis**) |
| `.lvl` | 0x0000, 0x0001, 0x0003, 0x0020, 0x0026, 0x0027, 0x0028 | Level file (see §7) |

---

## 4. Asset formats

### 4.1 Textures (`.tdu`, type 0x0040)

48-byte header followed by DXT data:

| Offset | Type | Meaning |
|---|---|---|
| 0x00 | u32 | width |
| 0x04 | u32 | height |
| 0x08 | u32 | unknown |
| 0x0C | u32 | pixel format: 4 = DXT1, 8 = DXT5 |
| 0x10 | u32 | unknown (flags) |
| 0x30 | ... | DXT blocks, full mip chain while data remains |

Textures are stored **bottom-up**: the image must be flipped vertically. `riot_extract.py` writes a `.dds` (as stored) and, with `--png`, a correctly oriented `.png`. All 2,636 textures in the tested packages decode.

### 4.2 Sounds (`.sdu`, types 0x0302 + 0x0303, same resource ID)

- 0x0302: 60-byte header. Offset 44 = u16 channels, offset 46 = u16 bits per sample, offset 48 = u32 sample rate.
- 0x0303: raw signed PCM.
- Observed rates: 2000, 22050, 32000 Hz; mono 16-bit.

### 4.3 Strings (`.xdu`, type 0x0400)

`u16 byte_length` followed by UTF-16LE text (null-terminated). Example IDs: `0x00B10004` "New Game", `0x00B10005` "Continue".

### 4.4 `Interface.wdu`

Four resources:

| ID | Content |
|---|---|
| 0x01BB0002 | Game credits: UTF-16LE with BOM, tab-separated with quotes (`"Company" "Department" "Title" "Names"`) — looks exported from a spreadsheet |
| 0x00780001 | PS2-style mesh with embedded texture (see below) |
| 0x01060003 | 17-value bell-shaped curve (fade/easing table? **hypothesis**) |
| 0x0402 | package metadata |

**`PS2D` mesh** (0x00780001):

- Header contains tag `PS2D`, material-like floats and three `FolderIcon.ico` name slots (exporter leftovers).
- 978 vertices of 24 bytes: position `3×int16 + pad`, normal `3×int16 + pad` (fixed point, 4096 = 1.0), UV `2×int16` (4096 = 1.0), colour RGBA (`7F7F7FFF`; on PS2 0x80 = 1.0).
- Followed by an RLE texture: `int16 n` — negative = `-n` literal pixels, positive = repeat next pixel `n` times. Pixels are 16-bit **BGR 1555**. Decodes to exactly 128×128 (a blood-stained paper texture).
- No separate index list found (probably triangle strips).

### 4.5 Models (`.mdu`)

Found via the reader table built at **0x483C90** in `Suffering.exe` (type → reader function):

| Type | Reader | Content |
|---|---|---|
| 0x0200 | 0x483850 | Header: `u32 flags` (masked 0x1C3C000), `u32 type` (bit 0: static/skinned), **`float` only if flags & 0x20000**, `u32 n`, then n references (`u16 index, u16 package`) to material objects |
| 0x0203 | 0x483100 | **Vertices** (decoded) |
| 0x0204 | 0x482710 | **Faces + UVs** (decoded) |
| 0x0214 | 0x482880 | Only one in the whole game (NPCs); not analysed |
| 0x0207 | 0x484020 | **Static model info + collision tree** (decoded, see §4.5.1) |
| 0x0208 | 0x47AD70 | **Skinned model**: N bones of 0x90 bytes (matrix, position ×2048, parent/ids); per bone, groups of (u32 vertex index, float weight) = skin weights; then collision volumes (radius² + 4 u32), bone groups, 3 floats |
| 0x0211 | 0x483C40 → 0x483BE0 / 0x483AC0 | **GPU-ready batches**: u32 batch count (0x44 bytes each in memory); per batch: N × u32 (looks like u16 position/UV pairs = render vertices), M × (u,v) floats, then index lists (strips) |
| 0x0216 | not in this table | One u16 value per vertex (count = vertex count); identity for most vertices; purpose unknown |

Every model has **either 0x0207 (static) or 0x0208 (skinned)**, never both: NPCs.mdu 56 + 88 = 144 models, Resources 179 + 8 = 187, System 15 + 8 = 23.

Stream reader vtable used by all loaders (`param_2` in Ghidra): `+0x08` read N bytes, `+0x18` read float, `+0x1C` read u16, `+0x24` read u32.

**0x0203 — vertices**

```
u16 N
N × float[3]   position (engine multiplies by 2048.0 → world units; constant at 0x58C9A8)
N × int8[4]    normal x, y, z, pad (engine multiplies by 1/127; constant at 0x596034)
```

**0x0204 — faces**

```
u16 F
F × { u16 0, u16 n, u16 material, n × u16 vertex index }   (n is 3 in all tested data)
u16 0
F × { float u0, v0, u1, v1, u2, v2 }                         (one UV per face corner)
```

UVs work directly with the vertically-flipped (correctly oriented) texture.

**Material chain** (verified on PrisonDeathRow model 0x9601A0, 9 materials, all resolved):

```
face material k  →  k-th reference in 0x0200 (index + package ID)
  →  material object (.odu 0x0102, class hash 0xAD99E79B, 3 properties)
       property 0: ref into System or Landscape Textures (surface type? hypothesis)
       property 1: ref to the texture
  →  texture (type 0x0040) with the same index in the .tdu of that package
```

The material classes are not in `Suffering.rfl` (they are defined in the engine). An object index is shared by the `.odu` and `.tdu` of a package. Material classes seen (2988 of 2989 model materials across all 18 levels resolve):

| Class | Texture reference |
|---|---|
| 0xAD99E79B (standard) | slot 1 |
| 0xB13556E7 (landscape material, also used on models) | slot 3 (slot 0 = another ref, surface type?) |
| 0x03656E9F (**Layered Material**) | slot 0 = surface type; **slot 1 = low-detail version** (a plain material; exe string "Layered material 0x%x does not have low-detail version!"); slot 2 = array header, slots 3+ = layers in any order; the base layer is the one using model UVs (slot 11 = 0), e.g. door World Common #0x742 = [#0x741 sheen, #0x740 door, #0xA2D] |
| 0x7E3AD512 (material layer) | slot 1 = texture; slot 2 = blend mode? (6, 7 on base layers); **slot 11 = texture-coordinate generation** (0 = model UVs = base layer; 1–3 with slot 12 = 3/4 = generated coordinates, i.e. the reflection/sheen layer) |

In a Layered Material one layer is the base (e.g. metal) and another simulates the metallic sheen (reflection/specular); the base texture's **alpha is a gloss mask, not transparency** (user-confirmed on the Cellblocks window grate, model Prison Common #0x104B, material World Common #0x436).
| 0xD58D8E2C (animated?) | array in slot 1 of textures (frames) |

`riot_model.material_texture()` tries the known slot first and then any slot that is a valid reference, recursing through materials.

---

### 4.6 Skinned models: 0x0208 (FUN_0047AD70), confirmed on CartWheeler, inmates, Slayer, Killjoy

```
float sphere[4]; float box[12]               // bounds (×2048 at load)
u32 n_lod; u32 n_vertices; u32 n_bones
n_bones × {
    u32 id                                   // hash of the bone name
    float translation[3]; float rotation[9]  // rotation stored column by column
    u32 first_child; u32 next_sibling        // 0 = none (bone 0 is the root)
    n_lod × { u16 n; n × { u32 vertex; float weight } }
}
n_lod × { float distance; u32 first_vertex; u32 n_vertices; u32 first_face; u32 n_faces }
... (more data follows, not decoded)
```
- Vertex positions in 0x0203 are already in **model space, in the bind pose** (their bounds match the declared box exactly), so a viewer can draw them without the skeleton.
- All LODs share the 0x0203/0x0204 arrays. **Face indices of LOD k are relative to that LOD's first vertex**: drawing every face with absolute indices produced the "crumpled" characters. Draw only LOD 0, or add `first_vertex` to the indices.
- Static models (0x0207, FUN_00484020) have no such LOD table: after the bounds comes an `i16` type and a typed list (element sizes 0x14 / 0x40 / 0x18), probably collision data.

### 4.5.1 Resource 0x0207: LOD link, bounds and collision tree (decoded via Ghidra)

Readers: 0x484020 (header) and 0x482D10 (tree), node readers 0x481C10 / 0x481EA0 (+0x481DE0) / 0x481C40. **All 5077 TS1 0x0207 resources parse byte-exact** (`tools/riot_coll.py`).

```
u16 lower-detail model id, u16 higher-detail model id, f LOD distance (squared at load)
bounding sphere:  3f centre, f radius                                   (×2048 at load)
oriented box:     3f centre, 3 × 3f half-extent axes                    (×2048; axes shorter than 0.01 are padded)
i16 tree type (0, 1, 2)
u16 nNodes, 4 × u16 (stored at model +0xC0..+0xC6; e.g. 0,1,0,0 / 0,4,4,4)
nodes (in-memory size 0x14 / 0x40 / 0x18 by type):
  type 0: u16, u16, sphere (3f + f)                                     — 2043 models (most with 0 or 1 node)
  type 1: i16 child A, i16 child B, oriented box (4 × 3f), u16 n + n × u16 face indices   — 3034 models
  type 2: u16, u16, sphere, u32                                         — unused in TS1
```
- **Collision is volume-based, not per triangle.** The face lists of type-1 nodes are empty in 3031 of 3034 models. The root oriented box contains 100% of the model's vertices. The node boxes cover the solid parts; foliage and decals are often left out.
- Practical consequence for an editor: a new static model needs at least a type-1 tree with one node (its oriented box) or a type-0 sphere. Both can be generated from the vertices.
- Skinned models (0x0208, reader 0x47AD70): after the bones come `n × (f radius² + 4 × u32)` collision volumes, then bone groups (u32 counts and u16 lists) and 3 floats. Not fully decoded yet.

### 4.7 Animations (`.adu`): readers registered at 0x474010

| Type | Reader | Content |
|---|---|---|
| 0x0501 | 0x473BA0 | Header: `float duration; u32 loop; u32 n_bones; float ×4` (e.g. 0.2, 1.406, 0.01, 1.0) |
| 0x0502 | 0x473500 | Keyframes (below) |
| 0x0504 | 0x473C50 | `u16 n` + n × (`u32` object ref, low 16 bits = index in the same package; `f` value ~0.65–1.15). 35 resources, all parse byte-exact; meaning unknown (the referenced id exists as both a sound and an animation in its package) |
| 0x0505 | 0x473D00 | **Events**: `u32 n` + n × (`u32 type, f time, u32 bone hash` + `u32 code` if type is 0 or 1), then `u32 m` + m × u32. 526 resources parse byte-exact. Type 1 codes are 100–104, 151, 200–202, 400–401 on bones such as the root (0xB6C65665); type 0 is mostly code 0. Probably footstep / effect triggers per bone |

```
0x0502:
u32 n_bones
n_bones × { u32 bone_id; u32 offset; i16 n_keys; u16 flags; float rest_pos[3] }   // 24 bytes
u32 key_bytes
per bone: n_keys × { float time; float quat[4]; float pos[3] only if flags == 0x8000 }
```
- `bone_id` is the same hash as in the model's 0x0208 bone list (e.g. root `0xB6C65665`), so animations bind to skeletons by bone name hash.
- Positions are multiplied by 2048 at load. Verified: the sum of key sizes equals `key_bytes` exactly (NPCs.adu #0x50001–#0x50003, CartWheeler, 29 bones).
- **Playback (verified visually on the CartWheeler):** keys are **local** to the parent bone; quaternion order **x, y, z, w**; a bone with flags `0x8000` has a position per key, a bone with `0xC000` uses the header's `rest_pos` as its fixed local translation (it matches the bind pose).
- The 0x0208 bone matrices are **inverse bind matrices** (model → bone space): bone position = `−Rᵀ·T`. Skinning: `v' = Σ w · World_bone(t) · InvBind_bone · v`, with `World = World_parent · Local`.
- 86 animations in `NPCs.adu` use exactly the CartWheeler's 29 bone ids.

## 5. Class system (`Suffering.rfl`)

`Suffering.rfl` is a standard PE DLL (image base `0x6DB00000`) with 327 object classes. Class names are plain strings (e.g. "Level Properties", "Sky Properties", "Fog / Sky Switcher", "Volumetric Fog", "Sky / Sun"). Some names are leftovers from Surreal's LOTR game (Shelob, UrakHai, OrcCaptain...).

**Property names are not stored anywhere** (not in the .rfl, not in the .exe); only property *types* are.

### 5.1 Class table entry (in `.data`, 28 bytes)

| Field | Meaning |
|---|---|
| u32 | **class ID** (32-bit hash) |
| u32 | unknown |
| u32 | flags |
| u32 | pointer to class name |
| u32 | number of properties |
| u32 | number of property groups |
| u32 | pointer to group list |

Note: the hash belongs to the entry **before** the name pointer, not the one after it.

Each group pointer → `{u32 count, u32 ptr}` → array of `count` u32 **property type codes**. The group counts add up to the property count.

### 5.2 Property type codes (observed)

| Code | Meaning |
|---|---|
| 0x0001 | integer / bool |
| 0x0002 | float |
| 0x0005, 0x0007, 0x000A, 0x0011 | 4-byte values (enum/int-like; exact meaning unknown) |
| 0x000E | unknown |
| 0x000F | colour, `0x00RRGGBB` |
| 0x2003, 0x3003, 0x4003 | object reference (see §6.4) |

### 5.3 Useful class IDs

| Class | ID | Props |
|---|---|---|
| Level Properties | 0xBFD00933 | 58 |
| Sky Properties | 0x4F594492 | 10 |
| Fog / Sky Switcher | 0xECA9EA64 | 5 |
| Volumetric Fog | 0xA019FCED | 18 |
| Sky / Sun | 0x8352C1E2 | 11 |
| Chapter Properties | 0x576BFE0E | 2 |
| Sound Effect | 0xED6B2FF8 | 19 |
| KillMeleeBehavior | 0x511E4029 | 11 |

---

## 6. Object templates (`.odu`, type 0x0102)

### 6.1 Record layout

| Offset | Type | Meaning |
|---|---|---|
| 0x00 | 12 bytes | header (unknown) |
| 0x0C | u16 | 1 = record has an extra 64-byte block (transform/bounds) before the class ID |
| b = 0x0E (+64 if extra block) | u32 | class ID |
| b+4 | u16 | unknown |
| b+6 | u16 | number of properties |
| b+8 | u16 | 0 |
| b+10 | u16 | number of 4-byte value slots |
| b+14 | slots | property values, one 4-byte slot each, in class order |

Values line up exactly with the type list from the `.rfl` (verified on Level Properties: 58 properties, 60 slots).

### 6.2 Example: `System.odu` #0x0009 (Level Properties default)

Group 0: `6.5, 4, 2.65, 0.65, 0.45`; group 2 starts with `ref(System #0x8)` (the default Sky Properties) ... (full decode in the session; most property meanings unknown).

### 6.3 Example: `System.odu` #0x0068 (Fog / Sky Switcher default)

`ref(none), ref(none), 5.0, 1, 7`, which probably means: target Sky Properties, second ref, transition time in seconds, and two enum/flag values (**hypothesis**). Level-specific switchers in World Common use a transition time of `0.1`.

### 6.4 Object references

A 4-byte reference = `u16 object index` + `u16 package ID` (the `.db` id). Example: `08 00 02 00` = System (#2), object 0x0008.

---

## 7. Level files (`.lvl`)

| Type | Size (Prelude Docks) | Content |
|---|---|---|
| 0x0402 | 8 | metadata |
| 0x0000 | 464 | level name + list of dependency package paths + start camera position/orientation |
| 0x0001 | 376 KB | layers / geometry ("Copy of layer 0", `PCH` tags) |
| 0x0003 | 4 | unknown |
| 0x0020 | 53 KB | **placed object instances** (see below) |
| 0x0026 | 40 KB | unknown |
| 0x0027 | 8 | unknown |
| 0x0028 | 36 KB | editor history? (author names "andre", "richard" + timestamps) |

### 7.1 Instance list (type 0x0020)

```
u16 count
count × { u32 instance_id, u16 template_index, u16 package_id }   // index
count × instance record
```

Instance record (works for simple objects):

| Field | Type |
|---|---|
| position | 3 × float |
| flags | u32 |
| unknown | u32 |
| rotation (degrees?) | u32 |
| number of overridden properties (N) | u32 |
| number of value slots (S) | u32 |
| values | S × 4 bytes |
| property indices | N × u16 |
| trailer | 4 bytes |

Superseded: see section 9b for the exact layout read by the executable.

Example: Prelude Docks, instance 4 = Level Properties (template System #0x9), overrides properties 0, 1, 10, 22, 23, 24, 27, 28. Property 10 = **Sky Properties reference → World Common #0x09ED**.

---

## 8. Fog — what controls it

### 8.1 How it works

1. Each level has one **Level Properties** instance whose property #10 points to a **Sky Properties** object.
2. **Fog / Sky Switcher** objects switch to other Sky Properties when the player enters an area.
3. Almost all Sky Properties live in `World Common\World Common\World Common.odu` (64 objects); the default is `COMMON\System\System.odu` #0x0008.
4. Values are read **when the level loads**, so the level must be restarted after editing.
5. Level `.odu` files (e.g. `1 PrisonDeathRow.odu`) contain **no** Sky Properties.

### 8.2 Sky Properties fields (10 properties)

| Prop | Type | Meaning | Status |
|---|---|---|---|
| p0 | float | ? (almost always 90) | unknown |
| p1 | float | ? (almost always 0.65) | unknown |
| **p2** | float | **fog end distance** (where fog becomes fully opaque); 35–45 indoors, 240 in the Prelude Docks | **confirmed** (p2 = 10 → fog right in front of the player) |
| **p3** | float | **fog start**, as a fraction of p2 (0.6 = fog starts at 60 % of p2) | **confirmed in practice** (0.9 cleared the middle of the corridor) |
| **p4** | colour | **fog colour** | **confirmed** (set to #FF0000 → distant geometry turned red) |
| p5 | colour | probably ambient/sky colour | untested |
| p6 | float | ? (0–0.15) | unknown |
| p7 | float | ? (0.05–0.7) | unknown |
| p8 | float | ? (usually 0, sometimes 0.4) | unknown |
| p9 | ref | sky texture/object reference | inferred from type |

Note: indoor areas mostly use **black** fog (`#000000`). Pushing black fog away mostly reveals unlit geometry, so much of the indoor darkness is lighting, not fog.

### 8.3 Sky Properties used per level (crude reference scan of `.lvl` type 0x0020)

| Level | Sky Properties (World Common unless noted) |
|---|---|
| 0 Prelude Docks | #0x9ED (Level Properties), #0x4A7, #0xA65 |
| 1a PrisonDeathRow | System #0x8, #0xF, #0xA36 |
| 1b PrisonDeathRow | System #0x8, #0xF |
| 1c PrisonDeathRow | System #0x8, #0xF, #0x3DE |
| 2 Cellblocks | System #0x8, #0x18, #0x19, #0x90, #0x31A |
| 3a / 3b YardCellBlock | #0x3C4 / System #0x8, #0xF, #0x18, #0x19, #0x3C4 |
| 4a / 4b Quarry | #0x8C, #0x60A |
| 5a Asylum | #0xF, #0x8C, #0x427, #0x70F, #0x9E5–#0x9E8 |
| 5b Asylum | #0xF, #0x6DE, #0x70A, #0x70B |
| 6a / 6b Woods | #0x93, #0x699 / System #0x8, #0x34, #0x6A6, #0x6D6 |
| 7 ReturnToPrison | System #0x8, #0x18, #0x19, #0xBA |
| 8a / 8b Bluff | System #0x8, #0x90, #0x91, #0x93, #0x41A / #0x98, #0x22D, #0x41A |
| 9 Lighthouse | #0x49B, #0xB23, #0xB24 |
| 10 Docks | #0x4A4, #0xB3A, #0xB4E, #0xBA2, #0xBCC |

Several Sky Properties are shared between levels (e.g. #0xF), so editing one can affect more than one level.

### 8.4 Working "less fog" setting

```
python riot_fog.py restore "E:\Jogos\The Suffering"
python riot_fog.py scale   "E:\Jogos\The Suffering" p2 2
python riot_fog.py setall  "E:\Jogos\The Suffering" p3 0.9
```

Result: the end of the D-Block corridor (1 PrisonDeathRow) became visible. One crash happened during testing with a larger p2; unclear whether it was caused by the edit (larger fog distance may also raise the draw distance) or by the game's general instability. If crashes recur, keep p2 at the original value and change only p3.

`scale` multiplies the current value, so running it twice accumulates (×2 twice = ×4). `restore` always returns the original files from `.orig`.

---

## 9. Hidden debug menu (`Suffering.exe`)

- Global object at **0x5CB080**, constructed by `FUN_00413590` (vtable 0x58D904).
- `*(this+0x138)` = array of option **names**, `*(this+0x144)` = parallel array of **values** (same index).
- `0x412FF0` = `GetValue(id)`; `0x412D20` = `SetValue(id, value)`, which has a switch for options with side effects.
- Options include: Fly, Invincible, Invulnerable, Teleport, Speed, Full Health, Enable Fog (id 10), Fog Value (id 60), Disable Sky, Cull Distance Multiplier, Render Wireframe, Show Invisible Statics, Display Bounding Box, Take Screen Shot, profiling and cache stats, etc. Some are PS2 leftovers ("Test PS2 Stack Size", "Disable VU Renderer").
- **Full option list** (from the constructor 0x413590 via Ghidra; names are stored in an array indexed by option id, defaults set with `SetValue` in the constructor, shown as "(=value)"): 0 Engine Debug Messages (=2) · 1 Font Size · 2 Enable Engine Stats · 3 Show Fade In Stat · 4 Display Activity Messages (=1) · 5 Enable Object Update (=1) · 6 Temporary Flag  fDebugFlag · 7 Disable Animation System · 8 Disable New Animation System · 9 Skin Normals (=0) · 10 Enable Fog (=1) · 11 Render Objects (=1) · 12 Render Instance Objects (=1) · 13 Render Layers (=1) · 14 Render Water (=1) · 15 View Alpha Pipeline · 16 Render Particles (=1) · 17 Enable Distance Cull (=1) · 18 Enable Texturing (=1) · 19 Enable Mipping (=1) · 20 Color by Mip · 21 Only upload used mips (=0) · 22 Force Texture uploads · 23 Approximate Point Lights (=1) · 24 Hardware Clipping (=1) · 25 Hardware Lighting (=1) · 26 Static Model Poly Count · 27 Actor Poly Count Only · 28 Display Splat Poly Count · 29 Display Splat Count · 30 Polygon throughput · 31 Display Rendering VU Time · 32 Display Rendering Core Time · 33 Display Rendering VB Time · 34 Display Texture Upload Time · 35 Display Misc Render Time · 36 Display Core Idle Time · 37 Display Object Run Time · 38 Display Object Detect Time · 39 Display Distance Culled Objects · 40 Display Lights · 41 Display Num Lights · 42 Display Full Bright · 43 Display Bounding Sphere · 44 Display Bounding Box · 45 Display Leaf Bounding · 46 Display Cloth Bounding Spheres · 47 Display Scene Graph Box · 48 Display Scene Graph Sphere · 49 Display Nonrendered Leaf Boundin · 50 Display Vertex Normals · 51 Display Bump STs · 52 Light Radius Cutoff Factor (=10) · 53 Enable Shadows · 54 Debug Shadows · 55 Enable LensFlares (=1) · 56 Enable Screen Warp (=1) · 57 Enable HDR ScreenBlur (=1) · 58 DirectX FrontBuffer Effects · 59 Cull Distance Multiplier · 60 Fog Value · 61 Landscape Texture Resolution (=0) · 62 Procedural Texture with Hues · 63 Display Layer LOD Levels · 64 Disable VU Renderer · 65 Disable Core Renderer · 66 Sync DMA (=0) · 67 Looped Mode Renderer (=0) · 68 Use Vertex shader renderer (=1) · 69 D3D VB Cache Renderer · 70 Take Screen Shot · 71 Split Screen · 72 Output File Access Stats · 73 Reset File Access Stats · 74 Load Map · 75 Output Load Map · 76 Landscape LOD · 77 Render Wireframe · 78 Show Strips · 79 Show Render Groups · 80 Use Occlusion (=0) · 81 Draw Occluders · 82 Disable Sound · 83 Disable HUD · 84 Disable Sky · 85 Log Stats · 86 Cache Statistics · 87 Data Read Delay  ms · 88 Profile Data Loading · 90 Splat Base Only · 91 Splat Disable Noise · 92 Land Splat Debug3 · 93 Land Splat Debug4 · 94 Limit Render Passes (=0) · 95 One Pass Rendering · 96 Output Memory Usage · 98 Test Data Caches · 99 Flush Data Caches · 100 Log Data Cache Usage · 101 Texture Cache Size · 102 Model Cache Size · 103 Animation Cache Size · 104 Splat Cache Size · 105 Flush VertexShader Cache · 106 Dump VertexShader Cache To File · 107 Compile VertexShader Library · 108 Sound Cache Size · 109 Lighting Cache Size · 110 DataCache To View (=0) · 111 Test PS2 Stack Size · 112 Stress Test · 113 Output Stored Transition Saves · 114 Performance Graph Analyzer · 115 Profile Info · 116 Profile Time Display (=0) · 117 Profile Sort Mode (=0) · 118 Profile Color Scheme (=3) · 119 Object Links · 120 Object List · 121 Display Messages · 123 Fly Controller 2 · 125 Invincible · 126 Invulnerable · 127 Teleport · 131 Speed · 132 MrClean · 133 Full Health · 134 Pause · 135 Suicide · 136 Show Invisible Statics · 137 Anti Aliasing (=1) · 138 Do Rendering Performance Test · 139 Print Lines · 140 Single Step  L2 (=0) · 141 Fly PAUSE MODE · 142 Display Playing Sounds (=0) · 143 Show Sound Occlusion Paths · 144 Query for Current FX Settings · 145 Lock Effect To This Debug · 146 Reverb Depth (=100) · 148 RoomHF · 149 Room Rolloff · 150 Decay Time (=10) · 151 Decay HF Ratio (=50) · 152 Reflections · 153 Reflections Delay (=2) · 154 Reverb · 155 Reverb Delay (=4) · 156 Diffusion (=100) · 157 Density (=100) · 158 HF Reference (=500) · 159 Show Scene Graph Geometry Node · 160 Show Scene Graph Group Node · 161 Color Vis Graph Zones · 162 Display Camera Zones · 163 Display Portals · 164 Use portals to cull geometry (=1) · 165 Display Object Zone Name · 166 Render Camera Zone Only · 167 Disable Never Visible Portals · 168 Dump Scene Graph Analysis · 169 Display Prefetched Vis Graph Zon · 170 Color Prefetched Objects · 171 Current Node Prefetch Mode (=1) · 172 Adjacent Nodes Prefetch Mode (=1) · 173 Prefetch Visible Nodes   1 · 174 Use PreComputed Prefetch Sets (=1) · 175 Animation Sounds Prefetch Mode · 176 Gamma Value.
- Notable for the viewer and RiotFix: **Approximate Point Lights** (23, on), **Light Radius Cutoff Factor** (52, = 10), **Use portals to cull geometry** (164, on), Display Portals (163), Display Camera Zones (162), Render Camera Zone Only (166), Use Occlusion (80, off), Enable Distance Cull (17), Cull Distance Multiplier (59).
- `SetValue`'s switch goes through a byte jump table that Ghidra did not normalise, so its case numbers are **not** option ids.
- Default for Enable Fog: `SetValue(10, 1)` at **0x413F3C** (file offset 0x1333C, bytes `6A 01 6A 0A`).
- **No reader of id 10 or id 60 was found** (`GetValue` is only called with ids 2, 4, 5, 0x10, 0x39, 0x5A, 0x5B, 0x8D, 0xA6, 0xAB, 0xAC, 0xAF), and id 10 hits the default case of `SetValue`. Enable Fog is probably inert on PC. How to open the menu in-game is unknown.

---

## 9b. Level object instances (`.lvl` type 0x0020): confirmed from the executable

The layout below is taken directly from the instance loader in `Suffering.exe`, **`FUN_0045A5C0`** (`ret 8`; stream object in `edi`; its vtable: `+0x28` u16, `+0x2C` float, `+0x30` u32, `+0x38` u32, `+0x3C` i16). A parser that follows it (`lvlexe.py`) reads **all 18 `.lvl` files of the game end to end, with no record skipped and no bytes left over** (1a PrisonDeathRow: 5512/5512 records).

The file stores an index first (`u16 count`, then `count × {u32 id, u16 template index, u16 package id}`), then the records:

| Field | Type | Notes |
|---|---|---|
| position | 3 × float | world units (÷ 2048 = model units) |
| flags | **u32** | 0x1 visible; 0x10 extra float; 0x100 scale; 0x8000 bounds block; many others are copied into object state (0x400, 0x800, 0x1000, 0x2000, 0x4000, 0x300000, 0x400000, 0x800000, 0x1000000, 0x2000000, 0x10000000) |
| [extra] | float | only if flags & 0x10 (default 0x5F0AC723 ≈ 1e19) |
| links | i16 n + n × u32 | linked object IDs |
| rotation | 3 × int16 | degrees, order in file X, Y, Z |
| [scale] | 3 × float | only if flags & 0x100 |
| data count `nd` | u32 | |
| param count `np` | u32 | |
| data | nd × u32 | **only if nd > 0 and np > 0** |
| param indices | np × u16 | same condition |
| [bounds] | u32 + 4 floats (sphere) + 12 floats (4×3 matrix) | only if flags & 0x8000 (68 bytes). **The u32 is the instance's own model reference** (`u16 index, u16 package`, passed to `0x454D30`), overriding the template's model; sphere/box ×2048 at runtime |
| trailer | u32 | stored at object +0x6C. In Ties That Bind it references the level's `_level` package: a 0x52 resource in the `.ldu` (baked per-vertex colors for that object) |

Earlier parsers had `nd`/`np` swapped and treated the flags as two u16; the "array" and "2-byte padding" heuristics were artifacts of that.

**Transform (emulated exactly in `enginexf.py`):** the matrix is row-major with row vectors (D3D, `world = v · M`).
1. `0x4D9030(angle, axis)` rotates about the object's **current local axis** (`0x4D67A0` takes row `axis` of the matrix), building the rotation from a quaternion (`0x4D7330`) and composing `M = M · Rot` (`0x4D7200`).
2. Call order: **Y** first, with `angle = Y·π/180 − 1.5707963` (constant at `0x590BB8`), then **X**, then **Z**.
3. The result equals `R = Ry · Rx · Rz` in column-vector form, i.e. three.js Euler order **`'YXZ'`**, all signs positive. (The `'ZYX'` order taken from OpenDrakan is **wrong** for The Suffering.)
4. Scale: `0x4D82F0` multiplies matrix **columns** (`m[0], m[4], m[8]` by sx …), which means the scale is applied along **world axes, after rotation**: in column form, `M = T · S · R`. It also stores 1/scale at +0x40.

**In-memory object (Cheat Engine):** objects are 0x118 bytes apart. The row of 14 floats just before the position holds the 4×4 matrix (rotation × scale). After the position: two small floats, a box of ±1024, a 2048-diagonal matrix, constants −153.78/−240.57/385.21 and 2229.84 (same for all objects).

**Template → model:** the first 4 bytes of an `.odu` template are the model reference (`u16 index, u16 package`). When `u16 @12 == 1` the template has a 64-byte block with bounds (sphere centre + radius, box minimum, sizes) that matches the model's extents.

**Property data (`nd` dwords, `np` indices), derived from all 14,857 records with properties, 0 failures:**
- one 4-byte word per overridden property, in the order of the indices;
- types with bit **0x1000 are arrays** (0x1003, 0x1005, 0x1009, 0x1013 …; also **0x3003 = array of 0x2003 refs** and **0x5003 = array of 0x4003 refs**). Their word is `(count << 16) | offset`, and the items sit at `data[offset : offset + count]`, after the direct words;
- references are `u16 index, u16 package` (0 = none);
- `.odu` templates use the same encoding for their slots (Sky Properties p9 is a 0x3003 array).
`riot_props.py` implements this; `python riot_props.py fog <game>` lists which Sky Properties every level and every Fog/Sky Switcher uses.

**Fog / Sky Switcher (0xECA9EA64):** p0 = Sky Properties ref, p1 = second ref (usually none), p2 = transition time in seconds, p3/p4 = ints (0x11).

**Level Properties (0xBFD00933) → Sky Properties per level (World Common = package 7):** Prelude Docks #0x9ED; 1a #0xA36; 1b, 1c, 3b, 5b #0xF; 2 Cellblocks #0x31A; 3a #0x3C4; 4a, 4b, 5a #0x8C; 6a #0x699; 6b #0x6A6; 7 #0xBA; 8a #0x41A; 8b #0x98; 9 #0x49B; 10 Docks #0xB3A. Switchers inside each level point to further Sky objects.

**Template classes without a real model:** Waypoints, Behaviors, Aim Controllers etc. point to a placeholder model (10 #0x0002, the CartWheeler) and are hidden in the viewer.

## 9e. Terrain layers (`.lvl` type 0x0001): confirmed from the executable

Loader: **`FUN_0049FEB0`** (called from the level loader at 0x467432 with the landscape object 0x5C6EC8; error string "Error reading the landscape layers!"). `lvllayers.py` reads all 18 levels exactly to the last byte. The layout differs from Drakan/OpenDrakan after the layer name.

```
u32 layer_count
layer_count × {
    u32 id; i32 width, height (cells); u32 type (0 floor, 1 ceiling)
    i32 origin_x, origin_z (cells; 1 cell = 2048 world units = 1 model unit)
    float base_height (world units)
    u16 len + name
    u32 flags                       // 0x2, 0x4 (single normal), 0x10
    u32 ref                         // nonzero on almost every layer (meaning unknown)
    if ref: 5 × u32, u32 n, n × {4 × u32, u32 m, m × u32 refs, u32 gx, gy, gz, gx*gy*gz bytes}
    normals: (flags & 4 ? 1 : (w+1)(h+1)) × int8[4]   (÷127)
    u32 unknown                     // -> layer +0x60
}
u32 compressed                       // 1 = zlib
layer_count × { u32 size; size bytes (zlib) }  ->  unpacked:
    (w+1)(h+1) × { u32 vertex_flags; u16 height }   // y = base + (height − 0x8000) × 2
    w*h × { u16 flags; i32 material_ref; u16 Uc,Ud,Ub,Ua,Vc,Vd,Vb,Va }   // 22 bytes
```
- Vertices are row by row (row = +Z, column = +X); position = (origin_x + col, y / 2048, origin_z + row) in model units.
- Face flag bit 0 = diagonal direction (as in Drakan). A face with `material_ref <= 0` or `flags & 0x30` is a hole.
- `material_ref` = `u16 index, u16 package` → a landscape material in *Landscape Textures* (package 6). Its class **0xB13556E7** is built into the engine (not in `Suffering.rfl`); **slot 3 is the texture reference** (id in `Landscape Textures.tdu`), slot 0 is another ref (surface type?).
- UVs: 0..65535 → 0..1, corners a-b (top) / c-d (bottom).

## 9c. Names and context

From the [Gamasutra/Game Developer postmortem](https://www.gamedeveloper.com/design/postmortem-the-game-design-of-surreal-s-i-the-suffering-i-) and from the data:

| Name in files | Meaning |
|---|---|
| `?0x5B0BAD74` (no name in `.rfl`) | **Portal** (visibility portal; uses System model #0xB5 with a "Portal" texture) — identified by the user |
| `?0x10D88BF0` (no name in `.rfl`) | **Fake light shafts (godrays) and alpha-textured geometry** (decals, grime) — identified by the user |
| `?0x029E9104` (no name in `.rfl`) | **Water volume** (texture World Common #0x345 / #0x348) — identified by the user |
| `?0x1589A3E3` (no name in `.rfl`) | **CCTV camera** — identified by the user |
| System package (2) models | Editor gizmos: Portal, Detector, Sound Effect, Ambient Sound, Clamber Point, Invisible Static Object, Player Spawn Point |
| `CartWheeler` | Early name of the **Slayer** (the blade creature); renamed and reworked to detach the head |
| **STOMP** (`STOMP Player`, `.qdu`) | Riot Engine **cinematic system**. `.qdu` resources are animation tracks (`Camera`, `Torque`, `Shoe Left/Right`, `Hat`). `STOMP Player` is the placed trigger (invisible box, scaled). Its first property has type `0xB`, a type used by no other class (probably the sequence reference). OpenDrakan also has a `StompPlayer` class for Drakan |
| `Reputation *` classes | The morality system inherited from Surreal's Gunslinger (blood texture sets and idle animations change with reputation) |
| `Screen Blur`, `Time Scale`, `Black And White Toggler`, `xpsBW_PC.psh` | Flashback presentation (slow motion, blur, black and white) |
| `Insanity Screen Flash`, `Warp Effect` | Environmental "flashes" added in the horror pass |
| `Phone`, `Simple Radio GUI`, `Speech Player`, `Line of Dialog` | Story delivery through phones, radios and PA |
| `Archives Trigger`, `GUI Archives`, `Archive Set` | Unlockable archive pages |
| LOTR leftovers (`Shelob…`, `UrakHai…`, `OrcCaptain…`) | Code shared with Surreal's *The Fellowship of the Ring* |

## 9d. Shaders (`xvsh\`)

- `*.vsh`: vertex shader fragments (D3D8-style asm, `vs.1.1`) concatenated at runtime: header (+fog), lights (directional, point, spot, hemisphere, precomputed, uniform), footer, texture-coordinate variants (plain, matrix, bump offset, reflection). `%i` is replaced by the light index.
- `*.psh`: only special effects (black and white, alpha clear). `xpsbw.xpu` is the Xbox-compiled version (`PSB0`).
- `ShaderLibrary.bin`: `u32 N` (989), `N × {u32 key, u32 extra}`, then `N × {u32 size, vs_1_1 bytecode}`. `shaderlib.py` disassembles it.
- **Fog:** every compiled shader has `mad oFog, -r0.z, c50.z, c50.w` (linear fog from depth; `c50` set by the engine). `c51 = [1, 0.5, 0, 2]`.
- Lighting constants: `c8…` lights (position/intensity, colour, direction), `c80` ambient, `c82` brightness clamp, `c83` world up in object space.

## 9g. Lights (engine-built-in classes, not in the `.rfl`)

Identified by the user as light data; confirmed by the data and the exe: the code at `0x4C4DF5` walks the level objects and collects those whose class is **0x7DFFD694** or **0x54E01F83** into a list (a light collector).

**0x7DFFD694 — light (point light).** 1539 instances in the first game (75 templates), 1244 in Ties That Bind. Placed about 2 units from the lamp models; **Light Housing objects link to them** (308 links), as do Message Relay (301), Timer, Screen Fader and STOMP Player (lights switched by events and cinematics).

| Slot | Meaning (first game) | Evidence |
|---|---|---|
| p0 | **colour** 0x(AA)RRGGBB | most overridden (1000×): `0xFFE0A8`, `0xDD9764`, `0x86A29E`, `0x4F5066`… |
| p1 | ? | always 0 when overridden |
| p3 | ref to a **0x6968CE68** light animator (optional) | `World Common #0x3C8`, `#0xE7`… |
| p4, p5 | small ints (1/2, 13/12, 0x5B…) — type / group? | |
| p6 | bool (0/1) — initially on? | |
| p8 | **radius** in units | second most overridden (1184×): 3.2, 4.05, 5, 6, 7.2, 16.2; System default 0.05 |
| p9 | enum 0/1/2 | |

1126 of 1539 lights have a rotation (irrelevant for a point light, or used by the shading). In Ties That Bind the class has 11 properties: the radius moves to slot 9 (a property was inserted before it).

**0x54E01F83 — probably a spot light.** 11 properties (the light's 10 + 2 floats: default 6.0 and 20.0, probably range and cone angle). 3 instances in Asylum Interior, rotated (e.g. −13°, 187°) and overriding colour `0xF5CF9C` and the two floats (2.0, 18.0). Ties That Bind: 12 properties, 7 instances.

**0x6968CE68 — probably a light animator (flicker/pulse).** 18 properties: ints (1,1,1,2,12,10), **two colours** (A/B, e.g. `0xEAE286` / `0xEB741D`), **two radii** (7.2 / 16.2, 0.05 / 4.05), a reference to Resources `#0x6E` (curve or sound?) and floats 1.0. Referenced by light p3 and links to lights (8). Ties That Bind: 19 properties.

Vertex shaders (`xvsh`) have matching fragments: `xvsLightPoint`, `xvsLightSpot`, `xvsLightDir`, `xvsLightPointHemiXtra`, `xvsLightUniform`, `xvsLightPrecomputed` (Ties That Bind adds `xvsLightMapProjection` and `xvsLightSpecularAlpha`). Lights are uploaded from `c8` onward (see 9d).

### Shadows (confirmed from the executable)

**Technique.** Each shadow-casting character gets its own **render-target texture** (silhouette rendered from the light), projected onto receivers. `xvsShadowBackfaceCull.vsh` writes `oT0` = world position × `c4`/`c5` (projection of the shadow texture), and `oD0` = colour `c80` with alpha = N·L term (`c55` light direction, `c56` = (0.3, 1/0.7) fixed in code at 0x436470: alpha = (N·L + 0.3) × 1/0.7, from the shader source `add r1.x, c[56].x` / `mul r1.x, c[56].y`) × three clip planes `c57`–`c59` (`sge`). So the shadow is texture-based; the per-vertex part only fades it on back-facing/clipped receivers.

| What | Where (TS1 / TTB) | Value |
|---|---|---|
| Caster registration | `0x492A00` calls `ShadowMgr(0x5C9460)::Add(obj, size, flags)` at **0x492AF2** / TTB 0x496B40 | `push 0x380` (flags 0x80/0x100/0x200), **`push 0x100` = texture size 256** |
| Size limit | `cmp ebp,0x100; ja skip` at **0x4CEF36** / TTB 0x4DC613 | sizes above 256 rejected |
| Texture creation | `0x4CB600` → `0x4481C0(w=size, h=size, fmt 0x20, flags 0x480001)` | one square texture per shadow slot (slot = 0x14E bytes; default size field 0x40 until created) |
| Option (launcher combo) | `0x5C6D00` (settings blob +0xC0); switch at 0x4CEEC3 | 3 = All, 2 = Characters only (model flag 0x2000 excluded), 1 = Players only, 0 = None |
| Light direction | `0x4CC020`: caster's first attached light (vtable +0x168 iterates, +0x16C gives its position), skipping lights with flag 0x100 when the caster has flag 2; dir = light − caster, normalised | **correction:** a light *below* 45° (y < sin 45° at 0x595B54) is raised to exactly 45° (y = horizontal length, renormalised), so shadows always fall downwards; lights with flag 0x100 (only the flashlight's spot) are skipped; no light → zero vector → no shadow (0x4CD550) |
| Fade/cull distances | `0x4084A0` (engine object 0x5C6DC8, vtable slot 6), called from the `.rfl` Level Properties code at 0x6DBB245A | start = **Level Properties p14** × 4194.304, end = **p15** × 4194.304, cull = end × 1.1; shadow opacity fades linearly between them (0x4CF1E5) |

- Level Properties default (System.odu #0x9): **p14 = 15, p15 = 30**; no level overrides them (all 18 TS1 levels).
- Caster test at 0x492AC2: shadow only if `fadeEnd × max(radius, 100) ≥ dist² × k`.

**Higher resolution (patch, untested in-game):** change both the `push 0x100` and the `cmp ebp,0x100` to 0x200/0x400. Tool: `riot_patch.py <exe> --shadow 512|1024` (checks original bytes, keeps `.orig`, `--restore`). Distance of shadows: raise Level Properties p14/p15 in `System.odu` #0x9.

- **Which objects cast (lvl_ReadInstance 0x45A5C0).** With instance flag 0x1000 the instance decides (0x400 → object +8
  bit 0x1000000, 0x800 → bit 0x2000000). Without it both come from the template object's flags (+0x20), which are the
  **u32 at offset 4 of the template data (0x0102)**: bit 0 = casts dynamic shadow, bit 1 = the 0x800 pair; bit 6 / bit 10
  feed group B and bit 7 group C. In practice the casters are characters: Unspeakable NPC / CartWheeler / Player
  templates have 0x0321 / 0x0121 (bit 0 on), Static Object 0x030C/0x030E (off). 0x400 without 0x1000 is ignored
  (1086 TS1 instances have it). SurrealEd's Level tab reproduces the shadows (World Settings → Lighting).

### Shadows, LOD and lights: details confirmed via Ghidra (Suffering.exe dump)
- **0x492A00 is the per-object shadow + LOD update**, not only shadow registration:
  - **Shadow branch:** runs when option ≠ 0 and the object flags (+8) have 0x1000000, lack 0x4000000 (already has a shadow) and lack bit 0x80. It registers the caster when `dist² × obj[+0x58] ≤ fadeEnd × max(model radius (model+0x60), 100.0)`. fadeEnd is the global 0x6EC078, so **shadow range grows with the model's bounding radius**.
  - **LOD branch:** runs when object +0xC has 0x800000 and lacks 0x200000. It calls `lod_SelectSkinned` if the object has a skeleton (+0xEC ≠ 0), otherwise `lod_SelectStatic`.
- **ShadowMgr::Add (0x4CEEA0)**:
  - Option 1 = the player only (compares +0xE4 with the first player); 2 = characters whose model lacks flag 0x2000; 3 = all.
  - It requires object flag +8 bit 1 and size ≤ 0x100 (the `cmp` at 0x4CEF36).
  - It creates **one render-target texture per caster, once** (format 0x20, flags 0x480001), then sets flag 0x4000000 on the object.
  - On texture-creation failure it tears down a 0x14E-byte slot built on the stack (0x4CEE70 / 0x4CCAE0). Larger shadow resolutions make that failure path likelier (VRAM), a plausible cause of the crash seen with high RiotFix shadow resolutions.
- **shadow_SetFadeDistances (0x4084A0)** stores: 0x6EC080 = start × 4194.304, 0x6EC078 = end × 4194.304, 0x6EC07C = end × 4194.304 × 1.1 (cull), 0x6EC084 / 0x6EC088 = its 3rd/4th arguments (unknown).
- **0x4CD550 builds the light-view projection and renders the shadow.** The zero-direction early exit is only its first test.
- **Skinned LOD (0x46B220)**: current level in object +0x10; table at model +0xD4 (stride 0x14, squared distance at +0), count at model +0xDC. It moves **one level per call**: down if `dist² < table[cur] − 1048576`, up if `dist² > table[cur+1] + 1048576`. Model flag 0x400000 (model +0xC bit 22) freezes the LOD.
- **Static LOD (0x491800)** switches only when the target model is already loaded (state 3, vtable +0x20 == 3), so LODs follow streaming. Object flag 0x400000 blocks the switch, and object +0x70 counts the LOD depth.
- **Light upload (0x436470)**: lights go to vertex-shader constants through device vtable +0x178 (SetVertexShaderConstantF), from runtime light records of 0x44 bytes:
  - type 0 (directional): direction + colour;
  - types 1 / 3 / 4 (point): `(pos, intensity)` and `(rgb, 0 / −1 / +1 hemisphere)`;
  - type 2 (spot): pos, direction, colour, `w = (2·r[10])² × 0.05 × r[11]`.
  - Per-object light counts are packed in object flags bits 2–5, 6–9, 10–13.
  - c80 = object ambient colour (ARGB / 255); c30 = (1 − k, k) with k = 0.5 (0 for skinned objects).
  - The intensity getter 0x4C07F0 returns light +0x38 (same field as the setter 0x4C4760).
- **`.qdu` header**: the third u32 is skipped by the reader (unused). Flags: bit 0x100 is always cleared; 0x42 is cleared when bit 1 is set. Sequence duration = latest event time.

## 9h. LOD and draw distance (confirmed from the executable)

- Skinned models (0x0208) have a per-model LOD table. Table at model +0xD4 (count +0xDC, stride 0x14), distance squared at load (0x47B0E6).
- Selection `0x46B220` (TTB 0x470CC0), called once from 0x492B0D (TTB 0x496B5B) with the **squared camera distance** (camera pos at `[0x5C5D74]+0x8C`). Switch to coarser when dist² > LOD[i+1]² + h, finer when dist² < LOD[i]² − h; h = 1048576 (TS1) / 0.25 (TTB). **No global multiplier.**
- Values: TS1 has 26 two-LOD models, all in NPCs.mdu, second LOD at 20480 (=10 model units) for most, also 24576/30720/47104. TTB: 42 (NPCs + Player Weapon and FX), second LOD at 6 or 10 model units (some keep TS1's 20480 = effectively never).
- Ways to change: edit the LOD floats in the `.mdu` (0x0208 table), or `riot_patch.py <exe> --lod0` (replaces `mov edx,[esp+0x20]` at 0x492B07 / TTB 0x496B55 with `xor edx,edx` → always LOD 0).
- **Static models also have LODs**, via resource **0x0207** (reader 0x484020): `u16 lower-detail model id, u16 higher-detail model id, f switch distance` (squared at load), then sphere, box, `i16` type + typed list. The distance sits on the lower-detail model. Selection `0x491800(model, dist²)` (TTB 0x495870), called at 0x492B23 (TTB 0x496B71), same hysteresis; object flag 0x400000 blocks the switch. Only 7 TS1 chains, all in Prison Common (0xC08→0xC32→0xE0B and 0xC09→0xE0C→0xE0D at 12/18 units: the floor grates of 1a, 2 and 3b; 0x697→0xB5B; 0x767→0xB57; 0xB58→0xB59). RiotFix 1.1 scales both selections.
- **Cull Distance Multiplier** (TS1 only): float at `0x5C6D1C` = registry blob `HKCU\SOFTWARE\Surreal\Riot Engine\SettingsDX105` (REG_BINARY, 0x184 bytes) offset **0xDC**, default 1.0 (set at 0x4054B7), no UI. Multiplies each object's cull distance (object +0x74) at 0x491A1D/0x49116B/0x4989DB/0x493586; also clamped by `[0x5C6DF4]×2048`. The debug-menu entry only displays it (×100). TTB's settings struct has no such field.
- Other debug entries (inert in retail, values only stored in the menu array): Landscape LOD (id 0x4C), Display Layer LOD Levels (0x3F), Landscape Texture Resolution (0x3D), Light Radius Cutoff Factor (0x34).

## 9k. Baked lighting (both games)

- Each level has `<level>_level.ldu` with one **0x52** resource per lit instance: `u16 model index, u16 model package, u32 1, u32 n, n × BGRA` (n = vertex count of the model's 0x0203). The instance's final u32 (`.lvl` 0x20) is the reference (package = the `_level` package). 1a PrisonDeathRow: 2627 resources, 2451 instances; colours are dark (median ~14/255, p99 ~78).
- Shader `xvsLightPrecomputed.vsh`: `r2 = v10 × c51.wwwx` with c51 = (1, 0.5, 0, 2) → colour ×2; `xvsLightFooter.vsh`: `min(r2, c82)` (c82 = 1.5686) then `× c51.yyyx` (×0.5, "half rgb") → oD0 ≈ baked colour, Stage 0 COLOROP is plain MODULATE (`SetTextureStageState(0, COLOROP, 4)` at 0x49AA7A), so final = texture × min(2·baked + Σ point lights + ambient, 1.5686) × 0.5. Baked colours alone are very dark (fill light only); most of the visible light comes from the Point Lights at runtime.
- Point lights (`xvsLightPoint.vsh`) are added on top of the baked colour for static geometry and used alone for characters/dynamic objects: per light `c8+i` = (pos, intensity), `c9+i` = (rgb, hemisphere); contribution = N·L × min(intensity / d², 2.0) × colour, over ambient `c80`. Intensity comes from the runtime light +0x38 (setter 0x4C4760, vtable 0x59543C slot 8). Working hypothesis used by the viewer: intensity = Point Light property 8 (TTB: property 9; enabled flag p6 / TTB p7), in model units — visually matches in-game screenshots of 1a.
- `0x0216` in models is not lighting: it is `u16 n` + vertex index list (vertex remap).

## 9l. Video packages (`.vdu`)

The exe maps `.vdu` to the type name "Video" (tag `xmv`), but on PC the payload is plain **ASF/WMV (WMV2, no audio)**. Per video:
- **0x0342** (76 bytes): `u32 version (2), u32 fps (30), u32 duration ms (incl. ASF preroll), u32 width, u32 height, u32 bpp (24), u32 n`, then a table of offsets into the payload at 512 KB steps (streaming reads; the first is the ASF header).
- **0x0343**: the ASF file with its *Simple Index Object* (GUID 33000890-E5B1-11CF-89F4-00A0C90349CB) moved to the front. Moving it back to the end gives a valid `.wmv` (`riot_vdu.py`).
- `Interface.vdu` (110 MB): 21 videos at 512×512 / 30 fps: menu backgrounds (prison corridor, 10 s loops), a 117 s night/moon sequence, short 0.4 s transitions, 15 s Midway / Surreal logos. TTB also plays videos on in-game textures ("Movie texture isn't 512x512!").

## 9m. Other packages: sounds, strings, sequences, fonts

Type names from the exe's extension table (0x194D08): `.fdu` Font, `.wdu` Waveform, `.ldu` Lighting, `.vdu` Video, `.xdu` String, `.qdu` Sequence, `.sdu` Sound, `.adu` Animation, `.tdu` Texture, `.mdu` Model, `.odu` Template, `.gdu` Group.

- **`.sdu` Sound** (readers 0x43D8E0 / 0x444A20). 0x0302 (60 B): **[field order confirmed via Ghidra: +0x24 and +0x28 are two u32 stored in the sound object; in TTB +0x24 holds the subtitle string ref; the reader skips 4 bytes at +0x34]** `u32 ?, u32 volume (0-10000), u32 flags (bits 0x8, 0x10, 0x4, 0x20, 0x40, 0x80, 0x100, 0x400 → runtime flags), u32 priority, f ?, f min distance, f max distance, f, f (distances ×2048), u32, u32, u16 channels, u16 bits, u32 sample rate, u32 data bytes`. 0x0303: raw signed PCM. Resources.sdu: 156 mono 16-bit sounds at 8–44.1 kHz (mostly 32 kHz and 22.05 kHz). `riot_sdu.py` writes WAVs.
- **`.xdu` String**. One 0x0400 per string: `u16 byte length (incl. null) + UTF-16LE`. Holds UI text, level paths (System.xdu = level list) and all subtitles/dialogue per level. `riot_xdu.py` dumps a TSV.
- **`.qdu` Sequence** (reader 0x44BFD0; event readers registered at 0x5DC400). 0x0311: `u32 flags, f radius (×2048), u32 ?, u32 nTracks`; track = `u16 n + ASCII name, u32, u32 object id (instance in the .lvl), u32, u32 nEvents`; event = `u16 type, f time (s)` + payload: 0 = 4f+3f+u32+u32+3f (transform key), 1 = u32,u32,3f,u32, 2/3 = u32,u16,u16, 4 = u32,u32, 5/6 = u32, 7 = 3×u32, 8 = u32,u32,4f,u32, 9 = f,u32,u32, 10 = no payload (4 Quarry, 8 Bluff). Parses byte-exact (all TS1 sequences). 0 Prelude Docks #1 is the 41.7 s intro (Camera, PoliceBoat, Torque, inmates, guards, fog switcher, splashes). `riot_qdu.py`.
- **`.fdu` Font**. 0x0700: header with glyph height (22 / 32 px), refs to atlas textures in Interface.tdu (#0x457, #0x458, #0x459), then glyph records (char code + rectangle). Not fully decoded.

## 9n. Sequences in practice: playback, skinning and Ties That Bind differences

Verified by playing every `.qdu` of both games in the viewer (18 TS1 levels, 18 TTB levels).

**Playback conventions**
- Key positions are world units (TS1 ÷2048 in the viewer). Objects and the camera use the **conjugated** quaternion (three.js); the camera looks down −z.
- A key whose flag is 0 is a **cut** (no interpolation into it).
- TS1 camera keys with flag & 0x80 are **attached to a bone of a host actor** (the actor whose first key coincides with the camera's first key, e.g. the police boat in the Prelude). The bone is the unskinned bone (excluding ancestors of skinned bones) with the largest translation range in the actor's animations (bone 16 on the boat). In TTB almost every camera key has 0x80 (values 0xC0 / 0xD0) and no host actor matches, so the keys are used as world positions.
- Sound events (type 3) point to an object id; the audio is resource 0x0302/0x0303 with that same id in the package's `.sdu`. Subtitle text: in TS1 the object's `.odu` template is a **Line of Dialog** (0xCC015D52), p2 = string ref into `.xdu`. In TTB the **0x0302 header holds the subtitle at +0x24** (`u16 string index, u16 package`; 0 = no subtitle).

**Skinning details**
- Model resource **0x0216**: `u16 n` + n×u16. A value ≥ 0x8000 marks a vertex duplicated for a UV seam, a copy of vertex `0xFFFF − value`; these copies are absent from the 0x0208 weight lists and must inherit the original's weights (otherwise they stay in the bind pose and form "fans").
- Some LOD 0 vertices have no weight and no 0x0216 mapping:
  - **Killjoy (NPCs #0x5A)**: 554 vertices that coincide with weighted vertices. They are fins of the "photocell" ray effect (material 1, white System texture); they inherit the weights of the coincident vertex.
  - **Animating Static** props (e.g. Stomp_NeckBrace in 5 Asylum): rigid parts that follow the root bone.
- Killjoy's rays are driven by bones 86–90 (direct children of the root, no track in most animations). In the ray animations (e.g. NPCs #0x1FD, 9 Lighthouse #0x27) they get keys whose rest positions are 2–6 units away from the body, which fans the rays out on purpose. Their material (NPCs texture #0x100) is **additive** (blend 2). When untracked, the viewer keeps them rigid relative to the pelvis.

**Ties That Bind `.qdu`** (event readers registered at **0x63FF60**, payload sizes table at 0x62A160)
- 0x0311 header is **28 bytes**: `u32 1, u32 2, f ?, u32 flags, f radius?, u32 ?, u32 nTracks`.
- Event 0 (transform) is **60 bytes**: the TS1 layout plus one more `3f` after the scale. All other event types match TS1. All 341 TTB sequences parse byte-exact.

**Ties That Bind `.adu` keys** (0x0502 reader **0x4799E0**, fast path used by the shipped files; evaluator 0x479BA0)
- Bone headers are the same 24-byte records; `offset` is the byte offset of the bone's keys.
- Keys are **packed**: `u16 time` (× 1/30 s, constant at 0x62B0A4) + `3 × s16` quaternion x, y, z (÷ 32767; w = +√(1 − x² − y² − z²)) = 8 bytes, plus `3f` position when flags == 0x8000 (20 bytes). The sum of key sizes equals `key_bytes` exactly.
- 0x0501 has the same layout as TS1; the `loop` field holds 4/5/6 instead of 0/1.

## 9i. Engine-built-in classes and blend modes (confirmed from the executable)

Built-in classes (not in the `.rfl`) are named in a table at **0x5BB348** (28-byte rows: hash, ?, ?, name, nProps, ?, types):

| Hash | Name | Props |
|---|---|---|
| 0x03656E9F | Layered Material | 3 |
| 0x11F8F39E | Wave Bump | 5 |
| 0x2D8C5D43 | Preset Material | 12 |
| 0x54E01F83 | Spot Light | 11 |
| 0x5B0BAD74 | Portal | 7 |
| 0x6968CE68 | Lighting Effect (light animator) | 18 |
| 0x6B110672 | Directional Light | 10 |
| 0x7578F3F7 | Ambient Light | 10 |
| 0x7DFFD694 | Point Light | 10 |
| 0x7E3AD512 | Advanced Material | 18 |
| 0x8C84CCE7 | Landscape Water Material | 13 |
| 0xAAAE85E3 | Engine Properties | 248 |
| 0xAD99E79B | Simple Material | 3 |
| 0xB13556E7 | Landscape Material | 9 |
| 0xB345D08D | HDR Scene Glow | 4 |
| 0xBC4FE3F7 | Rim Light | 12 |
| 0xC977497E | Sound Occlusion Template | 5 |
| 0xD58D8E2C | Animating Material | 8 |
| 0xF7BB7912 | Reverb Effect Template | 18 |

**Advanced Material slot 2 = blend mode** (`eRS_EXBlendMode`, mapped at 0x49A990 to D3D SRCBLEND/DESTBLEND/BLENDOP):

| Mode | Src / Dst | Meaning |
|---|---|---|
| 0, 3 | ONE / ZERO | opaque |
| 1, 8 | SRCALPHA / INVSRCALPHA | alpha blend |
| 2 | SRCALPHA / ONE | additive |
| 4 | SRCALPHA / ONE, REVSUBTRACT | subtractive |
| 5 | ZERO / SRCALPHA | multiply by alpha |
| 6 | DESTCOLOR / SRCCOLOR | modulate ×2 (decals: dirt, stains) |
| 7 | ONE / SRCALPHA | add + darken |

**Ties That Bind uses a different blend enum** (table at 0x49F880, 13 modes):

| Mode | Src / Dst / Op | Meaning |
|---|---|---|
| 0 | ONE / ZERO | opaque |
| 1, 2 | SRCALPHA / INVSRCALPHA | alpha blend |
| 3, 4 | SRCALPHA / ONE | additive |
| 5 | SRCALPHA / ONE, REVSUBTRACT | subtractive: blood decals are **cyan** textures subtracted from the floor (leaves red; black = no change) |
| 6 | ZERO / SRCALPHA | multiply by alpha |
| 7, 10 | DESTCOLOR / SRCCOLOR | modulate ×2 |
| 8 | ONE / SRCALPHA | add + darken |
| 9 | ZERO / SRCCOLOR | multiply |
| 11 | DESTALPHA / ONE | additive by destination alpha |
| 12 | SRCALPHA / ZERO | colour × alpha, replaces |

## 9j. RiotFix (runtime patch DLL)

`dinput8.dll` proxy (both games import only `DirectInput8Create` from it). Reads `RiotFix.ini`, writes `RiotFix.log`; recognises the game by the bytes at 0x492AE2 / 0x496B30. Options: shadow texture resolution (push + cmp), shadow distance scale (hooks the fade setter's vtable slot: TS1 0x58CA68 → 0x4084A0 with ints; TTB 0x5E6CE4 → 0x409B40 with floats, stores squares into 0x74FC00/04/08), character LOD distance scale (redirects the call to the LOD selector, scaling dist² by 1/k²; 0 = always LOD 0), cull distance multiplier (TS1 only: repoints the six `fld [0x5C6D1C]` operands to the DLL's own float).

## 9f. The Suffering: Ties That Bind (2005)

Same Riot Engine formats: SRSC `01 01`, the same resource types, and every parser here reads all 18 TTB `.lvl` files exactly (instances and layers). Differences found so far:
- **Instance positions are stored in model units**, not ×2048 (in `SufferingTTB.exe` the layer loader `0x4A48C0` also stores the origin without the `fmul 2048`). Layer base heights are still ×2048.
- `SufferingTTB.rfl` has 394 classes; `riotobj2.load_classes_any` finds them from the PE headers instead of fixed addresses.
- New `.ldu` per level (`*_level.ldu`): type **0x52** resources = **baked per-vertex lighting**: header (`u16 ?, u16 0x65, u32 1, u32 n_vertices`) then `n × BGRA`. Instances point to theirs through the record trailer.
- **Level architecture = Static Objects that share one generic template with no model** (e.g. Slums Grouphome #0x42, 330 instances); the model comes from the instance's 0x8000 block. In the first game 114 instances use that override too (64 had no model at all, 50 a different one).
- Levels use 1–6 small layers; the architecture is almost entirely static models.

## 9o. Ghidra pass on the full project (TS1 `Suffering.exe`)

### Resource-type table (`.rdata` 0x595BB8, 12 entries × 28 bytes)
Each entry: name, extension, letter code, format version, primary chunk type, source-file extension, flag.
The manager objects live in the array at 0x5DC828 (same order). Each resource object has a
vtable whose slot +0x18 registers "chunk type -> reader".

| # | Name | Ext | Code | Version | Main chunk | Source | Reader(s) |
|---|------|-----|------|---------|------------|--------|-----------|
| 0 | Group | .gdu | G | 0x100 | 0x0080 | – | (no files shipped) |
| 1 | Template | .odu | O | 0x112 | 0x0102 | – | 0x45FA90 via 0x4609F0 |
| 2 | Model | .mdu | M | 0x129 | 0x0200 | reo | 0x200/0x203/0x204/0x214/0x207/0x208/0x211 |
| 3 | Texture | .tdu | T | 0x212 | 0x0041* | jpg | callback 0x448FC0 on chunk 0x0040 |
| 4 | Animation | .adu | A | 0x10F | 0x0501 | rea | 0x501/0x502/0x504/0x505 |
| 5 | Sound | .sdu | S | 0x119 | 0x0302 | wav | 0x302 (`sdu_Read`), 0x305 (0x43D500) |
| 6 | Sequence | .qdu | Q | 0x111 | 0x0311 | – | `qdu_ReadSequence` |
| 7 | String | .xdu | X | 0x105 | 0x0400 | – | 0x484360 |
| 8 | Video | .vdu | V | 0x104 | 0x0342 | ipu | 0x486A60 |
| 9 | Lighting | .ldu | L | 0x101 | 0x0052 | – | 0x487610 |
| 10 | Waveform | .wdu | W | 0x101 | 0x0060 | wav | 0x4881C0 |
| 11 | Font | .fdu | F | 0x100 | 0x0700 | – | 0x489380 |

(*) The table says 0x41 for textures, but the texture object registers chunk **0x0040**. 0x41 is the
D3D-format code built from the header (0x41 / 0x51 / 0x10041…0x80041).
The `.0x402` chunk of every package = `u16 version` (must match the table), `u16 ?`, `u32 1`, `u16 'WI'`.

**Common chunk preamble (editor metadata).** The `.xdu`, `.ldu`, `.wdu` and `.fdu` readers start by skipping
`string, string, 8 bytes (FILETIME), string(s)` unless the game is in editor mode (`[0x5C5D70+4] != 0`).

### `.tdu` 0x0040: confirmed 48-byte header
`u32 width, u32 height, u32 bytesPerRow (= width*bpp/8), u32 bpp (4 = DXT1, 8 = DXT5/8-bit), u32 alphaBits (0/1/4/8),
u32 -1, u32 flags, f32 (256.0 almost always; -> obj+0x54 = exponent, mip/LOD bias), u32 dxtType (2 = DXT1, 3 = DXT5, 0 = paletted),
then a list of u32 terminated by 0 (always `2, 1, 0`)`.
- **No mipmaps are stored**: data size = w*h*bpp/8 exactly; the engine builds them.
- Paletted (bpp 8, dxtType 0, 4 files): +16 bytes + 1024-byte palette (256 × BGRA).
- Flags seen: 0x200 (compressed, 5123), 0x2 + 0x8 (4074), 0x200000 (24), 0x1000 (14), 0x1000000 (7), 0x8000, 0x4000, 0x400000, 0x4000000.
  Mapping into D3D flags in 0x448FC0: 0x800->0x80, 0x1000->0x100, 0x4000->0x2000000, 0x8000->0x4000000, 0x400000->0x20000000, 0x800000->0x800000.
- Size in memory (0x445180): 0x6C header + w*h + palette (0x41C for type 1, 0x21C for type 2, 0x1C otherwise).

### `.ldu` 0x0052: baked vertex colours
`u32 owner (e.g. 0x00030174), u32 nSets, nSets × { u32 nColours, nColours × u32 BGRA }`.
If any colour has alpha < 0xFE the resource gets flag 4 (translucent). (These are the "74 01 03 00" bytes searched in Cheat Engine.)

### `.wdu` 0x0060: waveform
`[preamble] u32 format (0/4 = raw bytes, 1 = 16-bit samples, 2/3 = 32-bit), u16, u16, u32 rate, 4 skipped, u32 dataSize, data`.
Duration = samples / rate (format 4 = no duration).

### `.fdu` 0x0700: font
`[preamble] u32 ?, u32 nGlyphs, nGlyphs × { u16 char, u32, u32, u32 } (14 bytes in memory), then the glyph texture`.

### `.xdu` 0x0400 / `.sdu` 0x0305
- `.xdu` 0x400: `[preamble] u16 nChars, nChars × u16` (UTF-16; buffer = n*2+2).
- `.sdu` 0x305: `u32 ?, u32 (+0x74), u32 (+0x70), 4 skipped, u32 compressed`; 0 = raw PCM read straight,
  otherwise `u32 compressedSize` + data, decoded to `n*2` bytes (16-bit) by 0x4E4C30/0x4E4A70.

### `.odu` 0x0103
`u32` (zlib) = total bytes of the package's **parameter memory** (runtime property blocks), allocated before the 0x0102 templates are read.
The loader (0x4609F0) checks the 0x402 version against 0x112 ("Parameter memory is not saved out properly!" otherwise).

### `.lvl` 0x0026: cell tree (fully parsed, 1a = 275,954 bytes, 0 left)
- Header `u32 25, u32 nNodes (1690), u32 a (3607), u32 b (270), u32 c (1850)`; a + b = number of object entries (3877).
- `nNodes` nodes: `u32 kind (0 = cell, 1 = named room, 2 = …), u32 24, u16 parent, u16 firstChild, u16 sibling, 6 f32 box, u32 X, u16 len, name (padded)`.
- Then object entries (42 bytes): `u32 kind (2 = level instance, 3 = geometry piece), u32 table (24 or 25), u32 cell, u16 next, 6 f32 box, u32 id`.
  Kind 2 -> instance id from 0x0020 (Static Object, Decoration, Point Light, Detector, Breakable…).
  Kind 3 -> ids 5199–6827, not instances (static geometry pieces). Table 24 -> instance+0x40, 25 -> instance+0x44 (two independent lists).

### `.lvl` 0x0027: portals and PVS (fully parsed, 3944 bytes)
`u32 nCells (83)`, then per cell: `u32 cellNode (index in 0x0026), u32 n, n × { u32 portalInstance, u16 targetCell (0..82), u16 flags }`
(flags bit 4 = flip the portal plane; instance -1 + flags 2 = special link).
The portal plane comes from the Portal instance transform (0x4BFC00). The node gets `+0x3C = cell index`, `+8 |= 1`.
Then `u32 M (860)` + M × u16: for each cell, `count + list of visible cells` (**PVS**), with offsets stored at cell+0x14.

### `.lvl` 0x0028: edit history (editor only)
`u32 n (= instance count)`, then two tables of n × `{ u64 FILETIME, u16 len, name }`: created by/when and last modified by/when.
1a: 2002-11 … 2003, authors richard (4912), andre, johns, BenC, joe, boyd, Brian, nick.

### `.lvl` 0x0003
4 bytes: 205000 / 255000 / 260000 / 524000 depending on level — probably a memory budget (not read by any loader found).

### `.mdu` 0x0211: render batches (fully parsed: 5267/5267 byte-exact)
`u32 nBatches` (= number of LODs: 1, or 2 for skinned NPCs with 2 LODs in 0x0208), per batch:
- `u32 n, n × u32` **seam duplicates**: low u16 = original vertex, high u16 = the copy appended at the end of 0x0203
  (0x0203 = unique positions first, then the copies needed where UVs split).
- `u32 m, m × (f32 u, f32 v)` **per-vertex UVs** (m = vertex count up to the end of this LOD).
- `u32 k, k × { u32 material, u32 nTriangles, u32 nIdx, nIdx × u16 }` **triangle strips per material**
  (degenerate triangles join strips; indices relative to the LOD's first vertex).
Decoding the strips gives exactly the same triangle set as 0x0204 in 5266/5267 models.

### `.mdu` 0x0208 tail (after the LOD table) — fully parsed, 190/190 byte-exact
- `u32 X` (low u16 small number, high u16 often 10/7/25/28 — meaning open; stored at obj+0x104).
- `u16 nGroups`, nGroups × `{ u32 boneIndex, u16 n, n × u32 mask }`: each listed bone gets a **one-bit mask**
  (1, 2, 4 … 2048), one value per LOD (n = 1 or 2). The bone record (+0x40) points to its group. Most likely body-part bits
  (hit regions / parts that can be hidden), since each bit is unique per bone.
- `3 × f32` distances (×1/2048 → usually 10, 20, 40 units; 25/45/99 on a few): LOD / fade distances of the skinned model.
- **Hit-sphere tree** = the same reader as the 0x0207 collision tree, forced to node type 2 (`mdu_ReadLODList(…, 2)`):
  `u16 nNodes`, if n: `4 × u16` (LOD node ranges: 0, n, n, n), then n × `{ i16 firstChild, i16 nextSibling, f32 cx, cy, cz, r, u32 boneIndex }`.
  The spheres are in bone space and follow the skeleton (root sphere = whole body; children = head, arms, legs…).

### `.mdu` 0x0214: cloth / spring system (only one: NPCs.mdu 19464291)
`9 f32 params` (0.1, 100, 1, 40, 40, 80, 100, 0.6, 1.01), `u32 192, u32 128, u32 96, u32 nSprings (416)`,
`nSprings × { u32 vertexA, u32 vertexB, f32 restLength, u16 flags }` (runtime: min = k·L, max = 2L − min, squared; k = param +0x30),
`u32 nB (128), nB × 15 u32` (vertex + neighbour lists, -1 = none), `u32 nC, nC × u32` (0 here). Reader 0x482880, setup 0x47B7A0.

### `.adu` events and links (Ghidra, animation vtable 0x591650)
- **0x0505 event types.** Only two types occur in the game files (TS1: 1065 × type 1, 478 × type 0):
  - **type 0 = attached resource**: `code` is a resource reference (`package << 16 | index`). The animation makes sure it is
    loaded (vtable +0x20 / +0x24, 0x473E40 / 0x473F00) and fires it at `time` on bone `hash`.
  - **type 1 = marker / message**: `code` is a message id sent to the actor when playback crosses `time`.
    `HasMarker(code)` = vtable +0x60 (0x473930), `GetMarkerTime(code)` = vtable +0x64 (0x473980).
    During playback 0x470500 queues `{type, time, bone, code, anim}` (20 bytes) for every event crossed (bone resolved by hash).
  - Codes seen: 100–117, 150–157, 200–209, 220, 230/231, 400/401, 450–460 (plus 5, 15, 92). In the `.rfl` the actor message handler
    0x6DBE3AB0 has `case 200..205 -> vtable +0x11C` (attack/hit group), 0x1C2 / 0x1C3, 0x9D, 0xE6… The marker ids share the message-id space.
- The trailing `u32 m + m × u32` of 0x0505 = **dependency list** (resource refs preloaded with the animation; obj+0x5C, count +0x64).
- **0x0504** = `u16 n, n × { u32 animRef, f32 }`: every ref points to **another animation of the same package** (64/64), never itself;
  the float is 0, 0.3–0.45 or 0.85–1.2 → most likely the transition / blend time to that animation (consumer not found yet).
- **0x0501** (Ghidra): `[preamble] f32 duration, u32 loop, u32 nBones, f32, f32, 4 skipped`.
- **Root motion** (0x4736C0, after load): if the first track has flag 0x8000 (translation), the engine extrapolates the
  root translation past the last key and stores it at obj+0x3C..0x44 (displacement per loop).

### `.sdu` 0x0305: lip-sync / amplitude envelope (all 3830 parsed)
`u32 compressed (always 0), u32 rate, u32 step (= rate / 25), u32 95, u32 n, n × s16` — one value every 1/25 s
(n ≈ samples / step). If `compressed != 0`: `u32 size` + **zlib** data (0x4E4C30 is zlib `inflate`). Used for mouth movement.

### `.wdu` 0x0060: "Waveform" = generic data curves and raw files
`u32 format, u16 channels, u16 bits, u32 rate (Hz, 20/30 for curves), u32 ?, u32 size, data`.
- format 3 = f32 samples (FX intensity curves, 1–2 channels), 1/2 = integer tables, 0 = bytes.
- format 4 = **raw file**: e.g. `Interface.wdu` holds the **PS2 memory-card save icon** (`u32 1, u32 964, u32 57132`, then `icon.sys` ("PS2D", 964 bytes) + `FolderIcon.ico` = 3D mesh with a 128×128 RLE BGR1555 texture, see §4.4) and the **credits** as a UTF-16 tab-separated table
  ("Company / Department / Title / Names": Surreal Software, Alan Patmore, Stuart Denman, Richard Rouse III…).

### `.fdu` 0x0700: fonts
`u32 size, u32 nPages, per page { u16, u32 size, u32, u32 }` then the font block (0x488F90):
`u32 height, u32 baseline, u32 ?, u32 nTexA, u32 nTexB, (nTexA+nTexB) × u32 texture ref (index | package << 16)`,
`u32, u32 nGlyphs, nGlyphs × { u16 x, u8 width, u8 ? }`, `u32, nGlyphs × { u16 char, u16 glyph }` (character map).

### Ties That Bind `.lvl` 0x0026 / 0x0027 (all 18 TTB levels parse byte-exact)
- 0x0026: 8 extra bytes before the header (`u32 0x2017C` twice, or 0), node = TS1 node + `u32` after the name,
  object entry = TS1 entry + `u32` at the end (46 bytes; almost always 0). Flags field uses more bits (0x18 / 0x98 / 0xD8).
- 0x0027: per cell, after the portals, `u32 m + m × u32` (extra cell list; e.g. a cell with no portals linked to cell 5).
- The first header u32 (20–45, 0 in levels without portals, TS1 and TTB) is not a version — probably a build parameter.

### `.odu` property access at runtime (how to name properties later)
Game code reads template properties through `(**(obj->params + 8))(propIndex, element)` (element -1 = the value itself / array header).
`propIndex` is the property's position in the class **including inherited base-class properties** (indexes up to ~350 for actors).
2013 such calls in the `.rfl`, 156 in the `.exe` (e.g. 0x48FF70 reads 17 properties of a textured effect: 1 = texture ref,
4 = colour, 15/16 = sizes ×2048…). Naming properties = finding, per class, the function that reads its indexes.

### Resource names (stripped) and the editor metadata chunk
- **No resource names survive in the shipped packages** (TS1 and TTB, every `.*du`, `.lvl` and the `.exe` checked). The ids
  (`package:index`, e.g. `2_000d`) are the only identifiers the game uses. The `.db` files only list package dependencies.
- **One leftover proves the original format.** `Interface.tdu` (TS1) still has a single chunk of type **0x0041** next to its 0x0040:
  `u16 len + name` ("GUI_Suffering_MousePointer"), `u16 len + source path` (`\\lion\Unspeakable\Graphics\GUI\HUDs\GUI_Suffering_MousePointer.tga`),
  `8 bytes FILETIME`, `u16 len + author` ("michel"). This is the same "preamble" the `.xdu` / `.ldu` / `.wdu` / `.fdu` / `.adu` readers
  skip outside editor mode. Every resource had one; the build step removed them (5127 TS1 / 4491 TTB textures have only 0x0040).
- Consequences: names must be **derived** (class using the model, level, subtitle text, character skeleton…) or typed by hand;
  writing a 0x0041 chunk back is possible in principle (the format is known) but must be tested in-game first.
- Other game versions (console, demo, pre-release) might still carry these chunks — worth checking if available.

### `.wdu` index tables (unknown consumer)
`System.wdu`, `NPCs.wdu` and `World Common.wdu` also hold integer tables (format 2/4, 400–1600 entries, values slightly above the
entry count, nearly sequential runs such as `0,1,2,3…` or `1440,1441,960…`). They look like **vertex remap tables** between two meshes,
but no model has a matching vertex count, so their consumer is still unknown. TTB ships no `.wdu` at all.

### Instance flags (lvl 0x0020), from lvl_ReadInstance (0x45A5C0) — see RiotTools/Riot/RiotProperties.py
Several bits are "override + value" pairs; without the override bit the value comes from the template object (+0x20).
- 0x1 visible (-> object +0xC bit 0x8000000) · 0x10 extra u32 after the flags (default 0x5F0AC723) · 0x100 scale · 0x8000 own model block.
- **0x1000 = override shadow; 0x400 = casts dynamic shadow** (-> object +8 bit 0x1000000, tested by the shadow manager 0x492A00 / shadow_Render 0x4CD550); 0x800 = second bit of that pair (-> +8 bit 0x2000000, used by animation code; meaning open).
- 0x2000 = override group B: 0x4000 (-> +8 bit 0x80000, skips a per-frame update in 0x46E750) and 0x1000000 (-> +8 bit 0x20000).
- 0x800000 = override group C: 0x400000 (-> +0x10 bit 0x20, read by the cell-tree code 0x4B9650).
- 0x300000 (2-bit field, with 0x10000000) -> +0x10 bits 8 / 0x10 / 0x4000; 0x2000000 -> +0x10 bit 0x400.
- 0x8 together with (0x10000 << n): excluded per variant (difficulty/platform?) — hypothesis.
- 0x80 and 0x200 are very common (about half of all instances) but are not read by lvl_ReadInstance.

### Writing (SurrealEd)
- SRSC layout facts used by the writer (all 405 TS1/TTB files): every chunk offset is a multiple of 8; gaps between chunks
  are zero bytes (0–30); directory order is not file order in 369 files; no overlaps, no trailing bytes. A layout-preserving
  rewrite (keep gaps, pad a replaced chunk to 8) gives byte-identical files and lets any chunk grow or shrink.
- `.lvl` 0x0020 writer: exact inverse of lvl_ReadInstance on all 36 levels.
- Textures (0x0040): in TTB the first u32 of the list at +0x24 is the number of extra mip levels stored after the main one
  (and +0x1C becomes 4/8/16); TS1 stores 2 there and no mips.

## 9t. Cross-reference: "the-suffering-engine" (browser reimplementation, TS1)
A TypeScript/Three.js reimplementation of the TS1 engine (README: "clean-room-style", no licence file in the copy
we saw, so only facts are used here, never its code). Its `docs/re/*.md` and `src/formats/*.ts` cover TS1 in depth and
answer several of our open questions. Checked against the exe where noted.
- **Shadows** (docs/re/renderer.md §4): light raised to 45° (we had it backwards; confirmed in 0x4CC020); colour black
  with alpha 0.66 (0x595B60) × camera fade × receiver fall-off (full near the caster, 0 at the reach); no
  self-shadowing on characters in captures; p14/p15 compare d² against p × 2048²/1000 (read as metres).
- **Point lights:** I = p8 × 2048² (not squared), so in metres level = p8 / d²; cull radius
  R' = √(10 × (0.33 r + 0.45 g + 0.22 b) × p8) (cutoff 0.1 at 0x5BA608); ranking (0.212 r + 0.701 g + 0.087 b) × I/d²;
  at most 8 lights per object, 5 of them point lights; p9 1/2 = point light that lights only above/below (flags 0x400/0x800).
- **STOMP keys** (src/game/world/stomp.ts): 0 transform (flags 0x10 linear / 0x20 Catmull-Rom / 0x40-0xC0 easing /
  0x100-0x400 leave pos/rot/scale / 0x800 constant speed), 1 animation (channel = hardpoint row, clip, start, blend,
  speed, flags = root-motion modes + 0x100 unload + 0x200 layer), 3 sound (ref, volume/10000, 0x10 not positional),
  4 attach, 5 control (0 take / 1 release), 6 visibility, 7 message (id, param, flags), 9 camera (time scale, vertical
  FOV, interpolation), 10 marker. Sequence flags 0x40 cinematic, 0x04 letterbox (Level Properties p36/p37), 0x01 strict,
  0x08 end reset; track flag 0x08 = remove the object at the end. TTB adds types 2 and 8 (still open).
- **.adu header** (0x0501, 28 bytes): f32 duration, u32 flags (bit 0 = plays once, bit 1 = full-rate update), u32 tracks,
  f32 blend time, f32 rate, 2 unread floats. Track format 0xC000 = rotation-only with a constant translation (the track's
  f32[3]), 0x8000 = keyed translations. Event kind 1 message names (rfl table 0x10174658): 100 Arm, 101 Disarm, 102 Fire,
  103 AmmoEject, 108 Equip, 150-157 items, 200-205 footsteps, 206-209 fades, 220 MorphCharacter, 230 ThrowWeapon,
  400/401 interact, 450 SpawnEffect, 451 CapLimb, 454 TriggerSwitch, 455 Emerge, 456/457 vulnerable, 458 Recede, 460 SpawnRat.
  0x0504 links: the blend used when this clip replaces that one.
- **Skeleton trailer** (.mdu 0x0208 after the bones): LOD records, a u32, the channel/hardpoint table
  `u16 n, n × {u32 bone, u16 k, k × u32 bits}`, f32[3] LOD distances, then a bounding-sphere tree.
- **.tdu:** DxtType 3 with AlphaBits 8 is **uncompressed L8** (alpha = L), not DXT5 — only the TS1 mouse pointer
  (Interface 5_0461). SurrealEd now decodes it and always writes DXT5 with AlphaBits 4.
- Also documented there, not yet used here: message maps per class, Switch/Detector logic, damage records, weapons,
  saves (.rsg), front-end (GUI) definitions, footsteps, audio voice limits/reverb, the HDR scene glow and screen effects.

## 9u. Level logic, message maps and other identified systems (SurrealEd tools + cross-check)
**Message system.** A message is a small integer; names come from the table `{char* name, u32 id}` in the .rfl
(TS1 0x6DC74658, 98 names; TTB 157 names, e.g. 1120 IntoRageStart, 310 NPCConversationBegun). `Tools/RiotMessageNames.py`
extracts both into `Riot/RiotMessageNames.json`. A placed object's `links` (lvl 0x0020) are uids of other instances and are
the only message routes (0 dangling links in TS1).
- **Inputs**: each class constructor registers a message map (`PUSH map; CALL [reg+0x34]`). The maps live in .data and are
  filled by C++ static initialisers (TS1: the _initterm table 0x6DC67000..0x6DC673F8, 253 entries). 28-byte records:
  `-1, P, handler` = input slot (the handler runs when the arriving message equals the instance's value of property P),
  `M, -1, handler` = fixed input, `-2, -2, …, parent` = chain to the parent map, `-1, -1` = end.
- **Outputs**: `[dispatcher]->vt[1](own handle, property, sender)` sends that property's message to every link
  (dispatcher global TS1 0x6DC7BF54). Many classes go through "fire" helpers that take the index as an argument.
- `Ghidra/Atlas/RiotMessageMaps.py` replays the initialisers with Unicorn, parses every class map and scans the class
  code (vtable, handlers, 2 call levels, helpers, register-tracked indices). TS1 result: 106 classes with a map;
  inputs and fixed inputs identical to the-suffering-engine's table for all 359 classes; outputs identical for 339
  (the rest: ours adds inherited 15/21/32; theirs adds two hand cases: Mechanism 55-58 and Switch 68/69, fired by the
  Player's code). Same tool on TTB (see `Riot/RiotMessageMaps.json`).
- Inherited maps: GameObject p11 BlowUp, p12 Destroy, p13/p14 invulnerable on/off, output p15 ("Damaged" in NPC
  templates); usable objects (Switch, Light Housing, Ladder, Pushable, Phone…) p28 unlock / p29 lock; Character p26,
  p27, p136, p137. Catch-all receivers: the Message Filters (test, then forward to the links), NPCs (to the behaviour
  stack), Level Transition Msg Handler (cross-level mailbox).
**Property types** (low byte; 0x1000 = list, 0x2000/0x4000 = ref qualifiers): 01 int, 02 float, 03 template ref,
04 model, 05 sound, 07 bool/small enum, 08 signed int (-1 unset), 09 animation, 0A string (.xdu), 0B STOMP sequence,
0E texture, 0F colour, 10 video, 11 enum **or message id**, 12 waveform (.wdu), 13 object link (level uid), 14 font.
**Families** (shared property prefixes): GameObject 0-15 (0 health, 1 max health, 7 attachments), PhysicalObject
0-21, Item 0-54, Character 0-24.
**Instance flags** (lvl_ReadInstance 0x45A5C0): 0x1 shown at start; 0x8 never created (with 0x10000 << difficulty);
0x10 own draw distance f32 (engine units; else the template's, else 70.71 × radius × scale); 0x80 / 0x200 not read
(editor only); 0x100 scale; 0x8000 own model/bounds; 0x1000 override template bits 0/1 with 0x400/0x800; 0x2000
override bits 6/10 with 0x4000/0x1000000; 0x800000 override bit 7 with 0x400000; 0x300000 / 0x10000000 / 0x2000000
object +0x10 bits. Template flags = u32 at template data +4.
**Sound header** (0x0302): +0 category (0 Effect, 1 Ambient, 2 Music, 3 Movie, 4 GUI, 5 GUI FX, 6 Dialog), +4 volume
×0.0001 (linear), +8 flags (0x8 loop), +0xC priority = (value >> 4) & 0xF, +0x10 random pitch variation %, +0x14/+0x18
min/max distance (model units, ×2048 in engine), +0x24 subtitle, +0x28 rumble. Stereo sounds are never 3D.
**Lip-sync**: 0x0305 envelope = 25 u16 frames per second, 0..0x7FFF; the jaw bone hash 0x30CB6F7D (child of head
0x07C159A2); Character p118/p119/p120 = jaw bone index / max angle / axis (Player p124-p126).
**Visibility** (.lvl): 0x0026 sector tree (5-u32 header; records {kind 0 split / 1 named group / 2 object leaf / 3 floor
leaf, flags, u16 parent/firstChild/nextSibling, f32 max[3], min[3], u32 id, name}); 0x0027 zone graph (zones = named
groups, portal links with flag 4 = side, 0xFFFFFFFF + flag 2 = open adjacency, then per-zone visibility lists).
Portal (engine class 0x5B0BAD74): p0 starts closed, p3 occlusion template, p4 linked door, p5/p6 open/close inputs.
**Skeleton trailer** (.mdu 0x0208): LOD records, u32, channel (hardpoint) table, f32[3] LOD distances, sphere tree.
**Not yet used by SurrealEd** but documented there: saves (.rsg chunk stream), GUI/HUD templates (Interface.odu,
root = User Interface Properties 0xA3165141), weapons and damage records, AI behaviours, insanity, footsteps, reverb.

## 10. Open questions (updated after the Ghidra pass)

- `.mdu`: meaning of the 0x0208 `X` field and of the group bits; the 0x0214 params and its 15-u32 records.
- `.tdu`: flags 0x2 / 0x8 / 0x200000 / 0x1000000, the f32 (256.0) and the trailing u32 list (`2, 1, 0`).
- `.adu`: what each marker code (100…460) does in the actor code; consumer of 0x0504 (blend time is a hypothesis).
- `.qdu`: executors of each event type (what every field does at runtime); TTB new event types.
- `.sdu`: the constant 95 in 0x0305.
- `.odu`: 0x0102 properties are known by layout but many property *names/meanings* need the `.rfl` (hashed names).
- `.ldu`: what the "owner" u32 points to (instance/model + LOD?) and how sets map to model LODs.
- `.xdu`: done. `.wdu`: who uses the integer index tables. `.fdu`: a few u32 in the font block and the second glyph byte.
- `.vdu`: no files in TS1; `.gdu`: none shipped.
- `.lvl`: 0x0003 value (memory budget?), the 0x0026 "24/25" table split and kind-3 ids, the X u32 of each node; 0x0001 terrain leftovers.
- Resource names: look for 0x0041 chunks in other versions of the game.
- Debug menu on PC; remaining Sky / Level Properties fields (needs `.rfl`).

## 11. References

- XeNTaX wiki — Surreal Software Archive (Riot Engine): https://wiki.xentax.spektr.name/index.php/Surreal_Software_Archive_(Riot_Engine)
- ResHax — The Suffering / Ties That Bind thread: https://reshax.com/topic/19095-the-suffering-and-the-suffering-ties-that-bind-riot-engine-from-the-early-2000s-sdu_mdlfile-tdufile/
- OpenDrakan (recreation of the older Riot Engine): https://github.com/Zalasus/opendrakan — see `doc/lvl_format.txt` (level objects and **layers**: zlib-compressed vertex grid with height offsets and per-face texture refs/UVs), `doc/riot_database_format.txt`, `src/odCore/ObjectRecord.cpp` (rotation), `src/dragonRfl/classes/StompPlayer.cpp`
- Postmortem: The Game Design of Surreal's The Suffering (Game Developer): https://www.gamedeveloper.com/design/postmortem-the-game-design-of-surreal-s-i-the-suffering-i-

## 12. Tool plan (decided, not built yet)

- **Goal:** a distributable editor ("SurrealEd" in the Figma draft) whose scripts sit in the **game's root folder** and read/write the
  real files directly (no pre-converted data). Detects TS1 / TTB from the `.exe`.
- **Scope:** **replace** existing resources first (textures, audio, then level objects, STOMP, models); adding new resources later.
  Replacement keeps the original's "contract": same size/compression for textures, same skeleton (bone hashes) for characters,
  same markers for animations.
- **Architecture:** local Python server (no external libraries) + browser UI with the existing 3D viewport.
  Writes always back up the original first and can be undone; warns if the game is running.
- **Modules (CamelCase, also for functions and variables):** RiotContainer, RiotPackages, RiotNames, RiotTextures, RiotModels,
  RiotCollision, RiotAnimation, RiotAudio, RiotWaveform, RiotStrings, RiotFonts, RiotTemplates, RiotClasses, RiotLighting,
  RiotLevel, RiotSTOMP, RiotVideo, RiotRendering, RiotServer, RiotBackup, RiotEditor.
- **Rules:** each module documents its format (fields, confirmed vs hypothesis, exe addresses); every format has Read and Write;
  a round-trip test re-writes every game file and compares byte for byte. Documentation in **Portuguese and English**. License: **MIT**.
- **Figma draft tabs:** Level, Textures (with R/G/B/A channel toggles), Models (info + Textured / No texture / Wireframe / Normals),
  Animation, Audio, STOMP / Cutscenes, Video; right panel = file select + list + Export / Import.
  Suggested changes: merge STOMP and Cutscenes, remove the duplicated Audio tab, add Strings (`.xdu`) and Templates (`.odu`);
  TS1 has no `.vdu`; textures are DXT1 / DXT5 / 8-bit paletted (no DXT3).


### 9s. Sounds, STOMP sequences and videos (formats used by the Audio / STOMP / Video tabs)
- **.sdu** (reader 0x43D8E0): 0x0302 header (60 bytes) = u32 ?, u32 volume 0–10000, u32 flags (0x8 = loop), u32 priority,
  f ?, f min distance, f max distance (raw, not ÷2048), f, f, u32 TTB subtitle (u16 index, u16 .xdu package), u32,
  u16 channels, u16 bits, u32 rate, u32 bytes. 0x0303 = signed PCM. 0x0305 = mouth envelope: u32 compressed, rate, step,
  ?, count, then s16 values (zlib if compressed), 25 per second. TS1 subtitle: "Line of Dialog" template (0xCC015D52) at the
  same index, p2 = text refs.
- **.qdu** (reader 0x44BFD0): 0x0311 = header + tracks; each track = name, level instance id, events. Event types:
  0 transform (quat, position, flags (0 = cut), scale; TTB has 3 extra floats), 1 animation (.adu ref), 3 sound / line,
  9 FOV, 2/4–8/10 other commands (open). The sound ref may point to a package with no .sdu (e.g. FX templates).
  The level is found by matching track object ids against the levels in the same folder.
- **.vdu**: 0x0342 (76 bytes) = version, fps, duration ms, width, height, bpp, block table; 0x0343 = ASF/WMV2 with the simple
  index moved to the front; moving it back gives a normal .wmv.

- **Which model uses which animation.** Bone hashes are not enough: many characters share one skeleton (TTB: one
  skeleton is shared by 63 models). The real link is in the data: model-bearing templates → behaviour templates →
  animation refs, plus instance property overrides in the .lvl and STOMP animation events (track → instance → model).
  SurrealEd follows those refs (not entering another skinned model's template) and keeps an animation only when the
  model has >= 80% of its bones. TTB NPCs: 1482 of 1884 animations get a user this way; TS1 NPCs: 488 of 673.

### 9r. Effects (FX): how they work (TS1, Ghidra on Suffering.rfl + Suffering.exe)

**General**
- No effect file format exists: an effect is an object (`.odu` template, `.rfl` class) whose properties drive engine code. FX.odu (TS1) is 419 Particle Fountain, 319 Object Generator, 198 BouncingObject, 93 Screen Fader, 68 Electric Arc Effect…; TTB adds Particle System - Simple/Complex and Event Manager/Entry.
- Composite effects are chains of references, e.g. Electric Arc Effect → Electric Arc (bolt model) + Object Generator (sparks).
- Property types: **0x000E = texture ref**, **0x0005 = any resource ref** (sound, model…), 0x0015 = float (TTB).

**Particle Fountain** (class 0x7EA6E450). The `.rfl` class sets up an engine emitter; the `.exe` simulates the particles.
- `.rfl` methods: Init FUN_6DC1A870, setup FUN_6DC19FC0, emitter update at vtable slot 6 = 0x6DC1AB10, particle-hit callback at slot 9 = 0x6DC1C0A0. The last two are not defined as functions in a default Ghidra analysis, which is why the property scan missed them.
- **Simple vs full mode.** Bit 2 of object+0x98 selects a "simple" sprite path (vtable +0xD4) when all of these are 0 / equal: P32, P48, P2, P31, P49, P39, P43∈{0,1}, start colour = end colour or P35 = 0, at most 1 texture, P45 < 1. Otherwise the full particle system is used (vtable +0xD0).
- **Engine emitter** (vtable 0x5945EC, manager update FUN_004ACFA0, per-particle step FUN_004AC1E0).
  - Fields: +0x58 size growth/s (P39), +0x5C wind scale (P44), +0x64/+0x68 fade-out time and 1/time (P41), +0x6C/+0x70 fade-in (P42), +0x74 gravity scale (P43), +0x78 rotation (P49 in radians), +0xE0 flags, +0xE4 texture (P36[0]).
  - Flags: 0x2 gravity, 0x20/0x40/0x800000 blend from P46 = 1/2/3, 0x100 wind, 0x200 P47, 0x400 limited duration (P10 > 0), 0x4000 fade-in, 0x8000 slow down over life (P2), 0x40000 rotation (P49), 0x80000 drag ×0.95/frame (P48 = 1), 0x200000 P25.
- **Per particle:** position +8, velocity +0x14/+0x20, ARGB +0x30 (alpha = fade in/out), size +0x34, birth +0x38, death +0x3C.
- **Emission** (0x6DC1AB10):
  - Rate is accumulated in +0x80; direction comes from the owner's axis P23 (0/1/2), spread P8 (degrees), speed P3 × random.
  - Size is random in P37…P38 × P1 × 2048, with a random texture from array P36.
  - Lifetime P40, colour P33 → P34 (P35 = lerp over life), P0 = emit from the model surface.
  - P4/P5 are the emitter's start angles, rotated each frame by P6/P7. P9 spins the owner object (degrees/s).
- **Activity:** P10 = emission duration (0 = forever), P14 = starts on, P12/P13 = start/loop sound (P11 probably volume), P15 = attach to the owner's bone.
- **Distance:** P26–P30 control emission versus distance to the camera (P30 × 2048 = max distance).
- **Damage** (callback): P18 damage per second, P19 type, P20 force (?), P21 effect applied to whatever is hit (BurnFX, class 0x7B6FE5DB).

**Fire** (0x1D84210F)
- The fire grows from scale P3/P4/P5 to P6/P7/P8 (x/y/z) over a timer; P11→P12 is a second value animated the same way (intensity?).
- P0 = starts lit, P19 = repeat (0 = removed at the end).
- Damage on touch: P16/P17, plus P18 = BurnFX applied.

**Screen Fader** (0x21C015A3)
- State machine: fade-in P0 s → hold P1 s → fade-out P2 s; P8 = max opacity, P7 = colour.
- P3 = starts on, P4 = remove at the end, P6 = screen texture (type 0x000E), P9 = extra resource, P10 = stage that fires an event.

**Camera Shake** (0x6506A1BA)
- P2 = duration; amplitude = P4 × 2048 scaled by distance falloff up to P5 × 2048.

**Object Generator** (0xBE08B1A0)
- **Spawn list:** P0 = object list, P1 = count per object (must be the same size: "Generator Multiples List is not the same size as object list!"), P23 = max alive.
- **Orientation:** P10/P11/P12 = fixed tilt/turn/roll (degrees). If P16 ≠ 0, the object is launched at a random angle in a cone P15…P16 (degrees) around a random spin, pushed forward P17. P20/P19 = random spin ± and its axis, P18 = align to direction.
- **Control:** P21 = interval (0 = all at once?), P24 = starts on, P25 = Follower object, P27 = use the owner's orientation.
- **Distance:** P28 × 2048 = max distance to the player; P29/P30 = vertical limits.
- The spawned class picks the setup path: 0xBE08B1A0 nested generator, 0x16AB1B0C, 0x5A410DDE, 0x7EA6E450 Particle Fountain, Missile 0xFD73BAB8 / 0xEB13B226…

**Other**
- These names now appear in the editor's Properties panel (RiotProperties.py, "(?)" = probable).
- RiotPropertyReads.py now also takes reads whose arguments the decompiler did not bind (3865 reads in Suffering.rfl, up from 2991).
- Not done yet: TTB Particle System - Simple/Complex, Electric Arc, Volumetric Fog, BurnFX, MorphingModel.

### 9q. Terrain splat blending (how the game blends ground textures)
- The per-layer block after the layer name (`u32 ref` + `5 × u32` + chunks) is the **splat** data, not water:
  - `ref` = **base texture** in the level's `_level.tdu` (a pre-rendered atlas of the whole floor, e.g. 1a uses 11_0002…11_000f, 64 or 128 px).
  - `5 × u32` = `Size, X0, X1, Y0, Y1`: the layer's rectangle in that atlas, 4 px per cell. Base UV = `(X0 + 0.5 + col·(X1−X0)/W) / Size`, `(Y0 + 0.5 + row·(Y1−Y0)/H) / Size`.
  - Each chunk = `x0, x1, z0, z1` (cells), `m` landscape materials, and a grid of `gx × gy × m` bytes: **one byte per vertex per material**.
    Bit 0x10 means the face whose top-left corner is this vertex receives the material. Bits 0–2 give the vertex alpha level, from the table `[0, 0.8, 0.9, 0.95, 1]` (0x58C… stack table in FUN_004A4A80).
- Rendering (FUN_004994F0, `xvsLandsplatAlpha.vsh`):
  - Pass 0 draws the base atlas.
  - Then one alpha-blended pass is drawn per material. Its texture is projected from above (`u = x / prop 4`, prop 4 = tile size in cells). Its alpha is `vertex alpha × (1 − (depth / fade)²)`, with fade = landscape material **prop 7** × 2048 (20–30 units).
  - Far away, only the blurry base atlas is left. Debug options 90 "Splat Base Only" and 91 "Splat Disable Noise" switch this off; a noise term (FUN_004D4F10) modulates the alpha at build time (not reproduced).
- Layers without the block (`ref = 0`) use the old per-face material + UVs.
- The editor (RiotRendering._SplatGroups) now draws terrain this way; TTB has few splat layers (most TTB ground is model geometry).

### 9p. Properties → code (Suffering.rfl, TS1)

- **Create function** `0x6DC285B0` is reached through the vtable of the object returned by `GetBaseRFLInterface` (vtable `0x6DC599DC`, slot 2), as `Create(EngineObject, ClassId)`. It is a big compare tree on the class hash. Each branch does `new(size)` (`0x6DB06400`) and then calls the class constructor. Emulating it for every hash gives the class → constructor map: 325 of 359 classes.
  - 104 classes return the shared dummy `0x6DB0B370` (→ `&DAT_6DC7A67C`). These are **data-only classes** (Attack, Combinable, "... Interaction Properties", HUD meters…), whose properties are read by other objects through references.
- **Constructor → vtable:** the last `MOV [reg], vtable` in the constructor. 221 classes have one.
- **Message maps:** the constructor pushes a static table (e.g. `0x6DC69588`) to `[[this+4]]+0x34`. Static initializers fill that table with handler pointers at runtime. Vtable **slot 70** is the message handler (`0x6DBE3AB0` and others).
- **Property set:** `[[this+4]+0xF0]` (TTB: `+0xEC`) → vtable+8 = `Get(N, Element)`, which returns a pointer to the value. Use after the call: `FLD` → float (68 of 70 direct reads land on type 0x0002); `TEST [EAX],0xFFFF0000` → array.
- **Result:** 1721 class/property pairs (about 830 of the 2991 reads) are tied to a class, with no read out of range in direct methods. Browsable in RiotPropertyAtlas.html and in Suffering_ClassProperties.csv. Property names still do not exist in any file; the meaning has to be read from the code snippets.
- **TTB:** `GetBaseRFLInterface` returns a statically initialized object (`0x01A4DED0` → vtable `0x01A36E2C`). Create is slot 2 = `0x019FF720`, new = `0x018A1930`. The sections have unusual names (`.sforce3`, `.brick`…), and code and vtables share the same block. Many vtables start with a pointer to a label that is not a defined function. Results: 357 of 394 classes have a constructor and 238 have a vtable. 1729 class/property pairs in 123 classes are tied to a class. 83 behaviors share the generic constructor `0x019FA710`, and 119 data-only classes share the dummy `0x01A0A280`.

## 9v. Animated materials and adding/removing level objects (SurrealEd)

**Animated materials** (facts cross-checked with the-suffering-engine; reader written here, `Riot/RiotWaveforms.py`):
- Animating Material 0xD58D8E2C: p1 = list of frame textures, p2 = frames per second (float; 0 -> 15), p4 = blend mode.
  Frame = floor(t × fps) mod n.
- Advanced Material 0x7E3AD512 with mesh UVs (p11 = 0): p6 UV scale, p7/p8 U/V offset, p9 UV-scale waveform (unused in
  both games), p10 UV-scroll waveform. coords = uv × p6 + (p7, p8) + scroll(fmod(t, duration)).
- `.wdu` 0x0060: u32 element type (0 int8, 1 int16, 2 int32, 3 float; 4 = not a curve), u16 channels, u32 rate at +8,
  u32 byte count at +16, samples from +20 interleaved; integers normalised (/127, /32767, /2^31); duration =
  samples / rate; linear interpolation, looped.
- Counts: TS1 44 Animating Materials with > 1 frame and 183 Advanced Materials with a scroll ref; TTB 75 and 68.

**0x0026 as an index space** (verified on all 36 levels; `Riot/RiotLevelEdit.py` rewrites them byte for byte):
- Nodes and leaves share one 1-based index G: node n -> G = n + 1, leaf j -> G = 1 + nNodes + j; 0 = none.
- Pointers in that space: node parent/child/sibling (u16 at +8/+10/+12), leaf cell (u32 at +8 = parent node G), leaf
  next (u16 at +12), and in TTB the leaf's last u32 (+42) = another leaf of the same object (objects spanning cells).
- Every leaf hangs from exactly one parent's child list. Node u32 at +38 is not a pointer (values exceed the space).
- Header a/b = sizes of the two leaf blocks. Block 1 = objects (FUN_004B9840 stores the leaf in object +0x40), block 2
  = Point/Directional/Ambient Lights (object +0x44). Light leaves have an empty box (max = -FLT_MAX, min = +FLT_MAX).
- 0x0028 has one "created" and one "changed" row per instance, in instance order (counts match on every level).
- SurrealEd's copy: new id above every id used by the levels in the same folder; record copied from the source;
  leaf copied with its box moved, first child of the deepest node containing the new position (ancestor boxes grown);
  inserting at the end of block 1 shifts every pointer into block 2 by +1. Deleting refuses while referenced.
- Not verified in game yet: whether the engine needs anything else for a new object (e.g. header c of 0x0026).

## 9w. Rendering fixes from in-game comparison (SurrealEd)

- **Instance flag 0x8**: lvl_ReadInstance (TS1 0x45A5C0, TTB 0x4604A0) creates the object only when
  `Flags & (0x10000 << difficulty | 8)` is zero. 0x8 objects (TTB 2967, TS1 603; e.g. 05_Prison_Admissions #5266, a
  ceiling whose scale equals its own model's size, and duplicate facades in 09A) are not created at level start;
  the editor hides them (toggle "Objects not created at start").
- **Tinted passes**: Advanced Material p3 = tint on, p4 = tint colour; Animating Material p5/p6. A tinted pass is
  unlit: TFACTOR = tint / 2 and texture stage 1 doubles it, so pixel = texture × tint. TS1 1a's Electric Shields
  (Advanced, add, tint 0x1A1A1C) were drawn full-white without it.
- **Every other pass is vertex-lit**, additive and other blended ones included.
- **Unbaked geometry** (no .ldu record or a missing one: 09A has 26 Static Objects whose tail points at a record not in
  the .ldu): L = ambient + Σ directional · max(N·L, 0) (+ point lights). Ambient Light (0x7578F3F7) and Directional
  Light (0x6B110672) colour = property 0; the directional light travels along the object's -Z. Regions are not
  decoded, so the editor takes the nearest of each.
- **TTB Point Lights** are tiny models inside their housings; SurrealEd draws a clickable icon per light (within 25 m).

**TTB `.wdu` 0x0060 layout** (differs from TS1): f32 duration, u16 channels, u16 element type (same codes), u32 flags
(0x100), u32 byte count, samples from +16. The samples span the duration end to end: rate = (n − 1) / duration
(81 samples over 2.667 s = 30/s; 319 over 53 s = 6/s; 350 over 69.8 s = 5/s). SurrealEd detects the layout by the
first u32 (TS1 element type 0..4 versus a float).

**Sky (SurrealEd):** Sky / Sun (p0 shown, p4/p5 On/Off inputs, p6 = 1 dome) layers are placed relative to the dome
and drawn around the camera before the level. The dome texture is a placeholder the game rewrites from the Sky
Properties (Suffering.rfl 0x1012AD70): round(p6 × 448) texels of p4, p7 × 448 blending to p5, then p5 (facts from
the-suffering-engine). 10 Docks has two domes. TTB levels place their sky layers as own-model instances without a dome.



## 9x. Particle effects (SurrealEd)

PT: O editor simula os emissores no navegador (Editor/RiotParticles.js) a partir de parâmetros normalizados que o
servidor monta (Riot/RiotEffects.py, tabela completa no cabeçalho). Cor do passe = saturate(2 × textura × cor) em gama;
sem colisão com o chão; tamanho = metade da largura do quadrado.
EN: The editor simulates emitters in the browser from normalised parameters built by the server (table in the
RiotEffects.py header). Pass colour = saturate(2 × texture × colour) in gamma space; no ground collision; size = half width.

- TS1 Particle Fountain: meanings as documented by the-suffering-engine (facts only, our own code). A placed fountain
  only emits at level start when p14 ≠ 0; the rest wait for an On message (p50).
- TS1 Object Generator: only entries that are Particle Fountain templates are previewed, fired every p7 ± p8 s at the
  generator's own matrix (the p9..p20 spawn shaping is not applied yet).
- TTB Particle System - Simple (class 0x607B301C), **inferred** from SufferingTTB.rfl FUN_019aca80 (setup),
  FUN_019a5440 (start), FUN_019ad0b0 (update) and the value statistics: p0 emission time, p2 on at start, p9 rate,
  p10 cone (deg), p18/p19 LOD, p31 + p32 lifetime, p33 → p34 start/end size (setup stores p34 − p33), p35 ± p36 speed,
  p38 textures, p39 colour, p40 blend (1 add / 2 sub / 3 lit / 0 alpha), p46 gravity factor, p48/p49 start rotation,
  p50/p51 spin, p56/p57 fade in/out as fractions of the lifetime, p58 flipbook (p60 grid 1/4/16/64/256, p61 frames,
  p62 first frame, p59 fps), p67 → p68..p69 random scale. Emission axis = object +Z. Open: p12..p15, p16, p47.
- TTB Billboard Light Cone (engine class 0x6375DE85, **from code**: SufferingTTB.exe factory 0x4F39B0 → ctor 0x4B0F40,
  setup 0x4B0C90, geometry 0x4B60E0, colours 0x4B56A0, draw 0x4B5990): p0 axis (p0 % 3 = matrix column x/y/z; p0 <= 2
  points to the negative side), p1 length, p2 → p3 start → end radius (min 0.025), p5 texture, p6 blend mode (TTB
  material table), p7 colour, p8 opacity, p9 falloff exponent (alpha = (1 − t^p9) × p8 × 255; p9 = 0 → no falloff).
  Billboards sit along the axis at steps of 2/3 of the local radius (t normalised so the last one is at 1), half width =
  local radius; near the camera alpha × (depth − 0.15625) / (0.75 × radius). p4 and p10 (fader) not used by the preview.
  Small open point: the sample count is taken from the counting loop at 0x4B6159..0x4B61CC.
- Not drawn yet: Fire, Volumetric Fog/Rain, DripMorphingModel, Particle System - Complex/Group, TTB Object Generator.
