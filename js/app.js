/* freshkeeper/app.js —— 界面控制器（所有业务决策都调用 engine/planner，本文件只做渲染与交互） */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var store = FreshStorage.createStore();
  if (typeof window !== 'undefined') window.__store = store; // 仅用于自动化测试/调试
  // 当前家庭成员名字（只在本机记住，便于一键认领；应用本身无账号体系）
  var IDENTITY_KEY = 'freshkeeper:member';
  // 方案页上次选择的就餐成员（纯本机便利记忆，存在成员不存在时自动剔除）
  var DINERS_KEY = 'freshkeeper:diners';
  function getIdentity() {
    try { return (localStorage.getItem(IDENTITY_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function setIdentity(name) {
    try { localStorage.setItem(IDENTITY_KEY, name); } catch (e) {}
  }
  function getSavedDiners() {
    try {
      var v = JSON.parse(localStorage.getItem(DINERS_KEY) || '[]');
      return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function setSavedDiners(ids) {
    try { localStorage.setItem(DINERS_KEY, JSON.stringify(ids || [])); } catch (e) {}
  }
  // 就餐成员解析：记忆的成员可能已被删除，渲染时按现存成员过滤
  function membersByIds(ids) {
    var map = {};
    store.listMembers().forEach(function (m) { map[m.id] = m; });
    return (ids || []).map(function (id) { return map[id]; }).filter(Boolean);
  }
  // 标签可读名（cat:seafood → 水产海鲜）
  function dietTagLabel(tag) { return FreshDiet.tagLabel(tag); }
  // 库存勾选 chip 的悬浮冲突提示
  function dietConflictTip(evalResult, itemId) {
    if (!evalResult) return '';
    var row = evalResult.list.filter(function (r) { return r.id === itemId; })[0];
    if (!row) return '';
    return FreshDiet.reasonLines(row.blockers).concat(FreshDiet.reasonLines(row.warnings)).join('、');
  }
  function tagsOf(member, kind) { return member[kind + 'Tags'] || []; }
  // 成员 chip 的 title：列出过敏/忌口标签
  function memberDietTitle(m) {
    var parts = [];
    if (tagsOf(m, 'allergy').length) parts.push('过敏：' + tagsOf(m, 'allergy').map(dietTagLabel).join('、'));
    if (tagsOf(m, 'avoid').length) parts.push('忌口：' + tagsOf(m, 'avoid').map(dietTagLabel).join('、'));
    return parts.join('；') || '无饮食限制';
  }
  // 把标签数组拆成 [{tag, cat:bool}] 供渲染
  function tagChipsHtml(tags, cls) {
    return (tags || []).map(function (t) {
      return '<span class="diet-tag ' + cls + '">' + esc(dietTagLabel(t)) + '</span>';
    }).join('');
  }
  var state = {
    view: 'inventory',
    filter: 'all',
    editingId: null,
    formLocation: 'fridge',
    pickedIds: null,   // null=使用全部库存；数组=仅选中的食材
    lastPlans: [],
    shopFilter: 'open',  // open=待办（待认领+已认领）；另可按 待认领/已认领/已买到 筛选
    editingShopId: null,  // 正在编辑（而非新建）的待购项
    purchaseShopId: null, // 录入表单正在完成哪条待购；保存成功才 complete，取消则保留
    assignCtx: null,      // 认领/转交/设置身份弹层的上下文 { mode, shoppingId, name }
    mealFilter: 'pending',
    mealPresetIds: null,   // 从方案页带入的预勾选食材
    mealPresetSource: null,// 计划来源：方案页带入为 plan
    mealDonePlanId: null,  // 正在完成哪条用餐计划
    mealDoneActions: {},   // 完成弹层中每样食材选定的处理动作
    planDinerIds: [],      // 方案页选中的就餐成员（本机记忆）
    mealDinerIds: [],      // 用餐计划表单选中的就餐成员
    editingMemberId: null, // 正在编辑的成员
    memberFormTags: { allergy: [], avoid: [], prefer: [] }, // 成员表单标签草稿
    dietCtx: null          // 冲突解决弹层上下文（见 openDietResolver）
  };

  // ---------- 小工具 ----------
  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, ms || 2200);
  }

  // ---------- 保存失败（本地存储写满）----------
  // 所有写操作都经 guard 包裹：存储层在写入失败时会回滚内存并抛 StorageWriteError，
  // 这里必须明确告诉用户“没存进去”，弹层不自动消失，引导先导出备份 / 清理历史痕迹。
  function guard(action) {
    try {
      return { ok: true, value: action() };
    } catch (err) {
      if (FreshStorage.StorageWriteError && FreshStorage.StorageWriteError.is(err)) {
        showStorageFull(err);
        return { ok: false, error: err };
      }
      throw err;
    }
  }

  function humanBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function renderStorageStats() {
    var info = store.storageInfo();
    var rows = [
      ['操作流水（追溯）', info.parts.audit, info.counts.audit + ' 条'],
      ['食材记录（含修订/事件）', info.parts.items, info.counts.items + ' 样'],
      ['待购清单', info.parts.shopping, info.counts.shopping + ' 条'],
      ['用餐计划', info.parts.mealPlans, info.counts.mealPlans + ' 条'],
      ['家庭成员', info.parts.members, info.counts.members + ' 位']
    ];
    $('#storageStats').innerHTML =
      '<div style="margin-bottom:4px">当前本机数据约 <b>' + humanBytes(info.totalBytes) + '</b>，占用分布：</div>' +
      rows.map(function (r) {
        var pct = info.totalBytes ? Math.round(r[1] / info.totalBytes * 100) : 0;
        return '<div style="display:flex;justify-content:space-between;gap:8px;line-height:1.7">' +
          '<span>' + r[0] + '（' + r[2] + '）</span><span>' + humanBytes(r[1]) + ' · ' + pct + '%</span></div>';
      }).join('');
  }

  function showStorageFull(err) {
    var msg = $('#storageFullMsg');
    msg.innerHTML = (err && err.quota
      ? '刚才的修改<b>没有存进浏览器</b>——本机浏览器为本网站分配的存储空间已经写满。'
      : '刚才的修改<b>没有存进浏览器</b>——浏览器存储当前不可写（可能处于无痕模式或被系统限制）。') +
      '请先按下面处理后再重试，否则刷新或关闭页面后这条记录会丢失。';
    renderStorageStats();
    $('#sheetStorageFull').hidden = false;
  }

  function setupStorageAlert() {
    $('#btnStorageClose').addEventListener('click', function () {
      $('#sheetStorageFull').hidden = true;
      renderAll(); // 存储层已回滚内存，刷新界面避免残留“看似已保存”的假象
    });
    $('#btnStorageExport').addEventListener('click', function () {
      download('freshkeeper-backup-' + todayISO() + '.json', store.exportJSON());
      toast('已导出备份文件，请妥善保存');
    });
    $('#btnStoragePrune').addEventListener('click', function () {
      var info = store.storageInfo();
      if (!confirm('将删除较早的操作流水（保留最近 500 条）和每样食材较早的字段修改快照。\n\n' +
        '库存、待购、用餐计划、家庭成员、期限事件与撤销记录都不会删除，食材仍可在追溯中恢复。\n\n' +
        '建议先点「先导出备份」再清理。现在开始清理？')) return;
      var r = guard(function () { return store.pruneHistory({ keepAudit: 500, keepRevisions: 20 }); });
      if (!r.ok) return; // 极端情况下瘦身后仍写不进：弹层保持，继续引导导出+清空
      var s = r.value;
      $('#sheetStorageFull').hidden = true;
      renderAll();
      toast('已清理：删除 ' + s.droppedAudit + ' 条旧流水、' + s.revisionsDropped +
        ' 份旧快照，腾出约 ' + humanBytes(Math.max(s.bytesSaved, 0)) + '。请重试刚才的操作。', 4200);
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function todayISO() { return FreshEngine.isoDate(FreshEngine.todayAt()); }
  function fmtDate(s) {
    if (!s) return '—';
    return String(s).slice(0, 10);
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function locTag(loc) {
    var m = FreshRules.locations[loc] || { name: loc };
    return '<span class="loc-tag loc-' + loc + '">' + esc(m.name) + '</span>';
  }

  // ---------- 库存渲染 ----------
  function assessments() {
    // 包含软删除记录（仅在“已归档”中展示），其余过滤条件排除
    return FreshEngine.assessAll(store.listItems(true));
  }

  function filterRows(rows) {
    switch (state.filter) {
      case 'expired': return rows.filter(function (a) { return a.status === 'expired' && !a.item.removed; });
      case 'urgent': return rows.filter(function (a) { return (a.status === 'danger' || a.status === 'warn') && !a.item.removed; });
      case 'fresh': return rows.filter(function (a) { return (a.status === 'fresh' || a.status === 'quality') && !a.item.removed; });
      case 'frozen': return rows.filter(function (a) { return a.state.clockPaused && !a.item.removed; });
      case 'ended': return rows.filter(function (a) { return a.state.ended || a.item.removed; });
      default: return rows.filter(function (a) { return !a.state.ended && !a.item.removed; });
    }
  }

  function daysText(a) {
    if (a.state.ended) return esc(a.statusInfo.label);
    if (a.state.clockPaused) {
      var q = a.qualityDaysLeft;
      return q < 0 ? '冷冻品质期已过 ' + Math.abs(q) + ' 天' : '冷冻中 · 品质期剩 ' + q + ' 天';
    }
    if (a.safeDaysLeft < 0) return '已过期 ' + Math.abs(a.safeDaysLeft) + ' 天';
    if (a.safeDaysLeft === 0) return '今天到期';
    return '建议期限剩 ' + a.safeDaysLeft + ' 天';
  }

  function renderInventory() {
    var all = assessments();
    var rows = filterRows(all);
    var active = all.filter(function (a) { return !a.state.ended; });

    // 顶部汇总
    var nExp = active.filter(function (a) { return a.status === 'expired'; }).length;
    var nUrg = active.filter(function (a) { return a.status === 'danger' || a.status === 'warn'; }).length;
    $('#summaryLine').textContent =
      '在库 ' + active.length + ' 样 · ' +
      (nExp ? '过期 ' + nExp + ' · ' : '') +
      (nUrg ? '需尽快 ' + nUrg : (nExp ? '' : '暂无临期，状态良好'));

    var list = $('#inventoryList');
    list.innerHTML = rows.map(function (a) {
      var it = a.item;
      var cat = a.state.cat;
      var endedCls = a.state.ended ? 's-' + a.status : '';
      return '<div class="food-card s-' + a.status + ' ' + endedCls + '" data-id="' + esc(it.id) + '">' +
        '<div class="fc-main">' +
          '<div class="fc-title">' +
            '<span class="fc-name">' + esc(it.name) + '</span>' +
            (cat ? '<span class="fc-cat">' + esc(cat.name) + '</span>' : '<span class="fc-cat">未识别分类</span>') +
            (a.highRisk ? '<span class="fc-risk">高风险</span>' : '') +
            (it.events.some(function (e) { return !e.deleted && e.type === 'cook'; }) ? '<span class="fc-cat">已做熟</span>' : '') +
          '</div>' +
          '<div class="fc-meta">' +
            locTag(a.state.location) +
            '<span>' + esc(FreshRules.packages[a.state.packageType] || a.state.packageType) + '</span>' +
            '<span>购于 ' + fmtDate(it.purchaseDate) + '</span>' +
          '</div>' +
          '<div class="fc-advice">' + esc(a.advice.title) + '</div>' +
        '</div>' +
        '<div class="fc-side">' +
          '<span class="status-pill sp-' + a.status + '">' + esc(a.statusInfo.label) + '</span>' +
          '<span class="fc-days">' + esc(daysText(a)) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    $('#inventoryEmpty').hidden = rows.length > 0;
    $$('#inventoryList .food-card').forEach(function (el) {
      el.addEventListener('click', function () { openDetail(el.getAttribute('data-id')); });
    });
  }

  // ---------- 录入/编辑表单 ----------
  function fillCategorySelect(selectId, selectedId) {
    var sel = $('#' + selectId);
    sel.innerHTML = '<option value="">（按名称自动识别）</option>' +
      FreshRules.categories.map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === selectedId ? ' selected' : '') + '>' +
          esc(c.name) + (c.highRisk ? ' ·高风险' : '') + '</option>';
      }).join('');
  }

  function rulePreview() {
    var name = $('#fName').value.trim();
    var catId = $('#fCategory').value;
    var loc = state.formLocation;
    var pkg = $('#fPackage').value;
    var m = FreshEngine.matchCategory(name);
    var cat = catId
      ? FreshRules.categories.filter(function (c) { return c.id === catId; })[0]
      : m.category;

    if (!name) { $('#rulePreview').innerHTML = '输入名称后显示该食材的建议期限。'; return; }
    if (!cat) {
      $('#catHint').textContent = m.matchedKeyword ? '' : '未识别该食材，可在上方手动选择分类';
      $('#rulePreview').innerHTML = '未匹配到规则，将按最保守 1 天估算；请手动选择分类以获得准确建议。';
      return;
    }
    $('#catHint').textContent = '识别为：' + cat.name + (cat.highRisk ? '（高风险食材，建议从严）' : '');
    var d = FreshEngine.safeDaysFor(cat, loc, pkg);
    var html;
    if (d === null) {
      html = '⚠️ <b>' + esc(cat.name) + '不建议' + FreshRules.locations[loc].name + '保存</b>，请更换位置，否则按 1 天估算。';
    } else if (loc === 'freezer') {
      html = '冷冻保存：安全时钟暂停，建议品质期约 <b>' + Math.round(cat.freezerQuality / 30) + ' 个月</b>；' +
        '解冻后冷藏请在 <b>' + cat.thawQuality + ' 天</b>内吃完。';
    } else {
      html = esc(cat.name) + ' · ' + FreshRules.locations[loc].name + ' · ' +
        esc(FreshRules.packages[pkg]) + ' 建议期限：<b>' + d + ' 天</b>' +
        '；做熟后冷藏 ' + cat.cookedSafe + ' 天内吃完。';
    }
    $('#rulePreview').innerHTML = html;
  }

  // opts.purchaseShopId：从待购项点“已买到”进入——只预填名称和分类，
  // 保存成功后才 completeShopping 关联新库存；取消录入则待购项原样保留
  function openForm(item, opts) {
    opts = opts || {};
    state.editingId = item ? item.id : null;
    state.purchaseShopId = opts.purchaseShopId || null;
    var shop = state.purchaseShopId ? store.getShopping(state.purchaseShopId) : null;
    $('#formTitle').textContent = item ? '编辑食材'
      : (shop ? '录入购买：' + shop.name : '录入食材');
    var presetName = item ? item.name : (shop ? shop.name : '');
    var presetCat = item ? item.categoryId : (shop ? (shop.categoryId || '') : '');
    if (!presetCat && presetName) {
      var pm = FreshEngine.matchCategory(presetName);
      if (pm.category) presetCat = pm.category.id;
    }
    fillCategorySelect('fCategory', presetCat);
    $('#fName').value = presetName;
    $('#fPurchaseDate').value = item ? item.purchaseDate : todayISO();
    $('#fPackage').value = item ? item.packageType : 'sealed';
    state.formLocation = item ? item.location : 'fridge';
    $('#fNote').value = item ? (item.note || '') : '';
    $$('#fLocation button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-v') === state.formLocation);
    });
    $('#btnDeleteItem').hidden = !item;
    if (shop) {
      $('#restockHintName').textContent = shop.name;
      $('#restockHint').hidden = false;
    } else {
      $('#restockHint').hidden = true;
    }
    rulePreview();
    $('#sheetForm').hidden = false;
  }

  function closeSheet(sheet) { $('#' + sheet).hidden = true; }

  function saveForm(e) {
    e.preventDefault();
    var fields = {
      name: $('#fName').value.trim(),
      categoryId: $('#fCategory').value,
      purchaseDate: $('#fPurchaseDate').value,
      packageType: $('#fPackage').value,
      location: state.formLocation,
      note: $('#fNote').value.trim()
    };
    if (!fields.name || !fields.purchaseDate) { toast('请填写名称和购买日期'); return; }
    if (!fields.categoryId) {
      var m = FreshEngine.matchCategory(fields.name);
      if (!m.category) { toast('未识别食材分类，请手动选择'); return; }
    }

    var purchaseShopId = state.purchaseShopId;
    if (state.editingId) {
      var r1 = guard(function () { return store.updateItem(state.editingId, fields, 'manual'); });
      if (!r1.ok) return; // 保存失败：弹层保持打开、输入不丢，失败提示已弹出
      toast('已保存修改，旧值已记入追溯');
    } else {
      var addRes = guard(function () {
        return store.addItem(fields, purchaseShopId ? ('restock:' + purchaseShopId) : 'manual');
      });
      if (!addRes.ok) return;
      var saved = addRes.value;
      // 待购购买录入：只有保存走到这里（校验通过且已入库）才完成待购项并关联新库存
      if (purchaseShopId) {
        var doneRes = guard(function () { return store.completeShopping(purchaseShopId, saved.id); });
        if (!doneRes.ok) return;
        toast('已录入并完成补货：' + fields.name);
      } else {
        toast('已录入：' + fields.name);
      }
    }
    state.purchaseShopId = null;
    closeSheet('sheetForm');
    renderAll();
  }

  // ---------- OCR 拍照识别 ----------
  function setupOCR() {
    var fileInput = $('#fileInput');
    $('#btnCamera').addEventListener('click', function () {
      fileInput.removeAttribute('capture');
      fileInput.setAttribute('capture', 'environment');
      fileInput.click();
    });
    $('#btnPhoto').addEventListener('click', function () {
      fileInput.removeAttribute('capture');
      fileInput.click();
    });
    fileInput.addEventListener('change', function () {
      if (!fileInput.files || !fileInput.files[0]) return;
      runOCR(fileInput.files[0]);
      fileInput.value = '';
    });
  }

  function runOCR(file) {
    var status = $('#ocrStatus');
    var btns = [$('#btnCamera'), $('#btnPhoto')];
    btns.forEach(function (b) { b.disabled = true; });
    status.innerHTML = '📸 正在识别标签文字（首次需下载识别组件，请稍候）…';

    var reader = new FileReader();
    reader.onload = function () {
      FreshOCR.recognizeImage(reader.result, function (stage, p) {
        var label = { 'loading tesseract core': '加载识别引擎', 'initializing tesseract': '初始化',
          'loading language traineddata': '下载中文语言包', 'initializing api': '准备中',
          'recognizing text': '识别文字中' }[stage] || stage;
        status.textContent = '📸 ' + label + (p ? ' ' + Math.round(p * 100) + '%' : '…');
      }).then(function (parsed) {
        fillFormFromOCR(parsed);
        status.innerHTML = '✅ 识别完成，<b>请逐项核对后再保存</b>（识别结果未入库）';
      }).catch(function (err) {
        status.innerHTML = '⚠️ ' + esc(err.message || '识别失败') + '，可直接手动填写。';
      }).then(function () {
        btns.forEach(function (b) { b.disabled = false; });
      });
    };
    reader.readAsDataURL(file);
  }

  function fillFormFromOCR(p) {
    if (p.name) $('#fName').value = p.name;
    var m = FreshEngine.matchCategory(p.name);
    if (m.category) $('#fCategory').value = m.category.id;
    if (p.locationHint) {
      state.formLocation = p.locationHint;
      $$('#fLocation button').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-v') === state.formLocation);
      });
    }
    // 标签上的到期日：换算回“购买日期”不现实，改在备注中提示，由用户确认
    if (p.expireDate) {
      $('#fNote').value = '标签到期日 ' + p.expireDate + (p.daysShelf ? '（保质期约 ' + p.daysShelf + ' 天）' : '') +
        '，请确认购买日期';
    }
    rulePreview();
    toast('识别文字已填入，请核对');
  }

  // ---------- 详情 / 时间线 ----------
  var EVENT_LABELS = {
    open: '开封', move: '更换保存位置', freeze: '放入冷冻', thaw: '解冻移至冷藏',
    cook: '已做熟', reheat: '重新加热', consume: '吃完/用尽', discard: '丢弃'
  };

  function openDetail(id) {
    var item = store.getItem(id);
    if (!item) return;
    var a = FreshEngine.assess(item);
    var cat = a.state.cat;

    // 有效事件：较晚发生的在前；同一天内按事件序号/创建时间继续排序（引擎比较器）
    var events = (item.events || []).filter(function (e) { return !e.deleted; })
      .slice().sort(FreshEngine.compareEventsDesc);
    // 已撤销事件：按撤销时间倒序，同毫秒回退到事件自身时序
    var undone = (item.events || []).filter(function (e) { return e.deleted; })
      .slice().sort(function (x, y) {
        var dx = x.deletedAt || '', dy = y.deletedAt || '';
        if (dx !== dy) return dx < dy ? 1 : -1;
        return FreshEngine.compareEventsDesc(x, y);
      });

    var adviceCls = a.status === 'expired' || a.status === 'danger' ? 'bad'
      : a.status === 'fresh' ? 'good' : '';

    var html =
      '<div class="detail-head">' +
        '<div style="flex:1">' +
          '<div class="detail-name">' + esc(item.name) + '</div>' +
          '<div class="fc-meta">' +
            (cat ? '<span class="fc-cat">' + esc(cat.name) + '</span>' : '<span class="fc-cat">未识别分类</span>') +
            (a.highRisk ? '<span class="fc-risk">高风险</span>' : '') +
            '<span class="tl-date">录入于 ' + fmtDateTime(item.createdAt) + '</span>' +
          '</div>' +
        '</div>' +
        '<span class="status-pill sp-' + a.status + '">' + esc(a.statusInfo.label) + '</span>' +
      '</div>' +

      '<div class="detail-advice ' + adviceCls + '">' +
        '<h4>👉 ' + esc(a.advice.title) + '</h4>' +
        '<p>' + esc(daysText(a)) + (a.advice.detail ? '。' + esc(a.advice.detail) : '') + '</p>' +
        (a.advice.alternatives.length
          ? '<ul class="alt-list">' + a.advice.alternatives.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
          : '') +
      '</div>' +

      '<div class="detail-meta">' +
        '<div><span>购买日期</span>' + fmtDate(item.purchaseDate) + '</div>' +
        '<div><span>当前位置</span>' + (FreshRules.locations[a.state.location] || {}).name + '</div>' +
        '<div><span>包装状态</span>' + esc(FreshRules.packages[a.state.packageType] || a.state.packageType) + '</div>' +
        '<div><span>处理状态</span>' + (a.state.cooked ? '已做熟' : '生/原状') + (a.state.thawed ? ' ·已解冻' : '') + '</div>' +
        (item.note ? '<div style="grid-column:1/-1"><span>备注</span>' + esc(item.note) + '</div>' : '') +
      '</div>';

    // 家庭成员饮食提醒：当前成员里谁对这道食材过敏/忌口（基于当前分类与名称实时计算）
    var members = store.listMembers();
    if (members.length) {
      var target = FreshDiet.normalizeTarget(item);
      var allergyWho = [], avoidWho = [], preferWho = [];
      members.forEach(function (m) {
        var h = FreshDiet.hitsForMember(m, target);
        if (h.blockers.length) allergyWho.push(m.name + '（' + h.blockers.map(function (x) { return x.tagLabel; }).join('、') + '）');
        if (h.warnings.length) avoidWho.push(m.name + '（' + h.warnings.map(function (x) { return x.tagLabel; }).join('、') + '）');
        if (h.likes.length) preferWho.push(m.name);
      });
      if (allergyWho.length || avoidWho.length || preferWho.length) {
        html += '<div class="detail-diet">' +
          (allergyWho.length ? '<div class="diet-line blocker">🚫 过敏：' + allergyWho.map(esc).join('；') + '</div>' : '') +
          (avoidWho.length ? '<div class="diet-line warning">⚠️ 忌口：' + avoidWho.map(esc).join('；') + '</div>' : '') +
          (preferWho.length ? '<div class="diet-line like">💚 偏好：' + preferWho.map(esc).join('、') + '</div>' : '') +
        '</div>';
      }
    }

    if (!a.state.ended) {
      html += '<div class="act-grid">' +
        actBtn('ev-open', '📦', '已开封', false) +
        actBtn('ev-freeze', '❄️', '放入冷冻', false) +
        actBtn('ev-thaw', '💧', '已解冻', false) +
        actBtn('ev-cook', '🍳', '做熟了', false) +
        actBtn('ev-reheat', '♨️', '重新加热', false) +
        actBtn('ev-move-pantry', '🏠', '移常温', false) +
        actBtn('ev-consume', '✅', '吃完了', false) +
        actBtn('ev-discard', '🗑️', '丢弃', true) +
      '</div>';
    } else {
      html += '<div class="form-actions" style="margin:12px 0;flex-wrap:wrap">' +
        '<button class="btn-primary" id="btnRestockItem" style="flex:1 1 100%">🛒 再买一份（加入补货清单）</button>' +
        '<button class="btn-ghost" id="btnRestoreItem">↩️ 撤销归档（恢复在库）</button>' +
      '</div>';
    }

    html += '<div class="timeline"><h4>变更时间线（可撤销）</h4>';
    html += '<div class="tl-item"><span class="tl-dot"></span><div class="tl-body tl-create">' +
      '<span class="tl-date">' + fmtDate(item.purchaseDate) + '</span> 购买并录入（' +
      esc(FreshRules.packages[item.packageType] || item.packageType) + ' · ' +
      (FreshRules.locations[item.location] || {}).name + '）</div></div>';

    events.forEach(function (ev) {
      var note = ev.type === 'reheat' ? a.reheatNote : null;
      html += '<div class="tl-item"><span class="tl-dot"></span>' +
        '<div class="tl-body"><span class="tl-date">' + fmtDate(ev.at) + '</span> ' +
        esc(EVENT_LABELS[ev.type] || ev.type) +
        (ev.reason ? '：' + esc(ev.reason) : '') +
        (ev.source && ev.source.indexOf('mealplan:') === 0 ? ' <span class="fc-cat">来自用餐计划</span>'
          : ev.source && ev.source.indexOf('plan') === 0 ? ' <span class="fc-cat">来自方案</span>' : '') +
        (note ? '<br><span class="tl-date">' + esc(note) + '</span>' : '') +
        ' <button class="tl-undo" data-undo="' + ev.id + '">撤销</button></div></div>';
    });
    undone.forEach(function (ev) {
      html += '<div class="tl-item"><span class="tl-dot undone"></span>' +
        '<div class="tl-body undone"><span class="tl-date">' + fmtDate(ev.at) + '</span> ' +
        esc(EVENT_LABELS[ev.type] || ev.type) + '（已撤销）</div></div>';
    });
    html += '</div>';

    html += '<div class="form-actions" style="margin-top:14px">' +
      '<button class="btn-ghost" id="btnEditItem">✏️ 修改信息</button>' +
      '<button class="btn-primary" data-close>关闭</button>' +
    '</div>';

    $('#detailBody').innerHTML = html;
    $('#sheetDetail').hidden = false;

    // 事件按钮
    var evMap = {
      'ev-open': ['open', {}],
      'ev-freeze': ['freeze', {}],
      'ev-thaw': ['thaw', {}],
      'ev-cook': ['cook', {}],
      'ev-reheat': ['reheat', {}],
      'ev-move-pantry': ['move', { to: 'pantry' }],
      'ev-consume': ['consume', {}],
      'ev-discard': ['discard', { reason: '用户丢弃' }]
    };
    Object.keys(evMap).forEach(function (k) {
      var btn = document.getElementById(k);
      if (btn) btn.addEventListener('click', function () {
        var spec = evMap[k];
        if (spec[0] === 'discard' && !confirm('确认丢弃该食材？此操作会记入追溯（可在记录中恢复）。')) return;
        var r = guard(function () {
          return store.addEvent(id, spec[0], Object.assign({ at: todayISO() }, spec[1]), 'manual');
        });
        if (!r.ok) return;
        toast('已记录：' + EVENT_LABELS[spec[0]]);
        closeSheet('sheetDetail');
        renderAll();
      });
    });
    $$('#detailBody [data-undo]').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = guard(function () { return store.undoEvent(b.getAttribute('data-undo')); });
        if (!r.ok) return;
        if (r.value) {
          toast('已撤销该操作，期限已重新计算');
          openDetail(id);
          renderAll();
        }
      });
    });
    var editBtn = $('#btnEditItem');
    if (editBtn) editBtn.addEventListener('click', function () {
      closeSheet('sheetDetail');
      openForm(item);
    });
    var restockBtn = $('#btnRestockItem');
    if (restockBtn) restockBtn.addEventListener('click', function () {
      // 从已吃完/已丢弃食材发起补货：预填名称与分类，来源记为对应归档事件
      closeSheet('sheetDetail');
      var endType = item.events.filter(function (ev) {
        return !ev.deleted && (ev.type === 'consume' || ev.type === 'discard');
      }).map(function (ev) { return ev.type; }).pop() || 'manual';
      openShoppingForm({
        name: item.name,
        categoryId: item.categoryId,
        source: endType,            // consume / discard
        sourceItemId: item.id,
        sourceName: item.name
      });
    });
    var restoreBtn = $('#btnRestoreItem');
    if (restoreBtn) restoreBtn.addEventListener('click', function () {
      // 归档恢复 = 撤销 consume/discard 事件
      var endEv = item.events.filter(function (e) { return !e.deleted && (e.type === 'consume' || e.type === 'discard'); }).pop();
      if (!endEv) return;
      var r = guard(function () { return store.undoEvent(endEv.id); });
      if (!r.ok) return;
      toast('已恢复在库'); openDetail(id); renderAll();
    });
  }

  function actBtn(id, icon, label, danger) {
    return '<button class="act-btn' + (danger ? ' danger' : '') + '" id="' + id + '"><span>' + icon + '</span>' + esc(label) + '</button>';
  }

  // ---------- 补货清单 ----------
  function sameNameStock(name) {
    var n = FreshEngine.normalizeName(name);
    if (!n) return [];
    // 同名在库食材：未归档（含冷冻中）；normalizeName 去空白转小写做对比
    return FreshEngine.assessAll(store.listItems())
      .filter(function (a) { return !a.state.ended && FreshEngine.normalizeName(a.item.name) === n; });
  }

  function renderDupWarn() {
    var box = $('#sDupWarn');
    var name = $('#sName').value.trim();
    var dups = name ? sameNameStock(name) : [];
    // 编辑既有待购项且名称未改：该项加入时已确认过同名在库，不再重复拦截
    var editing = state.editingShopId ? store.getShopping(state.editingShopId) : null;
    if (editing && FreshEngine.normalizeName(editing.name) === FreshEngine.normalizeName(name)) {
      dups = [];
    }
    if (!dups.length) { box.hidden = true; box.innerHTML = ''; return; }
    // 用户已勾选确认后再输入（如继续修改名称）不应清空其确认状态
    var wasOk = !box.hidden && $('#sDupOk') && $('#sDupOk').checked;
    box.hidden = false;
    box.innerHTML = '⚠️ 库存里已有 <b>' + dups.length + '</b> 样同名食材：' +
      '<ul class="dup-list">' + dups.slice(0, 4).map(function (a) {
        return '<li>' + esc(a.item.name) + ' · ' + esc(a.statusInfo.label) +
          ' · ' + esc(daysText(a)) + '</li>';
      }).join('') + '</ul>' +
      '<label class="dup-confirm"><input type="checkbox" id="sDupOk"' + (wasOk ? ' checked' : '') +
        '> 确认库存已有，仍要加入待购</label>';
  }

  // 成员快速名单：本机身份 + 历史负责人记录
  function shopMembers() {
    var me = getIdentity();
    var names = store.listShopMembers(10);
    if (me && names.indexOf(me) < 0) names.unshift(me);
    return names;
  }

  function fillMemberDatalists() {
    var opts = shopMembers().map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
    $('#shopMembers').innerHTML = opts;
    $('#shopMembers2').innerHTML = opts;
  }

  function openShoppingForm(preset) {
    preset = preset || {};
    state.editingShopId = preset.id || null;
    // 新建时记录来源（吃完/丢弃补货/手动）；编辑保留原记录的来源
    state.shopFormSource = preset.id ? null : (preset.source || 'manual');
    state.shopFormPreset = preset.id ? null : preset;
    $('#shopFormTitle').textContent = preset.id ? '编辑待购食材'
      : (preset.source === 'consume' || preset.source === 'discard' ? '补货：' + preset.name : '添加待购食材');
    // 来源食材若未存分类（早期录入自动识别），按名称补全预填分类
    var presetCat = preset.categoryId || '';
    if (!presetCat && preset.name) {
      var mm = FreshEngine.matchCategory(preset.name);
      if (mm.category) presetCat = mm.category.id;
    }
    fillCategorySelect('sCategory', presetCat);
    fillMemberDatalists();
    $('#sName').value = preset.name || '';
    $('#sQty').value = preset.qty || '';
    $('#sNote').value = preset.note || '';
    // 负责人：编辑取该项已有负责人；新建留空（待认领）
    $('#sAssignee').value = preset.id ? (preset.assignee || '') : '';
    $('#sCatHint').textContent = preset.source === 'consume' ? '来自一份已吃完的食材，名称与分类已带出'
      : preset.source === 'discard' ? '来自一份已丢弃的食材，名称与分类已带出' : '';
    renderDupWarn();
    $('#sheetShopping').hidden = false;
  }

  function saveShoppingForm(e) {
    e.preventDefault();
    var fields = {
      name: $('#sName').value.trim(),
      categoryId: $('#sCategory').value,
      qty: $('#sQty').value.trim(),
      note: $('#sNote').value.trim(),
      assignee: $('#sAssignee').value.trim()
    };
    if (!fields.name) { toast('请填写食材名称'); return; }
    if (!fields.categoryId) {
      var m = FreshEngine.matchCategory(fields.name);
      if (!m.category) { toast('未识别食材分类，请手动选择'); return; }
      fields.categoryId = m.category.id;
    }
    // 同名在库食材：必须看到提示并显式勾选“仍要购买”才能保存待购项
    var dupBox = $('#sDupWarn');
    if (!dupBox.hidden) {
      var ok = $('#sDupOk');
      if (!ok || !ok.checked) { toast('库存里已有同名食材，请勾选确认仍要购买'); return; }
    }
    if (state.editingShopId) {
      var r1 = guard(function () { return store.updateShopping(state.editingShopId, fields); });
      if (!r1.ok) return;
      toast('已更新待购项');
    } else {
      var preset = state.shopFormPreset || {};
      var payload = Object.assign({}, fields, {
        sourceItemId: preset.sourceItemId || '',
        sourceName: preset.sourceName || ''
      });
      var r2 = guard(function () { return store.addShopping(payload, state.shopFormSource || 'manual'); });
      if (!r2.ok) return;
      toast(fields.assignee ? '已加入待购，负责人：' + fields.assignee : '已加入待购（待认领）');
    }
    state.editingShopId = null;
    state.shopFormSource = null;
    state.shopFormPreset = null;
    closeSheet('sheetShopping');
    renderAll();
  }

  function shopCounts() {
    var all = store.listShopping();
    return {
      open: all.filter(function (s) { return s.status !== 'done'; }).length,
      unclaimed: all.filter(function (s) { return s.status === 'unclaimed'; }).length,
      claimed: all.filter(function (s) { return s.status === 'claimed'; }).length
    };
  }

  // 顶部“我是谁”：一键认领前先在本机记住当前家庭成员名字
  function renderIdentityBar() {
    var box = $('#shopIdentity');
    var me = getIdentity();
    if (me) {
      box.innerHTML = '👤 当前身份：<b>' + esc(me) + '</b>' +
        '<span class="shop-id-change">（点此切换）</span>';
    } else {
      box.innerHTML = '👤 点此设置你在家庭中的称呼（如：妈妈 / 爸爸），认领时不用重复输入' +
        '<span class="shop-id-go">设置 →</span>';
    }
  }

  function renderShopping() {
    fillMemberDatalists();
    renderIdentityBar();
    var counts = shopCounts();
    var done = store.listShopping('done');
    var badge = $('#shopBadge');
    badge.textContent = String(counts.open);
    badge.hidden = counts.open === 0;

    var rows;
    if (state.shopFilter === 'done') rows = done;
    else if (state.shopFilter === 'unclaimed') rows = store.listShopping('unclaimed');
    else if (state.shopFilter === 'claimed') rows = store.listShopping('claimed');
    else rows = store.listShopping('open');
    var root = $('#shoppingList');
    var empty = $('#shoppingEmpty');
    if (!rows.length) {
      root.innerHTML = '';
      empty.hidden = false;
      var emptyMsgs = {
        done: '还没有已买到的记录。在待购项上点「已买到」并完成录入后会显示在这里。',
        unclaimed: '没有待认领的食材——所有待购项都有负责人了。',
        claimed: '还没有被认领的待购项。',
        open: '还没有待购食材。吃完或丢弃食材后可在详情里一键补货，也可以点上方按钮手动添加。'
      };
      empty.textContent = emptyMsgs[state.shopFilter] || emptyMsgs.open;
      return;
    }
    empty.hidden = true;

    root.innerHTML = rows.map(function (s) {
      var cat = FreshRules.categories.filter(function (c) { return c.id === s.categoryId; })[0];
      var srcTag = s.source === 'consume' ? '<span class="shop-src">↩️ 吃完补货</span>'
        : s.source === 'discard' ? '<span class="shop-src">🗑️ 丢弃补货</span>' : '';
      if (s.status === 'done') {
        var linked = s.itemId ? store.getItem(s.itemId) : null;
        var linkedHtml = linked
          ? '<a class="shop-link" data-item="' + esc(linked.id) + '">→ 已关联新库存：' + esc(linked.name) + '</a>'
          : '<span class="shop-link gone">（关联的库存记录已被删除）</span>';
        return '<div class="shop-card done">' +
          '<div class="shop-main"><div class="shop-title">' +
            '<span class="shop-name">' + esc(s.name) + '</span>' +
            (cat ? '<span class="fc-cat">' + esc(cat.name) + '</span>' : '') +
            '<span class="shop-status">已买到</span>' +
          '</div>' +
          '<div class="shop-meta">' +
            (s.qty ? '<span>数量：' + esc(s.qty) + '</span>' : '') +
            (s.note ? '<span>备注：' + esc(s.note) + '</span>' : '') +
            (s.assignee ? '<span>负责人：' + esc(s.assignee) + '</span>' : '') +
            '<span>' + fmtDateTime(s.completedAt) + '</span>' +
          '</div>' + linkedHtml + '</div>' +
        '</div>';
      }
      var claimed = s.status === 'claimed';
      var statusPill = claimed
        ? '<span class="shop-status st-claimed">🙋 已认领 · ' + esc(s.assignee) + '</span>'
        : '<span class="shop-status st-unclaimed">🏷️ 待认领</span>';
      return '<div class="shop-card' + (claimed ? ' claimed' : ' unclaimed') + '">' +
        '<div class="shop-main"><div class="shop-title">' +
          '<span class="shop-name">' + esc(s.name) + '</span>' +
          (cat ? '<span class="fc-cat">' + esc(cat.name) + '</span>' : '<span class="fc-cat">未识别分类</span>') +
          srcTag + statusPill +
        '</div>' +
        '<div class="shop-meta">' +
          (s.qty ? '<span>要买：' + esc(s.qty) + '</span>' : '') +
          (s.note ? '<span>备注：' + esc(s.note) + '</span>' : '') +
          '<span>添加于 ' + fmtDate(s.createdAt.slice(0, 10)) + '</span>' +
        '</div></div>' +
        '<div class="shop-actions">' +
          '<button class="btn-primary" data-buy="' + esc(s.id) + '">已买到</button>' +
          (claimed
            ? '<button class="btn-ghost" data-transfer="' + esc(s.id) + '">转交</button>' +
              '<button class="btn-ghost" data-release="' + esc(s.id) + '">取消认领</button>'
            : '<button class="btn-ghost" data-claim="' + esc(s.id) + '">认领</button>') +
          '<button class="btn-ghost" data-edit-shop="' + esc(s.id) + '">编辑</button>' +
          '<button class="btn-ghost danger" data-del-shop="' + esc(s.id) + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');

    $$('#shoppingList [data-buy]').forEach(function (b) {
      b.addEventListener('click', function () { startPurchase(b.getAttribute('data-buy')); });
    });
    $$('#shoppingList [data-claim]').forEach(function (b) {
      b.addEventListener('click', function () { openAssign('claim', b.getAttribute('data-claim')); });
    });
    $$('#shoppingList [data-transfer]').forEach(function (b) {
      b.addEventListener('click', function () { openAssign('transfer', b.getAttribute('data-transfer')); });
    });
    $$('#shoppingList [data-release]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-release');
        var s = store.getShopping(id);
        if (!s) return;
        if (!confirm('取消认领「' + s.name + '」？它会回到待认领列表。')) return;
        var relRes = guard(function () { return store.releaseShopping(id); });
        if (!relRes.ok) return;
        if (relRes.value) {
          toast('已取消认领：' + s.name);
          renderAll();
        }
      });
    });
    $$('#shoppingList [data-edit-shop]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = store.getShopping(b.getAttribute('data-edit-shop'));
        if (s) openShoppingForm(s);
      });
    });
    $$('#shoppingList [data-del-shop]').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = store.getShopping(b.getAttribute('data-del-shop'));
        if (!s) return;
        if (!confirm('删除待购项「' + s.name + '」？')) return;
        var delRes = guard(function () { return store.removeShopping(s.id); });
        if (!delRes.ok) return;
        toast('已删除待购项');
        renderAll();
      });
    });
    $$('#shoppingList [data-item]').forEach(function (a) {
      a.addEventListener('click', function () {
        var id = a.getAttribute('data-item');
        if (store.getItem(id)) openDetail(id);
      });
    });
  }

  // ---------- 认领 / 转交 / 设置身份 ----------
  // mode: 'claim'（待认领项认领）/ 'transfer'（已认领项转交，或直接用自己名字接手）/ 'identity'（仅设置本机身份）
  function openAssign(mode, shoppingId) {
    var s = shoppingId ? store.getShopping(shoppingId) : null;
    if (shoppingId && !s) return;
    state.assignCtx = { mode: mode, shoppingId: shoppingId || null, name: s ? s.name : '' };
    fillMemberDatalists();
    var title, hint, label, submit;
    if (mode === 'identity') {
      title = '设置当前家庭成员';
      hint = '这个称呼只保存在本机浏览器，点“认领”时会自动带上。';
      label = '你的称呼';
      submit = '保存';
    } else if (mode === 'transfer') {
      title = '转交代购';
      hint = '把「' + (s ? s.name : '') + '」转交给另一位家庭成员，或输入你自己的名字直接接手。' +
        (s && s.assignee ? '当前负责人：' + s.assignee : '');
      label = '新负责人名字';
      submit = '确认转交';
    } else {
      title = '认领待购项';
      hint = '认领后「' + (s ? s.name : '') + '」由你负责购买；也可以替其他成员认领。';
      label = '负责人名字';
      submit = '确认认领';
    }
    $('#assignTitle').textContent = title;
    $('#assignHint').textContent = hint;
    $('#assignNameLabel').innerHTML = esc(label) + ' <em>*</em>';
    $('#assignSubmit').textContent = submit;
    $('#assignName').value = mode === 'transfer' ? '' : getIdentity();
    var memberBox = $('#assignMembers');
    var members = shopMembers();
    memberBox.innerHTML = members.length
      ? '<span class="assign-members-label">快速选择：</span>' +
          members.map(function (n) {
            return '<button type="button" class="member-chip' +
              (n === getIdentity() ? ' me' : '') + '" data-member="' + esc(n) + '">' + esc(n) + '</button>';
          }).join('')
      : '';
    $$('#assignMembers [data-member]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $('#assignName').value = chip.getAttribute('data-member');
        $('#assignName').focus();
      });
    });
    $('#sheetAssign').hidden = false;
    setTimeout(function () { $('#assignName').focus(); }, 0);
  }

  function confirmAssign(e) {
    e.preventDefault();
    var ctx = state.assignCtx;
    if (!ctx) return;
    var name = $('#assignName').value.trim();
    if (!name) { toast('请填写负责人名字'); return; }
    if (ctx.mode === 'identity') {
      setIdentity(name);
      toast('已设置当前身份：' + name);
    } else {
      var s = ctx.shoppingId ? store.getShopping(ctx.shoppingId) : null;
      if (!s) { closeSheet('sheetAssign'); state.assignCtx = null; renderAll(); return; }
      var ok;
      var claimRes = guard(function () {
        if (ctx.mode === 'transfer') {
          ok = store.transferShopping(ctx.shoppingId, name);
        } else {
          ok = store.claimShopping(ctx.shoppingId, name);
        }
        return ok;
      });
      if (!claimRes.ok) return;
      if (ctx.mode === 'transfer') {
        toast(ok ? '已转交给 ' + name : '无需转交（负责人未变化或已购买）');
      } else {
        toast(ok ? '已认领：' + s.name + '（负责人 ' + name + '）' : '认领失败（可能已被购买）');
      }
      // 认领/转交时若本机还没有身份，顺手记住，下次一键认领
      if (ok && !getIdentity()) setIdentity(name);
    }
    state.assignCtx = null;
    closeSheet('sheetAssign');
    renderAll();
  }

  // 点“已买到”：打开现有录入表单并预填名称和分类；待认领/已认领均可购买；
  // 保存成功（saveForm 中 completeShopping）才标记已购买，取消录入则状态保留
  function startPurchase(id) {
    var s = store.getShopping(id);
    if (!s || s.status === 'done') return;
    closeSheet('sheetShopping');
    state.view = 'inventory';
    switchView('inventory');
    // 新买到的食材一定是未归档，切回“全部”确保保存后立即可见
    if (state.filter !== 'all') {
      state.filter = 'all';
      $$('#statusFilter .chip').forEach(function (x) {
        x.classList.toggle('active', x.getAttribute('data-f') === 'all');
      });
      renderInventory();
    }
    openForm(null, { purchaseShopId: id });
  }

  // ---------- 方案视图 ----------
  function planScopeItems() {
    if (!state.pickedIds) return store.listItems();
    var ids = {};
    state.pickedIds.forEach(function (id) { ids[id] = true; });
    return store.listItems().filter(function (it) { return ids[it.id]; });
  }

  // 方案 used[] → 饮食评估目标。
  // 分类以“库存当前记录”为准（用户可能手动改过分类），其次用方案装配时带上的
  // categoryId，最后才退回按名称识别——只传 {id,name} 会把手选分类的食材漏报。
  function planDietTargets(used) {
    return (used || []).map(function (u) {
      var it = u.id ? store.getItem(u.id) : null;
      if (it) return { id: it.id, name: it.name, categoryId: it.categoryId || '' };
      return { id: u.id, name: u.name, categoryId: u.categoryId || '' };
    });
  }
  function planDietEval(diners, plan) {
    if (!diners.length || plan.type !== 'cook') return null;
    return FreshDiet.evaluate(diners, planDietTargets(plan.used));
  }

  // ---------- 就餐成员条（方案页 / 用餐计划表单共用） ----------
  // onChange(id) 点击成员 chip 时切换选中；onManage() 点击“管理”打开成员管理弹层
  function renderDinerBar(rootId, selectedIds, onChange, onManage) {
    var root = $(rootId);
    var all = store.listMembers();
    var html;
    if (!all.length) {
      html = '<button type="button" class="diner-manage" id="' + rootId.slice(1) + 'Manage">👨‍👩‍👧 还没有家庭成员，点此添加（过敏 / 忌口 / 偏好）</button>';
    } else {
      html = '<span class="diner-label">就餐成员：</span>' + all.map(function (m) {
        var on = selectedIds.indexOf(m.id) >= 0;
        var warn = tagsOf(m, 'allergy').length || tagsOf(m, 'avoid').length;
        return '<button type="button" class="diner-chip' + (on ? ' on' : '') +
          (warn ? ' has-diet' : '') + '" data-diner="' + esc(m.id) + '">' +
          (warn ? '🍽️ ' : '🙂 ') + esc(m.name) + '</button>';
      }).join('') +
      '<button type="button" class="diner-manage" data-manage>⚙️ 管理成员</button>';
    }
    root.innerHTML = html;
    $$('[data-diner]', root).forEach(function (chip) {
      chip.addEventListener('click', function () { onChange(chip.getAttribute('data-diner')); });
    });
    var manageBtn = $('[data-manage]', root) || $('#' + rootId.slice(1) + 'Manage');
    if (manageBtn) manageBtn.addEventListener('click', onManage);
  }

  // 方案页成员条：选择结果存 state.planDinerIds 并记忆到本机
  function renderPlanDinerBar() {
    // 清理已删除成员
    var valid = {};
    store.listMembers().forEach(function (m) { valid[m.id] = true; });
    state.planDinerIds = state.planDinerIds.filter(function (id) { return valid[id]; });
    renderDinerBar('#planDiners', state.planDinerIds, function (id) {
      var i = state.planDinerIds.indexOf(id);
      if (i >= 0) state.planDinerIds.splice(i, 1); else state.planDinerIds.push(id);
      setSavedDiners(state.planDinerIds);
      renderPlan();
    }, openMembersSheet);
  }

  // 把某方案的 used[] 汇总成 { blockers, warnings } 快照（用于确认继续时入审计）
  function dietAckFromEvaluation(evalResult) {
    return {
      blockers: evalResult.blockers.map(function (r) {
        return r.name + '（' + FreshDiet.reasonLines(r.blockers).join('、') + '）';
      }),
      warnings: evalResult.warnings.map(function (r) {
        return r.name + '（' + FreshDiet.reasonLines(r.warnings).join('、') + '）';
      })
    };
  }

  function renderPlan() {
    // 快速勾选区：优先展示临期/高风险食材
    var active = FreshEngine.activeAssessments(store.listItems());
    var diners = membersByIds(state.planDinerIds);
    // 勾选范围外的库存若与成员冲突，在范围提示下方给出明确警告
    var scopeEval = diners.length ? FreshDiet.evaluate(diners, active) : null;
    var scopeConflictIds = {};
    if (scopeEval) {
      scopeEval.blockers.forEach(function (r) { scopeConflictIds[r.id] = 'allergy'; });
      scopeEval.warnings.forEach(function (r) { if (!scopeConflictIds[r.id]) scopeConflictIds[r.id] = 'avoid'; });
    }
    var pickRoot = $('#quickPick');
    var picked = state.pickedIds;
    pickRoot.innerHTML = active.map(function (a) {
      var on = !picked || picked.indexOf(a.item.id) >= 0;
      var conflict = scopeConflictIds[a.item.id];
      var mark = a.status === 'expired' || a.status === 'danger' || a.status === 'warn'
        ? ' <span style="color:var(--danger)">●</span>'
        : '';
      var dietMark = conflict === 'allergy' ? ' 🚫' : conflict === 'avoid' ? ' ⚠️' : '';
      return '<button class="pick-chip ' + (on ? 'on' : '') +
        (conflict === 'allergy' ? ' diet-block' : conflict === 'avoid' ? ' diet-warn' : '') +
        '" data-id="' + esc(a.item.id) + '" title="' + (conflict ? esc((conflict === 'allergy' ? '过敏：' : '忌口：') +
          dietConflictTip(scopeEval, a.item.id)) : '') + '">' +
        esc(a.item.name) + mark + dietMark +
      '</button>';
    }).join('') +
    '<button class="pick-chip" id="pickScope" style="border-style:dashed">' +
      (picked ? '已选 ' + picked.length + ' 样 · 点此用全部库存' : '当前：全部库存') +
    '</button>';

    $$('#quickPick .pick-chip[data-id]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-id');
        var cur = state.pickedIds || active.map(function (a) { return a.item.id; });
        var idx = cur.indexOf(id);
        if (idx >= 0) cur.splice(idx, 1); else cur.push(id);
        state.pickedIds = cur;
        renderPlan();
      });
    });
    $('#pickScope').addEventListener('click', function () {
      state.pickedIds = null;
      renderPlan();
    });

    renderPlanDinerBar();

    var plans = FreshPlanner.buildPlans(planScopeItems());
    state.lastPlans = plans;
    // 为每个方案附带当前就餐成员的饮食评估（目标含库存已确认分类，见 planDietTargets）
    var planEvals = plans.map(function (p) { return planDietEval(diners, p); });

    var root = $('#planList');
    // 库存中（不限于方案）的冲突食材明确提示
    var scopeWarnHtml = scopeEval && (scopeEval.blockers.length || scopeEval.warnings.length)
      ? '<div class="diet-scope-warn"><b>🍽️ 所选成员的饮食冲突（库存中）：</b>' +
        scopeEval.blockers.slice(0, 6).map(function (r) {
          return '<span class="diet-line blocker">🚫 ' + esc(r.name) + '：' +
            esc(FreshDiet.reasonLines(r.blockers).join('、')) + '</span>';
        }).join('') +
        scopeEval.warnings.slice(0, 6).map(function (r) {
          return '<span class="diet-line warning">⚠️ ' + esc(r.name) + '：' +
            esc(FreshDiet.reasonLines(r.warnings).join('、')) + '</span>';
        }).join('') +
        '<span class="hint">提示：过敏食材不会被自动选入方案；下面各方案可逐样替换冲突食材。</span></div>'
      : '';
    if (!plans.length) {
      root.innerHTML = scopeWarnHtml +
        '<p class="empty-hint">当前选中的食材暂时凑不出方案。<br>试试勾选更多食材，或先处理过期食材。</p>';
      return;
    }

    var ICONS = { cook: '🍳', discard: '🗑️', freeze: '❄️', reheat: '♨️' };
    var TAGS = { cook: ['pt-cook', '烹饪'], discard: ['pt-discard', '丢弃'], freeze: ['pt-freeze', '冷冻'], reheat: ['pt-reheat', '复热'] };

    root.innerHTML = scopeWarnHtml + plans.map(function (p, i) {
      var ev = planEvals[i];
      var rowOf = {};
      if (ev) ev.list.forEach(function (r) { rowOf[r.id] = r; });
      var dietBox = ev && ev.hasConflict
        ? '<div class="plan-diet-box">' +
            (ev.blockers.length
              ? '<div class="diet-line blocker"><b>🚫 过敏冲突 ' + ev.blockerCount + ' 处：</b>' +
                ev.blockers.map(function (r) {
                  return esc(r.name) + '（' + esc(FreshDiet.reasonLines(r.blockers).join('、')) + '）';
                }).join('；') + '</div>' : '') +
            (ev.warnings.length
              ? '<div class="diet-line warning"><b>⚠️ 忌口 ' + ev.warningCount + ' 处：</b>' +
                ev.warnings.map(function (r) {
                  return esc(r.name) + '（' + esc(FreshDiet.reasonLines(r.warnings).join('、')) + '）';
                }).join('；') + '</div>' : '') +
            '<div class="hint">点「按此方案处理」后可逐样<b>替换冲突食材</b>，或确认风险后继续。</div>' +
          '</div>'
        : '';
      return '<div class="plan-card" data-i="' + i + '">' +
        '<div class="plan-top">' +
          '<span class="plan-icon">' + (ICONS[p.type] || '🍽️') + '</span>' +
          '<div><div class="plan-title">' + esc(p.title) + '</div>' +
            (p.minutes ? '<div class="plan-min">约 ' + p.minutes + ' 分钟</div>' : '') +
          '</div>' +
          '<span class="plan-tag ' + TAGS[p.type][0] + '">' + TAGS[p.type][1] + '</span>' +
        '</div>' +
        '<div class="plan-section">' +
          '<h4>使用食材（' + p.used.length + '）</h4>' +
          '<div class="used-tags">' + p.used.map(function (u) {
            var dot = /今天到期|近 /.test(u.statusLabel || '') || u.frozen;
            var dr = rowOf[u.id];
            var dcls = dr && dr.blockers.length ? ' diet-block-tag' : dr && dr.warnings.length ? ' diet-warn-tag' : '';
            var dmark = dr && dr.blockers.length ? ' 🚫' : dr && dr.warnings.length ? ' ⚠️' : '';
            return '<span class="used-tag' + (u.frozen ? ' frozen' : '') + dcls + '">' +
              (dot ? '<span class="urgent-dot">●</span>' : '') + esc(u.name) + dmark +
              (u.note ? ' <small>(' + esc(u.note) + ')</small>' : '') + '</span>';
          }).join('') + '</div>' +
          (ev && ev.likes.length
            ? '<div class="diet-like">💚 偏好命中：' + ev.likes.map(function (r) {
                return esc(r.name) + '（' + esc(FreshDiet.reasonLines(r.likes).join('、')) + '）';
              }).join('；') + '</div>' : '') +
          dietBox +
          (p.stillUrgent.length
            ? '<h4 style="color:var(--danger)">做完后仍需尽快处理（' + p.stillUrgent.length + '）</h4>' +
              '<div class="used-tags">' + p.stillUrgent.map(function (u) {
                return '<span class="used-tag" style="background:var(--warn-soft);color:#a35e00">⚠️ ' + esc(u.name) +
                  ' <small>(' + esc(u.statusLabel) + ')</small></span>';
              }).join('') + '</div>'
            : '<h4 style="color:var(--green-dark)">✓ 应用后没有遗留的临期食材</h4>') +
        '</div>' +
        '<div class="plan-actions">' +
          (p.type === 'cook'
            ? '<button class="btn-primary" data-apply="' + i + '">按此方案处理并记录</button>'
            : '<button class="btn-primary ' + (p.type === 'discard' ? 'danger' : '') + '" data-apply="' + i + '">执行并记录</button>') +
          (p.type === 'cook'
            ? '<button class="btn-ghost" data-meal="' + i + '">📅 加入计划</button>' : '') +
          '<button class="btn-ghost" data-detail="' + i + '">查看步骤</button>' +
        '</div>' +
      '</div>';
    }).join('');

    $$('#planList [data-detail]').forEach(function (b) {
      b.addEventListener('click', function () { openPlanDetail(+b.getAttribute('data-detail')); });
    });
    $$('#planList [data-apply]').forEach(function (b) {
      b.addEventListener('click', function () { applyPlan(+b.getAttribute('data-apply')); });
    });
    $$('#planList [data-meal]').forEach(function (b) {
      b.addEventListener('click', function () { mealPlanFromRecipe(+b.getAttribute('data-meal')); });
    });
  }

  // 方案页一键带入：方案名作计划名、方案食材预勾选、就餐成员一并带入
  function mealPlanFromRecipe(i) {
    var p = state.lastPlans[i];
    if (!p) return;
    state.mealPresetSource = 'plan';
    openMealPlanForm({
      name: p.title,
      itemIds: p.used.map(function (u) { return u.id; }),
      memberIds: state.planDinerIds.slice()
    });
  }

  function openPlanDetail(i) {
    var p = state.lastPlans[i];
    if (!p) return;
    var diners = membersByIds(state.planDinerIds);
    var ev = planDietEval(diners, p);
    var dietBlock = '';
    if (ev && ev.hasConflict) {
      dietBlock = '<div class="pd-block"><h4>🍽️ 饮食冲突</h4>' +
        (ev.blockers.length ? '<div class="diet-scope-warn">' + ev.blockers.map(function (r) {
          return '<div class="diet-line blocker">🚫 <b>' + esc(r.name) + '</b>：' +
            esc(FreshDiet.reasonLines(r.blockers).join('、')) + '</div>';
        }).join('') + '</div>' : '') +
        (ev.warnings.length ? ev.warnings.map(function (r) {
          return '<div class="diet-line warning">⚠️ <b>' + esc(r.name) + '</b>：' +
            esc(FreshDiet.reasonLines(r.warnings).join('、')) + '</div>';
        }).join('') : '') +
        '<p class="hint">应用前可在方案卡片上替换冲突食材，或在确认框中明示风险后继续。</p></div>';
    }
    var html = '<div class="pd-title">' + esc(p.title) + '</div>' +
      (diners.length ? '<div class="plan-min">就餐成员：' + diners.map(function (m) { return esc(m.name); }).join('、') + '</div>' : '') +
      (p.minutes ? '<div class="plan-min">约 ' + p.minutes + ' 分钟</div>' : '') +
      '<div class="pd-block"><h4>使用了哪些食材</h4><div class="used-tags">' +
        p.used.map(function (u) {
          var dr = ev ? ev.list.filter(function (r) { return r.id === u.id; })[0] : null;
          var dcls = dr && dr.blockers.length ? ' diet-block-tag' : dr && dr.warnings.length ? ' diet-warn-tag' : '';
          return '<span class="used-tag' + (u.frozen ? ' frozen' : '') + dcls + '">' + esc(u.name) +
            (u.note ? ' <small>(' + esc(u.note) + ')</small>' : '') + '</span>';
        }).join('') + '</div></div>' +
      dietBlock +
      (p.steps && p.steps.length
        ? '<ol class="pd-steps">' + p.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>'
        : '') +
      (p.leftoverNote ? '<p class="hint">' + esc(p.leftoverNote) + '</p>' : '') +
      (p.tip ? '<div class="pd-tip">💡 ' + esc(p.tip) + '</div>' : '') +
      '<div class="pd-block"><h4>应用后仍需尽快处理</h4>' +
        (p.stillUrgent.length
          ? '<div class="still-list">' + p.stillUrgent.map(function (u) {
              return '<div class="row"><span>⚠️ ' + esc(u.name) + '</span><b>' + esc(u.statusLabel) + '</b></div>';
            }).join('') + '</div>'
          : '<div class="still-list" style="background:var(--green-soft);color:var(--green-dark)">✓ 没有遗留的临期食材</div>') +
      '</div>' +
      '<div class="form-actions"><button class="btn-ghost" data-close>关闭</button>' +
      (p.type === 'cook' ? '<button class="btn-ghost" id="pdMeal">📅 加入用餐计划</button>' : '') +
      '<button class="btn-primary ' + (p.type === 'discard' ? 'danger' : '') + '" id="pdApply">按此方案处理并记录</button></div>';

    $('#planDetailBody').innerHTML = html;
    $('#sheetPlan').hidden = false;
    $('#pdApply').addEventListener('click', function () {
      closeSheet('sheetPlan');
      applyPlan(i);
    });
    var pdMeal = $('#pdMeal');
    if (pdMeal) pdMeal.addEventListener('click', function () {
      closeSheet('sheetPlan');
      mealPlanFromRecipe(i);
    });
  }

  function applyPlan(i) {
    var p = state.lastPlans[i];
    if (!p) return;
    var diners = membersByIds(state.planDinerIds);
    var ev = planDietEval(diners, p);
    // 有过敏/忌口冲突时进入解决弹层：可替换、确认风险后继续；无冲突沿用原确认框
    if (ev && ev.hasConflict) {
      openDietResolver({
        mode: 'plan',
        title: '方案饮食冲突：' + p.title,
        planIndex: i,
        plan: p,
        eval: ev,
        members: diners,
        onDone: function (finalPlan, finalEval, ackedBlockers, ackedWarnings) {
          var verb = finalPlan.type === 'discard' ? '确认丢弃以上食材？' : '确认已做熟并记录？';
          if (!confirm('「' + finalPlan.title + '」\n将为 ' + finalPlan.used.length + ' 样食材写入处理记录。\n' + verb)) return false;
          var ack = dietAckFromEvaluation(finalEval);
          var applyRes = guard(function () {
            return store.applyPlan(finalPlan, undefined, {
              memberNames: diners.map(function (m) { return m.name; }),
              diet: { blockers: ackedBlockers.length ? ackedBlockers : ack.blockers, warnings: ackedWarnings.length ? ackedWarnings : ack.warnings }
            });
          });
          if (!applyRes.ok) return false; // 保存失败：冲突解决弹层关闭与否由失败提示弹层接管
          toast('已记录方案处理结果');
          renderAll();
          return true;
        }
      });
      return;
    }
    var verb = { cook: '确认已做熟并记录？', discard: '确认丢弃以上食材？', freeze: '确认已分装放入冷冻？', reheat: '确认已彻底复热？' }[p.type] || '确认执行？';
    if (!confirm('「' + p.title + '」\n将为 ' + p.used.length + ' 样食材写入处理记录。\n' + verb)) return;
    var applyRes = guard(function () { return store.applyPlan(p); });
    if (!applyRes.ok) return;
    toast('已记录方案处理结果');
    renderAll();
  }

  // ---------- 家庭成员：饮食偏好/忌口/过敏管理 ----------
  var DIET_GROUP_META = [
    { kind: 'allergy', title: '🚫 过敏食材（命中会阻断，必须确认风险或替换）', cls: 'blocker', allowText: true },
    { kind: 'avoid',   title: '⚠️ 忌口 / 不喜欢（命中会警告，确认后可继续）', cls: 'warning', allowText: true },
    { kind: 'prefer',  title: '💚 偏好 / 爱吃（只做正向提示，优先消耗）', cls: 'like', allowText: true }
  ];

  function openMembersSheet() {
    renderMembers();
    $('#sheetMembers').hidden = false;
  }

  function renderMembers() {
    var root = $('#memberList');
    var members = store.listMembers();
    if (!members.length) {
      root.innerHTML = '<p class="empty-hint">还没有成员。添加后即可在方案和用餐计划里选择就餐成员。</p>';
      return;
    }
    root.innerHTML = members.map(function (m) {
      var n = function (k) { return tagsOf(m, k).length; };
      return '<div class="member-card" data-id="' + esc(m.id) + '">' +
        '<div class="member-head">' +
          '<b class="member-name">' + esc(m.name) + '</b>' +
          '<span class="member-edit hint">点卡片编辑</span>' +
        '</div>' +
        (m.note ? '<div class="member-note">' + esc(m.note) + '</div>' : '') +
        '<div class="member-tags">' +
          (n('allergy') ? '<div><span class="diet-kind blocker">过敏</span> ' + tagChipsHtml(tagsOf(m, 'allergy'), 'dt-allergy') + '</div>' : '') +
          (n('avoid') ? '<div><span class="diet-kind warning">忌口</span> ' + tagChipsHtml(tagsOf(m, 'avoid'), 'dt-avoid') + '</div>' : '') +
          (n('prefer') ? '<div><span class="diet-kind like">偏好</span> ' + tagChipsHtml(tagsOf(m, 'prefer'), 'dt-prefer') + '</div>' : '') +
          (!n('allergy') && !n('avoid') && !n('prefer') ? '<span class="hint">未设置饮食限制</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
    $$('#memberList .member-card').forEach(function (card) {
      card.addEventListener('click', function () { openMemberForm(card.getAttribute('data-id')); });
    });
  }

  // ---- 成员表单（分类多选 + 自定义关键词标签）----
  function openMemberForm(memberId) {
    var m = memberId ? store.getMember(memberId) : null;
    state.editingMemberId = m ? m.id : null;
    state.memberFormTags = {
      allergy: m ? tagsOf(m, 'allergy').slice() : [],
      avoid: m ? tagsOf(m, 'avoid').slice() : [],
      prefer: m ? tagsOf(m, 'prefer').slice() : []
    };
    $('#memberFormTitle').textContent = m ? '编辑成员：' + m.name : '添加家庭成员';
    $('#mbName').value = m ? m.name : '';
    $('#mbNote').value = m ? (m.note || '') : '';
    $('#btnDeleteMember').hidden = !m;
    renderMemberDietGroups();
    $('#sheetMemberForm').hidden = false;
    setTimeout(function () { $('#mbName').focus(); }, 0);
  }

  function renderMemberDietGroups() {
    var root = $('#mbDietGroups');
    root.innerHTML = DIET_GROUP_META.map(function (g) {
      var tags = state.memberFormTags[g.kind];
      var cats = tags.filter(function (t) { return FreshDiet.isCatTag(t); })
        .map(function (t) { return FreshDiet.catIdFromTag(t); });
      var custom = tags.filter(function (t) { return !FreshDiet.isCatTag(t); });
      var catChips = FreshRules.categories.map(function (c) {
        var on = cats.indexOf(c.id) >= 0;
        return '<button type="button" class="cat-chip' + (on ? ' on ' + g.cls : '') +
          '" data-cat="' + c.id + '" data-kind="' + g.kind + '">' + esc(c.name) + '</button>';
      }).join('');
      return '<div class="diet-group">' +
        '<div class="diet-group-title">' + g.title + '</div>' +
        '<div class="cat-chips">' + catChips + '</div>' +
        '<div class="custom-tag-row">' +
          custom.map(function (t, ti) {
            return '<span class="custom-tag ' + g.cls + '" data-kind="' + g.kind + '" data-ti="' + ti + '">' +
              esc(t) + ' <b data-del>×</b></span>';
          }).join('') +
          '<input type="text" class="custom-tag-input" maxlength="20" data-kind="' + g.kind +
            '" placeholder="＋ 其他食材，如花生（回车添加）" autocomplete="off">' +
        '</div>' +
      '</div>';
    }).join('');

    $$('#mbDietGroups [data-cat]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-kind');
        var tag = FreshDiet.catTag(btn.getAttribute('data-cat'));
        var arr = state.memberFormTags[kind];
        var i = arr.indexOf(tag);
        if (i >= 0) arr.splice(i, 1); else arr.push(tag);
        renderMemberDietGroups();
      });
    });
    $$('#mbDietGroups .custom-tag [data-del]').forEach(function (x) {
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        var span = x.closest('.custom-tag');
        var kind = span.getAttribute('data-kind');
        state.memberFormTags[kind].splice(+span.getAttribute('data-ti'), 1);
        renderMemberDietGroups();
      });
    });
    $$('#mbDietGroups .custom-tag-input').forEach(function (inp) {
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
          e.preventDefault();
          var v = inp.value.trim().replace(/[,，]/g, '');
          if (v) {
            var kind = inp.getAttribute('data-kind');
            var arr = state.memberFormTags[kind];
            if (arr.indexOf(v) < 0) arr.push(v);
            renderMemberDietGroups();
          }
        }
      });
    });
  }

  function saveMemberForm(e) {
    e.preventDefault();
    var name = $('#mbName').value.trim();
    if (!name) { toast('请填写成员姓名'); return; }
    var fields = {
      name: name,
      note: $('#mbNote').value.trim(),
      allergyTags: state.memberFormTags.allergy,
      avoidTags: state.memberFormTags.avoid,
      preferTags: state.memberFormTags.prefer
    };
    try {
      if (state.editingMemberId) {
        store.updateMember(state.editingMemberId, fields);
        toast('已更新成员信息');
      } else {
        store.addMember(fields);
        toast('已添加成员：' + name);
      }
    } catch (err) {
      if (FreshStorage.StorageWriteError && FreshStorage.StorageWriteError.is(err)) {
        showStorageFull(err);  // 弹层保持、输入保留
        return;
      }
      toast(err.message || '保存失败');
      return;
    }
    state.editingMemberId = null;
    closeSheet('sheetMemberForm');
    renderAll();
    // 成员管理弹层若开着（从其内部点“添加/编辑”），重新打开并刷新列表
    if (!$('#sheetMembers').hidden) renderMembers();
    else openMembersSheet();
  }

  // ---------- 饮食冲突解决弹层 ----------
  // ctx:
  //   mode 'plan'：{ planIndex, plan, members, eval, onDone(finalPlan, finalEval, ackBlockers, ackWarnings) }
  //   mode 'meal'：{ members, targets(): 当前勾选食材, onChange(id, newId|null), onDone(eval, ackB, ackW) }
  function openDietResolver(ctx) {
    state.dietCtx = ctx;
    state.dietSubstitutingId = null;
    $('#dietTitle').textContent = ctx.title || '饮食冲突提示';
    $('#dietIntro').textContent = '红色为过敏食材，必须替换或明确确认风险后才能继续；' +
      '橙色为忌口食材，可替换或直接确认继续。替换只会换成同菜谱槽位的其他在库食材。';
    renderDietRows();
    $('#dietAck').checked = false;
    $('#sheetDiet').hidden = false;
  }

  function renderDietRows() {
    var ctx = state.dietCtx;
    if (!ctx) return;
    // meal 模式每次重渲染（勾选可能已变）；plan 模式替换后由调用方更新 ctx.eval/plan
    var ev = ctx.eval;
    var rowsBox = $('#dietRows');
    var candBox = $('#dietCandidates');
    candBox.hidden = true;
    candBox.innerHTML = '';

    var rows = ev.blockers.map(function (r) { return { r: r, cls: 'blocker', icon: '🚫', kind: '过敏' }; })
      .concat(ev.warnings.map(function (r) { return { r: r, cls: 'warning', icon: '⚠️', kind: '忌口' }; }));
    rowsBox.innerHTML = rows.map(function (row, i) {
      var hits = FreshDiet.reasonLines(row.r.blockers).concat(FreshDiet.reasonLines(row.r.warnings));
      return '<div class="diet-row ' + row.cls + '" data-row="' + i + '" data-id="' + esc(row.r.id) + '">' +
        '<div class="diet-row-main">' +
          '<b>' + row.icon + ' ' + esc(row.r.name) + '</b>' +
          '<span class="diet-hits">' + esc(hits.join('；')) + '</span>' +
        '</div>' +
        '<div class="diet-row-actions">' +
          (ctx.mode === 'plan'
            ? '<button type="button" class="btn-ghost" data-action="replace">替换</button>'
            : '<button type="button" class="btn-ghost" data-action="remove">移除</button>') +
        '</div>' +
      '</div>';
    }).join('');

    // 偏好命中只作提示
    if (ev.likes.length) {
      rowsBox.innerHTML += '<div class="diet-like">💚 偏好命中：' + ev.likes.map(function (r) {
        return esc(r.name) + '（' + esc(FreshDiet.reasonLines(r.likes).join('、')) + '）';
      }).join('；') + '</div>';
    }

    var ackBox = $('#dietAckBox');
    var continueBtn = $('#btnDietContinue');
    if (ev.blockers.length) {
      ackBox.hidden = false;
      $('#dietAckLabel').innerHTML = '我已知悉 <b>' + ev.blockers.length + '</b> 样食材含成员过敏原，' +
        '烹饪/就餐时将做替换或单独处理，确认继续';
      continueBtn.disabled = false; // 提交时再强校验勾选，提示更明确
    } else if (ev.warnings.length) {
      ackBox.hidden = false;
      $('#dietAckLabel').innerHTML = '我已知悉 <b>' + ev.warnings.length + '</b> 样忌口食材，确认继续';
      continueBtn.disabled = false;
    } else {
      ackBox.hidden = true;
    }
  }

  // plan 模式：列出同槽位替换候选；选中后用 planner 重建方案并重评估
  function showSubstitutions(itemId, rowsBox) {
    var ctx = state.dietCtx;
    state.dietSubstitutingId = itemId;
    var candBox = $('#dietCandidates');
    var candidates = FreshPlanner.substitutionCandidates(ctx.plan, itemId, store.listItems(), {
      members: ctx.members
    });
    var oldName = (ctx.plan.used.filter(function (u) { return u.id === itemId; })[0] || {}).name || '';
    candBox.hidden = false;
    if (!candidates.length) {
      candBox.innerHTML = '<div class="hint">「' + esc(oldName) + '」没有可替换的同类型在库食材，' +
        '可先取消并到库存录入，或勾选确认风险后继续。</div>';
      return;
    }
    candBox.innerHTML = '<div class="hint" style="margin-bottom:6px">把「<b>' + esc(oldName) + '</b>」替换为：</div>' +
      candidates.slice(0, 8).map(function (c) {
        return '<button type="button" class="cand-chip' + (c.safe ? '' : ' unsafe') + '" data-newid="' + esc(c.id) + '">' +
          esc(c.name) + ' <small>(' + esc(c.statusLabel) + (c.frozen ? '·冷冻中' : '') + ')' +
          (c.preferCount ? ' 💚' : '') + (!c.safe ? ' 🚫仍过敏' : '') + '</small></button>';
      }).join('');
  }

  // plan 模式：选中一个替换候选 → planner 重建方案并重评估
  function pickSubstitution(newId) {
    var ctx = state.dietCtx;
    if (!ctx || ctx.mode !== 'plan') return;
    // 候选框由某一行展开，记录当前正在替换的食材
    var itemId = state.dietSubstitutingId;
    var oldName = (ctx.plan.used.filter(function (u) { return u.id === itemId; })[0] || {}).name || '';
    var next = FreshPlanner.substituteInPlan(ctx.plan, itemId, { id: newId }, store.listItems());
    if (!next) { toast('该食材不能替换到这个槽位'); return; }
    var newEval = FreshDiet.evaluate(ctx.members, planDietTargets(next.used));
    // 同步 state.lastPlans 中的方案，方案卡立即反映替换结果
    state.lastPlans[ctx.planIndex] = next;
    ctx.plan = next;
    ctx.eval = newEval;
    state.dietSubstitutingId = null;
    toast('已替换：' + oldName + ' → ' + (next.used.filter(function (u) { return u.id === newId; })[0] || {}).name);
    renderDietRows();
    renderPlan();
  }

  // meal 模式：从勾选清单移除食材
  function removeMealPick(id) {
    var cb = $('#mPickList input[data-id="' + id + '"]');
    if (cb && cb.checked) {
      cb.checked = false;
      renderMealPreview();
    }
  }

  function refreshMealResolver() {
    var ctx = state.dietCtx;
    if (!ctx || ctx.mode !== 'meal') return;
    var targets = ctx.targets();
    if (!targets.length) {
      // 食材全部移除：无法创建计划，回到表单让用户重新勾选
      closeSheet('sheetDiet');
      state.dietCtx = null;
      toast('已移除全部冲突食材，请重新选择食材');
      renderMealPreview();
      return;
    }
    ctx.eval = FreshDiet.evaluate(ctx.members, targets);
    if (!ctx.eval.hasConflict) {
      // 冲突已全部解决：继续走创建
      confirmDietContinue();
      return;
    }
    renderDietRows();
  }

  function confirmDietContinue() {
    var ctx = state.dietCtx;
    if (!ctx) return;
    var ev = ctx.eval;
    var ackBlockers = [], ackWarnings = [];
    if (ev.blockers.length) {
      if (!$('#dietAck').checked) {
        toast('有过敏食材未处理：请替换、移除，或勾选确认风险');
        return;
      }
      ackBlockers = ev.blockers.map(function (r) {
        return r.name + '（' + FreshDiet.reasonLines(r.blockers).join('、') + '）';
      });
    }
    if (!ev.blockers.length && ev.warnings.length) {
      // 仅忌口：勾选确认或直接放行皆可；记录用户确认时的快照
      if ($('#dietAck').checked) {
        ackWarnings = ev.warnings.map(function (r) {
          return r.name + '（' + FreshDiet.reasonLines(r.warnings).join('、') + '）';
        });
      }
    } else if (ev.warnings.length) {
      ackWarnings = ev.warnings.map(function (r) {
        return r.name + '（' + FreshDiet.reasonLines(r.warnings).join('、') + '）';
      });
    }
    if (ctx.mode === 'plan') {
      var done = ctx.onDone(ctx.plan, ev, ackBlockers, ackWarnings);
      if (done !== false) {
        closeSheet('sheetDiet');
        state.dietCtx = null;
      }
    } else {
      var ok = ctx.onDone(ev, ackBlockers, ackWarnings);
      if (ok !== false) {
        closeSheet('sheetDiet');
        state.dietCtx = null;
      }
    }
  }

  // ---------- 用餐计划 ----------
  // 闭环：选食材 + 定日期 → 预览计划日预计状态（临期/过期给调整提示）→
  //       确认生成按日期排列的清单 → 标记完成时逐样写入做熟/吃完/丢弃事件 →
  //       计划状态与审计流水自动更新
  var MP_LEVEL_ICON = { gone: '🔴', expired: '🔴', danger: '🟠', warn: '🟠', frozen: '❄️' };
  var MP_LEVEL_CLS = { gone: 'bad', expired: 'bad', danger: 'warn', warn: 'warn', frozen: 'frozen' };

  function defaultMealName(dateStr) {
    var d = FreshEngine.parseISODate(dateStr) || FreshEngine.todayAt();
    return (d.getMonth() + 1) + '月' + d.getDate() + '日晚餐';
  }

  function relDateLabel(dateStr) {
    var d = FreshEngine.parseISODate(dateStr);
    if (!d) return '';
    var diff = FreshEngine.daysBetween(FreshEngine.todayAt(), d);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === 2) return '后天';
    if (diff > 0) return diff + ' 天后';
    return '已过期 ' + Math.abs(diff) + ' 天';
  }

  function mealDateLabel(dateStr) {
    var d = FreshEngine.parseISODate(dateStr);
    if (!d) return dateStr;
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + '日一二三四五六'[d.getDay()] +
      ' · ' + relDateLabel(dateStr);
  }

  // preset: { name, itemIds, source, memberIds }（从方案页一键带入）
  function openMealPlanForm(preset) {
    preset = preset || {};
    state.mealPresetIds = preset.itemIds || null;
    state.mealDinerIds = (preset.memberIds || getSavedDiners()).slice();
    $('#mName').value = preset.name || defaultMealName(todayISO());
    $('#mDate').value = preset.date || todayISO();
    renderMealDinerBar();
    renderMealPickList();
    renderMealPreview();
    $('#sheetMealPlan').hidden = false;
  }

  // 用餐计划表单成员条：点击切换成员，选择结果跨次记忆到本机
  function renderMealDinerBar() {
    var valid = {};
    store.listMembers().forEach(function (m) { valid[m.id] = true; });
    state.mealDinerIds = state.mealDinerIds.filter(function (id) { return valid[id]; });
    renderDinerBar('#mDinerBar', state.mealDinerIds, function (id) {
      var i = state.mealDinerIds.indexOf(id);
      if (i >= 0) state.mealDinerIds.splice(i, 1); else state.mealDinerIds.push(id);
      setSavedDiners(state.mealDinerIds);
      renderMealDinerBar();
      renderMealPickList();
      renderMealPreview();
    }, openMembersSheet);
  }

  function mealDiners() { return membersByIds(state.mealDinerIds); }

  // 库存 id → 饮食评估目标（带库存已确认分类，避免按名称猜分类漏报）
  function mealDietTargets(ids) {
    return (ids || []).map(function (id) {
      var it = store.getItem(id);
      return it ? { id: it.id, name: it.name, categoryId: it.categoryId || '' } : null;
    }).filter(Boolean);
  }

  function renderMealPickList() {
    var active = FreshEngine.activeAssessments(store.listItems());
    var preset = state.mealPresetIds;
    var diners = mealDiners();
    var dietEval = diners.length ? FreshDiet.evaluate(diners, active) : null;
    var dietOf = {};
    if (dietEval) {
      dietEval.list.forEach(function (r) {
        dietOf[r.id] = r.blockers.length ? 'allergy' : r.warnings.length ? 'avoid' : r.likes.length ? 'like' : '';
      });
    }
    var root = $('#mPickList');
    if (!active.length) {
      root.innerHTML = '<p class="hint" style="padding:10px 12px;margin:0">库存里没有在库的食材，请先录入。</p>';
      return;
    }
    root.innerHTML = active.map(function (a) {
      var on = preset ? preset.indexOf(a.item.id) >= 0 : false;
      var d = dietOf[a.item.id];
      return '<label class="meal-pick-row' + (d === 'allergy' ? ' diet-block-row' : d === 'avoid' ? ' diet-warn-row' : '') + '">' +
        '<input type="checkbox" data-id="' + esc(a.item.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="mp-name">' + esc(a.item.name) +
          (d === 'allergy' ? ' 🚫' : d === 'avoid' ? ' ⚠️' : d === 'like' ? ' 💚' : '') +
        '</span>' +
        '<span class="status-pill sp-' + a.status + '">' + esc(a.statusInfo.label) + '</span>' +
        '<span class="mp-meta">' + esc(daysText(a)) + '</span>' +
      '</label>';
    }).join('');
  }

  function checkedMealIds() {
    return $$('#mPickList input[type=checkbox]:checked').map(function (el) {
      return el.getAttribute('data-id');
    });
  }

  // 当前勾选食材对应的饮食评估（未选就餐成员返回 null）
  function checkedMealDietEval() {
    var diners = mealDiners();
    if (!diners.length) return null;
    return FreshDiet.evaluate(diners, mealDietTargets(checkedMealIds()));
  }

  // 计划日预计状态预览：对勾选的每样食材用引擎“快进到计划日”评估，
  // 临期/已过期/已归档/冷冻中给出调整提示；就餐成员的忌口/过敏在此一并明确提示
  function renderMealPreview() {
    var box = $('#mPreview');
    var dateStr = $('#mDate').value;
    var ids = checkedMealIds();
    if (!ids.length) {
      box.innerHTML = '勾选食材后，这里会显示它们在<b>用餐当天的预计状态</b>。';
      return;
    }
    var planDate = FreshEngine.parseISODate(dateStr);
    if (!planDate) { box.innerHTML = '请先选择用餐日期。'; return; }
    var lines = [], nBad = 0;
    ids.forEach(function (id) {
      var item = store.getItem(id);
      if (!item || item.removed) return;
      var adj = FreshEngine.planAdjustment(FreshEngine.assess(item, planDate));
      if (!adj) return;
      if (adj.level === 'expired' || adj.level === 'danger' || adj.level === 'gone') nBad++;
      lines.push('<div class="mp-line ' + MP_LEVEL_CLS[adj.level] + '">' +
        MP_LEVEL_ICON[adj.level] + ' ' + esc(item.name) + '：' + esc(adj.text) + '</div>');
    });
    var html = '<b>' + esc(mealDateLabel(dateStr)) + ' 的预计状态：</b>';
    html += lines.length ? lines.join('')
      : '<div class="mp-line">✓ 所选 ' + ids.length + ' 样食材到用餐日状态良好，无需调整。</div>';
    if (nBad) {
      html += '<div class="mp-line bad">共 ' + nBad + ' 样到用餐日已过期/不可吃，建议把计划改早、更换食材或先冷冻。</div>';
    }
    // 饮食冲突/偏好提示
    var diet = checkedMealDietEval();
    if (diet && diet.hasConflict) {
      diet.blockers.forEach(function (r) {
        html += '<div class="mp-line bad">🚫 <b>' + esc(r.name) + '</b> 含过敏原：' +
          esc(FreshDiet.reasonLines(r.blockers).join('、')) + '</div>';
      });
      diet.warnings.forEach(function (r) {
        html += '<div class="mp-line warn">⚠️ <b>' + esc(r.name) + '</b> 是忌口：' +
          esc(FreshDiet.reasonLines(r.warnings).join('、')) + '</div>';
      });
    }
    if (diet && diet.likes.length) {
      html += '<div class="mp-line good">💚 偏好命中：' + diet.likes.map(function (r) {
        return esc(r.name) + '（' + esc(FreshDiet.reasonLines(r.likes).join('、')) + '）';
      }).join('；') + '</div>';
    }
    box.innerHTML = html;
  }

  function saveMealPlanForm(e) {
    e.preventDefault();
    var name = $('#mName').value.trim();
    var date = $('#mDate').value;
    var ids = checkedMealIds();
    if (!name) { toast('请填写计划名称'); return; }
    if (!date) { toast('请选择用餐日期'); return; }
    if (!ids.length) { toast('请至少选择 1 样食材'); return; }

    // 饮食冲突：打开解决弹层（可移除冲突食材或确认风险后继续）
    var diners = mealDiners();
    var targets = mealDietTargets(ids);
    var diet = diners.length ? FreshDiet.evaluate(diners, targets) : null;
    if (diet && diet.hasConflict) {
      openDietResolver({
        mode: 'meal',
        title: '用餐计划饮食冲突',
        members: diners,
        eval: diet,
        targets: function () { return mealDietTargets(checkedMealIds()); },
        onDone: function (finalEval, ackBlockers, ackWarnings) {
          return doCreateMealPlan(name, date, finalEval, ackBlockers, ackWarnings);
        }
      });
      return;
    }
    doCreateMealPlan(name, date, diet, [], []);
  }

  // 实际创建（无冲突，或冲突已在解决弹层处理）；成员与冲突确认快照随计划保存
  function doCreateMealPlan(name, date, dietEval, ackBlockers, ackWarnings) {
    var ids = checkedMealIds();
    var items = ids.map(function (id) {
      var it = store.getItem(id);
      return it ? { id: it.id, name: it.name } : null;
    }).filter(Boolean);
    if (!items.length) { toast('请至少选择 1 样食材'); return false; }
    var source = state.mealPresetSource || 'manual';
    var fields = {
      name: name, date: date, items: items,
      members: state.mealDinerIds.slice()
    };
    if (dietEval && dietEval.hasConflict) {
      var ack = dietAckFromEvaluation(dietEval);
      fields.diet = {
        blockers: (ackBlockers && ackBlockers.length) ? ackBlockers : ack.blockers,
        warnings: (ackWarnings && ackWarnings.length) ? ackWarnings : ack.warnings
      };
    }
    var createRes = guard(function () { return store.addMealPlan(fields, source); });
    if (!createRes.ok) return false; // 保存失败：冲突弹层保留，失败提示已弹出
    state.mealPresetSource = null;
    state.mealPresetIds = null;
    closeSheet('sheetMealPlan');
    toast((fields.diet && (fields.diet.blockers.length || fields.diet.warnings.length))
      ? '已创建用餐计划（冲突确认已记录）' : '已创建用餐计划：' + name);
    switchView('mealplan');
    renderAll();
    return true;
  }

  // 计划卡片上每样食材的标签：按“计划日”的预计状态着色，点击跳转食材详情
  function mealItemTag(pi, planDate, interactive) {
    var item = store.getItem(pi.id);
    if (!item || item.removed) {
      return '<span class="used-tag mp-tag mp-gone">' + esc(pi.name) + ' <small>(已删除)</small></span>';
    }
    var note = null, cls = '';
    if (interactive) {
      var a = FreshEngine.assess(item, planDate);
      if (a.state.ended) { note = a.statusInfo.label; cls = 'mp-gone'; }
      else if (a.state.clockPaused) { note = '冷冻中'; cls = 'frozen'; }
      else if (a.status === 'expired') { note = '那天已过期 ' + Math.abs(a.safeDaysLeft) + ' 天'; cls = 'mp-bad'; }
      else if (a.status === 'danger' || a.status === 'warn') { note = '那天剩 ' + Math.max(a.safeDaysLeft, 0) + ' 天'; cls = 'mp-warn'; }
    }
    return '<a class="used-tag mp-tag ' + cls + '" data-item="' + esc(pi.id) + '">' +
      esc(pi.name) + (note ? ' <small>(' + esc(note) + ')</small>' : '') + '</a>';
  }

  function renderMealPlans() {
    var pending = store.listMealPlans('pending');
    var done = store.listMealPlans('done');
    var badge = $('#mealBadge');
    badge.textContent = String(pending.length);
    badge.hidden = pending.length === 0;

    var rows = state.mealFilter === 'done' ? done : pending;
    var root = $('#mealPlanList');
    var empty = $('#mealPlanEmpty');
    if (!rows.length) {
      root.innerHTML = '';
      empty.hidden = false;
      empty.textContent = state.mealFilter === 'done'
        ? '还没有已完成的用餐计划。在待用餐计划上点「标记完成」并记录每样食材的处理结果后会显示在这里。'
        : '还没有用餐计划。点上方「新建用餐计划」从库存挑选食材，或在「方案」页把某个做法一键加入计划。';
      return;
    }
    empty.hidden = true;

    root.innerHTML = rows.map(function (plan) {
      var isDone = plan.status === 'done';
      var planDate = FreshEngine.parseISODate(plan.date);
      var tags = plan.items.map(function (pi) { return mealItemTag(pi, planDate, !isDone); }).join('');
      // 就餐成员名（成员被删除时只显示姓名快照）
      var memberHtml = (plan.members && plan.members.length)
        ? '<div class="meal-members">🍽️ 就餐：' + plan.members.map(function (mb) {
            var still = store.getMember(mb.id);
            return '<span class="member-chip' + (still ? '' : ' gone') + '" title="' +
              (still ? memberDietTitle(still) : '该成员已删除') + '">' + esc(mb.name) + '</span>';
          }).join('') + '</div>'
        : '';
      // 创建时确认过的冲突快照
      var dietHtml = plan.diet && (plan.diet.blockers.length || plan.diet.warnings.length)
        ? '<div class="meal-diet-ack">' +
            (plan.diet.blockers.length ? '🚫 已确认过敏风险：' + plan.diet.blockers.map(esc).join('；') : '') +
            (plan.diet.blockers.length && plan.diet.warnings.length ? '<br>' : '') +
            (plan.diet.warnings.length ? '⚠️ 已确认忌口：' + plan.diet.warnings.map(esc).join('；') : '') +
          '</div>'
        : '';
      var hints = [];
      if (!isDone) {
        if (FreshEngine.daysBetween(FreshEngine.todayAt(), planDate) < 0) {
          hints.push({ icon: '🟠', text: '用餐日已过，可补记完成或删除该计划' });
        }
        plan.items.forEach(function (pi) {
          var item = store.getItem(pi.id);
          if (!item || item.removed) return;
          var adj = FreshEngine.planAdjustment(FreshEngine.assess(item, planDate));
          if (adj) hints.push({ icon: MP_LEVEL_ICON[adj.level], text: pi.name + '：' + adj.text });
        });
      }
      return '<div class="shop-card meal-card' + (isDone ? ' done' : '') + '">' +
        '<div class="shop-main">' +
          '<div class="shop-title">' +
            '<span class="shop-name">' + esc(plan.name) + '</span>' +
            '<span class="status-pill ' + (isDone ? 'sp-consumed' : 'sp-fresh') + '">' +
              (isDone ? '已完成' : '待用餐') + '</span>' +
            (plan.source === 'plan' ? '<span class="shop-src">🍳 来自方案</span>' : '') +
          '</div>' +
          '<div class="shop-meta">' +
            '<span>📅 ' + esc(mealDateLabel(plan.date)) + '</span>' +
            '<span>' + plan.items.length + ' 样食材</span>' +
            (isDone ? '<span>完成于 ' + fmtDateTime(plan.doneAt) + '</span>' : '') +
          '</div>' +
          memberHtml +
          dietHtml +
          '<div class="used-tags">' + tags + '</div>' +
          (hints.length
            ? '<div class="meal-hints">' + hints.slice(0, 4).map(function (h) {
                return h.icon + ' ' + esc(h.text);
              }).join('<br>') + (hints.length > 4 ? '<br>……共 ' + hints.length + ' 条提示' : '') + '</div>'
            : '') +
        '</div>' +
        (isDone ? '' :
          '<div class="shop-actions">' +
            '<button class="btn-primary" data-meal-done="' + esc(plan.id) + '">标记完成</button>' +
            '<button class="btn-ghost danger" data-meal-del="' + esc(plan.id) + '">删除</button>' +
          '</div>') +
      '</div>';
    }).join('');

    $$('#mealPlanList [data-meal-done]').forEach(function (b) {
      b.addEventListener('click', function () { openMealDone(b.getAttribute('data-meal-done')); });
    });
    $$('#mealPlanList [data-meal-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var plan = store.getMealPlan(b.getAttribute('data-meal-del'));
        if (!plan) return;
        if (!confirm('删除用餐计划「' + plan.name + '」？（不会改动食材库存）')) return;
        var mpDel = guard(function () { return store.removeMealPlan(plan.id); });
        if (!mpDel.ok) return;
        toast('已删除用餐计划');
        renderAll();
      });
    });
    $$('#mealPlanList [data-item]').forEach(function (a) {
      a.addEventListener('click', function () {
        var id = a.getAttribute('data-item');
        if (store.getItem(id)) openDetail(id);
      });
    });
  }

  // 完成计划：逐样选择 做熟/吃完/丢弃/不记录（默认吃完），确认后写入现有事件体系
  var MEAL_ACTS = [
    ['consume', '✅ 吃完', ''],
    ['cook', '🍳 做熟', ''],
    ['discard', '🗑️ 丢弃', 'danger'],
    ['skip', '不记录', '']
  ];
  function openMealDone(planId) {
    var plan = store.getMealPlan(planId);
    if (!plan || plan.status !== 'pending') return;
    state.mealDonePlanId = planId;
    state.mealDoneActions = {};
    $('#mealDoneTitle').textContent = '完成「' + plan.name + '」';
    $('#mealDoneList').innerHTML = plan.items.map(function (pi) {
      var item = store.getItem(pi.id);
      if (!item || item.removed) {
        return '<div class="meal-done-row"><span class="mp-done-name">' + esc(pi.name) + '</span>' +
          '<span class="mp-done-state">记录已删除，跳过</span></div>';
      }
      var a = FreshEngine.assess(item);
      if (a.state.ended) {
        return '<div class="meal-done-row"><span class="mp-done-name">' + esc(pi.name) + '</span>' +
          '<span class="mp-done-state">已归档（' + esc(a.statusInfo.label) + '），不再重复记录</span></div>';
      }
      state.mealDoneActions[pi.id] = 'consume';
      return '<div class="meal-done-row" data-row="' + esc(pi.id) + '">' +
        '<span class="mp-done-name">' + esc(pi.name) + '</span>' +
        '<span class="mp-done-state">' + esc(a.statusInfo.label) + ' · ' + esc(daysText(a)) + '</span>' +
        '<div class="mp-acts">' + MEAL_ACTS.map(function (spec) {
          return '<button type="button" class="mp-act' + (spec[2] ? ' ' + spec[2] : '') +
            (spec[0] === 'consume' ? ' on' : '') + '" data-act="' + spec[0] + '">' + spec[1] + '</button>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');

    $$('#mealDoneList .meal-done-row[data-row]').forEach(function (row) {
      var itemId = row.getAttribute('data-row');
      $$('.mp-act', row).forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.mealDoneActions[itemId] = btn.getAttribute('data-act');
          $$('.mp-act', row).forEach(function (x) { x.classList.toggle('on', x === btn); });
        });
      });
    });
    $('#sheetMealDone').hidden = false;
  }

  function confirmMealDone() {
    var planId = state.mealDonePlanId;
    var plan = planId ? store.getMealPlan(planId) : null;
    if (!plan) return;
    var actions = state.mealDoneActions;
    var nDiscard = Object.keys(actions).filter(function (k) { return actions[k] === 'discard'; }).length;
    if (nDiscard && !confirm('包含 ' + nDiscard + ' 样「丢弃」记录，确认完成？')) return;
    var doneRes = guard(function () { return store.completeMealPlan(planId, actions); });
    if (!doneRes.ok) return;
    state.mealDonePlanId = null;
    state.mealDoneActions = {};
    closeSheet('sheetMealDone');
    toast('已完成用餐计划，处理结果已记入库存与追溯');
    renderAll();
  }

  // ---------- 追溯视图 ----------
  var AUDIT_META = {
    'item.create': ['录入食材', 'a-update', '📥'],
    'item.update': ['修改信息', 'a-update', '✏️'],
    'item.remove': ['删除记录', 'a-remove', '🗑️'],
    'item.restore': ['恢复记录', 'a-update', '↩️'],
    'event.add': ['记录期限事件', 'a-event', '🧷'],
    'event.undo': ['撤销事件', 'a-event', '↩️'],
    'plan.apply': ['应用方案', 'a-plan', '🍳'],
    'shopping.add': ['加入待购', 'a-shop', '🛒'],
    'shopping.update': ['修改待购', 'a-shop', '✏️'],
    'shopping.claim': ['认领待购', 'a-shop', '🙋'],
    'shopping.transfer': ['转交待购', 'a-shop', '🔁'],
    'shopping.release': ['取消认领', 'a-shop', '🏷️'],
    'shopping.complete': ['完成补货', 'a-shop', '✅'],
    'shopping.remove': ['删除待购', 'a-remove', '🧹'],
    'mealplan.add': ['新建用餐计划', 'a-plan', '📅'],
    'mealplan.complete': ['完成用餐计划', 'a-plan', '🍽️'],
    'mealplan.remove': ['删除用餐计划', 'a-remove', '🧹'],
    'member.add': ['添加家庭成员', 'a-shop', '🧑'],
    'member.update': ['修改成员饮食信息', 'a-shop', '✏️'],
    'member.remove': ['删除家庭成员', 'a-remove', '🧹'],
    'history.prune': ['清理历史痕迹', 'a-update', '🧹'],
    'data.import': ['导入数据', 'a-update', '⬆️']
  };
  function renderAudit() {
    var entries = store.auditEntries().slice(0, 100);
    var nameOf = {};
    store.listItems(true).forEach(function (it) { nameOf[it.id] = it.name; });

    $('#auditList').innerHTML = entries.length ? entries.map(function (e) {
      var meta = AUDIT_META[e.action] || [e.action, '', '•'];
      var d = e.detail || {};
      var lines = [];
      if (d.name) lines.push(esc(d.name));
      if (d.source) {
        var srcLabel = { consume: '吃完补货', discard: '丢弃补货', manual: '手动', plan: '方案页带入' }[d.source] || d.source;
        lines.push('来源：' + esc(String(d.source).indexOf('restock:') === 0 ? '待购购买录入'
          : String(d.source).indexOf('mealplan:') === 0 ? '用餐计划' : srcLabel));
      }
      if (d.eventType) lines.push(esc(EVENT_LABELS[d.eventType] || d.eventType) + (d.at ? ' @ ' + d.at : ''));
      if (d.planType || d.title) lines.push(esc(d.title || d.planType));
      if (d.date) lines.push('用餐日期：' + esc(d.date));
      if (d.memberNames && d.memberNames.length) lines.push('就餐成员：' + d.memberNames.map(esc).join('、'));
      if (d.dietAck) {
        if (d.dietAck.blockers && d.dietAck.blockers.length) lines.push('已确认过敏风险：' + d.dietAck.blockers.map(esc).join('；'));
        if (d.dietAck.warnings && d.dietAck.warnings.length) lines.push('已确认忌口：' + d.dietAck.warnings.map(esc).join('；'));
      }
      if (d.itemNames && d.itemNames.length) lines.push('食材：' + d.itemNames.map(function (n) { return esc(n); }).join('、'));
      if (d.recorded && d.recorded.length) {
        lines.push('记录：' + d.recorded.map(function (r) {
          return esc(r.name) + '·' + esc(EVENT_LABELS[r.event] || r.event);
        }).join('，'));
      }
      if (d.qty) lines.push('数量：' + esc(d.qty));
      if (d.note) lines.push('备注：' + esc(d.note));
      if (d.assignee) lines.push('负责人：' + esc(d.assignee));
      if (e.action === 'shopping.claim') lines.push('认领到：' + esc(d.to || ''));
      if (e.action === 'shopping.transfer') {
        lines.push('转交：' + esc(d.from || '待认领') + ' → ' + esc(d.to || ''));
      }
      if (e.action === 'shopping.release') lines.push('取消认领（原负责人：' + esc(d.from || '—') + '），回到待认领');
      if (e.action === 'shopping.add' && d.status === 'unclaimed') lines.push('状态：待认领');
      if (e.action === 'history.prune') {
        lines.push('删除旧操作流水 ' + (d.droppedAudit || 0) + ' 条、字段修改快照 ' +
          (d.revisionsDropped || 0) + ' 份（库存与期限事件未删除；保留最近 ' +
          (d.keepAudit || 500) + ' 条流水）');
      }
      if (d.itemId && e.action === 'shopping.complete') {
        var linked = store.getItem(d.itemId);
        lines.push(linked ? '已关联新库存：' + esc(linked.name) : '关联库存已删除');
      }
      if (e.action === 'shopping.update' && d.changes) {
        var SHOP_LABELS = { name: '名称', categoryId: '分类', qty: '数量', note: '备注' };
        Object.keys(d.changes).forEach(function (k) {
          var c = d.changes[k];
          lines.push((SHOP_LABELS[k] || k) + '：' + esc(short(c.from)) + ' → ' + esc(short(c.to)));
        });
      }
      if (d.changes && e.action !== 'shopping.update') {
        var LABELS = { name: '名称', categoryId: '分类', purchaseDate: '购买日期', packageType: '包装', location: '位置', note: '备注' };
        Object.keys(d.changes).forEach(function (k) {
          var c = d.changes[k];
          lines.push((LABELS[k] || k) + '：' + esc(short(c.from)) + ' → ' + esc(short(c.to)));
        });
      }
      if (d.itemIds && d.itemIds.length) lines.push('涉及 ' + d.itemIds.length + ' 样食材');
      if (e.action === 'member.add') {
        if (d.allergies && d.allergies.length) lines.push('过敏：' + d.allergies.map(function (t) { return esc(FreshDiet.tagLabel(t)); }).join('、'));
        if (d.avoids && d.avoids.length) lines.push('忌口：' + d.avoids.map(function (t) { return esc(FreshDiet.tagLabel(t)); }).join('、'));
        if (d.prefers && d.prefers.length) lines.push('偏好：' + d.prefers.map(function (t) { return esc(FreshDiet.tagLabel(t)); }).join('、'));
      }
      if (e.action === 'member.update' && d.changes) {
        var MEMBER_LABELS = {
          name: '姓名', note: '备注',
          allergyTags: '过敏', avoidTags: '忌口', preferTags: '偏好'
        };
        Object.keys(d.changes).forEach(function (k) {
          var c = d.changes[k];
          var fmt = function (v) {
            if (Array.isArray(v)) return v.length ? v.map(function (t) { return FreshDiet.tagLabel(t); }).join('、') : '（无）';
            return v || '（空）';
          };
          lines.push((MEMBER_LABELS[k] || k) + '：' + esc(short(fmt(c.from))) + ' → ' + esc(short(fmt(c.to))));
        });
      }
      var restoreBtn = e.action === 'item.remove' && d.itemId && store.getItem(d.itemId) && store.getItem(d.itemId).removed
        ? ' <button class="tl-undo" data-restore="' + esc(d.itemId) + '">恢复该记录</button>' : '';
      return '<div class="audit-item ' + meta[1] + '">' +
        '<div class="audit-top"><span class="audit-action">' + meta[2] + ' ' + meta[0] + '</span>' +
        '<span class="audit-time">' + fmtDateTime(e.at) + '</span></div>' +
        (lines.length ? '<div class="audit-detail">' + lines.join('<br>') + restoreBtn + '</div>' : (restoreBtn ? restoreBtn : '')) +
      '</div>';
    }).join('') : '<p class="empty-hint">暂无操作记录。</p>';

    $$('#auditList [data-restore]').forEach(function (b) {
      b.addEventListener('click', function () {
        var r = guard(function () { return store.restoreItem(b.getAttribute('data-restore')); });
        if (!r.ok) return;
        toast('已恢复该记录');
        renderAll();
      });
    });
  }
  function short(v) {
    v = String(v == null || v === '' ? '（空）' : v);
    return v.length > 18 ? v.slice(0, 18) + '…' : v;
  }

  // ---------- 设置：导入导出/演示/清空 ----------
  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function setupSettings() {
    $('#btnExport').addEventListener('click', function () { $('#sheetSettings').hidden = false; });
    $('#btnDemo').addEventListener('click', function () {
      if (store.listItems().length && !confirm('载入演示数据会追加到现有库存，继续？')) return;
      var r = guard(function () { return store.seedDemo(null, FreshEngine); });
      if (!r.ok) return;
      toast('已载入 ' + r.value + ' 样演示食材');
      closeSheet('sheetSettings');
      renderAll();
    });
    $('#btnExport2').addEventListener('click', function () {
      download('freshkeeper-' + todayISO() + '.json', store.exportJSON());
      toast('已导出数据文件');
    });
    $('#btnImport').addEventListener('click', function () { $('#importInput').click(); });
    $('#importInput').addEventListener('change', function (ev) {
      var f = ev.target.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var result = store.importJSON(r.result, true);
          toast('导入完成：新增 ' + result.items + ' 样食材（已合并）');
          closeSheet('sheetSettings');
          renderAll();
        } catch (e) {
          // 容量写满：存储层已回滚，现有库存不变；引导先导出/清理
          if (FreshStorage.StorageWriteError && FreshStorage.StorageWriteError.is(e)) {
            showStorageFull(e);
            return;
          }
          // 结构不合法时导入被整体取消、现有库存不变；向用户说明具体原因
          alert('未能导入，现有库存没有任何改动。\n\n' + (e.message || '文件内容无法解析'));
        }
      };
      r.readAsText(f);
      ev.target.value = '';
    });
    $('#btnPrune').addEventListener('click', function () {
      var info = store.storageInfo();
      if (!confirm('将删除较早的操作流水（保留最近 500 条）和每样食材较早的字段修改快照。\n\n' +
        '库存、待购、用餐计划、家庭成员、期限事件与撤销记录都不会删除，食材仍可在追溯中恢复。\n\n' +
        '当前数据约 ' + humanBytes(info.totalBytes) + '，其中操作流水约 ' +
        humanBytes(info.parts.audit) + '。建议先导出备份再清理。现在开始？')) return;
      var r = guard(function () { return store.pruneHistory({ keepAudit: 500, keepRevisions: 20 }); });
      if (!r.ok) return;
      var s = r.value;
      toast('已清理：删除 ' + s.droppedAudit + ' 条旧流水、' + s.revisionsDropped +
        ' 份旧快照，腾出约 ' + humanBytes(Math.max(s.bytesSaved, 0)), 3600);
      renderAll();
    });
    $('#btnWipe').addEventListener('click', function () {
      if (!confirm('确定清空本机全部数据（食材 / 补货 / 用餐计划 / 家庭成员 / 追溯 / 家庭称呼）？此操作不可恢复。')) return;
      localStorage.removeItem(store._key());
      localStorage.removeItem(IDENTITY_KEY); // 家庭成员身份随业务数据一并清空
      localStorage.removeItem(DINERS_KEY);  // 就餐成员选择记忆一并清空
      location.reload();
    });
  }

  // ---------- 全局渲染/导航 ----------
  function renderAll() {
    renderInventory();
    renderShopping();
    renderMealPlans();
    renderPlan();
    renderAudit();
  }

  function switchView(v) {
    state.view = v;
    $$('.tab[data-view]').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
    ['inventory', 'shopping', 'mealplan', 'plan', 'history'].forEach(function (k) {
      $('#view-' + k).hidden = (k !== v);
    });
    window.scrollTo(0, 0);
  }

  function init() {
    // 导航
    $$('.tab[data-view]').forEach(function (t) {
      t.addEventListener('click', function () { switchView(t.getAttribute('data-view')); });
    });
    $('#btnAdd').addEventListener('click', function () { openForm(null); });

    // 过滤
    $$('#statusFilter .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        state.filter = c.getAttribute('data-f');
        $$('#statusFilter .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
        renderInventory();
      });
    });

    // 表单
    $('#itemForm').addEventListener('submit', saveForm);
    $('#fName').addEventListener('input', function () {
      var m = FreshEngine.matchCategory(this.value.trim());
      if (m.category && !$('#fCategory').value) $('#fCategory').value = m.category.id;
      rulePreview();
    });
    $('#fCategory').addEventListener('change', rulePreview);
    $('#fPackage').addEventListener('change', rulePreview);
    $$('#fLocation button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.formLocation = b.getAttribute('data-v');
        $$('#fLocation button').forEach(function (x) { x.classList.toggle('active', x === b); });
        rulePreview();
      });
    });
    $('#btnDeleteItem').addEventListener('click', function () {
      if (!state.editingId) return;
      if (!confirm('删除该食材记录？记录会软删除并保留在追溯中（可恢复）。')) return;
      var delItem = guard(function () { return store.removeItem(state.editingId); });
      if (!delItem.ok) return;
      closeSheet('sheetForm');
      toast('已删除，可在追溯中恢复');
      renderAll();
    });

    // 弹层关闭
    document.addEventListener('click', function (e) {
      var closeBtn = e.target.closest('[data-close]');
      if (!closeBtn) return;
      var sheet = closeBtn.closest('.sheet');
      if (sheet) {
        // 取消购买录入：不完成待购项（状态保留），仅清掉本次录入上下文
        if (sheet.id === 'sheetForm') state.purchaseShopId = null;
        if (sheet.id === 'sheetDiet') state.dietCtx = null;
        sheet.hidden = true;
      }
    });

    // 补货清单
    $('#btnAddShopping').addEventListener('click', function () { openShoppingForm(null); });
    $('#shoppingForm').addEventListener('submit', saveShoppingForm);
    $('#sName').addEventListener('input', function () {
      var m = FreshEngine.matchCategory(this.value.trim());
      if (m.category && !$('#sCategory').value) $('#sCategory').value = m.category.id;
      $('#sCatHint').textContent = m.category
        ? '识别为：' + m.category.name + (m.category.highRisk ? '（高风险食材，建议从严）' : '')
        : (this.value.trim() ? '未识别该食材，可在上方手动选择分类' : '');
      renderDupWarn();
    });
    $('#sCategory').addEventListener('change', renderDupWarn);
    $$('#shopFilter .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        state.shopFilter = c.getAttribute('data-f');
        $$('#shopFilter .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
        renderShopping();
      });
    });

    // 家庭协作：身份条 / 认领弹层（身份条是 role=button 的 div，需补齐 Enter/Space 键盘操作）
    function openIdentity() { openAssign('identity', null); }
    $('#shopIdentity').addEventListener('click', openIdentity);
    $('#shopIdentity').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIdentity(); }
    });
    $('#assignForm').addEventListener('submit', confirmAssign);

    // 用餐计划
    $('#btnAddMealPlan').addEventListener('click', function () {
      state.mealPresetSource = null;
      openMealPlanForm(null);
    });
    $('#mealPlanForm').addEventListener('submit', saveMealPlanForm);
    $('#mPickList').addEventListener('change', renderMealPreview);
    $('#mDate').addEventListener('change', renderMealPreview);
    $$('#mealFilter .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        state.mealFilter = c.getAttribute('data-f');
        $$('#mealFilter .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
        renderMealPlans();
      });
    });
    $('#btnMealDoneConfirm').addEventListener('click', confirmMealDone);

    // 家庭成员与饮食冲突
    $('#btnAddMember').addEventListener('click', function () {
      closeSheet('sheetMembers');
      openMemberForm(null);
    });
    $('#memberForm').addEventListener('submit', saveMemberForm);
    $('#btnDeleteMember').addEventListener('click', function () {
      var id = state.editingMemberId;
      var m = id ? store.getMember(id) : null;
      if (!m) return;
      if (!confirm('删除成员「' + m.name + '」？\n历史用餐计划会保留其姓名快照，不再参与新的冲突检查。')) return;
      var delMb = guard(function () { return store.removeMember(id); });
      if (!delMb.ok) return;
      state.editingMemberId = null;
      closeSheet('sheetMemberForm');
      toast('已删除成员');
      renderAll();
      openMembersSheet();
    });
    $('#btnDietContinue').addEventListener('click', confirmDietContinue);
    // 冲突行每次重渲染都会重建 DOM，用事件委托一次绑定
    $('#dietRows').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      var rowEl = btn.closest('.diet-row');
      if (!rowEl) return;
      var id = rowEl.getAttribute('data-id');
      if (btn.getAttribute('data-action') === 'replace') {
        showSubstitutions(id, $('#dietRows'));
      } else if (btn.getAttribute('data-action') === 'remove') {
        removeMealPick(id);
        refreshMealResolver();
      }
    });
    // 替换候选同样每次重渲染，委托到候选容器
    $('#dietCandidates').addEventListener('click', function (e) {
      var b = e.target.closest('[data-newid]');
      if (b) pickSubstitution(b.getAttribute('data-newid'));
    });

    setupOCR();
    setupSettings();
    setupStorageAlert();
    // 兜底：任何漏网的存储写入异常（事件处理器里直接抛出）都要让用户看见，
    // 绝不允许“界面毫无反应、用户以为已保存”
    window.addEventListener('error', function (ev) {
      var err = ev && ev.error;
      if (err && FreshStorage.StorageWriteError && FreshStorage.StorageWriteError.is(err)) {
        ev.preventDefault();
        showStorageFull(err);
      }
    });
    // 方案页默认带上次选择的就餐成员（成员可能已删除，渲染时再过滤）
    state.planDinerIds = getSavedDiners().slice();
    renderAll();
    if (typeof window !== 'undefined') window.__renderAll = renderAll; // 测试/调试钩子
  }

  document.addEventListener('DOMContentLoaded', init);
})();
