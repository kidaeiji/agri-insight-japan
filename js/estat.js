// ===================================================
// e-Stat API クライアント & データ統合モジュール v5
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

  // テーブル一覧を検索
  async searchStats(searchWord, extra = {}) {
    const json = await this._get('getStatsList', { searchWord, limit: 100, ...extra });
    if (json?.GET_STATS_LIST?.RESULT?.STATUS !== 0) return [];
    const raw = json?.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  // 統計データ取得
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

// 単位を統一（万トン・万人・万ha・% に変換）
function normalizeValue(raw, unit) {
  const u = (unit || '').trim().replace(/\s/g, '');
  if (u === 't'   || u === 'トン')  return raw / 10000;
  if (u === '千t' || u === '千トン') return raw / 10;
  if (u === '万t' || u === '万トン') return raw;
  if (u === 'kg')   return raw / 10000000; // kg → 万t
  if (u === '人')   return raw / 10000;
  if (u === '千人') return raw / 10;
  if (u === '万人') return raw;
  if (u === '経営体') return raw / 10000;
  if (u === '千経営体') return raw / 10;
  if (u === '万経営体') return raw;
  if (u === 'ha')   return raw / 10000;
  if (u === '千ha') return raw / 10;
  if (u === '万ha') return raw;
  if (u === 'a')    return raw / 1000000; // a → 万ha
  if (u === '%')    return raw;
  // 単位不明時: 大きな数値は万オーダーに正規化
  if (raw > 100000) return raw / 10000;
  return raw;
}

// VALUES 配列 → { year: value } マップ
// areaCode: null = エリアフィルタなし, '00000' = 全国
function buildYearMap(values, areaCode, catFilters = []) {
  if (!Array.isArray(values) || !values.length) return {};
  const map = {};
  for (const v of values) {
    // エリアフィルタ：値に@areaがある場合のみ適用
    if (areaCode != null && v['@area'] != null && v['@area'] !== areaCode) continue;
    // カテゴリフィルタ：値にキーが存在する場合のみ適用
    if (catFilters.some(f => v[f.key] != null && v[f.key] !== f.value)) continue;
    const raw = parseFloat(v['$']);
    if (isNaN(raw) || raw < 0) continue;
    const year = parseYear(v['@time']);
    if (year < 1990 || year > 2030) continue;
    const val = parseFloat(normalizeValue(raw, v['@unit']).toFixed(4));
    if (val <= 0) continue;
    // 同一年は値が大きいほうを採用（確報>速報 の傾向）
    if (map[year] === undefined || val > map[year]) map[year] = val;
  }
  return map;
}

// { year: value } マップ → ソート済み [{year, value}] 配列
function yearMapToList(yearMap) {
  return Object.entries(yearMap)
    .map(([y, v]) => ({ year: parseInt(y), value: v }))
    .sort((a, b) => a.year - b.year);
}

// [{year,value}] の欠損を線形補間（センサス5年おきデータ用）
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
      const steps = hi - lo;
      const val = parseFloat((map[lo] + (map[hi] - map[lo]) * ((y - lo) / steps)).toFixed(2));
      result.push({ year: y, value: val });
    }
  }
  return result;
}

// CLASS_OBJ から @id 一致を検索
function findClassObj(classObjRaw, id) {
  if (!classObjRaw) return null;
  const arr = Array.isArray(classObjRaw) ? classObjRaw : [classObjRaw];
  return arr.find(c => c['@id'] === id) || null;
}

// CLASS 配列からキーワードにマッチするコードを返す（前方一致優先）
function findCode(classObj, ...keywords) {
  if (!classObj) return null;
  const classes = Array.isArray(classObj.CLASS) ? classObj.CLASS : [classObj.CLASS || []];
  for (const kw of keywords) {
    // 完全一致
    const exact = classes.find(c => c['@name'] === kw);
    if (exact) return exact['@code'];
  }
  for (const kw of keywords) {
    // 前方一致
    const starts = classes.find(c => c['@name']?.startsWith(kw));
    if (starts) return starts['@code'];
  }
  for (const kw of keywords) {
    // 部分一致
    const partial = classes.find(c => c['@name']?.includes(kw));
    if (partial) return partial['@code'];
  }
  return null;
}

// classObj 内の全 @name をログ出力（デバッグ用）
function logClasses(classObj, label) {
  if (!classObj) return;
  const classes = Array.isArray(classObj.CLASS) ? classObj.CLASS : [classObj.CLASS || {}];
  const names = classes.slice(0, 30).map(c => `${c['@code']}=${c['@name']}`).join(', ');
  console.log(`[e-Stat DEBUG] ${label}: ${names}`);
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
  for (const w of bonus)   { if (txt.includes(w)) score += 5; }
  for (const w of penalty) { if (txt.includes(w)) score -= 15; }
  // 新しいほど高スコア
  const d = parseInt(table.SURVEY_DATE || '0', 10);
  score += Math.max(0, Math.floor((d - 200000) / 10000));
  // データ件数が多いほど高スコア（COLLECT_DATE length ≈ 0 なら使えない）
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
    console.log(`[e-Stat] "${searchWord}" → 最高得点: ${scored[0].title} (score=${scored[0].score}, id=${scored[0].id})`);
    return scored[0].id;
  }
  return null;
}

// ===================================================
// データ取得ヘルパー：複数フォールバック戦略
// ===================================================

// フィルタを変えながらデータ取得を試みる
function tryBuildYearMap(values, areaCodes, catFilterSets) {
  for (const areaCode of areaCodes) {
    for (const catFilters of catFilterSets) {
      const map = buildYearMap(values, areaCode, catFilters);
      if (Object.keys(map).length >= 2) {
        console.log(`[e-Stat] 取得成功 area=${areaCode} filters=${JSON.stringify(catFilters)} → ${Object.keys(map).length}年分`);
        return map;
      }
    }
  }
  return {};
}

// ===================================================
// 【食料需給表】品目別: 生産量・消費量・輸入量・自給率
// ===================================================
async function fetchFoodBalance(client) {
  const SEARCH_STRATEGIES = [
    { word: '食料需給表 品目別 国内生産量', must: ['食料需給'], bonus: ['品目別', '国内生産量', '自給率'] },
    { word: '食料需給表 自給率',            must: ['食料需給'], bonus: ['自給率', '国内消費'] },
    { word: '食料需給表',                   must: ['食料需給'], bonus: ['品目', '生産'] },
  ];
  const PENALTY = ['都道府県', '市町村', '地域別'];

  let tableId = null;
  for (const s of SEARCH_STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) {
    console.warn('[e-Stat] 食料需給表テーブル未発見');
    return null;
  }

  let sd;
  try {
    sd = await client.getStatsData(tableId, { cdTimeFrom: '2000000000', cdTimeTo: '2024000000' });
  } catch (e) {
    console.error('[e-Stat] 食料需給表データ取得失敗:', e.message);
    return null;
  }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 食料需給表 VALUES空'); return null; }
  console.log(`[e-Stat] 食料需給表 VALUES件数=${values.length}`);

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01'); // 品目
  const cat02 = findClassObj(classObjs, 'cat02'); // 指標

  if (cat01) logClasses(cat01, '食料需給表 cat01(品目)');
  if (cat02) logClasses(cat02, '食料需給表 cat02(指標)');

  // 品目コード検索キーワード（広め）
  const CROP_KW = {
    rice:    ['米', 'うるち米', '水稲', '米（うるち米）'],
    wheat:   ['小麦'],
    soybean: ['大豆'],
    potato:  ['ばれいしょ', 'じゃがいも', 'バレイショ', 'いも類'],
    onion:   ['たまねぎ', 'タマネギ', '玉ねぎ', '野菜類'],
    cabbage: ['キャベツ', 'きゃべつ'],
    tomato:  ['トマト', 'とまと'],
  };
  const METRIC_KW = {
    production:      ['国内生産量', '生産量', '国内生産'],
    imports:         ['輸入量', '輸入'],
    consumption:     ['国内消費仕向量', '消費仕向量', '国内消費量', '消費量'],
    selfSufficiency: ['自給率', '食料自給率', '自給率（重量ベース）'],
  };

  const result = {};
  const AREA_CODES = ['00000', null, '0', ''];

  for (const [cropKey, cropKws] of Object.entries(CROP_KW)) {
    const cropCode = cat01 ? findCode(cat01, ...cropKws) : null;
    if (!cropCode) {
      console.warn(`[e-Stat] 食料需給表: 品目コード未発見 cropKey=${cropKey}`);
      continue;
    }
    result[cropKey] = {};

    for (const [metricKey, metricKws] of Object.entries(METRIC_KW)) {
      const metricCode = cat02 ? findCode(cat02, ...metricKws) : null;

      const filterSets = [];
      if (metricCode) {
        filterSets.push([{ key: '@cat01', value: cropCode }, { key: '@cat02', value: metricCode }]);
      }
      // メトリクスコード不明でも作物コードだけでトライ
      filterSets.push([{ key: '@cat01', value: cropCode }]);
      filterSets.push([]); // 最後の手段：フィルタなし

      const map = tryBuildYearMap(values, AREA_CODES, filterSets);
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
// ===================================================
async function fetchGrainStats(client, cropKws, cropLabel) {
  const mainWord = cropKws[0];
  const STRATEGIES = [
    { word: `作物統計調査 ${mainWord} 収穫量`, must: ['作物統計'], bonus: [...cropKws, '全国', '収穫'] },
    { word: `作物統計 農作物 ${mainWord}`,     must: ['作物統計'], bonus: [...cropKws, '収穫'] },
    { word: `作物統計 ${mainWord}`,            must: ['作物統計'], bonus: [...cropKws] },
  ];
  const PENALTY = ['市町村', '地域別', '被害'];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn(`[e-Stat] ${cropLabel}テーブル未発見`); return null; }

  let sd;
  try {
    sd = await client.getStatsData(tableId, {
      cdArea: '00000',
      cdTimeFrom: '2000000000',
      cdTimeTo: '2024000000',
    });
  } catch (e) {
    console.error(`[e-Stat] ${cropLabel}取得失敗:`, e.message);
    return null;
  }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn(`[e-Stat] ${cropLabel} VALUES空`); return null; }

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  const cat02 = findClassObj(classObjs, 'cat02');

  if (cat01) logClasses(cat01, `${cropLabel} cat01`);
  if (cat02) logClasses(cat02, `${cropLabel} cat02`);

  const HARVEST_KW = ['収穫量', '収穫'];
  const AREA_KW    = ['作付面積', '栽培面積', '作付(栽培)面積'];

  const buildData = (typeKws) => {
    const typeCode = cat02 ? findCode(cat02, ...typeKws) : null;
    const cropCode = cat01 ? findCode(cat01, ...cropKws) : null;

    const filterSets = [];
    if (cropCode && typeCode) filterSets.push([
      { key: '@cat01', value: cropCode }, { key: '@cat02', value: typeCode }
    ]);
    if (cropCode) filterSets.push([{ key: '@cat01', value: cropCode }]);
    if (typeCode) filterSets.push([{ key: '@cat02', value: typeCode }]);
    filterSets.push([]);

    const map = tryBuildYearMap(values, ['00000', null], filterSets);
    return yearMapToList(map);
  };

  const harvest = buildData(HARVEST_KW);
  const area    = buildData(AREA_KW);

  console.log(`[e-Stat] ${cropLabel} harvest=${harvest.length}年分 area=${area.length}年分`);
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
    { word: `野菜生産出荷統計 ${mainWord}`, must: ['野菜'], bonus: [...vegKws, '全国', '収穫'] },
    { word: `野菜 ${mainWord} 収穫量`,      must: ['野菜'], bonus: [...vegKws, '収穫'] },
  ];
  const PENALTY = ['市町村', '都道府県別', '産地別'];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn(`[e-Stat] ${vegLabel}テーブル未発見`); return null; }

  let sd;
  try {
    sd = await client.getStatsData(tableId, {
      cdArea: '00000',
      cdTimeFrom: '2000000000',
      cdTimeTo: '2024000000',
    });
  } catch (e) {
    console.error(`[e-Stat] ${vegLabel}取得失敗:`, e.message);
    return null;
  }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn(`[e-Stat] ${vegLabel} VALUES空`); return null; }

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  const cat02 = findClassObj(classObjs, 'cat02');

  if (cat01) logClasses(cat01, `${vegLabel} cat01`);
  if (cat02) logClasses(cat02, `${vegLabel} cat02`);

  const vegCode     = cat01 ? findCode(cat01, ...vegKws) : null;
  const harvestCode = cat02 ? findCode(cat02, '収穫量', '収穫') : null;
  const areaCode2   = cat02 ? findCode(cat02, '作付面積', '栽培面積') : null;

  const buildData = (typeCode) => {
    const filterSets = [];
    if (vegCode && typeCode) filterSets.push([
      { key: '@cat01', value: vegCode }, { key: '@cat02', value: typeCode }
    ]);
    if (vegCode) filterSets.push([{ key: '@cat01', value: vegCode }]);
    if (typeCode) filterSets.push([{ key: '@cat02', value: typeCode }]);
    filterSets.push([]);
    return yearMapToList(tryBuildYearMap(values, ['00000', null], filterSets));
  };

  const harvest = buildData(harvestCode);
  const area    = buildData(areaCode2);

  console.log(`[e-Stat] ${vegLabel} harvest=${harvest.length}年分 area=${area.length}年分`);
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
    { word: '農林業センサス 農業就業人口 年齢',    must: ['センサス'], bonus: ['農業就業', '年齢'] },
    { word: '農林業センサス 農業就業人口',          must: ['センサス'], bonus: ['農業就業'] },
    { word: '農林業センサス 農業経営体 農業就業',   must: ['センサス'], bonus: ['就業'] },
  ];
  const PENALTY = ['林業', '水産業', '都道府県別', '市町村'];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn('[e-Stat] 農業就業人口テーブル未発見'); return null; }

  let sd;
  try {
    sd = await client.getStatsData(tableId, { cdArea: '00000' });
  } catch (e) {
    // エリアコードなしで再試行
    try {
      sd = await client.getStatsData(tableId, {});
    } catch (e2) {
      console.error('[e-Stat] 農業就業人口取得失敗:', e2.message);
      return null;
    }
  }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 農業就業人口 VALUES空'); return null; }

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  if (cat01) logClasses(cat01, '農業就業人口 cat01');

  const TOTAL_KW    = ['計', '合計', '総数', '農業就業人口'];
  const UNDER49_KW  = ['49歳以下', '15〜49', '15〜44', '39歳以下', '49歳未満'];
  const AGE5064_KW  = ['50〜64', '50〜59', '60〜64'];
  const OVER65_KW   = ['65歳以上', '65歳〜', '65〜'];

  const buildList = (kws) => {
    const code = cat01 ? findCode(cat01, ...kws) : null;
    const filterSets = code
      ? [[{ key: '@cat01', value: code }], []]
      : [[]];
    const map = tryBuildYearMap(values, ['00000', null], filterSets);
    return interpolateList(yearMapToList(map));
  };

  const total  = buildList(TOTAL_KW);
  const byAge = {
    under49: buildList(UNDER49_KW),
    age5064: buildList(AGE5064_KW),
    over65:  buildList(OVER65_KW),
  };

  // 年齢別がなければ削除
  Object.keys(byAge).forEach(k => { if (!byAge[k].length) delete byAge[k]; });

  console.log(`[e-Stat] 農業就業人口 total=${total.length}年分 byAge=${JSON.stringify(Object.keys(byAge))}`);
  if (!total.length) return null;
  return { total, byAge, source: '農林業センサス（農林水産省）', tableId };
}

// ===================================================
// 【農林業センサス】農業経営体数
// ===================================================
async function fetchAgriBodies(client) {
  const STRATEGIES = [
    { word: '農林業センサス 農業経営体数',       must: ['センサス'], bonus: ['農業経営体', '経営体数'] },
    { word: '農林業センサス 農業経営体 全国',    must: ['センサス'], bonus: ['経営体'] },
    { word: '農林業センサス 農業経営体',         must: ['センサス'], bonus: ['経営体'] },
  ];
  const PENALTY = ['林業', '水産業', '都道府県', '市町村'];

  let tableId = null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn('[e-Stat] 農業経営体数テーブル未発見'); return null; }

  let sd;
  try {
    sd = await client.getStatsData(tableId, { cdArea: '00000' });
  } catch (e) {
    try {
      sd = await client.getStatsData(tableId, {});
    } catch (e2) {
      console.error('[e-Stat] 農業経営体数取得失敗:', e2.message);
      return null;
    }
  }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 農業経営体数 VALUES空'); return null; }

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs, 'cat01');
  if (cat01) logClasses(cat01, '農業経営体数 cat01');

  const TOTAL_KW = ['計', '合計', '総数', '農業経営体数', '農業経営体'];
  const code = cat01 ? findCode(cat01, ...TOTAL_KW) : null;
  const filterSets = code ? [[{ key: '@cat01', value: code }], []] : [[]];
  const map = tryBuildYearMap(values, ['00000', null], filterSets);
  const list = interpolateList(yearMapToList(map));

  console.log(`[e-Stat] 農業経営体数 ${list.length}年分`);
  if (!list.length) return null;
  return { data: list, source: '農林業センサス（農林水産省）', tableId };
}

// ===================================================
// 全データ一括ロード（アプリから呼び出し）
// ===================================================
async function loadAllEStatData(appId, onProgress) {
  const client = new EStatClient(appId);
  const prog = msg => { if (onProgress) onProgress(msg); console.log('[e-Stat]', msg); };

  prog('APIキーを確認中...');
  const test = await client.testConnection();
  if (!test.ok) throw new Error(`接続失敗: ${test.error}`);
  prog('接続OK。データ取得を開始します...');

  // Step 1: 食料需給表（最重要）
  prog('食料需給表を取得中...');
  const foodBalance = await fetchFoodBalance(client);

  // Step 2: 作物統計調査
  prog('作物統計調査を取得中...');
  const [riceR, wheatR, soybeanR] = await Promise.allSettled([
    fetchGrainStats(client, ['水稲', '米', 'うるち米'],  '水稲'),
    fetchGrainStats(client, ['小麦'],                  '小麦'),
    fetchGrainStats(client, ['大豆'],                  '大豆'),
  ]);
  const get = r => r.status === 'fulfilled' ? r.value : null;

  // Step 3: 野菜生産出荷統計
  prog('野菜生産出荷統計を取得中...');
  const [tomatoR, onionR, cabbageR, potatoR] = await Promise.allSettled([
    fetchVegetableStat(client, ['トマト', 'とまと'],            'トマト'),
    fetchVegetableStat(client, ['たまねぎ', 'タマネギ', '玉ねぎ'], 'タマネギ'),
    fetchVegetableStat(client, ['キャベツ', 'きゃべつ'],         'キャベツ'),
    fetchVegetableStat(client, ['ばれいしょ', 'じゃがいも'],     'じゃがいも'),
  ]);
  const veg = (r, key) => { const v = get(r); return v?.[key] || null; };

  // Step 4: 農林業センサス
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
    workers:     get(workersR),
    agriBodies:  get(bodiesR),
    foodBalance,
  };

  const harvestOk = Object.values(result.harvest).filter(Boolean).length;
  const fbOk = foodBalance ? Object.keys(foodBalance.data).length : 0;
  prog(`取得完了: 収穫量${harvestOk}品目, 食料需給表${fbOk}品目, 就業者${result.workers ? '✓' : '✗'}, 経営体${result.agriBodies ? '✓' : '✗'}`);
  return result;
}
