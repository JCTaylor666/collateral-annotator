# 数据格式 —— 完整说明

[English](data-format.md) · **中文** · [返回 README](../README.zh-CN.md)

给人或 AI agent 用的完整说明:怎样准备一个本标注工具能打开的数据文件夹。应用里 **Help → Data format… → Copy for an AI agent** 有它自己的一份写法,跟着你正在用的应用版本走;两份是分别写的,其中「恢复文件、冲突、更高版本格式」这几段逐字相同。从 DICOM 生成这样的文件夹,最简单的是用 [准备数据页面](https://jctaylor666.github.io/collateral-annotator/prepare.html)。

下面是一段**完整自包含**的规格，把它整段复制给任意 AI agent（无需任何背景），它就能生成一份本工具可以直接打开的数据集。内容涵盖：这个工具是干什么的、**每一个**输入/输出文件的格式、以及如何一步步准备数据。

规格正文保持**英文**。app 里「数据组织格式… → 复制给 AI」那一份措辞不同、随安装的版本走;两处不一致时,以 app 里的为准。

<details>
<summary><b>点开展开完整规格</b></summary>


````text
You are preparing an on-disk dataset for "Collateral Annotator", a browser tool
that labels leptomeningeal-collateral vessel segments on DSA (digital subtraction
angiography) frames. This message is a COMPLETE, self-contained specification.
Assume NO prior context. Follow it exactly.

========================================
WHAT THE TOOL DOES
========================================
The reviewer opens a local folder in Chrome or Edge (File System Access API; no
server, no install, nothing uploaded). For each DSA frame it shows the image with
your vessel segmentation on top. The reviewer then:
  - CLICKS a pre-segmented vessel segment to mark it as collateral (the segment
    is looked up in label.npy at the cursor);
  - PAINTS free-form regions with a brush that can be constrained to the vessel
    mask;
  - filters the visible segments by any per-segment metric you supply (radius,
    length, ...);
  - writes notes and numbered markers.
Everything is saved straight back into the same folder as JSON. Your job is to
produce the INPUT files; the tool produces the OUTPUT files.

========================================
FOLDER STRUCTURE
========================================
<root>/                              <- the folder the reviewer opens
  classes.json                       INPUT + OUTPUT (ship one; the tool updates it)
  .annotator_dataset.json            OUTPUT, hidden. Do not create one.
  <case folder>/                     one per case/sequence
    <unit folder>/                   one per frame; plus optional "minip"
      frames.png                     INPUT, required
      label.npy                      INPUT, required
      mask.npy                       INPUT, optional
      geometry.json                  INPUT + OUTPUT, optional
      annotation.json                OUTPUT (you MAY pre-fill it; see below)
      note.json                      OUTPUT
      annotation.json.corrupt        OUTPUT, recovery only
      note.json.corrupt              OUTPUT, recovery only
      annotation.unsaved-backup.json OUTPUT, recovery only
      note.unsaved-backup.json       OUTPUT, recovery only
      annotation.external-backup.json OUTPUT, recovery only
      note.external-backup.json      OUTPUT, recovery only
      note.unread-backup.json        OUTPUT, recovery only

Do NOT create a "perfusion" folder. The tool appends one computed, view-only
"perfusion" unit to every case, after minip. It has no files on disk, no label,
no mask and no geometry, and can never be annotated.

========================================
FOLDER NAMING & ORDERING
========================================
- A folder is a case (and, inside it, a unit) if its name CARRIES A NUMBER:
  pure digits, a trailing _<digits>, or a leading <digits>_. The rest of the name
  is free. Valid: case_0001, frame_3, 12_patient, 0_scan, 7. INVALID: "s0", "f1",
  "minip_left" -- these are SKIPPED IN SILENCE and never appear in the UI.
- A unit folder named exactly "minip" is also loaded and always sorts last.
- Units sort by their number (frame_2 before frame_10); cases sort by theirs.
  Numbers need NOT start at any particular value and need NOT be contiguous.
- Hidden folders (leading "."), folders with no number, and loose files are
  ignored.

========================================
COORDINATE CONVENTION (CRITICAL)
========================================
- Origin top-left. x = column index (0 = left). y = row index (0 = top).
- Everything is H rows by W columns. Flat index = y*W + x. NumPy shape = (H, W),
  so H = shape[0], W = shape[1].
- frames.png, label.npy and mask.npy (if present) MUST have EXACTLY the same W
  and H. If they disagree, that frame becomes a grey read-only placeholder.

========================================
INPUT FILES -- WHAT YOU PRODUCE
========================================
frames.png   (required)
  Grayscale PNG of the DSA frame, W x H. The tool reads the RED channel as the
  raw 0-255 gray value for contrast windowing and the inspect loupe. Save 8-bit
  grayscale ("L"); do not save 16-bit.

label.npy   (required) -- the segmentation, split into segments
  NumPy 2-D array, shape (H, W), C-order, little-endian. dtype uint16 preferred
  (uint8 / int32 / uint32 also accepted). fortran_order=True is REJECTED.
  Pixel value 0 = background; 1..N = segment id. Ids are PER FRAME and do not
  correspond across frames. Clicking selects the id under the cursor, so the
  granularity of this file IS the granularity of the annotation: one id per
  vessel branch is usually what you want, not one id per connected tree.

mask.npy   (optional)
  2-D (H, W) uint8 of 0/1: the vessel foreground. Drawn as the blue overlay and
  used to constrain the brush when "Foreground only" is on. If absent there is
  simply no overlay and nothing constrains the brush (paint lands wherever you
  drag). If PRESENT and readable it must match W x H exactly -- a
  wrong-shaped mask triggers the grey placeholder rather than being ignored. A
  mask that cannot be parsed at all (truncated, not 2-D) does NOT: the frame
  stays annotatable and shows a warning, with the overlay and "Foreground only"
  off for it.
  Normally mask == (label > 0).

geometry.json   (optional; the tool changes only "filter")
  { "segments": { "1":  { "radius_px": 2.0, "length_px": 40.0 },
                  "12": { "radius_px": 16.0, "length_px": 12.0 } },
    "filter":   { "metric": "radius_px", "min": 4.8, "max": 15.4 } }
  - "segments" is keyed by the label id AS A STRING; background 0 is excluded.
    Each value is an object of NAMED NUMERIC METRICS -- any names, any number of
    them. This drives the "Segment geometry" panel: pick a metric, see count /
    min / max / mean / median, and filter the display by a range.
  - "filter" is the reviewer's saved window; the tool rewrites it whenever the
    sliders move. Set it at generation time to the first metric's full range.
  - Everything else in the file is kept: the tool reads the file again right
    before it writes, sets "filter" and writes the rest back as it read it then
    (as re-formatted JSON, not byte for byte). A file that cannot be read at that
    moment, or is no longer a JSON object, is not written.

classes.json   (at the root -- SHIP THIS)
  { "classes": [ { "index": 1, "name": "Collateral" } ] }
  "index" is the number stored in annotations; "name" is the display name.
  Colors are NOT stored here. IF THIS FILE IS MISSING the tool invents a RANDOM
  name for every class index it finds and writes a new classes.json -- two copies
  of one dataset then disagree on class names. Always ship it.

========================================
OUTPUT FILES -- WHAT THE TOOL WRITES
========================================
annotation.json   (schema 5; you may pre-fill it, see "PRE-FILLING")
  { "schema_version": 5, "case": "case_0001", "unit": "frame_0",
    "image_size": [W, H], "coord_order": "xy",
    "collaterals": [ { "id": 12, "click": [321, 187], "class": 2 } ],
    "points":      [ { "click": [40, 500], "class": 1 } ],
    "starred": true,
    "paint": { "encoding": "rle_rows_v1",
               "width": W, "height": H,
               "classes": { "2": [[10, 40, 12], [11, 39, 14]] } } }
  - collaterals -- one entry per SELECTED SEGMENT. "id" is the label.npy id;
    "click" is where the reviewer clicked; "class" is omitted when unclassified.
    NOTE: the shape is NOT stored -- it is resolved from label.npy at display
    time. See "SEGMENT IDS ARE NOT STABLE".
  - points -- clicks that hit background (id 0), same click/class shape.
  - coord_order -- "xy" => click = [x, y]; "yx" => click = [y, x]. It applies to
    collaterals[].click and points[].click ONLY, NEVER to paint.
  - paint -- the brush layer, row run-length encoded. classes maps class index
    (as a string, must be >= 1) to a list of runs [row, col, length]:
    row = y from the top, col = x of the run start, length = consecutive pixels
    toward +x. width/height are the dimensions it was encoded at.
  - starred -- present only when true.

schema 6 (layers). A frame may hold several independent layers. With ONE layer
the file stays flat schema 5 exactly as above. With TWO OR MORE, the per-layer
content moves into a "layers" array:
  { "schema_version": 6, "case": ..., "unit": ..., "image_size": [W, H],
    "coord_order": "xy", "active_layer": 1,
    "layers": [ { "id": 0, "name": "Layer 1", "collaterals": [...],
                  "points": [...], "paint": {...} },
                { "id": 1, "name": "Veins", "collaterals": [], "points": [] } ] }
  Frame-level fields (starred, note.json) are NOT layered. Deleting down to one
  layer makes the next save collapse back to flat schema 5.

note.json
  { "schema_version": 1, "coord_order": "xy", "text": "free-text note",
    "markers": [ { "id": 1, "click": [321, 187] } ] }

.annotator_dataset.json  (root, hidden)
  { "id": "d3f1a2..." } -- created on first open. In-browser progress (unsaved
  work included) is filed per FOLDER: under this id the first time a folder is
  opened, and by the folder itself from then on -- the browser remembers which
  folder it was. While the browser has that record, a copy of the folder, which
  carries the same file, does not get the original's unsaved work; a folder
  that was moved or renamed is a new folder to the browser. (A folder replaced,
  at the same place and under the same name, by a copy of itself cannot be told
  from the original; and a folder exchanged for ANOTHER dataset while it is
  open is noticed when it is opened again -- open a folder again after
  replacing it.) Unsaved work that comes back without that record -- left by an
  older version of the app, or kept while the record could not be read or
  written -- is compared with the folder as soon as its frame is read. Where it
  says what the folder already holds, nothing is asked, and the next save
  writes nothing: the frame then counts as saved. Where it differs, it is shown
  and asked about at once, and nothing of it is written before the answer.
  (Work done on such a frame before answering goes on top of it: the browser
  then holds the result, not the work as it came back.) A file that is there
  but cannot be read just now: a folder the browser has not seen is not opened
  then (try again). A damaged file, or one that cannot be created: the folder's
  name stands in for the id. Safe to delete (resets browser state only) and
  safe to omit from an archive.

RECOVERY FILES -- written by the tool only when something needs protecting.
Never create them yourself; nothing reads them back automatically. The app can
show and RESTORE them (opening the frame offers a "View" banner; restoring is a
swap: the version it replaces is first written to a free backup name).
  annotation.json.corrupt / note.json.corrupt / classes.json.corrupt (the last
    one at the root) -- a file that cannot be parsed, or that this version can
    take over only in part, is copied here, byte for byte, before a save
    rewrites it.
  annotation.unsaved-backup.json / note.unsaved-backup.json -- the session's
    side of a resolved conflict (the folder's version was kept).
  annotation.external-backup.json / note.external-backup.json -- the folder's
    side of a resolved conflict (the session's version was kept): the file as it
    was, byte for byte.
  note.unread-backup.json -- the folder held a note.json this session never
    managed to READ (a Drive or permission hiccup) and a note was then written;
    the unread original is kept here first. It is not a damaged file.
  A backup name that already holds DIFFERENT content is never written over: the
  copy goes to ...-2, and so on up to -9; when all nine are taken, the operation
  is refused instead.
CONFLICTS -- decided by CONTENT, not by file time. When a frame's file no longer
holds what the session last read or wrote, and the session has unsaved work on
that frame, nothing is resolved automatically: the frame is write-protected and
opening it shows a two-version chooser; the version that is not kept goes to one
of the backup files above first, and if that copy cannot be made the choice is
not carried out. (Unsaved work that came back from the browser without its
record that it was made in THIS folder -- work left by an older version of the
app, or kept while that record could not be read or written -- is asked about
unless the folder already holds exactly that work, also where the folder has no
such file yet.) What this cannot see: a write by another computer, another
browser or another program that lands in the moment between the app's last look
at a file and its own write -- the later write then replaces the earlier one,
with no chooser and no backup.
NEWER FORMATS -- an annotation.json with a schema_version above the app's own,
or with an unknown paint.encoding, makes the frame READ-ONLY: saving does not
rewrite it. The one way it is replaced: it appears while the frame is open with
unsaved work -- a conflict like any other -- and the session's version is
chosen; the file is then first copied, byte for byte, to
annotation.external-backup.json. (While such a file cannot be read in full,
nothing is written over it: the save waits.) A note.json from a newer version is
treated differently: it can still be edited; the file as it was is first kept as
note.unread-backup.json, and the note is then written in this version's format.

========================================
HOW TO PREPARE A DATASET -- STEP BY STEP
========================================
STEP 1. What you need to start
  - the DSA frames of each sequence, as images;
  - a binary vessel segmentation for each frame (your own model);
  - optionally, existing region annotations you want to carry in.

STEP 2. Fix the image grid, once per frame
  Decide W x H now and use it for the image, the mask and the label. If you crop
  or resize, do it BEFORE anything else -- every downstream file must agree.
  Save the image as 8-bit grayscale PNG.

STEP 3. Turn the binary mask into segments (this is the important step)
  label.npy is what the reviewer clicks, so its granularity IS the annotation's
  granularity. Two options:
  (a) Connected components -- one id per connected vessel tree. Trivial, but
      usually far too coarse: one click selects the whole tree.
        from scipy import ndimage
        label, n = ndimage.label(mask)              # rarely what you want
  (b) Branch-level partition -- one id per vessel branch. This is what you
      normally want:
        1. skeletonize the mask                   (skimage.morphology.skeletonize)
        2. count 8-neighbours of every skeleton pixel; pixels with 3+ neighbours
           are branch points, 1 neighbour are endpoints
        3. remove the branch points; each remaining connected run of skeleton is
           one CHAIN = one segment
        4. assign EVERY foreground pixel to the nearest chain
           (scipy.spatial.cKDTree over the chain pixels)
        5. number the chains 1..N and write that as label.npy
      Keep closed rings as their own chain and never merge two chains that meet
      only at a branch point -- merging is what makes segments too coarse.
  Whichever you choose: ids must be 1..N with no gaps, 0 = background, and
  (label > 0) must equal your mask pixel for pixel.

STEP 4. Per-segment metrics -> geometry.json
  Any numeric metric works; these are the useful ones:
    radius     median of the Euclidean distance transform sampled along the
               segment's skeleton (diameter = 2x this). This is the robust one --
               it is not thrown off by a bulge at one end.
                 from scipy.ndimage import distance_transform_edt
                 dt = distance_transform_edt(mask)
                 radius = float(np.median(dt[chain_pixels]))
    length     path length along the skeleton; sum the step distances, using
               sqrt(2) for diagonal steps, not 1.
    area       pixel count of the segment
    mean_width area / length -- an independent width estimate; disagreement with
               radius is a useful red flag
    tortuosity length / straight-line distance between the two ends; 1.0 = straight
  Emit them all; the reviewer picks which to filter on. Set "filter" to the first
  metric's full range so the panel opens usable.
  If your images have no physical pixel spacing, say so in your own docs: these
  are PIXEL measurements and are NOT comparable across sequences of different
  resolution.

STEP 5. (Optional) Pre-fill annotations
  If you already have regions to carry in, write them as PAINT, not as
  collaterals[]. Paint stores pixels and survives a future re-partition;
  collaterals[] stores only ids and does not. Encode row-run-length:
        runs = []
        for y in range(H):
            cols = np.flatnonzero(region[y])
            if cols.size == 0: continue
            cut    = np.flatnonzero(np.diff(cols) != 1)
            starts = np.concatenate(([0], cut + 1))
            ends   = np.concatenate((cut, [cols.size - 1]))
            for s, e in zip(starts, ends):
                runs.append([int(y), int(cols[s]), int(cols[e] - cols[s] + 1)])
  then write annotation.json with paint.width/height set to THIS frame's W/H and
  classes = {"1": runs}. Declare class 1 in classes.json. Do not fabricate an
  empty annotation.json for a frame with nothing in it -- omit the file.

STEP 6. Validate before shipping
  For every unit, assert:
    - frames.png, label.npy and mask.npy have identical W x H;
    - label.npy is 2-D, C-order, dtype in {uint16, uint8, int32, uint32};
    - (label > 0) equals mask exactly;
    - geometry.json keys == the ids actually present in label.npy;
    - every paint block's width/height == that frame's W/H;
    - every class index used anywhere is declared in classes.json;
    - every folder name would be discovered (carries a number, or is "minip").

COMPLETE MINIMAL EXAMPLE (one valid frame)
  import numpy as np, json, os
  from PIL import Image
  H = W = 512
  gray  = (np.random.rand(H, W) * 255).astype(np.uint8)
  label = np.zeros((H, W), np.uint16)
  label[100:140, 50:400] = 1                 # segment 1
  label[200:260, 80:380] = 2                 # segment 2
  d = "case_0001/frame_0"; os.makedirs(d, exist_ok=True)
  Image.fromarray(gray, "L").save(d + "/frames.png")
  np.save(d + "/label.npy", label)           # (H, W) uint16, C-order
  np.save(d + "/mask.npy", (label > 0).astype(np.uint8))
  json.dump({"segments": {"1": {"radius_px": 3.0}, "2": {"radius_px": 5.0}},
             "filter": {"metric": "radius_px", "min": 3.0, "max": 5.0}},
            open(d + "/geometry.json", "w"), indent=2)
  json.dump({"classes": [{"index": 1, "name": "Collateral"}]},
            open("classes.json", "w"), indent=2)

========================================
FAILURES THAT ARE SILENT -- NOTHING WILL WARN YOU
========================================
- PAINT AT THE WRONG SIZE IS DISCARDED. If paint.width/height differ from the
  frame's W/H the brush layer is not decoded: no marks, no warning, no error.
  (The stored RLE is preserved, so load+save cannot destroy it -- but nothing
  shows.) Always write width/height from the array you encoded.
- A FOLDER WHOSE NAME CARRIES NO NUMBER IS SKIPPED, with no message.
- A MISSING classes.json IS SILENTLY REPLACED by one with invented names.
By contrast a W x H disagreement between frames.png / label.npy / mask.npy is
LOUD: that frame becomes a grey read-only placeholder listing the three shapes.

========================================
SEGMENT IDS ARE NOT STABLE IDENTIFIERS
========================================
collaterals[].id and the keys of geometry.json store ONLY a number; the shape is
resolved from label.npy at display time. Regenerating label.npy therefore
re-points every existing selection at whatever segment now carries that number,
silently.
- Ids are assigned deterministically by position, so SMALL changes are harmless:
  re-running the same partition, deleting one pixel, or adding a speck elsewhere
  leaves every id intact (measured).
- Replacing the MASK -- a better segmentation model, a changed partition rule --
  renumbers essentially everything. Measured on four sequences after swapping one
  vessel model for another, of the pixels that are foreground in BOTH masks the
  fraction keeping its old id was 0.73 %, 0.01 %, 0.00 %, 0.00 %.
- So: NEVER regenerate label.npy in place for a unit that already has an
  annotation.json. Build a new dataset folder instead.
- PAINT IS IMMUNE: it stores pixels, not ids. A segment-level view is recoverable
  from paint at any threshold:
      (paint & (label == i)).sum() / (label == i).sum()

========================================
SPLITTING THE WORK ACROSS SEVERAL ANNOTATORS
========================================
Cases can be handed out as separate folders and merged back. Case numbers need
not start anywhere in particular and need not be contiguous.
- Give every package its own copy of classes.json, or each invents its own names.
- Keep each case whole: all of its units go to one person.
- Merging is a plain copy; case folder names are unique so nothing collides. Take
  the UNION of the classes.json files if anyone added a class.
- What comes back changed: annotation.json, note.json, the "filter" block of
  geometry.json, classes.json, .annotator_dataset.json. Apart from these the tool
  writes only the recovery files (*.corrupt, *-backup.json), and only when
  something had to be protected.

========================================
CHECKLIST
========================================
[ ] Every unit folder has frames.png + label.npy. mask.npy and geometry.json optional.
[ ] frames.png, label.npy and mask.npy are EXACTLY the same W x H.
[ ] label.npy is 2-D (H, W), C-order, little-endian, uint16 (or uint8/int32/uint32);
    0 = background, 1..N = segment ids, no gaps.
[ ] (label > 0) equals mask.npy pixel for pixel.
[ ] geometry.json keys equal the label.npy ids, as strings; values are objects of
    numeric metrics; "filter" names a metric that exists.
[ ] NO frame folder name ends in "#" + digits (e.g. f_3#1 is FORBIDDEN: the tool
    keys per-layer content as case/frame#layerId and such a name cross-wires
    annotations between frames). Class indices in classes.json are all >= 1.
[ ] Case and unit folder names contain a number; a unit named exactly "minip" is
    allowed and sorts last.
[ ] classes.json ships WITH the data and declares every class index used.
[ ] Any paint block's width/height equal that frame's W/H.
````

</details>
