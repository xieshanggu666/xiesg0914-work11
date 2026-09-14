/*
 * freshkeeper/storage.js —— 本地持久化 + 全量审计追溯
 *
 * 数据（单个 localStorage 键）：
 *   items: 食材记录（fields 为当前字段，revisions 保存每次修改的字段快照）
 *   shopping: 待购补货清单（手动添加或从已吃完/丢弃食材发起；支持家庭认领/转交/取消认领；购买录入保存后才完成并关联新库存）
 *   mealPlans: 用餐计划（名称 + 用餐日期 + 食材快照；完成时复用期限事件写回食材）
 *   audit: 操作流水（创建/修改/事件/撤销/方案应用/补货/用餐计划），永不物理删除
 *
 * 追溯模型：
 *   - 食材字段修改：旧字段整体进 revisions，audit 记录变更字段
 *   - 改变期限的操作（开封/移位/冷冻/解冻/做熟/复热/吃完/丢弃）一律写成
 *     “事件”，事件可以撤销（deleted 标记），引擎重放时会跳过——历史仍在
 *   - audit 支持按时间倒序浏览，任何记录都可追溯到来源（手动录入/拍照确认/方案应用）
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'freshkeeper:v1';

  function nowISO() { return new Date().toISOString(); }
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---------- 结构校验与规范化 ----------
  // 导入时采用严格模式：任一食材记录缺必要结构即整体拒绝（抛错，不写入任何数据）。
  // 可选的畸形字段（events/revisions 不是数组等）不做静默吞除，统一归一化，保证渲染不崩。
  var LOCATIONS = ['fridge', 'freezer', 'pantry'];
  var PACKAGES = ['sealed', 'opened', 'loose'];
  var EVENT_TYPES = ['open', 'move', 'freeze', 'thaw', 'cook', 'reheat', 'consume', 'discard'];
  // 家庭共享采购协作：待认领（无人负责）→ 已认领（assignee 负责）→ 已购买（关联新库存）
  var SHOP_STATUSES = ['unclaimed', 'claimed', 'done'];
  var SHOP_OPEN_STATUSES = ['unclaimed', 'claimed'];
  // 饮食标签三类：过敏（阻断）/ 忌口（警告）/ 偏好（正向提示）
  var DIET_KINDS = ['allergy', 'avoid', 'prefer'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isDateStr(v) {
    return typeof v === 'string' && DATE_RE.test(v) && !isNaN(new Date(v + 'T12:00:00').getTime());
  }
  function isPlainObject(v) {
    return Object.prototype.toString.call(v) === '[object Object]';
  }

  // 校验并返回归一化后的食材。
  // opts.lenient（加载历史数据）：核心字段合法即保留，畸形数组/事件尽量修复，不轻易丢弃；
  // 严格模式（导入）：任何畸形结构都收集错误，由调用方整体拒绝。
  function normalizeItem(raw, index, errors, opts) {
    opts = opts || {};
    var lenient = !!opts.lenient;
    var where = '第 ' + (index + 1) + ' 条食材';
    if (!isPlainObject(raw)) {
      if (!lenient) errors.push(where + '不是对象');
      return null;
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      if (!lenient) errors.push(where + '缺少名称（name）');
      return null;
    }
    if (!isDateStr(raw.purchaseDate)) {
      if (!lenient) errors.push(where + '「' + raw.name + '」缺少合法购买日期（YYYY-MM-DD）');
      return null;
    }
    // 加载旧数据时对非法位置/包装做兜底；导入时严格拒绝
    var loc = LOCATIONS.indexOf(raw.location) >= 0 ? raw.location : (lenient ? 'fridge' : null);
    var pkg = PACKAGES.indexOf(raw.packageType) >= 0 ? raw.packageType : (lenient ? 'sealed' : null);
    if (!loc) { errors.push(where + '「' + raw.name + '」保存位置非法：' + raw.location); return null; }
    if (!pkg) { errors.push(where + '「' + raw.name + '」包装状态非法：' + raw.packageType); return null; }

    var item = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid('it'),
      name: raw.name.trim().slice(0, 30),
      categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
      purchaseDate: raw.purchaseDate,
      packageType: pkg,
      location: loc,
      note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
      events: [],
      revisions: [],
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowISO()
    };

    var rawEvents = Array.isArray(raw.events) ? raw.events
      : (raw.events == null ? [] : (lenient ? [] : null));
    if (rawEvents === null) { errors.push(where + '「' + item.name + '」的 events 必须是数组'); return null; }
    var validIdx = 0;
    var maxSeq = rawEvents.reduce(function (m, ev) {
      return isPlainObject(ev) && Number.isFinite(ev.seq) ? Math.max(m, ev.seq) : m;
    }, 0);
    rawEvents.forEach(function (ev, j) {
      if (!isPlainObject(ev)) {
        if (!lenient) errors.push(where + '「' + item.name + '」第 ' + (j + 1) + ' 条事件不是对象');
        return;
      }
      if (EVENT_TYPES.indexOf(ev.type) < 0) {
        if (!lenient) errors.push(where + '「' + item.name + '」存在不支持的事件类型：' + ev.type);
        return;
      }
      if (!isDateStr(ev.at)) {
        if (!lenient) errors.push(where + '「' + item.name + '」的「' + ev.type + '」事件缺少合法日期');
        return;
      }
      validIdx++;
      var clean = {
        id: (typeof ev.id === 'string' && ev.id) ? ev.id : uid('ev'),
        // 保留原序号；历史数据无 seq 时按文件中的先后次序补号，并避开已有序号，保证同一天事件次序稳定
        seq: Number.isFinite(ev.seq) ? ev.seq : Math.max(maxSeq, 0) + validIdx,
        type: ev.type, at: ev.at,
        deleted: !!ev.deleted
      };
      if (clean.deleted) clean.deletedAt = ev.deletedAt || nowISO();
      if (typeof ev.source === 'string') clean.source = ev.source;
      if (typeof ev.createdAt === 'string') clean.createdAt = ev.createdAt;
      ['to', 'from', 'reason', 'note'].forEach(function (k) {
        if (ev[k] !== undefined) clean[k] = String(ev[k]).slice(0, 200);
      });
      item.events.push(clean);
    });

    if (raw.revisions !== undefined && raw.revisions !== null && !Array.isArray(raw.revisions)) {
      if (!lenient) { errors.push(where + '「' + item.name + '」的 revisions 必须是数组'); return null; }
    } else if (Array.isArray(raw.revisions)) {
      raw.revisions.forEach(function (rev) {
        if (isPlainObject(rev) && isPlainObject(rev.fields)) item.revisions.push({ at: rev.at || nowISO(), fields: rev.fields });
      });
    }

    if (raw.removed === true) item.removed = true, item.removedAt = raw.removedAt || nowISO();
    return item;
  }

  function normalizeAuditEntry(raw) {
    if (!isPlainObject(raw)) return null;
    if (typeof raw.action !== 'string' || !raw.action) return null;
    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid('aud'),
      seq: Number.isFinite(raw.seq) ? raw.seq : 0,
      at: typeof raw.at === 'string' ? raw.at : nowISO(),
      action: raw.action,
      detail: isPlainObject(raw.detail) ? raw.detail : {},
      snapshot: raw.snapshot === undefined ? null : raw.snapshot
    };
  }

  // 待购项结构（家庭共享采购）：
  //   { id, name, categoryId, qty, note,
  //     status: 'unclaimed'（待认领）| 'claimed'（已认领）| 'done'（已购买），
  //     assignee（负责人）, claimedAt,
  //     source: manual|consume|discard, sourceItemId, sourceName,
  //     createdAt, completedAt, itemId（完成后关联的新库存） }
  function normalizeShopping(raw, index, errors, opts) {
    opts = opts || {};
    var lenient = !!opts.lenient;
    var where = '第 ' + (index + 1)  + ' 条待购';
    if (!isPlainObject(raw)) {
      if (!lenient) errors.push(where + '不是对象');
      return null;
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      if (!lenient) errors.push(where + '缺少名称（name）');
      return null;
    }
    // 旧版本 pending 归一化为 unclaimed；非法状态兜底为 unclaimed（宽松）或严格报错
    var rawStatus = raw.status === 'pending' ? 'unclaimed' : raw.status;
    var status = SHOP_STATUSES.indexOf(rawStatus) >= 0 ? rawStatus
      : (rawStatus === undefined || lenient ? 'unclaimed' : null);
    if (!status) { errors.push(where + '「' + raw.name + '」状态非法：' + raw.status); return null; }
    var assignee = typeof raw.assignee === 'string' ? raw.assignee.trim().slice(0, 20) : '';
    // 已认领却没有负责人：无法表达归属，退回待认领（宽松迁移，不拒绝整份导入）
    if (status === 'claimed' && !assignee) status = 'unclaimed';
    // 待认领状态不应残留负责人（脏数据修复）；已购买保留购买时的负责人用于展示
    if (status === 'unclaimed') assignee = '';
    var entry = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid('sh'),
      name: raw.name.trim().slice(0, 30),
      categoryId: typeof raw.categoryId === 'string' ? raw.categoryId.slice(0, 30) : '',
      qty: typeof raw.qty === 'string' ? raw.qty.trim().slice(0, 30)
        : (raw.qty === undefined || raw.qty === null ? '' : String(raw.qty).slice(0, 30)),
      note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
      status: status,
      source: typeof raw.source === 'string' ? raw.source : 'manual',
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowISO()
    };
    if (assignee) {
      entry.assignee = assignee;
      entry.claimedAt = typeof raw.claimedAt === 'string' && raw.claimedAt ? raw.claimedAt : entry.createdAt;
    }
    if (typeof raw.sourceItemId === 'string' && raw.sourceItemId) entry.sourceItemId = raw.sourceItemId;
    if (typeof raw.sourceName === 'string' && raw.sourceName) entry.sourceName = raw.sourceName.slice(0, 30);
    if (status === 'done') {
      if (typeof raw.completedAt === 'string' && raw.completedAt) entry.completedAt = raw.completedAt;
      else entry.completedAt = entry.createdAt;
      if (typeof raw.itemId === 'string' && raw.itemId) entry.itemId = raw.itemId;
    }
    return entry;
  }

  // 用餐计划结构：
  //   { id, name, date(YYYY-MM-DD 用餐日),
  //     items: [{ id, name }]（创建时的食材快照：跳转详情用 id，食材归档/改名后仍可展示），
  //     status: 'pending'|'done', source: manual|plan,
  //     createdAt, doneAt }
  function normalizeMealPlan(raw, index, errors, opts) {
    opts = opts || {};
    var lenient = !!opts.lenient;
    var where = '第 ' + (index + 1) + ' 条用餐计划';
    if (!isPlainObject(raw)) {
      if (!lenient) errors.push(where + '不是对象');
      return null;
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      if (!lenient) errors.push(where + '缺少计划名称（name）');
      return null;
    }
    if (!isDateStr(raw.date)) {
      if (!lenient) errors.push(where + '「' + raw.name + '」缺少合法用餐日期（YYYY-MM-DD）');
      return null;
    }
    var rawItems = Array.isArray(raw.items) ? raw.items
      : (raw.items == null ? [] : (lenient ? [] : null));
    if (rawItems === null) { errors.push(where + '「' + raw.name + '」的 items 必须是数组'); return null; }
    var items = [];
    var badItem = false;
    rawItems.forEach(function (pi, j) {
      if (!isPlainObject(pi) || typeof pi.id !== 'string' || !pi.id) {
        if (!lenient) { errors.push(where + '「' + raw.name + '」第 ' + (j + 1) + ' 个食材缺少合法 id'); badItem = true; }
        return;
      }
      items.push({ id: pi.id, name: typeof pi.name === 'string' ? pi.name.slice(0, 30) : '' });
    });
    if (badItem) return null;
    var status = raw.status === 'done' ? 'done' : 'pending';
    // 就餐成员快照：[{ id, name }]，改名/删除成员后历史计划仍可展示
    var rawMembers = Array.isArray(raw.members) ? raw.members
      : (raw.members == null ? [] : (lenient ? [] : null));
    if (rawMembers === null) { errors.push(where + '「' + raw.name + '」的 members 必须是数组'); return null; }
    var members = [];
    var badMember = false;
    rawMembers.forEach(function (mb) {
      if (!isPlainObject(mb) || typeof mb.id !== 'string' || !mb.id) {
        if (!lenient) { errors.push(where + '「' + raw.name + '」存在缺少 id 的就餐成员'); badMember = true; }
        return;
      }
      members.push({ id: mb.id, name: typeof mb.name === 'string' ? mb.name.slice(0, 20) : '' });
    });
    if (badMember) return null;
    var plan = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid('mp'),
      name: raw.name.trim().slice(0, 30),
      date: raw.date,
      items: items,
      members: members,
      status: status,
      source: typeof raw.source === 'string' ? raw.source : 'manual',
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowISO()
    };
    if (status === 'done') {
      plan.doneAt = (typeof raw.doneAt === 'string' && raw.doneAt) ? raw.doneAt : plan.createdAt;
    }
    return plan;
  }

  // 成员饮食偏好与忌口/过敏结构：
  //   { id, name, note,
  //     allergyTags: [...],  // 过敏食材标签（cat:<分类id> 或自定义关键词）
  //     avoidTags:   [...],  // 忌口/不喜欢
  //     preferTags:  [...],  // 偏好/爱吃
  //     createdAt }
  function cleanDietTags(v, errors, where) {
    if (v == null) return [];
    if (!Array.isArray(v)) {
      if (errors) errors.push(where + '的标签必须是数组');
      return null; // 严格模式下由调用方判定整体拒绝
    }
    var out = [];
    v.forEach(function (t) {
      t = String(t == null ? '' : t).trim().slice(0, 30);
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }

  function normalizeMember(raw, index, errors, opts) {
    opts = opts || {};
    var lenient = !!opts.lenient;
    var where = '第 ' + (index + 1) + ' 位家庭成员';
    if (!isPlainObject(raw)) {
      if (!lenient) errors.push(where + '不是对象');
      return null;
    }
    if (typeof raw.name !== 'string' || !raw.name.trim()) {
      if (!lenient) errors.push(where + '缺少姓名（name）');
      return null;
    }
    var member = {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid('mb'),
      name: raw.name.trim().slice(0, 20),
      note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : '',
      allergyTags: [], avoidTags: [], preferTags: [],
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : nowISO()
    };
    var bad = false;
    DIET_KINDS.forEach(function (kind) {
      var key = kind + 'Tags';
      var tags = cleanDietTags(raw[key], errors, where + '「' + member.name + '」');
      if (tags === null) { bad = true; tags = []; }
      member[key] = tags;
    });
    if (bad && !lenient) return null;
    return member;
  }

  // 严格校验整份导入数据，返回 { items, shopping, mealPlans, members, audit }；非法即抛错（原子拒绝）
  function validatePayload(input) {
    var data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!isPlainObject(data)) throw new Error('文件内容不是有效的数据对象');
    if (!Array.isArray(data.items)) throw new Error('缺少 items 食材列表');
    var errors = [];
    var seen = {};
    var items = data.items.map(function (raw, i) {
      var item = normalizeItem(raw, i, errors);
      if (item) {
        if (seen[item.id]) errors.push('食材 ID 重复：' + item.id + '（同一文件内出现多次）');
        seen[item.id] = true;
      }
      return item;
    });
    var shopping = [];
    if (data.shopping !== undefined && data.shopping !== null) {
      if (!Array.isArray(data.shopping)) {
        errors.push('shopping 待购清单必须是数组');
      } else {
        var seenShop = {};
        data.shopping.forEach(function (raw, i) {
          var entry = normalizeShopping(raw, i, errors);
          if (entry) {
            if (seenShop[entry.id]) errors.push('待购 ID 重复：' + entry.id + '（同一文件内出现多次）');
            seenShop[entry.id] = true;
            shopping.push(entry);
          }
        });
      }
    }
    var mealPlans = [];
    if (data.mealPlans !== undefined && data.mealPlans !== null) {
      if (!Array.isArray(data.mealPlans)) {
        errors.push('mealPlans 用餐计划必须是数组');
      } else {
        var seenMp = {};
        data.mealPlans.forEach(function (raw, i) {
          var plan = normalizeMealPlan(raw, i, errors);
          if (plan) {
            if (seenMp[plan.id]) errors.push('用餐计划 ID 重复：' + plan.id + '（同一文件内出现多次）');
            seenMp[plan.id] = true;
            mealPlans.push(plan);
          }
        });
      }
    }
    if (data.audit !== undefined && data.audit !== null && !Array.isArray(data.audit)) {
      errors.push('audit 必须是数组');
    }
    var members = [];
    if (data.members !== undefined && data.members !== null) {
      if (!Array.isArray(data.members)) {
        errors.push('members 家庭成员必须是数组');
      } else {
        var seenMb = {};
        data.members.forEach(function (raw, i) {
          var member = normalizeMember(raw, i, errors);
          if (member) {
            if (seenMb[member.id]) errors.push('成员 ID 重复：' + member.id + '（同一文件内出现多次）');
            seenMb[member.id] = true;
            members.push(member);
          }
        });
      }
    }
    if (errors.length) {
      var e = new Error('导入文件有 ' + errors.length + ' 处结构问题，已取消导入（未改动现有库存）：\n' +
        errors.slice(0, 5).map(function (x) { return '· ' + x; }).join('\n') +
        (errors.length > 5 ? '\n……等共 ' + errors.length + ' 处' : ''));
      e.errors = errors;
      throw e;
    }
    var audit = Array.isArray(data.audit)
      ? data.audit.map(normalizeAuditEntry).filter(Boolean)
      : [];
    return { items: items, shopping: shopping, mealPlans: mealPlans, members: members, audit: audit };
  }

  function createStore(backend) {
    backend = backend || (function () {
      if (typeof localStorage === 'undefined') {
        var mem = {};
        return {
          getItem: function (k) { return mem[k] === undefined ? null : mem[k]; },
          setItem: function (k, v) { mem[k] = String(v); }
        };
      }
      return localStorage;
    })();

    // 加载历史数据采用“宽松迁移”：尽力归一化，无法修复的记录丢弃并告警，避免页面白屏
    function load() {
      var EMPTY = { items: [], shopping: [], mealPlans: [], members: [], audit: [] };
      var raw = backend.getItem(STORE_KEY);
      if (!raw) return EMPTY;
      try {
        var parsed = JSON.parse(raw);
        if (!isPlainObject(parsed) || !Array.isArray(parsed.items)) return EMPTY;
        var total = Array.isArray(parsed.items) ? parsed.items.length : 0;
        var errors = [];
        var items = parsed.items.map(function (raw, i) {
          return normalizeItem(raw, i, errors, { lenient: true });
        }).filter(Boolean);
        var skipped = total - items.length;
        var shopTotal = Array.isArray(parsed.shopping) ? parsed.shopping.length : 0;
        var shopping = Array.isArray(parsed.shopping)
          ? parsed.shopping.map(function (raw, i) {
              return normalizeShopping(raw, i, errors, { lenient: true });
            }).filter(Boolean)
          : [];
        if (shopTotal - shopping.length > 0) skipped += shopTotal - shopping.length;
        var mpTotal = Array.isArray(parsed.mealPlans) ? parsed.mealPlans.length : 0;
        var mealPlans = Array.isArray(parsed.mealPlans)
          ? parsed.mealPlans.map(function (raw, i) {
              return normalizeMealPlan(raw, i, errors, { lenient: true });
            }).filter(Boolean)
          : [];
        if (mpTotal - mealPlans.length > 0) skipped += mpTotal - mealPlans.length;
        var mbTotal = Array.isArray(parsed.members) ? parsed.members.length : 0;
        var members = Array.isArray(parsed.members)
          ? parsed.members.map(function (raw, i) {
              return normalizeMember(raw, i, errors, { lenient: true });
            }).filter(Boolean)
          : [];
        if (mbTotal - members.length > 0) skipped += mbTotal - members.length;
        var audit = Array.isArray(parsed.audit)
          ? parsed.audit.map(normalizeAuditEntry).filter(Boolean) : [];
        if (skipped > 0 && typeof console !== 'undefined') {
          console.warn('FreshKeeper：本地数据跳过 ' + skipped + ' 条无法修复的异常记录');
        }
        return { items: items, shopping: shopping, mealPlans: mealPlans, members: members, audit: audit };
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('FreshKeeper：本地数据解析失败，使用空库存', e);
        return EMPTY;
      }
    }

    var db = load();
    // 历史脏数据经宽松迁移后回写，保证后续读取的都是规范结构
    try { backend.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {}
    var auditSeq = db.audit.reduce(function (m, e) { return Math.max(m, e.seq || 0); }, 0);

    function persist() {
      backend.setItem(STORE_KEY, JSON.stringify(db));
    }

    function log(action, detail, snapshot) {
      var entry = { id: uid('aud'), seq: ++auditSeq, at: nowISO(), action: action, detail: detail || {}, snapshot: snapshot || null };
      db.audit.push(entry);
      persist();
      return entry;
    }

    // ---- 食材 CRUD ----
    function addItem(fields, source) {
      var item = {
        id: uid('it'),
        name: fields.name || '',
        categoryId: fields.categoryId || '',
        purchaseDate: fields.purchaseDate,
        packageType: fields.packageType || 'sealed',
        location: fields.location || 'fridge',
        note: fields.note || '',
        events: [],
        revisions: [{ at: nowISO(), fields: {
          name: fields.name || '', categoryId: fields.categoryId || '',
          purchaseDate: fields.purchaseDate, packageType: fields.packageType || 'sealed',
          location: fields.location || 'fridge', note: fields.note || ''
        } }],
        createdAt: nowISO()
      };
      db.items.push(item);
      log('item.create', { itemId: item.id, name: item.name, source: source || 'manual' });
      persist();
      return item;
    }

    function getItem(id) {
      return db.items.filter(function (i) { return i.id === id; })[0] || null;
    }

    var TRACKED_FIELDS = ['name', 'categoryId', 'purchaseDate', 'packageType', 'location', 'note'];

    function updateItem(id, patch, source) {
      var item = getItem(id);
      if (!item) throw new Error('食材不存在: ' + id);
      var changes = {};
      TRACKED_FIELDS.forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(patch, f) && patch[f] !== item[f]) {
          changes[f] = { from: item[f], to: patch[f] };
        }
      });
      if (!Object.keys(changes).length) return item;
      item.revisions.push({ at: nowISO(), fields: TRACKED_FIELDS.reduce(function (acc, f) {
        acc[f] = item[f]; return acc;
      }, {}) });
      TRACKED_FIELDS.forEach(function (f) {
        if (Object.prototype.hasOwnProperty.call(patch, f)) item[f] = patch[f];
      });
      log('item.update', { itemId: id, name: item.name, changes: changes, source: source || 'manual' });
      persist();
      return item;
    }

    // ---- 期限事件 ----
    function addEvent(itemId, type, payload, source) {
      var item = getItem(itemId);
      if (!item) throw new Error('食材不存在: ' + itemId);
      // 同一食材内单调递增的序号：同一天的多个事件（如先冷冻又解冻）据此排序
      var seq = item.events.reduce(function (m, e) { return Math.max(m, Number(e.seq) || 0); }, 0) + 1;
      var ev = {
        id: uid('ev'), seq: seq, type: type,
        at: (payload && payload.at) || new Date().toISOString().slice(0, 10),
        source: source || 'manual',
        createdAt: nowISO(),
        deleted: false
      };
      if (payload) {
        ['to', 'from', 'reason', 'note'].forEach(function (k) {
          if (payload[k] !== undefined) ev[k] = payload[k];
        });
      }
      item.events.push(ev);
      log('event.add', { itemId: itemId, name: item.name, eventType: type, eventId: ev.id, at: ev.at, payload: payload || {} });
      persist();
      return ev;
    }

    function undoEvent(eventId) {
      var found = null;
      db.items.forEach(function (item) {
        item.events.forEach(function (ev) {
          if (ev.id === eventId && !ev.deleted) found = { item: item, ev: ev };
        });
      });
      if (!found) return false;
      found.ev.deleted = true;
      found.ev.deletedAt = nowISO();
      log('event.undo', { itemId: found.item.id, name: found.item.name, eventId: eventId, eventType: found.ev.type });
      persist();
      return true;
    }

    // ---- 方案应用（一次写入多个事件）----
    // meta.diet：就餐成员与“明知冲突仍继续”的食材快照（方案页饮食安全提示用）
    function applyPlan(plan, source, meta) {
      var applied = [];
      (plan.eventsOnApply || []).forEach(function (e) {
        applied.push(addEvent(e.itemId, e.type, { at: e.at, reason: e.reason }, source || ('plan:' + plan.type)));
      });
      log('plan.apply', {
        planType: plan.type, title: plan.title,
        itemIds: (plan.used || []).map(function (u) { return u.id; }),
        memberNames: meta && Array.isArray(meta.memberNames) ? meta.memberNames : [],
        dietAck: meta && meta.diet ? meta.diet : null
      });
      persist();
      return applied;
    }

    // ---- 删除食材（软删除：保留全部历史；audit 可恢复）----
    function removeItem(id) {
      var item = getItem(id);
      if (!item) return false;
      item.removed = true;
      item.removedAt = nowISO();
      log('item.remove', { itemId: id, name: item.name, snapshot: JSON.parse(JSON.stringify(item)) });
      persist();
      return true;
    }

    function restoreItem(id) {
      var item = getItem(id);
      if (!item || !item.removed) return false;
      delete item.removed;
      delete item.removedAt;
      log('item.restore', { itemId: id, name: item.name });
      persist();
      return true;
    }

    function listItems(includeRemoved) {
      return db.items.filter(function (i) { return includeRemoved || !i.removed; });
    }

    // ---- 待购补货清单 ----
    function getShopping(id) {
      return db.shopping.filter(function (s) { return s.id === id; })[0] || null;
    }

    function addShopping(fields, source) {
      var assignee = typeof fields.assignee === 'string' ? fields.assignee.trim().slice(0, 20) : '';
      var entry = {
        id: uid('sh'),
        name: (fields.name || '').trim(),
        categoryId: fields.categoryId || '',
        qty: fields.qty || '',
        note: fields.note || '',
        // 指定了负责人即直接进入“已认领”，否则待家庭成员认领
        status: assignee ? 'claimed' : 'unclaimed',
        source: source || fields.source || 'manual',
        createdAt: nowISO()
      };
      if (assignee) { entry.assignee = assignee; entry.claimedAt = entry.createdAt; }
      if (fields.sourceItemId) entry.sourceItemId = fields.sourceItemId;
      if (fields.sourceName) entry.sourceName = fields.sourceName;
      db.shopping.push(entry);
      log('shopping.add', {
        shoppingId: entry.id, name: entry.name, qty: entry.qty, note: entry.note,
        categoryId: entry.categoryId, source: entry.source, assignee: assignee || null,
        status: entry.status,
        sourceItemId: entry.sourceItemId || null, sourceName: entry.sourceName || null
      });
      persist();
      return entry;
    }

    function updateShopping(id, patch) {
      var entry = getShopping(id);
      if (!entry) return null;
      var fieldChanges = ['name', 'categoryId', 'qty', 'note'].reduce(function (acc, k) {
        if (Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== entry[k]) acc[k] = { from: entry[k], to: patch[k] };
        return acc;
      }, {});
      ['name', 'categoryId', 'qty', 'note'].forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) entry[k] = patch[k];
      });
      // 通过编辑表单修改负责人：未完成项在 待认领/已认领 间流转，与认领按钮同一口径入流水
      if (Object.prototype.hasOwnProperty.call(patch, 'assignee') && entry.status !== 'done') {
        var next = String(patch.assignee || '').trim().slice(0, 20);
        var prev = entry.assignee || '';
        if (next !== prev) {
          if (next) {
            entry.assignee = next;
            entry.claimedAt = nowISO();
            entry.status = 'claimed';
            log(prev ? 'shopping.transfer' : 'shopping.claim', {
              shoppingId: id, name: entry.name, from: prev || null, to: next
            });
          } else {
            entry.status = 'unclaimed';
            delete entry.assignee;
            delete entry.claimedAt;
            log('shopping.release', {
              shoppingId: id, name: entry.name, from: prev || null
            });
          }
        }
      }
      if (Object.keys(fieldChanges).length) {
        log('shopping.update', {
          shoppingId: id, name: entry.name, changes: fieldChanges
        });
      }
      persist();
      return entry;
    }

    // 认领：待认领/已认领都可由家庭成员接手（已被别人抢先认领时覆盖，以转交语义记录在案）
    function claimShopping(id, assignee) {
      var entry = getShopping(id);
      assignee = String(assignee || '').trim().slice(0, 20);
      if (!entry || entry.status === 'done' || !assignee) return false;
      var prev = entry.assignee || '';
      if (prev === assignee && entry.status === 'claimed') return false;
      entry.status = 'claimed';
      entry.assignee = assignee;
      entry.claimedAt = nowISO();
      log(prev ? 'shopping.transfer' : 'shopping.claim', {
        shoppingId: id, name: entry.name, from: prev || null, to: assignee
      });
      persist();
      return true;
    }

    // 转交：必须有新负责人名字；无人认领（取消认领）走 releaseShopping
    function transferShopping(id, assignee) {
      var entry = getShopping(id);
      assignee = String(assignee || '').trim().slice(0, 20);
      if (!entry || entry.status === 'done' || !assignee) return false;
      var prev = entry.assignee || '';
      if (prev === assignee) return false;
      entry.status = 'claimed';
      entry.assignee = assignee;
      entry.claimedAt = nowISO();
      log('shopping.transfer', {
        shoppingId: id, name: entry.name, from: prev || null, to: assignee
      });
      persist();
      return true;
    }

    // 取消认领：回到待认领池，负责人信息随之清空
    function releaseShopping(id) {
      var entry = getShopping(id);
      if (!entry || entry.status !== 'claimed') return false;
      var prev = entry.assignee || '';
      entry.status = 'unclaimed';
      delete entry.assignee;
      delete entry.claimedAt;
      log('shopping.release', { shoppingId: id, name: entry.name, from: prev || null });
      persist();
      return true;
    }

    // 购买录入保存成功后才调用：待认领/已认领项标记已购买并关联新库存；
    // 未关联（取消录入）则状态原样保留
    function completeShopping(id, itemId) {
      var entry = getShopping(id);
      if (!entry || SHOP_OPEN_STATUSES.indexOf(entry.status) < 0) return false;
      entry.status = 'done';
      entry.completedAt = nowISO();
      if (itemId) entry.itemId = itemId;
      log('shopping.complete', {
        shoppingId: id, name: entry.name, itemId: itemId || null,
        assignee: entry.assignee || null
      });
      persist();
      return true;
    }

    function removeShopping(id) {
      var before = db.shopping.length;
      var entry = getShopping(id);
      db.shopping = db.shopping.filter(function (s) { return s.id !== id; });
      var removed = db.shopping.length < before;
      if (removed) {
        log('shopping.remove', { shoppingId: id, name: entry ? entry.name : '' });
        persist();
      }
      return removed;
    }

    // status 支持：unclaimed（待认领）/ claimed（已认领）/ done（已购买）/ open（前两者合计）；
    // 兼容旧调用传入的 'pending'（等同 unclaimed）
    function listShopping(status) {
      var rows = db.shopping.slice();
      if (status === 'open') {
        rows = rows.filter(function (s) { return SHOP_OPEN_STATUSES.indexOf(s.status) >= 0; });
      } else if (status) {
        var want = status === 'pending' ? 'unclaimed' : status;
        rows = rows.filter(function (s) { return s.status === want; });
      }
      // 待办在前（待认领优先于已认领，新的在前）；已购买按完成时间倒序
      var rank = { unclaimed: 0, claimed: 1, done: 2 };
      rows.sort(function (a, b) {
        if (a.status !== b.status) return rank[a.status] - rank[b.status];
        if (a.status === 'done') {
          var ta = a.completedAt || a.createdAt, tb = b.completedAt || b.createdAt;
          return ta < tb ? 1 : -1;
        }
        return a.createdAt < b.createdAt ? 1 : -1;
      });
      return rows;
    }

    // 家庭成员名单：从认领记录中收集最近出现过的负责人（最新在前、去重），供快速选择
    function listShopMembers(limit) {
      var names = [];
      db.shopping.slice().sort(function (a, b) {
        var ta = a.claimedAt || a.createdAt, tb = b.claimedAt || b.createdAt;
        return ta < tb ? 1 : -1;
      }).forEach(function (s) {
        var n = (s.assignee || '').trim();
        if (n && names.indexOf(n) < 0) names.push(n);
      });
      return names.slice(0, limit || 10);
    }

    // ---- 家庭成员：饮食偏好与忌口/过敏 ----
    // 成员姓名在归一化（去空白、转小写）后唯一，避免“爸爸 ”与“爸爸”并存
    function getMember(id) {
      return db.members.filter(function (m) { return m.id === id; })[0] || null;
    }

    function findMemberByName(name) {
      var n = String(name || '').trim().toLowerCase().replace(/\s+/g, '');
      if (!n) return null;
      return db.members.filter(function (m) {
        return m.name.trim().toLowerCase().replace(/\s+/g, '') === n;
      })[0] || null;
    }

    function addMember(fields) {
      var name = String(fields.name || '').trim().slice(0, 20);
      if (!name) throw new Error('成员姓名不能为空');
      if (findMemberByName(name)) throw new Error('已存在同名家庭成员：' + name);
      var member = {
        id: uid('mb'),
        name: name,
        note: String(fields.note || '').slice(0, 200),
        allergyTags: cleanTags(fields.allergyTags),
        avoidTags: cleanTags(fields.avoidTags),
        preferTags: cleanTags(fields.preferTags),
        createdAt: nowISO()
      };
      db.members.push(member);
      log('member.add', { memberId: member.id, name: member.name,
        allergies: member.allergyTags, avoids: member.avoidTags, prefers: member.preferTags });
      persist();
      return member;
    }

    function updateMember(id, patch) {
      var member = getMember(id);
      if (!member) return null;
      var changes = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        var name = String(patch.name || '').trim().slice(0, 20);
        if (!name) throw new Error('成员姓名不能为空');
        var other = findMemberByName(name);
        if (other && other.id !== id) throw new Error('已存在同名家庭成员：' + name);
        if (name !== member.name) changes.name = { from: member.name, to: name };
        member.name = name;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
        var note = String(patch.note || '').slice(0, 200);
        if (note !== member.note) changes.note = { from: member.note, to: note };
        member.note = note;
      }
      DIET_KINDS.forEach(function (kind) {
        var key = kind + 'Tags';
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
        var tags = cleanTags(patch[key]);
        var same = tags.length === member[key].length && tags.every(function (t, i) { return t === member[key][i]; });
        if (!same) changes[key] = { from: member[key].slice(), to: tags.slice() };
        member[key] = tags;
      });
      if (!Object.keys(changes).length) return member;
      log('member.update', { memberId: id, name: member.name, changes: changes });
      persist();
      return member;
    }

    function removeMember(id) {
      var before = db.members.length;
      var member = getMember(id);
      db.members = db.members.filter(function (m) { return m.id !== id; });
      var removed = db.members.length < before;
      if (removed) {
        // 历史用餐计划保留成员名快照，不随删除级联
        log('member.remove', { memberId: id, name: member ? member.name : '' });
        persist();
      }
      return removed;
    }

    // 成员按添加时间正序（家庭中先登记的排前面）
    function listMembers() {
      return db.members.slice().sort(function (a, b) {
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      });
    }

    function cleanTags(v) {
      if (!Array.isArray(v)) return [];
      var out = [];
      v.forEach(function (t) {
        t = String(t == null ? '' : t).trim().slice(0, 30);
        if (t && out.indexOf(t) < 0) out.push(t);
      });
      return out;
    }

    // ---- 用餐计划 ----
    // 闭环：创建（选食材+定日期）→ 展示计划日预计状态（引擎 assess 到计划日）→
    //       标记完成时逐样记录做熟/吃完/丢弃事件 → 计划状态与审计自动更新
    function getMealPlan(id) {
      return db.mealPlans.filter(function (p) { return p.id === id; })[0] || null;
    }

    function addMealPlan(fields, source) {
      var items = (Array.isArray(fields.items) ? fields.items : []).map(function (pi) {
        return { id: pi.id, name: typeof pi.name === 'string' ? pi.name : '' };
      });
      // 就餐成员只保留仍存在的成员（id+姓名快照，成员改名/删除后历史计划照常展示）
      var members = (Array.isArray(fields.members) ? fields.members : []).map(function (mid) {
        var mb = getMember(mid);
        return mb ? { id: mb.id, name: mb.name } : null;
      }).filter(Boolean);
      var plan = {
        id: uid('mp'),
        name: (fields.name || '').trim(),
        date: fields.date,
        items: items,
        members: members,
        status: 'pending',
        source: source || fields.source || 'manual',
        createdAt: nowISO()
      };
      // 创建时的冲突快照：用户“明知冲突仍继续”的依据，写入计划与流水
      if (fields.diet) {
        plan.diet = {
          blockers: Array.isArray(fields.diet.blockers) ? fields.diet.blockers : [],
          warnings: Array.isArray(fields.diet.warnings) ? fields.diet.warnings : [],
          acknowledgedAt: nowISO()
        };
      }
      db.mealPlans.push(plan);
      log('mealplan.add', {
        planId: plan.id, name: plan.name, date: plan.date,
        itemCount: items.length,
        itemNames: items.map(function (pi) { return pi.name; }),
        memberIds: members.map(function (mb) { return mb.id; }),
        memberNames: members.map(function (mb) { return mb.name; }),
        dietAck: plan.diet ? { blockers: plan.diet.blockers, warnings: plan.diet.warnings } : null,
        source: plan.source
      });
      persist();
      return plan;
    }

    // 完成计划：actions = { itemId: 'cook'|'consume'|'discard'|'skip' }，
    // 非 skip 的食材写入对应期限事件（source 记 mealplan:<planId>，可在详情时间线撤销），
    // 随后计划置为 done；已删除/已归档（存在 consume/discard 终止事件）的食材自动跳过
    var MEAL_EVENT_TYPES = ['cook', 'consume', 'discard'];
    function isEnded(item) {
      return item.events.some(function (e) {
        return !e.deleted && (e.type === 'consume' || e.type === 'discard');
      });
    }
    function completeMealPlan(id, actions, at) {
      var plan = getMealPlan(id);
      if (!plan || plan.status !== 'pending') return false;
      actions = actions || {};
      var today = new Date().toISOString().slice(0, 10);
      var recorded = [];
      plan.items.forEach(function (pi) {
        var act = actions[pi.id];
        if (MEAL_EVENT_TYPES.indexOf(act) < 0) return;
        var item = getItem(pi.id);
        if (!item || item.removed || isEnded(item)) return;
        addEvent(pi.id, act, { at: at || today, reason: '用餐计划：' + plan.name }, 'mealplan:' + plan.id);
        recorded.push({ itemId: pi.id, name: pi.name, event: act });
      });
      plan.status = 'done';
      plan.doneAt = nowISO();
      log('mealplan.complete', {
        planId: plan.id, name: plan.name, date: plan.date, recorded: recorded
      });
      persist();
      return true;
    }

    function removeMealPlan(id) {
      var before = db.mealPlans.length;
      var plan = getMealPlan(id);
      db.mealPlans = db.mealPlans.filter(function (p) { return p.id !== id; });
      var removed = db.mealPlans.length < before;
      if (removed) {
        log('mealplan.remove', { planId: id, name: plan ? plan.name : '', date: plan ? plan.date : '' });
        persist();
      }
      return removed;
    }

    // 待用餐按用餐日期升序（最近的在前）；已完成按完成时间倒序
    function listMealPlans(status) {
      var rows = db.mealPlans.slice();
      if (status) rows = rows.filter(function (p) { return p.status === status; });
      rows.sort(function (a, b) {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        if (a.status === 'pending') {
          if (a.date !== b.date) return a.date < b.date ? -1 : 1;
          return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
        }
        var ta = a.doneAt || a.createdAt, tb = b.doneAt || b.createdAt;
        return ta < tb ? 1 : -1;
      });
      return rows;
    }

    // 审计按“实际发生时间 at”排序（倒序：最新在前）；
    // seq 仅在同一毫秒内作为次序兜底（旧实现只按 seq 排，合并旧备份会整体排到最新操作之前）
    function compareAuditDesc(a, b) {
      var ta = String(a.at || ''), tb = String(b.at || '');
      if (ta !== tb) return ta < tb ? 1 : -1;
      var sa = Number(a.seq) || 0, sb = Number(b.seq) || 0;
      if (sa !== sb) return sb - sa;
      var ia = String(a.id || ''), ib = String(b.id || '');
      if (ia !== ib) return ia < ib ? 1 : -1;
      return 0;
    }

    function auditEntries() {
      return db.audit.slice().sort(compareAuditDesc);
    }

    function exportJSON() {
      return JSON.stringify(db, null, 2);
    }

    function importJSON(text, merge) {
      // 先校验、后写入：任何结构问题都整体拒绝，现有库存不被改动
      var clean = validatePayload(text);
      if (merge) {
        var dup = clean.items.filter(function (it) { return getItem(it.id); }).map(function (it) { return it.id; });
        if (dup.length) {
          var e = new Error('导入文件中有 ' + dup.length + ' 条记录与现有库存 ID 相同（可能是同一数据重复导入），已取消合并。');
          e.errors = dup;
          throw e;
        }
        var dupShop = clean.shopping.filter(function (s) { return getShopping(s.id); }).map(function (s) { return s.id; });
        if (dupShop.length) {
          var es = new Error('导入文件中有 ' + dupShop.length + ' 条待购记录与现有清单 ID 相同，已取消合并。');
          es.errors = dupShop;
          throw es;
        }
        var dupMp = clean.mealPlans.filter(function (p) { return getMealPlan(p.id); }).map(function (p) { return p.id; });
        if (dupMp.length) {
          var em = new Error('导入文件中有 ' + dupMp.length + ' 条用餐计划与现有计划 ID 相同，已取消合并。');
          em.errors = dupMp;
          throw em;
        }
        var dupMb = clean.members.filter(function (m) { return getMember(m.id); }).map(function (m) { return m.id; });
        if (dupMb.length) {
          var em2 = new Error('导入文件中有 ' + dupMb.length + ' 位家庭成员与现有成员 ID 相同，已取消合并。');
          em2.errors = dupMb;
          throw em2;
        }
        db.items = db.items.concat(clean.items);
        db.shopping = db.shopping.concat(clean.shopping);
        db.mealPlans = db.mealPlans.concat(clean.mealPlans);
        db.members = db.members.concat(clean.members);
        // 审计顺序以实际时间 at 为准（见 compareAuditDesc），不再平移外部 seq，
        // 否则较早生成的备份会被误排到本地最新操作之后
        db.audit = db.audit.concat(clean.audit);
        var importedMaxSeq = clean.audit.reduce(function (m, e) { return Math.max(m, Number(e.seq) || 0); }, 0);
        auditSeq = Math.max(auditSeq, importedMaxSeq);
      } else {
        db = { items: clean.items, shopping: clean.shopping, mealPlans: clean.mealPlans, members: clean.members, audit: clean.audit };
        auditSeq = db.audit.reduce(function (m, e) { return Math.max(m, e.seq || 0); }, 0);
      }
      log('data.import', { merge: !!merge, items: clean.items.length, shopping: clean.shopping.length, mealPlans: clean.mealPlans.length, members: clean.members.length, audit: clean.audit.length });
      persist();
      return { items: clean.items.length, shopping: clean.shopping.length, mealPlans: clean.mealPlans.length, members: clean.members.length, audit: clean.audit.length };
    }

    function seedDemo(demoItems, Engine) {
      // 演示数据：购买日期相对今天，便于直接看到各种分档
      Engine = Engine || (typeof global.FreshEngine !== 'undefined' ? global.FreshEngine : null);
      var today = Engine.isoDate(Engine.todayAt());
      var d = function (offset) { return Engine.isoDate(Engine.addDays(today, offset)); };
      var specs = [
        { name: '猪里脊', purchaseDate: d(-2), packageType: 'sealed', location: 'fridge' },
        { name: '菠菜', purchaseDate: d(-4), packageType: 'loose', location: 'fridge' },
        { name: '番茄', purchaseDate: d(-6), packageType: 'loose', location: 'fridge' },
        { name: '鸡蛋', purchaseDate: d(-10), packageType: 'sealed', location: 'fridge' },
        { name: '酸奶', purchaseDate: d(-18), packageType: 'sealed', location: 'fridge' },
        { name: '三文鱼', purchaseDate: d(-2), packageType: 'sealed', location: 'freezer' },
        { name: '白米饭(剩)', purchaseDate: d(-1), packageType: 'opened', location: 'fridge' },
        { name: '豆腐', purchaseDate: d(-2), packageType: 'opened', location: 'fridge' },
        { name: '牛奶', purchaseDate: d(-6), packageType: 'opened', location: 'fridge' }
      ];
      specs.forEach(function (s) { addItem(s, 'demo'); });
      var rice = db.items.filter(function (i) { return i.name === '白米饭(剩)'; })[0];
      if (rice) addEvent(rice.id, 'cook', { at: d(-1) }, 'demo');

      // 演示家庭成员：覆盖过敏/忌口/偏好三种标签，与演示库存故意制造冲突
      // （爸爸忌葱属蔬菜、妈妈水产+花生过敏且爱吃番茄、宝宝不喝牛奶），
      // 载入后在方案/计划页选成员即可看到冲突提示。重复载入演示不重复添加。
      var demoMembers = [
        { name: '爸爸', allergyTags: [], avoidTags: ['cat:mushroom', '香菜'], preferTags: ['cat:rawmeat'] },
        { name: '妈妈', allergyTags: ['cat:seafood', '花生'], avoidTags: ['cat:tofu'], preferTags: ['番茄'] },
        { name: '宝宝', allergyTags: ['cat:egg'], avoidTags: ['cat:milk', 'cat:yogurt'], preferTags: ['cat:fruit'] }
      ];
      demoMembers.forEach(function (m) {
        if (!findMemberByName(m.name)) addMember(m);
      });
      return specs.length;
    }

    return {
      addItem: addItem, getItem: getItem, updateItem: updateItem, removeItem: removeItem,
      restoreItem: restoreItem, listItems: listItems,
      addEvent: addEvent, undoEvent: undoEvent, applyPlan: applyPlan,
      addShopping: addShopping, getShopping: getShopping, updateShopping: updateShopping,
      claimShopping: claimShopping, transferShopping: transferShopping,
      releaseShopping: releaseShopping, listShopMembers: listShopMembers,
      completeShopping: completeShopping, removeShopping: removeShopping, listShopping: listShopping,
      addMealPlan: addMealPlan, getMealPlan: getMealPlan, listMealPlans: listMealPlans,
      completeMealPlan: completeMealPlan, removeMealPlan: removeMealPlan,
      addMember: addMember, getMember: getMember, findMemberByName: findMemberByName,
      updateMember: updateMember, removeMember: removeMember, listMembers: listMembers,
      auditEntries: auditEntries, exportJSON: exportJSON, importJSON: importJSON,
      seedDemo: seedDemo, _key: function () { return STORE_KEY; }
    };
  }

  var Storage = { createStore: createStore, uid: uid, validatePayload: validatePayload };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Storage;
  } else {
    global.FreshStorage = Storage;
  }
})(typeof window !== 'undefined' ? window : this);
