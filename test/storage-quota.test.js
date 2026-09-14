/* freshkeeper/test/storage-quota.test.js —— 本地存储写满：失败报错、内存回滚、历史瘦身 */
const test = require('node:test');
const assert = require('node:assert');
const Storage = require('../js/storage');

function quotaErr() {
  const e = new Error("Failed to execute 'setItem' on 'Storage': Setting the value exceeded the quota.");
  e.name = 'QuotaExceededError';
  return e;
}

// 始终写满的后端
function alwaysFullBackend() {
  return {
    getItem: () => null,
    setItem: () => { throw quotaErr(); }
  };
}

// “容量台阶”后端：当写入数据长度超过当前阈值即失败，模拟使用过程中配额被收紧
function gateBackend(initial) {
  const mem = {};
  const api = {
    limit: initial,
    getItem: k => (mem[k] === undefined ? null : mem[k]),
    setItem: (k, v) => {
      if (api.limit != null && String(v).length > api.limit) throw quotaErr();
      mem[k] = String(v);
    },
    _raw: () => mem['freshkeeper:v1']
  };
  return api;
}

// 按容量限制的后端：数据超过 maxChars 就配额失败
function sizedBackend(maxChars) {
  const mem = {};
  return {
    getItem: k => (mem[k] === undefined ? null : mem[k]),
    setItem: (k, v) => {
      if (String(v).length > maxChars) throw quotaErr();
      mem[k] = String(v);
    },
    _raw: () => mem['freshkeeper:v1']
  };
}

const W = Storage.StorageWriteError;

test('写满时 addItem 抛出带 quota 标记的 StorageWriteError', () => {
  const st = Storage.createStore(alwaysFullBackend());
  assert.throws(() => st.addItem(
    { name: '牛奶', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' }
  ), err => W.is(err) && err.quota === true);
});

test('写失败后内存回滚：内存里看不到“幽灵记录”，刷新语义一致', () => {
  const st = Storage.createStore(alwaysFullBackend());
  assert.throws(() => st.addItem(
    { name: '牛奶', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' }
  ));
  assert.equal(st.listItems().length, 0);
  assert.equal(st.auditEntries().length, 0);
});

test('写失败后内存回滚到上一个已落盘状态（半成品事件不残留）', () => {
  const b = gateBackend(null);
  const st = Storage.createStore(b);
  const item = st.addItem(
    { name: '酸奶', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' });
  // 使用中途配额收紧：只允许当前已落盘的数据原样写回，任何变大的写入都失败
  b.limit = b._raw().length;
  assert.throws(() => st.addEvent(item.id, 'open', { at: '2026-09-14' }));
  assert.equal(st.getItem(item.id).events.length, 0);
  const onDisk = JSON.parse(b._raw());
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.items[0].events.length, 0);
});

test('多事件方案（applyPlan）部分写入后失败：全部回滚，磁盘与内存一致', () => {
  const b = gateBackend(null);
  const st = Storage.createStore(b);
  const a = st.addItem({ name: '菠菜', purchaseDate: '2026-09-14', packageType: 'loose', location: 'fridge' });
  const bb = st.addItem({ name: '番茄', purchaseDate: '2026-09-14', packageType: 'loose', location: 'fridge' });
  // 配额只够再容纳一个事件：第一个事件能写，第二个失败，第一个也必须随回滚撤销
  b.limit = b._raw().length + 600;
  const plan = {
    type: 'cook', title: '测试方案',
    used: [{ id: a.id }, { id: bb.id }],
    eventsOnApply: [
      { itemId: a.id, type: 'cook', at: '2026-09-14', reason: '做熟' },
      { itemId: bb.id, type: 'cook', at: '2026-09-14', reason: '做熟' }
    ]
  };
  assert.throws(() => st.applyPlan(plan), err => W.is(err));
  // 两条事件都不应残留（第一条曾短暂成功并落盘，回滚后磁盘快照恢复）
  assert.equal(st.getItem(a.id).events.length, 0);
  assert.equal(st.getItem(bb.id).events.length, 0);
  const onDisk = JSON.parse(b._raw());
  assert.equal(onDisk.items.reduce((n, it) => n + it.events.length, 0), 0);
});

test('非配额写入异常（隐私模式等）也被识别为 StorageWriteError 且 quota=false', () => {
  const b = {
    getItem: () => null,
    setItem: () => { const e = new Error('Storage is disabled'); e.name = 'SecurityError'; throw e; }
  };
  const st = Storage.createStore(b);
  assert.throws(() => st.addItem(
    { name: '牛奶', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' }
  ), err => W.is(err) && err.quota === false);
  assert.equal(st.listItems().length, 0);
});

test('isQuotaError 只识别配额类异常，普通 Error/SecurityError 不误判', () => {
  assert.equal(Storage.isQuotaError({ name: 'QuotaExceededError' }), true);
  assert.equal(Storage.isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), true);
  assert.equal(Storage.isQuotaError({ name: 'Error', code: 22 }), true);
  assert.equal(Storage.isQuotaError({ name: 'Error', message: 'the quota was exceeded' }), true);
  assert.equal(Storage.isQuotaError({ name: 'SecurityError', message: 'Storage is disabled' }), false);
  assert.equal(Storage.isQuotaError({ name: 'TypeError' }), false);
  assert.equal(Storage.isQuotaError(null), false);
});

test('从写满恢复后可正常写入（失败状态不污染后续操作）', () => {
  const b = gateBackend(null);
  const st = Storage.createStore(b);
  const item = st.addItem(
    { name: '鸡蛋', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' });
  b.limit = b._raw().length; // 配额收紧：事件写不进
  assert.throws(() => st.addEvent(item.id, 'open', { at: '2026-09-14' }));
  b.limit = null;            // 用户清理空间后恢复
  assert.doesNotThrow(() => st.addEvent(item.id, 'open', { at: '2026-09-14' }));
  assert.equal(st.getItem(item.id).events.length, 1);
});

test('pruneHistory 删除旧 audit 与 revisions，保留库存/事件/成员/计划', () => {
  const b = sizedBackend(Infinity);
  const st = Storage.createStore(b);
  const item = st.addItem(
    { name: '豆腐', purchaseDate: '2026-09-14', packageType: 'opened', location: 'fridge' });
  for (let i = 0; i < 30; i++) {
    st.updateItem(item.id, { note: '备注第 ' + i + ' 次，撑大修订历史' });
  }
  st.addEvent(item.id, 'open', { at: '2026-09-14' });
  st.addShopping({ name: '补货虾' });
  st.addMember({ name: '妈妈' });
  st.addMealPlan({ name: '周五晚餐', date: '2026-09-15', items: [{ id: item.id, name: '豆腐' }] });
  const auditBefore = st.auditEntries().length;
  assert.ok(auditBefore > 30);

  const r = st.pruneHistory({ keepAudit: 10, keepRevisions: 3 });
  assert.ok(r.droppedAudit > 0);
  assert.ok(r.revisionsDropped >= 27);
  assert.ok(st.auditEntries().length <= 10 + 2); // 保留窗口 + prune 自身流水（可能 1 条）
  // 主干数据完好
  assert.equal(st.listItems().length, 1);
  assert.equal(st.getItem(item.id).events.length, 1);
  assert.equal(st.listShopping().length, 1);
  assert.equal(st.listMembers().length, 1);
  assert.equal(st.listMealPlans().length, 1);
  assert.ok(st.getItem(item.id).revisions.length <= 3);
  // 引擎重放依赖的事件没被删，期限结论仍可计算
  const onDisk = JSON.parse(b._raw());
  assert.equal(onDisk.items[0].events.length, 1);
});

test('pruneHistory 保留回收站食材的 item.remove 流水（恢复入口不丢）', () => {
  const st = Storage.createStore(sizedBackend(Infinity));
  const a = st.addItem({ name: '菠菜A', purchaseDate: '2026-09-01', packageType: 'loose', location: 'fridge' });
  const c = st.addItem({ name: '菠菜C', purchaseDate: '2026-09-14', packageType: 'loose', location: 'fridge' });
  st.removeItem(a.id); // 很早的删除（按时间倒序排在后面）
  st.removeItem(c.id);
  const r = st.pruneHistory({ keepAudit: 1, keepRevisions: 0 });
  assert.ok(r.droppedAudit >= 0);
  // 两条 item.remove 都是仍在回收站的食材恢复入口，必须保留
  const removes = st.auditEntries().filter(e => e.action === 'item.remove');
  assert.equal(removes.length, 2);
  assert.ok(st.restoreItem(a.id)); // 仍可恢复
});

test('容量紧张时 pruneHistory 能自救：瘦身后成功落盘并腾出空间', () => {
  const KEEP_AUDIT = 30, KEEP_REV = 3;
  // 先在不限容量的 store 中生成数据，量出“瘦身后应有体积”，
  // 据此把故障容量卡在“完整数据写不进、瘦身后能写进”的区间
  const measure = gateBackend(null);
  const stm = Storage.createStore(measure);
  const seed = stm.addItem(
    { name: '牛肉', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' });
  for (let i = 0; i < 60; i++) stm.updateItem(seed.id, { note: '长备注'.repeat(10) + i });
  stm.pruneHistory({ keepAudit: KEEP_AUDIT, keepRevisions: KEEP_REV });
  const prunedSize = measure._raw().length;

  const b = gateBackend(null);
  const st = Storage.createStore(b);
  const item = st.addItem(
    { name: '牛肉', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' });
  // 灌大量流水/修订撑大体积
  for (let i = 0; i < 60; i++) st.updateItem(item.id, { note: '长备注'.repeat(10) + i });
  const big = b._raw().length;

  b.limit = prunedSize + 800; // 比瘦身后略大（够再写一条事件），但远小于完整数据
  assert.ok(b.limit < big, '前置：阈值确实小于完整数据体积');
  // 普通写入失败并回滚
  assert.throws(() => st.addEvent(item.id, 'open', { at: '2026-09-14' }), err => W.is(err));
  // 瘦身后可以写回
  const r = st.pruneHistory({ keepAudit: KEEP_AUDIT, keepRevisions: KEEP_REV });
  assert.ok(b._raw().length < big);
  assert.ok(r.bytesSaved > 0);
  // 清理后新的保存恢复正常
  assert.doesNotThrow(() => st.addEvent(item.id, 'open', { at: '2026-09-14' }));
  assert.equal(st.getItem(item.id).events.length, 1);
});

test('瘦身后仍写不进（配额近乎为 0）：抛 StorageWriteError 引导导出+清空', () => {
  const b = gateBackend(null);
  const st = Storage.createStore(b);
  st.addItem({ name: '鱼', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' });
  b.limit = 200;
  // 即使 keepAudit=0，库存本身也超过 200 字符时，prune 必须报错而不是静默成功
  assert.throws(() => st.pruneHistory({ keepAudit: 0, keepRevisions: 0 }), err => W.is(err));
});

test('storageInfo 报告各部分占用与条数', () => {
  const st = Storage.createStore(sizedBackend(Infinity));
  st.addItem({ name: '虾', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' });
  const info = st.storageInfo();
  assert.equal(info.counts.items, 1);
  assert.ok(info.totalBytes > 0);
  assert.ok(info.parts.audit > 0);
  ['items', 'shopping', 'mealPlans', 'members', 'audit'].forEach(k => {
    assert.equal(typeof info.parts[k], 'number');
  });
});
