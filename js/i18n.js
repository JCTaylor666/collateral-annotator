// i18n.js — language dictionary + apply/switch logic. English is the default language;
// Chinese is available as an alternate via the switcher in the top-right of the header.
// Static labels are tagged with data-i18n / data-i18n-title / data-i18n-placeholder /
// data-i18n-html in index.html and re-rendered by applyStatic(). Dynamic/data-driven text
// (banners, save status, counts, etc.) is built by app.js at the call site via I18n.t(),
// and re-rendered on the 'langchange' event app.js listens for.
(function () {
  'use strict';

  const DICT = {
    en: {
      pageTitle: 'Vessel Annotator',
      railToggleTitle: 'Collapse/expand sidebar (\\)',
      brand: 'Vessel Annotator',
      notLoaded: 'Not loaded',
      rpanelToggleTitle: 'Collapse/expand annotation panel',

      btnOpen: 'Open data folder',
      btnSave: 'Save to folder',

      navLabel: 'Navigation',
      prevCaseTitle: 'Previous case',
      prevUnit: '‹ Prev',
      nextUnit: 'Next ›',
      nextCaseTitle: 'Next case',

      contrastLabel: 'Contrast',
      winCenterLabel: 'Center',
      winWidthLabel: 'Width',
      btnAuto: 'Auto',
      btnWinReset: 'Reset window',

      grpOverlay: 'Overlay',
      opacityLabel: 'Highlight opacity',
      maskOpacityLabel: 'Vessel mask',

      grpLoupe: 'Inspect loupe',
      loupeZoomLabel: 'Zoom',
      loupeRLabel: 'Neighbor frames',
      loupeSizeLabel: 'View size',
      loupeMeanLabel: '3×3 mean',
      pinMinipLabel: 'Pin minip in loupe',
      pinPerfusionLabel: 'Pin perfusion in loupe',
      exportPerfusion: 'Export perfusion map',
      perfCap: 'perfusion',
      perfFailed: 'Could not compute the perfusion map for this case (needs ≥2 same-size frames).',
      loupeHoldHintShort: 'Hold Cmd/Ctrl to inspect (release to close; click-to-annotate still works while inspecting)',

      grpView: 'View',
      btnFitTitle: 'Reset zoom/pan',
      btnFit: 'Reset view',

      grpEdit: 'Edit',
      btnUndo: 'Undo',
      btnClear: 'Clear this unit',

      grpClasses: 'Class management',
      classNamePlaceholder: 'Class name',
      btnAddClass: 'Add',

      grpSettings: 'Settings',
      coordOrderLabel: 'Coordinate order',
      autoSaveLabel: 'Auto-save (write to disk on change)',

      grpHelp: 'Help / Legend',
      helpText: 'Click a vessel segment to mark it as collateral (click again to remove). Every click leaves a red dot marking its coordinate; clicking background (no vessel) also leaves a red dot — click near an existing red dot to delete it. Zoom: wheel/pinch; pan: left-drag/two-finger. Colors: vessel mask = bright blue, selected = green, hover = orange, red dot = click location.',

      btnCopyFrom: 'Copy from another frame…',
      btnCancelCopy: 'Cancel copy',

      toolsLabel: 'Annotation tool',
      toolClick: 'Click',
      toolBrush: 'Paint',
      clickSingle: 'Single',
      clickBrush: 'Brush',
      selAdd: 'Select',
      selErase: 'Deselect',
      selRadiusLabel: 'Radius',
      selBrushHint: 'Left-drag to select every segment the brush touches (uses the active class); pan with wheel/two-finger, or hold Space + left-drag.',
      brushAdd: 'Paint',
      brushErase: 'Erase',
      brushRadiusLabel: 'Radius',
      brushOnmaskLabel: 'Foreground only (within vessel mask)',
      brushHint: 'Left-drag = paint (uses the active class’s color); pan with wheel/two-finger, or hold Space + left-drag.',

      classesLabel: 'Annotation class (click to activate; swatch on the left picks its color)',
      noteLabel: 'Notes',
      btnSaveNote: 'Save notes',
      notePlaceholder: 'Notes for this frame, saved to note.json in the frame folder',
      btnAddMarker: 'Add marker',
      markerPlaceHint: 'Click on the image to place marker {n} (Esc to cancel).',
      markerDelete: 'Delete this marker',

      loupeHoldHintLong: 'Hold Cmd/Ctrl for detail · release to close · click-to-annotate still works while inspecting',
      loupeCrossFrameHint: 'Cross-frame raw grayscale (right of dashed line = minip projection)',
      loupeMismatch: 'Size mismatch',
      loupeLoading: 'Loading…',

      clearConfirmHtml: 'Really clear?<br>Clearing removes all annotations for this frame.',
      btnClearContinue: 'Continue clearing',
      btnCancel: 'Cancel',

      errNoCases: 'No case_* folders found. Please choose a data root containing case_0001 etc.',
      scanningExisting: 'Scanning existing annotations…',
      errOpenFailed: 'Open failed: {msg}',
      errLoadUnitFailed: '{id} failed to load: {msg}',
      classesSaved: 'Classes saved {time}',
      classesSaveFailed: 'Failed to save classes',
      unnamedPrefix: 'Unnamed-',
      classInUse: "Class {idx} is already used in annotations and can't be deleted (remove the related annotations first, or save, then delete).",
      noClassesYetMgr: 'No classes yet — type a name and click “Add”.',
      btnDelete: 'Delete',
      noClassesYetPicker: 'Add a class in the left sidebar’s “Class management” section, then pick the active class and its color here.',
      copyPickHint: 'Click the frame on the left to copy annotations from (Esc to cancel).',
      copyNoAnnotations: '“{id}” has no annotations to copy.',
      copyDone: '“{id}” copied and re-resolved: {segs} segments · {pts} points{dropped}',
      copyDoneDropped: ' ({n} with no class skipped)',
      errOpenFolderFirst: 'Open a data folder first.',
      noteSaved: 'Notes saved {time}',
      noteSaveFailed: 'Failed to save notes',
      unitIndicatorFmt: 'Unit {ui}/{uc} · Case {ci}/{cc}',
      none: 'None',
      progressFmt: '{segs} segments marked · {pts} points',
      saving: 'Saving…',
      saved: 'Saved {time}',
      saveFailed: 'Save failed',
      saveFailedMsg: 'Save failed: {msg}',
      starThisFrame: 'Star this frame',
      cursorSeg: 'Cursor seg {seg}',
      cursorOutside: 'Cursor outside image',
      projectionSuffix: ' (projection)',
      errPickClassFirst: 'Pick a class in “Annotation class” on the right before painting.',
      errNoWritePermission: "No write permission — can't save.",
      savedAllFmt: "Saved {n} units' annotation.json to their folders.",
      unsavedDot: '●Unsaved',
      synced: 'Synced',
      pendingSave: 'Pending save…',
      autoSaveFailed: 'Auto-save failed',
      errUnsupportedBrowser: "This browser doesn't support writing to disk (File System Access API). Please open this page in Chrome or Edge.",
      classFallbackName: 'Class {idx}',
      errQuotaFull: 'Browser local backup is full — unsaved changes are no longer being kept across reloads. Save to the folder now.',
      datasetSwitched: 'New dataset opened; unsaved in-memory changes from the previous dataset were discarded.',
      annCorrupt: '{id}: annotation.json is unreadable and was left as-is (it will be backed up to annotation.json.corrupt before any save). This frame shows no marks until the file is fixed.',
      classesCorrupt: 'classes.json is unreadable and was left untouched (class names not regenerated). Fix the file to restore your class names.',
      maskBad: '{id}: mask.npy is present but unreadable — the vessel-mask overlay and the brush “foreground only” limit are off for this frame.',
      savedPartial: 'Saved {n} units; {failed} failed (unreadable or missing files) — those were left untouched.'
    },
    zh: {
      pageTitle: '血管标注器',
      railToggleTitle: '折叠/展开侧栏（\\）',
      brand: '血管标注器',
      notLoaded: '未载入',
      rpanelToggleTitle: '折叠/展开右侧标注面板',

      btnOpen: '打开数据文件夹',
      btnSave: '保存到文件夹',

      navLabel: '导航',
      prevCaseTitle: '上一病例',
      prevUnit: '‹ 上一',
      nextUnit: '下一 ›',
      nextCaseTitle: '下一病例',

      contrastLabel: '影像对比度',
      winCenterLabel: '窗中心',
      winWidthLabel: '窗宽',
      btnAuto: '自动',
      btnWinReset: '复位窗',

      grpOverlay: '叠加层',
      opacityLabel: '高亮透明度',
      maskOpacityLabel: '血管mask',

      grpLoupe: '检视放大镜',
      loupeZoomLabel: '放大率',
      loupeRLabel: '前后帧数',
      loupeSizeLabel: '视野大小',
      loupeMeanLabel: '3×3均值',
      pinMinipLabel: '放大镜固定显示 minip',
      pinPerfusionLabel: '放大镜固定显示灌注图',
      exportPerfusion: '导出灌注图',
      perfCap: '灌注',
      perfFailed: '无法为该病例计算灌注图(需要至少 2 张同尺寸的帧)。',
      loupeHoldHintShort: '按住 Cmd/Ctrl 检视（松开关闭，检视时仍可点击标注）',

      grpView: '视图',
      btnFitTitle: '复位缩放/平移',
      btnFit: '复位视图',

      grpEdit: '编辑',
      btnUndo: '撤销',
      btnClear: '清空本单元',

      grpClasses: '分类管理',
      classNamePlaceholder: '类别名称',
      btnAddClass: '添加',

      grpSettings: '设置',
      coordOrderLabel: '坐标顺序',
      autoSaveLabel: '自动保存（改动后自动写盘）',

      grpHelp: '帮助 / 图例',
      helpText: '点击血管段即标为侧支（再点取消）。点击处会留红点记录坐标；点背景（无血管）也会留红点，在红点附近再点即删除。缩放：滚轮/捷合；平移：左键拖动/双指。颜色：血管mask=亮蓝，选中=绿，悬停=橙，红点=点击坐标。',

      btnCopyFrom: '从其他帧复制…',
      btnCancelCopy: '取消复制',

      toolsLabel: '标注工具',
      toolClick: '点选',
      toolBrush: '涂抹',
      clickSingle: '单点',
      clickBrush: '笔刷',
      selAdd: '选中',
      selErase: '取消',
      selRadiusLabel: '半径',
      selBrushHint: '左键拖动，选中刷子扫过的所有血管段（用当前所选类别）；平移用滚轮/双指，或按住空格+左拖。',
      brushAdd: '涂抹',
      brushErase: '擦除',
      brushRadiusLabel: '半径',
      brushOnmaskLabel: '仅前景（限血管mask内）',
      brushHint: '左键拖动=涂抹（用当前所选类别的颜色）；平移用滚轮/双指，或按住空格+左拖。',

      classesLabel: '标注分类（点击选为当前类别，左侧色块选颜色）',
      noteLabel: '笔记',
      btnSaveNote: '保存笔记',
      notePlaceholder: '本帧笔记，保存到该帧文件夹的 note.json',
      btnAddMarker: '添加标记',
      markerPlaceHint: '在图上点一下放置标记 {n}（Esc 取消）。',
      markerDelete: '删除该标记',

      loupeHoldHintLong: '按住 Cmd/Ctrl 看细节 · 松开关闭 · 检视时仍可点击标注',
      loupeCrossFrameHint: '跨帧原始灰度（虚线右为 minip 投影）',
      loupeMismatch: '尺寸不符',
      loupeLoading: '加载中…',

      clearConfirmHtml: '真的要清理么？<br>清理以后本 frame 全部标记都将消失。',
      btnClearContinue: '继续清理',
      btnCancel: '取消',

      errNoCases: '没找到 case_* 文件夹,请选包含 case_0001 等的数据根目录。',
      scanningExisting: '正在扫描已有标注…',
      errOpenFailed: '打开失败:{msg}',
      errLoadUnitFailed: '{id} 载入失败:{msg}',
      classesSaved: '类别已保存 {time}',
      classesSaveFailed: '类别保存失败',
      unnamedPrefix: '未命名-',
      classInUse: '类别 {idx} 已被标注使用，不能删除（先取消相关标注、或保存后再删）。',
      noClassesYetMgr: '还没有类别，输入名字点“添加”。',
      btnDelete: '删除',
      noClassesYetPicker: '在左栏“分类管理”添加类别后，这里选择当前标注类别与颜色。',
      copyPickHint: '点击左侧要复制标注的帧（Esc 取消）。',
      copyNoAnnotations: '“{id}” 没有可复制的标注。',
      copyDone: '已从 “{id}” 复制并重新解析：{segs} 段 · {pts} 点{dropped}',
      copyDoneDropped: '（{n} 个无类别已跳过）',
      errOpenFolderFirst: '先打开数据文件夹。',
      noteSaved: '笔记已保存 {time}',
      noteSaveFailed: '笔记保存失败',
      unitIndicatorFmt: '单元 {ui}/{uc} · 病例 {ci}/{cc}',
      none: '（无）',
      progressFmt: '本单元已标 {segs} 段 · {pts} 点',
      saving: '保存中…',
      saved: '已保存 {time}',
      saveFailed: '保存失败',
      saveFailedMsg: '保存失败:{msg}',
      starThisFrame: '星标该帧',
      cursorSeg: '光标 seg {seg}',
      cursorOutside: '光标在图外',
      projectionSuffix: '（投影）',
      errPickClassFirst: '先在右侧“标注分类”选择一个类别再涂抹。',
      errNoWritePermission: '没有写入权限,无法保存。',
      savedAllFmt: '已保存 {n} 个单元的 annotation.json 到各自文件夹。',
      unsavedDot: '●未保存',
      synced: '已同步',
      pendingSave: '待保存…',
      autoSaveFailed: '自动保存失败',
      errUnsupportedBrowser: '此浏览器不支持自动写盘(File System Access API)。请用 Chrome 或 Edge 打开本页。',
      classFallbackName: '类别 {idx}',
      errQuotaFull: '浏览器本地备份已满 —— 未保存的改动不再能在刷新后保留。请立即保存到文件夹。',
      datasetSwitched: '已打开新数据集；上一个数据集里未保存的内存改动已丢弃。',
      annCorrupt: '{id}：annotation.json 无法解析，已原样保留（保存前会先备份为 annotation.json.corrupt）。修好文件前本帧不显示标注。',
      classesCorrupt: 'classes.json 无法解析，已原样保留（未重新生成类别名）。修好文件即可恢复你的类别名称。',
      maskBad: '{id}：mask.npy 存在但无法解析 —— 本帧的血管 mask 叠加层和笔刷“仅前景”限制已关闭。',
      savedPartial: '已保存 {n} 个单元；{failed} 个失败（文件损坏或缺失）—— 这些未被改动。'
    }
  };

  const STORE_KEY = 'vessel_annotator_lang';
  let lang = 'en';
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'en' || saved === 'zh') lang = saved;
  } catch (e) { /* localStorage unavailable */ }

  function t(key, vars) {
    let s = (DICT[lang] && DICT[lang][key] != null) ? DICT[lang][key]
      : (DICT.en[key] != null ? DICT.en[key] : key);
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
    return s;
  }

  function getLang() { return lang; }

  function applyStatic() {
    document.title = t('pageTitle');
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
    document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    document.querySelectorAll('[data-lang-btn]').forEach(el => { el.classList.toggle('active', el.getAttribute('data-lang-btn') === lang); });
  }

  function setLang(l) {
    if (l !== 'en' && l !== 'zh') return;
    if (l === lang) return;
    lang = l;
    try { localStorage.setItem(STORE_KEY, l); } catch (e) { /* ignore */ }
    applyStatic();
    document.dispatchEvent(new CustomEvent('langchange'));
  }

  window.I18n = { t, getLang, setLang, applyStatic };
})();
