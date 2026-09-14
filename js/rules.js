/*
 * freshkeeper/rules.js
 * 食材分类保质期规则库（决策依据层）
 *
 * 数值为“安全期限”建议天数（充分加热/密封等理想条件下的家庭保守值），
 * 来源依据：USDA FoodKeeper、中国居民膳食指南关于剩菜/豆制品/水产的常见建议、
 * 各类食品包装通用贮存说明。家庭场景以保守为原则。
 *
 * 每个分类：
 *   fridge/freezer/pantry: { sealed, opened } 对应“未开封密封 / 已开封或散装”的安全天数
 *      null  = 该保存位置不建议（引擎会给“不建议此保存方式”提示，并按 1 天兜底）
 *   freezerQuality: 冷冻室内“品质期限”天数（安全上通常仍可保存，但口感/营养开始下降）
 *   thawQuality:    解冻后建议在多少天内吃完
 *   cookedSafe/cookedQuality: 做熟后冷藏的安全 / 品质期限
 *   highRisk: 高风险食材（肉禽水产蛋奶豆制品、剩菜），预警阈值更严
 *   freezable: 是否建议给出“适合冷冻”建议
 *   keywords: 名称匹配关键词（按最长关键词优先）
 */
(function (global) {
  'use strict';

  var CATEGORIES = [
    {
      id: 'leafy', name: '绿叶菜', highRisk: false, freezable: true,
      fridge: { sealed: 5, opened: 3 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 1, opened: 1 },
      freezerQuality: 90, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['菠菜', '青菜', '生菜', '油菜', '白菜', '芹菜', '韭菜', '香菜', '空心菜', '西兰花', '甘蓝', '沙拉菜', '菜心', '茼蒿', '苋菜', '绿叶']
    },
    {
      id: 'fruiting', name: '瓜果茄类蔬菜', highRisk: false, freezable: true,
      fridge: { sealed: 7, opened: 5 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 7, opened: 5 },
      freezerQuality: 180, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['番茄', '西红柿', '黄瓜', '茄子', '青椒', '辣椒', '彩椒', '西葫芦', '冬瓜', '南瓜', '丝瓜', '苦瓜', '玉米', '豆角', '豌豆', '荷兰豆']
    },
    {
      id: 'root', name: '根茎类', highRisk: false, freezable: true,
      fridge: { sealed: 30, opened: 14 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 30, opened: 20 },
      freezerQuality: 180, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['土豆', '马铃薯', '胡萝卜', '萝卜', '红薯', '地瓜', '山药', '芋头', '洋葱', '大蒜', '姜', '藕', '莴笋', '竹笋']
    },
    {
      id: 'mushroom', name: '鲜菌菇', highRisk: false, freezable: true,
      fridge: { sealed: 7, opened: 4 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 2, opened: 1 },
      freezerQuality: 90, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['蘑菇', '香菇', '口蘑', '金针菇', '平菇', '杏鲍菇', '木耳', '菌', '菇']
    },
    {
      id: 'fruit', name: '水果', highRisk: false, freezable: true,
      fridge: { sealed: 14, opened: 7 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 7, opened: 5 },
      freezerQuality: 180, thawQuality: 2, cookedSafe: 2, cookedQuality: 2,
      keywords: ['苹果', '梨', '香蕉', '橙子', '橘子', '桔子', '葡萄', '西瓜', '哈密瓜', '草莓', '蓝莓', '桃子', '李子', '芒果', '菠萝', '猕猴桃', '火龙果', '柠檬', '樱桃', '荔枝', '水果', '蜜瓜', '柚子', '杨梅']
    },
    {
      id: 'rawmeat', name: '生鲜肉（猪牛羊）', highRisk: true, freezable: true,
      fridge: { sealed: 3, opened: 2 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: null, opened: null },
      freezerQuality: 180, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['猪肉', '牛肉', '羊肉', '排骨', '里脊', '五花肉', '牛腩', '牛排', '肉馅', '肉末', '肉糜', '绞肉', '肉片', '肉丝', '肉丁', '肉馅', '猪蹄', '猪肝', '牛腩']
    },
    {
      id: 'poultry', name: '禽肉', highRisk: true, freezable: true,
      fridge: { sealed: 2, opened: 2 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: null, opened: null },
      freezerQuality: 180, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['鸡肉', '鸡腿', '鸡胸', '鸡翅', '整鸡', '鸭肉', '鹅', '鸡爪', '禽类']
    },
    {
      id: 'seafood', name: '水产海鲜', highRisk: true, freezable: true,
      fridge: { sealed: 1, opened: 1 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: null, opened: null },
      freezerQuality: 90, thawQuality: 1, cookedSafe: 2, cookedQuality: 1,
      keywords: ['鱼', '虾', '蟹', '贝类', '花甲', '生蚝', '牡蛎', '鱿鱼', '带鱼', '三文鱼', '海鲜', '水产', '花甲']
    },
    {
      id: 'deli', name: '熟肉/火腿香肠', highRisk: true, freezable: true,
      fridge: { sealed: 5, opened: 3 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 2, opened: 1 },
      freezerQuality: 60, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['火腿', '香肠', '培根', '腊肉', '腊肠', '熟食', '酱牛肉', '午餐肉', '热狗']
    },
    {
      id: 'leftovers', name: '剩菜/熟菜', highRisk: true, freezable: true,
      fridge: { sealed: 3, opened: 3 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 1, opened: 1 },
      freezerQuality: 60, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['剩菜', '剩饭', '外卖', '卤味', '熟菜', '家常菜']
    },
    {
      id: 'rice', name: '熟主食', highRisk: true, freezable: true,
      fridge: { sealed: 2, opened: 2 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 1, opened: 1 },
      freezerQuality: 90, thawQuality: 1, cookedSafe: 2, cookedQuality: 1,
      keywords: ['米饭', '炒饭', '面条', '馒头', '包子', '饺子熟', '花卷', '烙饼', '粥', '意面']
    },
    {
      id: 'egg', name: '鸡蛋（带壳）', highRisk: false, freezable: false,
      fridge: { sealed: 30, opened: 30 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 14, opened: 10 },
      freezerQuality: 90, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['鸡蛋', '鸭蛋', '鹌鹑蛋', '土鸡蛋', '柴鸡蛋', '乌鸡蛋', '鹅蛋']
    },
    {
      id: 'milk', name: '液态奶', highRisk: true, freezable: false,
      fridge: { sealed: 7, opened: 3 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 180, opened: 1 },
      freezerQuality: 30, thawQuality: 2, cookedSafe: 2, cookedQuality: 1,
      keywords: ['牛奶', '鲜奶', '纯牛奶', '低脂奶', '脱脂奶', '奶']
    },
    {
      id: 'yogurt', name: '酸奶', highRisk: true, freezable: true,
      fridge: { sealed: 21, opened: 3 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 1, opened: 1 },
      freezerQuality: 30, thawQuality: 2, cookedSafe: 2, cookedQuality: 1,
      keywords: ['酸奶', '酸乳', '风味发酵乳', '乳酸菌']
    },
    {
      id: 'tofu', name: '豆制品', highRisk: true, freezable: true,
      fridge: { sealed: 30, opened: 2 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 1, opened: 1 },
      freezerQuality: 60, thawQuality: 2, cookedSafe: 2, cookedQuality: 1,
      keywords: ['豆腐', '豆干', '千张', '豆皮', '腐竹鲜', '豆浆', '纳豆', '豆泡']
    },
    {
      id: 'bread', name: '面包糕点', highRisk: false, freezable: true,
      fridge: { sealed: 5, opened: 3 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 7, opened: 4 },
      freezerQuality: 60, thawQuality: 2, cookedSafe: 2, cookedQuality: 1,
      keywords: ['面包', '吐司', '蛋糕', '糕点', '饼干软', '三明治', '汉堡胚', '馕']
    },
    {
      id: 'frozen', name: '速冻食品', highRisk: true, freezable: true,
      fridge: { sealed: 2, opened: 1 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 1, opened: 1 },
      freezerQuality: 180, thawQuality: 1, cookedSafe: 2, cookedQuality: 1,
      keywords: ['速冻', '冷冻', '水饺', '饺子', '馄饨', '汤圆', '冻虾', '冻', '冰鲜']
    },
    {
      id: 'canned', name: '罐头/密封即食', highRisk: false, freezable: false,
      fridge: { sealed: 4, opened: 3 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 1095, opened: 1 },
      freezerQuality: 90, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['罐头', '八宝粥', '真空包装即食', '罐装']
    },
    {
      id: 'condiment', name: '调味酱料', highRisk: false, freezable: false,
      fridge: { sealed: 90, opened: 30 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 180, opened: 30 },
      freezerQuality: 60, thawQuality: 2, cookedSafe: 2, cookedQuality: 2,
      keywords: ['酱', '酱油', '醋', '调味', '沙拉酱', '番茄酱', '腐乳', '豆瓣']
    },
    {
      id: 'dry', name: '干货/米面挂面', highRisk: false, freezable: false,
      fridge: { sealed: 180, opened: 90 }, freezer: { sealed: null, opened: null },
      pantry: { sealed: 365, opened: 180 },
      freezerQuality: 180, thawQuality: 2, cookedSafe: 3, cookedQuality: 2,
      keywords: ['挂面', '面条干', '米', '面粉', '干货', '木耳干', '香菇干', '粉丝', '意面干', '杂粮', '燕麦']
    }
  ];

  // 保存位置元数据
  var LOCATIONS = {
    fridge:  { name: '冷藏', short: '冷', temp: '0–4°C' },
    freezer: { name: '冷冻', short: '冻', temp: '约-18°C' },
    pantry:  { name: '常温', short: '常', temp: '阴凉通风' }
  };

  var PACKAGES = {
    sealed: '未开封/密封',
    opened: '已开封',
    loose:  '散装'
  };

  var RULES = {
    categories: CATEGORIES,
    locations: LOCATIONS,
    packages: PACKAGES,
    fallbackDays: 1 // 规则缺失或不建议的保存位置时的兜底安全天数
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RULES;
  } else {
    global.FreshRules = RULES;
  }
})(typeof window !== 'undefined' ? window : this);
