// ===================================================
// e-Stat API クライアント & データ統合モジュール  v2
// 政府統計の総合窓口 (https://www.e-stat.go.jp/api/)
//
// 【設計方針】
// ハードコードされたテーブルIDは年度改訂で変わるため、
// キーワード検索 → スコアリング → 最良テーブルを動的選択する方式を採用
// ===================================================

const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json';

// ===================================================
// EStatClient — HTTP 基盤クラス
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
    const cacheKey = url.toString();
    if (this._cache[cacheKey]) return this._cache[cacheKey];

    const resp = await fetch(cacheKey);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    const json = await resp.json();
    this._cache[cacheKey] = json;
    return json;
  }

  // 接続テスト: APIキーが有効かどうか確認
  async testConnection() {
    try {
      const json = await this._get('getStatsList', {
        searchWord: '作物統計調査', limit: 1,
      });
      if (json?.GET_STATS_LIST?.RESULT?.STATUS === 0) return { ok: true };
      const msg = json?.GET_STATS_LIST?.RESULT?.ERROR_MSG || '不明なエラー';
      return { ok: false, error: msg };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 統計表リスト検索
  async searchStats(searchWord, extra = {}) {
    const json = await this._get('getStatsList', {
      searchWord, limit: 50, ...extra,
    });
    if (json?.GET_STATS_LIST?.RESULT?.STATUS !== 0) return [];
    const raw = json?.GET_STATS_LIST?.DATALIST_INF?.TABLE_INF;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
  }

  // 統計データ取得
  async getStatsData(statsDataId, params = {}) {
    const json = await this._get('getStatsData', {
      statsDataId, metaGetFlg: 'Y', cntGetFlg: 'N', ...params,
    });
    const result = json?.GET_STATS_DATA?.RESULT;
    if (result?.STATUS !== 0) {
      throw new Error(result?.ERROR_MSG || 'データ取得エラー');
    }
    return json.GET_STATS_DATA.STATISTICAL_DATA;
  }
}

// ===================================================
// ユーティリティ
// ===================================================

// "2023000000" → 2023
function parseYear(code) {
  return parseInt(String(code).slice(0, 4), 10);
}

// 単位を判定して万トンまたは万人に変換
function normalizeValue(raw, unit) {
  const u = (unit || '').trim();
  if (u === 't')    return raw / 10000;   // トン → 万トン
  if (u === '千t')  return raw / 10;      // 千トン → 万トン
  if (u === '万t')  return raw;           // そのまま
  if (u === '人')   return raw / 10000;   // 人 → 万人
  if (u === '千人') return raw / 10;      // 千人 → 万人
  if (u === '万人') return raw;
  if (u === 'ha')   return raw / 10000;   // ha → 万ha（参考用）
  return raw;                              // 不明単位はそのまま
}

// VALUE 配列 → {年: 値} マップ
// catFilters: [{key: '@cat01', value: 'XXX'}, ...] で絞り込み
function buildYearMap(values, areaCode = '00000', catFilters = []) {
  if (!Array.isArray(values) || values.length === 0) return {};
  const map = {};
  for (const v of values) {
    // 地域フィルタ（areaCode が null のときは全通し）
    if (areaCode && v['@area'] !== areaCode) continue;
    // カテゴリフィルタ
    if (catFilters.some(f => v[f.key] !== f.value)) continue;
    const raw = parseFloat(v['$']);
    if (isNaN(raw) || raw === 0) continue;
    const year = parseYear(v['@time']);
    if (year < 2000 || year > 2030) continue; // 範囲外を除外
    const val = parseFloat(normalizeValue(raw, v['@unit']).toFixed(2));
    // 同じ年が複数ある場合は大きい値を優先（確報 > 速報）
    if (!map[year] || val > map[year]) map[year] = val;
  }
  return map;
}

// yearMap → ALL_YEARS 長の配列（欠損は null）
function yearMapToArray(yearMap) {
  return ALL_YEARS.map(y => yearMap[y] ?? null);
}

// null を線形補間（農林業センサスのような5年おきデータ用）
function interpolateNulls(arr) {
  const out = [...arr];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let lo = i - 1, hi = i + 1;
    while (lo >= 0 && out[lo] === null) lo--;
    while (hi < out.length && out[hi] === null) hi++;
    if (lo < 0 || hi >= out.length) continue;
    const steps = hi - lo;
    out[i] = parseFloat(
      (out[lo] + (out[hi] - out[lo]) * ((i - lo) / steps)).toFixed(2)
    );
  }
  return out;
}

// CLASS_OBJ（配列 or 単体）から指定 @id の CLASS_OBJ を探す
function findClassObj(classObjRaw, id) {
  if (!classObjRaw) return null;
  const arr = Array.isArray(classObjRaw) ? classObjRaw : [classObjRaw];
  return arr.find(c => c['@id'] === id) || null;
}

// CLASS配列からキーワードを含むコードを探す
function findCode(classObj, ...keywords) {
  if (!classObj) return null;
  const classes = Array.isArray(classObj.CLASS)
    ? classObj.CLASS : [classObj.CLASS];
  for (const kw of keywords) {
    const found = classes.find(c => c['@name']?.includes(kw));
    if (found) return found['@code'];
  }
  return null;
}

// ===================================================
// テーブル動的選択
// キーワード検索 → スコアリング → 最良のテーブルIDを返す
// ===================================================
function scoreTable(table, mustWords, bonusWords, penaltyWords = []) {
  const name = (table.STATISTICS_NAME || '') + ' ' + (table.TITLE?.['$'] || table.TITLE || '');
  let score = 0;
  for (const w of mustWords)    { if (!name.includes(w)) return -999; score += 10; }
  for (const w of bonusWords)   { if (name.includes(w)) score += 5; }
  for (const w of penaltyWords) { if (name.includes(w)) score -= 8; }
  // 新しい調査ほど高スコア
  const date = parseInt(table.SURVEY_DATE || '0', 10);
  score += Math.floor((date - 200000) / 10000); // 2010年基準の年数加算
  return score;
}

async function findBestTableId(client, searchWord, mustWords, bonusWords = [], penaltyWords = []) {
  const tables = await client.searchStats(searchWord);
  if (!tables.length) return null;
  const scored = tables
    .map(t => ({ id: t['@id'], score: scoreTable(t, mustWords, bonusWords, penaltyWords) }))
    .filter(x => x.score > -999)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].id : null;
}

// ===================================================
// 個別データフェッチ関数
// ===================================================

// 【作物統計調査】汎用収穫量取得
// cropMustWords: 品目のキーワード（['水稲'] など）
async function fetchCropHarvest(client, cropMustWords, label) {
  try {
    const tableId = await findBestTableId(
      client,
      `作物統計調査 収穫量 ${cropMustWords.join(' ')}`,
      ['作物統計'],
      cropMustWords,
      ['都道府県', '市町村', '農業地域別']
    );
    if (!tableId) throw new Error(`テーブルが見つかりません: ${label}`);
    console.log(`[e-Stat] ${label} tableId=${tableId}`);

    const sd = await client.getStatsData(tableId, {
      cdArea: '00000',
      cdTimeFrom: '2010000000',
      cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データが空です');

    // メタ情報から「収穫量」に対応するカテゴリコードを特定
    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const filters = [];

    // cat01（品目）に複数品目が含まれる場合は対象品目コードを絞り込む
    const cat01 = findClassObj(classObjs, 'cat01');
    if (cat01) {
      const code = findCode(cat01, ...cropMustWords);
      if (code) filters.push({ key: '@cat01', value: code });
    }
    // cat02（項目種別）があれば「収穫量」に絞り込む
    const cat02 = findClassObj(classObjs, 'cat02');
    if (cat02) {
      const code = findCode(cat02, '収穫量', '収穫');
      if (code) filters.push({ key: '@cat02', value: code });
    }

    const map = buildYearMap(values, '00000', filters);
    const data = yearMapToArray(map);
    const count = data.filter(v => v !== null).length;
    if (count === 0) throw new Error('有効データが0件');
    console.log(`[e-Stat] ${label} 取得件数=${count}年分`);

    return { data, source: `作物統計調査（農林水産省）tableId=${tableId}` };
  } catch (e) {
    console.warn(`[e-Stat] ${label} 取得失敗:`, e.message);
    return null;
  }
}

// 【野菜生産出荷統計】野菜収穫量取得
async function fetchVegetableHarvest(client, vegJpName, label) {
  try {
    const tableId = await findBestTableId(
      client,
      `野菜生産出荷統計 ${vegJpName} 収穫量`,
      ['野菜'],
      ['収穫量', vegJpName],
      ['都道府県', '市町村', '産地']
    );
    if (!tableId) throw new Error(`テーブルが見つかりません: ${label}`);
    console.log(`[e-Stat] ${label} tableId=${tableId}`);

    const sd = await client.getStatsData(tableId, {
      cdArea: '00000',
      cdTimeFrom: '2010000000',
      cdTimeTo: '2024000000',
    });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データが空です');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const filters = [];

    // 品目コードの特定
    const cat01 = findClassObj(classObjs, 'cat01');
    if (cat01) {
      const code = findCode(cat01, vegJpName);
      if (code) filters.push({ key: '@cat01', value: code });
    }
    // 「収穫量」項目の特定
    const cat02 = findClassObj(classObjs, 'cat02');
    if (cat02) {
      const code = findCode(cat02, '収穫量', '収穫');
      if (code) filters.push({ key: '@cat02', value: code });
    }

    const map = buildYearMap(values, '00000', filters);
    const data = yearMapToArray(map);
    const count = data.filter(v => v !== null).length;
    if (count === 0) throw new Error('有効データが0件');
    console.log(`[e-Stat] ${label} 取得件数=${count}年分`);

    return { data, source: `野菜生産出荷統計（農林水産省）tableId=${tableId}` };
  } catch (e) {
    console.warn(`[e-Stat] ${label} 取得失敗:`, e.message);
    return null;
  }
}

// 【農林業センサス】農業就業人口取得
async function fetchAgriWorkers(client) {
  try {
    const tableId = await findBestTableId(
      client,
      '農林業センサス 農業就業人口',
      ['センサス'],
      ['農業就業', '農業経営'],
      ['林業', '水産', '都道府県', '市町村']
    );
    if (!tableId) throw new Error('テーブルが見つかりません');
    console.log(`[e-Stat] 農業就業人口 tableId=${tableId}`);

    const sd = await client.getStatsData(tableId, { cdArea: '00000' });
    const values = sd?.DATA_INF?.VALUE;
    if (!values?.length) throw new Error('データが空です');

    const classObjs = sd?.CLASS_INF?.CLASS_OBJ;
    const filters = [];

    // 「合計」「計」「総数」に対応するコードを探す
    const cat01 = findClassObj(classObjs, 'cat01');
    if (cat01) {
      const code = findCode(cat01, '計', '合計', '総数', '農業就業人口');
      if (code) filters.push({ key: '@cat01', value: code });
    }

    const map = buildYearMap(values, '00000', filters);
    const raw = yearMapToArray(map);
    // センサスは5年ごとなので補間
    const data = interpolateNulls(raw);
    const count = raw.filter(v => v !== null).length;
    if (count === 0) throw new Error('有効データが0件');
    console.log(`[e-Stat] 農業就業人口 取得件数=${count}時点分（補間後${data.filter(v=>v!==null).length}年分）`);

    return { data, source: `農林業センサス（農林水産省）tableId=${tableId}` };
  } catch (e) {
    console.warn('[e-Stat] 農業就業人口 取得失敗:', e.message);
    return null;
  }
}

// ===================================================
// メイン：全データ一括ロード
// ===================================================
async function loadAllEStatData(appId, onProgress) {
  const client = new EStatClient(appId);
  const prog = msg => { if (onProgress) onProgress(msg); console.log('[e-Stat]', msg); };

  prog('APIキーを確認中...');
  const test = await client.testConnection();
  if (!test.ok) throw new Error(`接続失敗: ${test.error}`);
  prog('接続OK。農林水産省統計を検索中...');

  // 並列取得（失敗しても他は継続）
  const results = await Promise.allSettled([
    fetchCropHarvest(client, ['水稲'],                    '水稲収穫量'),       // rice
    fetchCropHarvest(client, ['小麦'],                    '小麦収穫量'),       // wheat
    fetchCropHarvest(client, ['大豆'],                    '大豆収穫量'),       // soybean
    fetchVegetableHarvest(client, 'トマト',               'トマト収穫量'),     // tomato
    fetchVegetableHarvest(client, 'たまねぎ',             'タマネギ収穫量'),   // onion
    fetchVegetableHarvest(client, 'キャベツ',             'キャベツ収穫量'),   // cabbage
    fetchVegetableHarvest(client, 'ばれいしょ',           'じゃがいも収穫量'), // potato
    fetchAgriWorkers(client),                                                   // workers
  ]);

  const [rice, wheat, soybean, tomato, onion, cabbage, potato, workers]
    = results.map(r => r.status === 'fulfilled' ? r.value : null);

  const ok = [rice, wheat, soybean, tomato, onion, cabbage, potato, workers]
    .filter(Boolean).length;
  prog(`取得完了（${ok}/8 成功）`);

  return { rice, wheat, soybean, tomato, onion, cabbage, potato, workers };
}
