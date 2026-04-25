// ===================================================
// 農作物需給分析システム - Vue.js アプリケーション
// ===================================================

const { createApp } = Vue;

// Chart.js グローバル設定
Chart.defaults.font.family = "'Hiragino Kaku Gothic ProN', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif";
Chart.defaults.font.size = 12;
Chart.defaults.plugins.legend.position = 'bottom';
Chart.defaults.plugins.legend.labels.padding = 16;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(33,33,33,0.92)';
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 6;

// ===================================================
// グラフ生成ユーティリティ
// ===================================================
const CHART_COLORS = {
  actual: { border: '#2E7D32', bg: 'rgba(46,125,50,0.15)' },
  forecast: { border: '#81C784', bg: 'rgba(129,199,132,0.1)' },
  supply: { border: '#1976D2', bg: 'rgba(25,118,210,0.12)' },
  demand: { border: '#E53935', bg: 'rgba(229,57,53,0.12)' },
  import: { border: '#7B1FA2', bg: 'rgba(123,31,162,0.12)' },
  forecast_supply: { border: '#42A5F5', bg: 'rgba(66,165,245,0.08)' },
  forecast_demand: { border: '#EF9A9A', bg: 'rgba(239,154,154,0.08)' },
};

function makeGradient(ctx, color, alpha1 = 0.3, alpha2 = 0.0) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, color.replace(')', `,${alpha1})`).replace('rgb', 'rgba'));
  gradient.addColorStop(1, color.replace(')', `,${alpha2})`).replace('rgb', 'rgba'));
  return gradient;
}

function forecastAnnotation(years) {
  const idx = FORECAST_START_IDX;
  const year = years[idx];
  return {
    type: 'line', xMin: year, xMax: year,
    borderColor: 'rgba(180,180,180,0.6)',
    borderDash: [6, 4], borderWidth: 1.5,
    label: { content: '予測→', enabled: true, color: '#9E9E9E', font: { size: 10 } }
  };
}

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
      selectedDemandCrop: 'rice',
      selectedSupplyCrop: 'rice',
      selectedGapCrop: 'rice',
      crops: Object.values(CROPS),
      cropMap: CROPS,
      pages: [
        { id: 'dashboard',  label: 'ダッシュボード' },
        { id: 'demand',     label: '需要分析' },
        { id: 'supply',     label: '供給分析' },
        { id: 'gap',        label: '需給ギャップ' },
        { id: 'detail',     label: '作物詳細' },
        { id: 'sources',    label: 'データソース' }
      ],
      foodTrends: FOOD_TRENDS,
      dataSources: DATA_SOURCES,
      _charts: {},
      // e-Stat API 関連
      showSettings: false,
      showApiKey: false,
      apiKeyInput: '',
      apiConnected: false,
      apiLoading: false,
      apiMessage: '',
      apiMessageType: 'info', // 'info' | 'success' | 'error'
      // 各データの取得状況
      dataStatus: {
        rice:    { label: '水稲収穫量（作物統計）',       ok: false, source: '' },
        wheat:   { label: '小麦収穫量（作物統計）',       ok: false, source: '' },
        soybean: { label: '大豆収穫量（作物統計）',       ok: false, source: '' },
        tomato:  { label: 'トマト収穫量（野菜統計）',     ok: false, source: '' },
        onion:   { label: 'タマネギ収穫量（野菜統計）',   ok: false, source: '' },
        cabbage: { label: 'キャベツ収穫量（野菜統計）',   ok: false, source: '' },
        potato:  { label: 'じゃがいも収穫量（野菜統計）', ok: false, source: '' },
        workers: { label: '農業就業人口（農林業センサス）', ok: false, source: '' },
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
    demandCrop() { return CROPS[this.selectedDemandCrop]; },
    supplyCrop() { return CROPS[this.selectedSupplyCrop]; },
    gapCrop()    { return CROPS[this.selectedGapCrop]; },
    detailCrop() { return CROPS[this.selectedCrop]; },

    detailCurrentData() {
      const c = this.detailCrop;
      const i = FORECAST_START_IDX;
      return {
        selfSufficiency: c.selfSufficiency[i],
        farmerCount: c.farmers[i],
        retailPrice: c.retailPrice[i],
        supply: +(c.production[i] + c.imports[i]).toFixed(1)
      };
    }
  },

  mounted() {
    // 保存済みAPIキーを復元して自動接続
    const saved = localStorage.getItem('estat_api_key');
    if (saved) {
      this.apiKeyInput = saved;
      this.$nextTick(() => {
        this.initAllCharts();
        this.connectEstat(saved, false); // サイレントモードで接続
      });
    } else {
      this.$nextTick(() => this.initAllCharts());
    }
  },

  watch: {
    selectedDemandCrop(v) {
      this.$nextTick(() => this.initDemandCropCharts());
    },
    selectedSupplyCrop(v) {
      this.$nextTick(() => this.initSupplyCropCharts());
    },
    selectedGapCrop(v) {
      this.$nextTick(() => this.initGapCharts());
    },
    selectedCrop(v) {
      this.$nextTick(() => this.initDetailCharts());
    }
  },

  methods: {
    // ===================================================
    // e-Stat API 連携
    // ===================================================

    // 設定モーダルから「保存して接続」
    async saveAndConnect() {
      if (!this.apiKeyInput) return;
      localStorage.setItem('estat_api_key', this.apiKeyInput);
      await this.connectEstat(this.apiKeyInput, true);
    },

    // APIキークリア
    clearApiKey() {
      localStorage.removeItem('estat_api_key');
      this.apiKeyInput = '';
      this.apiConnected = false;
      this.apiMessage = 'APIキーをクリアしました。サンプルデータを使用します。';
      this.apiMessageType = 'info';
      // データをサンプルに戻す
      Object.keys(this.dataStatus).forEach(k => {
        this.dataStatus[k].ok = false;
        this.dataStatus[k].source = '';
      });
    },

    // e-Statへ接続してデータ取得
    async connectEstat(apiKey, showModal) {
      this.apiLoading = true;
      this.apiMessage = '接続テスト中...';
      this.apiMessageType = 'info';

      try {
        const result = await loadAllEStatData(apiKey, (msg) => {
          this.apiMessage = msg;
        });

        // 取得成功したデータを CROPS へマージ
        this.mergeEstatData(result);

        this.apiConnected = true;
        const successCount = Object.values(this.dataStatus).filter(s => s.ok).length;
        this.apiMessage = `接続成功。${successCount}件のデータをe-Statから取得しました。`;
        this.apiMessageType = 'success';

        // チャートを実データで再描画
        this.$nextTick(() => this.initAllCharts());

      } catch (e) {
        this.apiConnected = false;
        this.apiMessage = `エラー: ${e.message}`;
        this.apiMessageType = 'error';
        // サイレントモードならモーダルを開いて知らせる
        if (!showModal) this.showSettings = true;
      } finally {
        this.apiLoading = false;
      }
    },

    // e-Statデータを CROPS データ構造にマージ（実績部分のみ上書き）
    mergeEstatData(result) {
      const cropKeys = ['rice', 'wheat', 'soybean', 'tomato', 'onion', 'cabbage', 'potato'];

      cropKeys.forEach(key => {
        const fetched = result[key];
        if (!fetched || !fetched.data) return;

        // null でない実績値のみを CROPS.production に反映
        fetched.data.forEach((val, i) => {
          if (val !== null && i <= FORECAST_START_IDX) {
            CROPS[key].production[i] = val;
          }
        });

        this.dataStatus[key].ok = true;
        this.dataStatus[key].source = fetched.source;
      });

      // 農業就業人口は AGRI_WORKERS.total へ反映
      if (result.workers?.data) {
        result.workers.data.forEach((val, i) => {
          const year = ALL_YEARS[i];
          const idx = AGRI_WORKERS.years.indexOf(year);
          if (idx !== -1 && val !== null) {
            AGRI_WORKERS.total[idx] = val;
          }
        });
        this.dataStatus.workers.ok = true;
        this.dataStatus.workers.source = result.workers.source;
      }
    },

    // ===================================================
    // ナビゲーション
    // ===================================================
    navigate(pageId) {
      this.currentPage = pageId;
    },
    goToCrop(cropId) {
      this.selectedCrop = cropId;
      this.currentPage = 'detail';
    },
    setGapCrop(cropId) {
      this.selectedGapCrop = cropId;
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
    getTrendIcon(current, base) {
      const diff = ((current - base) / base * 100).toFixed(0);
      if (diff > 5) return '↑';
      if (diff < -5) return '↓';
      return '→';
    },
    formatNum(n) {
      if (n === null || n === undefined) return '-';
      return n.toLocaleString('ja-JP');
    },
    impactClass(impact) {
      if (impact === '高') return 'impact-badge impact-high';
      if (impact === '中') return 'impact-badge impact-medium';
      return 'impact-badge impact-low';
    },
    gapCardClass(crop) {
      const r = calcRisk(crop);
      return `gap-card risk-${r.level}`;
    },
    gapRiskLabel(crop) {
      const r = calcRisk(crop);
      if (r.level === 'high') return '🔴 要注意';
      if (r.level === 'medium') return '🟡 注意';
      return '🟢 安定';
    },

    // ===================================================
    // 全チャート初期化
    // ===================================================
    initAllCharts() {
      this.initDashboardCharts();
      this.initDemandCharts();
      this.initDemandCropCharts();
      this.initSupplyCharts();
      this.initSupplyCropCharts();
      this.initGapCharts();
      this.initDetailCharts();
    },

    // ===================================================
    // ダッシュボード チャート
    // ===================================================
    initDashboardCharts() {
      this._charts.workers = destroyChart(this._charts.workers);
      this._charts.selfSuff = destroyChart(this._charts.selfSuff);

      // 農業就業者数推移
      const ctxW = document.getElementById('chart-workers-dash');
      if (ctxW) {
        this._charts.workers = new Chart(ctxW, {
          type: 'bar',
          data: {
            labels: AGRI_WORKERS.years,
            datasets: [
              {
                label: '65歳以上',
                data: AGRI_WORKERS.over65,
                backgroundColor: 'rgba(211,47,47,0.7)',
                stack: 'workers'
              },
              {
                label: '50～64歳',
                data: AGRI_WORKERS.age5059,
                backgroundColor: 'rgba(245,124,0,0.7)',
                stack: 'workers'
              },
              {
                label: '49歳以下',
                data: AGRI_WORKERS.under49,
                backgroundColor: 'rgba(46,125,50,0.7)',
                stack: 'workers'
              }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { position: 'bottom' },
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}万人` } }
            },
            scales: {
              x: { stacked: true },
              y: {
                stacked: true,
                title: { display: true, text: '万人' },
                ticks: { callback: v => v + '万' }
              }
            }
          }
        });
      }

      // 食料自給率（品目別）
      const ctxS = document.getElementById('chart-selfsuff-dash');
      if (ctxS) {
        const years = [2010, 2014, 2018, 2022, 2024, 2028, 2032, 2035];
        const indices = years.map(y => ALL_YEARS.indexOf(y));

        const datasets = [
          { label: '米', data: indices.map(i => CROPS.rice.selfSufficiency[i]), borderColor: CROPS.rice.color },
          { label: '小麦', data: indices.map(i => CROPS.wheat.selfSufficiency[i]), borderColor: CROPS.wheat.color },
          { label: '大豆', data: indices.map(i => CROPS.soybean.selfSufficiency[i]), borderColor: CROPS.soybean.color },
          { label: 'じゃがいも', data: indices.map(i => CROPS.potato.selfSufficiency[i]), borderColor: CROPS.potato.color },
          { label: 'キャベツ', data: indices.map(i => CROPS.cabbage.selfSufficiency[i]), borderColor: CROPS.cabbage.color },
        ].map(d => ({
          ...d, tension: 0.3, fill: false, pointRadius: 3,
          backgroundColor: d.borderColor,
          borderDash: years.map((y,i) => y > 2024 ? [5,4] : []).flat().length > 0 ? [] : [],
        }));

        this._charts.selfSuff = new Chart(ctxS, {
          type: 'line',
          data: { labels: years, datasets },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%` } },
              annotation: { annotations: { vLine: {
                type: 'line', xMin: 4, xMax: 4,
                borderColor: 'rgba(180,180,180,0.6)', borderDash: [6,4], borderWidth: 1.5
              }}}
            },
            scales: {
              y: {
                title: { display: true, text: '自給率 (%)' },
                ticks: { callback: v => v + '%' }
              }
            }
          }
        });
      }
    },

    // ===================================================
    // 需要分析 チャート（人口・価格）
    // ===================================================
    initDemandCharts() {
      this._charts.population = destroyChart(this._charts.population);
      this._charts.priceIndex = destroyChart(this._charts.priceIndex);

      // 人口推移
      const ctxP = document.getElementById('chart-population');
      if (ctxP) {
        this._charts.population = new Chart(ctxP, {
          type: 'line',
          data: {
            labels: POPULATION_DATA.years,
            datasets: [
              {
                label: '総人口',
                data: POPULATION_DATA.total,
                borderColor: '#1976D2', backgroundColor: 'rgba(25,118,210,0.1)',
                fill: true, tension: 0.3,
                yAxisID: 'y'
              },
              {
                label: '65歳以上',
                data: POPULATION_DATA.over65,
                borderColor: '#D32F2F', backgroundColor: 'rgba(211,47,47,0.08)',
                fill: true, tension: 0.3, borderDash: [0],
                yAxisID: 'y'
              },
              {
                label: '生産年齢人口(15-64歳)',
                data: POPULATION_DATA.workingAge,
                borderColor: '#388E3C', backgroundColor: 'rgba(56,142,60,0.08)',
                fill: true, tension: 0.3,
                yAxisID: 'y'
              }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw.toLocaleString()}万人` } }
            },
            scales: {
              y: {
                title: { display: true, text: '万人' },
                ticks: { callback: v => (v/10000).toFixed(1) + '億' }
              }
            }
          }
        });
      }

      // 小売価格指数（2010年=100）
      const ctxI = document.getElementById('chart-price-index');
      if (ctxI) {
        const selectedCrops = ['rice','wheat','soybean','onion','potato'];
        const years2 = [2010,2012,2014,2016,2018,2020,2022,2024,2026,2028,2030,2032,2035];
        const indices2 = years2.map(y => ALL_YEARS.indexOf(y));
        const colors2 = selectedCrops.map(id => CROPS[id].color);

        this._charts.priceIndex = new Chart(ctxI, {
          type: 'line',
          data: {
            labels: years2,
            datasets: selectedCrops.map((id, ci) => {
              const base = CROPS[id].retailPrice[0];
              return {
                label: CROPS[id].name,
                data: indices2.map(i => +(CROPS[id].retailPrice[i] / base * 100).toFixed(1)),
                borderColor: colors2[ci],
                backgroundColor: colors2[ci],
                tension: 0.3, fill: false, pointRadius: 2
              };
            })
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}（2010年=100）` } }
            },
            scales: {
              y: {
                title: { display: true, text: '価格指数（2010年=100）' },
                ticks: { callback: v => v }
              }
            }
          }
        });
      }
    },

    // ===================================================
    // 需要分析 作物別チャート
    // ===================================================
    initDemandCropCharts() {
      this._charts.demandCrop = destroyChart(this._charts.demandCrop);
      this._charts.demandPrice = destroyChart(this._charts.demandPrice);

      const crop = CROPS[this.selectedDemandCrop];
      const { actual: consActual, forecast: consForecast } = splitActualForecast(crop.consumption);

      // 消費量推移
      const ctxC = document.getElementById('chart-demand-crop');
      if (ctxC) {
        this._charts.demandCrop = new Chart(ctxC, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              {
                label: '消費量（実績）',
                data: consActual, spanGaps: false,
                borderColor: '#E53935', backgroundColor: 'rgba(229,57,53,0.12)',
                fill: true, tension: 0.3, pointRadius: 2
              },
              {
                label: '消費量（予測）',
                data: consForecast, spanGaps: false,
                borderColor: '#EF9A9A', borderDash: [6,4],
                backgroundColor: 'rgba(239,154,154,0.06)',
                fill: true, tension: 0.3, pointRadius: 2
              }
            ]
          },
          options: this.lineChartOptions(crop.unit, '消費量推移')
        });
      }

      // 価格推移（小売）
      const ctxP = document.getElementById('chart-demand-price');
      if (ctxP) {
        const { actual: priceActual, forecast: priceForecast } = splitActualForecast(crop.retailPrice);
        this._charts.demandPrice = new Chart(ctxP, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              {
                label: '小売価格（実績）',
                data: priceActual, spanGaps: false,
                borderColor: '#F9A825', backgroundColor: 'rgba(249,168,37,0.12)',
                fill: true, tension: 0.3, pointRadius: 2
              },
              {
                label: '小売価格（予測）',
                data: priceForecast, spanGaps: false,
                borderColor: '#FFD54F', borderDash: [6,4],
                backgroundColor: 'rgba(255,213,79,0.06)',
                fill: true, tension: 0.3, pointRadius: 2
              }
            ]
          },
          options: this.lineChartOptions('円/kg', '小売価格推移')
        });
      }
    },

    // ===================================================
    // 供給分析 固定チャート
    // ===================================================
    initSupplyCharts() {
      this._charts.corporations = destroyChart(this._charts.corporations);
      this._charts.productivity = destroyChart(this._charts.productivity);

      // 農業法人数
      const ctxCorp = document.getElementById('chart-corporations');
      if (ctxCorp) {
        this._charts.corporations = new Chart(ctxCorp, {
          type: 'bar',
          data: {
            labels: AGRI_CORPORATIONS.years,
            datasets: [
              {
                label: '農業法人総数',
                data: AGRI_CORPORATIONS.total,
                backgroundColor: AGRI_CORPORATIONS.years.map(y => y <= 2024 ? 'rgba(46,125,50,0.75)' : 'rgba(129,199,132,0.6)'),
                borderColor: AGRI_CORPORATIONS.years.map(y => y <= 2024 ? '#2E7D32' : '#81C784'),
                borderWidth: 1
              }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: ctx => ` 法人数: ${ctx.raw.toLocaleString()}社` } }
            },
            scales: {
              y: {
                title: { display: true, text: '法人数（社）' },
                ticks: { callback: v => (v/10000).toFixed(1) + '万' }
              }
            }
          }
        });
      }

      // 生産性指数
      const ctxProd = document.getElementById('chart-productivity');
      if (ctxProd) {
        this._charts.productivity = new Chart(ctxProd, {
          type: 'line',
          data: {
            labels: PRODUCTIVITY.years,
            datasets: [
              {
                label: '総合生産性指数',
                data: PRODUCTIVITY.overall,
                borderColor: '#2E7D32', backgroundColor: 'rgba(46,125,50,0.12)',
                fill: true, tension: 0.3, pointRadius: 3
              },
              {
                label: '機械化・大規模化効果',
                data: PRODUCTIVITY.mechanize,
                borderColor: '#1976D2', backgroundColor: 'transparent',
                fill: false, tension: 0.3, pointRadius: 3
              },
              {
                label: 'ICT・スマート農業効果',
                data: PRODUCTIVITY.ict,
                borderColor: '#7B1FA2', backgroundColor: 'transparent',
                fill: false, tension: 0.3, borderDash: [5,3], pointRadius: 3
              }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}（2010=100）` } }
            },
            scales: {
              y: {
                title: { display: true, text: '生産性指数（2010年=100）' }
              }
            }
          }
        });
      }
    },

    // ===================================================
    // 供給分析 作物別チャート
    // ===================================================
    initSupplyCropCharts() {
      this._charts.supplyCrop = destroyChart(this._charts.supplyCrop);
      this._charts.supplyFarmers = destroyChart(this._charts.supplyFarmers);

      const crop = CROPS[this.selectedSupplyCrop];

      // 生産量・輸入量推移
      const ctxS = document.getElementById('chart-supply-crop');
      if (ctxS) {
        const { actual: prodActual, forecast: prodForecast } = splitActualForecast(crop.production);
        const { actual: impActual, forecast: impForecast } = splitActualForecast(crop.imports);

        this._charts.supplyCrop = new Chart(ctxS, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              {
                label: '国内生産量（実績）', data: prodActual, spanGaps: false,
                borderColor: '#2E7D32', backgroundColor: 'rgba(46,125,50,0.12)',
                fill: true, tension: 0.3, pointRadius: 2
              },
              {
                label: '国内生産量（予測）', data: prodForecast, spanGaps: false,
                borderColor: '#81C784', borderDash: [6,4],
                backgroundColor: 'rgba(129,199,132,0.06)',
                fill: true, tension: 0.3, pointRadius: 2
              },
              {
                label: '輸入量（実績）', data: impActual, spanGaps: false,
                borderColor: '#7B1FA2', backgroundColor: 'rgba(123,31,162,0.08)',
                fill: true, tension: 0.3, pointRadius: 2
              },
              {
                label: '輸入量（予測）', data: impForecast, spanGaps: false,
                borderColor: '#CE93D8', borderDash: [6,4],
                backgroundColor: 'rgba(206,147,216,0.05)',
                fill: true, tension: 0.3, pointRadius: 2
              }
            ]
          },
          options: this.lineChartOptions(crop.unit, '生産量・輸入量推移')
        });
      }

      // 農業従事者数推移
      const ctxF = document.getElementById('chart-supply-farmers');
      if (ctxF) {
        const { actual: farmerActual, forecast: farmerForecast } = splitActualForecast(crop.farmers);

        this._charts.supplyFarmers = new Chart(ctxF, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              {
                label: '農業従事者数（実績）', data: farmerActual, spanGaps: false,
                borderColor: '#F57C00', backgroundColor: 'rgba(245,124,0,0.12)',
                fill: true, tension: 0.3, pointRadius: 2
              },
              {
                label: '農業従事者数（予測）', data: farmerForecast, spanGaps: false,
                borderColor: '#FFCC80', borderDash: [6,4],
                backgroundColor: 'rgba(255,204,128,0.06)',
                fill: true, tension: 0.3, pointRadius: 2
              }
            ]
          },
          options: this.lineChartOptions('万人', '農業従事者数推移')
        });
      }
    },

    // ===================================================
    // 需給ギャップ チャート
    // ===================================================
    initGapCharts() {
      this._charts.gap = destroyChart(this._charts.gap);
      this._charts.gapBar = destroyChart(this._charts.gapBar);

      const crop = CROPS[this.selectedGapCrop];
      const sdData = calcSupplyDemand(crop);

      // 需給バランス（積み上げ面積グラフ）
      const ctxG = document.getElementById('chart-gap-main');
      if (ctxG) {
        const supply = sdData.map(d => d.supply);
        const demand = sdData.map(d => d.demand);
        const { actual: supplyActual, forecast: supplyForecast } = splitActualForecast(supply);
        const { actual: demandActual, forecast: demandForecast } = splitActualForecast(demand);

        this._charts.gap = new Chart(ctxG, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              {
                label: '供給量（実績）', data: supplyActual, spanGaps: false,
                borderColor: '#1976D2', backgroundColor: 'rgba(25,118,210,0.15)',
                fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2
              },
              {
                label: '供給量（予測）', data: supplyForecast, spanGaps: false,
                borderColor: '#42A5F5', borderDash: [6,4],
                backgroundColor: 'rgba(66,165,245,0.08)',
                fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2
              },
              {
                label: '需要量（実績）', data: demandActual, spanGaps: false,
                borderColor: '#E53935', backgroundColor: 'transparent',
                fill: false, tension: 0.3, pointRadius: 2, borderWidth: 2.5
              },
              {
                label: '需要量（予測）', data: demandForecast, spanGaps: false,
                borderColor: '#EF9A9A', borderDash: [6,4],
                backgroundColor: 'transparent',
                fill: false, tension: 0.3, pointRadius: 2, borderWidth: 2
              }
            ]
          },
          options: this.lineChartOptions(crop.unit, '需給バランス')
        });
      }

      // 需給ギャップ（棒グラフ）
      const ctxGB = document.getElementById('chart-gap-bar');
      if (ctxGB) {
        const gapYears = [2010,2015,2020,2024,2025,2028,2030,2032,2035];
        const gapIndices = gapYears.map(y => ALL_YEARS.indexOf(y));
        const gaps = gapIndices.map(i => sdData[i] ? +sdData[i].gap.toFixed(2) : null);

        this._charts.gapBar = new Chart(ctxGB, {
          type: 'bar',
          data: {
            labels: gapYears,
            datasets: [{
              label: '需給ギャップ（供給-需要）',
              data: gaps,
              backgroundColor: gaps.map((g, i) => {
                const y = gapYears[i];
                if (g === null) return 'transparent';
                const col = g >= 0 ? '46,125,50' : '211,47,47';
                return y <= 2024 ? `rgba(${col},0.75)` : `rgba(${col},0.45)`;
              }),
              borderColor: gaps.map(g => g >= 0 ? '#2E7D32' : '#D32F2F'),
              borderWidth: 1
            }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: {
                label: ctx => {
                  const v = ctx.raw;
                  return ` ギャップ: ${v >= 0 ? '+' : ''}${v} ${crop.unit}`;
                }
              }}
            },
            scales: {
              y: {
                title: { display: true, text: `${crop.unit}（プラス=供給過剰）` },
                grid: { color: ctx => ctx.tick.value === 0 ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.06)' }
              }
            }
          }
        });
      }
    },

    // ===================================================
    // 作物詳細 チャート
    // ===================================================
    initDetailCharts() {
      this._charts.detailMain = destroyChart(this._charts.detailMain);
      this._charts.detailPrice = destroyChart(this._charts.detailPrice);
      this._charts.detailFarmers = destroyChart(this._charts.detailFarmers);
      this._charts.detailSS = destroyChart(this._charts.detailSS);

      const crop = CROPS[this.selectedCrop];

      // メイン需給チャート
      const ctxM = document.getElementById('chart-detail-main');
      if (ctxM) {
        const { actual: prodA, forecast: prodF } = splitActualForecast(crop.production);
        const { actual: impA, forecast: impF } = splitActualForecast(crop.imports);
        const { actual: consA, forecast: consF } = splitActualForecast(crop.consumption);

        this._charts.detailMain = new Chart(ctxM, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              { label: '国内生産（実績）', data: prodA, spanGaps: false, borderColor: '#2E7D32', backgroundColor: 'rgba(46,125,50,0.15)', fill: true, tension: 0.3, pointRadius: 2 },
              { label: '国内生産（予測）', data: prodF, spanGaps: false, borderColor: '#81C784', borderDash: [6,4], backgroundColor: 'rgba(129,199,132,0.08)', fill: true, tension: 0.3, pointRadius: 2 },
              { label: '輸入（実績）', data: impA, spanGaps: false, borderColor: '#7B1FA2', backgroundColor: 'rgba(123,31,162,0.1)', fill: true, tension: 0.3, pointRadius: 2 },
              { label: '輸入（予測）', data: impF, spanGaps: false, borderColor: '#CE93D8', borderDash: [6,4], backgroundColor: 'rgba(206,147,216,0.06)', fill: true, tension: 0.3, pointRadius: 2 },
              { label: '消費量（実績）', data: consA, spanGaps: false, borderColor: '#E53935', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, borderWidth: 2.5 },
              { label: '消費量（予測）', data: consF, spanGaps: false, borderColor: '#EF9A9A', borderDash: [6,4], backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, borderWidth: 2 }
            ]
          },
          options: this.lineChartOptions(crop.unit, '需給推移')
        });
      }

      // 価格推移
      const ctxP = document.getElementById('chart-detail-price');
      if (ctxP) {
        const { actual: rpA, forecast: rpF } = splitActualForecast(crop.retailPrice);
        this._charts.detailPrice = new Chart(ctxP, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              { label: '小売価格（実績）', data: rpA, spanGaps: false, borderColor: '#F9A825', backgroundColor: 'rgba(249,168,37,0.12)', fill: true, tension: 0.3, pointRadius: 2 },
              { label: '小売価格（予測）', data: rpF, spanGaps: false, borderColor: '#FFD54F', borderDash: [6,4], backgroundColor: 'rgba(255,213,79,0.06)', fill: true, tension: 0.3, pointRadius: 2 }
            ]
          },
          options: this.lineChartOptions('円/kg', '小売価格推移')
        });
      }

      // 農業従事者数
      const ctxFm = document.getElementById('chart-detail-farmers');
      if (ctxFm) {
        const { actual: fmA, forecast: fmF } = splitActualForecast(crop.farmers);
        this._charts.detailFarmers = new Chart(ctxFm, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              { label: '農業従事者数（実績）', data: fmA, spanGaps: false, borderColor: '#F57C00', backgroundColor: 'rgba(245,124,0,0.12)', fill: true, tension: 0.3, pointRadius: 2 },
              { label: '農業従事者数（予測）', data: fmF, spanGaps: false, borderColor: '#FFCC80', borderDash: [6,4], backgroundColor: 'rgba(255,204,128,0.06)', fill: true, tension: 0.3, pointRadius: 2 }
            ]
          },
          options: this.lineChartOptions('万人', '農業従事者数推移')
        });
      }

      // 自給率推移
      const ctxSS = document.getElementById('chart-detail-ss');
      if (ctxSS) {
        const { actual: ssA, forecast: ssF } = splitActualForecast(crop.selfSufficiency);
        this._charts.detailSS = new Chart(ctxSS, {
          type: 'line',
          data: {
            labels: ALL_YEARS,
            datasets: [
              { label: '食料自給率（実績）', data: ssA, spanGaps: false, borderColor: '#1976D2', backgroundColor: 'rgba(25,118,210,0.12)', fill: true, tension: 0.3, pointRadius: 2 },
              { label: '食料自給率（予測）', data: ssF, spanGaps: false, borderColor: '#42A5F5', borderDash: [6,4], backgroundColor: 'rgba(66,165,245,0.06)', fill: true, tension: 0.3, pointRadius: 2 }
            ]
          },
          options: this.lineChartOptions('%', '食料自給率推移')
        });
      }
    },

    // ===================================================
    // 共通チャートオプション
    // ===================================================
    lineChartOptions(unit, title) {
      return {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          title: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                if (ctx.raw === null) return null;
                return ` ${ctx.dataset.label}: ${typeof ctx.raw === 'number' ? ctx.raw.toLocaleString('ja-JP') : ctx.raw} ${unit}`;
              },
              afterTitle: items => items[0]?.label > 2024 ? '（予測値）' : '（実績値）'
            }
          },
          legend: { labels: { font: { size: 11 } } }
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 10, font: { size: 11 } },
            grid: { color: 'rgba(0,0,0,0.04)' }
          },
          y: {
            title: { display: true, text: unit, font: { size: 11 } },
            ticks: { font: { size: 11 }, callback: v => v.toLocaleString('ja-JP') },
            grid: { color: 'rgba(0,0,0,0.06)' }
          }
        }
      };
    }
  }
}).mount('#app');
