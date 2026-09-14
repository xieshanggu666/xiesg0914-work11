/*
 * freshkeeper/diet.js —— 家庭成员饮食偏好与忌口/过敏（纯逻辑，无 DOM、无存储依赖）
 *
 * 成员记录三类标签（diet 标签）：
 *   allergyTags 过敏食材：命中即“阻断”级冲突，不确认风险不能继续
 *   avoidTags   忌口/不喜欢：命中即“警告”级冲突，提示后可继续
 *   preferTags  偏好/爱吃：命中仅作正向提示（“这顿有他爱吃的”），永不阻断
 *
 * 标签两种形态：
 *   'cat:<categoryId>' 分类标签（如 cat:seafood 水产、cat:egg 鸡蛋）——按食材分类命中
 *   '花生' 等自由文本   自定义食材关键词——按食材名称归一化后包含匹配
 *
 * 空值容忍：所有字段缺失/为 null 时按“无限制”处理，模块永不抛错，
 * 方便老数据（没有 members）与未选就餐成员时直接复用。
 */
(function (global) {
  'use strict';

  var Rules = (typeof require === 'function') ? require('./rules') : global.FreshRules;
  var Engine = (typeof require === 'function') ? require('./engine') : global.FreshEngine;

  var CAT_PREFIX = 'cat:';
  var TAG_KINDS = ['allergy', 'avoid', 'prefer'];
  // 严重度：过敏必须确认风险或替换；忌口警告可直接继续；偏好只是提示
  var KIND_META = {
    allergy: { level: 'blocker', label: '过敏', icon: '🚫' },
    avoid:   { level: 'warning', label: '忌口', icon: '⚠️' },
    prefer:  { level: 'like', label: '偏好', icon: '💚' }
  };

  function normalizeName(s) {
    return Engine.normalizeName(s);
  }

  // 标签清洗：去空白、限长、去重；非数组按空处理（空值=无限制）
  function cleanTags(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    v.forEach(function (t) {
      t = String(t == null ? '' : t).trim().slice(0, 30);
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }

  function isCatTag(tag) { return String(tag || '').indexOf(CAT_PREFIX) === 0; }
  function catTag(catId) { return CAT_PREFIX + catId; }
  function catIdFromTag(tag) { return isCatTag(tag) ? tag.slice(CAT_PREFIX.length) : ''; }

  function categoryName(catId) {
    var c = Rules.categories.filter(function (x) { return x.id === catId; })[0];
    return c ? c.name : catId;
  }

  // 标签的人类可读名：cat:seafood → 水产海鲜；自由文本原样
  function tagLabel(tag) {
    return isCatTag(tag) ? categoryName(catIdFromTag(tag)) : String(tag);
  }

  // 统一目标食材：可传库存 item、引擎评估结果（带 .item/.state.cat）或 { id, name }
  function normalizeTarget(t) {
    if (!t) return null;
    var item = t.item || t;
    if (!item || (!item.id && item.id !== 0) && !item.name) return null;
    var catId = item.categoryId || '';
    if (!catId && t.state && t.state.cat) catId = t.state.cat.id;
    if (!catId) {
      var c = Engine.categoryOf({ name: item.name, categoryId: '' });
      if (c) catId = c.id;
    }
    return {
      id: (item.id != null) ? item.id : ('name:' + normalizeName(item.name)),
      name: item.name || '',
      categoryId: catId || ''
    };
  }

  // 单个标签是否命中目标食材：分类标签比对分类，自定义标签比对名称关键词
  function tagHits(tag, target) {
    if (!tag) return false;
    if (isCatTag(tag)) return !!target.categoryId && target.categoryId === catIdFromTag(tag);
    var kw = normalizeName(tag);
    return !!kw && normalizeName(target.name).indexOf(kw) >= 0;
  }

  // 评估单样食材对单名成员的命中情况（返回 { blockers, warnings, likes } 命中数组）
  function hitsForMember(member, target) {
    var out = { blockers: [], warnings: [], likes: [] };
    if (!member) return out;
    TAG_KINDS.forEach(function (kind) {
      cleanTags(member[kind + 'Tags']).forEach(function (tag) {
        if (tagHits(tag, target)) {
          var hit = {
            memberId: member.id || '', memberName: member.name || '',
            type: kind, level: KIND_META[kind].level,
            tag: tag, tagLabel: tagLabel(tag)
          };
          if (kind === 'allergy') out.blockers.push(hit);
          else if (kind === 'avoid') out.warnings.push(hit);
          else out.likes.push(hit);
        }
      });
    });
    return out;
  }

  /*
   * 评估所选就餐成员与一批食材的全部冲突。
   * members: 成员对象数组（空/缺字段=无限制）
   * targets: 食材数组（item / 评估结果 / {id,name} 均可）
   * 返回：
   *   { members:[{id,name}], list:[食材行…],
   *     blockers:[有过敏命中的行], warnings:[无过敏但有忌口的行], likes:[有偏好命中的行],
   *     blockerCount, warningCount, likeCount, hasConflict }
   * 食材行：{ id, name, categoryId, blockers[], warnings[], likes[] }
   */
  function evaluate(members, targets) {
    members = Array.isArray(members) ? members : [];
    var tg = (Array.isArray(targets) ? targets : []).map(normalizeTarget).filter(Boolean);
    var list = tg.map(function (t) {
      var row = { id: t.id, name: t.name, categoryId: t.categoryId, blockers: [], warnings: [], likes: [] };
      members.forEach(function (m) {
        var h = hitsForMember(m, t);
        row.blockers = row.blockers.concat(h.blockers);
        row.warnings = row.warnings.concat(h.warnings);
        row.likes = row.likes.concat(h.likes);
      });
      return row;
    });
    var result = {
      members: members.map(function (m) { return { id: m.id, name: m.name }; }),
      list: list,
      blockers: list.filter(function (r) { return r.blockers.length; }),
      warnings: list.filter(function (r) { return !r.blockers.length && r.warnings.length; }),
      likes: list.filter(function (r) { return r.likes.length; })
    };
    result.blockerCount = result.blockers.reduce(function (n, r) { return n + r.blockers.length; }, 0);
    result.warningCount = result.warnings.reduce(function (n, r) { return n + r.warnings.length; }, 0);
    result.likeCount = result.likes.reduce(function (n, r) { return n + r.likes.length; }, 0);
    result.hasConflict = result.blockers.length > 0 || result.warnings.length > 0;
    return result;
  }

  // 某样食材对所选成员是否安全（无过敏命中）——替换候选筛选使用
  function isSafe(members, target) {
    var t = normalizeTarget(target);
    if (!t) return false;
    return !members.some(function (m) {
      return cleanTags(m && m.allergyTags).some(function (tag) { return tagHits(tag, t); });
    });
  }

  // 偏好命中人数——同等紧迫度下优先消耗“有人爱吃”的食材
  function preferCount(members, target) {
    var t = normalizeTarget(target);
    if (!t) return 0;
    var n = 0;
    members.forEach(function (m) {
      if (cleanTags(m && m.preferTags).some(function (tag) { return tagHits(tag, t); })) n++;
    });
    return n;
  }

  // 一行冲突的可读理由：['爸爸：水产海鲜', '妈妈：花生']
  function reasonLines(hits) {
    return (hits || []).map(function (h) {
      return (h.memberName || '家庭成员') + '：' + h.tagLabel;
    });
  }

  var FreshDiet = {
    CAT_PREFIX: CAT_PREFIX,
    TAG_KINDS: TAG_KINDS,
    KIND_META: KIND_META,
    cleanTags: cleanTags,
    isCatTag: isCatTag,
    catTag: catTag,
    catIdFromTag: catIdFromTag,
    tagLabel: tagLabel,
    normalizeTarget: normalizeTarget,
    tagHits: tagHits,
    hitsForMember: hitsForMember,
    evaluate: evaluate,
    isSafe: isSafe,
    preferCount: preferCount,
    reasonLines: reasonLines
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FreshDiet;
  } else {
    global.FreshDiet = FreshDiet;
  }
})(typeof window !== 'undefined' ? window : this);
