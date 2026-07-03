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
│  ├─ frame_0/                  ← one frame · name must be frame_&lt;digits&gt;
│  │  ├─ frames.png             ← input · DSA frame image (grayscale PNG)
│  │  ├─ label.npy              ← input · segment-id map (this frame's segmentation)
│  │  ├─ mask.npy               ← input · 0/1 vessel mask (optional)
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
<li><code>schema_version</code> — format version (currently 5; files written by older versions 1–4 still import).</li>
<li><code>case</code> / <code>unit</code> — the folder names, for traceability.</li>
<li><code>image_size</code> — <code>[W, H]</code> of the frame.</li>
<li><code>coord_order</code> — how click coordinates are serialized (Settings → Coordinate order). <code>"xy"</code> → click = [x, y] (x = column from left, y = row from top); <code>"yx"</code> → click = [y, x]. Applies to <code>collaterals[].click</code> and <code>points[].click</code>, <b>never</b> to <code>paint</code>.</li>
<li><code>collaterals</code> — one entry per selected vessel segment: <code>id</code> = segment id in label.npy, <code>click</code> = the clicked coordinate, <code>class</code> = class index (omitted when unclassified).</li>
<li><code>points</code> — background clicks (red dots that hit no segment), same click/class format.</li>
<li><code>starred</code> — present (true) only when the frame is starred.</li>
<li><code>paint</code> — brush layer, row run-length encoded; present only if painted. <code>classes</code> maps class index → list of runs <code>[row, col, length]</code>: row = y (0 = top), col = x of the run start (0 = left), length = number of consecutive pixels toward +x. <code>width</code>/<code>height</code> record the encoding dimensions, and the <code>axes</code> field documents the run layout inside the file itself.</li>
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
│  ├─ frame_0/                  ← 一帧 · 名字必须是 frame_&lt;数字&gt;
│  │  ├─ frames.png             ← 输入 · DSA 帧图像（灰度 PNG）
│  │  ├─ label.npy              ← 输入 · 血管段 id 图（本帧自己的分割）
│  │  ├─ mask.npy               ← 输入 · 0/1 血管 mask（可选）
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
<li><code>schema_version</code> — 格式版本（当前为 5；旧版本 1–4 的文件仍可读入）。</li>
<li><code>case</code> / <code>unit</code> — 文件夹名，便于溯源。</li>
<li><code>image_size</code> — 本帧的 <code>[W, H]</code>。</li>
<li><code>coord_order</code> — 点击坐标的序列化顺序（设置 → 坐标顺序）。<code>"xy"</code> → click = [x, y]（x = 列，从左起；y = 行，从上起）；<code>"yx"</code> → click = [y, x]。只影响 <code>collaterals[].click</code> 和 <code>points[].click</code>，<b>永远不影响</b> <code>paint</code>。</li>
<li><code>collaterals</code> — 每个选中的血管段一条：<code>id</code> = label.npy 里的段 id，<code>click</code> = 点击坐标，<code>class</code> = 类别索引（未分类时省略）。</li>
<li><code>points</code> — 背景点击（没落在任何段上的红点），click/class 格式同上。</li>
<li><code>starred</code> — 仅在该帧被星标时存在（true）。</li>
<li><code>paint</code> — 笔刷图层，按行游程编码（RLE），涂过才存在。<code>classes</code> 把类别索引映射到游程列表 <code>[row, col, length]</code>：row = y（第几行，0 = 顶部），col = 游程起点的 x（第几列，0 = 左侧），length = 向 +x 方向连续的像素数。<code>width</code>/<code>height</code> 记录编码时的尺寸，<code>axes</code> 字段在文件内部自己说明了维度含义。</li>
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

  const S = {
    en: { btn: 'Data format…', title: 'On-disk data format', close: 'Close', html: EN_HTML },
    zh: { btn: '数据组织格式…', title: '磁盘数据组织格式', close: '关闭', html: ZH_HTML },
  };

  let overlay = null, bodyEl = null, titleEl = null, closeBtn = null;
  const cur = () => S[window.I18n.getLang()] || S.en;

  function build() {
    overlay = document.createElement('div');
    overlay.id = 'dfModal';
    overlay.className = 'modal-overlay hidden';
    const box = document.createElement('div');
    box.className = 'modal doc-modal';
    const head = document.createElement('div'); head.className = 'doc-head';
    titleEl = document.createElement('h3'); titleEl.className = 'doc-title';
    closeBtn = document.createElement('button'); closeBtn.className = 'btn sm'; closeBtn.onclick = close;
    head.appendChild(titleEl); head.appendChild(closeBtn);
    bodyEl = document.createElement('div'); bodyEl.className = 'doc-body';
    box.appendChild(head); box.appendChild(bodyEl);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  function renderText() {
    const t = cur();
    const btn = document.getElementById('btnDataFormat');
    if (btn) btn.textContent = t.btn;
    titleEl.textContent = t.title;
    closeBtn.textContent = t.close;
    bodyEl.innerHTML = t.html;
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
