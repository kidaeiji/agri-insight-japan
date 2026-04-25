// ===================================================
// 農作物需給分析システム - Vue.js アプリケーション
// e-Stat API 対応版
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

function destroyChart(instance) {
  if (instance) { try { instance.destroy(); } catch(e) {} }
  return null;
}

// ===================================================
// Vue アプリケーション
// ===================================================
createApp({
  data() {
    return {
      currentPage: 'dashboard',
      selectedCrop: 'rice',
      selectedHarvestCrop: 'rice',
      selectedFBCrop: 'rice',
      crops: Object.values(CROPS),
      cropMap: CROPS,
      pages: [
        { id: 'dashboard',   label: 'ダッシュボード' },
        { id: 'harvest',     label: '収穫量分析' },
        { id: 'workers',     label: '農業就業者' },
        { id: 'foodbalance', label: '食料需給表' },
        { id: 'detail',      label: '作物詳細' },
        { id: 'sources',     label: 'データソース' },
      ],
      dataSources: DATA_SOURCES,
      estatDataSources: [
        { name: '作物統計調査（農林水産省）', desc: '水稲・小麦・大豆の収穫量および作付面積' },
        { name: '野菜生産出荷統計（農林水産省）', desc: 'トマト・タマネギ・キャベツ・じゃがいもの収穫量および作付面積' },
        { name: '食料需給表（農林水産省）', desc: '品目別の国内生産量・消費仕向量・輸入量・食料自給率' },
        { name: '農林業センサス（農林水産省）', desc: '農業就業人口（年齢別）および農業経営体数' },
      ],
      _charts: {},
      // e-Stat データ
      estatData: {
        harvest: {},
        area: {},
        workers: null,
        agriBodies: null,
        foodBalance: null,
      },
      // e-Stat API 関連
      showSettings: false,
      showApiKey: false,
      apiKeyInput: '',
      apiConnected: false,
      apiLoading: false,
      apiMessage: '',
      apiMessageType: 'info',
      dataStatus: {
        rice:        { label: '水稲収穫量',         ok: false, source: '' },
        wheat:       { label: '小麦収穫量',         ok: false, source: '' },
        soybean:     { label: '大豆収穫量',         ok: false, source: '' },
        tomato:      { label: 'トマト収穫量',       ok: false, source: '' },
        onion:       { label: 'タマネギ収穫量',     ok: false, source: '' },
        cabbage:     { label: 'キャベツ収穫量',     ok: false, source: '' },
        potato:      { label: 'じゃがいも収穫量',   ok: false, source: '' },
        workers:     { label: '農業就業人口',       ok: false, source: '' },
        agriBodies:  { label: '農業経営体数',       ok: false, source: '' },
        foodBalance: { label: '食料需給表',         ok: false, source: '' },
      }
    };
  },

  computed: {
    riskMatrix() {
      return this.crops.map(crop => {
        const r = calcRisk(crop);
        return { ...crop, ...r };
      }).sort((a, b) => b.score - a.score);
    },
    detailCrop() { return CROPS[this.selectedCrop]; },
    harvestCrop() { return CROPS[this.selectedHarvestCrop]; },

    // 収穫量ページ
    harvestDataOk() {
      return !!(this.estatData.harvest?.[this.selectedHarvestCrop]?.data?.length);
    },
    areaDataOk() {
      return !!(this.estatData.area?.[this.selectedHarvestCrop]?.data?.length);
    },
    harvestDataSource() {
      return this.estatData.harvest?.[this.selectedHarvestCrop]?.source || '—';
    },
    areaDataSource() {
      return this.estatData.area?.[this.selectedHarvestCrop]?.source || '—';
    },

    // 食料需給表ページ
    fbDataOk() {
      return !!(this.estatData.foodBalance?.data?.[this.selectedFBCrop]);
    },

    // 作物詳細ページ
    detailHarvestOk() {
      return !!(this.estatData.harvest?.[this.selectedCrop]?.data?.length);
    },
    detailHarvestSource() {
      return this.estatData.harvest?.[this.selectedCrop]?.source || '—';
    },
    detailFBOk() {
      return !!(this.estatData.foodBalance?.data?.[this.selectedCrop]);
    },
    detailLatestHarvest() {
      const list = this.estatData.harvest?.[this.selectedCrop]?.data;
      if (!list?.length) return CROPS[this.selectedCrop].production[14].toFixed(1);
      return list[list.length - 1].value.toFixed(1);
    },
    detailLatestSS() {
      const fb = this.estatData.foodBalance?.data?.[this.selectedCrop];
      if (fb?.selfSufficiency?.length) {
        const list = fb.selfSufficiency;
        return list[list.length - 1].value.toFixed(0);
      }
      return CROPS[this.selectedCrop].selfSufficiency[14];
    },
    detailLatestProd() {
      const fb = this.estatData.foodBalance?.data?.[this.selectedCrop];
      if (fb?.production?.length) {
        const list = fb.production;
        return list[list.length - 1].value.toFixed(1);
      }
      return CROPS[this.selectedCrop].production[14].toFixed(1);
    },
    detailLatestImports() {
      const fb = this.estatData.foodBalance?.data?.[this.selectedCrop];
      if (fb?.imports?.length) {
        const list = fb.imports;
        return list[list.length - 1].value.toFixed(1);
      }
      return CROPS[this.selectedCrop].imports[14].toFixed(1);
    },

    // ダッシュボード KPI
    kpiSelfSuff() {
      const fb = this.estatData.foodBalance?.data;
      if (fb?.rice?.selfSufficiency?.length) {
        const list = fb.rice.selfSufficiency;
        return list[list.length - 1].value.toFixed(0) + '%（米）';
      }
      return '38%';
    },
    kpiWorkers() {
      const w = this.estatData.workers?.total;
      if (w?.length) {
        return w[w.length - 1].value.toFixed(1) + '万人';
      }
      return '約168万人';
    },
    kpiAgriBodies() {
      const d = this.estatData.agriBodies?.data;
      if (d?.length) {
        const v = d[d.length - 1].value;
        return (v / 10000).toFixed(1) + '万経営体';
      }
      return '約108万経営体';
    },
    kpiRiceHarvest() {
      const list = this.estatData.harvest?.rice?.data;
      if (list?.length) {
        return list[list.length - 1].value.toFixed(1) + '万t';
      }
      return '約770万t';
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
    selectedHarvestCrop() {
      this.$nextTick(() => this.initHarvestCharts());
    },
    selectedFBCrop() {
      this.$nextTick(() => this.initFoodBalanceCharts());
    },
    selectedCrop() {
      this.$nextTick(() => this.initDetailCharts());
    },
  },

  methods: {
    // ===================================================
    // e-Stat API 連携
    // ===================================================
    async saveAndConnect() {
      if (!this.apiKeyInput) return;
      localStorage.setItem('estat_api_key', this.apiKeyInput);
      await this.connectEstat(this.apiKeyInput, true);
    },

    clearApiKey() {
      localStorage.removeItem('estat_api_key');
      this.apiKeyInput = '';
      this.apiMessage = 'クリアしました。ページを再読み込みします...';
      this.apiMessageType = 'info';
      setTimeout(() => location.reload(), 1200);
    },

    async connectEstat(apiKey, showModal) {
      this.apiLoading = true;
      this.apiMessage = '接続テスト中...';
      this.apiMessageType = 'info';

      try {
        const result = await loadAllEStatData(apiKey, (msg) => {
          this.apiMessage = msg;
        });

        this.mergeEstatData(result);
        this.apiConnected = true;

        const successCount = Object.values(this.dataStatus).filter(s => s.ok).length;
        this.apiMessage = `接続成功。${successCount}件のデータをe-Statから取得しました。`;
        this.apiMessageType = 'success';

        this.$nextTick(() => this.initAllCharts());

      } catch (e) {
        this.apiConnected = false;
        this.apiMessage = `エラー: ${e.message}`;
        this.apiMessageType = 'error';
        if (!showModal) this.showSettings = true;
      } finally {
        this.apiLoading = false;
      }
    },

    mergeEstatData(result) {
      this.estatData = result;

      const CROP_KEYS = ['rice', 'wheat', 'soybean', 'tomato', 'onion', 'cabbage', 'potato'];
      CROP_KEYS.forEach(key => {
        const h = result.harvest?.[key];
        if (h?.data?.length) {
          this.dataStatus[key].ok = true;
          this.dataStatus[key].source = `${h.source}（${h.data.length}年分）`;
        }
      });

      if (result.workers?.total?.length) {
        this.dataStatus.workers.ok = true;
        this.dataStatus.workers.source = result.workers.source;
      }
      if (result.agriBodies?.data?.length) {
        this.dataStatus.agriBodies.ok = true;
        this.dataStatus.agriBodies.source = result.agriBodies.source;
      }
      if (result.foodBalance?.data) {
        const n = Object.keys(result.foodBalance.data).length;
        this.dataStatus.foodBalance.ok = true;
        this.dataStatus.foodBalance.source = `${result.foodBalance.source}（${n}品目）`;
      }

      this.dataStatus = { ...this.dataStatus };
    },

    // ===================================================
    // ナビゲーション
    // ===================================================
    navigate(pageId) {
      this.currentPage = pageId;
      this.$nextTick(() => {
        if (pageId === 'dashboard')   this.initDashboardCharts();
        if (pageId === 'harvest')     this.initHarvestCharts();
        if (pageId === 'workers')     this.initWorkerCharts();
        if (pageId === 'foodbalance') this.initFoodBalanceCharts();
        if (pageId === 'detail')      this.initDetailCharts();
      });
    },

    goToCrop(cropId) {
      this.selectedCrop = cropId;
      this.currentPage = 'detail';
      this.$nextTick(() => this.initDetailCharts());
    },

    // ===================================================
    // リスク表示ヘルパー
    // ===================================================
    getRiskCellClass(level) {
      if (level === 'high') return 'cell-high';
      if (level === 'medium') return 'cell-medium';
      return 'cell-low';
    },
    getRiskBadgeClass(level) {
      if (level === 'high') return 'risk-badge badge-high';
      if (level === 'medium') return 'risk-badge badge-medium';
      return 'risk-badge badge-low';
    },
    getRiskLabel(level) {
      if (level === 'high') return '🔴 高リスク';
      if (level === 'medium') return '🟡 中リスク';
      return '🟢 低リスク';
    },

    // ===================================================
    // 全チャート初期化
    // ===================================================
    initAllCharts() {
      this.initDashboardCharts();
      this.initHarvestCharts();
      this.initWorkerCharts();
      this.initFoodBalanceCharts();
      this.initDetailCharts();
    },

    // ===================================================
    // チャート共通ユーティリティ
    // ===================================================
    lineChartOptions(unit, _title) {
      return {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { labels: { font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.raw === null || ctx.raw === undefined) return null;
                return ` ${ctx.dataset.label}: ${typeof ctx.raw === 'number' ? ctx.raw.toLocaleString('ja-JP') : ctx.raw} ${unit}`;
              }
            }
          }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 10, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: {
            title: { display: true, text: unit, font: { size: 11 } },
            ticks: { font: { size: 11 }, callback: v => v.toLocaleString('ja-JP') },
            grid: { color: 'rgba(0,0,0,0.06)' }
          }
        }
      };
    },

    // list = [{year, value}] → labels と data を返す
    listToChart(list) {
      if (!list?.length) return { labels: [], data: [] };
      return { labels: list.map(d => d.year), data: list.map(d => d.value) };
    },

    // 複数 list を共通年軸に揃える
    alignLists(namedLists) {
      const allYears = [...new Set(
        namedLists.flatMap(({ list }) => (list || []).map(d => d.year))
      )].sort((a, b) => a - b);

      return {
        labels: allYears,
        series: namedLists.map(({ list, label, color, bgColor, dash }) => {
          const map = Object.fromEntries((list || []).map(d => [d.year, d.value]));
          return {
            label,
            data: allYears.map(y => map[y] ?? null),
            borderColor: color,
            backgroundColor: bgColor || color,
            borderDash: dash || [],
            fill: !!bgColor,
            tension: 0.3,
            pointRadius: 3,
            spanGaps: true,
          };
        })
      };
    },

    // ===================================================
    // ダッシュボード チャート
    // ===================================================
    initDashboardCharts() {
      this._charts.workersDash = destroyChart(this._charts.workersDash);
      this._charts.selfSuffDash = destroyChart(this._charts.selfSuffDash);

      const workers = this.estatData.workers;
      const ctxW = document.getElementById('chart-workers-dash');
      if (ctxW && workers?.total?.length) {
        const totalList = workers.total;
        const byAge = workers.byAge || {};
        const labels = totalList.map(d => d.year);
        const yearToVal = list => {
          const map = Object.fromEntries((list || []).map(d => [d.year, d.value]));
          return labels.map(y => map[y] ?? null);
        };

        const datasets = [];
        if (byAge.over65?.length)  datasets.push({ label: '65歳以上', data: yearToVal(byAge.over65), backgroundColor: 'rgba(211,47,47,0.75)', stack: 'w' });
        if (byAge.age5064?.length) datasets.push({ label: '50〜64歳', data: yearToVal(byAge.age5064), backgroundColor: 'rgba(245,124,0,0.75)', stack: 'w' });
        if (byAge.under49?.length) datasets.push({ label: '49歳以下', data: yearToVal(byAge.under49), backgroundColor: 'rgba(46,125,50,0.75)', stack: 'w' });
        if (!datasets.length) {
          datasets.push({ label: '農業就業人口', data: totalList.map(d => d.value), backgroundColor: 'rgba(46,125,50,0.75)' });
        }

        this._charts.workersDash = new Chart(ctxW, {
          type: 'bar',
          data: { labels, datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw?.toFixed(1)}万人` } }
            },
            scales: {
              x: { stacked: true },
              y: { stacked: true, title: { display: true, text: '万人' }, ticks: { callback: v => v + '万' } }
            }
          }
        });
      }

      // 自給率推移（食料需給表）
      const fb = this.estatData.foodBalance?.data;
      const ctxS = document.getElementById('chart-selfsuff-dash');
      if (ctxS && fb) {
        const targets = [
          { key: 'rice',    label: '米',          color: CROPS.rice.color },
          { key: 'wheat',   label: '小麦',        color: CROPS.wheat.color },
          { key: 'soybean', label: '大豆',        color: CROPS.soybean.color },
          { key: 'potato',  label: 'じゃがいも',  color: CROPS.potato.color },
          { key: 'cabbage', label: 'キャベツ',    color: CROPS.cabbage.color },
        ];

        const namedLists = targets
          .filter(t => fb[t.key]?.selfSufficiency?.length)
          .map(t => ({ list: fb[t.key].selfSufficiency, label: t.label, color: t.color }));

        if (namedLists.length) {
          const { labels, series } = this.alignLists(namedLists);
          this._charts.selfSuffDash = new Chart(ctxS, {
            type: 'line',
            data: { labels, datasets: series },
            options: {
              responsive: true, maintainAspectRatio: false,
              plugins: {
                tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%` } }
              },
              scales: {
                y: { title: { display: true, text: '自給率 (%)' }, ticks: { callback: v => v + '%' } }
              }
            }
          });
        }
      }
    },

    // ===================================================
    // 収穫量分析 チャート
    // ===================================================
    initHarvestCharts() {
      this._charts.harvest = destroyChart(this._charts.harvest);
      this._charts.area = destroyChart(this._charts.area);
      this._charts.harvestAll = destroyChart(this._charts.harvestAll);

      const cropId = this.selectedHarvestCrop;
      const crop = CROPS[cropId];

      // 収穫量推移
      const harvestInfo = this.estatData.harvest?.[cropId];
      const ctxH = document.getElementById('chart-harvest');
      if (ctxH && harvestInfo?.data?.length) {
        const { labels, data } = this.listToChart(harvestInfo.data);
        this._charts.harvest = new Chart(ctxH, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: `${crop.name}収穫量`,
              data,
              borderColor: crop.color,
              backgroundColor: crop.color.replace('#', 'rgba(').replace(/^rgba\(([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\)$/, (_, r, g, b) => `rgba(${parseInt(r,16)},${parseInt(g,16)},${parseInt(b,16)},0.15)`),
              fill: true, tension: 0.3, pointRadius: 4,
            }]
          },
          options: this.lineChartOptions('万t', '収穫量推移')
        });
      }

      // 作付面積推移
      const areaInfo = this.estatData.area?.[cropId];
      const ctxA = document.getElementById('chart-area');
      if (ctxA && areaInfo?.data?.length) {
        const { labels, data } = this.listToChart(areaInfo.data);
        this._charts.area = new Chart(ctxA, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: `${crop.name}作付面積`,
              data,
              borderColor: '#1976D2',
              backgroundColor: 'rgba(25,118,210,0.12)',
              fill: true, tension: 0.3, pointRadius: 4,
            }]
          },
          options: this.lineChartOptions('万ha', '作付面積推移')
        });
      }

      // 全作物比較（最新年横棒）
      const ctxAll = document.getElementById('chart-harvest-all');
      if (ctxAll) {
        const cropIds = ['rice', 'wheat', 'soybean', 'tomato', 'onion', 'cabbage', 'potato'];
        const barLabels = [], barData = [], barColors = [];
        cropIds.forEach(id => {
          const list = this.estatData.harvest?.[id]?.data;
          if (list?.length) {
            barLabels.push(CROPS[id].name);
            barData.push(list[list.length - 1].value);
            barColors.push(CROPS[id].color);
          }
        });
        if (barLabels.length) {
          this._charts.harvestAll = new Chart(ctxAll, {
            type: 'bar',
            data: {
              labels: barLabels,
              datasets: [{
                label: '収穫量（最新年）',
                data: barData,
                backgroundColor: barColors.map(c => c + 'bb'),
                borderColor: barColors,
                borderWidth: 2,
              }]
            },
            options: {
              responsive: true, maintainAspectRatio: false,
              indexAxis: 'y',
              plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toFixed(1)} 万t` } }
              },
              scales: {
                x: { title: { display: true, text: '万t' } }
              }
            }
          });
        }
      }
    },

    // ===================================================
    // 農業就業者 チャート
    // ===================================================
    initWorkerCharts() {
      this._charts.workersAge = destroyChart(this._charts.workersAge);
      this._charts.agriBodies = destroyChart(this._charts.agriBodies);

      // 農業就業人口（年齢別）
      const workers = this.estatData.workers;
      const ctxW = document.getElementById('chart-workers-age');
      if (ctxW && workers?.total?.length) {
        const totalList = workers.total;
        const byAge = workers.byAge || {};
        const labels = totalList.map(d => d.year);
        const yearToVal = list => {
          const map = Object.fromEntries((list || []).map(d => [d.year, d.value]));
          return labels.map(y => map[y] ?? null);
        };

        const datasets = [];
        if (byAge.over65?.length)  datasets.push({ label: '65歳以上', data: yearToVal(byAge.over65), backgroundColor: 'rgba(211,47,47,0.75)', stack: 'w' });
        if (byAge.age5064?.length) datasets.push({ label: '50〜64歳', data: yearToVal(byAge.age5064), backgroundColor: 'rgba(245,124,0,0.75)', stack: 'w' });
        if (byAge.under49?.length) datasets.push({ label: '49歳以下', data: yearToVal(byAge.under49), backgroundColor: 'rgba(46,125,50,0.75)', stack: 'w' });

        // 年齢別がなければ合計のみ
        if (!datasets.length) {
          datasets.push({
            label: '農業就業人口',
            data: totalList.map(d => d.value),
            backgroundColor: 'rgba(46,125,50,0.75)',
          });
        } else {
          // 合計を折れ線で重ねる
          datasets.push({
            label: '合計',
            data: totalList.map(d => d.value),
            borderColor: '#212121',
            backgroundColor: 'transparent',
            type: 'line',
            fill: false, tension: 0.3, pointRadius: 3,
          });
        }

        this._charts.workersAge = new Chart(ctxW, {
          type: 'bar',
          data: { labels, datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw?.toFixed(1)}万人` } }
            },
            scales: {
              x: { stacked: true },
              y: { stacked: true, title: { display: true, text: '万人' }, ticks: { callback: v => v + '万' } }
            }
          }
        });
      }

      // 農業経営体数
      const bodies = this.estatData.agriBodies;
      const ctxB = document.getElementById('chart-agri-bodies');
      if (ctxB && bodies?.data?.length) {
        const { labels, data } = this.listToChart(bodies.data);
        this._charts.agriBodies = new Chart(ctxB, {
          type: 'bar',
          data: {
            labels,
            datasets: [{
              label: '農業経営体数',
              data,
              backgroundColor: labels.map(() => 'rgba(46,125,50,0.7)'),
              borderColor: '#2E7D32',
              borderWidth: 1,
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: ctx => ` 経営体数: ${ctx.raw.toLocaleString()}万` } }
            },
            scales: {
              y: { title: { display: true, text: '万経営体' }, ticks: { callback: v => v + '万' } }
            }
          }
        });
      }
    },

    // ===================================================
    // 食料需給表 チャート
    // ===================================================
    initFoodBalanceCharts() {
      ['fbProd', 'fbCons', 'fbImp', 'fbSS'].forEach(k => {
        this._charts[k] = destroyChart(this._charts[k]);
      });

      const fb = this.estatData.foodBalance?.data?.[this.selectedFBCrop];
      if (!fb) return;

      const crop = CROPS[this.selectedFBCrop];

      const makeLineChart = (canvasId, chartKey, list, label, unit, color) => {
        if (!list?.length) return;
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        const { labels, data } = this.listToChart(list);
        this._charts[chartKey] = new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label,
              data,
              borderColor: color,
              backgroundColor: color + '22',
              fill: true, tension: 0.3, pointRadius: 3,
            }]
          },
          options: this.lineChartOptions(unit, label)
        });
      };

      makeLineChart('chart-fb-prod', 'fbProd', fb.production,      '国内生産量',     '万t', '#2E7D32');
      makeLineChart('chart-fb-cons', 'fbCons', fb.consumption,     '国内消費仕向量', '万t', '#E53935');
      makeLineChart('chart-fb-imp',  'fbImp',  fb.imports,         '輸入量',         '万t', '#7B1FA2');
      makeLineChart('chart-fb-ss',   'fbSS',   fb.selfSufficiency, '食料自給率',     '%',   '#1976D2');
    },

    // ===================================================
    // 作物詳細 チャート
    // ===================================================
    initDetailCharts() {
      this._charts.detailHarvest = destroyChart(this._charts.detailHarvest);
      this._charts.detailFB = destroyChart(this._charts.detailFB);
      this._charts.detailSS = destroyChart(this._charts.detailSS);

      const cropId = this.selectedCrop;
      const crop = CROPS[cropId];

      // 収穫量チャート
      const harvestInfo = this.estatData.harvest?.[cropId];
      const ctxH = document.getElementById('chart-detail-harvest');
      if (ctxH && harvestInfo?.data?.length) {
        const { labels, data } = this.listToChart(harvestInfo.data);
        this._charts.detailHarvest = new Chart(ctxH, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: `${crop.name}収穫量`,
              data,
              borderColor: crop.color,
              backgroundColor: crop.color + '22',
              fill: true, tension: 0.3, pointRadius: 4,
            }]
          },
          options: this.lineChartOptions('万t', '収穫量推移')
        });
      }

      // 食料需給表（生産・消費・輸入）
      const fb = this.estatData.foodBalance?.data?.[cropId];
      const ctxFB = document.getElementById('chart-detail-fb');
      if (ctxFB && fb) {
        const namedLists = [
          { list: fb.production,  label: '国内生産量',     color: '#2E7D32', bgColor: 'rgba(46,125,50,0.12)' },
          { list: fb.consumption, label: '国内消費仕向量', color: '#E53935', bgColor: null },
          { list: fb.imports,     label: '輸入量',         color: '#7B1FA2', bgColor: 'rgba(123,31,162,0.08)' },
        ].filter(d => d.list?.length);

        if (namedLists.length) {
          const { labels, series } = this.alignLists(namedLists);
          this._charts.detailFB = new Chart(ctxFB, {
            type: 'line',
            data: { labels, datasets: series },
            options: this.lineChartOptions('万t', '需給推移')
          });
        }
      }

      // 自給率チャート
      const ctxSS = document.getElementById('chart-detail-ss');
      if (ctxSS && fb?.selfSufficiency?.length) {
        const { labels, data } = this.listToChart(fb.selfSufficiency);
        this._charts.detailSS = new Chart(ctxSS, {
          type: 'line',
          data: {
            labels,
            datasets: [{
              label: '食料自給率',
              data,
              borderColor: '#1976D2',
              backgroundColor: 'rgba(25,118,210,0.12)',
              fill: true, tension: 0.3, pointRadius: 3,
            }]
          },
          options: this.lineChartOptions('%', '食料自給率推移')
        });
      }
    },
  }
}).mount('#app');
