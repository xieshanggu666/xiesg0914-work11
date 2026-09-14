/*
 * freshkeeper/planner.js —— 库存组合方案
 *
 * 两类方案：
 *  A. 烹饪方案：模板由“食材槽位”（分类组）构成，按紧迫度贪婪匹配库存，
 *     必须所有槽位都能填满才成立（缺料时在 missing 中说明，不硬凑）。
 *  B. 处置方案：丢弃（已过期）、分装冷冻（临期且适合冷冻）、彻底复热（熟剩菜）。
 *
 * 每个方案都必须显式注明：
 *    used[]            使用了哪些食材
 *    stillUrgent[]     应用后仍需尽快处理的食材
 *    eventsOnApply[]   应用时要写入的事件（保证记录可追溯）
 */
(function (global) {
  'use strict';

  var Engine = (typeof require === 'function') ? require('./engine') : global.FreshEngine;
  var Diet = (typeof require === 'function') ? require('./diet') : global.FreshDiet;

  // 槽位可选分类：叶菜 / 瓜果茄 / 根茎 / 菌菇 / 生肉 / 禽肉 / 水产 / 熟肉火腿 /
  //              剩菜 / 熟主食 / 蛋 / 奶 / 酸奶 / 豆制品 / 面包 / 速冻
  var RECIPES = [
    {
      id: 'stirfry-meat-veg',
      title: '肉片快炒时蔬',
      minutes: 20,
      slots: [
        { groups: [['rawmeat', 'poultry', 'deli']], label: '肉类' },
        { groups: [['leafy', 'fruiting', 'mushroom']], label: '蔬菜' }
      ],
      steps: [
        '肉切薄片，用少许生抽、料酒、淀粉抓匀腌 10 分钟',
        '蔬菜洗净切段/块；热锅冷油先炒肉片至变色盛出',
        '锅中下蔬菜大火翻炒至断生，倒回肉片，加盐调味即可出锅'
      ],
      tip: '叶菜要最后下锅、快炒出水少；快炒全程不超过 5 分钟。'
    },
    {
      id: 'seafood-veg',
      title: '白灼虾/清蒸鱼配青菜',
      minutes: 20,
      slots: [
        { groups: [['seafood']], label: '水产' },
        { groups: [['leafy', 'fruiting']], label: '配菜' }
      ],
      steps: [
        '水产彻底清洗：虾去虾线，鱼去鳞去内脏',
        '水开后虾焯 2–3 分钟至弯曲变红；鱼大火蒸 8–10 分钟',
        '配菜白灼或清炒，搭配葱姜豉油蘸料'
      ],
      tip: '水产当天买当天吃最安全，必须彻底加热至全熟。'
    },
    {
      id: 'veg-soup',
      title: '时令蔬菜豆腐汤',
      minutes: 25,
      slots: [
        { groups: [['tofu']], label: '豆腐' },
        { groups: [['leafy', 'fruiting', 'mushroom', 'root']], label: '蔬菜' }
      ],
      steps: [
        '豆腐切小块用淡盐水泡 5 分钟去豆腥，蔬菜切块',
        '少油炒香根茎/菌菇类，加水煮开后转中火煮 8 分钟',
        '下豆腐和叶菜煮 2–3 分钟，加盐、白胡椒、几滴香油'
      ],
      tip: '豆腐开封后极易坏，汤要一次喝完，剩汤冷藏不超过 2 天。'
    },
    {
      id: 'egg-tomato',
      title: '番茄炒蛋（万能下饭菜）',
      minutes: 10,
      slots: [
        { groups: [['egg']], label: '鸡蛋' },
        { groups: [['fruiting']], label: '番茄/瓜茄' }
      ],
      steps: [
        '3–4 个鸡蛋打散加少许盐，番茄切块',
        '热油将蛋液炒至刚凝固盛出',
        '番茄炒出沙后倒回鸡蛋，加糖少许、盐调味翻匀'
      ],
      tip: '鸡蛋液要彻底炒熟；番茄出汁后尽快出锅，避免菜汤久放。'
    },
    {
      id: 'fried-rice',
      title: '什锦炒饭/炒面',
      minutes: 15,
      slots: [
        { groups: [['rice']], label: '剩米饭/熟面' },
        { groups: [['egg']], label: '鸡蛋', optional: true },
        { groups: [['rawmeat', 'poultry', 'deli', 'seafood']], label: '荤料', optional: true },
        { groups: [['leafy', 'fruiting', 'root', 'mushroom']], label: '蔬菜', optional: true }
      ],
      steps: [
        '所有配料切小丁；鸡蛋炒散盛出',
        '荤料丁先炒透（务必全熟），再下耐炒的根茎类',
        '下米饭大火炒散，加蛋液和叶菜翻匀，调味后立即出锅'
      ],
      tip: '熟主食再次加热必须彻底滚烫；这道菜最适合“清空冰箱边角料”。'
    },
    {
      id: 'meat-potato-stew',
      title: '土豆萝卜炖肉',
      minutes: 45,
      slots: [
        { groups: [['rawmeat', 'poultry']], label: '肉类' },
        { groups: [['root']], label: '土豆/萝卜' },
        { groups: [['leafy', 'fruiting', 'mushroom']], label: '配菜', optional: true }
      ],
      steps: [
        '肉切块焯水去血沫，土豆萝卜切滚刀块',
        '糖色或生抽炒香肉块，加热水没过，大火烧开转小火炖 25 分钟',
        '下土豆萝卜再炖 15 分钟至软烂，收汁前 5 分钟放配菜'
      ],
      tip: '炖菜一次吃不完应快速分装浅盒冷藏，24 小时内吃完，吃前彻底煮沸。'
    },
    {
      id: 'yogurt-fruit',
      title: '水果酸奶杯 / 奶昔',
      minutes: 5,
      slots: [
        { groups: [['yogurt', 'milk']], label: '酸奶/奶' },
        { groups: [['fruit']], label: '水果' }
      ],
      steps: [
        '水果去皮切小块，质地软的可压成果酱层',
        '杯中一层水果、一层酸奶叠加，或全部放入料理机打 30 秒',
        '现做现吃，不放糖更健康'
      ],
      tip: '开封奶/酸奶有结块、酸味异常就不要食用。'
    },
    {
      id: 'frozen-dumpling-soup',
      title: '速冻水饺/馄饨汤餐',
      minutes: 15,
      slots: [
        { groups: [['frozen']], label: '速冻食品' },
        { groups: [['leafy', 'fruiting', 'egg']], label: '配菜/蛋', optional: true }
      ],
      steps: [
        '无需解冻，水沸后直接下锅，轻推防粘',
        '沸腾后点 2–3 次冷水，至全部浮起再煮 3 分钟确保内馅熟透',
        '可顺便烫一把青菜或卧个蛋，调一碗清汤底'
      ],
      tip: '速冻食品一旦解冻就不要再冻回去；表面发黏、包装袋破损请丢弃。'
    }
  ];

  function urgencyPoints(a) {
    if (a.status === 'expired') return 0;   // 过期食材不进烹饪方案
    if (a.status === 'danger') return 100;
    if (a.status === 'warn') return 50;
    if (a.status === 'quality') return 40;
    return 5;
  }

  function candidateItems(assessments, group, allowFrozen) {
    return assessments.filter(function (a) {
      if (a.state.ended) return false;
      if (!allowFrozen && a.state.clockPaused) return false;
      if (a.status === 'expired') return false;
      var cat = a.state.cat;
      return cat && group.indexOf(cat.id) >= 0;
    });
  }

  function keyOf(a) {
    return a.item.id != null ? a.item.id : '#' + a.item.name + '@' + (a.item.purchaseDate || '');
  }

  // 为一个槽位贪婪选择当前最紧迫且未被占用的食材
  function pickForSlot(slot, assessments, usedKeys, allowFrozen) {
    var best = null;
    function consider(a) {
      if (usedKeys[keyOf(a)]) return;
      if (!best || urgencyPoints(a) > urgencyPoints(best) ||
          (urgencyPoints(a) === urgencyPoints(best) && a.safeDaysLeft < best.safeDaysLeft)) {
        best = a;
      }
    }
    slot.groups.forEach(function (group) {
      candidateItems(assessments, group, allowFrozen).forEach(consider);
    });
    return best;
  }

  // 把一组“槽位→选中评估”的指派装配成烹饪方案对象（新建与替换食材共用）。
  // slotPicks: [{ slot, pick }]，pick 为 null 表示可选槽位留空；必需槽位留空则返回 null。
  function assembleCookingPlan(recipe, slotPicks, now) {
    var used = [], missing = [], frozenUsed = false, score = 0, optionalFilled = 0, optionalTotal = 0;
    var slotInfo = [];
    slotPicks.forEach(function (sp) {
      var slot = sp.slot, pick = sp.pick;
      if (slot.optional) optionalTotal++;
      if (!pick) {
        if (!slot.optional) missing.push({ label: slot.label, groups: slot.groups });
        slotInfo.push({ index: slotInfo.length, label: slot.label, groups: slot.groups, optional: !!slot.optional, usedId: null });
        return;
      }
      used.push(pick);
      score += urgencyPoints(pick);
      if (slot.optional) optionalFilled++;
      if (pick.state.clockPaused) frozenUsed = true;
      slotInfo.push({ index: slotInfo.length, label: slot.label, groups: slot.groups, optional: !!slot.optional, usedId: keyOf(pick) });
    });

    if (missing.length) return null; // 必需槽位不齐，不出方案

    score += optionalFilled * 10; // 多消耗边角料加分
    var thawSteps = frozenUsed
      ? ['【准备】冷冻食材提前 1 晚移冷藏解冻；来不及就密封袋浸泡流动冷水，切勿室温久放解冻']
      : [];

    var plan = {
      type: 'cook',
      recipeId: recipe.id,
      title: recipe.title,
      minutes: recipe.minutes,
      used: used.map(function (a) {
        return {
          id: a.item.id, name: a.item.name,
          // 携带库存中已确认的分类（含手动指定）：饮食冲突评估不能只靠名称猜分类，
          // 否则“名称不含关键词但手选了分类”的食材会漏报过敏/忌口
          categoryId: a.state.cat ? a.state.cat.id : (a.item.categoryId || ''),
          statusLabel: a.statusInfo.label,
          frozen: a.state.clockPaused,
          note: a.state.clockPaused ? '冷冻中，需先解冻'
            : (a.safeDaysLeft <= 1 ? '今天到期，优先使用'
              : (a.safeDaysLeft <= (a.highRisk ? 2 : 3) ? '近 ' + a.safeDaysLeft + ' 天到期' : null))
        };
      }),
      steps: thawSteps.concat(recipe.steps),
      tip: recipe.tip,
      leftoverNote: '做熟后冷藏建议 ' + (used.some(function (a) { return a.state.cat && a.state.cat.highRisk; }) ? '1–2' : '2–3') + ' 天内吃完；',
      score: score,
      eventsOnApply: used.map(function (a) {
        return { itemId: a.item.id, type: 'cook', at: Engine.isoDate(now) };
      }),
      // 槽位结构供“替换冲突食材”定位（自由指派时不在 UI 暴露）
      _slots: slotInfo
    };
    return plan;
  }

  function buildCookingPlans(assessments, now, opts) {
    opts = opts || {};
    var allowFrozen = opts.allowFrozen !== false;
    var plans = [];

    RECIPES.forEach(function (recipe) {
      var usedIds = {};
      var slotPicks = recipe.slots.map(function (slot) {
        var pick = pickForSlot(slot, assessments, usedIds, allowFrozen);
        if (pick) usedIds[keyOf(pick)] = true;
        return { slot: slot, pick: pick };
      });
      var plan = assembleCookingPlan(recipe, slotPicks, now);
      if (plan) plans.push(plan);
    });

    return plans;
  }

  // 处置类方案
  function buildActionPlans(assessments, now) {
    var plans = [];

    // 1) 过期 → 丢弃
    var expired = assessments.filter(function (a) { return !a.state.ended && a.status === 'expired'; });
    if (expired.length) {
      plans.push({
        type: 'discard',
        title: '清理已过期食材',
        used: expired.map(function (a) {
          return { id: a.item.id, name: a.item.name, statusLabel: '已过期 ' + Math.abs(a.safeDaysLeft) + ' 天' };
        }),
        steps: [
          '确认包装破损/异味/变色情况（仅作记录，不要靠闻味判断高风险食材）',
          '密封后丢弃，避免汁水交叉污染冰箱',
          '清洁该食材接触过的隔板和抽屉'
        ],
        tip: '高风险食材（肉禽水产蛋奶豆制品、剩菜）过期后即使外观正常也应丢弃。',
        score: 500,
        eventsOnApply: expired.map(function (a) {
          return { itemId: a.item.id, type: 'discard', at: Engine.isoDate(now), reason: '超过建议安全期限' };
        })
      });
    }

    // 2) 临期且适合冷冻 → 分装冷冻
    var freezables = assessments.filter(function (a) {
      var c = a.state.cat;
      return !a.state.ended && !a.state.clockPaused && !a.state.thawed && c && c.freezable &&
        (a.status === 'danger' || a.status === 'warn');
    });
    if (freezables.length) {
      plans.push({
        type: 'freeze',
        title: '今天来不及吃？分装冷冻',
        used: freezables.map(function (a) {
          return { id: a.item.id, name: a.item.name, statusLabel: a.statusInfo.label + '（剩 ' + Math.max(a.safeDaysLeft, 0) + ' 天）' };
        }),
        steps: [
          '按一顿的量分装（生肉切薄片/丝更易解冻），挤出空气密封',
          '包装上标注名称和冷冻日期',
          '尽快放入冷冻室深处，避免反复开关门的温度波动'
        ],
        tip: '叶菜建议先焯水 30 秒、挤干再冻；解冻后请勿再次冷冻，' +
             '熟制品品质期约 2–3 个月，生肉约 6 个月。',
        score: 300 + freezables.length * 30,
        eventsOnApply: freezables.map(function (a) {
          return { itemId: a.item.id, type: 'freeze', at: Engine.isoDate(now) };
        })
      });
    }

    // 3) 熟剩菜/熟主食临期 → 彻底复热当餐吃完
    var reheatable = assessments.filter(function (a) {
      return !a.state.ended && a.state.cooked && (a.status === 'danger' || a.status === 'warn' || a.status === 'quality');
    });
    if (reheatable.length) {
      plans.push({
        type: 'reheat',
        title: '剩菜彻底复热，当餐吃完',
        used: reheatable.map(function (a) {
          return { id: a.item.id, name: a.item.name, statusLabel: a.statusInfo.label };
        }),
        steps: [
          '带汤剩菜煮沸并保持翻滚 3 分钟；干饭/炒菜微波炉高火后搅拌再加热，确保中心滚烫',
          '当餐吃完，吃多少热多少，不要把没吃完的再次冷藏',
          '复热后仍有异味、发酸或发黏，立即丢弃'
        ],
        tip: '重新加热不会“重置”保质期，也不应反复加热剩菜。',
        score: 250 + reheatable.length * 20,
        eventsOnApply: reheatable.map(function (a) {
          return { itemId: a.item.id, type: 'reheat', at: Engine.isoDate(now) };
        })
      });
    }

    return plans;
  }

  // 方案应用后仍需尽快处理的库存
  function stillUrgentAfter(plan, assessments) {
    var handled = {};
    plan.used.forEach(function (u) { handled[u.id] = true; });
    return assessments.filter(function (a) {
      if (a.state.ended || handled[a.item.id]) return false;
      return a.status === 'expired' || a.status === 'danger' || a.status === 'warn';
    }).map(function (a) {
      return {
        id: a.item.id, name: a.item.name,
        statusLabel: a.statusInfo.label,
        safeDaysLeft: a.safeDaysLeft,
        advice: a.advice.title
      };
    });
  }

  function buildPlans(items, now, opts) {
    now = Engine.todayAt(now);
    var assessments = Engine.activeAssessments(items, now);
    var plans = buildCookingPlans(assessments, now, opts).concat(buildActionPlans(assessments, now));
    plans.forEach(function (p) {
      p.stillUrgent = stillUrgentAfter(p, assessments);
      p.score += Math.max(0, 30 - p.stillUrgent.length * 3); // 能缓解更多紧迫库存的方案优先
    });
    plans.sort(function (a, b) { return b.score - a.score; });
    return plans.slice(0, 6);
  }

  // ---------- 饮食冲突：替换方案中的食材（同槽位换人） ----------
  //
  // 家庭成员忌口/过敏确认冲突后，可在不改菜谱的前提下把某样食材换成同槽位
  // （满足同一组分类）的另一项在库食材。候选规则：
  //   · 未归档、未过期；allowFrozen 与方案生成口径一致（默认可用冷冻）
  //   · 排除该方案里已经在用的其他食材（同一食材不在一道菜里重复）
  //   · members 存在时排除“对所选成员仍然过敏”的食材（忌口/偏好不拦）
  //   · 排序：过敏安全 → 偏好优先 → 紧迫度高（先消耗临期）→ 名称
  function assessmentById(assessments, id) {
    return assessments.filter(function (a) { return a.item.id === id; })[0] || null;
  }

  function substitutionCandidates(plan, itemId, items, opts) {
    opts = opts || {};
    var now = Engine.todayAt(opts.now);
    var members = Array.isArray(opts.members) ? opts.members : [];
    var allowFrozen = opts.allowFrozen !== false;
    if (!plan || plan.type !== 'cook') return [];
    var recipe = RECIPES.filter(function (r) { return r.id === plan.recipeId; })[0];
    if (!recipe) return [];
    var slotIdx = -1;
    (plan._slots || []).forEach(function (s) { if (s.usedId === itemId) slotIdx = s.index; });
    if (slotIdx < 0) return []; // 方案里没有这道食材
    var slot = recipe.slots[slotIdx];

    var usedIds = {};
    plan.used.forEach(function (u) { usedIds[u.id] = true; });
    var candidates = Engine.activeAssessments(items, now).filter(function (a) {
      if (a.state.ended || a.status === 'expired') return false;
      if (!allowFrozen && a.state.clockPaused) return false;
      if (usedIds[a.item.id]) return false; // 已在方案中（含被替换者自身）的不能作为候选
      var cat = a.state.cat;
      if (!cat) return false;
      return slot.groups.some(function (group) { return group.indexOf(cat.id) >= 0; });
    });
    candidates.sort(function (a, b) {
      var safeA = Diet.isSafe(members, a) ? 0 : 1;
      var safeB = Diet.isSafe(members, b) ? 0 : 1;
      if (safeA !== safeB) return safeA - safeB;
      var pA = Diet.preferCount(members, a), pB = Diet.preferCount(members, b);
      if (pA !== pB) return pB - pA;
      if (urgencyPoints(a) !== urgencyPoints(b)) return urgencyPoints(b) - urgencyPoints(a);
      if (a.safeDaysLeft !== b.safeDaysLeft) return a.safeDaysLeft - b.safeDaysLeft;
      return String(a.item.name).localeCompare(String(b.item.name), 'zh');
    });
    return candidates.map(function (a) {
      return {
        id: a.item.id, name: a.item.name,
        categoryId: a.state.cat ? a.state.cat.id : '',
        statusLabel: a.statusInfo.label,
        frozen: a.state.clockPaused,
        safe: Diet.isSafe(members, a),
        preferCount: Diet.preferCount(members, a)
      };
    });
  }

  // 返回替换后的新方案（不修改原方案）；替换不合法（食材不在方案/候选不符槽位）返回 null。
  // 替换后 steps/stillUrgent 等全部按同一套装配逻辑重算。
  function substituteInPlan(plan, oldItemId, newItem, items, opts) {
    opts = opts || {};
    var now = Engine.todayAt(opts.now);
    if (!plan || plan.type !== 'cook') return null;
    var recipe = RECIPES.filter(function (r) { return r.id === plan.recipeId; })[0];
    if (!recipe) return null;
    var slotIdx = -1;
    (plan._slots || []).forEach(function (s) { if (s.usedId === oldItemId) slotIdx = s.index; });
    if (slotIdx < 0) return null;
    var slot = recipe.slots[slotIdx];

    var assessments = Engine.activeAssessments(items, now);
    var next = assessmentById(assessments, newItem && newItem.id);
    if (!next || next.state.ended || next.status === 'expired') return null;
    var already = plan.used.some(function (u) { return u.id !== oldItemId && u.id === next.item.id; });
    if (already) return null;
    var cat = next.state.cat;
    if (!cat || !slot.groups.some(function (group) { return group.indexOf(cat.id) >= 0; })) return null;

    var slotPicks = recipe.slots.map(function (s, i) {
      if (i === slotIdx) return { slot: s, pick: next };
      var sid = plan._slots[i] ? plan._slots[i].usedId : null;
      return { slot: s, pick: sid ? assessmentById(assessments, sid) : null };
    });
    // 其他槽位食材若已归档（被吃完/删除），对应必需槽位视为无法重建
    var broken = slotPicks.some(function (sp) { return !sp.pick && !sp.slot.optional; });
    if (broken) return null;
    var rebuilt = assembleCookingPlan(recipe, slotPicks, now);
    if (!rebuilt) return null;
    rebuilt.stillUrgent = stillUrgentAfter(rebuilt, assessments);
    rebuilt.score += Math.max(0, 30 - rebuilt.stillUrgent.length * 3);
    rebuilt.substituted = { from: oldItemId, to: next.item.id };
    return rebuilt;
  }

  var Planner = {
    RECIPES: RECIPES,
    buildPlans: buildPlans,
    buildCookingPlans: buildCookingPlans,
    buildActionPlans: buildActionPlans,
    stillUrgentAfter: stillUrgentAfter,
    substitutionCandidates: substitutionCandidates,
    substituteInPlan: substituteInPlan
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Planner;
  } else {
    global.FreshPlanner = Planner;
  }
})(typeof window !== 'undefined' ? window : this);
