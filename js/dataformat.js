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
├─ .annotator_dataset.json      ← output · hidden; a stable id tying your saved progress to this folder
├─ case_0001/                   ← one case · any name carrying a number (e.g. case_0001, 12_patient)
│  ├─ frame_0/                  ← one frame · any name carrying a number (e.g. frame_0, 3_dsa)
│  │  ├─ frames.png             ← input · DSA frame image (grayscale PNG)
│  │  ├─ label.npy              ← input · segment-id map (this frame's segmentation)
│  │  ├─ mask.npy               ← input · 0/1 vessel mask (optional)
│  │  ├─ geometry.json          ← input+output · per-segment metrics + saved filter (optional)
│  │  ├─ annotation.json        ← output · your annotations for this frame
│  │  ├─ (recovery copies)      ← output · *.corrupt / *.unsaved-backup.json, only when needed
│  │  └─ note.json              ← output · frame note + numbered markers
│  ├─ frame_1/ …
│  ├─ minip/                    ← minimum-intensity projection · same files, listed last
│  └─ (perfusion)               ← computed by the tool · view-only, NO files on disk, listed after minip
└─ case_0002/ …</pre>
<div class="doc-sec"><h4>Discovery rules</h4><ul>
<li>A folder is a case (and, inside it, a frame) if its name carries a number — pure digits, a trailing <code>_&lt;digits&gt;</code>, or a leading <code>&lt;digits&gt;_</code>. The rest of the name is free (e.g. <code>case_0001</code>, <code>frame_3</code>, <code>12_patient</code>, <code>0_scan</code>). A unit folder named exactly <code>minip</code> is also loaded.</li>
<li>Frames sort by that number (frame_2 before frame_10); <code>minip</code> is always last; cases sort by their number. Hidden folders (starting with <code>.</code>), folders with no number, and files are ignored.</li>
</ul></div>
<div class="doc-sec"><h4><code>frames.png</code> — input, required</h4><ul>
<li>The DSA frame as a grayscale PNG. The tool reads the <b>red channel</b> as the raw gray value (0–255) for contrast windowing and the inspect loupe.</li>
<li>Width/height must exactly match <code>label.npy</code> (W = shape[1], H = shape[0]). If they disagree, the frame is <b>not</b> opened for editing — it shows a grey placeholder panel listing the three shapes (see “Shape rule” under <code>mask.npy</code>).</li>
</ul></div>
<div class="doc-sec"><h4><code>label.npy</code> — input, required</h4><ul>
<li>NumPy 2-D array, shape <code>(H, W)</code>, C-order, little-endian. dtype <code>uint16</code> (uint8 / int32 / uint32 also accepted; fortran_order is rejected).</li>
<li>Pixel value 0 = background; 1…N = segment id. Segmentation is <b>per-frame</b> — ids do not correspond across frames. The Click tool selects the segment id under the cursor.</li>
</ul></div>
<div class="doc-sec"><h4><code>mask.npy</code> — input, optional</h4><ul>
<li>2-D <code>(H, W)</code> uint8 array of 0/1: the vessel mask. Rendered as the bright-blue overlay; also limits the brush when “Foreground only” is checked.</li>
<li><b>Shape rule:</b> <code>frames.png</code>, <code>label.npy</code>, and <code>mask.npy</code> (when present) must all share one H×W. If any disagree, the frame becomes a view-only grey placeholder that lists the shapes — it is never annotated or saved.</li>
<li>If <code>mask.npy</code> is <b>absent</b> there is simply no overlay (everything else works). If it is <b>present</b> it must match exactly — a present mask with a different shape, or one that is truncated / non-2-D, triggers the placeholder above (it is <em>not</em> silently ignored).</li>
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
<li><b>If the file is missing entirely</b>, the tool still opens the dataset, then invents a <b>random name</b> for every class index it finds in the annotations and writes a new <code>classes.json</code>. Ship this file with the data — otherwise two copies of the same dataset end up with different class names.</li>
</ul></div>
<div class="doc-sec"><h4><code>.annotator_dataset.json</code> — output, dataset root</h4>
<pre class="doc-tree">{ "id": "d3f1a2…" }</pre>
<ul>
<li>Hidden file created the first time you open the folder. Your in-browser progress (visited flags, unsaved edits, per-frame layer choice) is keyed to this id, so two different datasets that both use <code>case_1/frame_0</code> never bleed into each other.</li>
<li>Safe to delete — a new id is minted on next open, which resets only the browser-side state, never the annotations on disk. Safe to leave out of an archive.</li>
</ul></div>
<div class="doc-sec"><h4>Recovery files — output, written only when something is wrong</h4>
<p class="doc-p">The tool never discards work silently. Four files exist purely so that a bad file or a lost race is always recoverable. In normal use you will never see any of them.</p>
<ul>
<li><code>annotation.json.corrupt</code> (in the frame) — an <code>annotation.json</code> that cannot be parsed is copied here <b>once</b>, before anything overwrites it. The frame opens with a warning and shows no marks until the file is fixed.</li>
<li><code>classes.json.corrupt</code> (at the root) — same, for an unparseable <code>classes.json</code>. The tool will not auto-overwrite it with placeholder names until the original is safely copied.</li>
<li><code>annotation.unsaved-backup.json</code> / <code>note.unsaved-backup.json</code> (in the frame) — if you have unsaved edits in the browser and the file on disk turns out to be <b>newer</b> (someone else saved, or another tab did), your edits are written here rather than being dropped or blindly overwriting the newer file.</li>
</ul>
<p class="doc-p">None of these are read back automatically. Inspect them yourself and merge by hand.</p></div>
<div class="doc-sec"><h4>The <code>perfusion</code> unit — computed, not read from disk</h4><ul>
<li>Every case gets one extra unit after <code>minip</code>, computed from that case's frames. It has <b>no folder and no files</b>; do not create one. It is view-only: no label, no mask, no geometry panel, and it can never be annotated or saved.</li>
<li>The smoothness slider re-colours it live. It can be downloaded as <code>&lt;case&gt;_perfusion.png</code> — that is a browser download, not a file in the dataset.</li>
</ul></div>
<div class="doc-sec"><h4>Failures that are SILENT — read this before generating data</h4>
<p class="doc-p">Most malformed input produces a visible warning. These three do not:</p>
<ul>
<li><b>Paint at the wrong size is discarded without a word.</b> If <code>paint.width</code>/<code>paint.height</code> differ from the frame's W/H, the brush layer is simply not decoded — no marks, no warning, no error. (The stored RLE is preserved verbatim, so a load-and-save cannot destroy it.) Always write <code>width</code>/<code>height</code> from the array you encoded.</li>
<li><b>A folder whose name carries no number is skipped without a word.</b> Names like <code>s0</code> or <code>f1</code> match none of the discovery patterns and never appear in the UI.</li>
<li><b>A missing <code>classes.json</code> is silently replaced</b> by one with invented names, as described above.</li>
</ul>
<p class="doc-p">By contrast, a <b>H×W disagreement</b> between <code>frames.png</code>, <code>label.npy</code> and <code>mask.npy</code> is loud: that frame becomes a grey read-only placeholder listing the three shapes.</p></div>
<div class="doc-sec"><h4>Segment ids are not stable identifiers</h4>
<p class="doc-p"><code>collaterals[].id</code> and the keys of <code>geometry.json</code> store <b>only a number</b>. The shape they refer to lives in <code>label.npy</code> and is looked up at display time. So if <code>label.npy</code> is regenerated, every existing selection silently points at whatever segment now carries that number.</p>
<ul>
<li>Ids are assigned deterministically by position, so a <b>small</b> change is harmless: re-running the same partition, removing one pixel, or adding a speck elsewhere leaves every id intact (measured).</li>
<li>Replacing the <b>mask</b> — a better segmentation model, a changed partition rule — renumbers essentially everything. Measured on four sequences after swapping one vessel model for another, of the pixels that are foreground in <b>both</b> masks, the fraction keeping their old id was <b>0.73 %, 0.01 %, 0.00 %, 0.00 %</b>.</li>
<li>Therefore: <b>never regenerate <code>label.npy</code> in place for a unit that already has an <code>annotation.json</code>.</b> Build a new dataset folder instead.</li>
<li><b>Paint is immune</b> — it stores pixels, not ids. If annotations must survive a future re-partition, import them as paint. A segment-level view is recoverable from paint at any threshold: <code>(paint &amp; (label == i)).sum() / (label == i).sum()</code>.</li>
</ul></div>
<div class="doc-sec"><h4>Splitting the work across several annotators</h4>
<p class="doc-p">Cases can be handed out in separate folders and merged back afterwards. Case numbers do <b>not</b> need to start at any particular value or be contiguous — the number is used only for ordering.</p>
<ul>
<li>Give every package <b>its own copy of <code>classes.json</code></b>, or each one invents its own class names.</li>
<li>Keep each case whole — all of its frames and its <code>minip</code> go to one person.</li>
<li>Merging is a plain copy: case folder names are unique, so nothing collides. Take the <b>union</b> of the <code>classes.json</code> files if anyone added a class.</li>
<li>What comes back changed: <code>annotation.json</code>, <code>note.json</code>, the <code>filter</code> block of <code>geometry.json</code>, <code>classes.json</code>, and <code>.annotator_dataset.json</code>. Nothing else is ever written.</li>
</ul></div>
<div class="doc-sec"><h4>Copying an annotation from another frame</h4><ul>
<li>The <b>Copy from frame</b> button only writes into a <b>completely empty</b> frame — it is disabled if the frame holds any segment, point or paint on <em>any</em> layer, or any numbered marker. (A star or a note does not block it.)</li>
<li>Erasing a frame's content fully re-enables it. So a dataset shipped with pre-filled annotations has that button disabled until the frame is cleared.</li>
</ul></div>`;

  const ZH_HTML = `
<p class="doc-p">用“打开数据文件夹”选中的文件夹就是数据根目录。<b>输入</b>（图像 + 分割）由你的预处理流水线生成；<b>输出</b>由本工具写入。每个帧文件夹都是自包含的。</p>
<pre class="doc-tree">&lt;数据根目录&gt;/                 ← “打开数据文件夹”选的就是它
├─ classes.json                 ← 输出 · 类别定义（全数据集共用）
├─ .annotator_dataset.json      ← 输出 · 隐藏文件；把你的进度绑定到这个文件夹的稳定 id
├─ case_0001/                   ← 一个病例 · 名字带数字即可(如 case_0001、12_patient)
│  ├─ frame_0/                  ← 一帧 · 名字带数字即可(如 frame_0、3_dsa)
│  │  ├─ frames.png             ← 输入 · DSA 帧图像（灰度 PNG）
│  │  ├─ label.npy              ← 输入 · 血管段 id 图（本帧自己的分割）
│  │  ├─ mask.npy               ← 输入 · 0/1 血管 mask（可选）
│  │  ├─ geometry.json          ← 输入+输出 · 每段参数 + 保存的过滤区间（可选）
│  │  ├─ annotation.json        ← 输出 · 本帧的标注结果
│  │  ├─ (恢复副本)              ← 输出 · *.corrupt / *.unsaved-backup.json，仅在需要时产生
│  │  └─ note.json              ← 输出 · 本帧笔记 + 编号标记
│  ├─ frame_1/ …
│  ├─ minip/                    ← 最小强度投影 · 文件相同，排在最后
│  └─ (perfusion)               ← 工具计算得出 · 只读，磁盘上没有文件，排在 minip 之后
└─ case_0002/ …</pre>
<div class="doc-sec"><h4>扫描规则</h4><ul>
<li>只要文件夹名<b>带数字</b>就算病例(以及病例里的帧)——纯数字、结尾 <code>_&lt;数字&gt;</code>、或开头 <code>&lt;数字&gt;_</code> 都行,前后缀随意(如 <code>case_0001</code>、<code>frame_3</code>、<code>12_patient</code>、<code>0_scan</code>)。名为 <code>minip</code> 的单元也会加载。</li>
<li>帧按该数字排序(frame_2 在 frame_10 前);<code>minip</code> 永远排最后;病例按编号排序。隐藏文件夹(以 <code>.</code> 开头)、不带数字的文件夹、以及文件一律忽略。</li>
</ul></div>
<div class="doc-sec"><h4><code>frames.png</code> — 输入，必需</h4><ul>
<li>DSA 帧图像，灰度 PNG。工具读取其<b>红色通道</b>作为原始灰度值（0–255），用于窗宽窗位和检视放大镜。</li>
<li>宽高必须与 <code>label.npy</code> 完全一致（W = shape[1]，H = shape[0]）。若不一致，该帧<b>不</b>进入编辑，而是显示一个灰色占位面板列出三者的尺寸（见 <code>mask.npy</code> 下的“尺寸规则”）。</li>
</ul></div>
<div class="doc-sec"><h4><code>label.npy</code> — 输入，必需</h4><ul>
<li>NumPy 二维数组，shape <code>(H, W)</code>，C 序、小端。dtype <code>uint16</code>（也接受 uint8 / int32 / uint32；fortran_order 会报错）。</li>
<li>像素值 0 = 背景；1…N = 血管段 id。分割是<b>逐帧</b>的 — id 在不同帧之间没有对应关系。点选工具选中的就是光标下的段 id。</li>
</ul></div>
<div class="doc-sec"><h4><code>mask.npy</code> — 输入，可选</h4><ul>
<li>二维 <code>(H, W)</code> uint8 的 0/1 血管 mask。显示为亮蓝叠加层；勾选“仅前景”时限制笔刷范围。</li>
<li><b>尺寸规则：</b><code>frames.png</code>、<code>label.npy</code>、以及存在时的 <code>mask.npy</code> 必须同为一个 H×W。任一不符，该帧就变成只读的灰色占位面板并列出各自尺寸，不会被标注或保存。</li>
<li><code>mask.npy</code> <b>缺失</b>时只是没有叠加层（其它功能正常）；<b>存在</b>时必须尺寸完全一致——存在但尺寸不符、或被截断/非二维的 mask 会触发上面的占位面板，<em>不是</em>静默忽略。</li>
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
<li><b>如果这个文件整个缺失</b>，工具照样能打开数据集，然后给标注里出现的每个类别序号<b>随机编一个名字</b>并写出一份新的 <code>classes.json</code>。请务必随数据一起分发 — 否则同一份数据的两个副本会得到不同的类别名。</li>
</ul></div>
<div class="doc-sec"><h4><code>.annotator_dataset.json</code> — 输出，位于数据根目录</h4>
<pre class="doc-tree">{ "id": "d3f1a2…" }</pre>
<ul>
<li>第一次打开该文件夹时创建的隐藏文件。你在浏览器里的进度（已访问标记、未保存的修改、每帧的图层选择）都以这个 id 为键，所以两份都用 <code>case_1/frame_0</code> 命名的不同数据集不会互相串扰。</li>
<li>可以放心删除 — 下次打开会重新生成一个新 id，只会重置浏览器端的状态，<b>绝不影响</b>磁盘上的标注。打包时不带也没关系。</li>
</ul></div>
<div class="doc-sec"><h4>恢复文件 — 输出，只在出问题时产生</h4>
<p class="doc-p">工具从不静默丢弃工作。下面四个文件存在的唯一目的，就是让「文件坏了」或「写入撞车」永远可恢复。正常使用时你一个都不会见到。</p>
<ul>
<li><code>annotation.json.corrupt</code>（在帧文件夹里）—— 无法解析的 <code>annotation.json</code> 会在被任何东西覆盖之前<b>备份一次</b>到这里。该帧带警告打开，在文件修好之前不显示任何标记。</li>
<li><code>classes.json.corrupt</code>（在根目录）—— 同理，针对无法解析的 <code>classes.json</code>。在原文件被安全备份之前，工具不会用占位名去自动覆盖它。</li>
<li><code>annotation.unsaved-backup.json</code> / <code>note.unsaved-backup.json</code>（在帧文件夹里）—— 如果你在浏览器里有未保存的改动，而磁盘上的文件却<b>更新</b>（别人保存了，或另一个标签页写了），你的改动会写到这里，而不是被丢掉、也不会盲目覆盖那个更新的文件。</li>
</ul>
<p class="doc-p">这些文件都不会被自动读回。请自己查看并手动合并。</p></div>
<div class="doc-sec"><h4><code>perfusion</code> 单元 — 计算得出，不来自磁盘</h4><ul>
<li>每个病例在 <code>minip</code> 之后会自动多出一个单元，由该病例的各帧计算得到。它<b>没有文件夹、没有文件</b>，不要去创建。它是只读的：没有 label、没有 mask、没有几何面板，永远不能标注也不会保存。</li>
<li>平滑度滑块会实时重新着色。可以下载为 <code>&lt;case&gt;_perfusion.png</code> — 那是浏览器下载，不是数据集里的文件。</li>
</ul></div>
<div class="doc-sec"><h4>会「静默失败」的三件事 — 生成数据前务必读</h4>
<p class="doc-p">大部分格式错误都会给出可见的提示。下面三种<b>不会</b>：</p>
<ul>
<li><b>尺寸不对的 paint 会被无声丢弃。</b> 只要 <code>paint.width</code>/<code>paint.height</code> 和该帧的 W/H 不一致，画笔图层就直接不解码 —— 不显示、不警告、不报错。（原始 RLE 会原样保留，所以「打开再保存」不会破坏它。）<code>width</code>/<code>height</code> 一定要写你实际编码的那个数组的尺寸。</li>
<li><b>名字里不带数字的文件夹会被无声跳过。</b> 像 <code>s0</code>、<code>f1</code> 这样的名字不匹配任何一条扫描规则，根本不会出现在界面里。</li>
<li><b>缺失的 <code>classes.json</code> 会被无声替换</b>成一份随机命名的，见上。</li>
</ul>
<p class="doc-p">相比之下，<code>frames.png</code>、<code>label.npy</code>、<code>mask.npy</code> 三者<b>H×W 不一致</b>是有明确提示的：该帧会变成灰色只读占位面板，并列出三个尺寸。</p></div>
<div class="doc-sec"><h4>segment id 不是稳定标识符</h4>
<p class="doc-p"><code>collaterals[].id</code> 和 <code>geometry.json</code> 的键都<b>只存一个数字</b>，它对应的形状在 <code>label.npy</code> 里、显示时才去查。所以一旦 <code>label.npy</code> 被重新生成，已有的每一条选择都会静默地指向「现在恰好叫这个号」的那一段。</p>
<ul>
<li>id 是按位置确定性发号的，所以<b>小改动无害</b>：同一份分区重跑、删掉一个像素、在别处加一个斑点，实测每个 id 都原封不动。</li>
<li>但<b>换掉 mask</b> —— 换一个更好的分割模型、改一条分区规则 —— 会让编号几乎全部重排。实测四个序列在更换血管模型后，在两张 mask 里<b>都</b>是前景的那些像素中，保住原 id 的比例是 <b>0.73 %、0.01 %、0.00 %、0.00 %</b>。</li>
<li>因此：<b>绝不要对已经有 <code>annotation.json</code> 的单元原地重新生成 <code>label.npy</code></b>。请另建一个新的数据集文件夹。</li>
<li><b>paint 不受影响</b> —— 它存的是像素，不是 id。如果标注需要在未来的重新分区中存活，就用 paint 导入。段级视图随时可以从 paint 按任意阈值还原：<code>(paint &amp; (label == i)).sum() / (label == i).sum()</code>。</li>
</ul></div>
<div class="doc-sec"><h4>多人分工标注：拆分与合并</h4>
<p class="doc-p">病例可以拆成几个文件夹分发，标完再合并。病例编号<b>不需要</b>从某个特定值开始，也<b>不需要</b>连续 —— 这个数字只用来排序。</p>
<ul>
<li>每个分包都要带<b>自己的一份 <code>classes.json</code></b>，否则每个人会各自编出不同的类别名。</li>
<li>每个病例必须整体分给同一个人 —— 它的所有帧和 <code>minip</code> 不能拆开。</li>
<li>合并就是直接复制：病例文件夹名唯一，不会冲突。如果有人加过类别，<code>classes.json</code> 要取<b>并集</b>。</li>
<li>会被改动的只有：<code>annotation.json</code>、<code>note.json</code>、<code>geometry.json</code> 的 <code>filter</code> 块、<code>classes.json</code>、以及 <code>.annotator_dataset.json</code>。除此之外工具不写任何文件。</li>
</ul></div>
<div class="doc-sec"><h4>从其他帧复制标注</h4><ul>
<li><b>从其他帧复制</b>按钮只能写入<b>完全空白</b>的帧 —— 只要该帧在<em>任何</em>图层上有 segment、点或 paint，或者有编号标记，按钮就是禁用的。（打星或写笔记不影响。）</li>
<li>把该帧内容全部擦掉后按钮会重新可用。所以一份带预填标注的数据集，这个按钮在清空该帧之前是用不了的。</li>
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
  .annotator_dataset.json     (tool OUTPUT, hidden; do not create one)
  <case folder>/              (one per case)
    <unit folder>/            (one per frame; plus optional "minip")
      frames.png              (INPUT, required)
      label.npy               (INPUT, required)
      mask.npy                (INPUT, optional)
      geometry.json           (INPUT + OUTPUT, optional)
      annotation.json         (tool OUTPUT)
      note.json               (tool OUTPUT)
      annotation.json.corrupt          (tool OUTPUT, recovery -- see below)
      annotation.unsaved-backup.json   (tool OUTPUT, recovery -- see below)
      note.unsaved-backup.json         (tool OUTPUT, recovery -- see below)

RECOVERY FILES. Written only when something is wrong; never read back
automatically; never create them yourself.
  annotation.json.corrupt / classes.json.corrupt (the latter at the root) -- an
    unparseable file is copied here ONCE before anything overwrites it.
  annotation.unsaved-backup.json / note.unsaved-backup.json -- if the browser
    holds unsaved edits and the file on disk turns out to be NEWER, the edits are
    written here instead of being dropped or overwriting the newer file.

Do NOT create a "perfusion" folder. The tool appends one computed, view-only
"perfusion" unit to every case, after minip. It has no files on disk, no label,
no mask and no geometry, and can never be annotated.

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
[ ] classes.json is shipped WITH the data, declaring every class index the annotations use.
[ ] Any paint block's width/height equal that frame's W/H.

========================================
FAILURES THAT ARE SILENT -- CHECK THESE, NOTHING WILL WARN YOU
========================================
Most malformed input produces a visible warning. These do not:
- PAINT AT THE WRONG SIZE IS DISCARDED. If paint.width/paint.height differ from
  the frame's W/H the brush layer is simply not decoded: no marks, no warning,
  no error. The stored RLE is preserved verbatim, so load+save cannot destroy
  it, but nothing is shown. Always write width/height from the array you encoded.
- A FOLDER WHOSE NAME CARRIES NO NUMBER IS SKIPPED. Names like "s0" or "f1"
  match none of the discovery patterns and never appear in the UI at all.
- A MISSING classes.json IS SILENTLY REPLACED. The tool invents a RANDOM name
  for every class index found in the annotations and writes a new classes.json.
  Two copies of one dataset then disagree on class names.
By contrast a W x H disagreement between frames.png / label.npy / mask.npy is
loud: that frame becomes a grey read-only placeholder listing the three shapes.

========================================
SEGMENT IDS ARE NOT STABLE IDENTIFIERS
========================================
collaterals[].id and the keys of geometry.json store ONLY a number. The shape it
refers to lives in label.npy and is resolved at display time. Regenerating
label.npy therefore re-points every existing selection at whatever segment now
carries that number -- silently.
- Ids are assigned deterministically by position, so SMALL changes are harmless:
  re-running the same partition, deleting one pixel, or adding a speck elsewhere
  leaves every id intact (measured).
- Replacing the MASK -- a better segmentation model, a changed partition rule --
  renumbers essentially everything. Measured on four sequences after swapping one
  vessel model for another, of the pixels that are foreground in BOTH masks the
  fraction that kept its old id was 0.73 %, 0.01 %, 0.00 %, 0.00 %.
- So: NEVER regenerate label.npy in place for a unit that already has an
  annotation.json. Build a new dataset folder instead.
- PAINT IS IMMUNE: it stores pixels, not ids. If annotations must survive a
  future re-partition, import them as paint. A segment-level view is recoverable
  from paint at any threshold:
      (paint & (label == i)).sum() / (label == i).sum()

========================================
SPLITTING THE WORK ACROSS SEVERAL ANNOTATORS
========================================
Cases can be handed out as separate folders and merged back. Case numbers need
not start at any particular value and need not be contiguous -- the number is
used only for ordering.
- Give every package its own copy of classes.json, or each invents its own names.
- Keep each case whole: all of its frames and its minip go to one person.
- Merging is a plain copy; case folder names are unique so nothing collides. Take
  the UNION of the classes.json files if anyone added a class.
- What comes back changed: annotation.json, note.json, the "filter" block of
  geometry.json, classes.json, .annotator_dataset.json. Nothing else is written.

========================================
COPY FROM FRAME
========================================
The tool's "Copy from frame" button only writes into a COMPLETELY EMPTY frame --
it is disabled if the frame holds any segment, point or paint on ANY layer, or
any numbered marker (a star or a note does not block it). Erasing the frame fully
re-enables it. A dataset shipped with pre-filled annotations therefore has that
button disabled until the frame is cleared.
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
