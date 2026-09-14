/*
 * freshkeeper/ocr.js —— 拍照文字识别 + 标签解析
 *
 * 流程：拍照/选图 → Tesseract 中英文识别（CDN 懒加载，离线时提示手动输入）
 *       → 规则解析出候选字段 → 全部回填到表单，用户逐项确认/修改后才入库。
 *       OCR 永远只是“建议”，不自动写入任何记录。
 */
(function (global) {
  'use strict';

  var TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  // ---------- 纯解析逻辑（可测试） ----------
  var LOCATION_HINTS = [
    { re: /(冷冻|速冻|-\s*18\s*℃|以下冷冻)/, location: 'freezer' },
    { re: /(冷藏|0\s*[-~–至]\s*4\s*℃|2\s*[-~–至]\s*6\s*℃|冰箱冷藏)/, location: 'fridge' },
    { re: /(常温|阴凉|干燥|室温|避免阳光直射)/, location: 'pantry' }
  ];

  var NAME_STOPWORDS = /(净含量|配料|生产商|地址|电话|保质期|贮存|保存|生产日期|产品标准|生产许可|食品生产|条码|www\.|http|有限公司|分公司)/;

  function findDates(text) {
    var out = [];
    var patterns = [
      /(\d{4})\s*[年\/\-.]\s*(\d{1,2})\s*[月\/\-.]\s*(\d{1,2})\s*日?/g,
      /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})/g
    ];
    patterns.forEach(function (re) {
      var m;
      while ((m = re.exec(text)) !== null) {
        var y, mo, d;
        if (m[0].match(/^\d{4}/)) { y = +m[1]; mo = +m[2]; d = +m[3]; }
        else { mo = +m[1]; d = +m[2]; y = +m[3]; }
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y < 2100) {
          out.push({ text: m[0], date: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), index: m.index });
        }
      }
    });
    return out;
  }

  function parseLabel(rawText) {
    var text = String(rawText || '').replace(/[ \t]+/g, ' ');
    var result = { rawText: rawText || '', name: '', expireDate: '', locationHint: '', daysShelf: null, hints: [] };

    // 保质期天数/月数
    var shelf = text.match(/保质[期日][^0-9]{0,8}(\d{1,4})\s*(天|日|个月|月|年)/);
    if (shelf) {
      var n = +shelf[1];
      result.daysShelf = shelf[2] === '天' || shelf[2] === '日' ? n
        : (shelf[2] === '个月' || shelf[2] === '月') ? n * 30 : n * 365;
    }

    var dates = findDates(text);

    // 1) 显式到期关键词：取关键词之后最近的日期
    var expiryKey = /(保质期至|此日期前(?:最佳|食用)?|最佳食用日期|消费日期|有效期至|EXP(?:IRY)?(?:\s*DATE)?|到期日|请于)/i;
    var km = text.match(expiryKey);
    if (km) {
      var after = dates.filter(function (dt) { return dt.index >= km.index; })
        .sort(function (a, b) { return a.index - b.index; })[0];
      if (after) result.expireDate = after.date;
    }

    // 2) 生产日期 + 保质期 N 天 → 推算到期日
    if (!result.expireDate && shelf) {
      var pm = text.match(/(生产日期|生产[日期号批号]*|MFG(?:\s*DATE)?|制造日期)/i);
      if (pm) {
        var prod = dates.filter(function (dt) { return dt.index >= pm.index; })
          .sort(function (a, b) { return a.index - b.index; })[0];
        if (prod && result.daysShelf) {
          var t = new Date(prod.date + 'T12:00:00');
          t.setDate(t.getDate() + result.daysShelf);
          result.expireDate = t.getFullYear() + '-' +
            String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
        }
      }
    }

    // 3) 只有一个日期且没有保质期天数：按到期日候选
    if (!result.expireDate && !shelf && dates.length) {
      result.expireDate = dates[dates.length - 1].date;
    }

    // 保存位置
    for (var i = 0; i < LOCATION_HINTS.length; i++) {
      if (LOCATION_HINTS[i].re.test(text)) { result.locationHint = LOCATION_HINTS[i].location; break; }
    }

    // 名称：取第一条“像样的”非数字行
    var lines = text.split(/\r?\n|。|；|;/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 2 && !NAME_STOPWORDS.test(s) && !/^\d+[.\s]/.test(s); });
    if (lines.length) {
      result.name = lines[0]
        .replace(/^[【\[(（]?[^一-龥A-Za-z]{0,6}[】\])）]?/, '')
        .replace(/(净含量|规格).*$/, '').trim().slice(0, 20);
    }

    result.hints.push('识别结果仅供参考，请逐项核对后再保存');
    return result;
  }

  // ---------- 浏览器端 OCR ----------
  function recognizeImage(dataUrlOrFile, onProgress) {
    return new Promise(function (resolve, reject) {
      if (typeof window === 'undefined' || !window.document) {
        return reject(new Error('OCR 仅在浏览器环境可用'));
      }
      function run(Tesseract) {
        Tesseract.recognize(dataUrlOrFile, 'chi_sim+eng', {
          logger: function (m) { if (onProgress && m.status) onProgress(m.status, m.progress || 0); }
        }).then(function ({ data }) {
          resolve(parseLabel(data.text));
        }).catch(reject);
      }
      if (global.Tesseract) {
        run(global.Tesseract);
      } else {
        var s = document.createElement('script');
        s.src = TESSERACT_CDN;
        s.onload = function () { run(global.Tesseract); };
        s.onerror = function () { reject(new Error('识别组件加载失败（可能离线），请直接手动输入')); };
        document.head.appendChild(s);
      }
    });
  }

  var OCR = { parseLabel: parseLabel, findDates: findDates, recognizeImage: recognizeImage };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OCR;
  } else {
    global.FreshOCR = OCR;
  }
})(typeof window !== 'undefined' ? window : this);
