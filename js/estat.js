// ===================================================
// e-Stat API クライアント & データ統合モジュール v3
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
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    this._cache[key] = json;
    return json;
  }

  async testConnection() {
    try {
      const json = await this._get('getStatsList', { searchWord: '作物統計調査', limit: 1 });
      if (json?.GET_STATS_LIST?.RESULT?.STATUS === 0) return { ok: true };
      return { ok: false, error: json?.GET_STATS_LIST?.RESULT?.ERROR_MSG || '不明なエラー' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async searchStats(searchWord, extra = {}) {
    const json = await this._get('getStatsList', { searchWord, limit: 50, ...extra });
    if (json?.GET_STATS_LIST?.RESULT?.STATUS !== 0) return [];
    const raw = json?.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  async getStatsData(statsDataId, params = {}) {
    const json = await this._get('getStatsData', {
      statsDataId, metaGetFlg: 'Y', cntGetFlg: 'N', ...params,
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

// 単位を統一（万トン または 万人 に変換）
function normalizeValue(raw, unit) {
  const u = (unit || '').trim();
  if (u === 't')       return raw / 10000;
  if (u === '千t')     return raw / 10;
  if (u === '万t')     return raw;
  if (u === '千トン')  return raw / 10;
  if (u === '人')      return raw / 10000;
  if (u === '千人')    return raw / 10;
  if (u === '万人')    return raw;
  if (u === 'ha')      return raw / 10000;
  if (u === '千ha')    return raw / 10;
  if (u === '%')       return raw;  // 自給率はそのまま
  return raw;
}

// VALUES 配列 → { year: value } マップ
function buildYearMap(values, areaCode = '00000', catFilters = []) {
  if (!Array.isArray(values) || !values.length) return {};
  const map = {};
  for (const v of values) {
    if (areaCode && v['@area'] !== areaCode) continue;
    if (catFilters.some(f => v[f.key] !== f.value)) continue;
    const raw = parseFloat(v['$']);
    if (isNaN(raw)) continue;
    const year = parseYear(v['@time']);
    if (year < 1990 || year > 2030) continue;
    const val = parseFloat(normalizeValue(raw, v['@unit']).toFixed(3));
    // 同一年は大きい値を優先（確報 > 速報 の場合が多い）
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

// [{year,value}] の null を線形補間（センサスのような5年おきデータ用）
function interpolateList(list) {
  if (!list.length) return list;
  const minY = list[0].year, maxY = list[list.length - 1].year;
  const map = Object.fromEntries(list.map(d => [d.year, d.value]));
  const result = [];
  for (let y = minY; y <= maxY; y++) {
    if (map[y] !== undefined) { result.push({ year: y, value: map[y] }); continue; }
    // 前後を探して補間
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

// CLASS_OBJ (配列 or 単体) から @id が一致するものを探す
function findClassObj(classObjRaw, id) {
  if (!classObjRaw) return null;
  const arr = Array.isArray(classObjRaw) ? classObjRaw : [classObjRaw];
  return arr.find(c => c['@id'] === id) || null;
}

// CLASS 配列から名称にキーワードを含むコードを返す
function findCode(classObj, ...keywords) {
  if (!classObj) return null;
  const classes = Array.isArray(classObj.CLASS) ? classObj.CLASS : [classObj.CLASS];
  for (const kw of keywords) {
    const found = classes.find(c => c['@name']?.includes(kw));
    if (found) return found['@code'];
  }
  return null;
}

// ===================================================
// テーブル動的選択（キーワード検索 → スコアリング）
// ===================================================
function scoreTable(table, must, bonus, penalty = []) {
  const txt = `${table.STATISTICS_NAME || ''} ${table.TITLE?.['$'] || table.TITLE || ''}`;
  let score = 0;
  for (const w of must)    { if (!txt.includes(w)) return -999; score += 10; }
  for (const w of bonus)   { if (txt.includes(w)) score += 5; }
  for (const w of penalty) { if (txt.includes(w)) score -= 8; }
  const date = parseInt(table.SURVEY_DATE || '0', 10);
  score += Math.max(0, Math.floor((date - 200000) / 10000));
  return score;
}

async function findBestTableId(client, searchWord, must, bonus = [], penalty = []) {
  const tables = await client.searchStats(searchWord);
  if (!tables.length) return null;
  const scored = tables
    .map(t => ({ id: t['@id'], score: scoreTable(t, must, bonus, penalty) }))
    .filter(x => x.score > -999)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].id : null;
}

// ===================================================
// 個別データフェッチ関数
// ===================================================

// 【作物統計調査】収穫量
async function fetchCropHarvest(client, cropKeywords, label) {
  try {
    const id = await findBestTableId(
      client, `作物統計調査 ${cropKeywords[0]} 収穫量`,
      ['作物統計'], cropKeywords, ['都道府県', '市町村', '地域別']
    );
    if (!id) throw new Error('テーブル未発見');
    console.log(`[e-Stat] ${label} tableId=${id}`);

    const sd = await client.getStatsData(id, {
      cdArea: '00000', cdTimeFrom: '2000000000', cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データ空');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const filters = [];
    const cat01 = findClassObj(classObjs, 'cat01');
    if (cat01) {
      const code = findCode(cat01, ...cropKeywords);
      if (code) filters.push({ key: '@cat01', value: code });
    }
    const cat02 = findClassObj(classObjs, 'cat02');
    if (cat02) {
      const code = findCode(cat02, '収穫量', '収穫');
      if (code) filters.push({ key: '@cat02', value: code });
    }

    const map = buildYearMap(values, '00000', filters);
    const list = yearMapToList(map);
    if (!list.length) throw new Error('有効データ0件');
    console.log(`[e-Stat] ${label} 取得: ${list.length}年分 (${list[0].year}〜${list[list.length-1].year})`);
    return { data: list, source: `作物統計調査（農林水産省）`, tableId: id };
  } catch (e) {
    console.warn(`[e-Stat] ${label} 失敗:`, e.message);
    return null;
  }
}

// 【作物統計調査】作付面積
async function fetchCropArea(client, cropKeywords, label) {
  try {
    const id = await findBestTableId(
      client, `作物統計調査 ${cropKeywords[0]} 作付面積`,
      ['作物統計'], [...cropKeywords, '作付'], ['都道府県', '市町村']
    );
    if (!id) throw new Error('テーブル未発見');

    const sd = await client.getStatsData(id, {
      cdArea: '00000', cdTimeFrom: '2000000000', cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データ空');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const filters = [];
    const cat01 = findClassObj(classObjs, 'cat01');
    if (cat01) {
      const code = findCode(cat01, ...cropKeywords);
      if (code) filters.push({ key: '@cat01', value: code });
    }
    const cat02 = findClassObj(classObjs, 'cat02');
    if (cat02) {
      const code = findCode(cat02, '作付面積', '栽培面積', '面積');
      if (code) filters.push({ key: '@cat02', value: code });
    }

    const map = buildYearMap(values, '00000', filters);
    const list = yearMapToList(map);
    if (!list.length) throw new Error('有効データ0件');
    return { data: list, source: `作物統計調査（農林水産省）`, tableId: id };
  } catch (e) {
    console.warn(`[e-Stat] ${label}作付面積 失敗:`, e.message);
    return null;
  }
}

// 【野菜生産出荷統計】収穫量・作付面積
async function fetchVegetable(client, vegName, label) {
  try {
    const id = await findBestTableId(
      client, `野菜生産出荷統計 ${vegName}`,
      ['野菜'], [vegName], ['都道府県', '市町村', '産地']
    );
    if (!id) throw new Error('テーブル未発見');
    console.log(`[e-Stat] ${label} tableId=${id}`);

    const sd = await client.getStatsData(id, {
      cdArea: '00000', cdTimeFrom: '2000000000', cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データ空');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const baseFilters = [];
    const cat01 = findClassObj(classObjs, 'cat01');
    if (cat01) {
      const code = findCode(cat01, vegName);
      if (code) baseFilters.push({ key: '@cat01', value: code });
    }

    // 収穫量フィルタ
    const cat02 = findClassObj(classObjs, 'cat02');
    const harvestFilters = [...baseFilters];
    if (cat02) {
      const code = findCode(cat02, '収穫量', '収穫');
      if (code) harvestFilters.push({ key: '@cat02', value: code });
    }
    // 作付面積フィルタ
    const areaFilters = [...baseFilters];
    if (cat02) {
      const code = findCode(cat02, '作付面積', '栽培面積', '面積');
      if (code) areaFilters.push({ key: '@cat02', value: code });
    }

    const harvestMap = buildYearMap(values, '00000', harvestFilters);
    const areaMap    = buildYearMap(values, '00000', areaFilters);
    const harvestList = yearMapToList(harvestMap);
    const areaList    = yearMapToList(areaMap);

    if (!harvestList.length) throw new Error('収穫量データ0件');
    console.log(`[e-Stat] ${label} 取得: ${harvestList.length}年分`);
    return {
      harvest: { data: harvestList, source: `野菜生産出荷統計（農林水産省）`, tableId: id },
      area:    areaList.length ? { data: areaList, source: `野菜生産出荷統計（農林水産省）`, tableId: id } : null,
    };
  } catch (e) {
    console.warn(`[e-Stat] ${label} 失敗:`, e.message);
    return null;
  }
}

// 【食料需給表】品目別: 生産量・消費量・自給率
async function fetchFoodBalance(client) {
  const result = {};
  try {
    const id = await findBestTableId(
      client, '食料需給表 自給率',
      ['食料需給'], ['自給率', '国内生産'], ['都道府県']
    );
    if (!id) throw new Error('テーブル未発見');
    console.log(`[e-Stat] 食料需給表 tableId=${id}`);

    const sd = await client.getStatsData(id, {
      cdArea: '00000', cdTimeFrom: '2000000000', cdTimeTo: '2023000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データ空');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const cat01 = findClassObj(classObjs, 'cat01'); // 品目
    const cat02 = findClassObj(classObjs, 'cat02'); // データ種別

    // 品目コードを動的に取得
    const CROP_NAMES = {
      rice:    ['米', 'うるち米', '水稲'],
      wheat:   ['小麦'],
      soybean: ['大豆'],
      tomato:  ['トマト', 'とまと'],
      onion:   ['たまねぎ', 'タマネギ', '玉ねぎ'],
      cabbage: ['キャベツ', 'きゃべつ'],
      potato:  ['ばれいしょ', 'じゃがいも', 'バレイショ'],
    };
    // データ種別コードを動的に取得
    const TYPE_KEYWORDS = {
      production:      ['国内生産量', '生産量'],
      consumption:     ['国内消費仕向量', '消費量', '国内消費量'],
      imports:         ['輸入量'],
      selfSufficiency: ['自給率', '食料自給率'],
    };

    for (const [cropKey, names] of Object.entries(CROP_NAMES)) {
      const cropCode = cat01 ? findCode(cat01, ...names) : null;
      if (!cropCode) continue;

      result[cropKey] = {};
      for (const [typeKey, keywords] of Object.entries(TYPE_KEYWORDS)) {
        const typeCode = cat02 ? findCode(cat02, ...keywords) : null;
        const filters = [{ key: '@cat01', value: cropCode }];
        if (typeCode) filters.push({ key: '@cat02', value: typeCode });

        const map = buildYearMap(values, '00000', filters);
        const list = yearMapToList(map);
        if (list.length) result[cropKey][typeKey] = list;
      }
    }

    const found = Object.keys(result).length;
    console.log(`[e-Stat] 食料需給表 取得品目数=${found}`);
    return { data: result, source: '食料需給表（農林水産省）', tableId: id };
  } catch (e) {
    console.warn('[e-Stat] 食料需給表 失敗:', e.message);
    return null;
  }
}

// 【農林業センサス】農業就業人口（年齢別）
async function fetchAgriWorkers(client) {
  try {
    const id = await findBestTableId(
      client, '農林業センサス 農業就業人口',
      ['センサス'], ['農業就業', '農業経営体'],
      ['林業', '水産', '都道府県', '市町村']
    );
    if (!id) throw new Error('テーブル未発見');
    console.log(`[e-Stat] 農業就業人口 tableId=${id}`);

    const sd = await client.getStatsData(id, { cdArea: '00000' });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データ空');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const cat01 = findClassObj(classObjs, 'cat01');
    const filters = [];
    if (cat01) {
      const code = findCode(cat01, '計', '合計', '総数', '農業就業人口');
      if (code) filters.push({ key: '@cat01', value: code });
    }

    const totalMap = buildYearMap(values, '00000', filters);
    const totalList = interpolateList(yearMapToList(totalMap));

    // 年齢別（あれば）
    const AGE_GROUPS = [
      { key: 'under49', keywords: ['49歳以下', '15〜49歳', '15〜44歳', '49歳未満'] },
      { key: 'age5064', keywords: ['50〜64歳', '50〜59歳'] },
      { key: 'over65',  keywords: ['65歳以上', '65歳〜'] },
    ];
    const byAge = {};
    for (const { key, keywords } of AGE_GROUPS) {
      if (!cat01) continue;
      const code = findCode(cat01, ...keywords);
      if (!code) continue;
      const ageMap = buildYearMap(values, '00000', [{ key: '@cat01', value: code }]);
      const ageList = interpolateList(yearMapToList(ageMap));
      if (ageList.length) byAge[key] = ageList;
    }

    if (!totalList.length) throw new Error('有効データ0件');
    console.log(`[e-Stat] 農業就業人口 取得: ${totalList.length}年分`);
    return { total: totalList, byAge, source: `農林業センサス（農林水産省）`, tableId: id };
  } catch (e) {
    console.warn('[e-Stat] 農業就業人口 失敗:', e.message);
    return null;
  }
}

// 【農林業センサス】農業経営体数
async function fetchAgriBodies(client) {
  try {
    const id = await findBestTableId(
      client, '農林業センサス 農業経営体数',
      ['センサス'], ['経営体', '農業経営体'],
      ['林業', '水産', '都道府県', '市町村']
    );
    if (!id) throw new Error('テーブル未発見');
    console.log(`[e-Stat] 農業経営体数 tableId=${id}`);

    const sd = await client.getStatsData(id, { cdArea: '00000' });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データ空');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const cat01 = findClassObj(classObjs, 'cat01');
    const filters = [];
    if (cat01) {
      const code = findCode(cat01, '計', '合計', '総数', '農業経営体');
      if (code) filters.push({ key: '@cat01', value: code });
    }

    const map = buildYearMap(values, '00000', filters);
    const list = interpolateList(yearMapToList(map));
    if (!list.length) throw new Error('有効データ0件');
    console.log(`[e-Stat] 農業経営体数 取得: ${list.length}年分`);
    return { data: list, source: `農林業センサス（農林水産省）`, tableId: id };
  } catch (e) {
    console.warn('[e-Stat] 農業経営体数 失敗:', e.message);
    return null;
  }
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
  prog('接続OK。農林水産省統計を取得中...');

  // 並列取得
  const [
    rice, wheat, soybean,
    tomatoR, onionR, cabbageR, potatoR,
    riceArea, wheatArea, soybeanArea,
    workers, agriBodies, foodBalance,
  ] = await Promise.allSettled([
    fetchCropHarvest(client, ['水稲'],          '水稲収穫量'),
    fetchCropHarvest(client, ['小麦'],          '小麦収穫量'),
    fetchCropHarvest(client, ['大豆'],          '大豆収穫量'),
    fetchVegetable(client,   'トマト',          'トマト'),
    fetchVegetable(client,   'たまねぎ',        'タマネギ'),
    fetchVegetable(client,   'キャベツ',        'キャベツ'),
    fetchVegetable(client,   'ばれいしょ',      'じゃがいも'),
    fetchCropArea(client,    ['水稲'],          '水稲'),
    fetchCropArea(client,    ['小麦'],          '小麦'),
    fetchCropArea(client,    ['大豆'],          '大豆'),
    fetchAgriWorkers(client),
    fetchAgriBodies(client),
    fetchFoodBalance(client),
  ]);

  const get = r => r.status === 'fulfilled' ? r.value : null;

  // 野菜は {harvest, area} で返るためラップ解除
  const veg = (r, key) => { const v = get(r); return v?.[key] || null; };

  const result = {
    harvest: {
      rice:    get(rice),
      wheat:   get(wheat),
      soybean: get(soybean),
      tomato:  veg(tomatoR, 'harvest'),
      onion:   veg(onionR,  'harvest'),
      cabbage: veg(cabbageR,'harvest'),
      potato:  veg(potatoR, 'harvest'),
    },
    area: {
      rice:    get(riceArea),
      wheat:   get(wheatArea),
      soybean: get(soybeanArea),
      tomato:  veg(tomatoR, 'area'),
      onion:   veg(onionR,  'area'),
      cabbage: veg(cabbageR,'area'),
      potato:  veg(potatoR, 'area'),
    },
    workers:     get(workers),
    agriBodies:  get(agriBodies),
    foodBalance: get(foodBalance),
  };

  const ok = Object.values(result.harvest).filter(Boolean).length
           + (result.workers ? 1 : 0)
           + (result.foodBalance ? 1 : 0);
  prog(`取得完了（${ok}/${Object.values(result.harvest).length + 2} 成功）`);
  return result;
}
