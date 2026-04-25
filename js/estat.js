// ===================================================
// e-Stat API クライアント & データ統合モジュール
// 政府統計の総合窓口 (https://www.e-stat.go.jp/api/)
// ===================================================

const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json';

// ===================================================
// 農業関連 統計表ID定義
// e-Stat サイトで「統計表ID」列を確認して更新可能
// ===================================================
const ESTAT_TABLE_IDS = {
  // 作物統計調査（確報）水稲・陸稲の作付面積及び収穫量
  rice:         '0001032058',
  // 作物統計調査（確報）麦類（小麦・大麦等）収穫量
  wheat:        '0001032061',
  // 作物統計調査（確報）豆類（大豆・小豆等）収穫量
  soybean:      '0001032064',
  // 野菜生産出荷統計 作付面積・収穫量・出荷量（トマト・タマネギ等）
  vegetable:    '0001032162',
  // 農林業センサス 農業就業人口（年齢別）
  agriWorkers:  '0003195591',
  // 農林業センサス 農業経営体数（法人経営体を含む）
  corporations: '0003195532',
};

// 野菜品目コード (野菜生産出荷統計の cat01 コード)
// e-Stat メタ情報から取得; 変更されることがあるため要確認
const VEGETABLE_CODES = {
  tomato:  '020',   // トマト
  onion:   '062',   // たまねぎ
  cabbage: '018',   // キャベツ
  potato:  '072',   // ばれいしょ
};

// ===================================================
// EStatClient クラス
// ===================================================
class EStatClient {
  constructor(appId) {
    this.appId = appId;
    this._cache = {};
  }

  // --- 低レベル fetch ---
  async _get(endpoint, params = {}) {
    const url = new URL(`${ESTAT_BASE}/${endpoint}`);
    url.searchParams.set('appId', this.appId);
    url.searchParams.set('lang', 'J');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const key = url.toString();
    if (this._cache[key]) return this._cache[key];

    const resp = await fetch(key);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    this._cache[key] = json;
    return json;
  }

  // --- 接続テスト ---
  async testConnection() {
    try {
      const json = await this._get('getStatsList', { searchWord: '作物統計', limit: 1 });
      const status = json?.GET_STATS_LIST?.RESULT?.STATUS;
      if (status === 0) return { ok: true };
      const msg = json?.GET_STATS_LIST?.RESULT?.ERROR_MSG || '不明なエラー';
      return { ok: false, error: msg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // --- 統計表リスト検索 ---
  async searchStats(searchWord, options = {}) {
    const json = await this._get('getStatsList', { searchWord, limit: 20, ...options });
    const raw = json?.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  // --- 統計データ取得 ---
  async getStatsData(statsDataId, options = {}) {
    const json = await this._get('getStatsData', {
      statsDataId,
      metaGetFlg: 'Y',
      cntGetFlg:  'N',
      ...options,
    });
    const result = json?.GET_STATS_DATA?.RESULT;
    if (result && result.STATUS !== 0) {
      throw new Error(`e-Stat: ${result.ERROR_MSG}`);
    }
    return json?.GET_STATS_DATA?.STATISTICAL_DATA;
  }
}

// ===================================================
// パーサー共通ユーティリティ
// ===================================================

// e-Stat 時点コード "2023000000" → 2023
function parseYear(timeCode) {
  return parseInt(String(timeCode).slice(0, 4), 10);
}

// e-Stat VALUE 配列 → { 年: 数値 } マップ
// areaCode: 全国='00000'、catCode: 品目絞り込み条件 {key, value}
function buildYearMap(values, { areaCode = '00000', catFilter = null } = {}) {
  const map = {};
  if (!values) return map;
  for (const v of values) {
    if (v['@area'] && v['@area'] !== areaCode) continue;
    if (catFilter && v[catFilter.key] !== catFilter.value) continue;
    const raw = parseFloat(v['$']);
    if (isNaN(raw)) continue;
    const year = parseYear(v['@time']);
    const unit = v['@unit'] || '';
    // 単位変換: t → 万トン、千t → 万トン
    let val = raw;
    if (unit === 't')   val = raw / 10000;
    if (unit === '千t') val = raw / 10;
    if (unit === '千人') val = raw / 10;  // 千人 → 万人
    if (unit === '人')  val = raw / 10000;
    if (unit === '経営体' || unit === '法人') val = raw;
    map[year] = parseFloat(val.toFixed(2));
  }
  return map;
}

// yearMap → ALL_YEARS 順の配列に整列（欠損は null）
function yearMapToArray(yearMap, years = ALL_YEARS) {
  return years.map(y => (yearMap[y] !== undefined ? yearMap[y] : null));
}

// null を前後の線形補間で埋める（センサスのような5年おきデータ用）
function interpolateNulls(arr) {
  const out = [...arr];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let prev = i - 1, next = i + 1;
    while (prev >= 0 && out[prev] === null) prev--;
    while (next < out.length && out[next] === null) next++;
    if (prev < 0 || next >= out.length) continue;
    const steps = next - prev;
    out[i] = parseFloat((out[prev] + (out[next] - out[prev]) * ((i - prev) / steps)).toFixed(2));
  }
  return out;
}

// ===================================================
// 個別データ取得関数
// ===================================================

// 水稲収穫量（万トン）
async function fetchRiceHarvest(client) {
  try {
    const sd = await client.getStatsData(ESTAT_TABLE_IDS.rice, {
      cdArea: '00000', cdTimeFrom: '2010000000', cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    const map = buildYearMap(values, { areaCode: '00000' });
    return { data: yearMapToArray(map), source: '作物統計調査（農林水産省）' };
  } catch (e) {
    console.warn('[e-Stat] 水稲収穫量取得失敗:', e.message);
    return null;
  }
}

// 小麦収穫量（万トン）
async function fetchWheatHarvest(client) {
  try {
    const sd = await client.getStatsData(ESTAT_TABLE_IDS.wheat, {
      cdArea: '00000', cdTimeFrom: '2010000000', cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    // 小麦の品目コードを特定（メタ情報から確認）
    const classMeta = sd?.CLASS_INF?.CLASS_OBJ;
    const catObj = Array.isArray(classMeta)
      ? classMeta.find(c => c['@id'] === 'cat01')
      : classMeta;
    const wheatClass = Array.isArray(catObj?.CLASS)
      ? catObj.CLASS.find(c => c['@name']?.includes('小麦'))
      : null;
    const catFilter = wheatClass ? { key: '@cat01', value: wheatClass['@code'] } : null;
    const map = buildYearMap(values, { areaCode: '00000', catFilter });
    return { data: yearMapToArray(map), source: '作物統計調査（農林水産省）' };
  } catch (e) {
    console.warn('[e-Stat] 小麦収穫量取得失敗:', e.message);
    return null;
  }
}

// 大豆収穫量（万トン）
async function fetchSoybeanHarvest(client) {
  try {
    const sd = await client.getStatsData(ESTAT_TABLE_IDS.soybean, {
      cdArea: '00000', cdTimeFrom: '2010000000', cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    const classMeta = sd?.CLASS_INF?.CLASS_OBJ;
    const catObj = Array.isArray(classMeta)
      ? classMeta.find(c => c['@id'] === 'cat01')
      : classMeta;
    const soybeanClass = Array.isArray(catObj?.CLASS)
      ? catObj.CLASS.find(c => c['@name']?.includes('大豆'))
      : null;
    const catFilter = soybeanClass ? { key: '@cat01', value: soybeanClass['@code'] } : null;
    const map = buildYearMap(values, { areaCode: '00000', catFilter });
    return { data: yearMapToArray(map), source: '作物統計調査（農林水産省）' };
  } catch (e) {
    console.warn('[e-Stat] 大豆収穫量取得失敗:', e.message);
    return null;
  }
}

// 野菜収穫量（万トン）cropId: 'tomato'|'onion'|'cabbage'|'potato'
async function fetchVegetableHarvest(client, cropId) {
  try {
    const catCode = VEGETABLE_CODES[cropId];
    if (!catCode) return null;
    const sd = await client.getStatsData(ESTAT_TABLE_IDS.vegetable, {
      cdArea: '00000',
      cdCat01: catCode,
      cdTimeFrom: '2010000000',
      cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    // 収穫量の項目コードを特定
    const classMeta = sd?.CLASS_INF?.CLASS_OBJ;
    const typeObj = Array.isArray(classMeta)
      ? classMeta.find(c => c['@id'] === 'cat02')
      : null;
    const harvestClass = typeObj && Array.isArray(typeObj.CLASS)
      ? typeObj.CLASS.find(c => c['@name']?.includes('収穫量'))
      : null;
    const catFilter = harvestClass ? { key: '@cat02', value: harvestClass['@code'] } : null;
    const map = buildYearMap(values, { areaCode: '00000', catFilter });
    return { data: yearMapToArray(map), source: '野菜生産出荷統計（農林水産省）' };
  } catch (e) {
    console.warn(`[e-Stat] ${cropId}収穫量取得失敗:`, e.message);
    return null;
  }
}

// 農業就業人口（万人）
async function fetchAgriWorkers(client) {
  try {
    const sd = await client.getStatsData(ESTAT_TABLE_IDS.agriWorkers, {
      cdArea: '00000',
    });
    const values = sd?.DATA_INF?.VALUE;
    // 総数の項目コードを特定
    const classMeta = sd?.CLASS_INF?.CLASS_OBJ;
    const totalObj = Array.isArray(classMeta)
      ? classMeta.find(c => c['@id'] === 'cat01')
      : classMeta;
    const totalClass = Array.isArray(totalObj?.CLASS)
      ? totalObj.CLASS.find(c => c['@name'] === '計' || c['@name']?.includes('総数'))
      : null;
    const catFilter = totalClass ? { key: '@cat01', value: totalClass['@code'] } : null;
    const rawMap = buildYearMap(values, { areaCode: '00000', catFilter });
    const interpolated = interpolateNulls(yearMapToArray(rawMap));
    return { data: interpolated, source: '農林業センサス（農林水産省）' };
  } catch (e) {
    console.warn('[e-Stat] 農業就業人口取得失敗:', e.message);
    return null;
  }
}

// ===================================================
// 一括ロード（アプリから呼び出すメイン関数）
// ===================================================
// 戻り値: { rice, wheat, soybean, tomato, onion, cabbage, potato, workers }
// 各値: { data: number[]|null[], source: string } または null（取得失敗）
async function loadAllEStatData(appId, onProgress) {
  const client = new EStatClient(appId);
  const report = (msg) => { if (onProgress) onProgress(msg); };

  report('接続テスト中...');
  const test = await client.testConnection();
  if (!test.ok) throw new Error(`接続失敗: ${test.error}`);
  report('接続OK。データ取得中...');

  const [rice, wheat, soybean, tomato, onion, cabbage, potato, workers] = await Promise.allSettled([
    fetchRiceHarvest(client),
    fetchWheatHarvest(client),
    fetchSoybeanHarvest(client),
    fetchVegetableHarvest(client, 'tomato'),
    fetchVegetableHarvest(client, 'onion'),
    fetchVegetableHarvest(client, 'cabbage'),
    fetchVegetableHarvest(client, 'potato'),
    fetchAgriWorkers(client),
  ]);

  const extract = r => r.status === 'fulfilled' ? r.value : null;

  report('取得完了');
  return {
    rice:    extract(rice),
    wheat:   extract(wheat),
    soybean: extract(soybean),
    tomato:  extract(tomato),
    onion:   extract(onion),
    cabbage: extract(cabbage),
    potato:  extract(potato),
    workers: extract(workers),
  };
}
