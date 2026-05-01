// ===================================================
// e-Stat API クライアント & データ統合モジュール v8
// 修正内容:
//   1. normalizeUnit() - 全角単位(千ｔ,％,ｈａ)→半角に変換
//   2. buildYearCodeMap() / extractWithCatYear() - 年がカテゴリに入るテーブル対応
//   3. parseMetricYearCat() - 野菜テーブルの cat2='収穫量_YYYY年産' 形式対応
//   4. tryByUnit/tryByUnitWithFallback に minPoints パラメータ追加（センサス=1点OK）
// ===================================================

const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json';

class EStatClient {
  constructor(appId) { this.appId = appId; this._cache = {}; }

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
        ? { ok: true } : { ok: false, error: json?.GET_STATS_LIST?.RESULT?.ERROR_MSG || '不明なエラー' };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async searchStats(searchWord, extra = {}) {
    const json = await this._get('getStatsList', { searchWord, limit: 100, ...extra });
    if (json?.GET_STATS_LIST?.RESULT?.STATUS !== 0) return [];
    const raw = json?.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  async getStatsData(statsDataId, params = {}) {
    const json = await this._get('getStatsData', { statsDataId, metaGetFlg: 'Y', cntGetFlg: 'N', ...params });
    const result = json?.GET_STATS_DATA?.RESULT;
    if (result?.STATUS !== 0) throw new Error(result?.ERROR_MSG || 'データ取得エラー');
    return json.GET_STATS_DATA.STATISTICAL_DATA;
  }
}

// ===================================================
// ユーティリティ
// ===================================================
function parseYear(code) { return parseInt(String(code).slice(0, 4), 10); }

// Fix 1: 全角ASCII → 半角変換（e-Stat は '千ｔ','％','ｈａ' などの全角単位を返す）
function normalizeUnit(unit) {
  return (unit || '').trim()
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '');
}

function normalizeValue(raw, unit) {
  const u = normalizeUnit(unit); // 全角→半角を内部でも適用
  if (u === 't'   || u === 'トン')   return raw / 10000;
  if (u === '千t' || u === '千トン') return raw / 10;
  if (u === '万t' || u === '万トン') return raw;
  if (u === 'kg')    return raw / 10000000;
  if (u === '人')    return raw / 10000;
  if (u === '千人')  return raw / 10;
  if (u === '万人')  return raw;
  if (u === '経営体')   return raw / 10000;
  if (u === '千経営体') return raw / 10;
  if (u === '万経営体') return raw;
  if (u === 'ha')   return raw / 10000;
  if (u === '千ha') return raw / 10;
  if (u === '万ha') return raw;
  if (u === 'a')    return raw / 1000000;
  if (u === '%')    return raw;
  if (raw > 100000) return raw / 10000;
  return raw;
}

// ===================================================
// 単位タイプベースフィルタ
// ===================================================
const UNIT_SETS = {
  weight:  new Set(['t','トン','千t','千トン','万t','万トン','kg']),
  area:    new Set(['ha','千ha','万ha','a']),
  percent: new Set(['%']),
  people:  new Set(['人','千人','万人']),
  body:    new Set(['経営体','千経営体','万経営体']),
};

const ALL_AREA_CODES = ['00000','00','0','000','0000','000000',null];

function buildYearMapByUnit(values, unitType, areaCode, catFilters) {
  if (!Array.isArray(values) || !values.length) return {};
  const accepted = UNIT_SETS[unitType] || new Set();
  catFilters = catFilters || [];
  const map = {};
  for (const v of values) {
    const unit = normalizeUnit(v['@unit']); // Fix 1: normalizeUnit
    if (accepted.size > 0 && !accepted.has(unit)) continue;
    const raw = parseFloat(v['$']);
    if (isNaN(raw) || raw < 0) continue;
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

function buildYearMapNoUnit(values, areaCode, catFilters) {
  if (!Array.isArray(values) || !values.length) return {};
  catFilters = catFilters || [];
  const map = {};
  for (const v of values) {
    const raw = parseFloat(v['$']);
    if (isNaN(raw) || raw < 0) continue;
    if (areaCode != null && v['@area'] != null && v['@area'] !== areaCode) continue;
    if (catFilters.some(f => v[f.key] != null && v[f.key] !== f.value)) continue;
    const year = parseYear(v['@time']);
    if (year < 1990 || year > 2030) continue;
    const unit = normalizeUnit(v['@unit']); // Fix 1
    const val = parseFloat(normalizeValue(raw, unit).toFixed(4));
    if (val <= 0) continue;
    if (map[year] === undefined || val > map[year]) map[year] = val;
  }
  return map;
}

// 複数コードを年ごとに合計（年齢別就業者の集計用）
function sumCodesPerYear(values, catKey, codes, extraFilter, areaCodes) {
  const sums = {};
  for (const code of codes) {
    const filters = [{ key: catKey, value: code }];
    if (extraFilter) filters.push(extraFilter);
    let found = false;
    for (const ac of areaCodes) {
      const m = buildYearMapNoUnit(values, ac, filters);
      if (Object.keys(m).length > 0) {
        for (const [y, v] of Object.entries(m)) sums[y] = (sums[y] || 0) + v;
        found = true; break;
      }
    }
    if (!found) {
      const m = buildYearMapNoUnit(values, null, [{ key: catKey, value: code }]);
      for (const [y, v] of Object.entries(m)) sums[y] = (sums[y] || 0) + v;
    }
  }
  return sums;
}

// Fix 4: minPoints パラメータを追加
function tryByUnit(values, unitType, areaCodes, catFilterSets, minPoints = 2) {
  for (const ac of areaCodes) {
    for (const cf of catFilterSets) {
      const m = buildYearMapByUnit(values, unitType, ac, cf);
      if (Object.keys(m).length >= minPoints) {
        console.log(`[e-Stat] OK unit=${unitType} area=${ac} → ${Object.keys(m).length}年`);
        return m;
      }
    }
  }
  return {};
}

function tryByUnitWithFallback(values, unitType, areaCodes, catFilterSets, minPoints = 2) {
  const m = tryByUnit(values, unitType, areaCodes, catFilterSets, minPoints);
  if (Object.keys(m).length >= minPoints) return m;
  for (const ac of areaCodes) {
    for (const cf of catFilterSets) {
      const m2 = buildYearMapNoUnit(values, ac, cf);
      if (Object.keys(m2).length >= minPoints) {
        console.log(`[e-Stat] OK (no-unit fallback) area=${ac} → ${Object.keys(m2).length}年`);
        return m2;
      }
    }
  }
  return {};
}

// ===================================================
// Fix 2: 年カテゴリ対応ユーティリティ
// （@time が無効で年がカテゴリ名に埋め込まれているテーブル用）
// ===================================================

// カテゴリ名から年度→コード逆引きマップを構築
// 例: '2020年度' → { '001': 2020 }
function buildYearCodeMap(classObj) {
  const cls = getClasses(classObj);
  const map = {};
  for (const c of cls) {
    const name = c['@name'] || '';
    let year = null;
    const m1 = name.match(/(\d{4})年度?/);   if (m1) year = parseInt(m1[1]);
    const m2 = name.match(/\((\d{4})\)/);    if (m2 && !year) year = parseInt(m2[1]);
    const m3 = name.match(/^(\d{4})年産/);   if (m3 && !year) year = parseInt(m3[1]);
    if (year && year >= 1900 && year <= 2030) map[c['@code']] = year;
  }
  return Object.keys(map).length > 0 ? map : null;
}

// @time が有効な年データを持つか確認
function hasValidTimeData(values, sampleSize = 80) {
  if (!Array.isArray(values) || !values.length) return false;
  const sample = values.slice(0, sampleSize);
  const valid = sample.filter(v => {
    const y = parseYear(v['@time']);
    return y >= 1990 && y <= 2030;
  });
  return valid.length >= Math.min(5, Math.ceil(sample.length * 0.4));
}

// 年カテゴリキーを使って年ごとにマップを構築
function buildYearMapByCatYear(values, catYearKey, yearCodeMap, unitType, areaCode, catFilters) {
  if (!Array.isArray(values) || !values.length) return {};
  const accepted = UNIT_SETS[unitType] || new Set();
  catFilters = catFilters || [];
  const map = {};
  for (const v of values) {
    const catCode = v[catYearKey];
    const year = yearCodeMap[catCode];
    if (!year || year < 1990 || year > 2030) continue;
    const unit = normalizeUnit(v['@unit']);
    if (accepted.size > 0 && !accepted.has(unit)) continue;
    const raw = parseFloat(v['$']);
    if (isNaN(raw) || raw < 0) continue;
    if (unitType === 'percent' && raw > 1000) continue;
    if (areaCode != null && v['@area'] != null && v['@area'] !== areaCode) continue;
    if (catFilters.some(f => v[f.key] != null && v[f.key] !== f.value)) continue;
    const val = parseFloat(normalizeValue(raw, unit).toFixed(4));
    if (val <= 0) continue;
    if (map[year] === undefined || val > map[year]) map[year] = val;
  }
  return map;
}

// 年カテゴリ次元を自動検出して年マップを返す汎用ヘルパー
function extractWithCatYear(values, classObjs, unitType, cropCatKey, cropCode, minPoints = 1) {
  for (const catId of ['cat01', 'cat02', 'cat03']) {
    const obj = findClassObj(classObjs, catId);
    if (!obj) continue;
    const yearMap = buildYearCodeMap(obj);
    if (!yearMap || Object.keys(yearMap).length < 2) continue;
    const catYearKey = '@' + catId;

    const catFilters = [];
    if (cropCode && cropCatKey && cropCatKey !== catYearKey) {
      catFilters.push({ key: cropCatKey, value: cropCode });
    }

    // エリアコードを試す
    for (const ac of ALL_AREA_CODES) {
      const m = buildYearMapByCatYear(values, catYearKey, yearMap, unitType, ac, catFilters);
      if (Object.keys(m).length >= minPoints) {
        console.log(`[e-Stat] OK(catYear cat=${catId}) area=${ac} → ${Object.keys(m).length}年`);
        return m;
      }
    }
    // エリアフィルタなし
    const m = buildYearMapByCatYear(values, catYearKey, yearMap, unitType, null, catFilters);
    if (Object.keys(m).length >= minPoints) {
      console.log(`[e-Stat] OK(catYear/noArea cat=${catId}) → ${Object.keys(m).length}年`);
      return m;
    }
  }
  return {};
}

// ===================================================
// Fix 3: cat2='指標_YYYY年産' 形式のパース（野菜統計テーブル用）
// ===================================================
function parseMetricYearCat(classObj) {
  const cls = getClasses(classObj);
  const result = [];
  for (const c of cls) {
    const name = c['@name'] || '';
    // '収穫量_2015年産' or '作付面積_2015年産' 形式
    const m = name.match(/^(.+)[_＿](\d{4})年産?$/);
    if (m) result.push({ code: c['@code'], metric: m[1].trim(), year: parseInt(m[2]) });
  }
  return result;
}

// cat2-year エントリのコード→年マップから値を集計
function buildYearMapFromCat2Year(values, codeToYear, unitType, cropCatKey, cropCode) {
  const accepted = UNIT_SETS[unitType] || new Set();
  const map = {};
  for (const v of values) {
    if (cropCode && v[cropCatKey] !== cropCode) continue;
    const year = codeToYear[v['@cat02']];
    if (!year || year < 1990 || year > 2030) continue;
    const unit = normalizeUnit(v['@unit']);
    if (accepted.size > 0 && !accepted.has(unit) && unit !== '') continue;
    const raw = parseFloat(v['$']);
    if (isNaN(raw) || raw <= 0) continue;
    const val = parseFloat(normalizeValue(raw, unit).toFixed(4));
    if (val <= 0) continue;
    if (map[year] === undefined || val > map[year]) map[year] = val;
  }
  return map;
}

// ===================================================
// CLASS_OBJ ユーティリティ
// ===================================================
function findClassObj(raw, id) {
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.find(c => c['@id'] === id) || null;
}

function getClasses(classObj) {
  if (!classObj) return [];
  return Array.isArray(classObj.CLASS) ? classObj.CLASS : (classObj.CLASS ? [classObj.CLASS] : []);
}

function findCode(classObj, ...keywords) {
  const cls = getClasses(classObj);
  for (const kw of keywords) {
    const e = cls.find(c => c['@name'] === kw); if (e) return e['@code'];
  }
  for (const kw of keywords) {
    const e = cls.find(c => c['@name']?.startsWith(kw)); if (e) return e['@code'];
  }
  for (const kw of keywords) {
    const e = cls.find(c => c['@name']?.includes(kw)); if (e) return e['@code'];
  }
  return null;
}

function logClasses(classObj, label) {
  const cls = getClasses(classObj);
  console.log(`[e-Stat DEBUG] ${label}: ${cls.slice(0,40).map(c=>`${c['@code']}=${c['@name']}`).join(' | ')}`);
}

function yearMapToList(map) {
  return Object.entries(map).map(([y,v]) => ({year:parseInt(y),value:v})).sort((a,b)=>a.year-b.year);
}

function interpolateList(list) {
  if (list.length < 2) return list;
  const minY=list[0].year, maxY=list[list.length-1].year;
  const m = Object.fromEntries(list.map(d=>[d.year,d.value]));
  const res=[];
  for (let y=minY; y<=maxY; y++) {
    if (m[y]!==undefined) { res.push({year:y,value:m[y]}); continue; }
    let lo=y-1, hi=y+1;
    while(lo>=minY && m[lo]===undefined) lo--;
    while(hi<=maxY && m[hi]===undefined) hi++;
    if(m[lo]!==undefined && m[hi]!==undefined) {
      res.push({year:y, value:parseFloat((m[lo]+(m[hi]-m[lo])*((y-lo)/(hi-lo))).toFixed(2))});
    }
  }
  return res;
}

// ===================================================
// テーブル選択（スコアリング）
// ===================================================
function scoreTable(table, must, bonus, penalty=[]) {
  const txt = [table.STATISTICS_NAME||'', table.TITLE?.['$']||table.TITLE||'', table.SURVEY_DATE||''].join(' ');
  let score=0;
  for (const w of must)    { if (!txt.includes(w)) return -9999; score+=10; }
  for (const w of bonus)   { if (txt.includes(w))  score+=5; }
  for (const w of penalty) { if (txt.includes(w))  score-=15; }
  if (/\d+年産/.test(txt)) score -= 30;
  // SURVEY_DATE は YYYYMM 形式（例:'202312'）→ 先頭4桁を年として取得
  // 旧コードは 8桁想定の計算式で 2000年以降すべてスコア0になるバグがあったため修正
  const sd = String(table.SURVEY_DATE || '0').replace(/\D/g, '');
  const surveyYear = sd.length >= 4 ? parseInt(sd.slice(0, 4), 10) : 0;
  if (surveyYear >= 1990 && surveyYear <= 2030) {
    score += (surveyYear - 1990) * 2; // 1990→0, 2000→20, 2015→50, 2023→66
  }
  return score;
}

async function findBestTableId(client, searchWord, must, bonus=[], penalty=[]) {
  const tables = await client.searchStats(searchWord);
  if (!tables.length) { console.warn(`[e-Stat] "${searchWord}" 検索結果なし`); return null; }
  const scored = tables
    .map(t => ({ id:t['@id'], score:scoreTable(t,must,bonus,penalty), title:t.TITLE?.['$']||t.TITLE||'' }))
    .filter(x => x.score > -9999)
    .sort((a,b) => b.score-a.score);
  if (scored.length) {
    console.log(`[e-Stat] "${searchWord}" → ${scored[0].title} (score=${scored[0].score}, id=${scored[0].id})`);
    return scored[0].id;
  }
  return null;
}

async function fetchTableData(client, tableId, extraParams={}) {
  const tries = [
    { cdTimeFrom:'2000000000', cdTimeTo:'2030000000', ...extraParams },
    { ...extraParams },
  ];
  for (const params of tries) {
    try {
      const sd = await client.getStatsData(tableId, params);
      const values = sd?.DATA_INF?.VALUE;
      if (Array.isArray(values) && values.length>=2) return sd;
    } catch(e) {
      console.warn(`[e-Stat] fetch失敗 id=${tableId}: ${e.message}`);
    }
  }
  return null;
}

// ===================================================
// 【食料需給表】各指標を専用検索で取得
// ===================================================
async function fetchFoodBalance(client) {
  const METRIC_STRATEGIES = {
    production: [
      { word:'食料需給表 国内生産量 品目別', must:['食料需給'], bonus:['国内生産量','品目'], penalty:['内訳','穀類の','飼料'] },
      { word:'食料需給表 品目別累年 国内生産量', must:['食料需給','累年'], bonus:['品目','生産'] },
    ],
    imports: [
      { word:'食料需給表 輸入量 品目別', must:['食料需給'], bonus:['輸入量','品目'], penalty:['内訳','穀類の'] },
      { word:'食料需給表 品目別累年 輸入量', must:['食料需給','累年'], bonus:['品目','輸入'] },
    ],
    consumption: [
      { word:'食料需給表 国内消費仕向量 品目別', must:['食料需給'], bonus:['国内消費','品目'], penalty:['内訳','穀類の'] },
      { word:'食料需給表 消費 品目別', must:['食料需給'], bonus:['消費','品目'] },
    ],
    selfSufficiency: [
      { word:'食料自給率 品目別',        must:['自給率'],  bonus:['品目','食料'], penalty:['内訳'] },
      { word:'食料需給表 自給率 品目別', must:['食料需給','自給率'], bonus:['品目'],  penalty:['内訳'] },
      { word:'食料需給表 食料自給率',    must:['食料需給'], bonus:['自給率'],          penalty:['内訳'] },
    ],
  };

  const CROP_KW = {
    rice:    ['米','うるち米','水稲','米（うるち米）'],
    wheat:   ['小麦'],
    soybean: ['大豆'],
    potato:  ['ばれいしょ','じゃがいも','バレイショ','いも類'],
    onion:   ['たまねぎ','タマネギ','玉ねぎ'],
    cabbage: ['キャベツ','きゃべつ'],
    tomato:  ['トマト','とまと'],
  };
  const UNIT_FOR = {
    production:'weight', imports:'weight', consumption:'weight', selfSufficiency:'percent',
  };

  const metricData = {};

  for (const [metricKey, strategies] of Object.entries(METRIC_STRATEGIES)) {
    let tableId=null;
    for (const s of strategies) {
      tableId = await findBestTableId(client, s.word, s.must, s.bonus||[], s.penalty||[]);
      if (tableId) break;
    }
    if (!tableId) { console.warn(`[e-Stat] 食料需給表:${metricKey} テーブル未発見`); continue; }

    const sd = await fetchTableData(client, tableId);
    if (!sd) { console.warn(`[e-Stat] 食料需給表:${metricKey} データ取得失敗`); continue; }

    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) continue;
    console.log(`[e-Stat] 食料需給表:${metricKey} VALUES=${values.length} id=${tableId}`);

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const allCats = ['cat01','cat02','cat03'].map(id => ({ id, obj: findClassObj(classObjs, id) })).filter(x=>x.obj);
    allCats.forEach(c => logClasses(c.obj, `食料需給表:${metricKey} ${c.id}`));

    // Fix 2: @time が有効かチェック。無効ならカテゴリから年を取る
    const timeValid = hasValidTimeData(values);
    console.log(`[e-Stat] 食料需給表:${metricKey} timeValid=${timeValid}`);

    const unitType = UNIT_FOR[metricKey];
    metricData[metricKey] = {};

    for (const [cropKey, cropKws] of Object.entries(CROP_KW)) {
      let cropCode=null, cropCatKey=null;
      for (const {id, obj} of allCats) {
        const c = findCode(obj, ...cropKws);
        if (c) { cropCode=c; cropCatKey='@'+id; break; }
      }

      let map = {};

      if (timeValid) {
        // 通常アプローチ（Fix 1 により全角単位も正しく比較される）
        const catFilterSets = [];
        if (cropCode) catFilterSets.push([{key:cropCatKey, value:cropCode}]);
        catFilterSets.push([]);
        map = tryByUnit(values, unitType, ALL_AREA_CODES, catFilterSets);
      }

      // @time が無効、または通常アプローチで取得できなかった場合はカテゴリ年で再試行
      if (Object.keys(map).length < 2) {
        const catMap = extractWithCatYear(values, classObjs, unitType, cropCatKey, cropCode);
        if (Object.keys(catMap).length >= 2) map = catMap;
      }

      const list = yearMapToList(map);
      if (list.length >= 2) metricData[metricKey][cropKey] = list;
    }
    console.log(`[e-Stat] 食料需給表:${metricKey} 取得品目=${Object.keys(metricData[metricKey]).join(',')}`);
  }

  const result = {};
  for (const [metricKey, cropMap] of Object.entries(metricData)) {
    for (const [cropKey, list] of Object.entries(cropMap)) {
      if (!result[cropKey]) result[cropKey] = {};
      result[cropKey][metricKey] = list;
    }
  }

  const found = Object.keys(result).length;
  console.log(`[e-Stat] 食料需給表 最終品目数=${found}`, Object.keys(result));
  if (!found) return null;
  return { data:result, source:'食料需給表（農林水産省）', tableId:'(複数)' };
}

// ===================================================
// 【作物統計調査】穀物
// ===================================================
async function fetchGrainStats(client, cropKws, cropLabel) {
  const main = cropKws[0];
  const STRATEGIES = [
    { word:`作物統計 ${main} 全国 累年`,      must:['作物統計'], bonus:[...cropKws,'累年','全国'], penalty:['品種別','産地品種','都道府県別','市町村'] },
    { word:`作物統計 ${main} 収穫量 全国`,    must:['作物統計'], bonus:[...cropKws,'収穫','全国'], penalty:['品種別','産地品種','都道府県別','市町村'] },
    { word:`作物統計調査 ${main} 収穫量`,     must:['作物統計'], bonus:[...cropKws,'収穫'],        penalty:['品種別','産地品種','市町村'] },
    { word:`作物統計 農作物 ${main}`,          must:['作物統計'], bonus:[...cropKws],              penalty:['品種別','産地品種','市町村'] },
  ];

  let tableId=null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, s.penalty||[]);
    if (tableId) break;
  }
  if (!tableId) { console.warn(`[e-Stat] ${cropLabel} テーブル未発見`); return null; }

  const sd = await fetchTableData(client, tableId);
  if (!sd) { console.warn(`[e-Stat] ${cropLabel} データ取得失敗`); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn(`[e-Stat] ${cropLabel} VALUES空`); return null; }

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs,'cat01');
  const cat02 = findClassObj(classObjs,'cat02');
  if (cat01) logClasses(cat01, `${cropLabel} cat01`);
  if (cat02) logClasses(cat02, `${cropLabel} cat02`);

  let cropCode=null, cropCatKey=null;
  for (const [id,obj] of [['@cat01',cat01],['@cat02',cat02]]) {
    if (!obj) continue;
    const c = findCode(obj,...cropKws);
    if (c) { cropCode=c; cropCatKey=id; break; }
  }
  const cropFilter = cropCode ? [{key:cropCatKey, value:cropCode}] : [];
  const filterSets = cropFilter.length ? [cropFilter,[]] : [[]];

  let harvest = yearMapToList(tryByUnit(values,'weight',ALL_AREA_CODES,filterSets));
  let area    = yearMapToList(tryByUnit(values,'area',  ALL_AREA_CODES,filterSets));

  // Fix 2: 通常アプローチ失敗時はカテゴリ年で再試行
  if (!harvest.length) {
    const m = extractWithCatYear(values, classObjs, 'weight', cropCatKey, cropCode);
    harvest = yearMapToList(m);
  }
  if (!area.length) {
    const m = extractWithCatYear(values, classObjs, 'area', cropCatKey, cropCode);
    area = yearMapToList(m);
  }

  console.log(`[e-Stat] ${cropLabel} harvest=${harvest.length}年 area=${area.length}年`);
  if (!harvest.length) return null;

  return {
    harvest: { data:harvest, source:'作物統計調査（農林水産省）', tableId },
    area:    area.length ? { data:area, source:'作物統計調査（農林水産省）', tableId } : null,
  };
}

// ===================================================
// 【野菜生産出荷統計】
// ===================================================
async function fetchVegetableStat(client, vegKws, vegLabel) {
  const main = vegKws[0];
  const STRATEGIES = [
    { word:`野菜生産出荷統計 ${main} 全国 累年`, must:['野菜'], bonus:[...vegKws,'累年','全国'], penalty:['都道府県別','産地別','市町村'] },
    { word:`野菜生産出荷統計 ${main} 全国`,      must:['野菜'], bonus:[...vegKws,'全国','収穫'], penalty:['都道府県別','産地別','市町村'] },
    { word:`野菜生産出荷統計 ${main}`,           must:['野菜'], bonus:[...vegKws,'収穫'],        penalty:['産地別','市町村'] },
    { word:`野菜生産出荷統計 主要野菜 全国`,     must:['野菜'], bonus:[...vegKws,'収穫','全国'], penalty:['産地別','市町村'] },
  ];

  let tableId=null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, s.penalty||[]);
    if (tableId) break;
  }
  if (!tableId) { console.warn(`[e-Stat] ${vegLabel} テーブル未発見`); return null; }

  const sd = await fetchTableData(client, tableId);
  if (!sd) { console.warn(`[e-Stat] ${vegLabel} データ取得失敗`); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn(`[e-Stat] ${vegLabel} VALUES空`); return null; }
  console.log(`[e-Stat] ${vegLabel} VALUES=${values.length} id=${tableId}`);

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs,'cat01');
  const cat02 = findClassObj(classObjs,'cat02');
  if (cat01) logClasses(cat01, `${vegLabel} cat01`);
  if (cat02) logClasses(cat02, `${vegLabel} cat02`);

  let vegCode=null, vegCatKey=null;
  for (const [id,obj] of [['@cat01',cat01],['@cat02',cat02]]) {
    if (!obj) continue;
    const c = findCode(obj,...vegKws);
    if (c) { vegCode=c; vegCatKey=id; break; }
  }
  const vegFilter = vegCode ? [{key:vegCatKey, value:vegCode}] : [];
  const filterSets = vegFilter.length ? [vegFilter,[]] : [[]];

  let harvestFinal = yearMapToList(tryByUnit(values,'weight',ALL_AREA_CODES,filterSets));
  let areaFinal    = yearMapToList(tryByUnit(values,'area',  ALL_AREA_CODES,filterSets));

  // 都道府県別テーブルで国コードが見つからない場合: 都道府県合計を算出
  if (!harvestFinal.length) {
    console.log(`[e-Stat] ${vegLabel} 国コードNG→都道府県合計を試みる`);
    const sumMap = {};
    for (const v of values) {
      const unit = normalizeUnit(v['@unit']); // Fix 1
      if (!UNIT_SETS.weight.has(unit)) continue;
      if (vegFilter.length && vegFilter.some(f=>v[f.key]!=null&&v[f.key]!==f.value)) continue;
      const raw=parseFloat(v['$']); if(isNaN(raw)||raw<=0) continue;
      const year=parseYear(v['@time']); if(year<1990||year>2030) continue;
      const val=parseFloat(normalizeValue(raw,unit).toFixed(4)); if(val<=0) continue;
      sumMap[year]=(sumMap[year]||0)+val;
    }
    const sumList=yearMapToList(sumMap);
    if(sumList.length>=2) harvestFinal=sumList;
  }
  if (!areaFinal.length) {
    const sumMap={};
    for (const v of values) {
      const unit = normalizeUnit(v['@unit']); // Fix 1
      if (!UNIT_SETS.area.has(unit)) continue;
      if (vegFilter.length && vegFilter.some(f=>v[f.key]!=null&&v[f.key]!==f.value)) continue;
      const raw=parseFloat(v['$']); if(isNaN(raw)||raw<=0) continue;
      const year=parseYear(v['@time']); if(year<1990||year>2030) continue;
      const val=parseFloat(normalizeValue(raw,unit).toFixed(4)); if(val<=0) continue;
      sumMap[year]=(sumMap[year]||0)+val;
    }
    const sumList=yearMapToList(sumMap);
    if(sumList.length>=2) areaFinal=sumList;
  }

  // Fix 3: cat2='収穫量_YYYY年産' 形式のフォールバック
  if (!harvestFinal.length && cat02) {
    const metricYears = parseMetricYearCat(cat02);
    if (metricYears.length > 0) {
      console.log(`[e-Stat] ${vegLabel} cat2-year形式を試みる (${metricYears.length}エントリ)`);
      const harvestEntries = metricYears.filter(e => e.metric.includes('収穫量'));
      const areaEntries    = metricYears.filter(e => e.metric.includes('作付面積') || e.metric.includes('収穫面積'));

      if (harvestEntries.length > 0) {
        const codeToYear = Object.fromEntries(harvestEntries.map(e => [e.code, e.year]));
        const hmap = buildYearMapFromCat2Year(values, codeToYear, 'weight', vegCatKey||'@cat01', vegCode);
        const hlist = yearMapToList(hmap);
        if (hlist.length >= 1) harvestFinal = hlist;
      }

      if (!areaFinal.length && areaEntries.length > 0) {
        const codeToYear = Object.fromEntries(areaEntries.map(e => [e.code, e.year]));
        const amap = buildYearMapFromCat2Year(values, codeToYear, 'area', vegCatKey||'@cat01', vegCode);
        const alist = yearMapToList(amap);
        if (alist.length >= 1) areaFinal = alist;
      }
    }
  }

  console.log(`[e-Stat] ${vegLabel} harvest=${harvestFinal.length}年 area=${areaFinal.length}年`);
  if (!harvestFinal.length) return null;

  return {
    harvest:{ data:harvestFinal, source:'野菜生産出荷統計（農林水産省）', tableId },
    area:   areaFinal.length ? { data:areaFinal, source:'野菜生産出荷統計（農林水産省）', tableId } : null,
  };
}

// ===================================================
// 【農林業センサス】農業就業人口（年齢別）
// ===================================================
async function fetchAgriWorkers(client) {
  const STRATEGIES = [
    { word:'農林業センサス 農業就業人口 年齢別 累年', must:['センサス'], bonus:['就業','年齢','累年'] },
    { word:'農林業センサス 農業就業人口 年齢',        must:['センサス'], bonus:['就業','年齢'] },
    { word:'農林業センサス 農業就業人口',             must:['センサス'], bonus:['就業','農業'] },
    { word:'農林業センサス 農業就業者 年齢',          must:['センサス'], bonus:['就業','年齢'] },
    { word:'農林業センサス 農業就業者',               must:['センサス'], bonus:['就業'] },
    { word:'センサス 農業就業人口',                   must:['センサス','就業'], bonus:['農業'] },
    { word:'農林業センサス 就業構造 年齢',            must:['センサス'], bonus:['就業','年齢'] },
    { word:'農林業センサス 就業構造',                 must:['センサス'], bonus:['就業'] },
  ];
  const PENALTY = ['林業のみ','漁業','水産業','市町村'];

  let tableId=null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn('[e-Stat] 農業就業人口テーブル未発見'); return null; }

  const sd = await fetchTableData(client, tableId);
  if (!sd) { console.warn('[e-Stat] 農業就業人口データ取得失敗'); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 農業就業人口 VALUES空'); return null; }
  console.log(`[e-Stat] 農業就業人口 VALUES=${values.length} id=${tableId}`);

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs,'cat01');
  const cat02 = findClassObj(classObjs,'cat02');
  if (cat01) logClasses(cat01,'農業就業人口 cat01');
  if (cat02) logClasses(cat02,'農業就業人口 cat02');

  const genderTotalCode = cat02 ? findCode(cat02,'合計','計','総数') : null;
  const genderFilter = (cat02 && genderTotalCode) ? {key:'@cat02', value:genderTotalCode} : null;

  const TOTAL_KW=['計','合計','総数','農業就業人口','農業就業者数'];
  let totalCode=null, totalCatKey=null;
  for (const [id,obj] of [['@cat01',cat01],['@cat02',cat02]]) {
    if (!obj) continue;
    const c=findCode(obj,...TOTAL_KW); if(c){totalCode=c;totalCatKey=id;break;}
  }

  // Fix 4: センサスは1点でもOK（minPoints=1）
  const buildTotal = () => {
    const catFilterSets=[];
    if (totalCode) {
      const f=[{key:totalCatKey,value:totalCode}];
      if(genderFilter && totalCatKey!=='@cat02') f.push(genderFilter);
      catFilterSets.push(f);
    }
    catFilterSets.push([]);
    return yearMapToList(tryByUnitWithFallback(values,'people',ALL_AREA_CODES,catFilterSets,1));
  };

  const cls1 = getClasses(cat01);
  const ageCodeGroups = { under49:[], age5064:[], over65:[] };
  for (const c of cls1) {
    const n = c['@name']||'';
    const m = n.match(/^(\d+)[\s～〜~ー]+(\d+)歳/);
    if (m) {
      const lo=parseInt(m[1]);
      if (lo<50)      ageCodeGroups.under49.push(c['@code']);
      else if (lo<65) ageCodeGroups.age5064.push(c['@code']);
      else            ageCodeGroups.over65.push(c['@code']);
      continue;
    }
    const m2 = n.match(/^(\d+)歳以上/);
    if (m2 && parseInt(m2[1])>=65) { ageCodeGroups.over65.push(c['@code']); continue; }
    if (/49歳以下|15〜49|15～49/.test(n)) ageCodeGroups.under49.push(c['@code']);
    if (/50〜64|50～64/.test(n))          ageCodeGroups.age5064.push(c['@code']);
    if (/65歳以上|65〜|65～/.test(n))     ageCodeGroups.over65.push(c['@code']);
  }
  console.log('[e-Stat] 農業就業人口 年齢帯コード', JSON.stringify(ageCodeGroups));

  const buildAgeGroup = (codes) => {
    if (!codes.length) return [];
    const sums = sumCodesPerYear(values,'@cat01',codes,genderFilter,ALL_AREA_CODES);
    return interpolateList(yearMapToList(sums));
  };

  const total   = interpolateList(buildTotal());
  const under49 = buildAgeGroup(ageCodeGroups.under49);
  const age5064 = buildAgeGroup(ageCodeGroups.age5064);
  const over65  = buildAgeGroup(ageCodeGroups.over65);

  const byAge={};
  if(under49.length) byAge.under49=under49;
  if(age5064.length) byAge.age5064=age5064;
  if(over65.length)  byAge.over65=over65;

  let finalTotal=total;
  if (!total.length && Object.keys(byAge).length===3) {
    const allYears=[...new Set([...under49,...age5064,...over65].map(d=>d.year))].sort((a,b)=>a-b);
    const sums={};
    for(const y of allYears){
      const s=(under49.find(d=>d.year===y)?.value||0)+(age5064.find(d=>d.year===y)?.value||0)+(over65.find(d=>d.year===y)?.value||0);
      if(s>0) sums[y]=parseFloat(s.toFixed(2));
    }
    finalTotal=interpolateList(yearMapToList(sums));
    console.log('[e-Stat] 農業就業人口 年齢別合計から再構成');
  }

  console.log(`[e-Stat] 農業就業人口 total=${finalTotal.length}年 byAge=${JSON.stringify(Object.keys(byAge))}`);
  if (!finalTotal.length) return null;
  return { total:finalTotal, byAge, source:'農林業センサス（農林水産省）', tableId };
}

// ===================================================
// 【農林業センサス】農業経営体数
// ===================================================
async function fetchAgriBodies(client) {
  const STRATEGIES = [
    { word:'農林業センサス 農業経営体数 累年',  must:['センサス'], bonus:['農業経営体','累年'] },
    { word:'農林業センサス 農業経営体数',       must:['センサス'], bonus:['農業経営体','経営体数'] },
    { word:'農林業センサス 農業経営体 全国',    must:['センサス'], bonus:['経営体','全国'] },
    { word:'農林業センサス 農業経営体',         must:['センサス'], bonus:['経営体'] },
    { word:'センサス 農業経営体数',            must:['センサス','経営体'], bonus:[] },
  ];
  const PENALTY=['林業のみ','漁業','水産業','市町村'];

  let tableId=null;
  for (const s of STRATEGIES) {
    tableId = await findBestTableId(client, s.word, s.must, s.bonus, PENALTY);
    if (tableId) break;
  }
  if (!tableId) { console.warn('[e-Stat] 農業経営体数テーブル未発見'); return null; }

  const sd = await fetchTableData(client, tableId);
  if (!sd) { console.warn('[e-Stat] 農業経営体数データ取得失敗'); return null; }

  const values = sd?.DATA_INF?.VALUE;
  if (!values?.length) { console.warn('[e-Stat] 農業経営体数 VALUES空'); return null; }
  console.log(`[e-Stat] 農業経営体数 VALUES=${values.length} id=${tableId}`);

  const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
  const cat01 = findClassObj(classObjs,'cat01');
  const cat02 = findClassObj(classObjs,'cat02');
  if (cat01) logClasses(cat01,'農業経営体数 cat01');
  if (cat02) logClasses(cat02,'農業経営体数 cat02');

  const TOTAL_KW=['計','合計','総数','農業経営体数','農業経営体'];
  let code=null, catKey=null;
  for (const [id,obj] of [['@cat01',cat01],['@cat02',cat02]]) {
    if (!obj) continue;
    const c=findCode(obj,...TOTAL_KW); if(c){code=c;catKey=id;break;}
  }
  const catFilterSets=code ? [[{key:catKey,value:code}],[]] : [[]];

  // Fix 4: センサスは1点でもOK（minPoints=1）
  const map = tryByUnitWithFallback(values,'body',ALL_AREA_CODES,catFilterSets,1);
  const list = interpolateList(yearMapToList(map));

  console.log(`[e-Stat] 農業経営体数 ${list.length}年分`);
  if (!list.length) return null;
  return { data:list, source:'農林業センサス（農林水産省）', tableId };
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

  prog('食料需給表を取得中（指標別）...');
  const foodBalance = await fetchFoodBalance(client);

  prog('作物統計調査（穀物）を取得中...');
  const [riceR,wheatR,soybeanR] = await Promise.allSettled([
    fetchGrainStats(client,['水稲','米','うるち米'],'水稲'),
    fetchGrainStats(client,['小麦'],'小麦'),
    fetchGrainStats(client,['大豆'],'大豆'),
  ]);
  const get = r => r.status==='fulfilled' ? r.value : null;

  prog('野菜生産出荷統計を取得中...');
  const [tomatoR,onionR,cabbageR,potatoR] = await Promise.allSettled([
    fetchVegetableStat(client,['トマト','とまと'],'トマト'),
    fetchVegetableStat(client,['たまねぎ','タマネギ','玉ねぎ'],'タマネギ'),
    fetchVegetableStat(client,['キャベツ','きゃべつ'],'キャベツ'),
    fetchVegetableStat(client,['ばれいしょ','じゃがいも'],'じゃがいも'),
  ]);
  const veg = (r,key) => { const v=get(r); return v?.[key]||null; };

  prog('農林業センサスを取得中...');
  const [workersR,bodiesR] = await Promise.allSettled([
    fetchAgriWorkers(client),
    fetchAgriBodies(client),
  ]);

  const result = {
    harvest:{
      rice:   get(riceR)?.harvest    || null,
      wheat:  get(wheatR)?.harvest   || null,
      soybean:get(soybeanR)?.harvest || null,
      tomato: veg(tomatoR,'harvest'),
      onion:  veg(onionR,'harvest'),
      cabbage:veg(cabbageR,'harvest'),
      potato: veg(potatoR,'harvest'),
    },
    area:{
      rice:   get(riceR)?.area    || null,
      wheat:  get(wheatR)?.area   || null,
      soybean:get(soybeanR)?.area || null,
      tomato: veg(tomatoR,'area'),
      onion:  veg(onionR,'area'),
      cabbage:veg(cabbageR,'area'),
      potato: veg(potatoR,'area'),
    },
    workers:    get(workersR),
    agriBodies: get(bodiesR),
    foodBalance,
  };

  const harvestOk=Object.values(result.harvest).filter(Boolean).length;
  const fbOk=foodBalance?Object.keys(foodBalance.data).length:0;
  prog(`取得完了: 食料需給${fbOk}品目 / 収穫量${harvestOk}品目 / 就業者${result.workers?'✓':'✗'} / 経営体${result.agriBodies?'✓':'✗'}`);
  return result;
}
