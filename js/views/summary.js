/**
 * 集計表ビュー
 * 勘定科目別・タイプ別・メンバー×勘定科目クロス集計の3種ピボットテーブル
 * PC/タブレット（≥768px）では全幅レイアウト
 */
const SummaryView = (() => {

  let _expenses = [];
  let _charts   = {};

  function render() {
    const now = new Date();
    const ym  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return `
<div class="pt-3">
  <!-- ヘッダー -->
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

  <!-- フィルター -->
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

  <!-- 合計 -->
  <div class="card summary-card mb-3 text-center">
    <div class="card-body py-3">
      <div class="text-muted small mb-1">合計申請額</div>
      <div class="summary-total" id="lblTotal">¥0</div>
      <div class="text-muted small mt-1" id="lblTotalSub"></div>
    </div>
  </div>

  <!-- ピボットテーブル 1・2（PC: 2カラム） -->
  <div class="summary-grid-2 mb-3">

    <!-- 1: 勘定科目別 -->
    <div class="card h-100">
      <div class="card-body">
        <h6 class="fw-bold mb-2"><i class="bi bi-tag-fill me-1 text-primary"></i>勘定科目別</h6>
        <div class="summary-chart-wrap mb-2">
          <canvas id="chartCategory"></canvas>
        </div>
        <div class="table-responsive">
          <table class="table table-sm list-table mb-0" id="tableCat">
            <thead><tr>
              <th>勘定科目</th>
              <th class="text-end">件数</th>
              <th class="text-end">金額</th>
              <th class="text-end no-print-col">割合</th>
            </tr></thead>
            <tbody id="tbodyCat"></tbody>
            <tfoot id="tfootCat"></tfoot>
          </table>
        </div>
      </div>
    </div>

    <!-- 2: タイプ別 -->
    <div class="card h-100">
      <div class="card-body">
        <h6 class="fw-bold mb-2"><i class="bi bi-grid-fill me-1 text-success"></i>タイプ別</h6>
        <div class="summary-chart-wrap mb-2">
          <canvas id="chartType"></canvas>
        </div>
        <div class="table-responsive">
          <table class="table table-sm list-table mb-0">
            <thead><tr>
              <th>タイプ</th>
              <th class="text-end">件数</th>
              <th class="text-end">金額</th>
              <th class="text-end no-print-col">割合</th>
            </tr></thead>
            <tbody id="tbodyType"></tbody>
            <tfoot id="tfootType"></tfoot>
          </table>
        </div>
      </div>
    </div>

  </div>

  <!-- 3: メンバー×勘定科目クロス集計（管理者・全員選択時のみ） -->
  <div class="card mb-3" id="crossCard" style="display:none;">
    <div class="card-body">
      <h6 class="fw-bold mb-2"><i class="bi bi-table me-1 text-warning"></i>メンバー別×勘定科目クロス集計</h6>
      <div class="table-responsive">
        <table class="table table-sm list-table cross-table mb-0" id="tableCross"></table>
      </div>
    </div>
  </div>

  <!-- 電帳法バッジ -->
  <div class="text-center mt-3 mb-2">
    <span class="badge-denchou">電帳法対応：承認済データは改ざん防止記録あり</span>
  </div>
</div>`;
  }

  async function bindEvents(el) {
    // PC/タブレットでは幅を広げる
    const appMain = document.getElementById('appMain');
    if (appMain) appMain.style.maxWidth = '';

    const isAdmin = App.isAdmin();
    if (!isAdmin) el.querySelector('#scopeWrap').style.display = 'none';

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
      App.showLoading('更新中...');
      try { _expenses = await Sheets.readExpenses(); } finally { App.hideLoading(); }
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
      if (ym && !e.date.startsWith(ym)) return false;
      if (scope === 'me' && e.email !== email) return false;
      return true;
    });

    const total = filtered.reduce((s, e) => s + e.amount, 0);
    el.querySelector('#lblTotal').textContent = `¥${total.toLocaleString()}`;
    el.querySelector('#lblTotalSub').textContent = `${filtered.length}件 / ${ym || '全期間'}`;

    _renderCategoryPivot(el, filtered, total);
    _renderTypePivot(el, filtered, total);

    const showCross = isAdmin && scope === 'all';
    const crossCard = el.querySelector('#crossCard');
    if (crossCard) crossCard.style.display = showCross ? '' : 'none';
    if (showCross) _renderCrossTable(el, filtered);
  }

  // ── ピボット1: 勘定科目別 ──────────────────────────────
  function _renderCategoryPivot(el, filtered, grandTotal) {
    const byCat = {};
    const countByCat = {};
    filtered.forEach(e => {
      const cats = (e.category || '').split('/');
      cats.forEach(c => {
        const key = c.trim() || '（未分類）';
        byCat[key]      = (byCat[key]      || 0) + e.amount / cats.length;
        countByCat[key] = (countByCat[key] || 0) + 1;
      });
    });

    const labels = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
    const data   = labels.map(k => Math.round(byCat[k]));

    if (_charts.category) _charts.category.destroy();
    const ctx = el.querySelector('#chartCategory')?.getContext('2d');
    if (ctx && labels.length > 0) {
      _charts.category = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ data, backgroundColor: _palette(labels.length), borderRadius: 4 }] },
        options: {
          plugins: { legend: { display: false } },
          scales: { y: { ticks: { callback: v => `¥${v.toLocaleString()}` } } },
          responsive: true, maintainAspectRatio: true,
        }
      });
    }

    const tbody = el.querySelector('#tbodyCat');
    const tfoot = el.querySelector('#tfootCat');
    if (tbody) {
      tbody.innerHTML = labels.map(k => `<tr>
        <td>${_escape(k)}</td>
        <td class="text-end">${countByCat[k]}</td>
        <td class="text-end list-amount">¥${Math.round(byCat[k]).toLocaleString()}</td>
        <td class="text-end text-muted no-print-col">${grandTotal > 0 ? Math.round(byCat[k] / grandTotal * 100) : 0}%</td>
      </tr>`).join('');
    }
    if (tfoot) {
      tfoot.innerHTML = `<tr class="table-light fw-bold">
        <td>合計</td>
        <td class="text-end">${filtered.length}</td>
        <td class="text-end">¥${grandTotal.toLocaleString()}</td>
        <td class="text-end no-print-col">100%</td>
      </tr>`;
    }
  }

  // ── ピボット2: タイプ別 ──────────────────────────────
  function _renderTypePivot(el, filtered, grandTotal) {
    const byType = {};
    const countByType = {};
    filtered.forEach(e => {
      const t = e.type || '（未設定）';
      byType[t]      = (byType[t]      || 0) + e.amount;
      countByType[t] = (countByType[t] || 0) + 1;
    });

    const labels = Object.keys(byType).sort((a, b) => byType[b] - byType[a]);
    const data   = labels.map(k => byType[k]);

    if (_charts.type) _charts.type.destroy();
    const ctx = el.querySelector('#chartType')?.getContext('2d');
    if (ctx && labels.length > 0) {
      _charts.type = new Chart(ctx, {
        type: 'pie',
        data: { labels, datasets: [{ data, backgroundColor: _palette(labels.length) }] },
        options: {
          plugins: {
            legend: { position: 'bottom', labels: { font: { size: 11 } } },
            tooltip: { callbacks: { label: c => `¥${c.parsed.toLocaleString()}` } }
          },
          responsive: true, maintainAspectRatio: true,
        }
      });
    }

    const tbody = el.querySelector('#tbodyType');
    const tfoot = el.querySelector('#tfootType');
    if (tbody) {
      tbody.innerHTML = labels.map(k => `<tr>
        <td>${_escape(k)}</td>
        <td class="text-end">${countByType[k]}</td>
        <td class="text-end list-amount">¥${byType[k].toLocaleString()}</td>
        <td class="text-end text-muted no-print-col">${grandTotal > 0 ? Math.round(byType[k] / grandTotal * 100) : 0}%</td>
      </tr>`).join('');
    }
    if (tfoot) {
      tfoot.innerHTML = `<tr class="table-light fw-bold">
        <td>合計</td>
        <td class="text-end">${filtered.length}</td>
        <td class="text-end">¥${grandTotal.toLocaleString()}</td>
        <td class="text-end no-print-col">100%</td>
      </tr>`;
    }
  }

  // ── ピボット3: メンバー×勘定科目クロス集計 ──────────────
  function _renderCrossTable(el, filtered) {
    const table = el.querySelector('#tableCross');
    if (!table) return;

    // データ集計
    const members = [...new Set(filtered.map(e => e.name || e.email))].sort();
    const cats    = [...new Set(filtered.flatMap(e =>
      (e.category || '').split('/').map(c => c.trim()).filter(Boolean)
    ))].sort();

    if (members.length === 0 || cats.length === 0) {
      table.innerHTML = '<tr><td class="text-muted small">データなし</td></tr>';
      return;
    }

    // member → category → amount
    const matrix = {};
    const memberTotal = {};
    const catTotal    = {};
    filtered.forEach(e => {
      const m = e.name || e.email;
      const cs = (e.category || '').split('/');
      cs.forEach(c => {
        const key = c.trim() || '（未分類）';
        if (!matrix[m]) matrix[m] = {};
        matrix[m][key] = (matrix[m][key] || 0) + e.amount / cs.length;
        memberTotal[m] = (memberTotal[m] || 0) + e.amount / cs.length;
        catTotal[key]  = (catTotal[key]  || 0) + e.amount / cs.length;
      });
    });
    const grandTotal = Object.values(memberTotal).reduce((s, v) => s + v, 0);

    // HTMLビルド
    const thCats = cats.map(c => `<th class="text-end" style="min-width:80px;">${_escape(c)}</th>`).join('');
    const rows = members.map(m => {
      const cells = cats.map(c => {
        const v = matrix[m]?.[c] || 0;
        return `<td class="text-end">${v ? '¥' + Math.round(v).toLocaleString() : '-'}</td>`;
      }).join('');
      return `<tr>
        <td class="fw-semibold" style="white-space:nowrap;">${_escape(m)}</td>
        ${cells}
        <td class="text-end fw-bold list-amount">¥${Math.round(memberTotal[m] || 0).toLocaleString()}</td>
      </tr>`;
    }).join('');
    const footCells = cats.map(c => `<td class="text-end fw-bold">¥${Math.round(catTotal[c] || 0).toLocaleString()}</td>`).join('');

    table.innerHTML = `
      <thead class="table-light">
        <tr>
          <th style="min-width:100px;">氏名</th>
          ${thCats}
          <th class="text-end">合計</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot class="table-light fw-bold">
        <tr>
          <td>合計</td>
          ${footCells}
          <td class="text-end">¥${Math.round(grandTotal).toLocaleString()}</td>
        </tr>
      </tfoot>`;
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
