/**
 * 集計表ビュー
 * デフォルト直近12ヶ月・3種ピボットテーブル（メンバー別/未精算/勘定科目別）
 * セルクリックでドリルダウン表示
 */
const SummaryView = (() => {

  let _expenses = [];

  function render() {
    const defaultMonths = window.innerWidth >= 768 ? 12 : 3;
    const { fromYM, toYM } = _rangeForMonths(defaultMonths);
    const _btn = (m, label) => {
      const active = m === defaultMonths;
      return `<button class="btn ${active ? 'btn-outline-primary active' : 'btn-outline-secondary'}" data-months="${m}">${label}</button>`;
    };
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

  <!-- フィルター -->
  <div class="card mb-3 no-print">
    <div class="card-body py-2">
      <div class="d-flex flex-wrap gap-2 align-items-center">
        <div class="btn-group btn-group-sm" id="presetBtns">
          ${_btn(3, '3ヶ月')}
          ${_btn(6, '6ヶ月')}
          ${_btn(12, '12ヶ月')}
          <button class="btn btn-outline-secondary" data-months="0">カスタム</button>
        </div>
        <div id="customRange" class="d-none d-flex align-items-center gap-1">
          <input type="month" class="form-control form-control-sm" id="inputFrom"
            value="${fromYM}" style="width:140px;">
          <span class="text-muted small">〜</span>
          <input type="month" class="form-control form-control-sm" id="inputTo"
            value="${toYM}" style="width:140px;">
        </div>
      </div>
    </div>
  </div>

  <!-- ① 勘定科目別 -->
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-2 pivot-title"><i class="bi bi-tags-fill me-1 text-success"></i><span id="titleCat">勘定科目一覧</span></h6>
      <div class="table-responsive" id="wrapCat">
        <div class="text-muted small text-center py-3">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- ② メンバー別 -->
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-2 pivot-title"><i class="bi bi-people-fill me-1"></i><span id="titleMember">メンバー別</span></h6>
      <div class="table-responsive" id="wrapMember">
        <div class="text-muted small text-center py-3">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- ③ 未精算一覧 -->
  <div class="card mb-3">
    <div class="card-body">
      <h6 class="fw-bold mb-2 pivot-title"><i class="bi bi-exclamation-triangle-fill me-1 text-warning"></i><span id="titleUnpaid">未精算一覧</span></h6>
      <div class="table-responsive" id="wrapUnpaid">
        <div class="text-muted small text-center py-3">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- 電帳法バッジ -->
  <div class="text-center mt-2 mb-3">
    <span class="badge-denchou">電帳法対応：承認済データは改ざん防止記録あり</span>
  </div>
</div>`;
  }

  async function bindEvents(el) {
    const appMain = document.getElementById('appMain');
    if (appMain) appMain.style.maxWidth = '';

    App.showLoading('読み込み中...');
    try {
      _expenses = await Sheets.readExpenses();
    } catch (err) {
      App.showToast(err.message, 'danger');
      return;
    } finally {
      App.hideLoading();
    }

    const update = () => _renderAll(el);

    // プリセットボタン
    el.querySelectorAll('#presetBtns [data-months]').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('#presetBtns [data-months]').forEach(b =>
          b.className = b === btn
            ? b.className.replace('btn-outline-secondary', 'btn-outline-primary') + (b.classList.contains('active') ? '' : ' active')
            : b.className.replace('btn-outline-primary', 'btn-outline-secondary').replace(' active', '')
        );
        // クリーンなアクティブ切替
        el.querySelectorAll('#presetBtns [data-months]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        el.querySelectorAll('#presetBtns [data-months]').forEach(b => {
          b.classList.remove('btn-outline-primary', 'btn-outline-secondary');
          b.classList.add(b === btn ? 'btn-outline-primary' : 'btn-outline-secondary');
        });

        const months = Number(btn.dataset.months);
        const customRange = el.querySelector('#customRange');
        if (months === 0) {
          customRange.classList.remove('d-none');
        } else {
          customRange.classList.add('d-none');
          const { fromYM, toYM } = _rangeForMonths(months);
          el.querySelector('#inputFrom').value = fromYM;
          el.querySelector('#inputTo').value   = toYM;
        }
        update();
      });
    });

    el.querySelector('#inputFrom')?.addEventListener('change', update);
    el.querySelector('#inputTo')?.addEventListener('change', update);

    el.querySelector('#btnRefreshSummary')?.addEventListener('click', async () => {
      App.showLoading('更新中...');
      try { _expenses = await Sheets.readExpenses(); } finally { App.hideLoading(); }
      update();
    });

    // 3テーブルの横スクロールを連動させる
    const wraps = ['#wrapCat', '#wrapMember', '#wrapUnpaid']
      .map(id => el.querySelector(id)).filter(Boolean);
    let _syncing = false;
    wraps.forEach(wrap => {
      wrap.addEventListener('scroll', () => {
        if (_syncing) return;
        _syncing = true;
        wraps.forEach(w => { if (w !== wrap) w.scrollLeft = wrap.scrollLeft; });
        _syncing = false;
      });
    });

    update();
  }

  // ─── 期間ヘルパー ──────────────────────────────────────────
  function _defaultRange() { return _rangeForMonths(window.innerWidth >= 768 ? 12 : 3); }

  function _rangeForMonths(n) {
    const now  = new Date();
    const toYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const from = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
    const fromYM = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
    return { fromYM, toYM };
  }

  function _getMonths(fromYM, toYM) {
    const months = [];
    let [fy, fm] = fromYM.split('-').map(Number);
    const [ty, tm] = toYM.split('-').map(Number);
    while (fy < ty || (fy === ty && fm <= tm)) {
      months.push(`${fy}-${String(fm).padStart(2, '0')}`);
      fm++;
      if (fm > 12) { fm = 1; fy++; }
    }
    return months;
  }

  function _currentRange(el) {
    const fromYM = el.querySelector('#inputFrom')?.value || _defaultRange().fromYM;
    const toYM   = el.querySelector('#inputTo')?.value   || _defaultRange().toYM;
    return { fromYM, toYM, months: _getMonths(fromYM, toYM) };
  }

  // ─── メイン描画 ────────────────────────────────────────────
  function _renderAll(el) {
    const { fromYM, toYM, months } = _currentRange(el);

    const role      = App.getUserRole();
    const userEmail = Auth.getUserEmail();
    const filtered = _expenses.filter(e => {
      if (!e.id || !e.date) return false;
      const ym = e.date.substring(0, 7);
      if (ym < fromYM || ym > toYM) return false;
      if (role === 'member' && e.email !== userEmail) return false;
      return true;
    });
    // 精算日が空のものを未精算とする（会社払いは申請時に「会社払い」が入るため除外される）
    const unpaid = filtered.filter(e => !e.settlementDate);

    const periodLabel = `直近${months.length}ヶ月間`;
    el.querySelector('#titleMember').textContent = `メンバー別（${periodLabel}）`;
    el.querySelector('#titleUnpaid').textContent = `未精算一覧（${periodLabel}）`;
    el.querySelector('#titleCat').textContent    = `勘定科目一覧（${periodLabel}）`;

    const isAdmin = App.getUserRole() === 'admin';

    _renderPivotTable(el.querySelector('#wrapMember'), filtered, months, _memberKey, '申請者');
    _renderPivotTable(el.querySelector('#wrapUnpaid'), unpaid,   months, _memberKey, '申請者',
      isAdmin ? (drillExpenses, onDone) => _batchSettleDrill(drillExpenses, onDone, el) : null);
    _renderPivotTable(el.querySelector('#wrapCat'),    filtered, months, _categoryKey, '勘定科目');
  }

  // ─── キー関数 ──────────────────────────────────────────────
  function _memberKey(e) {
    if (e.payment) return [{ key: `🏢 ${e.payment}`, amount: e.amount }];
    return [{ key: e.name || e.email || '（不明）', amount: e.amount }];
  }
  function _categoryKey(e) {
    const parts = (e.category || '（未分類）').split('/').map(s => s.trim()).filter(Boolean);
    if (!parts.length) parts.push('（未分類）');
    return parts.map(k => ({ key: k, amount: e.amount / parts.length }));
  }

  // ─── 一括精算処理 ──────────────────────────────────────────
  async function _batchSettleDrill(expenses, onDone, el) {
    const ids = expenses.map(e => e.id).filter(Boolean);
    if (!ids.length) return;
    const today = new Date().toISOString().slice(0, 10);
    const ok = await App.confirm(`${ids.length}件を精算済みにします（精算日: ${today}）。よろしいですか？`);
    if (!ok) return;
    App.showLoading('精算処理中...');
    try {
      await Sheets.batchSettle(ids, today);
      _expenses = await Sheets.readExpenses();
      if (el) _renderAll(el);
      App.showToast(`${ids.length}件を精算済みにしました`, 'success');
      if (onDone) onDone();
    } catch (err) {
      App.showToast('精算処理エラー: ' + err.message, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  // ─── ピボットテーブル描画 ──────────────────────────────────
  function _renderPivotTable(container, records, months, keyFn, rowLabel, settleCallback = null) {
    if (!container) return;

    // 集計
    const matrix        = {}; // {rowKey: {ym: amount}}
    const drillRecords  = {}; // {rowKey: {ym: [expense]}}
    const rowTotals     = {};
    const colTotals     = {};
    let grandTotal = 0;

    records.forEach(e => {
      const ym = e.date.substring(0, 7);
      if (!months.includes(ym)) return;
      keyFn(e).forEach(({ key, amount }) => {
        if (!matrix[key])       { matrix[key] = {}; drillRecords[key] = {}; }
        if (!drillRecords[key][ym]) drillRecords[key][ym] = [];
        matrix[key][ym]      = (matrix[key][ym]      || 0) + amount;
        rowTotals[key]        = (rowTotals[key]        || 0) + amount;
        colTotals[ym]         = (colTotals[ym]         || 0) + amount;
        grandTotal            += amount;
        if (!drillRecords[key][ym].includes(e)) drillRecords[key][ym].push(e);
      });
    });

    const rowKeys = Object.keys(rowTotals).sort((a, b) => rowTotals[b] - rowTotals[a]);

    if (rowKeys.length === 0) {
      container.innerHTML = '<div class="text-muted small text-center py-3">データなし</div>';
      return;
    }

    // ヘッダー
    const thMonths = months.map(ym =>
      `<th class="text-end" style="min-width:72px;">${_fmtYM(ym)}</th>`
    ).join('');

    // データ行
    let drillIdx = 0;
    const drillMap = []; // [{key, ym}]

    const bodyRows = rowKeys.map(key => {
      const cells = months.map(ym => {
        const v = matrix[key]?.[ym] || 0;
        if (v === 0) return '<td class="text-end text-muted" style="font-size:0.78rem;">-</td>';
        const idx = drillIdx++;
        drillMap.push({ key, ym });
        return `<td class="text-end pivot-cell" data-di="${idx}"
          style="cursor:pointer;">${Math.round(v).toLocaleString()}</td>`;
      }).join('');
      return `<tr>
        <td title="${_escape(key)}">${_escape(key)}</td>
        ${cells}
        <td class="text-end fw-bold">${Math.round(rowTotals[key]).toLocaleString()}</td>
      </tr>`;
    }).join('');

    // フッター（合計行）
    const footCells = months.map(ym =>
      `<td class="text-end fw-bold">${Math.round(colTotals[ym] || 0).toLocaleString()}</td>`
    ).join('');

    container.innerHTML = `
      <table class="table table-sm pivot-table mb-0">
        <thead><tr>
          <th>${_escape(rowLabel)}</th>
          ${thMonths}
          <th class="text-end" style="min-width:72px;">総計</th>
        </tr></thead>
        <tbody>${bodyRows}</tbody>
        <tfoot><tr>
          <td class="fw-bold">総計</td>
          ${footCells}
          <td class="text-end fw-bold">${Math.round(grandTotal).toLocaleString()}</td>
        </tr></tfoot>
      </table>`;

    // ドリルダウン：セルクリック
    container.querySelectorAll('.pivot-cell[data-di]').forEach(td => {
      const { key, ym } = drillMap[Number(td.dataset.di)];
      td.addEventListener('click', () => {
        const drillExp = drillRecords[key]?.[ym] || [];
        const settle = settleCallback ? (onDone) => settleCallback(drillExp, onDone) : null;
        _showDrill(`${key} — ${_fmtYM(ym)}`, drillExp, settle);
      });
    });
  }

  // ─── ドリルダウンモーダル ──────────────────────────────────
  function _showDrill(title, expenses, settleCallback = null) {
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const sorted = expenses.slice().sort((a, b) => a.date.localeCompare(b.date));

    const rows = sorted.map((e, i) => {
      const imgUrls = (e.imageLinks || '').split(',').map(s => s.trim()).filter(Boolean);
      const hasExtra = e.note || imgUrls.length > 0;
      const receiptBtns = imgUrls.map((url, j) =>
        `<a href="${_escape(url)}" target="_blank" rel="noopener"
            class="btn btn-outline-secondary btn-sm py-0 px-2" style="font-size:0.75rem;">
           <i class="bi bi-image me-1"></i>証票${imgUrls.length > 1 ? j + 1 : ''}
         </a>`
      ).join('');

      return `<tr>
        <td style="white-space:nowrap;">${e.date}</td>
        <td>${_escape(e.place)}</td>
        <td class="text-end${hasExtra ? ' drill-amount-toggle' : ''}" data-row="${i}"
            style="${hasExtra ? 'cursor:pointer;' : ''}">
          ¥${e.amount.toLocaleString()}
          ${hasExtra ? '<i class="bi bi-chevron-down" style="font-size:0.6rem;opacity:0.55;margin-left:2px;vertical-align:middle;"></i>' : ''}
        </td>
        <td class="text-muted">${_escape(e.name)}</td>
        <td class="text-muted" style="font-size:0.75rem;">${_escape(e.category)}</td>
        <td>
          ${e.confirmed
            ? '<span class="badge badge-confirmed rounded-pill px-2">承認済</span>'
            : '<span class="badge badge-pending rounded-pill px-2">未確認</span>'}
        </td>
      </tr>
      ${hasExtra ? `<tr class="drill-detail-row d-none" data-row="${i}">
        <td colspan="6" style="background:#f8f9fa;border-top:none;padding:0.4rem 0.75rem 0.5rem;">
          ${e.note ? `<div style="font-size:0.78rem;color:#495057;white-space:pre-wrap;word-break:break-all;margin-bottom:${imgUrls.length ? '0.3rem' : '0'};">
            <i class="bi bi-chat-text me-1 text-secondary"></i>${_escape(e.note)}
          </div>` : ''}
          ${receiptBtns ? `<div class="d-flex gap-1 flex-wrap">${receiptBtns}</div>` : ''}
        </td>
      </tr>` : ''}`;
    }).join('');

    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-lg modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header py-2 justify-content-center position-relative">
              <h6 class="modal-title text-center w-100">${_escape(title)}</h6>
              <button class="btn-close position-absolute end-0 me-3" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body p-0">
              ${settleCallback ? `
              <div class="px-3 pt-3 pb-2">
                <button class="btn btn-success btn-sm w-100" id="drillBtnSettle">
                  <i class="bi bi-check2-all me-1"></i>この月をまとめて精算済みにする（${expenses.length}件）
                </button>
              </div>` : ''}
              <div class="table-responsive">
                <table class="table table-sm mb-0">
                  <thead class="table-light">
                    <tr><th class="text-center">日付</th><th class="text-center">支払先</th><th class="text-center">金額</th><th class="text-center">申請者</th><th class="text-center">科目</th><th class="text-center">状態</th></tr>
                  </thead>
                  <tbody>${rows}</tbody>
                  <tfoot class="table-light">
                    <tr>
                      <td colspan="2" class="fw-bold">合計 ${expenses.length}件</td>
                      <td class="text-end fw-bold">¥${total.toLocaleString()}</td>
                      <td colspan="3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            <div class="modal-footer py-2">
              <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);

    // 金額タップで詳細行を展開
    div.querySelectorAll('.drill-amount-toggle').forEach(td => {
      td.addEventListener('click', () => {
        const row = td.dataset.row;
        const detail = div.querySelector(`.drill-detail-row[data-row="${row}"]`);
        if (!detail) return;
        const isOpen = !detail.classList.contains('d-none');
        detail.classList.toggle('d-none', isOpen);
        const chevron = td.querySelector('.bi-chevron-down, .bi-chevron-up');
        if (chevron) chevron.className = `bi bi-chevron-${isOpen ? 'down' : 'up'}`;
      });
    });

    const modal = new bootstrap.Modal(div.querySelector('.modal'));
    modal.show();
    div.querySelector('.modal').addEventListener('hidden.bs.modal', () => div.remove());

    if (settleCallback) {
      div.querySelector('#drillBtnSettle')?.addEventListener('click', () => {
        settleCallback(() => modal.hide());
      });
    }
  }

  // ─── ユーティリティ ───────────────────────────────────────
  function _fmtYM(ym) {
    if (!ym) return '';
    const [y, m] = ym.split('-');
    return `${y}-${m}月`;
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  return { render, bindEvents };
})();
