// ===================================================
// e-Stat API クライアント & データ統合モジュール v7
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

function normalizeValue(raw, unit) {
  const u = (unit || '').trim().replace(/\s/g, '');
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
// 単位タイプベースフィルタ (v6)
// ===================================================
const UNIT_SETS = {
  weight:  new Set(['t','トン','千t','千トン','万t','万トン','kg']),
  area:    new Set(['ha','千ha','万ha','a']),
  percent: new Set(['%']),
  people:  new Set(['人','千人','万人']),
  body:    new Set(['経営体','千経営体','万経営体']),
};

// 全エリアコード候補（国コード違いに備えて広く試す）
const ALL_AREA_CODES = ['00000','00','0','000','0000','000000',null];

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

// 単位不問フォールバック（センサス等で単位が空の場合用）
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
    const unit = (v['@unit'] || '').trim();
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

function tryByUnit(values, unitType, areaCodes, catFilterSets) {
  for (const ac of areaCodes) {
    for (const cf of catFilterSets) {
      const m = buildYearMapByUnit(values, unitType, ac, cf);
      if (Object.keys(m).length >= 2) {
        console.log(`[e-Stat] OK unit=${unitType} area=${ac} → ${Object.keys(m).length}年`);
        return m;
      }
    }
  }
  return {};
}

// 単位ベース失敗時に単位不問でリトライ
function tryByUnitWithFallback(values, unitType, areaCodes, catFilterSets) {
  const m = tryByUnit(values, unitType, areaCodes, catFilterSets);
  if (Object.keys(m).length >= 2) return m;
  // 単位不問フォールバック
  for (const ac of areaCodes) {
    for (const cf of catFilterSets) {
      const m2 = buildYearMapNoUnit(values, ac, cf);
      if (Object.keys(m2).length >= 2) {
        console.log(`[e-Stat] OK (no-unit fallback) area=${ac} → ${Object.keys(m2).length}年`);
        return m2;
      }
    }
  }
  return {};
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
  // 単年テーブル（「〇年産」パターン）を強くペナルティ
  if (/\d+年産/.test(txt)) score -= 30;
  const d = parseInt(table.SURVEY_DATE||'0',10);
  score += Math.max(0, Math.floor((d-200000)/10000));
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

// テーブルデータ取得（エリア有・無 + 時刻有・無でフォールバック）
async function fetchTableData(client, tableId, extraParams={}) {
  const tries = [
    { cdTimeFrom:'2000000000', cdTimeTo:'2024000000', ...extraParams },
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
// 単一の「総合テーブル」ではなく指標ごとに最適テーブルを探す
// ===================================================
async function fetchFoodBalance(client) {
  // 指標ごとの検索戦略
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

  // 指標ごとに最適テーブルを取得してデータをマージ
  const metricData = {}; // { production: {rice:[...], wheat:[...],...}, ... }

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
    // cat01~cat03 を全部確認してどのカテゴリが品目かを自動判定
    const allCats = ['cat01','cat02','cat03'].map(id => ({ id, obj: findClassObj(classObjs, id) })).filter(x=>x.obj);
    allCats.forEach(c => logClasses(c.obj, `食料需給表:${metricKey} ${c.id}`));

    const unitType = UNIT_FOR[metricKey];
    metricData[metricKey] = {};

    for (const [cropKey, cropKws] of Object.entries(CROP_KW)) {
      // 全カテゴリから品目コードを探す
      let cropCode=null, cropCatKey=null;
      for (const {id, obj} of allCats) {
        const c = findCode(obj, ...cropKws);
        if (c) { cropCode=c; cropCatKey='@'+id; break; }
      }

      const catFilterSets = [];
      if (cropCode) catFilterSets.push([{key:cropCatKey, value:cropCode}]);
      catFilterSets.push([]); // unit typeが守る

      const map = tryByUnit(values, unitType, ALL_AREA_CODES, catFilterSets);
      const list = yearMapToList(map);
      if (list.length>=2) metricData[metricKey][cropKey] = list;
    }
    console.log(`[e-Stat] 食料需給表:${metricKey} 取得品目=${Object.keys(metricData[metricKey]).join(',')}`);
  }

  // 品目×指標 のマトリクスを作成
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

  // 品目コードを全カテゴリから探す
  let cropCode=null, cropCatKey=null;
  for (const [id,obj] of [['@cat01',cat01],['@cat02',cat02]]) {
    if (!obj) continue;
    const c = findCode(obj,...cropKws);
    if (c) { cropCode=c; cropCatKey=id; break; }
  }
  const cropFilter = cropCode ? [{key:cropCatKey, value:cropCode}] : [];
  const filterSets = cropFilter.length ? [cropFilter,[]] : [[]];

  const harvest = yearMapToList(tryByUnit(values,'weight',ALL_AREA_CODES,filterSets));
  const area    = yearMapToList(tryByUnit(values,'area',  ALL_AREA_CODES,filterSets));

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

  // 品目コードを全カテゴリから探す
  let vegCode=null, vegCatKey=null;
  for (const [id,obj] of [['@cat01',cat01],['@cat02',cat02]]) {
    if (!obj) continue;
    const c = findCode(obj,...vegKws);
    if (c) { vegCode=c; vegCatKey=id; break; }
  }
  const vegFilter = vegCode ? [{key:vegCatKey, value:vegCode}] : [];
  const filterSets = vegFilter.length ? [vegFilter,[]] : [[]];

  const harvest = yearMapToList(tryByUnit(values,'weight',ALL_AREA_CODES,filterSets));
  const area    = yearMapToList(tryByUnit(values,'area',  ALL_AREA_CODES,filterSets));

  // 都道府県別テーブルで国コードが見つからない場合: 都道府県合計を算出
  let harvestFinal=harvest, areaFinal=area;
  if (!harvest.length) {
    console.log(`[e-Stat] ${vegLabel} 国コードNG→都道府県合計を試みる`);
    const sumMap = {};
    for (const v of values) {
      const unit=(v['@unit']||'').trim().replace(/\s+/g,'');
      if (!UNIT_SETS.weight.has(unit)) continue;
      if (vegFilter.length && vegFilter.some(f=>v[f.key]!=null&&v[f.key]!==f.value)) continue;
      const raw=parseFloat(v['$']); if(isNaN(raw)||raw<=0) continue;
      const year=parseYear(v['@time']); if(year<1990||year>2030) continue;
      const val=parseFloat(normalizeValue(raw,unit).toFixed(4)); if(val<=0) continue;
      sumMap[year]=(sumMap[year]||0)+val;
    }
    // 合計が国計より明らかに大きい（都道府県重複なし）か判断不能のため、
    // 最大の1件より大きい合計なら都道府県合計として採用
    const sumList=yearMapToList(sumMap);
    if(sumList.length>=2) harvestFinal=sumList;
  }
  if (!area.length) {
    const sumMap={};
    for (const v of values) {
      const unit=(v['@unit']||'').trim().replace(/\s+/g,'');
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

  // 性別:合計コードを探す（存在すればcat02フィルタに使用）
  const genderTotalCode = cat02 ? findCode(cat02,'合計','計','総数') : null;
  const genderFilter = (cat02 && genderTotalCode) ? {key:'@cat02', value:genderTotalCode} : null;

  // 合計コードを全カテゴリから探す
  const TOTAL_KW=['計','合計','総数','農業就業人口','農業就業者数'];
  let totalCode=null, totalCatKey=null;
  for (const [id,obj] of [['@cat01',cat01],['@cat02',cat02]]) {
    if (!obj) continue;
    const c=findCode(obj,...TOTAL_KW); if(c){totalCode=c;totalCatKey=id;break;}
  }

  const buildTotal = () => {
    const catFilterSets=[];
    if (totalCode) {
      const f=[{key:totalCatKey,value:totalCode}];
      if(genderFilter && totalCatKey!=='@cat02') f.push(genderFilter);
      catFilterSets.push(f);
    }
    catFilterSets.push([]);
    return yearMapToList(tryByUnitWithFallback(values,'people',ALL_AREA_CODES,catFilterSets));
  };

  // 年齢別: cat01のラベルを解析して年齢帯コードを自動抽出
  const cls1 = getClasses(cat01);
  const ageCodeGroups = { under49:[], age5064:[], over65:[] };
  for (const c of cls1) {
    const n = c['@name']||'';
    // "X～Y歳" パターン
    const m = n.match(/^(\d+)[\s～〜~ー]+(\d+)歳/);
    if (m) {
      const lo=parseInt(m[1]);
      if (lo<50)      ageCodeGroups.under49.push(c['@code']);
      else if (lo<65) ageCodeGroups.age5064.push(c['@code']);
      else            ageCodeGroups.over65.push(c['@code']);
      continue;
    }
    // "X歳以上" パターン
    const m2 = n.match(/^(\d+)歳以上/);
    if (m2 && parseInt(m2[1])>=65) { ageCodeGroups.over65.push(c['@code']); continue; }
    // 集計系キーワード
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

  // 合計が取れず年齢別が揃っていれば再合成
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

  const map = tryByUnitWithFallback(values,'body',ALL_AREA_CODES,catFilterSets);
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
