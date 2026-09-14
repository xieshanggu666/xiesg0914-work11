/* freshkeeper/test/diet.test.js —— 家庭成员饮食偏好/忌口/过敏：匹配、冲突、替换、成员 CRUD、导入导出 */
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../js/engine');
const Diet = require('../js/diet');
const Planner = require('../js/planner');
const Storage = require('../js/storage');

function memBackend() {
  let s = {};
  return {
    getItem: k => (s[k] === undefined ? null : s[k]),
    setItem: (k, v) => { s[k] = String(v); },
    _raw: () => s['freshkeeper:v1']
  };
}

const D = (offset) => Engine.isoDate(Engine.addDays('2026-09-13T12:00:00', offset));
const NOW = '2026-09-13T12:00:00';

// ---------- 纯逻辑：标签匹配 ----------
test('分类标签按食材分类命中，自定义标签按名称关键词命中', () => {
  const shrimp = { id: 'i1', name: '虾', categoryId: 'seafood' };
  assert.equal(Diet.tagHits('cat:seafood', Diet.normalizeTarget(shrimp)), true);
  assert.equal(Diet.tagHits('cat:egg', Diet.normalizeTarget(shrimp)), false);
  const peanut = { id: 'i2', name: '花生酱拌面', categoryId: 'rice' };
  assert.equal(Diet.tagHits('花生', Diet.normalizeTarget(peanut)), true);
  // 名称归一化：空白/大小写不敏感
  assert.equal(Diet.tagHits('milk', Diet.normalizeTarget({ id: 'i3', name: 'Milk 牛奶', categoryId: 'bread' })), true);
});

test('只给名称时按引擎自动识别分类；未知分类不命中分类标签', () => {
  const t = Diet.normalizeTarget({ name: '三文鱼' });
  assert.equal(t.categoryId, 'seafood');
  assert.equal(Diet.tagHits('cat:seafood', t), true);
  const unk = Diet.normalizeTarget({ name: '神秘食材' });
  assert.equal(Diet.tagHits('cat:egg', unk), false);
});

test('空值容忍：members/targets 为空或缺字段时无冲突且不抛错', () => {
  assert.equal(Diet.evaluate(null, null).hasConflict, false);
  assert.equal(Diet.evaluate(undefined, [{ id: 'x', name: '虾' }]).hasConflict, false);
  assert.equal(Diet.evaluate([{ name: '裸成员' }], [{ id: 'x', name: '虾' }]).hasConflict, false);
  assert.equal(Diet.isSafe([{ allergyTags: null }], { name: '虾' }), true);
});

test('标签清洗：去空白、去重、限长，非数组按空处理', () => {
  assert.deepEqual(Diet.cleanTags([' 花生', '花生', '', '  ']), ['花生']);
  assert.deepEqual(Diet.cleanTags(null), []);
  assert.deepEqual(Diet.cleanTags('花生'), []);
});

// ---------- 冲突分级 ----------
test('过敏=blocker、忌口=warning、偏好=like；同一成员可同时命中', () => {
  const members = [
    { id: 'm1', name: '妈妈', allergyTags: ['cat:seafood', '花生'], avoidTags: ['cat:tofu'], preferTags: ['番茄'] }
  ];
  const r = Diet.evaluate(members, [
    { id: 'a', name: '虾', categoryId: 'seafood' },
    { id: 'b', name: '老豆腐', categoryId: 'tofu' },
    { id: 'c', name: '番茄炒蛋', categoryId: 'fruiting' },
    { id: 'd', name: '米饭', categoryId: 'rice' }
  ]);
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0].name, '虾');
  assert.equal(r.blockers[0].blockers.length, 1);
  assert.equal(r.blockerCount, 1);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].name, '老豆腐');
  assert.equal(r.warningCount, 1);
  // 番茄通过名称关键词命中偏好
  assert.equal(r.likes.length, 1);
  assert.equal(r.likes[0].likes[0].tagLabel, '番茄');
  assert.equal(r.likeCount, 1);
  assert.equal(r.hasConflict, true);
});

test('多名成员命中同一食材：过敏优先于忌口，理由列出每位成员', () => {
  const members = [
    { id: 'm1', name: '妈', allergyTags: ['cat:egg'] },
    { id: 'm2', name: '爸', avoidTags: ['cat:egg'] }
  ];
  const r = Diet.evaluate(members, [{ id: 'e', name: '鸡蛋', categoryId: 'egg' }]);
  assert.equal(r.blockers.length, 1);
  assert.equal(r.warnings.length, 0, '有过敏的行不算纯 warning');
  const row = r.blockers[0];
  assert.deepEqual(Diet.reasonLines(row.blockers), ['妈：鸡蛋（带壳）']);
});

test('isSafe 只看过敏；preferCount 统计偏好人数', () => {
  const members = [
    { id: 'm1', allergyTags: ['cat:seafood'], preferTags: ['番茄'] },
    { id: 'm2', avoidTags: ['cat:seafood'], preferTags: ['番茄'] }
  ];
  assert.equal(Diet.isSafe(members, { name: '虾', categoryId: 'seafood' }), false);
  assert.equal(Diet.isSafe(members, { name: '番茄', categoryId: 'fruiting' }), true);
  assert.equal(Diet.preferCount(members, { name: '番茄', categoryId: 'fruiting' }), 2);
});

// ---------- 方案替换 ----------
function seededStore() {
  const st = Storage.createStore(memBackend());
  const specs = [
    { name: '菠菜', categoryId: 'leafy', packageType: 'loose', location: 'fridge' },
    { name: '黄瓜', categoryId: 'fruiting', packageType: 'loose', location: 'fridge' },
    { name: '番茄', categoryId: 'fruiting', packageType: 'loose', location: 'fridge' },
    { name: '牛肉', categoryId: 'rawmeat', packageType: 'sealed', location: 'fridge' },
    { name: '虾', categoryId: 'seafood', packageType: 'sealed', location: 'fridge' },
    { name: '三文鱼', categoryId: 'seafood', packageType: 'sealed', location: 'freezer' }
  ];
  specs.forEach(s => st.addItem(Object.assign({ purchaseDate: D(0) }, s)));
  return st;
}

test('substitutionCandidates：同槽位、未在用、排除自身；偏好优先、过敏候选沉底', () => {
  const st = seededStore();
  st.addMember({ name: '妈妈', allergyTags: ['cat:seafood'], preferTags: ['番茄'] });
  const plans = Planner.buildPlans(st.listItems(), NOW);
  const seafoodPlan = plans.find(p => p.recipeId === 'seafood-veg');
  assert.ok(seafoodPlan, '白灼水产方案应成立');
  // 水产槽：只剩三文鱼（虾自身已在用，被排除），但仍过敏，标记 safe=false
  const fishCands = Planner.substitutionCandidates(seafoodPlan, seafoodPlan.used[0].id, st.listItems(), { now: NOW, members: st.listMembers() });
  assert.deepEqual(fishCands.map(c => c.name), ['三文鱼']);
  assert.equal(fishCands[0].safe, false);
  // 配菜槽（leafy/fruiting）：番茄因偏好排第一，且没有菠菜（自身）
  const vegId = seafoodPlan.used[1].id;
  const vegCands = Planner.substitutionCandidates(seafoodPlan, vegId, st.listItems(), { now: NOW, members: st.listMembers() });
  assert.equal(vegCands[0].name, '番茄');
  assert.equal(vegCands[0].preferCount, 1);
  assert.ok(vegCands.every(c => c.name !== seafoodPlan.used[1].name), '被替换者自身不出现在候选中');
});

test('substituteInPlan：同槽位替换重建方案，跨槽位/不存在食材返回 null', () => {
  const st = seededStore();
  st.addMember({ name: '妈', allergyTags: ['cat:seafood'] });
  const plans = Planner.buildPlans(st.listItems(), NOW);
  const seafoodPlan = plans.find(p => p.recipeId === 'seafood-veg');
  const vegId = seafoodPlan.used[1].id;
  const tomato = st.listItems().find(i => i.name === '番茄');
  const rebuilt = Planner.substituteInPlan(seafoodPlan, vegId, { id: tomato.id }, st.listItems(), { now: NOW });
  assert.ok(rebuilt);
  assert.deepEqual(rebuilt.used.map(u => u.name).sort(), ['虾', '番茄'].sort());
  assert.ok(rebuilt.stillUrgent !== undefined, 'stillUrgent 重算');
  // 事件随之改为新食材
  assert.ok(rebuilt.eventsOnApply.some(e => e.itemId === tomato.id));
  assert.ok(!rebuilt.eventsOnApply.some(e => e.itemId === vegId));
  // 跨槽位（牛肉不能填水产/配菜槽）返回 null
  const beef = st.listItems().find(i => i.name === '牛肉');
  assert.equal(Planner.substituteInPlan(seafoodPlan, seafoodPlan.used[0].id, { id: beef.id }, st.listItems(), { now: NOW }), null);
  // 方案中不存在的食材 id
  assert.equal(Planner.substituteInPlan(seafoodPlan, 'nope', { id: tomato.id }, st.listItems(), { now: NOW }), null);
});

test('替换后重评冲突：把过敏食材换成安全食材后冲突消失', () => {  const st = seededStore();
  st.addMember({ name: '妈', avoidTags: ['cat:leafy'] }); // 只忌口叶菜
  const plans = Planner.buildPlans(st.listItems(), NOW);
  const plan = plans.find(p => p.recipeId === 'seafood-veg');
  const before = Diet.evaluate(st.listMembers(), plan.used.map(u => ({ id: u.id, name: u.name })));
  assert.equal(before.warnings.length, 1, '菠菜是叶菜→忌口');
  const spinachId = plan.used.find(u => u.name === '菠菜').id;
  const cucumber = st.listItems().find(i => i.name === '黄瓜');
  const rebuilt = Planner.substituteInPlan(plan, spinachId, { id: cucumber.id }, st.listItems(), { now: NOW });
  const after = Diet.evaluate(st.listMembers(), rebuilt.used.map(u => ({ id: u.id, name: u.name })));
  assert.equal(after.hasConflict, false);
});

test('原方案对象不被替换修改（不可变）', () => {
  const st = seededStore();
  const plans = Planner.buildPlans(st.listItems(), NOW);
  const plan = plans.find(p => p.recipeId === 'seafood-veg');
  const beforeNames = plan.used.map(u => u.name);
  const cucumber = st.listItems().find(i => i.name === '黄瓜');
  Planner.substituteInPlan(plan, plan.used[1].id, { id: cucumber.id }, st.listItems(), { now: NOW });
  assert.deepEqual(plan.used.map(u => u.name), beforeNames);
});

// 回归：方案 used[] 必须携带库存已确认分类，饮食评估不能只靠名称猜分类
test('回归：手动分类的食材（名称不含关键词）也会报告过敏冲突', () => {
  const st = Storage.createStore(memBackend());
  // “海味拼盘”名称不含任何水产关键词，自动识别不出分类；用户手动选为水产
  st.addItem({ name: '海味拼盘', categoryId: 'seafood', purchaseDate: D(0), packageType: 'sealed', location: 'fridge' });
  st.addItem({ name: '青菜', categoryId: 'leafy', purchaseDate: D(0), packageType: 'loose', location: 'fridge' });
  st.addMember({ name: '妈', allergyTags: ['cat:seafood'] });
  const plans = Planner.buildPlans(st.listItems(), NOW);
  const plan = plans.find(p => p.recipeId === 'seafood-veg');
  assert.ok(plan, '手动分类为水产的食材应能进入白灼方案槽位');
  // 1) 方案 used 条目带已确认分类
  const usedSeafood = plan.used.find(u => u.name === '海味拼盘');
  assert.equal(usedSeafood.categoryId, 'seafood');
  // 2) 只用方案自带信息（id/name/categoryId，模拟“库存已删除”兜底）也能命中
  const evFromUsed = Diet.evaluate(st.listMembers(), plan.used);
  assert.equal(evFromUsed.blockers.length, 1);
  assert.equal(evFromUsed.blockers[0].name, '海味拼盘');
  // 3) 名称猜分类确认识别不出（这正是漏报根因，证明命中依赖的是已确认分类而非名称）
  assert.equal(Diet.normalizeTarget({ name: '海味拼盘' }).categoryId, '');
  // 4) 不带分类只传 {id,name} 时确实漏报（对照用例，说明 app 层必须解析库存分类）
  assert.equal(Diet.evaluate(st.listMembers(), [{ id: 'x', name: '海味拼盘' }]).blockers.length, 0);
});

test('回归：手选分类与名称识别不一致时，饮食评估以已确认分类为准', () => {
  const st = Storage.createStore(memBackend());
  // 名字像水果，实际被用户归类为水产
  st.addItem({ name: '菠萝海鲜船', categoryId: 'seafood', purchaseDate: D(0), packageType: 'sealed', location: 'fridge' });
  st.addItem({ name: '生菜', categoryId: 'leafy', purchaseDate: D(0), packageType: 'loose', location: 'fridge' });
  st.addMember({ name: '爸', allergyTags: ['cat:seafood'], preferTags: ['cat:fruit'] });
  const plans = Planner.buildPlans(st.listItems(), NOW);
  const plan = plans.find(p => p.recipeId === 'seafood-veg');
  const ev = Diet.evaluate(st.listMembers(), plan.used);
  const row = ev.blockers.find(r => r.name === '菠萝海鲜船');
  assert.ok(row, '按已确认分类（水产）报过敏，而非按名称猜成水果');
  assert.equal(ev.likes.some(r => r.name === '菠萝海鲜船'), false);
});

// ---------- 存储：成员 CRUD ----------
test('成员 CRUD：创建入审计、同名拒绝、修改字段级流水、删除保留计划快照', () => {
  const st = Storage.createStore(memBackend());
  const m = st.addMember({ name: '妈妈', allergyTags: ['cat:seafood', '花生'], avoidTags: [], preferTags: ['番茄'] });
  assert.equal(m.allergyTags.length, 2);
  assert.ok(st.auditEntries().some(e => e.action === 'member.add'));
  assert.throws(() => st.addMember({ name: '妈妈 ' }), /同名/);
  assert.throws(() => st.addMember({ name: '  ' }), /不能为空/);

  st.updateMember(m.id, { allergyTags: ['cat:seafood'], preferTags: ['番茄', '鸡蛋'] });
  const upd = st.auditEntries().find(e => e.action === 'member.update');
  assert.ok(upd, '修改入审计');
  assert.ok(upd.detail.changes.allergyTags || upd.detail.changes.preferTags);
  assert.equal(st.getMember(m.id).allergyTags.length, 1);

  // 无变化不产生流水
  const nAudit = st.auditEntries().length;
  st.updateMember(m.id, { allergyTags: ['cat:seafood'] });
  assert.equal(st.auditEntries().length, nAudit);

  // 计划里的成员名快照不随删除丢失
  const it = st.addItem({ name: '虾', categoryId: 'seafood', purchaseDate: D(0), packageType: 'sealed', location: 'fridge' });
  st.addMealPlan({ name: '周五', date: D(1), items: [{ id: it.id, name: '虾' }], members: [m.id] });
  assert.equal(st.removeMember(m.id), true);
  const plan = st.listMealPlans()[0];
  assert.deepEqual(plan.members, [{ id: m.id, name: '妈妈' }]);
  assert.ok(st.auditEntries().some(e => e.action === 'member.remove'));
});

test('用餐计划保存成员快照与冲突确认；addMealPlan 自动剔除不存在的成员', () => {
  const st = Storage.createStore(memBackend());
  const m = st.addMember({ name: '爸', allergyTags: ['cat:egg'] });
  const it = st.addItem({ name: '鸡蛋', categoryId: 'egg', purchaseDate: D(0), packageType: 'sealed', location: 'fridge' });
  const plan = st.addMealPlan({
    name: '周六', date: D(2),
    items: [{ id: it.id, name: '鸡蛋' }],
    members: [m.id, '不存在'],
    diet: { blockers: ['鸡蛋（爸：鸡蛋（带壳））'], warnings: [] }
  });
  assert.deepEqual(plan.members.map(x => x.name), ['爸']);
  assert.ok(plan.diet.acknowledgedAt, '冲突确认时间被补全');
  const entry = st.auditEntries().find(e => e.action === 'mealplan.add');
  assert.deepEqual(entry.detail.memberNames, ['爸']);
  assert.equal(entry.detail.dietAck.blockers.length, 1);
});

// ---------- 导入导出 / 迁移 ----------
test('成员随导出/合并导入往返；重复 ID 拒绝合并', () => {
  const st = Storage.createStore(memBackend());
  st.addMember({ name: '爷爷', allergyTags: ['cat:egg'], avoidTags: ['香菜'] });
  const text = st.exportJSON();
  assert.equal(JSON.parse(text).members.length, 1);
  const st2 = Storage.createStore(memBackend());
  const r = st2.importJSON(text, true);
  assert.equal(r.members, 1);
  assert.deepEqual(st2.listMembers()[0].allergyTags, ['cat:egg']);
  assert.throws(() => st2.importJSON(text, true), /成员.*ID/);
});

test('成员畸形结构：导入严格拒绝（原子），本地加载宽松跳过', () => {
  const st = Storage.createStore(memBackend());
  assert.throws(() => st.importJSON({ items: [], members: [{ allergyTags: ['cat:egg'] }] }, true), /姓名/);
  assert.throws(() => st.importJSON({ items: [], members: ['字符串'] }, true), /对象/);
  assert.throws(() => st.importJSON({ items: [], members: [{ name: 'x', allergyTags: '花生' }] }, true), /标签必须是数组/);
  assert.equal(st.listMembers().length, 0, '全部拒绝后无成员');

  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [],
    members: [
      { id: 'mb1', name: '好人', allergyTags: ['cat:egg'] },
      { id: 'mb2' },                 // 缺姓名：宽松跳过
      { id: 'mb3', name: '标签坏', allergyTags: '花生' } // 非数组：宽松置空保留
    ],
    audit: []
  }));
  const st2 = Storage.createStore(b);
  const rows = st2.listMembers();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.id === 'mb3').allergyTags.length, 0);
});

test('计划里的 members 畸形：导入严格拒绝，宽松加载修复', () => {
  const st = Storage.createStore(memBackend());
  assert.throws(() => st.importJSON({
    items: [], mealPlans: [{ id: 'p1', name: '坏', date: '2026-09-15', items: [], members: 'x' }]
  }, true), /members 必须是数组/);
  assert.throws(() => st.importJSON({
    items: [], mealPlans: [{ id: 'p2', name: '坏', date: '2026-09-15', items: [], members: [{ name: '没 id' }] }]
  }, true), /缺少 id/);
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [],
    mealPlans: [{ id: 'p3', name: '好', date: '2026-09-15', items: [], members: [{ id: 'mb9', name: '奶奶' }, 'x'] }]
  }));
  const st2 = Storage.createStore(b);
  assert.deepEqual(st2.getMealPlan('p3').members, [{ id: 'mb9', name: '奶奶' }]);
});

test('演示数据：成员只添加一次，含三类标签；方案应用可携带饮食确认入审计', () => {
  const st = Storage.createStore(memBackend());
  st.seedDemo(null, Engine);
  const n1 = st.listMembers().length;
  st.seedDemo(null, Engine);
  assert.equal(st.listMembers().length, n1, '重复载入演示不重复添加成员');
  const mom = st.listMembers().find(m => m.name === '妈妈');
  assert.ok(mom.allergyTags.includes('cat:seafood'));
  // applyPlan 第三参 meta 记录就餐成员与确认
  const plans = Planner.buildPlans(st.listItems(), NOW);
  const cook = plans.find(p => p.type === 'cook');
  st.applyPlan(cook, undefined, { memberNames: ['妈妈'], diet: { blockers: ['三文鱼（妈妈：水产海鲜）'], warnings: [] } });
  const entry = st.auditEntries().find(e => e.action === 'plan.apply');
  assert.deepEqual(entry.detail.memberNames, ['妈妈']);
  assert.equal(entry.detail.dietAck.blockers.length, 1);
});
