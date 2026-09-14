/* freshkeeper/test/engine.test.js —— 决策引擎自动化测试：node --test */
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../js/engine');
const Planner = require('../js/planner');
const Storage = require('../js/storage');
const OCR = require('../js/ocr');

const D = (offset) => Engine.isoDate(Engine.addDays('2026-09-13T12:00:00', offset));
const NOW = '2026-09-13T12:00:00';

let _seq = 0;
function item(over) {
  return Object.assign({
    id: 't' + (++_seq),
    name: '菠菜', purchaseDate: D(-2), packageType: 'loose', location: 'fridge', events: []
  }, over);
}

// ---------- 分类识别 ----------
test('分类识别：精确与最长关键词优先', () => {
  assert.equal(Engine.matchCategory('五花肉馅').category.id, 'rawmeat');
  assert.equal(Engine.matchCategory('三文鱼').category.id, 'seafood');
  assert.equal(Engine.matchCategory('速冻水饺').category.id, 'frozen');
  assert.equal(Engine.matchCategory('土豆').category.id, 'root');
  assert.equal(Engine.matchCategory('未知外星菜').category, null);
});

test('分类识别：歧义单字关键词不得误伤（西红柿≠水果，蛋糕≠蛋类）', () => {
  assert.equal(Engine.matchCategory('西红柿').category.id, 'fruiting');
  assert.equal(Engine.matchCategory('番茄').category.id, 'fruiting');
  assert.equal(Engine.matchCategory('蛋糕').category.id, 'bread');
  assert.equal(Engine.matchCategory('橙子').category.id, 'fruit');
});

test('高风险食材分类正确', () => {
  ['猪里脊', '鸡腿', '虾', '牛奶', '酸奶', '豆腐', '剩菜'].forEach(n => {
    assert.equal(Engine.matchCategory(n).category.highRisk, true, n);
  });
  assert.equal(Engine.matchCategory('苹果').category.highRisk, false);
});

// ---------- 分档 ----------
test('叶菜：散装冷藏第4天 → 尽快食用（散装生鲜按未处理 5 天计）', () => {
  const a = Engine.assess(item({ purchaseDate: D(-4) }), NOW);
  assert.equal(a.status, 'warn');
  assert.match(a.advice.title, /尽快食用/);
});

test('叶菜：散装冷藏第6天 → 过期丢弃', () => {
  const a = Engine.assess(item({ purchaseDate: D(-6) }), NOW);
  assert.equal(a.status, 'expired');
  assert.match(a.advice.title, /丢弃/);
});

test('叶菜：散装冷藏第3天 → 尽快食用(warn)', () => {
  const a = Engine.assess(item({ purchaseDate: D(-3) }), NOW);
  assert.equal(a.status, 'warn');
  assert.equal(a.safeDaysLeft, 2);
});

test('猪肉：冷藏第2天 → 临期(danger)，建议今天吃或冷冻', () => {
  const a = Engine.assess(item({ name: '猪里脊', purchaseDate: D(-2), packageType: 'sealed' }), NOW);
  assert.equal(a.status, 'danger');
  assert.ok(a.advice.alternatives.some(x => /冷冻/.test(x)));
});

test('虾：冷藏第2天 → 过期（水产仅1天）', () => {
  const a = Engine.assess(item({ name: '虾', purchaseDate: D(-2), packageType: 'sealed' }), NOW);
  assert.equal(a.status, 'expired');
});

test('苹果常温新鲜', () => {
  const a = Engine.assess(item({ name: '苹果', purchaseDate: D(-2), location: 'pantry', packageType: 'loose' }), NOW);
  assert.equal(a.status, 'fresh');
});

test('冷冻中：安全时钟暂停，仅看品质期', () => {
  const a = Engine.assess(item({ name: '三文鱼', purchaseDate: D(-30), location: 'freezer', packageType: 'sealed' }), NOW);
  assert.equal(a.state.clockPaused, true);
  assert.equal(a.status, 'fresh');
  assert.match(a.advice.title, /冷冻保存中/);
});

test('冷冻超过品质期 → 品质下降，不是“过期”', () => {
  const a = Engine.assess(item({ name: '三文鱼', purchaseDate: D(-100), location: 'freezer', packageType: 'sealed' }), NOW);
  assert.equal(a.status, 'quality');
});

// ---------- 改变期限的事件 ----------
test('开封事件截断保质期', () => {
  // 酸奶密封21天：买了15天仍新鲜；开封后只剩3天，3天前开封 → warn/danger
  const sealed = Engine.assess(item({ name: '酸奶', purchaseDate: D(-15), packageType: 'sealed' }), NOW);
  assert.equal(sealed.status, 'fresh');
  const opened = Engine.assess(item({
    name: '酸奶', purchaseDate: D(-15), packageType: 'sealed',
    events: [{ id: 'e1', type: 'open', at: D(-3), deleted: false }]
  }), NOW);
  assert.ok(['warn', 'danger'].includes(opened.status), opened.status);
  assert.equal(opened.state.packageType, 'opened');
});

test('冷冻事件暂停时钟，解冻后按解冻期限续期且不可再冻', () => {
  // 猪肉第2天冷冻（本来明天到期），冷冻10天后解冻1天
  const a = Engine.assess(item({
    name: '猪里脊', purchaseDate: D(-13), packageType: 'sealed',
    events: [
      { id: 'e1', type: 'freeze', at: D(-11), deleted: false },
      { id: 'e2', type: 'thaw', at: D(-1), deleted: false }
    ]
  }), NOW);
  assert.equal(a.state.clockPaused, false);
  assert.equal(a.state.thawed, true);
  assert.ok(a.safeDaysLeft >= 0, '解冻后还在解冻期限内');
  assert.ok(!/分装冷冻/.test(a.advice.alternatives.join(';')), '解冻后不再建议冷冻');
});

test('做熟事件后按熟菜期限计算，重新加热不重置期限', () => {
  // 生猪肉做熟后按熟菜3天：4天前做熟 → 过期
  const a = Engine.assess(item({
    name: '猪里脊', purchaseDate: D(-10), packageType: 'sealed',
    events: [{ id: 'e1', type: 'cook', at: D(-4), deleted: false }]
  }), NOW);
  assert.equal(a.state.cooked, true);
  assert.equal(a.status, 'expired');

  // 1天前做熟 + 今天复热 → 仍剩2天，复热备注提示当餐吃完
  const b = Engine.assess(item({
    name: '猪里脊', purchaseDate: D(-10), packageType: 'sealed',
    events: [
      { id: 'e1', type: 'cook', at: D(-1), deleted: false },
      { id: 'e2', type: 'reheat', at: D(0), deleted: false }
    ]
  }), NOW);
  assert.equal(b.status, 'warn');
  assert.match(b.reheatNote, /不重置|当餐/);
});

test('同一天多事件按 seq 排序：数组乱序传入也按先开封后做熟重放', () => {
  // 同一天先 open(seq1) 再 cook(seq2)，数组故意倒序
  const a = Engine.assess(item({
    name: '猪里脊', purchaseDate: D(-10), packageType: 'sealed',
    events: [
      { id: 'e2', seq: 2, type: 'cook', at: D(0), createdAt: '2026-09-13T09:00:00Z', deleted: false },
      { id: 'e1', seq: 1, type: 'open', at: D(0), createdAt: '2026-09-13T08:00:00Z', deleted: false }
    ]
  }), NOW);
  assert.equal(a.state.cooked, true);
  assert.equal(a.state.packageType, 'opened');
  assert.equal(a.safeDaysLeft, 3, '今天做熟应按熟菜 3 天计');
});

test('同一天先冷冻后解冻：乱序事件仍重放为已解冻冷藏态', () => {
  const a = Engine.assess(item({
    name: '虾', purchaseDate: D(-2), packageType: 'sealed', location: 'fridge',
    events: [
      { id: 't', seq: 2, type: 'thaw', at: D(0), deleted: false },
      { id: 'f', seq: 1, type: 'freeze', at: D(0), deleted: false }
    ]
  }), NOW);
  assert.equal(a.state.clockPaused, false);
  assert.equal(a.state.thawed, true);
  assert.equal(a.state.location, 'fridge');
});

test('compareEvents：日期优先，同日按 seq，再回退 createdAt / id', () => {
  const arr = [
    { at: D(0), seq: 3, id: 'c' }, { at: D(0), seq: 1, id: 'a' },
    { at: D(-1), seq: 9, id: 'z' }, { at: D(0), seq: 2, id: 'b' }
  ];
  assert.deepEqual(arr.slice().sort(Engine.compareEventsAsc).map(e => e.id), ['z', 'a', 'b', 'c']);
  assert.deepEqual(arr.slice().sort(Engine.compareEventsDesc).map(e => e.id), ['c', 'b', 'a', 'z']);

  const noSeq = [
    { at: D(0), createdAt: '2026-09-13T10:00:00Z', id: 'late' },
    { at: D(0), createdAt: '2026-09-13T08:00:00Z', id: 'early' }
  ];
  assert.deepEqual(noSeq.slice().sort(Engine.compareEventsAsc).map(e => e.id), ['early', 'late']);

  // 完全等同时也不能恒返回一个方向（旧 bug：相等时一直返回 -1）
  const same = [{ at: D(0), seq: 1, id: 'x' }, { at: D(0), seq: 1, id: 'x' }];
  assert.equal(Engine.compareEventsAsc(same[0], same[1]), 0);
});

test('撤销事件（软删除）后期限恢复到事件前计算', () => {
  const base = item({
    name: '猪里脊', purchaseDate: D(-10), packageType: 'sealed',
    events: [{ id: 'e1', type: 'cook', at: D(-4), deleted: false }]
  });
  assert.equal(Engine.assess(base, NOW).status, 'expired');
  base.events[0].deleted = true;
  const after = Engine.assess(base, NOW);
  assert.equal(after.state.cooked, false);
  assert.equal(after.status, 'expired'); // 生肉本身也早过期了，但走的是生肉规则(safeEnd 购买+3)
});

test('不建议的保存位置产生警告（如带壳鸡蛋放冷冻）', () => {
  const a = Engine.assess(item({ name: '鸡蛋', purchaseDate: D(0), location: 'freezer', packageType: 'sealed' }), NOW);
  assert.ok(a.state.warnings.length > 0);
  assert.equal(a.state.locationNotRecommended, true);
});

// ---------- 优先级排序 ----------
test('库存按处理优先级排序：过期 > 临期 > 尽快 > 新鲜；高风险加权', () => {
  const rows = Engine.activeAssessments([
    item({ name: '苹果', purchaseDate: D(0), location: 'pantry', packageType: 'loose' }),
    item({ name: '虾', purchaseDate: D(-2), packageType: 'sealed' }),
    item({ name: '菠菜', purchaseDate: D(-2), packageType: 'loose' }),
    item({ name: '猪里脊', purchaseDate: D(-2), packageType: 'sealed' })
  ], NOW).map(a => a.item.name);
  assert.equal(rows[0], '虾');       // 过期+高风险
  assert.ok(rows.indexOf('猪里脊') < rows.indexOf('菠菜')); // danger 早于 warn
  assert.equal(rows[rows.length - 1], '苹果'); // 新鲜最后
});

// ---------- 组合方案 ----------
test('组合方案：番茄炒蛋能识别库存并注明紧迫标注', () => {
  const plans = Planner.buildPlans([
    item({ name: '番茄', purchaseDate: D(-4), packageType: 'loose' }), // warn: 剩2天
    item({ name: '鸡蛋', purchaseDate: D(-5), packageType: 'sealed' })
  ], NOW);
  const p = plans.filter(p => p.recipeId === 'egg-tomato')[0];
  assert.ok(p, '应该生成番茄炒蛋方案');
  assert.deepEqual(p.used.map(u => u.name).sort(), ['番茄', '鸡蛋']);
  assert.ok(p.steps.length >= 3);
  assert.ok(p.eventsOnApply.every(e => e.type === 'cook'));
});

test('缺必需食材不出方案，不硬凑；不可冷冻食材不产生冷冻方案', () => {
  const plans = Planner.buildPlans([
    item({ name: '鸡蛋', purchaseDate: D(-1), packageType: 'sealed' })
  ], NOW);
  assert.ok(!plans.some(p => p.recipeId === 'egg-tomato'));
  assert.ok(!plans.some(p => p.type === 'freeze'), '鸡蛋不适合冷冻，不应有冷冻方案');
});

test('过期食材只进丢弃方案，不进烹饪方案', () => {
  const plans = Planner.buildPlans([
    item({ name: '虾', purchaseDate: D(-3), packageType: 'sealed' }),
    item({ name: '菠菜', purchaseDate: D(-1), packageType: 'loose' })
  ], NOW);
  const cook = plans.filter(p => p.type === 'cook');
  cook.forEach(p => assert.ok(!p.used.some(u => u.name === '虾')));
  const discard = plans.filter(p => p.type === 'discard')[0];
  assert.ok(discard);
  assert.ok(discard.used.some(u => u.name === '虾'));
  assert.deepEqual(discard.eventsOnApply.map(e => e.type), ['discard']);
});

test('方案必须注明 stillUrgent：处理后哪些仍需尽快', () => {
  const plans = Planner.buildPlans([
    item({ name: '番茄', purchaseDate: D(-4), packageType: 'loose' }),
    item({ name: '鸡蛋', purchaseDate: D(-1), packageType: 'sealed' }),
    item({ name: '豆腐', purchaseDate: D(-2), packageType: 'opened' }) // warn/临期
  ], NOW);
  const p = plans.filter(p => p.recipeId === 'egg-tomato')[0];
  assert.ok(p.stillUrgent.some(u => u.name === '豆腐'));
});

test('熟剩菜临期给出复热方案，冷冻食材需要解冻提示', () => {
  const plans = Planner.buildPlans([
    item({
      name: '白米饭', purchaseDate: D(-2), packageType: 'opened',
      events: [{ id: 'e1', type: 'cook', at: D(-1), deleted: false }]
    }),
    item({ name: '鸡蛋', purchaseDate: D(-1), packageType: 'sealed' })
  ], NOW);
  assert.ok(plans.some(p => p.type === 'reheat'));
  assert.ok(plans.some(p => p.recipeId === 'fried-rice'));
});

// ---------- 存储与审计 ----------
test('全量追溯：创建→改字段→加事件→撤销事件，audit 完整', () => {
  const backend = (() => { let s = {}; return {
    getItem: k => s[k] ?? null, setItem: (k, v) => { s[k] = v; }
  }; })();
  const store = Storage.createStore(backend);
  const it = store.addItem({ name: '牛奶', purchaseDate: D(0), packageType: 'sealed', location: 'fridge' });
  store.updateItem(it.id, { location: 'pantry' });
  const ev = store.addEvent(it.id, 'open', { at: D(-1) });
  assert.equal(store.undoEvent(ev.id), true);

  const got = store.getItem(it.id);
  assert.equal(got.events[0].deleted, true);
  assert.ok(got.revisions.length >= 2);
  const actions = store.auditEntries().map(e => e.action);
  assert.deepEqual(actions, ['event.undo', 'event.add', 'item.update', 'item.create']);
  assert.equal(actions.length, 4);

  // 撤销后引擎不再算开封
  const a = Engine.assess(got, NOW);
  assert.equal(a.state.packageType, 'sealed');

  // 重新加载数据仍在
  const store2 = Storage.createStore(backend);
  assert.equal(store2.getItem(it.id).name, '牛奶');
});

test('applyPlan 为每个食材写入事件并记录 plan.apply', () => {
  const backend = (() => { let s = {}; return {
    getItem: k => s[k] ?? null, setItem: (k, v) => { s[k] = v; }
  }; })();
  const store = Storage.createStore(backend);
  const t = store.addItem({ name: '番茄', purchaseDate: D(-4), packageType: 'loose', location: 'fridge' });
  const e = store.addItem({ name: '鸡蛋', purchaseDate: D(-2), packageType: 'sealed', location: 'fridge' });
  const plans = Planner.buildPlans(store.listItems(), NOW);
  const p = plans.filter(p => p.recipeId === 'egg-tomato')[0];
  store.applyPlan(p);
  assert.equal(store.getItem(t.id).events.at(-1).type, 'cook');
  assert.equal(store.getItem(e.id).events.at(-1).type, 'cook');
  assert.equal(store.auditEntries()[0].action, 'plan.apply');
});

test('软删除与恢复保留历史', () => {
  const backend = (() => { let s = {}; return {
    getItem: k => s[k] ?? null, setItem: (k, v) => { s[k] = v; }
  }; })();
  const store = Storage.createStore(backend);
  const it = store.addItem({ name: '面包', purchaseDate: D(0), packageType: 'sealed', location: 'pantry' });
  store.removeItem(it.id);
  assert.equal(store.listItems().length, 0);
  assert.equal(store.listItems(true).length, 1);
  store.restoreItem(it.id);
  assert.equal(store.listItems().length, 1);
});

// ---------- OCR 解析 ----------
test('OCR 标签解析：保质期天数+生产日期推算到期日', () => {
  const r = OCR.parseLabel('特鲜牛奶\n净含量 250mL\n生产日期 2026-09-10\n保质期 7 天\n请于 0-4℃ 冷藏保存');
  assert.match(r.name, /牛奶/);
  assert.equal(r.daysShelf, 7);
  assert.equal(r.expireDate, '2026-09-17');
  assert.equal(r.locationHint, 'fridge');
});

test('OCR 标签解析：保质期至直接取日期', () => {
  const r = OCR.parseLabel('酸奶饮品\n保质期至 2026/10/01\n2-6℃冷藏');
  assert.equal(r.expireDate, '2026-10-01');
  assert.equal(r.locationHint, 'fridge');
});

test('OCR 冷冻贮存提示', () => {
  const r = OCR.parseLabel('速冻水饺 -18℃以下冷冻 保质期12个月');
  assert.equal(r.locationHint, 'freezer');
});
