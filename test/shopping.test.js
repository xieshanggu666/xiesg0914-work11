/* freshkeeper/test/shopping.test.js —— 家庭共享采购：待认领/已认领/已购买 + 认领转交 + 购买完成关联 */
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

const MILK = { name: '酸奶', categoryId: 'yogurt', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge' };

test('手动添加待购：默认 unclaimed（待认领），可写数量与备注', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '菠菜', categoryId: 'leafy', qty: '2 斤', note: '选小棵的' });
  assert.equal(sh.status, 'unclaimed');
  assert.equal(sh.assignee, undefined);
  assert.equal(sh.source, 'manual');
  assert.equal(sh.qty, '2 斤');
  const rows = st.listShopping('unclaimed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, sh.id);
  assert.ok(!st.listShopping('done').length);
});

test('添加时指定负责人：直接进入已认领', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '排骨', categoryId: 'meat', assignee: '妈妈' });
  assert.equal(sh.status, 'claimed');
  assert.equal(sh.assignee, '妈妈');
  assert.ok(sh.claimedAt);
  assert.equal(st.listShopping('unclaimed').length, 0);
  assert.equal(st.listShopping('claimed').length, 1);
});

test('从已吃完/已丢弃食材发起补货：带来源标记与来源食材 ID', () => {
  const st = Storage.createStore(memBackend());
  const it = st.addItem(MILK);
  st.addEvent(it.id, 'consume', { at: '2026-09-12' });
  const sh = st.addShopping(
    { name: it.name, categoryId: it.categoryId, sourceItemId: it.id, sourceName: it.name },
    'consume');
  assert.equal(sh.source, 'consume');
  assert.equal(sh.sourceItemId, it.id);
  assert.equal(sh.sourceName, '酸奶');
});

test('认领：待认领 → 已认领，记录负责人与认领时间', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '黄瓜', qty: '3 根' });
  assert.equal(st.claimShopping(sh.id, '爸爸'), true);
  const now = st.getShopping(sh.id);
  assert.equal(now.status, 'claimed');
  assert.equal(now.assignee, '爸爸');
  assert.ok(now.claimedAt);
});

test('认领空名字被拒绝；已购买的不能再认领', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '黄瓜' });
  assert.equal(st.claimShopping(sh.id, '   '), false);
  const it = st.addItem(MILK);
  st.completeShopping(sh.id, it.id);
  assert.equal(st.claimShopping(sh.id, '爸爸'), false);
});

test('转交：更换负责人，仍为已认领；同名转交无变化返回 false', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '酱油', assignee: '妈妈' });
  assert.equal(st.transferShopping(sh.id, '爸爸'), true);
  assert.equal(st.getShopping(sh.id).assignee, '爸爸');
  assert.equal(st.getShopping(sh.id).status, 'claimed');
  assert.equal(st.transferShopping(sh.id, '爸爸'), false);
  assert.equal(st.transferShopping(sh.id, ''), false);
});

test('转交可从待认领池直接指定负责人（等同认领，写 claim 流水）', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '生姜' });
  // 待认领项经编辑接口指定负责人 → claim 语义
  st.updateShopping(sh.id, { assignee: '奶奶' });
  assert.equal(st.getShopping(sh.id).status, 'claimed');
  assert.equal(st.getShopping(sh.id).assignee, '奶奶');
  const actions = st.auditEntries().map(e => e.action);
  assert.ok(actions.includes('shopping.claim'));
});

test('取消认领：已认领 → 待认领，清空负责人；重复取消返回 false', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '豆腐', assignee: '妈妈' });
  assert.equal(st.releaseShopping(sh.id), true);
  const now = st.getShopping(sh.id);
  assert.equal(now.status, 'unclaimed');
  assert.equal(now.assignee, undefined);
  assert.equal(now.claimedAt, undefined);
  assert.equal(st.releaseShopping(sh.id), false);
});

test('编辑表单改负责人：认领/转交/取消认领各自写入对应流水，且不重复写 update', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '鸡蛋', qty: '1 板' });
  st.updateShopping(sh.id, { assignee: '妈妈' });
  st.updateShopping(sh.id, { assignee: '爸爸' });
  st.updateShopping(sh.id, { assignee: '' });
  assert.equal(st.getShopping(sh.id).status, 'unclaimed');
  const entries = st.auditEntries().filter(e => String(e.detail.shoppingId) === sh.id);
  const acts = entries.map(e => e.action);
  assert.deepEqual(acts.filter(a => a !== 'shopping.add'),
    ['shopping.release', 'shopping.transfer', 'shopping.claim']); // 倒序：最新在前
  const transfer = entries.find(e => e.action === 'shopping.transfer');
  assert.equal(transfer.detail.from, '妈妈');
  assert.equal(transfer.detail.to, '爸爸');
  assert.equal(acts.filter(a => a === 'shopping.update').length, 0, '数量备注未改，不应写 update 流水');
  // 改数量仍写 update
  st.updateShopping(sh.id, { qty: '2 板' });
  assert.ok(st.auditEntries().some(e => e.action === 'shopping.update'));
});

test('已购买项的负责人不被编辑改动', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '牛奶', assignee: '妈妈' });
  const it = st.addItem(MILK);
  st.completeShopping(sh.id, it.id);
  st.updateShopping(sh.id, { assignee: '爸爸' });
  assert.equal(st.getShopping(sh.id).assignee, '妈妈');
  assert.equal(st.getShopping(sh.id).status, 'done');
});

test('completeShopping：待认领/已认领均可完成并关联新库存', () => {
  const st = Storage.createStore(memBackend());
  const a = st.addShopping({ name: '酸奶 A', categoryId: 'yogurt' });
  const b = st.addShopping({ name: '酸奶 B', categoryId: 'yogurt', assignee: '妈妈' });
  const it1 = st.addItem(MILK);
  assert.equal(st.completeShopping(a.id, it1.id), true);
  const it2 = st.addItem(Object.assign({}, MILK, { name: '酸奶 B' }));
  assert.equal(st.completeShopping(b.id, it2.id), true);
  const done = st.listShopping('done');
  assert.equal(done.length, 2);
  const bDone = done.find(s => s.id === b.id);
  assert.equal(bDone.itemId, it2.id);
  assert.equal(bDone.assignee, '妈妈', '完成后保留负责人信息');
  // 完成后不能重复完成
  assert.equal(st.completeShopping(a.id, it1.id), false);
  // 待办列表清空
  assert.equal(st.listShopping('open').length, 0);
});

test('取消录入场景：不调用 completeShopping，状态完整保留', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '黄瓜', qty: '3 根', assignee: '爸爸' });
  assert.equal(st.getShopping(sh.id).status, 'claimed');
  const rows = st.listShopping('claimed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, '3 根');
  assert.equal(rows[0].itemId, undefined);
});

test('编辑待购项只改名称/分类/数量/备注，不改状态与来源', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '菠菜', qty: '1 斤' }, 'manual');
  st.updateShopping(sh.id, { qty: '3 斤', note: '补铁' });
  const again = st.getShopping(sh.id);
  assert.equal(again.qty, '3 斤');
  assert.equal(again.note, '补铁');
  assert.equal(again.status, 'unclaimed');
  assert.equal(again.source, 'manual');
});

test('删除待购项：removeShopping 后列表不再包含', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '豆腐' });
  assert.equal(st.removeShopping(sh.id), true);
  assert.equal(st.getShopping(sh.id), null);
  assert.equal(st.removeShopping(sh.id), false);
});

test('排序：待办在前（待认领先于已认领，新的在前）；已购买按完成时间倒序', () => {
  const st = Storage.createStore(memBackend());
  const a = st.addShopping({ name: 'A' });
  const b = st.addShopping({ name: 'B', assignee: '妈妈' });
  const c = st.addShopping({ name: 'C' });
  const it = st.addItem(MILK);
  st.completeShopping(a.id, it.id);
  const all = st.listShopping();
  assert.equal(all[0].name, 'C', '待认领最新的排最前');
  assert.equal(all[1].status, 'claimed');
  assert.equal(all[2].status, 'done');
  // open 筛选只含未完成
  assert.deepEqual(st.listShopping('open').map(s => s.name), ['C', 'B']);
});

test('家庭成员名单：按最近认领收集负责人，去重', () => {
  const st = Storage.createStore(memBackend());
  st.addShopping({ name: '1', assignee: '妈妈' });
  st.addShopping({ name: '2', assignee: '爸爸' });
  st.addShopping({ name: '3', assignee: '妈妈' });
  st.addShopping({ name: '4' }); // 待认领不入名单
  const members = st.listShopMembers();
  assert.ok(members.includes('妈妈'));
  assert.ok(members.includes('爸爸'));
  assert.equal(new Set(members).size, members.length, '名单去重');
});

test('认领/转交/取消认领/完成都会写审计流水', () => {
  const st = Storage.createStore(memBackend());
  const sh = st.addShopping({ name: '酸奶', qty: '1 排', note: '无糖' }, 'discard');
  st.claimShopping(sh.id, '妈妈');
  st.transferShopping(sh.id, '爸爸');
  st.releaseShopping(sh.id);
  st.claimShopping(sh.id, '爸爸');
  const it = st.addItem(MILK);
  st.completeShopping(sh.id, it.id);
  const entries = st.auditEntries().filter(e => String(e.detail.shoppingId) === sh.id);
  const actions = entries.map(e => e.action);
  ['shopping.add', 'shopping.claim', 'shopping.transfer', 'shopping.release', 'shopping.complete']
    .forEach(a => assert.ok(actions.includes(a), '缺少流水：' + a));
  const addEntry = entries.find(e => e.action === 'shopping.add');
  assert.equal(addEntry.detail.qty, '1 排');
  assert.equal(addEntry.detail.source, 'discard');
  const claimEntry = entries.filter(e => e.action === 'shopping.claim').pop();
  assert.equal(claimEntry.detail.to, '妈妈');
  assert.equal(claimEntry.detail.from, null);
  const doneEntry = entries.find(e => e.action === 'shopping.complete');
  assert.equal(doneEntry.detail.itemId, it.id);
});

test('待购随导出/合并导入往返：三态与负责人保留，重复 ID 拒绝', () => {
  const st = Storage.createStore(memBackend());
  st.addShopping({ name: '菠菜', qty: '2 斤' });
  st.addShopping({ name: '牛肉', qty: '1 斤', assignee: '爸爸' });
  const text = st.exportJSON();

  const st2 = Storage.createStore(memBackend());
  const r = st2.importJSON(text, true);
  assert.equal(r.shopping, 2);
  assert.equal(st2.listShopping('unclaimed')[0].qty, '2 斤');
  assert.equal(st2.listShopping('claimed')[0].assignee, '爸爸');
  // 重复 ID 再导一次：整体拒绝
  assert.throws(() => st2.importJSON(text, true), /ID/);
});

test('导入 shopping 畸形结构被严格拒绝，已有数据不变', () => {
  const st = Storage.createStore(memBackend());
  st.addShopping({ name: '原有待购', qty: '' });
  assert.throws(() => st.importJSON({ items: [], shopping: 'not-array' }, true), /shopping/);
  assert.throws(() => st.importJSON({ items: [], shopping: [{ qty: '2 斤' }] }, true), /名称/);
  assert.throws(() => st.importJSON({ items: [], shopping: [{ name: '坏状态', status: 'weird' }] }, true), /状态非法/);
  assert.equal(st.listShopping('open').length, 1);
});

test('历史数据迁移：旧 pending 归一化为 unclaimed；claimed 缺负责人退回待认领', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [],
    shopping: [
      { id: 's1', name: '旧版待购', status: 'pending' },
      { id: 's2', name: '已认领', status: 'claimed', assignee: '妈妈' },
      { id: 's3', name: '残缺认领', status: 'claimed' },
      { id: 's4', name: '已买到但缺 completedAt', status: 'done' }
    ],
    audit: []
  }));
  const st = Storage.createStore(b);
  const rows = st.listShopping();
  assert.equal(rows.length, 4);
  assert.equal(st.getShopping('s1').status, 'unclaimed');
  assert.equal(st.getShopping('s2').assignee, '妈妈');
  assert.equal(st.getShopping('s3').status, 'unclaimed', 'claimed 无负责人退回待认领');
  const done = rows.find(r => r.id === 's4');
  assert.equal(done.status, 'done');
  assert.ok(done.completedAt, '缺失的完成时间归一化为创建时间');
});

test('加载历史脏数据：畸形待购宽松跳过，合法待购保留', () => {
  const b = memBackend();
  b.setItem('freshkeeper:v1', JSON.stringify({
    items: [],
    shopping: [
      { id: 's1', name: '好待购', status: 'unclaimed' },
      { id: 's2' },                       // 缺名称：跳过
      '字符串'
    ],
    audit: []
  }));
  const st = Storage.createStore(b);
  const rows = st.listShopping();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 's1');
});

test('覆盖导入会同时替换待购清单', () => {
  const st = Storage.createStore(memBackend());
  st.addShopping({ name: '本地待购' });
  st.importJSON({ items: [Object.assign({ id: 'x1' }, MILK)],
    shopping: [{ id: 'ns1', name: '新文件待购', status: 'claimed', assignee: '妈妈' }] }, false);
  assert.equal(st.listShopping('claimed').length, 1);
  assert.equal(st.listShopping('claimed')[0].name, '新文件待购');
});
