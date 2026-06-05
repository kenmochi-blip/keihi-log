/**
 * 会計事務所ダッシュボード
 * Google OAuth (PKCE) でログイン後、/api/data/accountant で紹介者確認。
 * 顧問先 × 月のピボットテーブルを表示し、セルクリックで経費明細・証票を確認できる。
 */
const Accountant = (() => {
  let _summaries = [];
  let _months    = [];
  let _active    = null; // { expenses, total, byCategory, name, month } 詳細表示中

  // ── デモデータ ───────────────────────────────────────────────────────────
  const DEMO_MONTHS = (() => {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return months;
  })();

  const DEMO_SUMMARIES = (() => {
    const M = DEMO_MONTHS;
    function mkMonth(expenses) {
      const total = expenses.reduce((s, e) => s + e.amount, 0);
      const byCategory = {};
      expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
      return { total, count: expenses.length, byCategory, expenses };
    }
    function empty() { return { total: 0, count: 0, byCategory: {}, expenses: [] }; }

    const byMonth1 = {
      [M[0]]: mkMonth([
        { date: `${M[0]}-15`, name: '田中 花子', place: 'JR東日本', amount: 5200, category: '旅費交通費', type: '電車バス', confirmed: true, settlementDate: '', note: '出張交通費', id: 'c1a', imageLinks: '' },
        { date: `${M[0]}-20`, name: '鈴木 一郎', place: 'ランチ代', amount: 15000, category: '接待交際費', type: '領収書', confirmed: true, settlementDate: '', note: '顧客打ち合わせ', id: 'c1b', imageLinks: '' },
      ]),
      [M[1]]: mkMonth([
        { date: `${M[1]}-10`, name: '田中 花子', place: 'Amazon', amount: 9800, category: '消耗品費', type: '領収書', confirmed: true, settlementDate: '', note: '事務用品', id: 'c2a', imageLinks: '' },
        { date: `${M[1]}-18`, name: '佐藤 二郎', place: 'ソフトバンク', amount: 8800, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: '携帯電話代', id: 'c2b', imageLinks: '' },
      ]),
      [M[2]]: mkMonth([
        { date: `${M[2]}-05`, name: '鈴木 一郎', place: '銀座レストラン', amount: 32000, category: '接待交際費', type: '領収書', confirmed: true, settlementDate: '', note: '新規顧客接待', id: 'c3a', imageLinks: '/api/data/receipt?fileId=demo&exp=0&sig=0' },
        { date: `${M[2]}-22`, name: '田中 花子', place: 'タクシー', amount: 3200, category: '旅費交通費', type: '領収書', confirmed: true, settlementDate: '', note: '深夜帰宅', id: 'c3b', imageLinks: '' },
      ]),
      [M[3]]: mkMonth([
        { date: `${M[3]}-08`, name: '佐藤 二郎', place: 'ANA', amount: 45000, category: '旅費交通費', type: '領収書', confirmed: true, settlementDate: '', note: '大阪出張 往復', id: 'c4a', imageLinks: '' },
        { date: `${M[3]}-15`, name: '田中 花子', place: 'ヤマト運輸', amount: 1200, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: '書類送付', id: 'c4b', imageLinks: '' },
      ]),
      [M[4]]: mkMonth([
        { date: `${M[4]}-12`, name: '鈴木 一郎', place: '会議室レンタル', amount: 22000, category: '会議費', type: '領収書', confirmed: true, settlementDate: '', note: '外部会議室 半日', id: 'c5a', imageLinks: '' },
        { date: `${M[4]}-25`, name: '田中 花子', place: 'セミナー主催', amount: 18000, category: '研修費', type: '領収書', confirmed: true, settlementDate: '', note: 'マーケティングセミナー参加', id: 'c5b', imageLinks: '' },
      ]),
      [M[5]]: mkMonth([
        { date: `${M[5]}-03`, name: '田中 花子', place: 'JR東日本', amount: 3240, category: '旅費交通費', type: '電車バス', confirmed: true, settlementDate: '', note: '東京→大阪 出張', id: 'c6a', imageLinks: '' },
        { date: `${M[5]}-01`, name: '鈴木 一郎', place: '銀座 ○○レストラン', amount: 32000, category: '接待交際費', type: '領収書', confirmed: true, settlementDate: '', note: '既存顧客接待', id: 'c6b', imageLinks: '/api/data/receipt?fileId=demo&exp=0&sig=0' },
        { date: `${M[5]}-02`, name: '田中 花子', place: 'Amazon', amount: 12800, category: '消耗品費', type: '領収書', confirmed: false, settlementDate: '', note: 'プリンター用紙・インク', id: 'c6c', imageLinks: '' },
        { date: `${M[5]}-01`, name: '佐藤 二郎', place: 'ソフトバンク', amount: 8800, category: '通信費', type: '領収書', confirmed: false, settlementDate: '', note: '携帯電話代6月分', id: 'c6d', imageLinks: '' },
      ]),
    };

    const byMonth2 = {
      [M[1]]: mkMonth([
        { date: `${M[1]}-10`, name: '山田 美咲', place: 'Adobe', amount: 8000, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: 'Creative Cloud月額', id: 'd1a', imageLinks: '' },
      ]),
      [M[3]]: mkMonth([
        { date: `${M[3]}-14`, name: '山田 美咲', place: 'フリーランサーA', amount: 40000, category: '外注費', type: '領収書', confirmed: true, settlementDate: '', note: 'ロゴデザイン制作', id: 'd3a', imageLinks: '' },
        { date: `${M[3]}-20`, name: '山田 美咲', place: '画材屋', amount: 15200, category: '消耗品費', type: '領収書', confirmed: true, settlementDate: '', note: 'デザイン用画材', id: 'd3b', imageLinks: '' },
      ]),
      [M[5]]: mkMonth([
        { date: `${M[5]}-01`, name: '山田 美咲', place: 'Adobe', amount: 8000, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: 'Creative Cloud月額', id: 'd5a', imageLinks: '' },
        { date: `${M[5]}-04`, name: '山田 美咲', place: 'フリーランサーA', amount: 55200, category: '外注費', type: '領収書', confirmed: false, settlementDate: '', note: 'Webサイト制作', id: 'd5b', imageLinks: '' },
      ]),
    };

    const allByMonth1 = Object.fromEntries(M.map(m => [m, byMonth1[m] || empty()]));
    const allByMonth2 = Object.fromEntries(M.map(m => [m, byMonth2[m] || empty()]));
    const allByMonth3 = Object.fromEntries(M.map(m => [m, empty()]));

    return [
      { sheetId: 'demo1', name: '株式会社サンプル商事', byMonth: allByMonth1 },
      { sheetId: 'demo2', name: '山田デザイン事務所',   byMonth: allByMonth2 },
      { sheetId: 'demo3', name: '佐々木コンサルティング', byMonth: allByMonth3 },
    ];
  })();

  function _isDemoMode() {
    return new URLSearchParams(location.search).has('demo');
  }

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
    _months    = DEMO_MONTHS;
    _summaries = DEMO_SUMMARIES;
    document.getElementById('loadingClients').classList.add('d-none');
    _renderPivotTable();
  }

  // ── 初期化 ──────────────────────────────────────────────────────────────
  async function init() {
    document.getElementById('signInBtn').onclick = () => Auth.initiateLogin('/accountant');

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
      _showError('顧問先がまだ登録されていません。', false);
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
      const url = `/api/data/accountant/summary?months=6${refresh ? '&refresh=1' : ''}`;
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

    const monthHeaders = _months.map(m => {
      const [y, mo] = m.split('-');
      return `<th class="text-end text-nowrap px-3">${parseInt(y)}年${parseInt(mo)}月</th>`;
    }).join('');

    const rows = _summaries.map(s => {
      if (s.error) {
        const cells = _months.map(() =>
          `<td class="text-center text-danger px-3" style="font-size:.8rem;">取得失敗</td>`
        ).join('');
        return `<tr><td class="fw-semibold px-3">${_esc(s.name)}<br><small class="text-danger fw-normal" style="font-size:.75rem;">${_esc(s.message || '')}</small></td>${cells}</tr>`;
      }

      const cells = _months.map(m => {
        const d = (s.byMonth || {})[m];
        if (!d || d.count === 0) {
          return `<td class="text-end px-3 text-muted">—</td>`;
        }
        return `<td class="text-end px-3 pivot-cell"
          data-sheet="${_esc(s.sheetId)}" data-month="${_esc(m)}">
          <div class="amount">¥${d.total.toLocaleString()}</div>
          <div class="cnt">${d.count}件</div>
        </td>`;
      }).join('');

      return `<tr><td class="fw-semibold px-3">${_esc(s.name)}</td>${cells}</tr>`;
    }).join('');

    container.innerHTML = `<div class="card border-0 shadow-sm">
      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-hover table-sm align-middle mb-0" style="min-width:600px;">
            <thead class="table-light">
              <tr>
                <th class="px-3">顧問先名</th>
                ${monthHeaders}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;

    container.querySelectorAll('.pivot-cell').forEach(cell => {
      cell.addEventListener('click', () => _showDetail(cell.dataset.sheet, cell.dataset.month));
    });
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
        <td style="font-size:.8rem;max-width:180px;" class="text-truncate">${_esc(e.note || '')}</td>
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
