// ===================================================
// 農作物需給分析システム - Vue.js アプリケーション
// e-Stat 対応版 v5
// ===================================================

const { createApp } = Vue;

Chart.defaults.font.family = "'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.plugins.legend.position = 'bottom';
Chart.defaults.plugins.legend.labels.padding = 16;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(33,33,33,0.92)';
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 6;

function destroyChart(c) { if (c) { try { c.destroy(); } catch(e) {} } return null; }

// ===================================================
createApp({
  data() {
    return {
      currentPage: 'dashboard',
      selectedSDCrop:      'rice',
      selectedHarvestCrop: 'rice',
      crops: Object.values(CROPS),
      pages: [
        { id: 'dashboard',    label: 'ダッシュボード' },
        { id: 'supplydemand', label: '食料需給分析' },
        { id: 'harvest',      label: '収穫量統計' },
        { id: 'workers',      label: '農業担い手' },
        { id: 'sources',      label: 'データソース' },
      ],
      _charts: {},
      // e-Stat データ（estat.js の loadAllEStatData 戻り値をそのまま格納）
      estatData: {
        harvest: {}, area: {}, workers: null, agriBodies: null, foodBalance: null,
      },
      // API 関連
      showSettings: false,
      showApiKey:   false,
      apiKeyInput:  '',
      apiConnected: false,
      apiLoading:   false,
      apiMessage:   '',
      apiMessageType: 'info',
      dataStatus: {
        foodBalance: { label: '食料需給表',            ok: false, source: '' },
        rice:        { label: '水稲収穫量（作物統計）',  ok: false, source: '' },
        wheat:       { label: '小麦収穫量（作物統計）',  ok: false, source: '' },
        soybean:     { label: '大豆収穫量（作物統計）',  ok: false, source: '' },
        tomato:      { label: 'トマト（野菜統計）',      ok: false, source: '' },
        onion:       { label: 'タマネギ（野菜統計）',    ok: false, source: '' },
        cabbage:     { label: 'キャベツ（野菜統計）',    ok: false, source: '' },
        potato:      { label: 'じゃがいも（野菜統計）',  ok: false, source: '' },
        workers:     { label: '農業就業人口（センサス）', ok: false, source: '' },
        agriBodies:  { label: '農業経営体数（センサス）', ok: false, source: '' },
      },
    };
  },

  computed: {
    // ---- データ可用性 ----
    fbOk()        { return !!(this.estatData.foodBalance?.data && Object.keys(this.estatData.foodBalance.data).length); },
    workersOk()   { return !!(this.estatData.workers?.total?.length); },
    bodiesOk()    { return !!(this.estatData.agriBodies?.data?.length); },
    anyHarvestOk(){ return Object.values(this.estatData.harvest).some(v => v?.data?.length); },
    harvestOk()   { return !!(this.estatData.harvest?.[this.selectedHarvestCrop]?.data?.length); },
    areaOk()      { return !!(this.estatData.area?.[this.selectedHarvestCrop]?.data?.length); },
    sdCropOk()    {
      const fb = this.estatData.foodBalance?.data;
      if (!fb) return false;
      const d = fb[this.selectedSDCrop];
      return !!(d && Object.keys(d).length);
    },

    // ---- 作物オブジェクト ----
    sdCrop()      { return CROPS[this.selectedSDCrop]; },
    harvestCrop() { return CROPS[this.selectedHarvestCrop]; },
    harvestSource() { return this.estatData.harvest?.[this.selectedHarvestCrop]?.source || '—'; },
    areaSource()    { return this.estatData.area?.[this.selectedHarvestCrop]?.source || '—'; },

    // ---- ダッシュボード KPI ----
    kpi() {
      const riceList  = this.estatData.harvest?.rice?.data;
      const riceSS    = this.estatData.foodBalance?.data?.rice?.selfSufficiency;
      const workers   = this.estatData.workers?.total;
      const bodies    = this.estatData.agriBodies?.data;
      const fmt = (list, unit, dec=1) => {
        if (!list?.length) return '—';
        return list[list.length-1].value.toFixed(dec) + unit;
      };
      return {
        riceHarvest:     fmt(riceList, '万t'),
        riceHarvestYear: riceList?.length ? riceList[riceList.length-1].year + '年' : '—',
        riceSS:          fmt(riceSS, '%', 0),
        workers:         fmt(workers, '万人'),
        bodies:          fmt(bodies, '万経営体'),
      };
    },

    // ---- 接続状況サマリー ----
    dataSrcSummary() {
      const h = this.estatData.harvest || {};
      const grainOk  = ['rice','wheat','soybean'].filter(k => h[k]?.data?.length);
      const vegOk    = ['tomato','onion','cabbage','potato'].filter(k => h[k]?.data?.length);
      return [
        {
          key: 'foodBalance', label: '食料需給表',
          ok:     this.fbOk,
          detail: this.fbOk
            ? `${Object.keys(this.estatData.foodBalance.data).length}品目取得済`
            : '未取得',
        },
        {
          key: 'grainStats', label: '作物統計調査（穀物）',
          ok:     grainOk.length > 0,
          detail: grainOk.length > 0 ? `${grainOk.map(k=>CROPS[k].name).join('・')}` : '未取得',
        },
        {
          key: 'vegStats', label: '野菜生産出荷統計',
          ok:     vegOk.length > 0,
          detail: vegOk.length > 0 ? `${vegOk.map(k=>CROPS[k].name).join('・')}` : '未取得',
        },
        {
          key: 'workers', label: '農林業センサス（就業者）',
          ok:     this.workersOk,
          detail: this.workersOk
            ? `${this.estatData.workers.total.length}年分取得済`
            : '未取得',
        },
        {
          key: 'bodies', label: '農林業センサス（経営体）',
          ok:     this.bodiesOk,
          detail: this.bodiesOk
            ? `${this.estatData.agriBodies.data.length}年分取得済`
            : '未取得',
        },
      ];
    },
  },

  mounted() {
    const saved = localStorage.getItem('estat_api_key');
    if (saved) {
      this.apiKeyInput = saved;
      this.$nextTick(() => this.connectEstat(saved, false));
    }
  },

  watch: {
    selectedSDCrop()      { this.$nextTick(() => this.initSDCharts()); },
    selectedHarvestCrop() { this.$nextTick(() => this.initHarvestCharts()); },
  },

  methods: {
    // ===================================================
    // e-Stat API 連携
    // ===================================================
    async saveAndConnect() {
      if (!this.apiKeyInput) return;
      localStorage.setItem('estat_api_key', this.apiKeyInput);
      this.showSettings = false;
      await this.connectEstat(this.apiKeyInput, true);
    },

    clearApiKey() {
      localStorage.removeItem('estat_api_key');
      this.apiKeyInput = '';
      this.apiMessage = 'クリアしました。ページを再読み込みします...';
      this.apiMessageType = 'info';
      setTimeout(() => location.reload(), 1200);
    },

    async connectEstat(apiKey, _showModal) {
      this.apiLoading = true;
      this.apiMessage = '接続テスト中...';
      this.apiMessageType = 'info';
      try {
        const result = await loadAllEStatData(apiKey, msg => { this.apiMessage = msg; });
        this.mergeEstatData(result);
        this.apiConnected = true;
        const ok = Object.values(this.dataStatus).filter(s => s.ok).length;
        this.apiMessage = `取得完了。${ok}項目のデータを取得しました。`;
        this.apiMessageType = ok > 0 ? 'success' : 'error';
        this.$nextTick(() => this.initAllCharts());
      } catch (e) {
        this.apiConnected = false;
        this.apiMessage = `エラー: ${e.message}`;
        this.apiMessageType = 'error';
        this.showSettings = true;
      } finally {
        this.apiLoading = false;
      }
    },

    mergeEstatData(result) {
      this.estatData = result;
      const CROP_KEYS = ['rice','wheat','soybean','tomato','onion','cabbage','potato'];

      // 収穫量データステータス
      CROP_KEYS.forEach(key => {
        const h = result.harvest?.[key];
        if (h?.data?.length) {
          this.dataStatus[key].ok = true;
          this.dataStatus[key].source = `${h.source}（${h.data.length}年分）`;
        }
      });

      // 食料需給表
      if (result.foodBalance?.data) {
        const n = Object.keys(result.foodBalance.data).length;
        this.dataStatus.foodBalance.ok = n > 0;
        this.dataStatus.foodBalance.source = n > 0
          ? `${result.foodBalance.source}（${n}品目）`
          : '品目コード未マッチ';
      }

      // センサス
      if (result.workers?.total?.length) {
        this.dataStatus.workers.ok = true;
        this.dataStatus.workers.source = `${result.workers.source}（${result.workers.total.length}年分）`;
      }
      if (result.agriBodies?.data?.length) {
        this.dataStatus.agriBodies.ok = true;
        this.dataStatus.agriBodies.source = `${result.agriBodies.source}（${result.agriBodies.data.length}年分）`;
      }

      this.dataStatus = { ...this.dataStatus };
    },

    // ===================================================
    // ナビゲーション
    // ===================================================
    navigate(pageId) {
      this.currentPage = pageId;
      this.$nextTick(() => {
        if (pageId === 'dashboard')    this.initDashboardCharts();
        if (pageId === 'supplydemand') this.initSDCharts();
        if (pageId === 'harvest')      this.initHarvestCharts();
        if (pageId === 'workers')      this.initWorkerCharts();
      });
    },

    cropBtnStyle(crop, selectedId) {
      const active = selectedId === crop.id;
      return { borderColor: crop.color, color: active ? 'white' : crop.color, background: active ? crop.color : 'white' };
    },

    // ===================================================
    // 全チャート初期化
    // ===================================================
    initAllCharts() {
      this.initDashboardCharts();
      this.initSDCharts();
      this.initHarvestCharts();
      this.initWorkerCharts();
    },

    // ===================================================
    // Chart.js 共通オプション
    // ===================================================
    lineOpts(yLabel) {
      return {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { labels: { font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => ctx.raw == null ? null
                : ` ${ctx.dataset.label}: ${Number(ctx.raw).toLocaleString('ja-JP')} ${yLabel}`,
            }
          }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 10, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: {
            title: { display: true, text: yLabel, font: { size: 11 } },
            ticks: { font: { size: 11 }, callback: v => Number(v).toLocaleString('ja-JP') },
            grid: { color: 'rgba(0,0,0,0.06)' },
          }
        }
      };
    },

    // [{year,value}] → { labels, data }
    toChart(list) {
      if (!list?.length) return { labels: [], data: [] };
      return { labels: list.map(d => d.year), data: list.map(d => d.value) };
    },

    // 複数 [{year,value}] リストを共通年軸に揃える
    align(namedLists) {
      const valid = namedLists.filter(nl => nl.list?.length);
      if (!valid.length) return { labels: [], datasets: [] };
      const allYears = [...new Set(valid.flatMap(nl => nl.list.map(d => d.year)))].sort((a,b) => a-b);
      return {
        labels: allYears,
        datasets: valid.map(nl => {
          const map = Object.fromEntries(nl.list.map(d => [d.year, d.value]));
          return {
            label: nl.label,
            data: allYears.map(y => map[y] ?? null),
            borderColor: nl.color,
            backgroundColor: nl.bg || nl.color,
            fill: !!nl.bg,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
            borderWidth: nl.bw || 2,
          };
        })
      };
    },

    // ===================================================
    // ダッシュボード チャート
    // ===================================================
    initDashboardCharts() {
      this._charts.dashSS      = destroyChart(this._charts.dashSS);
      this._charts.dashWorkers = destroyChart(this._charts.dashWorkers);

      // 主要品目 自給率推移
      const fb = this.estatData.foodBalance?.data;
      const ctxSS = document.getElementById('chart-dash-ss');
      if (ctxSS && fb) {
        const targets = [
          { key: 'rice',    label: '米',          color: CROPS.rice.color },
          { key: 'wheat',   label: '小麦',        color: CROPS.wheat.color },
          { key: 'soybean', label: '大豆',        color: CROPS.soybean.color },
          { key: 'potato',  label: 'じゃがいも',  color: CROPS.potato.color },
          { key: 'onion',   label: 'タマネギ',    color: CROPS.onion.color },
        ].filter(t => fb[t.key]?.selfSufficiency?.length);

        if (targets.length) {
          const { labels, datasets } = this.align(
            targets.map(t => ({ list: fb[t.key].selfSufficiency, label: t.label, color: t.color }))
          );
          this._charts.dashSS = new Chart(ctxSS, {
            type: 'line',
            data: { labels, datasets },
            options: {
              ...this.lineOpts('%'),
              plugins: {
                ...this.lineOpts('%').plugins,
                annotation: {
                  annotations: {
                    ref: { type: 'line', yMin: 100, yMax: 100, borderColor: 'rgba(180,180,180,0.5)', borderDash: [5,4], borderWidth: 1 }
                  }
                }
              }
            }
          });
        }
      }

      // 農業就業人口
      this._buildWorkersChart('chart-dash-workers', 'dashWorkers');
    },

    // ===================================================
    // 食料需給分析 チャート
    // ===================================================
    initSDCharts() {
      ['sdMain','sdSS','sdCompare'].forEach(k => { this._charts[k] = destroyChart(this._charts[k]); });

      const fb = this.estatData.foodBalance?.data?.[this.selectedSDCrop];

      // 生産・消費・輸入 メインチャート
      const ctxMain = document.getElementById('chart-sd-main');
      if (ctxMain && fb) {
        const { labels, datasets } = this.align([
          { list: fb.production,  label: '国内生産量',     color: '#2E7D32', bg: 'rgba(46,125,50,0.12)',  bw: 2 },
          { list: fb.consumption, label: '国内消費仕向量', color: '#E53935', bg: null,                    bw: 2.5 },
          { list: fb.imports,     label: '輸入量',         color: '#7B1FA2', bg: 'rgba(123,31,162,0.08)', bw: 2 },
        ]);
        if (labels.length) {
          this._charts.sdMain = new Chart(ctxMain, {
            type: 'line', data: { labels, datasets }, options: this.lineOpts('万t')
          });
        }
      }

      // 自給率チャート
      const ctxSS = document.getElementById('chart-sd-ss');
      if (ctxSS && fb?.selfSufficiency?.length) {
        const { labels, data } = this.toChart(fb.selfSufficiency);
        this._charts.sdSS = new Chart(ctxSS, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: '食料自給率（重量ベース）',
              data, borderColor: '#1976D2', backgroundColor: 'rgba(25,118,210,0.12)',
              fill: true, tension: 0.3, pointRadius: 3, borderWidth: 2,
            }]
          },
          options: {
            ...this.lineOpts('%'),
            plugins: {
              ...this.lineOpts('%').plugins,
              annotation: {
                annotations: {
                  ref100: { type: 'line', yMin: 100, yMax: 100, borderColor: 'rgba(180,180,180,0.5)', borderDash: [5,4], borderWidth: 1.5,
                    label: { content: '自給率100%', display: true, position: 'end', color: '#9E9E9E', font: { size: 10 } }
                  }
                }
              }
            }
          }
        });
      }

      // 全品目 自給率比較横棒
      const ctxCmp = document.getElementById('chart-sd-compare');
      const allFb = this.estatData.foodBalance?.data;
      if (ctxCmp && allFb) {
        const items = Object.entries(allFb)
          .filter(([, d]) => d.selfSufficiency?.length)
          .map(([cropKey, d]) => {
            const latest = d.selfSufficiency[d.selfSufficiency.length - 1];
            return { name: CROPS[cropKey]?.name || cropKey, value: latest.value, year: latest.year, color: CROPS[cropKey]?.color || '#999' };
          })
          .sort((a, b) => b.value - a.value);

        if (items.length) {
          this._charts.sdCompare = new Chart(ctxCmp, {
            type: 'bar',
            data: {
              labels: items.map(i => i.name),
              datasets: [{
                label: '食料自給率（重量ベース）',
                data: items.map(i => i.value),
                backgroundColor: items.map(i => i.color + 'bb'),
                borderColor: items.map(i => i.color),
                borderWidth: 2,
              }]
            },
            options: {
              indexAxis: 'y',
              responsive: true, maintainAspectRatio: false,
              plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)} %（${items[ctx.dataIndex].year}年）` } }
              },
              scales: {
                x: { title: { display: true, text: '自給率 (%)' }, ticks: { callback: v => v + '%' } }
              }
            }
          });
        }
      }
    },

    // ===================================================
    // 収穫量統計 チャート
    // ===================================================
    initHarvestCharts() {
      ['harvest','area','harvestAll'].forEach(k => { this._charts[k] = destroyChart(this._charts[k]); });

      const cropId = this.selectedHarvestCrop;
      const crop   = CROPS[cropId];
      const hColor = crop.color;

      // 収穫量推移
      const ctxH = document.getElementById('chart-harvest');
      const harvestList = this.estatData.harvest?.[cropId]?.data;
      if (ctxH && harvestList?.length) {
        const { labels, data } = this.toChart(harvestList);
        this._charts.harvest = new Chart(ctxH, {
          type: 'line',
          data: { labels, datasets: [{
            label: `${crop.name}収穫量`, data,
            borderColor: hColor, backgroundColor: hColor + '22',
            fill: true, tension: 0.3, pointRadius: 4, borderWidth: 2,
          }]},
          options: this.lineOpts('万t')
        });
      }

      // 作付面積推移
      const ctxA = document.getElementById('chart-area');
      const areaList = this.estatData.area?.[cropId]?.data;
      if (ctxA && areaList?.length) {
        const { labels, data } = this.toChart(areaList);
        this._charts.area = new Chart(ctxA, {
          type: 'line',
          data: { labels, datasets: [{
            label: `${crop.name}作付面積`, data,
            borderColor: '#1976D2', backgroundColor: 'rgba(25,118,210,0.12)',
            fill: true, tension: 0.3, pointRadius: 4, borderWidth: 2,
          }]},
          options: this.lineOpts('万ha')
        });
      }

      // 全作物比較 横棒
      const ctxAll = document.getElementById('chart-harvest-all');
      if (ctxAll) {
        const items = Object.entries(this.estatData.harvest)
          .filter(([, v]) => v?.data?.length)
          .map(([k, v]) => {
            const last = v.data[v.data.length - 1];
            return { name: CROPS[k]?.name || k, value: last.value, year: last.year, color: CROPS[k]?.color || '#999' };
          })
          .sort((a, b) => b.value - a.value);

        if (items.length) {
          this._charts.harvestAll = new Chart(ctxAll, {
            type: 'bar',
            data: {
              labels: items.map(i => i.name),
              datasets: [{
                label: '収穫量（最新年）',
                data: items.map(i => i.value),
                backgroundColor: items.map(i => i.color + 'bb'),
                borderColor: items.map(i => i.color),
                borderWidth: 2,
              }]
            },
            options: {
              indexAxis: 'y',
              responsive: true, maintainAspectRatio: false,
              plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(2)} 万t（${items[ctx.dataIndex].year}年）` } }
              },
              scales: { x: { title: { display: true, text: '万t' } } }
            }
          });
        }
      }
    },

    // ===================================================
    // 農業担い手 チャート
    // ===================================================
    initWorkerCharts() {
      this._charts.workers = destroyChart(this._charts.workers);
      this._charts.bodies  = destroyChart(this._charts.bodies);
      this._buildWorkersChart('chart-workers', 'workers');

      // 農業経営体数
      const ctxB = document.getElementById('chart-bodies');
      const bodiesList = this.estatData.agriBodies?.data;
      if (ctxB && bodiesList?.length) {
        const { labels, data } = this.toChart(bodiesList);
        this._charts.bodies = new Chart(ctxB, {
          type: 'bar',
          data: { labels, datasets: [{
            label: '農業経営体数',
            data,
            backgroundColor: 'rgba(46,125,50,0.7)',
            borderColor: '#2E7D32',
            borderWidth: 1,
          }]},
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)} 万経営体` } }
            },
            scales: { y: { title: { display: true, text: '万経営体' }, ticks: { callback: v => v + '万' } } }
          }
        });
      }
    },

    // 農業就業人口チャートを指定 canvas に描画（ダッシュボード/就業者ページ共用）
    _buildWorkersChart(canvasId, chartKey) {
      this._charts[chartKey] = destroyChart(this._charts[chartKey]);
      const workers  = this.estatData.workers;
      const ctx = document.getElementById(canvasId);
      if (!ctx || !workers?.total?.length) return;

      const totalList = workers.total;
      const byAge     = workers.byAge || {};
      const labels    = totalList.map(d => d.year);
      const yv        = list => {
        const m = Object.fromEntries((list||[]).map(d => [d.year, d.value]));
        return labels.map(y => m[y] ?? null);
      };

      const datasets = [];
      if (byAge.over65?.length)  datasets.push({ label: '65歳以上', type: 'bar', data: yv(byAge.over65),  backgroundColor: 'rgba(211,47,47,0.75)',  stack: 'w' });
      if (byAge.age5064?.length) datasets.push({ label: '50〜64歳', type: 'bar', data: yv(byAge.age5064), backgroundColor: 'rgba(245,124,0,0.75)',  stack: 'w' });
      if (byAge.under49?.length) datasets.push({ label: '49歳以下', type: 'bar', data: yv(byAge.under49), backgroundColor: 'rgba(46,125,50,0.75)',  stack: 'w' });
      // 合計を折れ線で重ねる
      datasets.push({ label: '合計', type: 'line', data: totalList.map(d => d.value),
        borderColor: '#212121', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 3, borderWidth: 2 });

      if (!datasets.length) return;

      const stacked = !!byAge.over65;
      this._charts[chartKey] = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { labels: { font: { size: 11 } } },
            tooltip: { callbacks: { label: ctx => ctx.raw == null ? null : ` ${ctx.dataset.label}: ${ctx.raw.toFixed(1)} 万人` } }
          },
          scales: {
            x: { stacked, ticks: { font: { size: 11 } } },
            y: { stacked, title: { display: true, text: '万人' }, ticks: { callback: v => v + '万' } },
          }
        }
      });
    },
  }
}).mount('#app');
