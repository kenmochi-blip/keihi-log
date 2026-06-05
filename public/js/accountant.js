/**
 * 会計事務所ダッシュボード
 * Google OAuth (PKCE) でログイン後、/api/data/accountant で紹介者確認。
 * 顧問先 × 月のピボットテーブル。セルクリックで経費明細・証票を確認できる。
 * ▶ ボタンで勘定科目別内訳行を展開。
 */
const Accountant = (() => {
  let _summaries   = [];
  let _months      = [];
  let _monthsCount = 6;
  let _active      = null; // { expenses, total, byCategory, name, month }

  // ── デモデータ ───────────────────────────────────────────────────────────
  // 12ヶ月分生成（過去7〜12ヶ月は集計のみ、直近6ヶ月は明細あり）
  const DEMO_MONTHS = (() => {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return months;
  })();

  const DEMO_SUMMARIES = (() => {
    const M = DEMO_MONTHS; // M[0]=最古, M[11]=今月

    function mkDetail(expenses) {
      const total = expenses.reduce((s, e) => s + e.amount, 0);
      const byCategory = {};
      expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
      return { total, count: expenses.length, byCategory, expenses };
    }
    function mkSimple(byCategory) {
      const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
      return { total, count: Math.ceil(total / 20000) + 1, byCategory, expenses: [] };
    }
    function empty() { return { total: 0, count: 0, byCategory: {}, expenses: [] }; }

    // 顧問先1: 株式会社サンプル商事（直近6ヶ月 詳細 / それ以前 集計）
    const c1Older = [
      mkSimple({ '旅費交通費': 52000, '接待交際費': 47000, '消耗品費': 22000, '通信費': 8800 }),
      mkSimple({ '旅費交通費': 38000, '接待交際費': 32000, '消耗品費': 18000, '通信費': 8800 }),
      mkSimple({ '旅費交通費': 71000, '接待交際費': 54000, '消耗品費': 31000, '通信費': 8800 }),
      mkSimple({ '旅費交通費': 45000, '消耗品費': 15000, '通信費': 8800 }),
      mkSimple({ '旅費交通費': 60000, '接待交際費': 51000, '通信費': 8800 }),
      mkSimple({ '旅費交通費': 42000, '接待交際費': 35000, '消耗品費': 19000, '通信費': 8800 }),
    ];
    const c1Recent = [
      mkDetail([
        { date: `${M[6]}-15`, name: '田中 花子', place: 'JR東日本', amount: 5200, category: '旅費交通費', type: '電車バス', confirmed: true, settlementDate: '', note: '出張交通費', id: 'c1a', imageLinks: '' },
        { date: `${M[6]}-20`, name: '鈴木 一郎', place: 'ランチ代', amount: 15000, category: '接待交際費', type: '領収書', confirmed: true, settlementDate: '', note: '顧客打ち合わせ', id: 'c1b', imageLinks: '' },
      ]),
      mkDetail([
        { date: `${M[7]}-10`, name: '田中 花子', place: 'Amazon', amount: 9800, category: '消耗品費', type: '領収書', confirmed: true, settlementDate: '', note: '事務用品', id: 'c2a', imageLinks: '' },
        { date: `${M[7]}-18`, name: '佐藤 二郎', place: 'ソフトバンク', amount: 8800, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: '携帯電話代', id: 'c2b', imageLinks: '' },
      ]),
      mkDetail([
        { date: `${M[8]}-05`, name: '鈴木 一郎', place: '銀座レストラン', amount: 32000, category: '接待交際費', type: '領収書', confirmed: true, settlementDate: '', note: '新規顧客接待', id: 'c3a', imageLinks: '/api/data/receipt?fileId=demo&exp=0&sig=0' },
        { date: `${M[8]}-22`, name: '田中 花子', place: 'タクシー', amount: 3200, category: '旅費交通費', type: '領収書', confirmed: true, settlementDate: '', note: '深夜帰宅', id: 'c3b', imageLinks: '' },
      ]),
      mkDetail([
        { date: `${M[9]}-08`, name: '佐藤 二郎', place: 'ANA', amount: 45000, category: '旅費交通費', type: '領収書', confirmed: true, settlementDate: '', note: '大阪出張 往復', id: 'c4a', imageLinks: '' },
        { date: `${M[9]}-15`, name: '田中 花子', place: 'ヤマト運輸', amount: 1200, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: '書類送付', id: 'c4b', imageLinks: '' },
      ]),
      mkDetail([
        { date: `${M[10]}-12`, name: '鈴木 一郎', place: '会議室レンタル', amount: 22000, category: '会議費', type: '領収書', confirmed: true, settlementDate: '', note: '外部会議室 半日', id: 'c5a', imageLinks: '' },
        { date: `${M[10]}-25`, name: '田中 花子', place: 'セミナー参加費', amount: 18000, category: '研修費', type: '領収書', confirmed: true, settlementDate: '', note: 'マーケティングセミナー', id: 'c5b', imageLinks: '' },
      ]),
      mkDetail([
        { date: `${M[11]}-03`, name: '田中 花子', place: 'JR東日本', amount: 3240, category: '旅費交通費', type: '電車バス', confirmed: true, settlementDate: '', note: '東京→大阪 出張', id: 'c6a', imageLinks: '' },
        { date: `${M[11]}-01`, name: '鈴木 一郎', place: '銀座 ○○レストラン', amount: 32000, category: '接待交際費', type: '領収書', confirmed: true, settlementDate: '', note: '既存顧客接待', id: 'c6b', imageLinks: '/api/data/receipt?fileId=demo&exp=0&sig=0' },
        { date: `${M[11]}-02`, name: '田中 花子', place: 'Amazon', amount: 12800, category: '消耗品費', type: '領収書', confirmed: false, settlementDate: '', note: 'プリンター用紙・インク', id: 'c6c', imageLinks: '' },
        { date: `${M[11]}-01`, name: '佐藤 二郎', place: 'ソフトバンク', amount: 8800, category: '通信費', type: '領収書', confirmed: false, settlementDate: '', note: '携帯電話代今月分', id: 'c6d', imageLinks: '' },
      ]),
    ];
    const byMonth1 = Object.fromEntries([
      ...M.slice(0, 6).map((m, i) => [m, c1Older[i]]),
      ...M.slice(6).map((m, i) => [m, c1Recent[i]]),
    ]);

    // 顧問先2: 山田デザイン事務所（月によって 0 あり）
    const c2Base = [
      empty(), mkSimple({ '通信費': 8000 }), empty(),
      mkSimple({ '外注費': 40000, '消耗品費': 15200 }), empty(),
      mkSimple({ '通信費': 8000, '外注費': 30000 }),
    ];
    const c2Recent = [
      mkDetail([
        { date: `${M[6]}-10`, name: '山田 美咲', place: 'Adobe', amount: 8000, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: 'Creative Cloud月額', id: 'd1a', imageLinks: '' },
      ]),
      empty(),
      mkDetail([
        { date: `${M[8]}-14`, name: '山田 美咲', place: 'フリーランサーA', amount: 40000, category: '外注費', type: '領収書', confirmed: true, settlementDate: '', note: 'ロゴデザイン制作', id: 'd3a', imageLinks: '' },
        { date: `${M[8]}-20`, name: '山田 美咲', place: '画材屋', amount: 15200, category: '消耗品費', type: '領収書', confirmed: true, settlementDate: '', note: 'デザイン用画材', id: 'd3b', imageLinks: '' },
      ]),
      empty(),
      mkDetail([
        { date: `${M[10]}-01`, name: '山田 美咲', place: 'Adobe', amount: 8000, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: 'Creative Cloud月額', id: 'd5a', imageLinks: '' },
      ]),
      mkDetail([
        { date: `${M[11]}-01`, name: '山田 美咲', place: 'Adobe', amount: 8000, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: 'Creative Cloud月額', id: 'd6a', imageLinks: '' },
        { date: `${M[11]}-04`, name: '山田 美咲', place: 'フリーランサーA', amount: 55200, category: '外注費', type: '領収書', confirmed: false, settlementDate: '', note: 'Webサイト制作', id: 'd6b', imageLinks: '' },
      ]),
    ];
    const byMonth2 = Object.fromEntries([
      ...M.slice(0, 6).map((m, i) => [m, c2Base[i]]),
      ...M.slice(6).map((m, i) => [m, c2Recent[i]]),
    ]);

    // 顧問先3: 佐々木コンサルティング（全月 0）
    const byMonth3 = Object.fromEntries(M.map(m => [m, empty()]));

    return [
      { sheetId: 'demo1', name: '株式会社サンプル商事', byMonth: byMonth1 },
      { sheetId: 'demo2', name: '山田デザイン事務所',   byMonth: byMonth2 },
      { sheetId: 'demo3', name: '佐々木コンサルティング', byMonth: byMonth3 },
    ];
  })();

  function _isDemoMode() {
    return new URLSearchParams(location.search).has('demo');
  }

  // ── 初期化 ──────────────────────────────────────────────────────────────
  async function init() {
    document.getElementById('signInBtn').onclick = () => Auth.initiateLogin('/accountant');

    _setupMonthSelector();

    if (_isDemoMode()) {
      await _showDemoMode();
      return;
    }

    document.getElementById('loadingAuth').classList.remove('d-none');
    document.getElementById('loginArea').classList.add('d-none');

    try {
      await Auth.getToken();
      await _showDashboard();
    } catch {
      document.getElementById('loadingAuth').classList.add('d-none');
      document.getElementById('loginArea').classList.remove('d-none');
    }
  }

  function _setupMonthSelector() {
    document.querySelectorAll('#monthCountGroup [data-months]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#monthCountGroup [data-months]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _monthsCount = parseInt(btn.dataset.months, 10);
        if (_isDemoMode()) {
          _months = DEMO_MONTHS.slice(-_monthsCount);
          _renderPivotTable();
        } else {
          _loadSummary();
        }
      });
    });
  }

  // ── デモモード ───────────────────────────────────────────────────────────
  async function _showDemoMode() {
    document.getElementById('authGate').classList.add('d-none');
    document.getElementById('mainContent').classList.remove('d-none');
    document.getElementById('userEmailDisplay').textContent = 'デモ表示';
    document.getElementById('logoutBtn').onclick = () => location.href = '/accountant';
    document.getElementById('csvExportBtn').onclick = _exportCsv;
    document.getElementById('refreshBtn').onclick = () => {};

    const banner = document.createElement('div');
    banner.className = 'alert alert-info text-center py-2 mb-0 rounded-0';
    banner.style.fontSize = '.85rem';
    banner.innerHTML = '<i class="bi bi-eye me-1"></i>これはデモ表示です。実際のデータは表示されていません。';
    document.getElementById('mainContent').insertBefore(
      banner,
      document.getElementById('mainContent').firstChild.nextSibling
    );

    document.getElementById('referrerLabel').textContent = 'サンプル会計事務所（紹介コード: sample）';
    _summaries   = DEMO_SUMMARIES;
    _months      = DEMO_MONTHS.slice(-_monthsCount);
    document.getElementById('loadingClients').classList.add('d-none');
    _renderPivotTable();
  }

  // ── ダッシュボード ───────────────────────────────────────────────────────
  async function _showDashboard() {
    document.getElementById('authGate').classList.add('d-none');
    document.getElementById('mainContent').classList.remove('d-none');

    const info = Auth.getUserInfo();
    document.getElementById('userEmailDisplay').textContent = info?.email || '';
    document.getElementById('logoutBtn').onclick = () => Auth.signOut();
    document.getElementById('csvExportBtn').onclick = _exportCsv;
    document.getElementById('refreshBtn').onclick = () => _loadSummary(true);

    document.getElementById('loadingClients').classList.remove('d-none');

    let profile;
    try {
      profile = await _get('/api/data/accountant');
    } catch (e) {
      document.getElementById('loadingClients').classList.add('d-none');
      const msg = e.status === 403
        ? 'このアカウントは会計事務所として登録されていません。経費ログ運営にお問い合わせください。'
        : 'プロファイルの取得に失敗しました';
      _showError(msg);
      return;
    }

    const ref = profile.referrer;
    document.getElementById('referrerLabel').textContent =
      ref?.name ? `${ref.name}（紹介コード: ${ref.code}）` : '';

    if (!(profile.clients || []).length) {
      document.getElementById('loadingClients').classList.add('d-none');
      _showError('顧問先がまだ登録されていません。顧問先の管理者に、マスタ表へ貴事務所のメールアドレスを登録するよう依頼してください。', false);
      return;
    }

    await _loadSummary();
  }

  // ── 集計データ取得 ────────────────────────────────────────────────────────
  async function _loadSummary(refresh = false) {
    document.getElementById('loadingClients').classList.remove('d-none');
    document.getElementById('pivotContainer').innerHTML = '';
    document.getElementById('errorState').classList.add('d-none');

    try {
      const url = `/api/data/accountant/summary?months=${_monthsCount}${refresh ? '&refresh=1' : ''}`;
      const data = await _get(url);
      _months    = data.months    || [];
      _summaries = data.summaries || [];
    } catch {
      _showError('集計データの取得に失敗しました');
      return;
    } finally {
      document.getElementById('loadingClients').classList.add('d-none');
    }

    _renderPivotTable();
  }

  // ── ピボットテーブル ─────────────────────────────────────────────────────
  function _renderPivotTable() {
    const container = document.getElementById('pivotContainer');
    container.innerHTML = '';

    if (!_summaries.length) {
      _showError('顧問先がまだ登録されていません。', false);
      return;
    }

    const months = _isDemoMode() ? DEMO_MONTHS.slice(-_monthsCount) : _months;

    const monthHeaders = months.map(m => {
      const [y, mo] = m.split('-');
      return `<th class="text-end text-nowrap px-3">${parseInt(y)}年${parseInt(mo)}月</th>`;
    }).join('');

    const rowsHtml = _summaries.flatMap(s => {
      if (s.error) {
        const cells = months.map(() =>
          `<td class="text-center text-danger px-3" style="font-size:.8rem;">取得失敗</td>`
        ).join('');
        return [`<tr>
          <td class="px-3 fw-semibold">${_esc(s.name)}<br>
            <small class="text-danger fw-normal" style="font-size:.75rem;">${_esc(s.message || '')}</small>
          </td>${cells}
        </tr>`];
      }

      const cats = [...new Set(
        months.flatMap(m => Object.keys(((s.byMonth || {})[m] || {}).byCategory || {}))
      )].sort();

      const expandBtn = cats.length
        ? `<button class="btn btn-link btn-sm p-0 me-1 expand-btn" data-sheet="${_esc(s.sheetId)}" title="勘定科目別内訳を展開">
             <i class="bi bi-chevron-right expand-icon"></i>
           </button>`
        : `<span style="display:inline-block;width:1.6rem;"></span>`;

      const sheetLink = `<a href="https://docs.google.com/spreadsheets/d/${_esc(s.sheetId)}"
           target="_blank" rel="noopener" class="client-name-link fw-semibold">
           ${_esc(s.name)}<i class="bi bi-box-arrow-up-right ms-1 text-muted" style="font-size:.7rem;opacity:.6;"></i>
         </a>`;

      const amountCells = months.map(m => {
        const d = (s.byMonth || {})[m];
        if (!d || d.count === 0) return `<td class="text-end px-3 text-muted">—</td>`;
        return `<td class="text-end px-3 pivot-cell" data-sheet="${_esc(s.sheetId)}" data-month="${_esc(m)}">
          <div class="amount">¥${d.total.toLocaleString()}</div>
          <div class="cnt">${d.count}件</div>
        </td>`;
      }).join('');

      const clientRow = `<tr>
        <td class="px-3 py-2">
          <div class="d-flex align-items-center">${expandBtn}${sheetLink}</div>
        </td>
        ${amountCells}
      </tr>`;

      const catRows = cats.map(cat => {
        const cells = months.map(m => {
          const amt = (((s.byMonth || {})[m] || {}).byCategory || {})[cat] || 0;
          return `<td class="text-end px-3 py-1">${amt > 0 ? '¥' + amt.toLocaleString() : '<span class="text-muted">—</span>'}</td>`;
        }).join('');
        return `<tr class="cat-row d-none" data-parent="${_esc(s.sheetId)}">
          <td class="py-1" style="padding-left:2.5rem;">${_esc(cat)}</td>
          ${cells}
        </tr>`;
      });

      return [clientRow, ...catRows];
    }).join('');

    container.innerHTML = `<div class="card border-0 shadow-sm">
      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-hover table-sm align-middle mb-0" style="min-width:520px;">
            <thead class="table-light">
              <tr>
                <th class="px-3">顧問先名</th>
                ${monthHeaders}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    </div>`;

    container.querySelectorAll('.pivot-cell').forEach(cell => {
      cell.addEventListener('click', () => _showDetail(cell.dataset.sheet, cell.dataset.month));
    });
    container.querySelectorAll('.expand-btn').forEach(btn => {
      btn.addEventListener('click', () => _toggleExpand(btn.dataset.sheet));
    });
  }

  function _toggleExpand(sheetId) {
    const btn  = document.querySelector(`.expand-btn[data-sheet="${CSS.escape(sheetId)}"]`);
    const rows = document.querySelectorAll(`.cat-row[data-parent="${CSS.escape(sheetId)}"]`);
    if (!btn) return;
    const open = btn.dataset.expanded === '1';
    btn.dataset.expanded = open ? '0' : '1';
    const icon = btn.querySelector('.expand-icon');
    icon.classList.toggle('open', !open);
    rows.forEach(r => r.classList.toggle('d-none', open));
  }

  // ── 経費明細ポップアップ ───────────────────────────────────────────────────
  function _showDetail(sheetId, month) {
    const summary = _summaries.find(s => s.sheetId === sheetId);
    if (!summary) return;
    const data = (summary.byMonth || {})[month];
    if (!data) return;

    _active = { ...data, sheetId, name: summary.name, month };
    document.getElementById('detailTitle').textContent = summary.name;
    document.getElementById('detailMonth').textContent =
      month.replace(/^(\d{4})-(\d{2})$/, '$1年$2月');

    _renderDetailTable(_active);
    _renderCategoryBreakdown(_active);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('detailModal')).show();
  }

  function _renderDetailTable(d) {
    const expenses = d.expenses || [];
    document.getElementById('detailSummaryText').textContent =
      `${expenses.length}件 ／ 合計 ¥${(d.total || 0).toLocaleString()}`;

    const tbody = document.getElementById('detailTableBody');
    if (!expenses.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-3">この月の経費はありません</td></tr>';
      return;
    }

    tbody.innerHTML = expenses.map(e => {
      const statusBadge = e.settlementDate
        ? '<span class="badge bg-secondary" style="font-size:.7rem;">精算済</span>'
        : e.confirmed
          ? '<span class="badge bg-success" style="font-size:.7rem;">登録済</span>'
          : '<span class="badge bg-warning text-dark" style="font-size:.7rem;">申請済</span>';

      const receiptHtml = (e.imageLinks || '').split(',').filter(u => u.trim()).map((u, i) =>
        `<a href="${_esc(u.trim())}" target="_blank" rel="noopener" class="receipt-link me-1">
          <i class="bi bi-image"></i>${i > 0 ? i + 1 : ''}
        </a>`
      ).join('') || '<span class="text-muted">—</span>';

      return `<tr>
        <td class="text-nowrap">${_esc(e.date || '')}</td>
        <td>${_esc(e.name || '')}</td>
        <td>${_esc(e.place || '')}</td>
        <td class="text-end text-nowrap">¥${(e.amount || 0).toLocaleString()}</td>
        <td style="font-size:.8rem;">${_esc(e.category || '')}</td>
        <td style="font-size:.8rem;max-width:180px;" class="text-truncate" title="${_esc(e.note || '')}">${_esc(e.note || '')}</td>
        <td>${statusBadge}</td>
        <td>${receiptHtml}</td>
      </tr>`;
    }).join('');
  }

  function _renderCategoryBreakdown(d) {
    const cats  = Object.entries(d.byCategory || {}).sort((a, b) => b[1] - a[1]);
    const total = cats.reduce((sum, [, v]) => sum + v, 0);
    const container = document.getElementById('categoryBreakdown');
    if (!cats.length) {
      container.innerHTML = '<p class="text-muted text-center py-3">データがありません</p>';
      return;
    }
    const colors = ['#0d6efd','#198754','#fd7e14','#6610f2','#dc3545','#0dcaf0','#ffc107'];
    container.innerHTML = cats.map(([cat, amt], i) => {
      const pct = total > 0 ? Math.round(amt / total * 100) : 0;
      return `<div class="mb-3">
        <div class="d-flex justify-content-between mb-1" style="font-size:.85rem;">
          <span>${_esc(cat)}</span>
          <span class="fw-semibold">¥${amt.toLocaleString()} <span class="text-muted">(${pct}%)</span></span>
        </div>
        <div class="progress cat-bar"><div class="progress-bar" style="width:${pct}%;background:${colors[i % colors.length]};"></div></div>
      </div>`;
    }).join('');
  }

  // ── CSV出力 ──────────────────────────────────────────────────────────────
  function _exportCsv() {
    if (!_active) return;
    const header = ['日付','申請者','支払先','金額','勘定科目','タイプ','備考','状態','ID'];
    const rows = (_active.expenses || []).map(e => [
      e.date, e.name, e.place, e.amount, e.category, e.type, e.note,
      e.settlementDate ? '精算済' : e.confirmed ? '登録済' : '申請済',
      e.id,
    ]);
    const csv = [header, ...rows]
      .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${_active.name}_${_active.month || ''}.csv`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── API helpers ──────────────────────────────────────────────────────────
  async function _fetch(url, opts = {}) {
    const idToken = await Auth.getIdToken();
    const res = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}`, ...(opts.headers || {}) },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
    }
    return res.json();
  }

  const _get = url => _fetch(url, { method: 'GET' });

  // ── ユーティリティ ───────────────────────────────────────────────────────
  function _showError(msg, isDanger = true) {
    const el = document.getElementById('errorState');
    el.innerHTML = isDanger
      ? `<div class="alert alert-danger">${_esc(msg)}</div>`
      : `<div class="text-center py-5 text-muted"><i class="bi bi-building fs-1 d-block mb-2 opacity-25"></i><p>${_esc(msg)}</p></div>`;
    el.classList.remove('d-none');
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => Accountant.init());
