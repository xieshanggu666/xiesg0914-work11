/* freshkeeper/test/import.test.js —— 导入结构校验 / 加载防御迁移 */
const test = require('node:test');
const assert = require('node:assert');
const Storage = require('../js/storage');

function memBackend() {
  let s = {};
  return {
    getItem: k => (s[k] === undefined ? null : s[k]),
    setItem: (k, v) => { s[k] = String(v); },
    _raw: () => s['freshkeeper:v1']
  };
}

const VALID_ITEM = { name: '菠菜', purchaseDate: '2026-09-10', packageType: 'loose', location: 'fridge' };

test('合法 JSON 字符串/对象均可导入（合并）', () => {
  const b = memBackend();
  const st = Storage.createStore(b);
  st.addItem({ name: '原有', purchaseDate: '2026-09-11', packageType: 'sealed', location: 'fridge' });
  const r = st.importJSON(JSON.stringify({ items: [VALID_ITEM], audit: [] }), true);
  assert.equal(r.items, 1);
  assert.equal(st.listItems().length, 2);
});

test('缺少 items 结构：拒绝且不写入', () => {
  const st = Storage.createStore(memBackend());
  assert.throws(() => st.importJSON({ foo: 1 }, true), /items/);
  assert.throws(() => st.importJSON('[1,2,3]', true), /数据对象/);
  assert.throws(() => st.importJSON('not-json', true), /JSON|JSON/i);
  assert.equal(st.listItems().length, 0);
});

test('单条记录缺必要字段（名称/购买日期/位置/包装）整体拒绝', () => {
  const st = Storage.createStore(memBackend());
  const bad = [
    { purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' },          // 缺 name
    { name: '肉', packageType: 'sealed', location: 'fridge' },                            // 缺 purchaseDate
    { name: '肉', purchaseDate: '2026-13-40', packageType: 'sealed', location: 'fridge' }, // 非法日期
    { name: '肉', purchaseDate: '2026-09-10', packageType: 'sealed', location: '阳台' },   // 非法位置
    { name: '肉', purchaseDate: '2026-09-10', packageType: '真空', location: 'fridge' },   // 非法包装
    '一条字符串', null, 42
  ];
  bad.forEach(rec => {
    assert.throws(() => st.importJSON({ items: [rec] }, true), /结构|缺少|非法|对象/);
  });
  assert.equal(st.listItems().length, 0);
});

test('畸形事件/修订结构被拒绝（不静默吞掉）', () => {
  const st = Storage.createStore(memBackend());
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { events: '已开封' })] }, true), /events/);
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { events: [{ type: '未知', at: '2026-09-11' }] })] }, true), /事件类型/);
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { events: [{ type: 'open' }] })] }, true), /日期/);
  assert.throws(() => st.importJSON({ items: [Object.assign({}, VALID_ITEM, { revisions: {} })] }, true), /revisions/);
});

test('原子性：多条中只有一条非法时全部不写入，已有库存不变', () => {
  const b = memBackend();
  const st = Storage.createStore(b);
  st.addItem({ name: '原有牛奶', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' });
  const before = st.exportJSON();
  assert.throws(() => st.importJSON({ items: [
    { name: '好蛋', purchaseDate: '2026-09-01', packageType: 'sealed', location: 'fridge' },
    { name: '坏肉', purchaseDate: 'not-a-date', packageType: 'sealed', location: 'fridge' }
  ] }, true), /1 处/);
  assert.equal(st.listItems().length, 1);
  assert.equal(st.listItems()[0].name, '原有牛奶');
  assert.equal(st.exportJSON(), before, '拒绝后存储应完全不变');
});

test('覆盖模式遇到非法数据也不能清空现有库存', () => {
  const st = Storage.createStore(memBackend());
  st.addItem({ name: '不能被清掉', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' });
  assert.throws(() => st.importJSON({ items: [{ name: '坏' }] }, false));
  assert.equal(st.listItems().length, 1);
  assert.equal(st.listItems()[0].name, '不能被清掉');
});

test('同一文件内/与现有库存重复 ID 拒绝合并', () => {
  const st = Storage.createStore(memBackend());
  st.importJSON({ items: [{ id: 'X1', name: 'A', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' }] }, true);
  assert.throws(() => st.importJSON({ items: [{ id: 'X1', name: 'B', purchaseDate: '2026-09-11', packageType: 'sealed', location: 'fridge' }] }, true), /ID/);
  assert.throws(() => st.importJSON({ items: [
    { id: 'Y', name: 'A', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' },
    { id: 'Y', name: 'B', purchaseDate: '2026-09-11', packageType: 'sealed', location: 'fridge' }
  ] }, true), /重复/);
});

test('导入记录缺少 id/events/revisions 时自动补全为可用结构', () => {
  const clean = Storage.validatePayload({ items: [Object.assign({}, VALID_ITEM, {
    events: [{ type: 'open', at: '2026-09-11' }],
    revisions: undefined
  })] });
  const it = clean.items[0];
  assert.ok(it.id);
  assert.ok(Array.isArray(it.events) && it.events[0].id);
  assert.ok(Array.isArray(it.revisions));
  assert.equal(it.events[0].type, 'open');
});

test('新增事件分配食材内单调递增 seq，同一天事件据此排序', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem({ name: '虾', purchaseDate: '2026-09-11', packageType: 'sealed', location: 'fridge' });
  const e1 = st.addEvent(it.id, 'freeze', { at: '2026-09-13' });
  const e2 = st.addEvent(it.id, 'thaw', { at: '2026-09-13' });
  const e3 = st.addEvent(it.id, 'cook', { at: '2026-09-13' });
  assert.deepEqual([e1.seq, e2.seq, e3.seq], [1, 2, 3]);

  // 方案批量应用（同一天多个事件）同样有序
  const Planner = require('../js/planner');
  const Engine = require('../js/engine');
  const t = st.addItem({ name: '番茄', purchaseDate: '2026-09-09', packageType: 'loose', location: 'fridge' });
  const e = st.addItem({ name: '鸡蛋', purchaseDate: '2026-09-01', packageType: 'sealed', location: 'fridge' });
  const plans = Planner.buildPlans(st.listItems().filter(x => x.id === t.id || x.id === e.id), '2026-09-13T12:00:00');
  const plan = plans.find(p => p.recipeId === 'egg-tomato');
  assert.ok(plan);
  st.applyPlan(plan);
  const seqOf = id => st.getItem(id).events.slice().pop().seq;
  assert.ok(seqOf(t.id) >= 1 && seqOf(e.id) >= 1);
});

test('导入归一化保留事件 seq；无 seq 的历史事件按文件次序补号且不与已有号冲突', () => {
  const clean = Storage.validatePayload({ items: [{
    name: '肉', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge',
    events: [
      { type: 'freeze', at: '2026-09-11', seq: 5 },
      { type: 'thaw', at: '2026-09-11' },
      { type: 'cook', at: '2026-09-11' }
    ]
  }] });
  const evs = clean.items[0].events;
  assert.equal(evs[0].seq, 5);
  assert.ok(evs[1].seq > 5 && evs[2].seq > 5);
  assert.notEqual(evs[1].seq, evs[2].seq, '补号互不相同，同日顺序稳定');
  // 保持文件中的先后次序
  assert.deepEqual(evs.map(x => x.type), ['freeze', 'thaw', 'cook']);
});

test('加载旧版脏数据时宽松迁移：核心字段合法则保留并归一化，页面不崩', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [
      { id: 'a', name: '好记录', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge', events: null, revisions: null },
      { id: 'b', name: '缺日期', location: 'fridge', packageType: 'sealed' },
      '字符串', null,
      { id: 'c', name: '位置错', purchaseDate: '2026-09-10', packageType: 'sealed', location: '阳台' },
      { id: 'd', name: '畸形事件', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge',
        events: [{ type: 'open', at: '2026-09-11' }, '坏事件', { type: 'bad', at: 'x' }] }
    ],
    audit: [{ action: 'item.create' }, null, 'junk']
  }));
  const st = Storage.createStore(b);
  const items = st.listItems(true);
  assert.equal(items.length, 3);                       // 缺日期/字符串/null 被跳过
  assert.deepEqual(items.map(i => i.id).sort(), ['a', 'c', 'd']);
  assert.ok(Array.isArray(st.getItem('a').events));    // null 归一化
  assert.equal(st.getItem('c').location, 'fridge');    // 非法位置兜底
  assert.equal(st.getItem('d').events.length, 1);      // 有效事件保留
  assert.equal(st.auditEntries().length, 1);

  // 引擎可正常评估迁移后的每条记录（复现渲染崩溃场景）
  const Engine = require('../js/engine');
  assert.doesNotThrow(() => items.forEach(i => Engine.assess(i)));

  // 已回写为干净结构
  const reparsed = JSON.parse(b._raw());
  assert.ok(reparsed.items.every(x => x && typeof x === 'object' && Array.isArray(x.events)));
});

test('本地 JSON 完全损坏时降级为空库存而非抛错', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', '{损坏的json');
  assert.doesNotThrow(() => Storage.createStore(b));
  assert.equal(Storage.createStore(b).listItems().length, 0);
});

test('合并较早生成的备份：外部审计按实际时间排在本地较新操作之前（seq 不倒置）', () => {
  const st = Storage.createStore(memBackend());
  // 本地在较晚时间产生操作
  st.addItem({ name: '本地新食材', purchaseDate: '2026-09-13', packageType: 'sealed', location: 'fridge' });

  // 外部备份：审计记录都生成于很早以前，但其 seq 恰好很大
  const oldBackup = {
    items: [
      { id: 'old1', name: '旧备份食材', purchaseDate: '2026-01-01', packageType: 'sealed', location: 'fridge' }
    ],
    audit: [
      { id: 'old-a1', seq: 999, at: '2026-01-01T08:00:00.000Z', action: 'item.create',
        detail: { itemId: 'old1', name: '旧备份食材' } },
      { id: 'old-a2', seq: 1000, at: '2026-01-02T08:00:00.000Z', action: 'event.add',
        detail: { itemId: 'old1', name: '旧备份食材', eventType: 'open' } }
    ]
  };
  st.importJSON(oldBackup, true);

  const entries = st.auditEntries();
  const ordered = entries.map(e => e.action);
  // 最新（data.import / 本地 create）必须在最前；旧备份 1 月的记录必须在后
  const idxOldest = ordered.indexOf('item.create', ordered.indexOf('data.import'));
  const lastTwo = ordered.slice(-2);
  assert.deepEqual(lastTwo, ['event.add', 'item.create'], '旧备份两条按时间顺序落在末尾');
  const idxOldCreate = ordered.lastIndexOf('item.create');
  assert.ok(idxOldCreate > ordered.indexOf('data.import'), '旧备份录入早于本次导入');
  // 旧备份自身顺序正确：1/2 event.add 在 1/1 create 之前（倒序）
  assert.ok(ordered.indexOf('event.add') > -1);
});

test('合并较晚生成的备份：外部较新审计应排在本地较早操作之前', () => {
  const st = Storage.createStore(memBackend());
  st.addItem({ name: '本地旧食材', purchaseDate: '2026-09-01', packageType: 'sealed', location: 'fridge' });

  const newerBackup = {
    items: [
      { id: 'new1', name: '备份里的新食材', purchaseDate: '2026-09-13', packageType: 'sealed', location: 'fridge' }
    ],
    audit: [
      { id: 'new-a1', seq: 1, at: '2026-12-01T08:00:00.000Z', action: 'item.create',
        detail: { itemId: 'new1', name: '备份里的新食材' } }
    ]
  };
  st.importJSON(newerBackup, true);
  const ordered = st.auditEntries().map(e => e.at);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i - 1] >= ordered[i], '审计必须按时间倒序，第 ' + i + ' 条倒置');
  }
  assert.equal(ordered[ordered.length - 1] < '2026-10-01', true, '本地最早操作在最末');
});

test('同毫秒操作仍由 seq 兜底排序（不受合并影响）', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem({ name: '奶', purchaseDate: '2026-09-13', packageType: 'sealed', location: 'fridge' });
  st.addEvent(it.id, 'open', { at: '2026-09-13' });
  st.addEvent(it.id, 'cook', { at: '2026-09-13' });
  const ordered = st.auditEntries();
  const times = ordered.map(e => e.at);
  // 前两条为同毫秒新增的事件：seq 大的（cook）在前
  assert.equal(times[0], times[1], '最新两条事件同毫秒');
  const detailTypes = ordered.slice(0, 2).map(e => e.detail.eventType);
  assert.deepEqual(detailTypes, ['cook', 'open']);
});
