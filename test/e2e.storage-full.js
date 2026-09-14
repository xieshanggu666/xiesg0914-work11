/* 端到端：localStorage 写满时的保存失败提示与自救流程 */
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
// jsdom 未实现下载相关 URL API
window.URL.createObjectURL = () => 'blob:mock';
window.URL.revokeObjectURL = () => {};

['rules.js', 'engine.js', 'diet.js', 'planner.js', 'storage.js', 'ocr.js', 'app.js'].forEach(f => {
  const code = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  window.eval(code);
});

const $ = s => window.document.querySelector(s);
function fire(el, type) {
  el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
}
window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

(async () => {
  // 先正常准备几样食材（追溯流水随之产生，便于后面验证“清理历史痕迹”）
  window.__store.addItem(
    { name: '菠菜', purchaseDate: '2026-09-13', packageType: 'loose', location: 'fridge' }, 'test');
  window.__store.addItem(
    { name: '番茄', purchaseDate: '2026-09-12', packageType: 'loose', location: 'fridge' }, 'test');
  const spinach = window.__store.listItems().find(i => i.name === '菠菜');
  for (let i = 0; i < 5; i++) {
    window.__store.updateItem(spinach.id, { note: '备注第 ' + i + ' 次' });
  }
  window.__renderAll();
  const cardsBefore = window.document.querySelectorAll('.food-card').length;
  const itemsBefore = window.__store.listItems().length;
  const auditBefore = window.__store.auditEntries().length;
  check('前置：库存正常渲染', cardsBefore >= 2);

  // 模拟 localStorage 写入失败。
  // 注意 jsdom 的 setItem 解析自 Storage.prototype，给实例赋自有属性不能遮蔽，
  // 因此在原型方法上包一层：业务数据键写入按 failMode 抛错，其它键照常。
  //   quota   → QuotaExceededError（容量写满）
  //   blocked → SecurityError（无痕/隐私模式、存储被禁止，且消息不含 quota）
  const proto = Object.getPrototypeOf(window.localStorage);
  const protoSet = proto.setItem;
  let failMode = null;
  proto.setItem = function (k, v) {
    if (failMode && k === 'freshkeeper:v1') {
      if (failMode === 'quota') {
        const e = new Error("Failed to execute 'setItem' on 'Storage': quota exceeded.");
        e.name = 'QuotaExceededError';
        throw e;
      }
      const e = new Error('Failed to read or write Local Storage.');
      e.name = 'SecurityError';
      throw e;
    }
    return protoSet.call(this, k, v);
  };
  const makeQuotaFail = () => { failMode = 'quota'; };
  const makeStorageBlocked = () => { failMode = 'blocked'; };
  const restoreStorage = () => { failMode = null; };

  // 1. 录入食材时写满：必须出现明确的失败提示，表单不关闭、库存不增加
  makeQuotaFail();
  $('#btnAdd').click();
  $('#fName').value = '草莓';
  fire($('#fName'), 'input');
  $('#fPurchaseDate').value = '2026-09-14';
  fire($('#itemForm'), 'submit');

  const fullSheet = $('#sheetStorageFull');
  check('保存失败弹层出现', fullSheet.hidden === false);
  check('配额模式：标题为“存储空间已满”', /存储空间已满/.test($('#storageFullTitle').textContent));
  check('配额模式：标题不出现“不可写”', !/不可写/.test($('#storageFullTitle').textContent));
  check('弹层明确告知“没有存进浏览器”', /没有存进浏览器|存储空间已满/.test(fullSheet.textContent));
  check('弹层引导先导出备份', /导出备份/.test($('#stepsQuota').textContent));
  check('弹层引导清理历史记录', /清理历史痕迹/.test($('#stepsQuota').textContent));
  check('配额模式：展示容量步骤、隐藏不可写步骤',
    $('#stepsQuota').hidden === false && $('#stepsBlocked').hidden === true);
  check('配额模式：显示“清理历史痕迹”按钮', $('#btnStoragePrune').hidden === false);
  check('配额模式：展示数据占用分布', $('#storageStats').hidden === false &&
    /操作流水/.test($('#storageStats').textContent) && /KB|B|MB/.test($('#storageStats').textContent));
  check('录入表单保持打开（输入不丢）', $('#sheetForm').hidden === false);
  check('表单中刚输入的名称仍在', $('#fName').value === '草莓');
  check('库存条数未增加（失败已回滚）', window.__store.listItems().length === itemsBefore);
  check('追溯流水未增加（失败已回滚）', window.__store.auditEntries().length === auditBefore);
  check('界面卡片数未增加（没有“看似已保存”）',
    window.document.querySelectorAll('.food-card').length === cardsBefore);

  // 2. 记录期限事件写满：同样提示且回滚（不弹成功 toast、不关详情）
  const card = window.document.querySelector('.food-card[data-id="' + spinach.id + '"]');
  card.click();
  const eventsBefore = window.__store.getItem(spinach.id).events.length;
  $('#ev-open').click();
  check('事件保存失败时也弹出失败提示', fullSheet.hidden === false);
  check('事件未写入内存（已回滚）', window.__store.getItem(spinach.id).events.length === eventsBefore);
  check('详情弹层没有按“成功”路径关闭', $('#sheetDetail').hidden === false);
  $('#sheetDetail').hidden = true;

  // 3. “我知道了”：关闭失败弹层；存储层已回滚，录入表单仍可重试
  $('#btnStorageClose').click();
  check('关闭后失败弹层隐藏', fullSheet.hidden === true);
  check('录入表单仍开着，可修改后重试', $('#sheetForm').hidden === false);

  // 4. 空间未恢复时点“清理历史痕迹”：仍写不进，弹层保持，不谎报成功
  $('#btnStoragePrune').click();
  check('瘦身后仍写不进时弹层保持打开', fullSheet.hidden === false);

  // 5. “先导出备份”可点且不报错（下载在 jsdom 中为空操作）
  let exportThrew = false;
  try { $('#btnStorageExport').click(); } catch (e) { exportThrew = true; }
  check('导出备份按钮可正常点击', exportThrew === false);

  // 6. 空间恢复后再点“清理历史痕迹”：成功瘦身、弹层关闭、给出腾出空间提示
  restoreStorage();
  $('#btnStoragePrune').click();
  check('空间恢复后清理成功，失败弹层关闭', fullSheet.hidden === true);
  check('提示已清理并腾出空间', /已清理/.test($('#toast').textContent) && $('#toast').hidden === false);
  check('清理只删流水：库存数量不变', window.__store.listItems().length === itemsBefore);
  check('清理只删流水：食材事件不受影响',
    window.__store.getItem(spinach.id).events.length === eventsBefore);
  check('清理动作本身记入追溯',
    window.__store.auditEntries().some(e => e.action === 'history.prune'));
  // 修订历史确实被裁剪（保留最近 20 份）
  check('字段修订快照被裁剪到保留上限', window.__store.getItem(spinach.id).revisions.length <= 20);

  // 7. 重试此前失败的录入：成功保存、表单关闭、新食材出现
  fire($('#itemForm'), 'submit');
  check('重试保存成功：表单关闭', $('#sheetForm').hidden === true);
  check('重试保存成功：新食材入库',
    window.__store.listItems().some(i => i.name === '草莓'));
  check('重试保存成功：界面出现新卡片',
    Array.from(window.document.querySelectorAll('.food-card')).some(c => /草莓/.test(c.textContent)));

  // 8. 追溯页展示“清理历史痕迹”流水说明
  Array.from(window.document.querySelectorAll('.tab[data-view]'))
    .find(t => t.dataset.view === 'history').click();
  check('追溯视图展示清理历史痕迹记录', /清理历史痕迹/.test($('#auditList').textContent));
  check('清理记录写明删除范围且库存未删', /旧流水|库存与期限事件未删除/.test($('#auditList').textContent));

  // 9. 无痕/隐私模式（非配额的存储不可写）：标题、引导、按钮必须换成另一套
  Array.from(window.document.querySelectorAll('.tab[data-view]'))
    .find(t => t.dataset.view === 'inventory').click();
  const itemsBeforeBlocked = window.__store.listItems().length;
  const auditBeforeBlocked = window.__store.auditEntries().length;
  makeStorageBlocked();
  $('#btnAdd').click();
  $('#fName').value = '蓝莓';
  fire($('#fName'), 'input');
  $('#fPurchaseDate').value = '2026-09-14';
  fire($('#itemForm'), 'submit');

  check('不可写时保存失败弹层出现', fullSheet.hidden === false);
  check('不可写模式：标题为“浏览器存储不可写”', /浏览器存储不可写/.test($('#storageFullTitle').textContent));
  check('不可写模式：标题不误报“存储空间已满”', !/存储空间已满/.test($('#storageFullTitle').textContent));
  check('不可写模式：正文提示无痕/隐私模式', /无痕|隐私/.test($('#storageFullMsg').textContent));
  check('不可写模式：展示不可写步骤、隐藏容量步骤',
    $('#stepsBlocked').hidden === false && $('#stepsQuota').hidden === true);
  check('不可写模式：引导退出无痕/隐私窗口', /退出无痕|隐私/.test($('#stepsBlocked').textContent));
  check('不可写模式：引导更换浏览器重试', /更换浏览器/.test($('#stepsBlocked').textContent));
  check('不可写模式：明确说明无需清理历史', /无需清理历史数据|删除记录也腾不出/.test($('#stepsBlocked').textContent));
  check('不可写模式：不出现“清理历史痕迹”按钮', $('#btnStoragePrune').hidden === true);
  // 只统计可见内容（hidden 元素的文字仍在 textContent 里，需排除）。
  // 不可写步骤第 3 条虽提到“清理历史痕迹对此没有帮助”，但不能出现配额模式里
  // “点击清理 → 腾出空间”那套可执行引导。
  const visibleText = (() => {
    const clone = fullSheet.cloneNode(true);
    Array.from(clone.querySelectorAll('[hidden]')).forEach(el => el.remove());
    return clone.textContent;
  })();
  check('不可写模式：可见内容没有“清理历史痕迹”按钮或腾出空间引导',
    !/清理历史痕迹/.test(visibleText) && !/通常足以腾出空间/.test(visibleText));
  check('不可写模式：不展示数据占用分布（大小不是原因）', $('#storageStats').hidden === true);
  check('不可写模式：仍引导先导出备份', /导出备份/.test($('#stepsBlocked').textContent));
  check('不可写模式：表单保持打开、输入不丢',
    $('#sheetForm').hidden === false && $('#fName').value === '蓝莓');
  check('不可写模式：库存条数未增加（已回滚）',
    window.__store.listItems().length === itemsBeforeBlocked);
  check('不可写模式：追溯流水未增加（已回滚）',
    window.__store.auditEntries().length === auditBeforeBlocked);

  // 导出仍可点击（自救动作不依赖写入）
  let blockedExportThrew = false;
  try { $('#btnStorageExport').click(); } catch (e) { blockedExportThrew = true; }
  check('不可写模式：导出备份按钮仍可点击', blockedExportThrew === false);

  // 退出无痕/换普通窗口（存储恢复）后重试成功
  restoreStorage();
  $('#btnStorageClose').click();
  fire($('#itemForm'), 'submit');
  check('存储恢复后重试：表单关闭', $('#sheetForm').hidden === true);
  check('存储恢复后重试：新食材入库',
    window.__store.listItems().some(i => i.name === '蓝莓'));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
