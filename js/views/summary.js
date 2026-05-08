/**
 * 集計表ビュー（新規機能）
 * 月別・勘定科目別・メンバー別の集計とChart.jsグラフ
 */
const SummaryView = (() => {

  let _expenses = [];
  let _charts   = {};

  function render() {
    const now = new Date();
    const ym  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `
<div class="pt-3">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="fw-bold mb-0"><i class="bi bi-bar-chart-fill me-2 text-primary"></i>集計表</h5>
    <div class="d-flex gap-2 no-print">
      <button class="btn btn-outline-secondary btn-sm" onclick="window.print()">
        <i class="bi bi-printer me-1"></i>印刷
      </button>
      <button class="btn btn-outline-secondary btn-sm" id="btnRefreshSummary">
        <i class="bi bi-arrow-clockwise"></i>
      </button>
    </div>
  </div>

  <!-- 月・対象選択 -->
  <div class="card mb-3 no-print">
    <div class="card-body py-2">
      <div class="row g-2 align-items-center">
        <div class="col-6">
          <label class="form-label small mb-1 fw-semibold">対象月</label>
          <input type="month" class="form-control form-control-sm" id="inputMonth" value="${ym}">
        </div>
        <div class="col-6" id="scopeWrap">
          <label class="form-label small mb-1 fw-semibold">対象</label>
          <select class="form-select form-select-sm" id="selScope">
            <option value="me">自分のみ</option>
            <option value="all">全員</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <!-- 合計カード -->
  <div class="card summary-card mb-3 text-center">
    <div class="card-body py-3">
      <div class="text-muted small mb-1">合計申請額</div>
      <div class="summary-total" id="lblTotal">¥0</div>
      <div class="text-muted small mt-1" id="lblTotalSub"></div>
    </div>
  </div>

  <!-- 勘定科目別グラフ -->
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-3">勘定科目別</h6>
      <canvas id="chartCategory" height="200"></canvas>
      <div class="mt-3" id="tableCategoryContainer"></div>
    </div>
  </div>

  <!-- タイプ別グラフ -->
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-3">タイプ別</h6>
      <canvas id="chartType" height="180"></canvas>
    </div>
  </div>

  <!-- メンバー別テーブル（管理者のみ） -->
  <div class="card mb-3" id="memberSummaryCard" style="display:none;">
    <div class="card-body">
      <h6 class="fw-bold mb-3">メンバー別</h6>
      <div id="tableMember"></div>
    </div>
  </div>

  <!-- 電帳法対応バッジ -->
  <div class="text-center mt-3 mb-2">
    <span class="badge-denchou">電帳法対応：承認済データは改ざん防止記録あり</span>
  </div>
</div>`;
  }

  async function bindEvents(el) {
    const isAdmin = App.isAdmin();
    if (isAdmin) {
      el.querySelector('#memberSummaryCard').style.display = '';
    } else {
      el.querySelector('#scopeWrap').style.display = 'none';
    }

    try {
      _expenses = await Sheets.readExpenses();
    } catch (err) {
      el.querySelector('#lblTotal').textContent = 'エラー';
      App.showToast(err.message, 'danger');
      return;
    }

    const update = () => _renderSummary(el, isAdmin);
    el.querySelector('#inputMonth')?.addEventListener('input', update);
    el.querySelector('#selScope')?.addEventListener('change', update);
    el.querySelector('#btnRefreshSummary')?.addEventListener('click', async () => {
      _expenses = await Sheets.readExpenses();
      update();
    });

    update();
  }

  function _renderSummary(el, isAdmin) {
    const ym    = el.querySelector('#inputMonth')?.value || '';
    const scope = isAdmin ? (el.querySelector('#selScope')?.value || 'me') : 'me';
    const email = Auth.getUserEmail();

    const filtered = _expenses.filter(e => {
      if (!e.id || !e.date) return false;
      if (!e.date.startsWith(ym)) return false;
      if (scope === 'me' && e.email !== email) return false;
      return true;
    });

    const total = filtered.reduce((s, e) => s + e.amount, 0);
    el.querySelector('#lblTotal').textContent = `¥${total.toLocaleString()}`;
    el.querySelector('#lblTotalSub').textContent = `${filtered.length}件 / ${ym || '全期間'}`;

    // 勘定科目別集計
    const byCat = {};
    filtered.forEach(e => {
      // 明細分割の場合カテゴリが「科目A/科目B」形式になっている
      const cats = e.category.split('/');
      cats.forEach(c => {
        byCat[c.trim()] = (byCat[c.trim()] || 0) + (e.amount / cats.length);
      });
    });
    _renderCategoryChart(el, byCat);

    // タイプ別集計
    const byType = {};
    filtered.forEach(e => { byType[e.type] = (byType[e.type] || 0) + e.amount; });
    _renderTypeChart(el, byType);

    // メンバー別（管理者・全員表示のみ）
    if (isAdmin && scope === 'all') {
      const byMember = {};
      filtered.forEach(e => { byMember[e.name || e.email] = (byMember[e.name || e.email] || 0) + e.amount; });
      _renderMemberTable(el, byMember);
      el.querySelector('#memberSummaryCard').style.display = '';
    } else {
      el.querySelector('#memberSummaryCard').style.display = 'none';
    }
  }

  function _renderCategoryChart(el, byCat) {
    const labels = Object.keys(byCat);
    const data   = labels.map(k => Math.round(byCat[k]));
    const total  = data.reduce((s, v) => s + v, 0);

    if (_charts.category) _charts.category.destroy();
    const ctx = el.querySelector('#chartCategory')?.getContext('2d');
    if (!ctx) return;

    _charts.category = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ data, backgroundColor: _palette(labels.length), borderRadius: 4 }]
      },
      options: {
        plugins: { legend: { display: false } },
        scales: { y: { ticks: { callback: v => `¥${v.toLocaleString()}` } } },
        responsive: true,
      }
    });

    // テーブル
    const container = el.querySelector('#tableCategoryContainer');
    if (container) {
      container.innerHTML = `<table class="table table-sm list-table mt-2">
        <thead><tr><th>勘定科目</th><th class="text-end">金額</th><th class="text-end">割合</th></tr></thead>
        <tbody>
          ${labels.sort((a,b) => byCat[b] - byCat[a]).map(k => `
            <tr>
              <td>${_escape(k)}</td>
              <td class="text-end list-amount">¥${Math.round(byCat[k]).toLocaleString()}</td>
              <td class="text-end text-muted">${total > 0 ? Math.round(byCat[k] / total * 100) : 0}%</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    }
  }

  function _renderTypeChart(el, byType) {
    const labels = Object.keys(byType);
    const data   = labels.map(k => byType[k]);

    if (_charts.type) _charts.type.destroy();
    const ctx = el.querySelector('#chartType')?.getContext('2d');
    if (!ctx) return;

    _charts.type = new Chart(ctx, {
      type: 'pie',
      data: {
        labels,
        datasets: [{ data, backgroundColor: _palette(labels.length) }]
      },
      options: {
        plugins: {
          legend: { position: 'bottom' },
          tooltip: { callbacks: { label: ctx => `¥${ctx.parsed.toLocaleString()}` } }
        },
        responsive: true,
      }
    });
  }

  function _renderMemberTable(el, byMember) {
    const container = el.querySelector('#tableMember');
    if (!container) return;
    const sorted = Object.entries(byMember).sort((a, b) => b[1] - a[1]);
    container.innerHTML = `<table class="table table-sm list-table">
      <thead><tr><th>氏名</th><th class="text-end">金額</th></tr></thead>
      <tbody>
        ${sorted.map(([name, amount]) => `
          <tr>
            <td>${_escape(name)}</td>
            <td class="text-end list-amount">¥${amount.toLocaleString()}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  }

  const PALETTE = [
    '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
    '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac'
  ];
  function _palette(n) {
    return Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length]);
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return { render, bindEvents };
})();
