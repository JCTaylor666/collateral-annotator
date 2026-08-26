# 侧支标注器

[English](README.md) · **中文**

一个在浏览器里给 DSA(数字减影血管造影)帧标注侧支血管段的工具。点击预分割好的血管段即可标注,还能笔刷涂抹、写笔记、放标记——所有结果直接写入你本地的文件夹。

**在线使用:https://jctaylor666.github.io/collateral-annotator/**

> ⚠️ **请用 Chrome 或 Edge。** 本工具通过 File System Access API 直接把文件写入你电脑上的文件夹,只有 Chromium 内核的浏览器支持。Safari 和 Firefox 能打开页面,但无法打开数据文件夹。

---

## 数据文件夹结构

把工具指向这样一个**数据根目录**:

```
<数据根目录>/          ← 你打开的就是它
├─ classes.json         ← 类别定义(工具自动创建/更新)
├─ case_0001/           ← 一个病例,名字必须是 case_<数字>
│  ├─ frame_0/          ← 一帧,名字必须是 frame_<数字>
│  │  ├─ frames.png     ← 必需 · DSA 图像(灰度)
│  │  ├─ label.npy      ← 必需 · 逐像素血管段 id(本帧的分割)
│  │  ├─ mask.npy       ← 可选 · 0/1 血管 mask
│  │  ├─ annotation.json← 工具写入
│  │  └─ note.json      ← 工具写入
│  └─ minip/            ← 最小强度投影,永远排在最后
└─ case_0002/ …
```

只要文件夹名**带数字**就会被当作病例(以及病例里的单元)——纯数字、结尾 `_<数字>`、或开头 `<数字>_` 都行,前后缀随意(`case_0001`、`frame_3`、`12_patient`、`7`)。名为 `minip` 的单元也会加载并永远排在最后。其余一律**静默跳过**。`frames.png` 和 `label.npy` 必需,且**尺寸必须一致**(W = label 宽,H = label 高),否则该帧无法加载。分割是**逐帧的**——同一个段 id 在不同帧之间没有对应关系。

---

## 功能说明

### 1. 打开数据文件夹

![打开数据文件夹](docs/media/dataload.gif)

点击**打开数据文件夹**,选择你的数据根目录。

- **需要 Chrome/Edge**(File System Access API);浏览器会请求读写该文件夹的权限。
- 打开时,工具会扫描所有帧生成帧列表,并把标注里用到但 `classes.json` 里缺失的类别自动补上。
- 如果文件夹里没有 `case_<数字>` 子文件夹,则什么都不加载,并弹出提示。

### 2. 选择病例、切换帧

![选择病例与切换帧](docs/media/selectframeandcase.gif)

在左栏顶部的下拉框里选病例,然后在下面的列表里点选帧。

- **← / →** 切到上一/下一帧(跨病例循环);`«` `»` 按钮跳病例,`‹` `›` 跳帧。
- 帧旁边的数字是**该帧的标注数量**;看过的帧颜色更深。
- 点帧上的 **★** 加星标。只要一个病例里有任意一帧被星标,下拉框里该病例就显示 ★。

### 3. 标注血管段

![标注血管段](docs/media/annotationprocess.gif)

*(此片段为加速播放。)*

先在右侧面板(**标注分类**)里选好当前类别,然后在图上点击。

- **点血管段** → 用当前类别的颜色标为侧支。**用同一类别再点一次** → 取消标注。**换一个当前类别再点** → 改标为新类别。
- **点背景**(无血管处)→ 在该位置留一个红点。**在已有红点附近再点** → 删除该红点。
- 颜色来自你在右侧选中的类别;若还没定义任何类别,标注回退为绿色。
- 开着**自动保存**(默认开)时,每次改动约一秒后就写入 `annotation.json`。

### 4. 从其他帧复制标注

![从其他帧复制](docs/media/copyfromprevious.gif)

复用你在相邻帧上已经做好的标注。

- ⚠️ **只有当前帧没有任何标注时,这个按钮才可用。** 如果本帧已经标过,得先清空(否则按钮一直是灰的)。
- 点击**从其他帧复制…**,帧列表高亮,然后点你要复制的那一帧。按 **Esc** 取消。
- 源帧的每个点击都会**按当前帧自己的分割重新解析**(分割逐帧不同):落在某个段上就标该段,落在背景就变成红点。
- **没有类别的点击会被丢弃。** 如果两个源点击落到同一个目标段,**第一个生效**。

### 5. 检视放大镜(按住 Cmd / Ctrl)

![检视放大镜](docs/media/inspection.gif)

光标在图上时,**按住 Cmd(Mac)或 Ctrl(Windows)**。

- 会弹出一个面板,显示当前帧及其**前后相邻帧**在光标处的放大裁剪,还有一条**跨帧原始灰度曲线**(minip 在虚线右侧),让你看清同一个点的强度在整个序列里如何变化。
- **检视时仍然可以点击标注**——放大镜不挡任何操作。
- 松开按键即关闭(切换标签页也会关闭)。
- 在**检视放大镜**设置里可调:*放大率*、*前后帧数*(显示前后各几帧)、*3×3 均值*、*视野大小*(瓦片越大视野越宽,面板随之变宽)。

### 6. 笔记与标记

![笔记与标记](docs/media/nakenote.gif)

每一帧都有自己的笔记,保存到 `note.json`。

- 在**笔记**框里输入;**保存笔记**(或自动保存)会写入磁盘。
- 点**添加标记**,然后在图上点一下,就在该位置放一个**带编号的圆圈**。编号递增(1、2、3……)且稳定——删掉某个不会让其它重新编号。
- 用笔记下方 chip 上的 **×** 删除标记;鼠标悬停某个 chip 时,图上对应的圆圈会高亮。
- **Cmd+Z** 撤销标记(或任何标注)。

---

### 7. 保存、冲突与恢复

- **保存 `s_N`** 只写当前病例;**全部保存**是收工前的整体落盘,带进度框和取消
  (按钮上带全局未保存计数)。自动保存默认开启,每次修改约 1 秒后写当前帧。
- 若某帧磁盘上的文件**更新且内容不同**(同事保存过、从别的机器拷来),程序不会
  覆盖任何一方:打开该帧会弹出**双缩略图对比**,由你选择保留文件夹版本还是本次
  会话版本;落选的一方总会先存进备份文件。
- 文件里含本程序版本读不懂的内容(更高的 `schema_version`、陌生的涂抹编码)时,
  该帧变为**只读**并提供可复制的诊断信息,而不是被静默改写。
- 帧文件夹里的备份/救援文件会以横幅加「查看」按钮的形式出现:对比后**以交换方式
  恢复**——任何选择都不会销毁内容。

## 你的标注存在哪

所有内容都写在**你的数据文件夹里**,逐帧保存:

- `annotation.json` — 标注的血管段、背景红点、笔刷涂抹、星标。
- `note.json` — 本帧的笔记文本和编号标记。
- `classes.json`(在数据根目录) — 类别索引 → 名称。颜色**不**存这里,只存在你的浏览器本地。

坐标顺序由**设置 → 坐标顺序**决定(`xy` = `[x, y]`,`yx` = `[y, x]`;默认 `xy`,原点在左上角)。应用内的**帮助 → 数据组织格式**里有逐字段的完整说明。

---

## 给 AI agent 用的数据集准备 prompt

下面是一段**完整自包含**的规格，把它整段复制给任意 AI agent（无需任何背景），它就能生成一份本工具可以直接打开的数据集。内容涵盖：这个工具是干什么的、**每一个**输入/输出文件的格式、以及如何一步步准备数据。

规格正文保持**英文** —— 和 app 里「数据组织格式… → 复制给 AI」那一份完全一致，只维护一份，才能始终跟代码同步。

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
      annotation.unsaved-backup.json OUTPUT, recovery only
      note.unsaved-backup.json       OUTPUT, recovery only

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
  simply no overlay. If PRESENT it must match W x H exactly -- a wrong-shaped or
  truncated mask triggers the grey placeholder rather than being ignored.
  Normally mask == (label > 0).

geometry.json   (optional; the tool writes back only "filter")
  { "segments": { "1":  { "radius_px": 2.0, "length_px": 40.0 },
                  "12": { "radius_px": 16.0, "length_px": 12.0 } },
    "filter":   { "metric": "radius_px", "min": 4.8, "max": 15.4 } }
  - "segments" is keyed by the label id AS A STRING; background 0 is excluded.
    Each value is an object of NAMED NUMERIC METRICS -- any names, any number of
    them. This drives the "Segment geometry" panel: pick a metric, see count /
    min / max / mean / median, and filter the display by a range.
  - "filter" is the reviewer's saved window; the tool rewrites it whenever the
    sliders move. Set it at generation time to the first metric's full range.
  - Everything else in the file is preserved verbatim.

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
  { "id": "d3f1a2..." } -- created on first open. In-browser progress is keyed to
  this id so two datasets that both use case_1/frame_0 never bleed together. Safe
  to delete (resets browser state only) and safe to omit from an archive.

RECOVERY FILES -- written only when something needs protecting; the app can
show and RESTORE them from the UI (opening the frame offers a "View" banner;
restoring is a swap, nothing is destroyed):
  annotation.json.corrupt / note.json.corrupt / classes.json.corrupt -- an
    unparseable file is copied here ONCE before anything overwrites it.
  annotation.unsaved-backup.json / note.unsaved-backup.json -- the session's
    side of a resolved conflict (you kept the folder's version).
  annotation.external-backup.json / note.external-backup.json -- the folder's
    side of a resolved conflict (you kept the session's version).
CONFLICTS: a file on disk NEWER than the session's copy and different in
content is never auto-resolved -- the frame goes write-protected and opening
it shows a two-thumbnail chooser. A file with a schema_version above the app's
own, or an unknown paint.encoding, makes the frame READ-ONLY (never blindly
rewritten by an older app).

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
  geometry.json, classes.json, .annotator_dataset.json. Nothing else is written.

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
