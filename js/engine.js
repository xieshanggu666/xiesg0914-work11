/*
 * freshkeeper/engine.js —— 纯逻辑决策引擎（无 DOM、无存储依赖）
 *
 * 设计要点：
 * 1. 食材只有“当前字段 + 一串事件”，所有期限结论由事件重放得出，天然可追溯。
 * 2. 时间轴模型：
 *    - state.safeEnd    安全期限截止时间（“不能再吃”的硬边界）
 *    - state.qualityEnd 品质期限截止时间（超过后口感/营养明显下降，冷冻期主要看它）
 *    - state.clockPaused 在冷冻室内时钟暂停；转冷藏/常温时用“剩余余额”续期
 *    - 开封 / 移位 / 做熟 / 重新加热都会截断并重设期限
 * 3. 结论分档：fresh 新鲜 / quality 品质下降 / warn 尽快吃 / danger 临期 / expired 过期
 */
(function (global) {
  'use strict';

  var Rules = (typeof require === 'function') ? require('./rules') : global.FreshRules;
  var MS_DAY = 24 * 60 * 60 * 1000;

  // ---------- 时间工具（全部以“当天中午”为基准，消除时分秒干扰） ----------
  function dateOnly(d) {
    var x = new Date(d);
    return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 12, 0, 0, 0);
  }
  function todayAt(now) { return dateOnly(now || Date.now()); }
  function addDays(base, days) { return new Date(dateOnly(base).getTime() + days * MS_DAY); }
  function daysBetween(a, b) {
    return Math.round((dateOnly(b).getTime() - dateOnly(a).getTime()) / MS_DAY);
  }
  function parseISODate(s) { // 'YYYY-MM-DD' -> Date(中午)
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return dateOnly(s);
    return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
  }
  function isoDate(d) {
    var x = dateOnly(d);
    var mm = String(x.getMonth() + 1).padStart(2, '0');
    var dd = String(x.getDate()).padStart(2, '0');
    return x.getFullYear() + '-' + mm + '-' + dd;
  }

  // ---------- 分类识别 ----------
  function normalizeName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function matchCategory(name) {
    var n = normalizeName(name);
    if (!n) return { category: null, matchedKeyword: null };

    // 精确命中分类名
    for (var i = 0; i < Rules.categories.length; i++) {
      if (n === Rules.categories[i].name.toLowerCase()) {
        return { category: Rules.categories[i], matchedKeyword: Rules.categories[i].name };
      }
    }
    // 关键词：最长优先（如“五花肉馅”优先匹配“肉馅”而不是“肉”）
    var best = null, bestLen = 0;
    Rules.categories.forEach(function (cat) {
      cat.keywords.forEach(function (kw) {
        var k = kw.toLowerCase();
        if (n.indexOf(k) >= 0 && k.length > bestLen) {
          best = cat; bestLen = k.length;
        }
      });
    });
    return best
      ? { category: best, matchedKeyword: best.keywords.filter(function (k) { return k.length === bestLen; })[0] }
      : { category: null, matchedKeyword: null };
  }

  function categoryOf(item) {
    if (item.categoryId) {
      var byId = Rules.categories.filter(function (c) { return c.id === item.categoryId; })[0];
      if (byId) return byId;
    }
    var m = matchCategory(item.name);
    return m.category;
  }

  // 某分类在某位置/包装下的安全天数；null 表示不建议该保存方式
  // 散装：生鲜整采食材按“未处理(sealed 档)”计；加工/即食/乳品散装视同开封
  var LOOSE_AS_SEALED = { leafy: 1, fruiting: 1, root: 1, mushroom: 1, fruit: 1 };
  function locKey(cat, pkg) {
    if (pkg === 'sealed') return 'sealed';
    if (pkg === 'loose' && cat && LOOSE_AS_SEALED[cat.id]) return 'sealed';
    return 'opened';
  }

  function safeDaysFor(cat, location, pkg) {
    if (!cat) return Rules.fallbackDays;
    var loc = cat[location];
    if (!loc) return Rules.fallbackDays;
    var v = loc[locKey(cat, pkg)];
    return (v === null || v === undefined) ? null : v;
  }

  // ---------- 事件重放：构建食材当前状态 ----------
  //
  // event 类型：
  //   open        开封              { at }
  //   move        移位              { at, from, to }  to∈fridge/freezer/pantry
  //   freeze      放入冷冻（move→freezer 的语义糖，UI 按钮用）
  //   thaw        解冻移冷藏        { at }
  //   cook        做熟              { at }
  //   reheat      重新加热          { at }
  //   consume     吃完/用尽         { at }
  //   discard     丢弃              { at, reason }
  function initialState(item) {
    var cat = categoryOf(item);
    var loc = item.location || 'fridge';
    var pkg = item.packageType || 'sealed';
    var start = parseISODate(item.purchaseDate);
    var safe = safeDaysFor(cat, loc, pkg);
    var isFrozen = loc === 'freezer';
    // 冷冻室内“安全时钟暂停”：购入即冷冻的，按解冻规则赋予解冻余额
    var frozenAllowed = !!(cat && cat.freezable);
    var notRec = isFrozen ? !frozenAllowed : safe === null;
    var safeDays = isFrozen ? 0 : (safe === null ? Rules.fallbackDays : safe);    return {
      cat: cat,
      location: loc,
      packageType: pkg,
      cooked: false,
      clockPaused: isFrozen,
      pausedAt: isFrozen ? start : null,
      remainingDays: isFrozen ? (cat ? cat.thawQuality : 1) : null,
      qualityStart: start,
      qualityEnd: isFrozen ? addDays(start, cat ? cat.freezerQuality : 90) : null,
      safeEnd: isFrozen ? null : addDays(start, safeDays),
      currentBase: start,
      ended: false, endEvent: null,
      locationNotRecommended: notRec,
      warnings: notRec ? ['该食材不建议在此温度保存，已按最保守 1 天估算，请尽快处理'] : [],
      thawed: false,
      reheatNote: null
    };
  }

  function moveToFreezer(state, at, cat) {
    var rem = state.clockPaused
      ? state.remainingDays
      : Math.max(0, daysBetween(at, state.safeEnd));
    state.location = 'freezer';
    state.clockPaused = true;
    state.pausedAt = at;
    state.remainingDays = rem; // 冷冻前剩余的安全余额，解冻后续用
    state.safeEnd = null;
    state.locationNotRecommended = !(cat && cat.freezable);
    state.qualityStart = at;
    state.qualityEnd = addDays(at, cat ? cat.freezerQuality : 90);
  }

  function rebalance(state, at, cat, newLoc, newPkg) {
    if (newLoc === 'freezer') {
      moveToFreezer(state, at, cat);
      state.packageType = newPkg;
      return;
    }
    // 从冷冻拿出来：恢复时钟，解冻余额在新位置继续（解冻规则）
    var balance = null;
    if (state.clockPaused) {
      balance = state.remainingDays;
      state.clockPaused = false;
      state.pausedAt = null;
      state.remainingDays = null;
    }
    state.location = newLoc;
    state.packageType = newPkg;
    var d = safeDaysFor(cat, newLoc, newPkg);
    var notRec = d === null;
    var locDays = notRec ? Rules.fallbackDays : d;
    if (balance !== null) {
      locDays = Math.min(locDays, balance); // 解冻/移位不吃满新位置全额
    }
    state.currentBase = at;
    state.safeEnd = addDays(at, locDays);
    state.locationNotRecommended = notRec;
    if (notRec && state.warnings.indexOf('该食材不建议在此温度保存，已按最保守 1 天估算，请尽快处理') < 0) {
      state.warnings.push('该食材不建议在此温度保存，已按最保守 1 天估算，请尽快处理');
    }
  }

  // ---------- 事件时序 ----------
  // 同一天的多个事件必须按发生先后排序（如先“开封”后“做熟”、先“冷冻”后“解冻”），
  // 依次回退到：事件日期 → 食材内序号 seq → 实际创建时间戳 → id，保证结果稳定且确定。
  function eventTimeKey(ev) {
    return dateOnly(ev.at).getTime();
  }
  function compareEventsAsc(a, b) {
    var da = eventTimeKey(a), db = eventTimeKey(b);
    if (da !== db) return da - db;
    var sa = Number(a.seq) || 0, sb = Number(b.seq) || 0;
    if (sa !== sb) return sa - sb;
    var ca = a.createdAt || '', cb = b.createdAt || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    var ia = String(a.id || ''), ib = String(b.id || '');
    if (ia !== ib) return ia < ib ? -1 : 1;
    return 0; // 所有排序键一致，保持稳定（不得恒返回 -1）
  }
  // 倒序（时间线展示）：较晚发生的在前
  function compareEventsDesc(a, b) {
    return -compareEventsAsc(a, b);
  }

  function rebuild(item) {
    var state = initialState(item);
    // 复制事件对象再排序，避免给重放中的事件挂临时字段时污染存储对象
    var events = (item.events || [])
      .filter(function (e) { return !e.deleted; })
      .map(function (e) { return Object.assign({}, e); })
      .sort(compareEventsAsc);

    events.forEach(function (ev) {
      if (state.ended) return;
      var at = dateOnly(ev.at);
      var cat = state.cat;
      switch (ev.type) {
        case 'open':
          state.packageType = 'opened';
          if (state.clockPaused) break; // 冷冻中“开封”不改期限
          var od = safeDaysFor(cat, state.location, 'opened');
          state.safeEnd = addDays(at, od === null ? Rules.fallbackDays : od);
          state.currentBase = at;
          break;
        case 'move':
          rebalance(state, at, cat, ev.to, state.packageType);
          break;
        case 'freeze':
          if (state.location !== 'freezer') moveToFreezer(state, at, cat);
          break;
        case 'thaw':
          if (state.clockPaused || state.location === 'freezer') {
            rebalance(state, at, cat, 'fridge', state.packageType);
            state.thawed = true;
          }
          break;
        case 'cook':
          state.clockPaused = false; state.pausedAt = null;
          state.remainingDays = null;
          state.cooked = true;
          state.location = 'fridge';
          state.packageType = 'opened';
          state.thawed = false;
          state.currentBase = at;
          state.safeEnd = addDays(at, cat ? cat.cookedSafe : 3);
          state.qualityEnd = addDays(at, cat ? cat.cookedQuality : 2);
          state.qualityStart = at;
          state.locationNotRecommended = false;
          break;
        case 'reheat': {
          // 重新加热不“重置”安全期限，只给当日可食用的提醒（剩菜不反复加热）
          var d0 = daysBetween(todayAt(ev.at), state.safeEnd);
          state.reheatNote = (d0 < 0)
            ? '重新加热时已超过建议期限'
            : '重新加热不重置期限，建议当餐吃完，不要再二次加热';
          break;
        }
        case 'consume':
        case 'discard':
          state.ended = true;
          state.endEvent = ev;
          break;
      }
    });

    // 编辑记录的字段（购买日期/位置/包装）早于或没有事件时，以字段为准；
    // initialState 已使用当前字段；若存在“移位类”事件，最终位置以事件为准。
    return state;
  }

  // ---------- 评估：分档 + 建议 ----------
  var STATUS = {
    expired: { key: 'expired', label: '已过期', color: '#b3261e', rank: 5 },
    danger:  { key: 'danger',  label: '临期', color: '#d7263d', rank: 4 },
    warn:    { key: 'warn',    label: '尽快食用', color: '#f29100', rank: 3 },
    quality: { key: 'quality', label: '品质下降', color: '#8a6d00', rank: 2 },
    fresh:   { key: 'fresh',   label: '新鲜', color: '#1e8e4f', rank: 1 }
  };

  function assess(item, now) {
    now = todayAt(now);
    var state = rebuild(item);
    var cat = state.cat;
    var highRisk = !!(cat && cat.highRisk);
    var warnD = highRisk ? 2 : 3;    // 剩余 ≤ 该值 → 尽快食用
    var dangerD = highRisk ? 1 : 0;  // 高风险最后1天临期；低风险到期当天才临期

    var status, safeDaysLeft, qualityDaysLeft = null;
    if (state.ended) {
      status = state.endEvent.type === 'consume' ? 'consumed' : 'discarded';
      safeDaysLeft = daysBetween(now, state.endEvent.at);
    } else if (state.clockPaused) {
      // 冷冻中：安全时钟暂停，safeDaysLeft 展示“解冻后还能放几天”的余额
      safeDaysLeft = state.remainingDays;
      qualityDaysLeft = state.qualityEnd ? daysBetween(now, state.qualityEnd) : null;
      if (qualityDaysLeft !== null && qualityDaysLeft < 0) status = 'quality';
      else status = 'fresh';
    } else {
      safeDaysLeft = daysBetween(now, state.safeEnd);
      if (state.qualityEnd) qualityDaysLeft = daysBetween(now, state.qualityEnd);
      if (safeDaysLeft < 0) status = 'expired';
      else if (safeDaysLeft <= dangerD) status = 'danger';
      else if (safeDaysLeft <= warnD) status = 'warn';
      else if (qualityDaysLeft !== null && qualityDaysLeft < 0) status = 'quality';
      else status = 'fresh';
    }

    var advice = buildAdvice(item, state, status, safeDaysLeft, qualityDaysLeft);
    return {
      item: item,
      state: state,
      status: status,
      statusInfo: STATUS[status] || { key: status, label: status === 'consumed' ? '已吃完' : '已丢弃', color: '#888', rank: 0 },
      safeDaysLeft: safeDaysLeft,
      qualityDaysLeft: qualityDaysLeft,
      highRisk: highRisk,
      advice: advice,
      reheatNote: state.reheatNote || null,
      score: priorityScore(status, safeDaysLeft, highRisk, state)
    };
  }

  function priorityScore(status, daysLeft, highRisk, state) {
    var base = { consumed: -100, discarded: -100, expired: 1000, danger: 800, warn: 500, quality: 200, fresh: 50 }[status] || 0;
    if (state && state.ended) return -100;
    var urgency = (typeof daysLeft === 'number' && daysLeft <= 10) ? (10 - daysLeft) * 10 : 0;
    return base + urgency + (highRisk ? 20 : 0);
  }

  function buildAdvice(item, state, status, safeLeft, qualityLeft) {
    var cat = state.cat;
    var name = item.name || '该食材';
    var title, detail, alternatives = [];

    if (state.ended) {
      return {
        title: state.endEvent.type === 'consume' ? '已食用，记录已归档' : '已丢弃，记录已归档',
        detail: '',
        alternatives: []
      };
    }

    if (state.clockPaused) {
      var warnPrefix = state.locationNotRecommended ? '⚠️ 该食材不适合冷冻保存，请尽快处理或更换位置。' : '';
      if (status === 'quality') {
        title = '冷冻过久，建议尽快安排食用';
        detail = warnPrefix + '安全上通常仍可保存，但冷冻已超过建议的品质期（约 ' + (cat ? Math.round(cat.freezerQuality / 30) : 3) + ' 个月），口感和营养会明显下降。';
      } else {
        title = '冷冻保存中，安全时钟暂停';
        detail = warnPrefix + '品质建议期限还剩约 ' + qualityLeft + ' 天；建议提前 1 晚移至冷藏解冻，解冻后 ' + (cat ? cat.thawQuality : 1) + ' 天内吃完。';
      }
      alternatives = ['提前一晚移冷藏解冻', '做熟后再冷冻可显著延长保存'];
      if (state.locationNotRecommended) alternatives = ['尽快食用或丢弃'].concat(alternatives);
      return { title: title, detail: detail, alternatives: alternatives };
    }

    switch (status) {
      case 'expired':
        title = '建议丢弃';
        detail = '已超过建议安全期限 ' + Math.abs(safeLeft) + ' 天。' + (state.highRiskLabel || '') +
          (cat && cat.highRisk ? '这类食材风险较高，即使没有异味也不建议食用。' : '食用前若有异味、发黏、变色请直接丢弃。');
        alternatives = ['丢弃并记录，避免误用'];
        break;
      case 'danger':
        title = '尽快食用 / 立即处理';
        detail = '今天到明天就到建议期限。' + (cat && cat.freezable ? '若今天吃不完，现在分装冷冻仍可保留。' : '不建议再存放。');
        alternatives = (cat && cat.freezable)
          ? ['今天做熟', '立即分装冷冻（留长期限）']
          : ['今天做熟吃完', state.location === 'fridge' ? '确认密封并置于最冷处' : '尽快移入冷藏'];
        break;
      case 'warn':
        title = '尽快食用';
        detail = '还剩 ' + Math.max(safeLeft, 0) + ' 天到建议期限' + (cat && cat.highRisk ? '，属高风险食材请优先处理' : '') + '。';
        alternatives = (cat && cat.freezable)
          ? ['1–2 天内做熟', '吃不完可分装冷冻']
          : ['1–2 天内吃完'];
        break;
      case 'quality':
        title = '可食用但品质下降';
        detail = '仍在建议期限内（剩 ' + safeLeft + ' 天），但已超过建议的最佳赏味期，风味/口感可能变差，建议用于炖煮等重口味做法。';
        alternatives = ['重调味烹饪（炖/卤/烤）'];
        break;
      default:
        title = '状态良好，正常安排即可';
        detail = '建议期限还剩 ' + safeLeft + ' 天。';
        alternatives = (cat && cat.freezable && safeLeft <= 7) ? ['吃不完可提前分装冷冻'] : [];
    }
    if (state.locationNotRecommended) {
      alternatives = ['换至建议的保存位置'].concat(alternatives);
    }
    if (state.thawed) {
      detail = (detail ? detail + ' ' : '') + '该食材已解冻，解冻后请勿再次冷冻。';
      alternatives = alternatives.filter(function (a) { return a.indexOf('冷冻') < 0; });
    }
    return { title: title, detail: detail, alternatives: alternatives };
  }

  // ---------- 用餐计划：食材在计划日的预计状态 → 调整提示 ----------
  // 入参为 assess(item, 计划日期) 的评估结果；返回 null 表示无需调整，
  // 否则返回 { level, text }，level ∈ gone / expired / danger / warn / frozen
  function planAdjustment(a) {
    if (a.state.ended) {
      return { level: 'gone', text: a.statusInfo.label + '，请更换食材或从计划中移除' };
    }
    if (a.state.clockPaused) {
      return { level: 'frozen', text: '计划日预计仍在冷冻中，需提前一晚移冷藏解冻' };
    }
    var cat = a.state.cat;
    var freezable = !!(cat && cat.freezable) && !a.state.thawed && !a.state.cooked;
    if (a.status === 'expired') {
      return { level: 'expired',
        text: '到计划日预计已过期 ' + Math.abs(a.safeDaysLeft) + ' 天，建议提前食用、把计划改早' +
          (freezable ? '或尽快分装冷冻' : '') };
    }
    if (a.status === 'danger') {
      return { level: 'danger',
        text: '到期日就在计划日前后（剩 ' + Math.max(a.safeDaysLeft, 0) + ' 天），务必优先安排' };
    }
    if (a.status === 'warn') {
      return { level: 'warn', text: '到计划日临近建议期限（剩 ' + a.safeDaysLeft + ' 天），尽量提前食用' };
    }
    return null;
  }

  // ---------- 库存列表：优先级排序 ----------
  function assessAll(items, now) {
    return items.map(function (it) { return assess(it, now); })
      .sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return String(a.item.name).localeCompare(String(b.item.name), 'zh');
      });
  }

  function activeAssessments(items, now) {
    return assessAll(items, now).filter(function (a) { return !a.state.ended; });
  }

  var FreshEngine = {
    MS_DAY: MS_DAY,
    dateOnly: dateOnly, todayAt: todayAt, addDays: addDays, daysBetween: daysBetween,
    parseISODate: parseISODate, isoDate: isoDate,
    matchCategory: matchCategory, categoryOf: categoryOf, safeDaysFor: safeDaysFor,
    normalizeName: normalizeName,
    compareEventsAsc: compareEventsAsc, compareEventsDesc: compareEventsDesc,
    rebuild: rebuild,
    assess: assess, assessAll: assessAll, activeAssessments: activeAssessments,
    planAdjustment: planAdjustment,
    STATUS: STATUS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FreshEngine;
  } else {
    global.FreshEngine = FreshEngine;
  }
})(typeof window !== 'undefined' ? window : this);
