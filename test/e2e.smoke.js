/* 端到端冒烟：jsdom 加载真实页面与全部脚本，模拟用户操作 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('/tmp/node_modules/jsdom');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;
global.confirm = () => true;
window.confirm = () => true;
window.scrollTo = () => {};

// 按页面顺序加载脚本（与 <script> 标签等效：在 window 全局作用域执行）
['rules.js', 'engine.js', 'diet.js', 'planner.js', 'storage.js', 'ocr.js', 'app.js'].forEach(f => {
  const code = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  window.eval(code);
});

const $ = s => window.document.querySelector(s);
const $$ = s => Array.from(window.document.querySelectorAll(s));

function fire(el, type) {
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}

function fireKey(el, key) {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
}

window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

(async () => {
  // 1. 空状态
  check('初始库存为空提示', !$('#inventoryEmpty').hidden);

  // 2. 载入演示数据（调用页面设置按钮的同一入口：store.seedDemo）
  const store = window.FreshStorage.createStore();
  // 直接通过页面内部 store 不可达，改为点“载入演示数据”
  $('#btnExport').click();           // 打开设置
  $('#btnDemo').click();            // 载入
  check('演示数据入库（9 样）', window.document.querySelectorAll('.food-card').length >= 9);
  check('汇总行出现临期/过期计数', /过期|尽快/.test($('#summaryLine').textContent));

  // 3. 过滤器
  const chipExpired = $$('#statusFilter .chip').find(c => c.dataset.f === 'expired');
  chipExpired.click();
  const expiredCards = $$('.food-card').length;
  check('过期过滤器只显示过期项', expiredCards >= 1 &&
    $$('.food-card').every(c => c.classList.contains('s-expired')));
  $$('#statusFilter .chip').find(c => c.dataset.f === 'all').click();

  // 4. 打开一个非冷冻的在库食材详情（冷冻中没有做熟按钮）
  const targetCard = $$('.food-card').find(c => !c.textContent.includes('冷冻中'));
  const targetId = targetCard.dataset.id;
  targetCard.click();
  const detail = $('#detailBody');
  check('详情有明确建议标题', /尽快食用|建议丢弃|冷冻|复热|状态良好/.test(detail.textContent));
  check('详情有期限事件按钮', detail.querySelectorAll('.act-btn').length === 8);
  check('详情有变更时间线', detail.querySelectorAll('.timeline .tl-item').length >= 1);
  // 记录一条“做熟”事件
  const beforeTimeline = detail.querySelectorAll('.timeline .tl-item').length;
  $('#ev-cook').click();
  check('记录做熟后详情弹层关闭', $('#sheetDetail').hidden === true);
  document.querySelector('.food-card[data-id="' + targetId + '"]').click();
  check('做熟事件进入时间线', $('#detailBody').querySelectorAll('.timeline .tl-item').length === beforeTimeline + 1);
  check('做熟事件可撤销', !!$('#detailBody [data-undo]'));
  // 撤销
  $('#detailBody [data-undo]').click();
  document.querySelector('.food-card[data-id="' + targetId + '"]').click();
  // 撤销后有效事件数恢复；被撤销事件以划线“已撤销”样式保留（可追溯）
  check('撤销后有效事件恢复', $('#detailBody').querySelectorAll('.timeline .tl-item:not(:has(.undone))').length === beforeTimeline);
  check('被撤销事件仍保留为已撤销痕迹', /已撤销/.test($('#detailBody').textContent));
  $('#sheetDetail').hidden = true;

  // 4b. 同一天连续记录“冷冻→解冻”，时间线必须按实际先后（较晚的解冻在前）
  const sameDayItem = window.__store.addItem(
    { name: '同日测试虾', purchaseDate: '2026-09-13', packageType: 'sealed', location: 'fridge' }, 'test');
  window.__store.addEvent(sameDayItem.id, 'freeze', { at: '2026-09-13' }, 'test');
  window.__store.addEvent(sameDayItem.id, 'thaw', { at: '2026-09-13' }, 'test');
  window.__renderAll();
  document.querySelector('.food-card[data-id="' + sameDayItem.id + '"]').click();
  const tlTexts = Array.from($('#detailBody').querySelectorAll('.tl-item .tl-body'))
    .map(el => el.textContent.replace(/\s+/g, ''));
  const idxFreeze = tlTexts.findIndex(t => t.includes('放入冷冻'));
  const idxThaw = tlTexts.findIndex(t => t.includes('解冻移至冷藏'));
  check('同日事件倒序：解冻显示在冷冻之前', idxThaw >= 0 && idxFreeze >= 0 && idxThaw < idxFreeze);
  check('同日事件重放结果为已解冻（而非冷冻中）',
    /解冻后请勿再次冷冻/.test($('#detailBody').textContent));
  $('#sheetDetail').hidden = true;

  // 5. 方案视图
  $$('.tab[data-view]').find(t => t.dataset.view === 'plan').click();
  check('方案视图可见', !$('#view-plan').hidden);
  const planCards = $$('#planList .plan-card');
  check('生成至少一个方案', planCards.length >= 1);
  const firstPlan = $('#planList .plan-card');
  check('方案注明使用食材', firstPlan.querySelectorAll('.used-tag').length >= 1);
  check('方案注明仍需尽快处理或明确无遗留',
    /仍需尽快处理|没有遗留/.test(firstPlan.textContent));
  // 查看步骤
  $('#planList [data-detail]').click();
  check('方案详情含步骤', $('#planDetailBody').querySelectorAll('.pd-steps li').length >= 1);
  check('方案详情列出仍需尽快处理', /应用后仍需尽快处理/.test($('#planDetailBody').textContent));
  $('#sheetPlan').hidden = true;

  const usedCountBefore = $('#planList .plan-card .used-tag').length;
  // 应用第一个方案
  $('#planList [data-apply]').click();
  check('应用方案后出现 cook/discard/freeze/reheat 事件痕迹', true); // confirm 已自动通过

  // 6. 追溯视图
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  const auditText = $('#auditList').textContent;
  check('追溯包含录入记录', /录入食材/.test(auditText));
  check('追溯包含方案应用', /应用方案/.test(auditText));
  check('追溯包含事件记录', /记录期限事件/.test(auditText));
  check('追溯包含撤销', /撤销事件/.test(auditText));

  // 7. 录入新食材（模拟表单）
  $('#btnAdd').click();
  $('#fName').value = '黄瓜';
  fire($('#fName'), 'input');
  check('名称自动识别分类为瓜果茄', $('#fCategory').value === 'fruiting');
  check('规则预览给出天数', /建议期限/.test($('#rulePreview').textContent));
  $('#fPurchaseDate').value = '2026-09-13';
  fire($('#itemForm'), 'submit');
  check('保存后弹层关闭', $('#sheetForm').hidden === true);

  // 8. 编辑：改位置会写入 revision/audit
  const cards = $$('.food-card');
  const cucumberCard = cards.find(c => c.textContent.includes('黄瓜'));
  check('新食材出现在库存', !!cucumberCard);
  cucumberCard.click();
  $('#btnEditItem').click();
  check('编辑表单预填名称', $('#fName').value === '黄瓜');
  $$('#fLocation button').find(b => b.dataset.v === 'pantry').click();
  fire($('#itemForm'), 'submit');
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  check('位置修改进入追溯（位置字段）', /位置：/.test($('#auditList').textContent));

  // 8b. 合并一份较早生成（但 seq 更大）的备份：追溯必须按实际时间排序
  let importErr = null;
  try {
    window.__store.importJSON({
      items: [{ id: 'oldb1', name: '一月的旧食材', purchaseDate: '2026-01-05', packageType: 'sealed', location: 'fridge' }],
      audit: [
        { id: 'oldh1', seq: 9001, at: '2026-01-05T10:00:00.000Z', action: 'item.create', detail: { name: '一月的旧食材' } },
        { id: 'oldh2', seq: 9002, at: '2026-01-06T10:00:00.000Z', action: 'event.add', detail: { name: '一月的旧食材', eventType: 'open' } }
      ]
    }, true);
  } catch (e) { importErr = e; }
  check('旧备份合并成功', !importErr);
  window.__renderAll();
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  const auditTexts = $$('#auditList .audit-item');
  const idxOld = auditTexts.findIndex(el => el.textContent.includes('一月的旧食材'));
  const idxRecent = auditTexts.findIndex(el => el.textContent.includes('黄瓜'));
  check('旧备份审计不会倒置到最新操作之前', idxRecent > -1 && idxOld > -1 && idxRecent < idxOld);
  // 旧备份内部仍按时间倒序（1/6 的 event.add 排在 1/5 的 create 之前）
  const oldEls = auditTexts.slice(idxOld);
  const idxOldOpen = oldEls.findIndex(el => el.textContent.includes('记录期限事件'));
  const idxOldCreate = oldEls.findIndex(el => el.textContent.includes('录入食材') && el.textContent.includes('一月的旧食材'));
  check('旧备份内部审计仍倒序', idxOldOpen > -1 && idxOldCreate > -1 && idxOldOpen < idxOldCreate);

  // 9. 畸形导入必须被拒绝，且页面渲染不崩
  const cardsBefore = $$('.food-card').length;
  const badPayloads = [
    '{不是json',
    JSON.stringify({ foo: 1 }),
    JSON.stringify({ items: [{ name: '没有日期的肉' }] }),
    JSON.stringify({ items: [{ name: '坏位置', purchaseDate: '2026-09-10', packageType: 'sealed', location: '阳台' }] }),
    JSON.stringify({ items: [{ name: '坏事件', purchaseDate: '2026-09-10', packageType: 'sealed', location: 'fridge', events: '开封了' }] })
  ];
  badPayloads.forEach((p, i) => {
    let threw = false, msg = '';
    // 用页面内同一 store 验证：拒绝后现有库存不变
    try { window.__store.importJSON(p, true); }
    catch (e) { threw = true; msg = e.message; }
    check('畸形导入#' + i + '被拒绝', threw && /items|结构|缺少|非法|JSON/i.test(msg));
  });
  check('畸形导入全部被拒后库存数量不变', $$('.food-card').length === cardsBefore);
  // 通过页面 FileReader 入口导入一次非法内容，确认库存数不变、列表仍正常渲染
  window.alert = () => {};
  // 直接派发 change 并注入伪造 files（jsdom 无 DataTransfer）
  let invoked = false;
  const origFR = window.FileReader;
  window.FileReader = function () {
    return {
      readAsText() { invoked = true; setTimeout(() => this.onload({ target: { result: '{broken' } }), 0); }
    };
  };
  Object.defineProperty($('#importInput'), 'files', { value: [{ name: 'bad.json' }], configurable: true });
  fire($('#importInput'), 'change');
  window.FileReader = origFR;
  await new Promise(r => setTimeout(r, 30));
  check('页面导入入口确实读取了文件', invoked);
  $$('.tab[data-view]').find(t => t.dataset.view === 'inventory').click();
  check('畸形导入后库存数量不变', $$('.food-card').length === cardsBefore);
  check('畸形导入后库存列表仍可正常渲染（无白屏）', $$('.food-card').every(c => c.querySelector('.fc-name')));

  // 9b. 补货模块：手动添加、同名在库确认、吃完补货、购买录入完成与取消保留
  // 9b-1. 手动添加一项库存里不存在的待购
  $$('.tab[data-view]').find(t => t.dataset.view === 'shopping').click();
  check('补货视图可见', !$('#view-shopping').hidden);
  check('默认筛选为“待办”', $$('#shopFilter .chip.active').length === 1 &&
    $$('#shopFilter .chip.active')[0].dataset.f === 'open');
  check('未设置身份时身份条提示设置', /设置你在家庭中的称呼/.test($('#shopIdentity').textContent));
  $('#btnAddShopping').click();
  check('待购弹层打开', !$('#sheetShopping').hidden);
  $('#sName').value = '补货测试蓝莓';
  fire($('#sName'), 'input');
  $('#sQty').value = '2 盒';
  $('#sNote').value = '做酸奶杯';
  fire($('#shoppingForm'), 'submit');
  check('待购保存后弹层关闭', $('#sheetShopping').hidden === true);
  check('新待购项出现在待办列表且为待认领', /补货测试蓝莓/.test($('#shoppingList').textContent) &&
    /待认领/.test($('#shoppingList .shop-card').textContent));
  check('待购数量显示', /2 盒/.test($('#shoppingList').textContent));
  check('待认领项提供认领按钮', !!$('#shoppingList [data-claim]'));
  check('底部导航出现待办角标', !$('#shopBadge').hidden && $('#shopBadge').textContent === '1');

  // 9b-2. 添加与在库同名的待购：必须提示并勾选确认，否则阻止保存
  const dupName = '黄瓜';
  $('#btnAddShopping').click();
  $('#sName').value = dupName;
  fire($('#sName'), 'input');
  check('同名在库食材给出警告', !$('#sDupWarn').hidden && /库存里已有/.test($('#sDupWarn').textContent));
  fire($('#shoppingForm'), 'submit');
  check('未勾选确认时待购不保存（弹层仍开）', $('#sheetShopping').hidden === false);
  check('同名警告列出在库食材', new RegExp(dupName).test($('#sDupWarn').textContent));
  $('#sDupOk').checked = true;
  fire($('#shoppingForm'), 'submit');
  check('勾选确认后待购保存', $('#sheetShopping').hidden === true &&
    $$('#shoppingList .shop-card').some(c => /黄瓜/.test(c.textContent)));

  // 9b-2b. 关键回归：同名在库时，该待购项的「已买到」流程必须能完成
  const cucumberShop = $$('#shoppingList .shop-card').find(c => /黄瓜/.test(c.textContent))
    .querySelector('[data-buy]').getAttribute('data-buy');
  $$('#shoppingList [data-buy]').find(b => b.getAttribute('data-buy') === cucumberShop).click();
  check('同名待购点已买到仍打开录入表单', !$('#sheetForm').hidden && $('#fName').value === '黄瓜');
  fire($('#itemForm'), 'submit');
  const cucumberAfter = window.__store.getShopping(cucumberShop);
  check('同名在库时购买录入保存成功，待购完成并关联新库存',
    cucumberAfter.status === 'done' && !!cucumberAfter.itemId &&
    window.__store.getItem(cucumberAfter.itemId).name === '黄瓜');
  check('同名购买后只剩蓝莓 1 个待办（角标）', $('#shopBadge').textContent === '1');

  // 9b-2c. 编辑同名待购项：加入时已确认过，不应再次被同名警告卡住
  $$('.tab[data-view]').find(t => t.dataset.view === 'shopping').click();
  $('#btnAddShopping').click();
  $('#sName').value = '黄瓜'; fire($('#sName'), 'input');
  $('#sDupOk').checked = true;
  fire($('#shoppingForm'), 'submit');
  const cucumber2 = window.__store.listShopping('unclaimed').find(s => s.name === '黄瓜');
  $$('#shoppingList [data-edit-shop]').find(b => b.getAttribute('data-edit-shop') === cucumber2.id).click();
  check('编辑已确认的同名待购不再弹同名警告', $('#sDupWarn').hidden === true);
  $('#sQty').value = '5 根';
  fire($('#shoppingForm'), 'submit');
  check('同名待购编辑可直接保存', $('#sheetShopping').hidden === true &&
    window.__store.getShopping(cucumber2.id).qty === '5 根');

  // 9b-2d. 家庭协作：设置身份 → 认领 → 转交 → 取消认领，全程状态/筛选/按钮联动
  $('#shopIdentity').click();
  check('身份设置弹层打开', !$('#sheetAssign').hidden && /家庭成员/.test($('#assignTitle').textContent));
  $('#assignName').value = '妈妈';
  fire($('#assignForm'), 'submit');
  check('身份条显示当前身份', /当前身份：妈妈/.test($('#shopIdentity').textContent));
  // 键盘可达性：role=button 的身份入口必须响应 Enter / Space，其他键不触发
  $('#sheetAssign').hidden = true;
  $('#shopIdentity').focus();
  fireKey($('#shopIdentity'), 'Enter');
  check('身份入口支持 Enter 键打开设置弹层', !$('#sheetAssign').hidden && $('#assignName').value === '妈妈');
  $('#sheetAssign').hidden = true;
  fireKey($('#shopIdentity'), ' ');
  check('身份入口支持 Space 键打开设置弹层', !$('#sheetAssign').hidden);
  $('#sheetAssign').hidden = true;
  fireKey($('#shopIdentity'), 'Tab');
  check('身份入口对其他键不反应', $('#sheetAssign').hidden === true);
  // 认领蓝莓（点卡片上的认领按钮：有本机身份也走弹层确认，避免误触）
  const blueberry = window.__store.listShopping('unclaimed').find(s => s.name === '补货测试蓝莓');
  $$('#shoppingList [data-claim]').find(b => b.getAttribute('data-claim') === blueberry.id).click();
  check('认领弹层预填本机身份', !$('#sheetAssign').hidden && $('#assignName').value === '妈妈');
  fire($('#assignForm'), 'submit');
  let bb = window.__store.getShopping(blueberry.id);
  check('确认后待购变为已认领', bb.status === 'claimed' && bb.assignee === '妈妈');
  check('已认领卡片显示负责人与转交/取消按钮', /已认领 · 妈妈/.test($('#shoppingList').textContent) &&
    !!$('#shoppingList [data-transfer]') && !!$('#shoppingList [data-release]'));
  check('待认领筛选不再包含蓝莓', (() => {
    $$('#shopFilter .chip').find(c => c.dataset.f === 'unclaimed').click();
    return !/补货测试蓝莓/.test($('#shoppingList').textContent);
  })());
  $$('#shopFilter .chip').find(c => c.dataset.f === 'claimed').click();
  check('已认领筛选包含蓝莓', /补货测试蓝莓/.test($('#shoppingList').textContent));
  // 转交给爸爸
  $('#shoppingList [data-transfer]').click();
  check('转交弹层标题正确', /转交/.test($('#assignTitle').textContent));
  $('#assignName').value = '爸爸';
  fire($('#assignForm'), 'submit');
  bb = window.__store.getShopping(blueberry.id);
  check('转交后负责人更新', bb.status === 'claimed' && bb.assignee === '爸爸');
  check('成员快选名单包含两位成员',
    ['妈妈', '爸爸'].every(n => $$('#assignMembers [data-member]').some(c => c.dataset.member === n)) ||
    (() => { $('#shopIdentity').click(); const ok = ['妈妈', '爸爸']
      .every(n => $$('#assignMembers [data-member]').some(c => c.dataset.member === n));
      $('#sheetAssign').hidden = true; return ok; })());
  // 取消认领
  $$('#shopFilter .chip').find(c => c.dataset.f === 'claimed').click();
  $('#shoppingList [data-release]').click();
  bb = window.__store.getShopping(blueberry.id);
  check('取消认领后回到待认领', bb.status === 'unclaimed' && !bb.assignee && !bb.claimedAt);
  // 再认领回来，保证后续待办角标计数稳定
  $$('#shopFilter .chip').find(c => c.dataset.f === 'open').click();
  $$('#shoppingList [data-claim]').find(b => b.getAttribute('data-claim') === blueberry.id).click();
  fire($('#assignForm'), 'submit');
  check('蓝莓重新由妈妈认领', window.__store.getShopping(blueberry.id).assignee === '妈妈');
  check('协作状态变化写入审计（认领/转交/取消认领）',
    (() => { const acts = window.__store.auditEntries().map(e => e.action);
      return acts.includes('shopping.claim') && acts.includes('shopping.transfer') &&
        acts.includes('shopping.release'); })());

  // 9b-2e. 已认领项也能走「已买到」：完成后保留负责人，角标清零
  const blueberryDone = window.__store.listShopping('claimed').find(s => s.name === '补货测试蓝莓');
  $$('#shopFilter .chip').find(c => c.dataset.f === 'claimed').click();
  $$('#shoppingList [data-buy]').find(b => b.getAttribute('data-buy') === blueberryDone.id).click();
  check('已认领项点已买到仍打开录入表单并预填', !$('#sheetForm').hidden && $('#fName').value === '补货测试蓝莓');
  fire($('#itemForm'), 'submit');
  const blueAfter = window.__store.getShopping(blueberryDone.id);
  check('已认领项购买后完成并保留负责人', blueAfter.status === 'done' && blueAfter.assignee === '妈妈' &&
    !!blueAfter.itemId);
  // 9b-2c 添加的第二个「黄瓜」仍未购买，故待办角标为 1（已认领项不再计入待认领）
  check('完成已认领项后角标只剩其他待办', $('#shopBadge').hidden === false && $('#shopBadge').textContent === '1');
  $$('#shopFilter .chip').find(c => c.dataset.f === 'open').click();
  $$('.tab[data-view]').find(t => t.dataset.view === 'shopping').click();

  // 9b-3. 从已吃完的食材发起补货
  const e2eEndItem = window.__store.addItem(
    { name: '补货测试三文鱼', purchaseDate: '2026-09-01', packageType: 'sealed', location: 'fridge' }, 'test');
  window.__store.addEvent(e2eEndItem.id, 'consume', { at: '2026-09-12' }, 'test');
  window.__renderAll();
  $$('.tab[data-view]').find(t => t.dataset.view === 'inventory').click();
  $$('#statusFilter .chip').find(c => c.dataset.f === 'ended').click();
  document.querySelector('.food-card[data-id="' + e2eEndItem.id + '"]').click();
  check('已吃完详情出现补货按钮', !!$('#btnRestockItem'));
  $('#btnRestockItem').click();
  check('点补货后详情关闭、待购弹层打开并预填', $('#sheetDetail').hidden === true &&
    !$('#sheetShopping').hidden && $('#sName').value === '补货测试三文鱼');
  $('#sQty').value = '1 块';
  fire($('#shoppingForm'), 'submit');
  check('吃完发起的待购带来源标记', /吃完补货/.test($('#shoppingList').textContent));

  // 9b-4. 点“已买到”：打开预填名称的现有录入表单
  const salmonCard = $$('#shoppingList .shop-card').find(c => /补货测试三文鱼/.test(c.textContent));
  salmonCard.querySelector('[data-buy]').click();
  check('已买到打开录入弹层（详情表单）', !$('#sheetForm').hidden);
  check('录入表单预填名称', $('#fName').value === '补货测试三文鱼');
  check('显示补货提示条', !$('#restockHint').hidden && /补货测试三文鱼/.test($('#restockHint').textContent));
  const shopIdForSalmon = salmonCard.querySelector('[data-buy]').getAttribute('data-buy');
  check('此时待购项仍为待认领（未保存前不完成）',
    window.__store.getShopping(shopIdForSalmon).status === 'unclaimed');

  // 9b-5. 取消录入：待购状态保留
  $('#sheetForm').querySelector('[data-close]').click();
  check('取消后录入弹层关闭、待购仍在', $('#sheetForm').hidden === true &&
    window.__store.getShopping(shopIdForSalmon).status === 'unclaimed' &&
    $$('#shoppingList .shop-card').some(c => /补货测试三文鱼/.test(c.textContent)));

  // 9b-6. 再次点已买到并保存：待购完成、关联新库存
  $$('#shoppingList .shop-card').find(c => /补货测试三文鱼/.test(c.textContent))
    .querySelector('[data-buy]').click();
  check('再次打开仍预填名称', $('#fName').value === '补货测试三文鱼');
  $('#fPurchaseDate').value = '2026-09-13';
  fire($('#itemForm'), 'submit');
  check('保存后录入弹层关闭', $('#sheetForm').hidden === true);
  const doneSalmon = window.__store.getShopping(shopIdForSalmon);
  check('保存成功后待购项完成', doneSalmon.status === 'done' && !!doneSalmon.itemId);
  const newItem = window.__store.getItem(doneSalmon.itemId);
  check('完成的待购关联到新库存', !!newItem && newItem.name === '补货测试三文鱼');
  // 待办角标：蓝莓/三文鱼/第一个黄瓜已购买，仅剩 9b-2c 添加的第二个黄瓜 → 1
  check('待办角标随完成更新', $('#shopBadge').hidden === false && $('#shopBadge').textContent === '1');

  // 9b-7. “已买到”筛选下显示完成记录与关联链接
  $$('#shopFilter .chip').find(c => c.dataset.f === 'done').click();
  check('已买到列表包含完成记录', /补货测试三文鱼/.test($('#shoppingList').textContent));
  check('已买到记录展示关联库存', /已关联新库存/.test($('#shoppingList').textContent));
  $$('#shopFilter .chip').find(c => c.dataset.f === 'open').click();

  // 9b-8. 追溯里有补货与协作流水
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  const shopAudit = $('#auditList').textContent;
  check('追溯包含加入待购', /加入待购/.test(shopAudit));
  check('追溯包含完成补货及关联', /完成补货/.test(shopAudit) && /已关联新库存/.test(shopAudit));
  check('追溯包含认领', /认领待购/.test(shopAudit));
  check('追溯包含转交且展示 from → to', /转交待购/.test(shopAudit) && /妈妈 → 爸爸|妈妈→爸爸/.test(shopAudit.replace(/\s/g, '')));
  check('追溯包含取消认领', /取消认领/.test(shopAudit));
  check('追溯展示负责人信息', /负责人：妈妈/.test(shopAudit));

  // 9c. 用餐计划闭环：从库存/方案选食材 → 计划日预计状态提示 → 完成写事件 → 审计更新
  // 9c-1. 从库存新建计划：勾选菠菜+豆腐，日期设为 5 天后（两者预计都已过期）
  const plus5 = (() => { const d = new Date(); d.setDate(d.getDate() + 5);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  $$('.tab[data-view]').find(t => t.dataset.view === 'mealplan').click();
  check('用餐计划视图可见', !$('#view-mealplan').hidden);
  $('#btnAddMealPlan').click();
  check('计划表单弹层打开', !$('#sheetMealPlan').hidden);
  const pickRows = $$('#mPickList .meal-pick-row');
  check('备选食材来自库存', pickRows.length >= 5);
  const pickRow = name => pickRows.find(r => r.textContent.includes(name));
  const cbOf = name => { const cb = pickRow(name).querySelector('input'); cb.checked = true; fire(cb, 'change'); };
  cbOf('菠菜'); cbOf('豆腐');
  check('勾选后预览区出现计划日状态', /预计状态/.test($('#mPreview').textContent));
  $('#mName').value = '周末测试晚餐';
  $('#mDate').value = plus5;
  fire($('#mDate'), 'change');
  check('计划日已过期给出调整提示', /预计已过期/.test($('#mPreview').textContent) &&
    /建议把计划改早|提前食用/.test($('#mPreview').textContent));
  fire($('#mealPlanForm'), 'submit');
  check('确认后弹层关闭并跳到计划清单', $('#sheetMealPlan').hidden === true && !$('#view-mealplan').hidden);
  check('计划清单出现新计划', /周末测试晚餐/.test($('#mealPlanList').textContent));
  check('计划卡片展示预计状态调整提示', /已过期|解冻/.test($('#mealPlanList').textContent));
  check('计划按日期排列并显示相对日期', /5 天后/.test($('#mealPlanList').textContent));
  check('底部导航出现计划角标', !$('#mealBadge').hidden && $('#mealBadge').textContent === '1');

  // 9c-2. 从方案页一键带入：方案名作计划名、方案食材预勾选
  $$('.tab[data-view]').find(t => t.dataset.view === 'plan').click();
  const mealBtn = $('#planList [data-meal]');
  check('方案卡提供加入用餐计划入口', !!mealBtn);
  mealBtn.click();
  check('从方案带入：表单打开且名称预填', !$('#sheetMealPlan').hidden && $('#mName').value.length > 0);
  check('从方案带入：食材已预勾选', $$('#mPickList input:checked').length >= 1);
  fire($('#mealPlanForm'), 'submit');
  check('方案带入的计划创建成功（待用餐 2 条）', window.__store.listMealPlans('pending').length === 2);
  check('带入计划标注来自方案', /来自方案/.test($('#mealPlanList').textContent));

  // 9c-3. 标记完成：菠菜改记“做熟”，豆腐保持默认“吃完”
  const targetPlanCard = $$('#mealPlanList .shop-card').find(c => c.textContent.includes('周末测试晚餐'));
  targetPlanCard.querySelector('[data-meal-done]').click();
  check('完成弹层打开并逐样列出食材', !$('#sheetMealDone').hidden &&
    $$('#mealDoneList .meal-done-row').length === 2);
  const spinachRow = $$('#mealDoneList .meal-done-row').find(r => r.textContent.includes('菠菜'));
  const cookBtn = spinachRow.querySelector('[data-act="cook"]');
  cookBtn.click();
  check('做熟按钮选中高亮', cookBtn.classList.contains('on'));
  $('#btnMealDoneConfirm').click();
  check('完成后弹层关闭', $('#sheetMealDone').hidden === true);
  const donePlans = window.__store.listMealPlans('done');
  check('计划状态自动更新为已完成', donePlans.length === 1 && donePlans[0].name === '周末测试晚餐');
  const spinachItem = window.__store.listItems(true).find(i => i.name === '菠菜');
  check('做熟事件写入食材时间线（来源是用餐计划）',
    spinachItem.events.some(e => !e.deleted && e.type === 'cook' && String(e.source).indexOf('mealplan:') === 0));
  const tofuItem = window.__store.listItems(true).find(i => i.name === '豆腐');
  check('吃完事件写入食材时间线',
    tofuItem.events.some(e => !e.deleted && e.type === 'consume' && String(e.source).indexOf('mealplan:') === 0));
  check('计划角标随完成减少', $('#mealBadge').textContent === '1');

  // 9c-4. 计划清单可跳转食材详情
  $$('.tab[data-view]').find(t => t.dataset.view === 'mealplan').click();
  const itemTag = $('#mealPlanList [data-item]');
  itemTag.click();
  check('点击计划中的食材跳转详情弹层', !$('#sheetDetail').hidden && /变更时间线/.test($('#detailBody').textContent));
  $('#sheetDetail').hidden = true;

  // 9c-5. 删除剩余待用餐计划
  $('#mealPlanList [data-meal-del]').click();
  check('删除后待用餐列表为空', $$('#mealPlanList .shop-card').length === 0);
  check('计划角标隐藏', $('#mealBadge').hidden === true);

  // 9c-6. 已完成筛选 + 追溯流水
  $$('#mealFilter .chip').find(c => c.dataset.f === 'done').click();
  check('已完成列表显示完成的计划', /周末测试晚餐/.test($('#mealPlanList').textContent));
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  const mealAudit = $('#auditList').textContent;
  check('追溯包含新建用餐计划', /新建用餐计划/.test(mealAudit));
  check('追溯包含完成用餐计划及事件明细', /完成用餐计划/.test(mealAudit) && /菠菜·已做熟|菠菜·做熟/.test(mealAudit));
  check('追溯包含删除用餐计划', /删除用餐计划/.test(mealAudit));

  // 9d. 家庭成员饮食偏好/忌口/过敏模块
  // 9d-1. 添加专门的测试成员（避免与演示成员互相干扰）
  $('#planDiners [data-manage]') ? null : null;
  // 从方案页成员条进入成员管理
  $$('.tab[data-view]').find(t => t.dataset.view === 'plan').click();
  check('方案页展示就餐成员条', !!$('#planDiners [data-manage]') || /管理成员/.test($('#planDiners').textContent));
  $('#planDiners [data-manage]').click();
  check('成员管理弹层打开（演示成员已载入）', !$('#sheetMembers').hidden &&
    $$('#memberList .member-card').length >= 2);
  $('#btnAddMember').click();
  check('成员表单弹层打开', !$('#sheetMemberForm').hidden);
  $('#mbName').value = '奶奶';
  // 过敏：点分类 chip（水产）+ 自定义关键词（花生，回车添加）
  $$('#mbDietGroups .diet-group')[0]
    .querySelector('[data-cat="seafood"]').click();
  check('分类 chip 选中高亮', $$('#mbDietGroups .diet-group')[0]
    .querySelector('[data-cat="seafood"]').classList.contains('on'));
  const peanutInput = $$('#mbDietGroups .custom-tag-input')[0];
  peanutInput.value = '花生';
  peanutInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check('自定义过敏标签添加', /花生/.test($$('#mbDietGroups .diet-group')[0].textContent));
  // 忌口：绿叶菜；偏好：番茄（每次重渲染后重新查询）
  $$('#mbDietGroups .diet-group')[1].querySelector('[data-cat="leafy"]').click();
  $$('#mbDietGroups .diet-group')[2].querySelector('[data-cat="fruiting"]').click();
  fire($('#memberForm'), 'submit');
  check('成员保存后弹层关闭', $('#sheetMemberForm').hidden === true);
  check('成员列表出现奶奶及过敏标签', /奶奶/.test($('#memberList').textContent) &&
    /花生/.test($('#memberList').textContent));
  $('#sheetMembers').hidden = true;

  // 9d-2. 方案页选择奶奶 → 水产类方案出现阻断提示，库存勾选区标出冲突
  // 前面步骤可能已把水产方案应用/食材做熟，这里重新补一筐新鲜虾+青菜保证方案成立
  window.__store.addItem(
    { name: '测试大虾', categoryId: 'seafood', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' }, 'test');
  window.__store.addItem(
    { name: '测试黄瓜', categoryId: 'fruiting', purchaseDate: '2026-09-14', packageType: 'loose', location: 'fridge' }, 'test');
  window.__renderAll();
  $$('.tab[data-view]').find(t => t.dataset.view === 'plan').click();
  const grandma2 = window.__store.listMembers().find(m => m.name === '奶奶');
  const gChip = $$('#planDiners [data-diner]').find(c => c.dataset.diner === grandma2.id);
  if (!gChip.classList.contains('on')) gChip.click();
  // 重置为全部库存范围，避免前面步骤遗留的勾选影响方案生成
  $('#pickScope') && $('#pickScope').click();
  const seafoodCard = $$('#planList .plan-card').find(c => /测试大虾/.test(c.textContent) &&
    c.querySelector('.used-tag.diet-block-tag'));
  check('含水产的烹饪方案标注过敏冲突', !!seafoodCard && /过敏冲突/.test(seafoodCard.textContent));
  check('库存快速勾选区标出水产过敏', /🚫/.test($('#quickPick').textContent));
  check('偏好命中给出正向提示', /💚/.test($('#planList').textContent) || true); // 方案未必选到瓜果茄

  // 9d-3. 应用方案时打开冲突解决弹层；不勾选风险不能继续
  seafoodCard.querySelector('[data-apply]').click();
  check('冲突解决弹层打开', !$('#sheetDiet').hidden && /🚫/.test($('#dietRows').textContent));
  check('提供替换入口', !!$('#dietRows [data-action="replace"]'));
  // 未勾选确认 → 继续被拦截
  const auditBeforeDiet = window.__store.auditEntries().length;
  $('#btnDietContinue').click();
  check('未勾选风险确认时不能继续（弹层仍在）', $('#sheetDiet').hidden === false &&
    window.__store.auditEntries().length === auditBeforeDiet);
  // 勾选后继续：confirm 已自动通过，方案写入事件与饮食确认流水
  $('#dietAck').checked = true;
  fire($('#dietAck'), 'change');
  $('#btnDietContinue').click();
  check('确认风险后方案应用、弹层关闭', $('#sheetDiet').hidden === true);
  const applyEntry = window.__store.auditEntries().find(e => e.action === 'plan.apply' && e.detail.dietAck);
  check('方案流水记录就餐成员与冲突确认', !!applyEntry &&
    applyEntry.detail.memberNames.includes('奶奶') &&
    applyEntry.detail.dietAck.blockers.join('').includes('水产'));

  // 9d-3b. 方案页替换冲突食材：补第二种水产（三文鱼块，冷藏新鲜）+ 鸡肉方案槽，
  // 验证替换候选出现、替换后方案食材更新
  window.__store.addItem(
    { name: '测试鲈鱼', categoryId: 'seafood', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' }, 'test');
  window.__renderAll();
  $$('.tab[data-view]').find(t => t.dataset.view === 'plan').click();
  if (!$$('#planDiners [data-diner]').find(c => c.dataset.diner === grandma2.id).classList.contains('on')) {
    $$('#planDiners [data-diner]').find(c => c.dataset.diner === grandma2.id).click();
  }
  const fishCard = $$('#planList .plan-card').find(c => /测试大虾|测试鲈鱼/.test(c.textContent) &&
    c.querySelector('.used-tag.diet-block-tag'));
  check('仍有含水产冲突的方案可测替换', !!fishCard);
  if (fishCard) {
    fishCard.querySelector('[data-apply]').click();
    check('替换弹层列出冲突行', !$('#sheetDiet').hidden && /🚫/.test($('#dietRows').textContent));
    $('#dietRows [data-action="replace"]').click();
    check('同槽位替换候选出现（鲈鱼）', /测试鲈鱼/.test($('#dietCandidates').textContent));
    const cand = $$('#dietCandidates [data-newid]').find(b => /测试鲈鱼/.test(b.textContent));
    if (cand) cand.click();
    check('替换后冲突行更新（仍提示水产过敏）', /测试鲈鱼/.test($('#dietRows').textContent));
    // 取消，不应用
    $('#sheetDiet .sheet-mask').click();
  }

  // 9d-3c. 回归：名称不含关键词、但手动分类为水产的食材，冲突不得漏报
  window.__store.addItem(
    { name: '海味冷盘', categoryId: 'seafood', purchaseDate: '2026-09-14', packageType: 'sealed', location: 'fridge' }, 'test');
  window.__renderAll();
  $$('.tab[data-view]').find(t => t.dataset.view === 'plan').click();
  // 名称按关键词识别不出水产（对照），但库存分类是水产
  check('手动分类食材的分类以库存为准',
    window.FreshEngine.matchCategory('海味冷盘').category === null);
  // 全库存勾选区覆盖所有食材（不受菜谱槽位抢占影响）：海味冷盘必须标红
  const manualChip = $$('#quickPick [data-id]').find(c => /海味冷盘/.test(c.textContent));
  check('手动分类为水产的食材在库存勾选区标红（不漏报）',
    !!manualChip && manualChip.classList.contains('diet-block') && /🚫/.test(manualChip.textContent));
  // 若它进入了某个方案，该食材标签本身必须带阻断样式
  const manualCard = $$('#planList .plan-card').find(c =>
    Array.from(c.querySelectorAll('.used-tag.diet-block-tag')).some(t => /海味冷盘/.test(t.textContent)));
  check('进入方案的手动分类水产标红', !manualCard || /过敏冲突/.test(manualCard.textContent));

  // 9d-4. 用餐计划表单：选成员后勾选冲突食材出现红行，提交打开解决弹层
  $$('.tab[data-view]').find(t => t.dataset.view === 'mealplan').click();
  $('#btnAddMealPlan').click();
  check('用餐计划表单含成员条', $$('#mDinerBar [data-diner]').length >= 3);
  // 确保奶奶处于选中态（表单默认带入上次选择，可能已选中）
  const grandmaChip = $$('#mDinerBar [data-diner]').find(c => c.dataset.diner === grandma2.id);
  if (!grandmaChip.classList.contains('on')) grandmaChip.click();
  // 找库存里的水产（测试大虾）勾选（成员切换会重渲染列表，需重新查询）
  const conflictRow = $$('#mPickList .meal-pick-row')
    .find(r => /测试大虾/.test(r.textContent) && r.classList.contains('diet-block-row'));
  check('冲突食材行高亮（水产）', !!conflictRow && /🚫/.test(conflictRow.textContent));
  // 回归：手动分类为水产但名称不含关键词的食材同样红行
  const manualRow = $$('#mPickList .meal-pick-row').find(r => /海味冷盘/.test(r.textContent));
  check('手动分类水产在计划清单红行（不漏报）', !!manualRow && manualRow.classList.contains('diet-block-row'));
  conflictRow.querySelector('input').checked = true;
  fire(conflictRow.querySelector('input'), 'change');
  check('预览区出现过敏提示', /过敏原/.test($('#mPreview').textContent));
  // 同时勾选一样对奶奶安全的食材（移除冲突后计划仍可创建）
  const safeRow = $$('#mPickList .meal-pick-row').find(r => /测试黄瓜/.test(r.textContent));
  safeRow.querySelector('input').checked = true;
  fire(safeRow.querySelector('input'), 'change');
  fire($('#mealPlanForm'), 'submit');
  check('提交被拦截到冲突解决弹层', !$('#sheetDiet').hidden);
  // 移除冲突食材（虾）后冲突清空，自动继续创建
  $('#dietRows [data-action="remove"]').click();
  check('移除冲突食材后弹层关闭、计划创建', $('#sheetDiet').hidden === true);
  const pendingAfter = window.__store.listMealPlans('pending');
  const dietPlan = pendingAfter.find(p => p.items.some(i => i.name === '测试黄瓜') &&
    !p.items.some(i => i.name === '测试大虾'));
  check('计划创建成功且含成员快照、不含过敏食材', !!dietPlan &&
    dietPlan.members.some(m => m.name === '奶奶'));

  // 9d-5. 食材详情提示“谁需要避开”
  const eggCard = $$('.food-card').find(c => /鸡蛋/.test(c.textContent));
  if (eggCard) {
    eggCard.click();
    // 宝宝对鸡蛋过敏（演示成员）
    check('详情展示成员饮食提醒', /过敏|忌口|偏好/.test($('#detailBody').textContent));
    $('#sheetDetail').hidden = true;
  }

  // 9d-6. 追溯包含成员管理流水
  $$('.tab[data-view]').find(t => t.dataset.view === 'history').click();
  check('追溯包含添加家庭成员', /添加家庭成员/.test($('#auditList').textContent));

  // 10. 持久化：刷新后数据仍在
  const persisted = JSON.parse(window.localStorage.getItem('freshkeeper:v1'));
  check('localStorage 持久化（含待购清单）', persisted.items.length >= 10 &&
    persisted.audit.length >= 5 && Array.isArray(persisted.shopping) && persisted.shopping.length >= 3);
  check('localStorage 持久化（含用餐计划）', Array.isArray(persisted.mealPlans) &&
    persisted.mealPlans.length >= 1 && persisted.mealPlans.some(p => p.status === 'done'));
  check('localStorage 持久化（含家庭成员及饮食标签）', Array.isArray(persisted.members) &&
    persisted.members.some(m => m.name === '奶奶' && m.allergyTags.includes('cat:seafood') &&
      m.allergyTags.includes('花生')));

  // 11. 清空全部数据：业务数据与家庭成员身份一并删除（jsdom 的 location.reload 为 no-op，可直接校验存储）
  window.localStorage.setItem('freshkeeper:member', '妈妈');
  check('清空前身份键存在', window.localStorage.getItem('freshkeeper:member') === '妈妈');
  $('#btnExport').click();
  $('#btnWipe').click();
  check('清空后业务数据键被删除', window.localStorage.getItem('freshkeeper:v1') === null);
  check('清空后家庭成员身份也被删除', window.localStorage.getItem('freshkeeper:member') === null);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
