// ===================================================
// e-Stat API クライアント & データ統合モジュール v6
// 政府統計の総合窓口 https://www.e-stat.go.jp/api/
// ===================================================

const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json';

// ===================================================
// e-Stat API クライアント
// ===================================================
class EStatClient {
  constructor(appId) {
    this.appId = appId;
    this._cache = {};
  }

  async _get(endpoint, params = {}) {
    const url = new URL(`${ESTAT_BASE}/${endpoint}`);
    url.searchParams.set('appId', this.appId);
    url.searchParams.set('lang', 'J');
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    const key = url.toString();
    if (this._cache[key]) return this._cache[key];
    const resp = await fetch(key);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    this._cache[key] = json;
    return json;
  }

  async testConnection() {
    try {
      const json = await this._get('getStatsList', { searchWord: '食料需給表', limit: 1 });
      return json?.GET_STATS_LIST?.RESULT?.STATUS === 0
        ? { ok: true }
        : { ok: false, error: json?.GET_STATS_LIST?.RESULT?.ERROR_MSG || '不明なエラー' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async searchStats(searchWord, extra = {}) {
    const json = await this._get('getStatsList', { searchWord, limit: 100, ...extra });
    if (json?.GET_STATS_LIST?.RESULT?.STATUS !== 0) return [];
    const raw = json?.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  async getStatsData(statsDataId, params = {}) {
    const json = await this._get('getStatsData', {
      statsDataId,
      metaGetFlg: 'Y',
      cntGetFlg: 'N',
      ...params,
    });
    const result = json?.GET_STATS_DATA?.RESULT;
    if (result?.STATUS !== 0) throw new Error(result?.ERROR_MSG || 'データ取得エラー');
    return json.GET_STATS_DATA.STATISTICAL_DATA;
  }
}

// ===================================================
// ユーティリティ
// ===================================================

function parseYear(code) {
  return parseInt(String(code).slice(0, 4), 10);
}

function normalizeValue(raw, unit) {
  const u = (unit || '').trim().replace(/\s/g, '');
  if (u === 't'   || u === 'トン')  return raw / 10000;
  if (u === '千t' || u === '千トン') return raw / 10;
  if (u === '万t' || u === '万トン') return raw;
  if (u === 'kg')   return raw / 10000000;
  if (u === '人')   return raw / 10000;
  if (u === '千人') return raw / 10;
  if (u === '万人') return raw;
  if (u === '経営体')    return raw / 10000;
  if (u === '千経営体')  return raw / 10;
  if (u === '万経営体')  return raw;
  if (u === 'ha')   return raw / 10000;
  if (u === '千ha') return raw / 10;
  if (u === '万ha') return raw;
  if (u === 'a')    return raw / 1000000;
  if (u === '%')    return raw;
  if (raw > 100000) return raw / 10000;
  return raw;
}

// ===================================================
// 単位タイプベースのフィルタリング（v6 コア機能）
// ===================================================
// 単位でデータ種別を判断することで、カテゴリコード不一致や
// 空フィルタによる誤データ混入（例: 自給率8429%）を防ぐ
const UNIT_SETS = {
  weight:  new Set(['t', 'トン', '千t', '千トン', '万t', '万トン', 'kg']),
  area:    new Set(['ha', '千ha', '万ha', 'a']),
  percent: new Set(['%']),
  people:  new Set(['人', '千人', '万人']),
  body:    new Set(['経営体', '千経営体', '万経営体']),
};

function buildYearMapByUnit(values, unitType, areaCode, catFilters) {
  if (!Array.isArray(values) || !values.length) return {};
  const accepted = UNIT_SETS[unitType] || new Set();
  catFilters = catFilters || [];

  const map = {};
  for (const v of values) {
    const unit = (v['@unit'] || '').trim().replace(/\s+/g, '');
    if (accepted.size > 0 && !accepted.has(unit)) continue;

    const raw = parseFloat(v['$']);
    if (isNaN(raw) || raw < 0) continue;
    // 自給率の値域バリデーション（絶対に1000%を超えない）
    if (unitType === 'percent' && raw > 1000) continue;

    if (areaCode != null && v['@area'] != null && v['@area'] !== areaCode) continue;
    if (catFilters.some(f => v[f.key] != null && v[f.key] !== f.value)) continue;

    const year = parseYear(v['@time']);
    if (year < 1990 || year > 2030) continue;

    const val = parseFloat(normalizeValue(raw, unit).toFixed(4));
    if (val <= 0) continue;
    if (map[year] === undefined || val > map[year]) map[year] = val;
  }
  return map;
}

// areaCode と catFilters の複数組み合わせを試して ≥2 件のデータを返す
function tryByUnit(values, unitType, areaCodes, catFilterSets) {
  for (const areaCode of areaCodes) {
    for (const catFilters of catFilterSets) {
      const map = buildYearMapByUnit(values, unitType, areaCode, catFilters);
      if (Object.keys(map).length >= 2) {
        console.log(`[e-Stat] OK unitType=${unitType} area=${areaCode} filters=${JSON.stringify(catFilters)} → ${Object.keys(map).length}年`);
        return map;
      }
    }
  }
  return {};
}

// ===================================================
// CLASS_OBJ ユーティリティ
// ===================================================

function findClassObj(classObjRaw, id) {
  if (!classObjRaw) return null;
  const arr = Array.isArray(classObjRaw) ? classObjRaw : [classObjRaw];
  return arr.find(c => c['@id'] === id) || null;
}

function findCode(classObj, ...keywords) {
  if (!classObj) return null;
  const classes = Array.isArray(classObj.CLASS) ? classObj.CLASS : (classObj.CLASS ? [classObj.CLASS] : []);
  for (const kw of keywords) {
    const exact = classes.find(c => c['@name'] === kw);
    if (exact) return exact['@code'];
  }
  for (const kw of keywords) {
    const starts = classes.find(c => c['@name']?.startsWith(kw));
    if (starts) return starts['@code'];
  }
  for (const kw of keywords) {
    const partial = classes.find(c => c['@name']?.includes(kw));
    if (partial) return partial['@code'];
  }
  return null;
}

// 全カテゴリコード一覧をコンソール出力（デバッグ用）
function logClasses(classObj, label) {
  if (!classObj) return;
  const classes = Array.isArray(classObj.CLASS) ? classObj.CLASS : (classObj.CLASS ? [classObj.CLASS] : []);
  const names = classes.slice(0, 40).map(c => `${c['@code']}=${c['@name']}`).join(' | ');
  console.log(`[e-Stat DEBUG] ${label}: ${names}`);
}

// { year: value } → [{year, value}] ソート済み配列
function yearMapToList(yearMap) {
  return Object.entries(yearMap)
    .map(([y, v]) => ({ year: parseInt(y), value: v }))
    .sort((a, b) => a.year - b.year);
}

// 欠損補間（農林業センサス5年おきデータ用）
function interpolateList(list) {
  if (list.length < 2) return list;
  const minY = list[0].year, maxY = list[list.length - 1].year;
  const map = Object.fromEntries(list.map(d => [d.year, d.value]));
  const result = [];
  for (let y = minY; y <= maxY; y++) {
    if (map[y] !== undefined) { result.push({ year: y, value: map[y] }); continue; }
    let lo = y - 1, hi = y + 1;
    while (lo >= minY && map[lo] === undefined) lo--;
    while (hi <= maxY && map[hi] === undefined) hi++;
    if (map[lo] !== undefined && map[hi] !== undefined) {
      const val = parseFloat((map[lo] + (map[hi] - map[lo]) * ((y - lo) / (hi - lo))).toFixed(2));
      result.push({ year: y, value: val });
    }
  }
  return result;
}

// ===================================================
// テーブル動的選択（キーワード検索 → スコアリング）
// ===================================================
function scoreTable(table, must, bonus, penalty = []) {
  const txt = [
    table.STATISTICS_NAME || '',
    table.TITLE?.['$'] || table.TITLE || '',
    table.SURVEY_DATE || '',
  ].join(' ');
  let score = 0;
  for (const w of must)    { if (!txt.includes(w)) return -9999; score += 10; }
  for (const w of bonus)   { if (txt.includes(w))  score += 5; }
  for (const w of penalty) { if (txt.includes(w))  score -= 15; }
  const d = parseInt(table.SURVEY_DATE || '0', 10);
  score += Math.max(0, Math.floor((d - 200000) / 10000));
  return score;
}

async function findBestTableId(client, searchWord, must, bonus = [], penalty = []) {
  const tables = await client.searchStats(searchWord);
  if (!tables.length) {
    console.warn(`[e-Stat] "${searchWord}" 検索結果なし`);
    return null;
  }
  const scored = tables
    .map(t => ({ id: t['@id'], score: scoreTable(t, must, bonus, penalty), title: t.TITLE?.['$'] || t.TITLE || '' }))
    .filter(x => x.score > -9999)
    .sort((a, b) => b.score - a.score);
  if (scored.length) {
    console.log(`[e-Stat] "${searchWord}" → ${scored[0].title} (score=${scored[0].score}, id=${scored[0].id})`);
    return scored[0].id;
  }
  return null;
}

// テーブルを fetch（areaCode あり / なし 両方試す）
async function fetchTableData(client, tableId, extraParams = {}) {
  const paramSets = [
    { cdArea: '00000', cdTimeFrom: '2000000000', cdTimeTo: '2024000000', ...extraParams },
    { cdTimeFrom: '2000000000', cdTimeTo: '2024000000', ...extraParams },  // area なし
    { ...extraParams },  // 時刻絞り込みなし
  ];
  for (const params of paramSets) {
    try {
      const sd = await client.getStatsData(tableId, params);
      const values = sd?.DATA_INF?.VALUE;
      if (Array.isArray(values) && values.length >= 2) return sd;
    } catch (e) {
      console.warn(`[e-Stat] fetch試行失敗 params=${JSON.stringify(params)}: ${e.message}`);
    }
  }
  return null;
}

// ===================================================
// 【食料需給表】品目別: 生産量・消費量・輸入量・自給率
// ===================================================
async function fetchFoodBalance(client) {
  const STRATEGIES = [
    { word: '食料需給表 品目別 国内生産量', must: ['食料需給'], bonus: ['品目別', '国内生産量', '自給率'] },
    { word: '食料需給表 自給率',            must: ['食料需給'], bonus: ['自給率', '国内消費'] },
    { word: '食料需給表',                   must: ['食料需給'], bonus: ['品目', '生産'] },
  ];
  const PENALTY = ['都道府県', '市町村', '地域別'];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn('[e-Stat] 食料需給表テーブル未発見'); return null; }

  const sd = await fetchTableData(client, tableId);
  if (!sd) { console.warn('[e-Stat] 食料需給表データ取得失敗'); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 食料需給表 VALUES空'); return null; }
  console.log(`[e-Stat] 食料需給表 VALUES=${values.length}件`);

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  const cat02 = findClassObj(classObjs, 'cat02');
  if (cat01) logClasses(cat01, '食料需給表 cat01');
  if (cat02) logClasses(cat02, '食料需給表 cat02');

  const CROP_KW = {
    rice:    ['米', 'うるち米', '水稲', '米（うるち米）'],
    wheat:   ['小麦'],
    soybean: ['大豆'],
    potato:  ['ばれいしょ', 'じゃがいも', 'バレイショ', 'いも類'],
    onion:   ['たまねぎ', 'タマネギ', '玉ねぎ'],
    cabbage: ['キャベツ', 'きゃべつ'],
    tomato:  ['トマト', 'とまと'],
  };
  const METRIC_KW = {
    production:      ['国内生産量', '生産量', '国内生産'],
    imports:         ['輸入量', '輸入'],
    consumption:     ['国内消費仕向量', '消費仕向量', '国内消費量', '消費量'],
    selfSufficiency: ['自給率', '食料自給率', '自給率（重量ベース）'],
  };

  // cat01/cat02 どちらが品目・指標かを両方向で探す
  function findCropAndMetricCodes(cropKws, metricKws) {
    const cats = [cat01, cat02].filter(Boolean);
    let cropCode = null, cropCatKey = null;
    let metricCode = null, metricCatKey = null;
    const catKeys = ['@cat01', '@cat02'];
    cats.forEach((cat, i) => {
      const cc = findCode(cat, ...cropKws);
      const mc = findCode(cat, ...metricKws);
      if (cc && !cropCode)   { cropCode = cc;   cropCatKey = catKeys[i]; }
      if (mc && !metricCode) { metricCode = mc; metricCatKey = catKeys[i]; }
    });
    return { cropCode, cropCatKey, metricCode, metricCatKey };
  }

  const AREA_CODES = ['00000', null];
  const result = {};

  for (const [cropKey, cropKws] of Object.entries(CROP_KW)) {
    result[cropKey] = {};

    for (const [metricKey, metricKws] of Object.entries(METRIC_KW)) {
      const unitType = metricKey === 'selfSufficiency' ? 'percent' : 'weight';
      const { cropCode, cropCatKey, metricCode, metricCatKey } = findCropAndMetricCodes(cropKws, metricKws);

      const catFilterSets = [];
      // 最優先: 品目+指標の両方コードが見つかった場合
      if (cropCode && metricCode && cropCatKey !== metricCatKey) {
        catFilterSets.push([
          { key: cropCatKey,   value: cropCode },
          { key: metricCatKey, value: metricCode },
        ]);
      }
      // 品目コードのみ
      if (cropCode) catFilterSets.push([{ key: cropCatKey, value: cropCode }]);
      // 指標コードのみ
      if (metricCode) catFilterSets.push([{ key: metricCatKey, value: metricCode }]);
      // フィルタなし（単位タイプが守ってくれる）
      catFilterSets.push([]);

      const map = tryByUnit(values, unitType, AREA_CODES, catFilterSets);
      const list = yearMapToList(map);
      if (list.length >= 2) result[cropKey][metricKey] = list;
    }

    if (!Object.keys(result[cropKey]).length) delete result[cropKey];
  }

  const found = Object.keys(result).length;
  console.log(`[e-Stat] 食料需給表 取得品目数=${found}`, Object.keys(result));
  if (!found) return null;
  return { data: result, source: '食料需給表（農林水産省）', tableId };
}

// ===================================================
// 【作物統計調査】収穫量・作付面積（米・麦・豆類）
// 単位ベース分離: weight=収穫量, area=作付面積
// ===================================================
async function fetchGrainStats(client, cropKws, cropLabel) {
  const mainWord = cropKws[0];
  const STRATEGIES = [
    { word: `作物統計調査 ${mainWord} 収穫量`, must: ['作物統計'], bonus: [...cropKws, '全国', '収穫'], penalty: ['市町村', '被害'] },
    { word: `作物統計 農作物 ${mainWord}`,     must: ['作物統計'], bonus: [...cropKws, '収穫'],          penalty: ['市町村', '被害'] },
    { word: `作物統計 ${mainWord}`,            must: ['作物統計'], bonus: [...cropKws],                  penalty: ['市町村', '被害'] },
    { word: `農作物 ${mainWord} 収穫量`,       must: ['作物'],     bonus: [...cropKws, '収穫'],          penalty: ['市町村'] },
  ];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, s.penalty || []);
    if (tableId) break;
  }
  if (!tableId) { console.warn(`[e-Stat] ${cropLabel} テーブル未発見`); return null; }

  const sd = await fetchTableData(client, tableId);
  if (!sd) { console.warn(`[e-Stat] ${cropLabel} データ取得失敗`); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn(`[e-Stat] ${cropLabel} VALUES空`); return null; }

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  const cat02 = findClassObj(classObjs, 'cat02');
  if (cat01) logClasses(cat01, `${cropLabel} cat01`);
  if (cat02) logClasses(cat02, `${cropLabel} cat02`);

  // 作物コード（複数品目テーブルの場合のみ必要）
  const cropCode01 = cat01 ? findCode(cat01, ...cropKws) : null;
  const cropCode02 = cat02 ? findCode(cat02, ...cropKws) : null;
  const cropCatKey = cropCode01 ? '@cat01' : (cropCode02 ? '@cat02' : null);
  const cropCode = cropCode01 || cropCode02;

  const cropFilter = cropCode ? [{ key: cropCatKey, value: cropCode }] : [];
  const AREA_CODES = ['00000', null];

  const buildData = (unitType) => {
    const allFilterSets = cropFilter.length > 0 ? [cropFilter, []] : [[]];
    return yearMapToList(tryByUnit(values, unitType, AREA_CODES, allFilterSets));
  };

  const harvest = buildData('weight');
  const area    = buildData('area');

  console.log(`[e-Stat] ${cropLabel} harvest=${harvest.length}年 area=${area.length}年`);
  if (!harvest.length) return null;

  return {
    harvest: harvest.length ? { data: harvest, source: '作物統計調査（農林水産省）', tableId } : null,
    area:    area.length    ? { data: area,    source: '作物統計調査（農林水産省）', tableId } : null,
  };
}

// ===================================================
// 【野菜生産出荷統計】収穫量・作付面積（野菜類）
// ===================================================
async function fetchVegetableStat(client, vegKws, vegLabel) {
  const mainWord = vegKws[0];
  const STRATEGIES = [
    { word: `野菜生産出荷統計 ${mainWord}`, must: ['野菜'], bonus: [...vegKws, '全国', '収穫'], penalty: ['産地別'] },
    { word: `野菜 ${mainWord} 収穫量`,      must: ['野菜'], bonus: [...vegKws, '収穫'],          penalty: ['産地別'] },
    { word: `野菜生産出荷統計 主要野菜`,    must: ['野菜'], bonus: [...vegKws, '収穫'],          penalty: ['産地別'] },
    { word: `野菜 収穫量 作付面積`,         must: ['野菜'], bonus: [...vegKws],                  penalty: ['産地別'] },
  ];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, s.penalty || []);
    if (tableId) break;
  }
  if (!tableId) { console.warn(`[e-Stat] ${vegLabel} テーブル未発見`); return null; }

  const sd = await fetchTableData(client, tableId);
  if (!sd) { console.warn(`[e-Stat] ${vegLabel} データ取得失敗`); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn(`[e-Stat] ${vegLabel} VALUES空`); return null; }

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  const cat02 = findClassObj(classObjs, 'cat02');
  if (cat01) logClasses(cat01, `${vegLabel} cat01`);
  if (cat02) logClasses(cat02, `${vegLabel} cat02`);

  const vegCode01 = cat01 ? findCode(cat01, ...vegKws) : null;
  const vegCode02 = cat02 ? findCode(cat02, ...vegKws) : null;
  const vegCatKey = vegCode01 ? '@cat01' : (vegCode02 ? '@cat02' : null);
  const vegCode = vegCode01 || vegCode02;
  const vegFilter = vegCode ? [{ key: vegCatKey, value: vegCode }] : [];

  const AREA_CODES = ['00000', null];
  const allFilterSets = vegFilter.length > 0 ? [vegFilter, []] : [[]];

  const harvest = yearMapToList(tryByUnit(values, 'weight', AREA_CODES, allFilterSets));
  const area    = yearMapToList(tryByUnit(values, 'area',   AREA_CODES, allFilterSets));

  console.log(`[e-Stat] ${vegLabel} harvest=${harvest.length}年 area=${area.length}年`);
  if (!harvest.length) return null;

  return {
    harvest: { data: harvest, source: '野菜生産出荷統計（農林水産省）', tableId },
    area:    area.length ? { data: area, source: '野菜生産出荷統計（農林水産省）', tableId } : null,
  };
}

// ===================================================
// 【農林業センサス】農業就業人口（年齢別）
// ===================================================
async function fetchAgriWorkers(client) {
  const STRATEGIES = [
    { word: '農林業センサス 農業就業人口 年齢別 累年',  must: ['センサス'], bonus: ['就業', '年齢', '累年'] },
    { word: '農林業センサス 農業就業人口 年齢',          must: ['センサス'], bonus: ['就業', '年齢'] },
    { word: '農林業センサス 農業就業人口',               must: ['センサス'], bonus: ['就業', '農業'] },
    { word: '農林業センサス 農業就業者 年齢',            must: ['センサス'], bonus: ['就業', '年齢'] },
    { word: '農林業センサス 農業就業者',                 must: ['センサス'], bonus: ['就業'] },
    { word: 'センサス 農業就業人口',                     must: ['センサス', '就業'], bonus: ['農業', '年齢'] },
    { word: '農林業センサス 農業経営体 就業',            must: ['センサス'], bonus: ['就業'] },
  ];
  const PENALTY = ['林業のみ', '水産業', '漁業', '市町村'];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn('[e-Stat] 農業就業人口テーブル未発見'); return null; }

  const sd = await fetchTableData(client, tableId, {});
  if (!sd) { console.warn('[e-Stat] 農業就業人口データ取得失敗'); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 農業就業人口 VALUES空'); return null; }
  console.log(`[e-Stat] 農業就業人口 VALUES=${values.length}件`);

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  const cat02 = findClassObj(classObjs, 'cat02');
  if (cat01) logClasses(cat01, '農業就業人口 cat01');
  if (cat02) logClasses(cat02, '農業就業人口 cat02');

  const AREA_CODES = ['00000', null];

  // 合計の就業人口
  const TOTAL_KW   = ['計', '合計', '総数', '農業就業人口', '農業就業者数'];
  const UNDER49_KW = ['49歳以下', '15〜49歳', '15〜49', '15〜44歳', '39歳以下'];
  const AGE5064_KW = ['50〜64歳', '50〜64', '50〜59歳と60〜64歳', '50〜59歳'];
  const OVER65_KW  = ['65歳以上', '65歳〜', '65〜'];

  const buildList = (kws) => {
    // cat01, cat02 両方から検索
    const cats = [cat01, cat02].filter(Boolean);
    const catKeys = ['@cat01', '@cat02'];
    let code = null, catKey = null;
    for (let i = 0; i < cats.length; i++) {
      const c = findCode(cats[i], ...kws);
      if (c) { code = c; catKey = catKeys[i]; break; }
    }
    const filterSets = code
      ? [[{ key: catKey, value: code }], []]
      : [[]];
    const map = tryByUnit(values, 'people', AREA_CODES, filterSets);
    return interpolateList(yearMapToList(map));
  };

  const total   = buildList(TOTAL_KW);
  const under49 = buildList(UNDER49_KW);
  const age5064 = buildList(AGE5064_KW);
  const over65  = buildList(OVER65_KW);

  // 年齢別が取れなかった場合: 合計のみ返す
  const byAge = {};
  if (under49.length) byAge.under49 = under49;
  if (age5064.length) byAge.age5064 = age5064;
  if (over65.length)  byAge.over65  = over65;

  console.log(`[e-Stat] 農業就業人口 total=${total.length}年 byAge=${JSON.stringify(Object.keys(byAge))}`);

  // 合計が取れなくても年齢別が全部あれば再構成
  if (!total.length && Object.keys(byAge).length === 3) {
    const allYears = [...new Set([...under49, ...age5064, ...over65].map(d => d.year))].sort((a,b)=>a-b);
    const sumByYear = {};
    for (const y of allYears) {
      const u = (under49.find(d=>d.year===y)?.value || 0);
      const m = (age5064.find(d=>d.year===y)?.value || 0);
      const o = (over65.find(d=>d.year===y)?.value || 0);
      const s = parseFloat((u + m + o).toFixed(2));
      if (s > 0) sumByYear[y] = s;
    }
    const reconstructed = yearMapToList(sumByYear);
    if (reconstructed.length >= 2) {
      console.log('[e-Stat] 農業就業人口 年齢別合計から再構成');
      return { total: reconstructed, byAge, source: '農林業センサス（農林水産省）', tableId };
    }
  }

  if (!total.length) return null;
  return { total, byAge, source: '農林業センサス（農林水産省）', tableId };
}

// ===================================================
// 【農林業センサス】農業経営体数
// ===================================================
async function fetchAgriBodies(client) {
  const STRATEGIES = [
    { word: '農林業センサス 農業経営体数 累年',     must: ['センサス'], bonus: ['農業経営体', '累年'] },
    { word: '農林業センサス 農業経営体数',          must: ['センサス'], bonus: ['農業経営体', '経営体数'] },
    { word: '農林業センサス 農業経営体 全国',       must: ['センサス'], bonus: ['経営体', '全国'] },
    { word: '農林業センサス 農業経営体',            must: ['センサス'], bonus: ['経営体'] },
    { word: 'センサス 農業経営体数',               must: ['センサス', '経営体'], bonus: [] },
  ];
  const PENALTY = ['林業のみ', '水産業', '漁業', '市町村'];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn('[e-Stat] 農業経営体数テーブル未発見'); return null; }

  const sd = await fetchTableData(client, tableId, {});
  if (!sd) { console.warn('[e-Stat] 農業経営体数データ取得失敗'); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 農業経営体数 VALUES空'); return null; }
  console.log(`[e-Stat] 農業経営体数 VALUES=${values.length}件`);

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  const cat02 = findClassObj(classObjs, 'cat02');
  if (cat01) logClasses(cat01, '農業経営体数 cat01');
  if (cat02) logClasses(cat02, '農業経営体数 cat02');

  const TOTAL_KW = ['計', '合計', '総数', '農業経営体数', '農業経営体'];
  const cats = [cat01, cat02].filter(Boolean);
  const catKeys = ['@cat01', '@cat02'];
  let code = null, catKey = null;
  for (let i = 0; i < cats.length; i++) {
    const c = findCode(cats[i], ...TOTAL_KW);
    if (c) { code = c; catKey = catKeys[i]; break; }
  }

  const filterSets = code ? [[{ key: catKey, value: code }], []] : [[]];
  const map = tryByUnit(values, 'body', ['00000', null], filterSets);
  const list = interpolateList(yearMapToList(map));

  console.log(`[e-Stat] 農業経営体数 ${list.length}年分`);
  if (!list.length) return null;
  return { data: list, source: '農林業センサス（農林水産省）', tableId };
}

// ===================================================
// 全データ一括ロード
// ===================================================
async function loadAllEStatData(appId, onProgress) {
  const client = new EStatClient(appId);
  const prog = msg => { if (onProgress) onProgress(msg); console.log('[e-Stat]', msg); };

  prog('APIキーを確認中...');
  const test = await client.testConnection();
  if (!test.ok) throw new Error(`接続失敗: ${test.error}`);
  prog('接続OK。データ取得を開始します...');

  prog('食料需給表を取得中...');
  const foodBalance = await fetchFoodBalance(client);

  prog('作物統計調査（穀物）を取得中...');
  const [riceR, wheatR, soybeanR] = await Promise.allSettled([
    fetchGrainStats(client, ['水稲', '米', 'うるち米'], '水稲'),
    fetchGrainStats(client, ['小麦'],                   '小麦'),
    fetchGrainStats(client, ['大豆'],                   '大豆'),
  ]);
  const get = r => r.status === 'fulfilled' ? r.value : null;

  prog('野菜生産出荷統計を取得中...');
  const [tomatoR, onionR, cabbageR, potatoR] = await Promise.allSettled([
    fetchVegetableStat(client, ['トマト', 'とまと'],                 'トマト'),
    fetchVegetableStat(client, ['たまねぎ', 'タマネギ', '玉ねぎ'],  'タマネギ'),
    fetchVegetableStat(client, ['キャベツ', 'きゃべつ'],            'キャベツ'),
    fetchVegetableStat(client, ['ばれいしょ', 'じゃがいも'],        'じゃがいも'),
  ]);
  const veg = (r, key) => { const v = get(r); return v?.[key] || null; };

  prog('農林業センサスを取得中...');
  const [workersR, bodiesR] = await Promise.allSettled([
    fetchAgriWorkers(client),
    fetchAgriBodies(client),
  ]);

  const result = {
    harvest: {
      rice:    get(riceR)?.harvest    || null,
      wheat:   get(wheatR)?.harvest   || null,
      soybean: get(soybeanR)?.harvest || null,
      tomato:  veg(tomatoR,  'harvest'),
      onion:   veg(onionR,   'harvest'),
      cabbage: veg(cabbageR, 'harvest'),
      potato:  veg(potatoR,  'harvest'),
    },
    area: {
      rice:    get(riceR)?.area    || null,
      wheat:   get(wheatR)?.area   || null,
      soybean: get(soybeanR)?.area || null,
      tomato:  veg(tomatoR,  'area'),
      onion:   veg(onionR,   'area'),
      cabbage: veg(cabbageR, 'area'),
      potato:  veg(potatoR,  'area'),
    },
    workers:    get(workersR),
    agriBodies: get(bodiesR),
    foodBalance,
  };

  const harvestOk = Object.values(result.harvest).filter(Boolean).length;
  const fbOk      = foodBalance ? Object.keys(foodBalance.data).length : 0;
  prog(`取得完了: 食料需給${fbOk}品目 / 収穫量${harvestOk}品目 / 就業者${result.workers ? '✓' : '✗'} / 経営体${result.agriBodies ? '✓' : '✗'}`);
  return result;
}
