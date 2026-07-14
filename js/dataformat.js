// dataformat.js — self-contained "Data format" reference. A button in the Help
// group opens a modal documenting the on-disk dataset layout (folder tree, every
// file's role and exact content format). Owns its own EN/ZH strings so the large
// doc content stays out of the central i18n dictionary; re-renders on 'langchange'.
(function () {
  'use strict';

  const EN_HTML = `
<p class="doc-p">The folder you pick with “Open data folder” is the dataset root. <b>Inputs</b> (image + segmentation) come from your preprocessing pipeline; <b>outputs</b> are written by this tool. Every frame folder is self-contained.</p>
<pre class="doc-tree">&lt;data root&gt;/                    ← picked with “Open data folder”
├─ classes.json                 ← output · class definitions (whole dataset)
├─ case_0001/                   ← one case · any name carrying a number (e.g. case_0001, 12_patient)
│  ├─ frame_0/                  ← one frame · any name carrying a number (e.g. frame_0, 3_dsa)
│  │  ├─ frames.png             ← input · DSA frame image (grayscale PNG)
│  │  ├─ label.npy              ← input · segment-id map (this frame's segmentation)
│  │  ├─ mask.npy               ← input · 0/1 vessel mask (optional)
│  │  ├─ geometry.json          ← input+output · per-segment metrics + saved filter (optional)
│  │  ├─ annotation.json        ← output · your annotations for this frame
│  │  └─ note.json              ← output · frame note + numbered markers
│  ├─ frame_1/ …
│  └─ minip/                    ← minimum-intensity projection · same files, listed last
└─ case_0002/ …</pre>
<div class="doc-sec"><h4>Discovery rules</h4><ul>
<li>A folder is a case (and, inside it, a frame) if its name carries a number — pure digits, a trailing <code>_&lt;digits&gt;</code>, or a leading <code>&lt;digits&gt;_</code>. The rest of the name is free (e.g. <code>case_0001</code>, <code>frame_3</code>, <code>12_patient</code>, <code>0_scan</code>). A unit folder named exactly <code>minip</code> is also loaded.</li>
<li>Frames sort by that number (frame_2 before frame_10); <code>minip</code> is always last; cases sort by their number. Hidden folders (starting with <code>.</code>), folders with no number, and files are ignored.</li>
</ul></div>
<div class="doc-sec"><h4><code>frames.png</code> — input, required</h4><ul>
<li>The DSA frame as a grayscale PNG. The tool reads the <b>red channel</b> as the raw gray value (0–255) for contrast windowing and the inspect loupe.</li>
<li>Width/height must exactly match <code>label.npy</code> (W = shape[1], H = shape[0]) — otherwise the frame fails to load with an error.</li>
</ul></div>
<div class="doc-sec"><h4><code>label.npy</code> — input, required</h4><ul>
<li>NumPy 2-D array, shape <code>(H, W)</code>, C-order, little-endian. dtype <code>uint16</code> (uint8 / int32 / uint32 also accepted; fortran_order is rejected).</li>
<li>Pixel value 0 = background; 1…N = segment id. Segmentation is <b>per-frame</b> — ids do not correspond across frames. The Click tool selects the segment id under the cursor.</li>
</ul></div>
<div class="doc-sec"><h4><code>mask.npy</code> — input, optional</h4><ul>
<li>2-D <code>(H, W)</code> uint8 array of 0/1: the vessel mask. Rendered as the bright-blue overlay; also limits the brush when “Foreground only” is checked.</li>
<li>If missing, or its shape mismatches label.npy, it is silently ignored (no overlay).</li>
</ul></div>
<div class="doc-sec"><h4><code>geometry.json</code> — input + output, optional</h4>
<pre class="doc-tree">{ "segments": {
    "1":  { "radius": 2.0,  "length": 40 },
    "12": { "radius": 16.0, "length": 12 }
  },
  "filter": { "metric": "radius", "min": 4.8, "max": 15.4 } }</pre>
<ul>
<li><code>segments</code> — keyed by <b>label segment id</b> (the pixel value in label.npy; background 0 excluded). Each entry is an object of <b>named metrics</b> your pipeline computes — any names, any number (radius, length, …). Drives the “Segment geometry” panel: pick a metric, see stats (count / min / max / mean / median) and filter by its range. (Legacy form <code>"1": 2.0</code> with a top-level <code>"metric"</code> is still accepted.)</li>
<li><code>filter</code> — the reviewer's window: which <code>metric</code> + <code>min</code>/<code>max</code>. The tool writes it back whenever you move the sliders or switch metric, so each frame reopens with its last-used metric and range. Default at generation = the first metric's full range. The on/off toggle is a global app preference, not stored here.</li>
<li>Absent or unparseable → the panel doesn't appear. Only <code>filter</code> is ever written; <code>segments</code> and any other fields are preserved. Segments with no value for the active metric are always shown.</li>
</ul></div>
<div class="doc-sec"><h4><code>annotation.json</code> — output</h4>
<p class="doc-p">Written into each frame folder on save / auto-save:</p>
<pre class="doc-tree">{
  "schema_version": 5,
  "case": "case_0001",
  "unit": "frame_0",
  "image_size": [800, 800],
  "coord_order": "xy",
  "collaterals": [
    { "id": 12, "click": [321, 187], "class": 2 }
  ],
  "points": [
    { "click": [40, 500], "class": 1 }
  ],
  "starred": true,
  "paint": {
    "encoding": "rle_rows_v1",
    "axes": "run=[row,col,length]; row=y image row (0=top); …",
    "width": 800, "height": 800,
    "classes": { "2": [[10, 40, 12], [11, 39, 14]] }
  }
}</pre>
<ul>
<li><code>schema_version</code> — format version: <b>5</b> when the frame has a single annotation layer (the flat form above), <b>6</b> when it has two or more layers (see “Layers” below). Files written by older versions 1–4 still import.</li>
<li><code>case</code> / <code>unit</code> — the folder names, for traceability.</li>
<li><code>image_size</code> — <code>[W, H]</code> of the frame.</li>
<li><code>coord_order</code> — how click coordinates are serialized (Settings → Coordinate order). <code>"xy"</code> → click = [x, y] (x = column from left, y = row from top); <code>"yx"</code> → click = [y, x]. Applies to <code>collaterals[].click</code> and <code>points[].click</code>, <b>never</b> to <code>paint</code>.</li>
<li><code>collaterals</code> — one entry per selected vessel segment: <code>id</code> = segment id in label.npy, <code>click</code> = the clicked coordinate, <code>class</code> = class index (omitted when unclassified).</li>
<li><code>points</code> — background clicks (red dots that hit no segment), same click/class format.</li>
<li><code>starred</code> — present (true) only when the frame is starred.</li>
<li><code>paint</code> — brush layer, row run-length encoded; present only if painted. <code>classes</code> maps class index → list of runs <code>[row, col, length]</code>: row = y (0 = top), col = x of the run start (0 = left), length = number of consecutive pixels toward +x. <code>width</code>/<code>height</code> record the encoding dimensions, and the <code>axes</code> field documents the run layout inside the file itself.</li>
</ul>
<h4>Layers (<code>schema_version</code> 6)</h4>
<p class="doc-p">A frame can hold several independent annotation layers (the “Layers” bar in the right panel). With <b>one</b> layer the file stays flat v5, exactly as above. With <b>two or more</b> layers the per-layer content moves into a <code>layers</code> array:</p>
<pre class="doc-tree">{
  "schema_version": 6,
  "case": "case_0001", "unit": "frame_0",
  "image_size": [800, 800], "coord_order": "xy",
  "starred": true,                ← frame-level fields stay at the top
  "active_layer": 1,              ← id of the layer selected in the UI
  "layers": [
    { "id": 0, "name": "Layer 1",
      "collaterals": [ … ],       ← same formats as v5
      "points": [ … ],
      "paint": { … } },           ← optional, same RLE as v5
    { "id": 1, "name": "Veins", "collaterals": [], "points": [] }
  ]
}</pre>
<ul>
<li><code>id</code> — stable integer per layer; <code>name</code> — its display name. <code>collaterals</code> / <code>points</code> / <code>paint</code> inside each layer have exactly the v5 formats (and <code>coord_order</code> applies the same way).</li>
<li>Frame-level data is <b>not</b> layered: <code>starred</code> stays top-level, and note.json (note text + numbered markers) is one per frame.</li>
<li>Deleting down to one layer makes the next save collapse back to flat v5. A single-layer frame with a custom layer name keeps it in the v5 field <code>layer_name</code>.</li>
</ul></div>
<div class="doc-sec"><h4><code>note.json</code> — output</h4>
<pre class="doc-tree">{ "schema_version": 1, "coord_order": "xy",
  "text": "free-text note…",
  "markers": [ { "id": 1, "click": [321, 187] } ] }</pre>
<ul>
<li><code>text</code> — the frame's Notes box. <code>markers</code> — the numbered circle markers placed from the note panel: <code>id</code> = the number shown in the circle (stable, never renumbered), <code>click</code> = image coordinate, serialized with <code>coord_order</code> like annotation.json.</li>
<li>Written when the frame has note text or markers. Legacy <code>note.txt</code> files are no longer read or written.</li>
</ul></div>
<div class="doc-sec"><h4><code>classes.json</code> — output, dataset root</h4>
<pre class="doc-tree">{ "classes": [ { "index": 1, "name": "Collateral A" } ] }</pre>
<ul>
<li><code>index</code> = the number stored in annotations (the <code>class</code> fields and paint keys); <code>name</code> = display name.</li>
<li>Colors are <b>not</b> stored here — they live only in your browser. The file is created/updated automatically; if any annotation on disk uses a class missing here, it is re-added on open with a placeholder name.</li>
</ul></div>`;

  const ZH_HTML = `
<p class="doc-p">用“打开数据文件夹”选中的文件夹就是数据根目录。<b>输入</b>（图像 + 分割）由你的预处理流水线生成；<b>输出</b>由本工具写入。每个帧文件夹都是自包含的。</p>
<pre class="doc-tree">&lt;数据根目录&gt;/                 ← “打开数据文件夹”选的就是它
├─ classes.json                 ← 输出 · 类别定义（全数据集共用）
├─ case_0001/                   ← 一个病例 · 名字带数字即可(如 case_0001、12_patient)
│  ├─ frame_0/                  ← 一帧 · 名字带数字即可(如 frame_0、3_dsa)
│  │  ├─ frames.png             ← 输入 · DSA 帧图像（灰度 PNG）
│  │  ├─ label.npy              ← 输入 · 血管段 id 图（本帧自己的分割）
│  │  ├─ mask.npy               ← 输入 · 0/1 血管 mask（可选）
│  │  ├─ geometry.json          ← 输入+输出 · 每段参数 + 保存的过滤区间（可选）
│  │  ├─ annotation.json        ← 输出 · 本帧的标注结果
│  │  └─ note.json              ← 输出 · 本帧笔记 + 编号标记
│  ├─ frame_1/ …
│  └─ minip/                    ← 最小强度投影 · 文件相同，排在最后
└─ case_0002/ …</pre>
<div class="doc-sec"><h4>扫描规则</h4><ul>
<li>只要文件夹名<b>带数字</b>就算病例(以及病例里的帧)——纯数字、结尾 <code>_&lt;数字&gt;</code>、或开头 <code>&lt;数字&gt;_</code> 都行,前后缀随意(如 <code>case_0001</code>、<code>frame_3</code>、<code>12_patient</code>、<code>0_scan</code>)。名为 <code>minip</code> 的单元也会加载。</li>
<li>帧按该数字排序(frame_2 在 frame_10 前);<code>minip</code> 永远排最后;病例按编号排序。隐藏文件夹(以 <code>.</code> 开头)、不带数字的文件夹、以及文件一律忽略。</li>
</ul></div>
<div class="doc-sec"><h4><code>frames.png</code> — 输入，必需</h4><ul>
<li>DSA 帧图像，灰度 PNG。工具读取其<b>红色通道</b>作为原始灰度值（0–255），用于窗宽窗位和检视放大镜。</li>
<li>宽高必须与 <code>label.npy</code> 一致（W = shape[1]，H = shape[0]），否则该帧报错不加载。</li>
</ul></div>
<div class="doc-sec"><h4><code>label.npy</code> — 输入，必需</h4><ul>
<li>NumPy 二维数组，shape <code>(H, W)</code>，C 序、小端。dtype <code>uint16</code>（也接受 uint8 / int32 / uint32；fortran_order 会报错）。</li>
<li>像素值 0 = 背景；1…N = 血管段 id。分割是<b>逐帧</b>的 — id 在不同帧之间没有对应关系。点选工具选中的就是光标下的段 id。</li>
</ul></div>
<div class="doc-sec"><h4><code>mask.npy</code> — 输入，可选</h4><ul>
<li>二维 <code>(H, W)</code> uint8 的 0/1 血管 mask。显示为亮蓝叠加层；勾选“仅前景”时限制笔刷范围。</li>
<li>缺失或尺寸不匹配时静默忽略（不显示叠加层）。</li>
</ul></div>
<div class="doc-sec"><h4><code>geometry.json</code> — 输入 + 输出，可选</h4>
<pre class="doc-tree">{ "segments": {
    "1":  { "radius": 2.0,  "length": 40 },
    "12": { "radius": 16.0, "length": 12 }
  },
  "filter": { "metric": "radius", "min": 4.8, "max": 15.4 } }</pre>
<ul>
<li><code>segments</code> — 键 = <b>label 分区 id</b>(即 label.npy 里的像素值,背景 0 除外)。每项是一个<b>命名参数对象</b>,放你流水线算的任意个参数(名字随意,如 radius、length)。驱动“分区几何”面板:选一个参数,看统计(段数/最小/最大/均值/中位)并按其区间过滤。(旧格式 <code>"1": 2.0</code> 配顶层 <code>"metric"</code> 仍兼容。)</li>
<li><code>filter</code> — 医生用的窗口:哪个 <code>metric</code> + <code>min</code>/<code>max</code>。拖滑块或切换参数时工具写回,这样每帧重开恢复上次的参数和区间。生成默认 = 第一个参数的满量程。过滤开/关是全局偏好,不存这里。</li>
<li>缺失或无法解析 → 面板不出现。只写回 <code>filter</code>;<code>segments</code> 及其它字段都保留。当前参数下没值的分区始终显示。</li>
</ul></div>
<div class="doc-sec"><h4><code>annotation.json</code> — 输出</h4>
<p class="doc-p">保存 / 自动保存时写入每个帧文件夹：</p>
<pre class="doc-tree">{
  "schema_version": 5,
  "case": "case_0001",
  "unit": "frame_0",
  "image_size": [800, 800],
  "coord_order": "xy",
  "collaterals": [
    { "id": 12, "click": [321, 187], "class": 2 }
  ],
  "points": [
    { "click": [40, 500], "class": 1 }
  ],
  "starred": true,
  "paint": {
    "encoding": "rle_rows_v1",
    "axes": "run=[row,col,length]; row=y image row (0=top); …",
    "width": 800, "height": 800,
    "classes": { "2": [[10, 40, 12], [11, 39, 14]] }
  }
}</pre>
<ul>
<li><code>schema_version</code> — 格式版本：单图层的帧写 <b>5</b>（就是上面的扁平结构），两层及以上写 <b>6</b>（见下方“图层”）。旧版本 1–4 的文件仍可读入。</li>
<li><code>case</code> / <code>unit</code> — 文件夹名，便于溯源。</li>
<li><code>image_size</code> — 本帧的 <code>[W, H]</code>。</li>
<li><code>coord_order</code> — 点击坐标的序列化顺序（设置 → 坐标顺序）。<code>"xy"</code> → click = [x, y]（x = 列，从左起；y = 行，从上起）；<code>"yx"</code> → click = [y, x]。只影响 <code>collaterals[].click</code> 和 <code>points[].click</code>，<b>永远不影响</b> <code>paint</code>。</li>
<li><code>collaterals</code> — 每个选中的血管段一条：<code>id</code> = label.npy 里的段 id，<code>click</code> = 点击坐标，<code>class</code> = 类别索引（未分类时省略）。</li>
<li><code>points</code> — 背景点击（没落在任何段上的红点），click/class 格式同上。</li>
<li><code>starred</code> — 仅在该帧被星标时存在（true）。</li>
<li><code>paint</code> — 笔刷图层，按行游程编码（RLE），涂过才存在。<code>classes</code> 把类别索引映射到游程列表 <code>[row, col, length]</code>：row = y（第几行，0 = 顶部），col = 游程起点的 x（第几列，0 = 左侧），length = 向 +x 方向连续的像素数。<code>width</code>/<code>height</code> 记录编码时的尺寸，<code>axes</code> 字段在文件内部自己说明了维度含义。</li>
</ul>
<h4>图层（<code>schema_version</code> 6）</h4>
<p class="doc-p">一帧可以有多个相互独立的标注图层（右侧面板的“图层”栏）。只有<b>一层</b>时文件保持扁平 v5（与上面完全一致）；<b>两层及以上</b>时，逐层内容移入 <code>layers</code> 数组：</p>
<pre class="doc-tree">{
  "schema_version": 6,
  "case": "case_0001", "unit": "frame_0",
  "image_size": [800, 800], "coord_order": "xy",
  "starred": true,                ← 帧级字段仍在顶层
  "active_layer": 1,              ← 界面上当前选中的图层 id
  "layers": [
    { "id": 0, "name": "Layer 1",
      "collaterals": [ … ],       ← 与 v5 格式完全相同
      "points": [ … ],
      "paint": { … } },           ← 可选，RLE 同 v5
    { "id": 1, "name": "静脉", "collaterals": [], "points": [] }
  ]
}</pre>
<ul>
<li><code>id</code> — 每层的稳定整数编号；<code>name</code> — 显示名。每层里的 <code>collaterals</code> / <code>points</code> / <code>paint</code> 与 v5 的格式完全一致（<code>coord_order</code> 同样适用）。</li>
<li>帧级数据<b>不分层</b>：<code>starred</code> 留在顶层；note.json（笔记 + 编号标记）每帧一份。</li>
<li>删到只剩一层后，下次保存会折叠回扁平 v5。单层帧的自定义图层名保存在 v5 的 <code>layer_name</code> 字段里。</li>
</ul></div>
<div class="doc-sec"><h4><code>note.json</code> — 输出</h4>
<pre class="doc-tree">{ "schema_version": 1, "coord_order": "xy",
  "text": "自由文本笔记…",
  "markers": [ { "id": 1, "click": [321, 187] } ] }</pre>
<ul>
<li><code>text</code> — 本帧笔记框的内容。<code>markers</code> — 从笔记面板放置的编号圆圈标记：<code>id</code> = 圆圈里显示的数字（编号稳定、不重排），<code>click</code> = 图像坐标，和 annotation.json 一样按 <code>coord_order</code> 序列化。</li>
<li>有笔记文字或标记时写入。旧的 <code>note.txt</code> 不再读取也不再写入。</li>
</ul></div>
<div class="doc-sec"><h4><code>classes.json</code> — 输出，位于数据根目录</h4>
<pre class="doc-tree">{ "classes": [ { "index": 1, "name": "侧支 A" } ] }</pre>
<ul>
<li><code>index</code> = 写进标注的数字（各 <code>class</code> 字段和 paint 的键）；<code>name</code> = 显示名称。</li>
<li>颜色<b>不</b>存在这里 — 颜色只存在浏览器本地。此文件自动创建/更新；如果磁盘上的标注用到了这里缺失的类别，打开时会自动补一个占位名。</li>
</ul></div>`;

  // Part 2: a self-contained spec the user can copy to any AI agent with zero prior context, so that
  // agent can generate or read this dataset. Plain text (shown via textContent + copied verbatim).
  const PROMPT = `You are generating (or reading) an on-disk dataset for a browser tool called "Vessel Annotator", which annotates leptomeningeal-collateral vessel segments on DSA (digital subtraction angiography) frames. This message is a COMPLETE, self-contained specification. Assume NO prior context. Follow it exactly.

========================================
OVERVIEW
========================================
The user opens ONE root folder. Inside it are CASE folders; inside each case are UNIT folders (one per DSA frame, plus optionally one "minip" minimum-intensity-projection unit). Each unit folder is self-contained. INPUT files (image + segmentation + optional geometry) are produced by your pipeline. OUTPUT files (annotations, notes, classes) are written by the tool during review — you normally do NOT create them, but their format is given for completeness.

========================================
FOLDER STRUCTURE
========================================
<root>/
  classes.json                (optional, dataset-wide; the tool creates/updates it)
  <case folder>/              (one per case)
    <unit folder>/            (one per frame; plus optional "minip")
      frames.png              (INPUT, required)
      label.npy               (INPUT, required)
      mask.npy                (INPUT, optional)
      geometry.json           (INPUT + OUTPUT, optional)
      annotation.json         (tool OUTPUT)
      note.json               (tool OUTPUT)

FOLDER NAMING & ORDERING
- A folder counts as a CASE (and, inside it, a FRAME) only if its name CONTAINS A NUMBER: pure digits ("12"), a trailing "_<digits>" ("case_0001", "frame_3"), or a leading "<digits>_" ("12_patient", "0_scan"). The rest of the name is free text.
- Cases and frames are sorted by that number. A unit folder named exactly "minip" is always listed LAST.
- Hidden folders (starting with "."), folders with no number, and loose files are ignored.

========================================
COORDINATE CONVENTION (CRITICAL)
========================================
- Origin is top-left. x = column index (0 = left). y = row index (0 = top).
- Everything is H rows by W columns. Flat index = y*W + x. In NumPy terms shape = (H, W), so H = shape[0], W = shape[1].
- frames.png, label.npy, and mask.npy (if present) MUST all have EXACTLY the same width W and height H. If they disagree the tool shows that frame as a non-editable placeholder.

========================================
FILE: frames.png   (INPUT, required)
========================================
- Grayscale PNG of the DSA frame, size W x H.
- The tool reads the RED channel as the raw gray value 0-255; a standard 8-bit grayscale PNG is fine.
- Python: from PIL import Image; Image.fromarray(gray_uint8_HxW, mode="L").save("frames.png")

========================================
FILE: label.npy   (INPUT, required) -- the segmentation / "partition"
========================================
- A NumPy .npy array. 2-D, shape (H, W), C-order (row-major), little-endian.
- dtype: uint16 preferred (uint8 / int32 / uint32 also accepted). Fortran order is REJECTED.
- Pixel value = SEGMENT ID. 0 = background. 1..N = one id per vessel segment; EVERY pixel of a segment carries that segment's id.
- Segment ids are LOCAL to each frame (they start at 1 and are independent per unit): id 5 in frame_0 is unrelated to id 5 in frame_1.
- Python: import numpy as np; np.save("label.npy", label_HxW.astype(np.uint16))

========================================
FILE: mask.npy   (INPUT, optional) -- vessel foreground mask
========================================
- 2-D (H, W) uint8 of 0/1 (0 = background, 1 = vessel). Same W x H as label.npy.
- If present it MUST match the frames.png / label.npy size (see the shape contract above).
- Rendered as a blue overlay; also limits the pixel-paint brush when "foreground only" is on.
- Python: np.save("mask.npy", (label_HxW > 0).astype(np.uint8))

========================================
FILE: geometry.json   (INPUT + OUTPUT, optional) -- per-segment metrics + saved filter
========================================
- JSON. "segments" is keyed by SEGMENT ID (the SAME integer as the label.npy pixel value, written as a string; background 0 excluded). Each value is an OBJECT of named numeric metrics your pipeline computes -- any names, any count.
- Optional "filter" records the reviewer's last-used filter window: which metric + min + max. The tool WRITES this back when the reviewer drags the sliders. You may set a default (e.g. the first metric's full range) or omit it.
- The tool NEVER changes "segments"; it only writes "filter", and preserves any other fields.
- Example:
  {
    "segments": {
      "1": { "radius": 2.0, "length": 40 },
      "2": { "radius": 4.0, "length": 55 }
    },
    "filter": { "metric": "radius", "min": 2.0, "max": 4.0 }
  }
- Legacy form still accepted: { "metric": "radius", "segments": { "1": 2.0, "2": 4.0 } } (a bare number per segment = one metric named by "metric").

========================================
FILE: annotation.json   (tool OUTPUT -- format for reference)
========================================
{
  "schema_version": 5,
  "case": "<case folder name>",
  "unit": "<unit folder name>",
  "image_size": [W, H],
  "coord_order": "xy",              // "xy" => click = [x, y]; "yx" => click = [y, x]. Applies to collaterals[].click and points[].click, NEVER to paint.
  "collaterals": [                  // one entry per selected vessel segment
    { "id": 12, "click": [321, 187], "class": 2 }   // id = segment id in label.npy; "class" omitted when unclassified
  ],
  "points": [                       // background clicks (red dots that hit no segment)
    { "click": [40, 500], "class": 1 }
  ],
  "starred": true,                  // present (true) only when the frame is starred
  "paint": {                        // brush pixel layer; present only if painted
    "encoding": "rle_rows_v1",
    "axes": "run=[row,col,length]; row=y image row (0=top); col=x of run start (0=left); length=consecutive pixels toward +x",
    "width": W, "height": H,
    "classes": { "2": [[10,40,12],[11,39,14]] }     // class index -> list of runs [row, col, length]
  }
}

LAYERS (schema_version 6). A frame can hold MULTIPLE independent annotation layers.
- Exactly ONE layer -> the tool writes the flat v5 form above (fully backward compatible).
  A custom single-layer name is kept in an optional extra v5 field "layer_name": "<name>".
- TWO OR MORE layers -> schema_version 6: the per-layer content moves into "layers":
{
  "schema_version": 6,
  "case": "...", "unit": "...", "image_size": [W, H], "coord_order": "xy",
  "starred": true,                  // frame-level fields stay at the top level
  "active_layer": 1,                // id of the layer currently selected in the UI
  "layers": [
    { "id": 0, "name": "Layer 1",
      "collaterals": [ ... ],       // EXACTLY the v5 formats, per layer
      "points": [ ... ],
      "paint": { ... } },           // optional, same RLE as v5
    { "id": 1, "name": "Veins", "collaterals": [], "points": [] }
  ]
}
- "id" = stable integer per layer; "name" = display name. coord_order applies inside layers the same way; paint is never flipped.
- Frame-level data is NOT layered: "starred" stays top-level; note.json is one per frame.
- A reader must accept BOTH forms; ids need not be contiguous, and active_layer always references an existing id.

========================================
FILE: note.json   (tool OUTPUT)
========================================
{ "schema_version": 1, "coord_order": "xy",
  "text": "free-text note",
  "markers": [ { "id": 1, "click": [321, 187] } ] }   // numbered circle markers; id = the shown number

========================================
FILE: classes.json   (tool OUTPUT, at the dataset ROOT)
========================================
{ "classes": [ { "index": 1, "name": "Collateral A" } ] }
// index = the number stored in annotations ("class" fields and paint keys). Colors are NOT stored here.

========================================
MINIMAL GENERATOR (one valid frame), Python
========================================
  import numpy as np, json, os
  from PIL import Image
  H = W = 512
  gray  = (np.random.rand(H, W) * 255).astype(np.uint8)
  label = np.zeros((H, W), np.uint16)
  label[100:140, 50:400] = 1                 # segment 1
  label[200:260, 80:380] = 2                 # segment 2
  d = "case_0001/frame_0"; os.makedirs(d, exist_ok=True)
  Image.fromarray(gray, "L").save(d + "/frames.png")
  np.save(d + "/label.npy", label)                          # (H, W) uint16, C-order, little-endian
  np.save(d + "/mask.npy", (label > 0).astype(np.uint8))
  json.dump({"segments": {"1": {"radius": 3.0}, "2": {"radius": 5.0}},
             "filter": {"metric": "radius", "min": 3.0, "max": 5.0}},
            open(d + "/geometry.json", "w"), indent=2)

========================================
CHECKLIST FOR VALID INPUT DATA
========================================
[ ] Every frame folder has frames.png + label.npy (required). mask.npy and geometry.json are optional.
[ ] frames.png, label.npy, and mask.npy are all EXACTLY the same W x H.
[ ] label.npy is 2-D (H, W), C-order, little-endian, uint16 (or uint8/int32/uint32); 0 = background, 1..N = segment ids.
[ ] geometry.json keys equal the label.npy segment ids (as strings); each value is an object of numeric metrics.
[ ] Case and frame folder names contain a number; a unit named exactly "minip" is allowed and sorts last.
`;

  const S = {
    en: { btn: 'Data format…', title: 'On-disk data format', close: 'Close', html: EN_HTML,
          tabHuman: 'For humans', tabPrompt: 'Copy for an AI agent', copy: 'Copy prompt', copied: 'Copied ✓',
          promptIntro: 'Paste this to any AI agent (no prior context needed) so it can generate or read this dataset. The spec is exhaustive and self-contained.' },
    zh: { btn: '数据组织格式…', title: '磁盘数据组织格式', close: '关闭', html: ZH_HTML,
          tabHuman: '给人看', tabPrompt: '复制给 AI', copy: '复制 prompt', copied: '已复制 ✓',
          promptIntro: '把下面这段(英文完整规格)复制给任意 AI agent(无需任何背景),它就能生成或读取这套数据。' },
  };

  let overlay = null, bodyEl = null, titleEl = null, closeBtn = null;
  let promptEl = null, preEl = null, copyBtn = null, tabHumanBtn = null, tabPromptBtn = null, promptIntro = null, activeTab = 'human';
  const cur = () => S[window.I18n.getLang()] || S.en;

  function build() {
    overlay = document.createElement('div');
    overlay.id = 'dfModal';
    overlay.className = 'modal-overlay hidden';
    const box = document.createElement('div');
    box.className = 'modal doc-modal';
    const head = document.createElement('div'); head.className = 'doc-head';
    titleEl = document.createElement('h3'); titleEl.className = 'doc-title';
    const tabs = document.createElement('div'); tabs.className = 'doc-tabs';
    tabHumanBtn = document.createElement('button'); tabHumanBtn.className = 'btn sm'; tabHumanBtn.onclick = () => setTab('human');
    tabPromptBtn = document.createElement('button'); tabPromptBtn.className = 'btn sm'; tabPromptBtn.onclick = () => setTab('prompt');
    tabs.appendChild(tabHumanBtn); tabs.appendChild(tabPromptBtn);
    closeBtn = document.createElement('button'); closeBtn.className = 'btn sm'; closeBtn.onclick = close;
    head.appendChild(titleEl); head.appendChild(tabs); head.appendChild(closeBtn);
    // part 1: human-readable
    bodyEl = document.createElement('div'); bodyEl.className = 'doc-body';
    // part 2: copyable agent prompt
    promptEl = document.createElement('div'); promptEl.className = 'doc-prompt hidden';
    promptIntro = document.createElement('p'); promptIntro.className = 'doc-p';
    copyBtn = document.createElement('button'); copyBtn.className = 'btn sm'; copyBtn.onclick = copyPrompt;
    const wrap = document.createElement('div'); wrap.className = 'doc-prompt-wrap';
    preEl = document.createElement('pre'); preEl.className = 'doc-prompt-text'; preEl.textContent = PROMPT;
    wrap.appendChild(preEl);
    promptEl.appendChild(promptIntro); promptEl.appendChild(copyBtn); promptEl.appendChild(wrap);
    box.appendChild(head); box.appendChild(bodyEl); box.appendChild(promptEl);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  function setTab(which) {
    activeTab = which;
    bodyEl.classList.toggle('hidden', which !== 'human');
    promptEl.classList.toggle('hidden', which !== 'prompt');
    tabHumanBtn.classList.toggle('active', which === 'human');
    tabPromptBtn.classList.toggle('active', which === 'prompt');
  }
  function copyPrompt() {
    const done = () => { copyBtn.textContent = cur().copied; setTimeout(() => { copyBtn.textContent = cur().copy; }, 1500); };
    const fallback = () => { const r = document.createRange(); r.selectNodeContents(preEl); const s = getSelection(); s.removeAllRanges(); s.addRange(r); try { document.execCommand('copy'); } catch (e) {} s.removeAllRanges(); done(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(PROMPT).then(done, fallback);
    else fallback();
  }

  function renderText() {
    const t = cur();
    const btn = document.getElementById('btnDataFormat');
    if (btn) btn.textContent = t.btn;
    titleEl.textContent = t.title;
    closeBtn.textContent = t.close;
    tabHumanBtn.textContent = t.tabHuman;
    tabPromptBtn.textContent = t.tabPrompt;
    copyBtn.textContent = t.copy;
    promptIntro.textContent = t.promptIntro;
    bodyEl.innerHTML = t.html;
    setTab(activeTab);
  }

  const isOpen = () => overlay && !overlay.classList.contains('hidden');
  function open() { overlay.classList.remove('hidden'); }
  function close() { overlay.classList.add('hidden'); }

  function init() {
    build();
    renderText();
    const btn = document.getElementById('btnDataFormat');
    if (btn) btn.onclick = open;
    document.addEventListener('langchange', renderText);
    // capture phase: close on Escape before app-level key handling sees it
    document.addEventListener('keydown', e => {
      if (isOpen() && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }, true);
  }
  window.addEventListener('DOMContentLoaded', init);
})();
