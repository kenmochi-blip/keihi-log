/**
 * 会計事務所ダッシュボード
 * Google OAuth (PKCE) でログイン後、/api/data/accountant で紹介者確認。
 * 顧問先のスプレッドシートをSA経由で集計し、証票まで閲覧できる。
 */
const Accountant = (() => {
  let _clients   = [];
  let _summaries = [];
  let _month     = '';
  let _active    = null; // 詳細表示中の summary オブジェクト

  // ── 初期化 ──────────────────────────────────────────────────────────────
  // ── デモデータ ───────────────────────────────────────────────────────────
  const DEMO_SUMMARIES = [
    {
      sheetId: 'demo1', name: '株式会社サンプル商事', auto: true,
      total: 187450, count: 12, pending: 3,
      byCategory: { '旅費交通費': 82000, '接待交際費': 54000, '消耗品費': 28450, '通信費': 23000 },
      expenses: [
        { date: '2026-06-18', name: '田中 花子', place: 'JR東日本', amount: 3240, category: '旅費交通費', type: '電車バス', confirmed: true,  settlementDate: '', note: '東京→大阪 出張', id: 'd1', imageLinks: '' },
        { date: '2026-06-15', name: '鈴木 一郎', place: '銀座 ○○レストラン', amount: 32000, category: '接待交際費', type: '領収書', confirmed: true,  settlementDate: '', note: '顧客接待', id: 'd2', imageLinks: '/api/data/receipt?fileId=demo&exp=0&sig=0' },
        { date: '2026-06-12', name: '田中 花子', place: 'Amazon', amount: 12800, category: '消耗品費', type: '領収書', confirmed: false, settlementDate: '', note: 'プリンター用紙・インク', id: 'd3', imageLinks: '' },
        { date: '2026-06-10', name: '佐藤 二郎', place: 'ソフトバンク', amount: 8800, category: '通信費', type: '領収書', confirmed: false, settlementDate: '', note: '携帯電話代6月分', id: 'd4', imageLinks: '' },
        { date: '2026-06-08', name: '鈴木 一郎', place: 'タクシー', amount: 4200, category: '旅費交通費', type: '領収書', confirmed: false, settlementDate: '', note: '深夜帰宅', id: 'd5', imageLinks: '' },
      ],
    },
    {
      sheetId: 'demo2', name: '山田デザイン事務所', auto: true,
      total: 63200, count: 5, pending: 1,
      byCategory: { '外注費': 40000, '消耗品費': 15200, '通信費': 8000 },
      expenses: [
        { date: '2026-06-20', name: '山田 美咲', place: 'Adobe', amount: 8000, category: '通信費', type: '領収書', confirmed: true, settlementDate: '', note: 'Creative Cloud月額', id: 'd6', imageLinks: '' },
        { date: '2026-06-14', name: '山田 美咲', place: 'フリーランサーA', amount: 40000, category: '外注費', type: '領収書', confirmed: false, settlementDate: '', note: 'ロゴデザイン制作', id: 'd7', imageLinks: '' },
      ],
    },
    {
      sheetId: 'demo3', name: '佐々木コンサルティング', auto: false,
      total: 0, count: 0, pending: 0,
      byCategory: {},
      expenses: [],
    },
  ];

  function _isDemoMode() {
    return new URLSearchParams(location.search).has('demo');
  }

  async function _showDemoMode() {
    document.getElementById('authGate').classList.add('d-none');
    document.getElementById('mainContent').classList.remove('d-none');
    document.getElementById('userEmailDisplay').textContent = 'デモ表示';
    document.getElementById('logoutBtn').onclick = () => location.href = '/accountant';
    document.getElementById('addClientBtn').onclick  = _showAddModal;
    document.getElementById('addClientBtnEmpty')?.addEventListener('click', _showAddModal);
    document.getElementById('addClientConfirm').onclick = () => {
      bootstrap.Modal.getInstance(document.getElementById('addClientModal'))?.hide();
    };
    document.getElementById('csvExportBtn').onclick = _exportCsv;
    document.getElementById('refreshBtn').onclick = () => {};
    document.getElementById('monthPicker').onchange = e => { _month = e.target.value; };

    // デモ表示バナー
    const banner = document.createElement('div');
    banner.className = 'alert alert-info text-center py-2 mb-0 rounded-0';
    banner.style.fontSize = '.85rem';
    banner.innerHTML = '<i class="bi bi-eye me-1"></i>これはデモ表示です。実際のデータは表示されていません。';
    document.getElementById('mainContent').insertBefore(banner, document.getElementById('mainContent').firstChild.nextSibling);

    document.getElementById('referrerLabel').textContent = 'サンプル会計事務所（紹介コード: sample）';
    _clients = DEMO_SUMMARIES;
    _summaries = DEMO_SUMMARIES;
    document.getElementById('statClients').textContent = _clients.length;
    document.getElementById('loadingClients').classList.add('d-none');
    _renderGrid();
  }

  async function init() {
    const now = new Date();
    _month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('monthPicker').value = _month;
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
    document.getElementById('addClientBtn').onclick  = _showAddModal;
    document.getElementById('addClientBtnEmpty')?.addEventListener('click', _showAddModal);
    document.getElementById('addClientConfirm').onclick = _addClient;
    document.getElementById('csvExportBtn').onclick = _exportCsv;
    document.getElementById('monthPicker').onchange = e => { _month = e.target.value; _loadSummary(); };
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
      _showGridError(msg);
      return;
    }

    _clients = profile.clients || [];
    const ref = profile.referrer;
    document.getElementById('referrerLabel').textContent =
      ref?.name ? `${ref.name}（紹介コード: ${ref.code}）` : '';
    document.getElementById('statClients').textContent = _clients.length;

    if (!_clients.length) {
      document.getElementById('loadingClients').classList.add('d-none');
      document.getElementById('emptyState').classList.remove('d-none');
      return;
    }

    await _loadSummary();
  }

  // ── 月次集計 ─────────────────────────────────────────────────────────────
  async function _loadSummary(refresh = false) {
    document.getElementById('loadingClients').classList.remove('d-none');
    document.getElementById('clientGrid').innerHTML = '';
    document.getElementById('emptyState').classList.add('d-none');

    try {
      const url = `/api/data/accountant/summary?month=${_month}${refresh ? '&refresh=1' : ''}`;
      const data = await _get(url);
      _summaries = data.summaries || [];
    } catch {
      _showGridError('集計データの取得に失敗しました');
      return;
    } finally {
      document.getElementById('loadingClients').classList.add('d-none');
    }

    _renderGrid();
  }

  function _renderGrid() {
    const valid = _summaries.filter(s => !s.error);
    document.getElementById('statCount').textContent   = valid.reduce((s, c) => s + c.count,   0).toLocaleString() + '件';
    document.getElementById('statTotal').textContent   = '¥' + valid.reduce((s, c) => s + c.total,   0).toLocaleString();
    document.getElementById('statPending').textContent = valid.reduce((s, c) => s + c.pending, 0).toLocaleString() + '件';

    const grid = document.getElementById('clientGrid');
    grid.innerHTML = '';

    _summaries.forEach(s => {
      const col = document.createElement('div');
      col.className = 'col-12 col-md-6 col-lg-4';
      col.innerHTML = s.error ? _errorCard(s) : _clientCard(s);
      grid.appendChild(col);
    });

    grid.querySelectorAll('[data-remove]').forEach(btn =>
      btn.addEventListener('click', e => { e.stopPropagation(); _removeClient(btn.dataset.remove); })
    );
    grid.querySelectorAll('[data-detail]').forEach(btn =>
      btn.addEventListener('click', () => _showDetail(btn.dataset.detail))
    );
  }

  function _clientCard(s) {
    const pendingBadge = s.pending > 0
      ? `<span class="badge bg-warning text-dark mb-1" style="font-size:.7rem;"><i class="bi bi-clock me-1"></i>未承認 ${s.pending}件</span>`
      : '';
    const autoBadge = s.auto
      ? `<span class="badge bg-light text-muted border" style="font-size:.65rem;">自動連携</span>`
      : `<span class="badge bg-light text-muted border" style="font-size:.65rem;">手動追加</span>`;
    const removeBtn = s.auto
      ? '' // 自動連携顧問先は削除不可（管理側で管理）
      : `<button class="btn btn-link btn-sm text-secondary p-0 ms-2 flex-shrink-0"
           data-remove="${_esc(s.sheetId)}" title="削除"><i class="bi bi-x-lg"></i></button>`;
    const topCats = Object.entries(s.byCategory || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const catRows = topCats.map(([cat, amt]) =>
      `<div class="d-flex justify-content-between" style="font-size:.8rem;">
        <span class="text-muted text-truncate me-2">${_esc(cat)}</span>
        <span>¥${amt.toLocaleString()}</span>
      </div>`
    ).join('');

    return `<div class="card h-100 border-0 shadow-sm client-card">
      <div class="card-body">
        <div class="d-flex align-items-start justify-content-between mb-1">
          <div class="d-flex align-items-center gap-2 flex-wrap">
            <h6 class="mb-0 fw-semibold">${_esc(s.name)}</h6>
            ${autoBadge}
          </div>
          ${removeBtn}
        </div>
        ${pendingBadge}
        <div class="mt-2 mb-1">
          <div class="text-muted" style="font-size:.78rem;">今月の合計</div>
          <div class="fw-bold" style="font-size:1.3rem;">¥${(s.total || 0).toLocaleString()}</div>
          <div class="text-muted" style="font-size:.8rem;">${s.count || 0}件</div>
        </div>
        ${catRows ? `<hr class="my-2">${catRows}` : ''}
        <div class="mt-3">
          <button class="btn btn-primary btn-sm w-100" data-detail="${_esc(s.sheetId)}">
            <i class="bi bi-list-ul me-1"></i>経費明細・証票を見る
          </button>
        </div>
      </div>
    </div>`;
  }

  function _errorCard(s) {
    return `<div class="card h-100 border-0 shadow-sm client-card error-border">
      <div class="card-body">
        <div class="d-flex align-items-start justify-content-between mb-2">
          <h6 class="mb-0 fw-semibold">${_esc(s.name)}</h6>
          <button class="btn btn-link btn-sm text-danger p-0 ms-2 flex-shrink-0"
            data-remove="${_esc(s.sheetId)}" title="削除"><i class="bi bi-trash3"></i></button>
        </div>
        <p class="text-danger small mb-1"><i class="bi bi-exclamation-circle me-1"></i>データ取得失敗</p>
        <p class="text-muted small mb-0">${_esc(s.message || 'シートにアクセスできませんでした')}</p>
      </div>
    </div>`;
  }

  // ── 顧問先追加 ───────────────────────────────────────────────────────────
  function _showAddModal() {
    document.getElementById('clientName').value = '';
    document.getElementById('clientSheetUrl').value = '';
    document.getElementById('addClientError').classList.add('d-none');
    bootstrap.Modal.getOrCreateInstance(document.getElementById('addClientModal')).show();
  }

  async function _addClient() {
    const name = document.getElementById('clientName').value.trim();
    const url  = document.getElementById('clientSheetUrl').value.trim();
    const errEl = document.getElementById('addClientError');
    errEl.classList.add('d-none');

    if (!name) { errEl.textContent = '会社名を入力してください'; errEl.classList.remove('d-none'); return; }
    if (!url)  { errEl.textContent = 'スプレッドシートURLを入力してください'; errEl.classList.remove('d-none'); return; }

    const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
    if (!m) { errEl.textContent = 'URLからスプレッドシートIDを取得できませんでした'; errEl.classList.remove('d-none'); return; }

    const btn = document.getElementById('addClientConfirm');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>確認中...';

    try {
      const result = await _post('/api/data/accountant', { sheetId: m[1], name });
      _clients = result.clients || [];
      document.getElementById('statClients').textContent = _clients.length;
      bootstrap.Modal.getInstance(document.getElementById('addClientModal')).hide();
      document.getElementById('emptyState').classList.add('d-none');
      await _loadSummary();
    } catch (e) {
      const msgs = {
        409: 'この顧問先はすでに登録されています',
        503: 'シートにアクセスできませんでした。URLが正しいか、または顧問先が経費ログの最新バージョンを使用しているか確認してください。',
      };
      errEl.textContent = msgs[e.status] || e.message || '追加に失敗しました';
      errEl.classList.remove('d-none');
    } finally {
      btn.disabled = false;
      btn.textContent = '追加する';
    }
  }

  async function _removeClient(sheetId) {
    if (!confirm('この顧問先を削除しますか？')) return;
    try {
      await _del(`/api/data/accountant?sheetId=${encodeURIComponent(sheetId)}`);
      _clients = _clients.filter(c => c.sheetId !== sheetId);
      document.getElementById('statClients').textContent = _clients.length;
      if (!_clients.length) {
        document.getElementById('clientGrid').innerHTML = '';
        document.getElementById('emptyState').classList.remove('d-none');
      } else {
        await _loadSummary();
      }
    } catch (e) {
      if (e.status === 403) {
        alert('自動連携の顧問先は削除できません。管理側で紹介コードの紐付けを解除してください。');
      } else {
        alert('削除に失敗しました');
      }
    }
  }

  // ── 経費明細 ─────────────────────────────────────────────────────────────
  function _showDetail(sheetId) {
    _active = _summaries.find(s => s.sheetId === sheetId);
    if (!_active) return;

    document.getElementById('detailTitle').textContent = _active.name;
    document.getElementById('detailMonth').textContent =
      _month.replace(/^(\d{4})-(\d{2})$/, '$1年$2月');

    _renderDetailTable(_active);
    _renderCategoryBreakdown(_active);
    bootstrap.Modal.getOrCreateInstance(document.getElementById('detailModal')).show();
  }

  function _renderDetailTable(s) {
    const expenses = s.expenses || [];
    document.getElementById('detailSummaryText').textContent =
      `${expenses.length}件 ／ 合計 ¥${(s.total || 0).toLocaleString()}`;

    const tbody = document.getElementById('detailTableBody');
    if (!expenses.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">この月の経費はありません</td></tr>';
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
        <td>${statusBadge}</td>
        <td>${receiptHtml}</td>
      </tr>`;
    }).join('');
  }

  function _renderCategoryBreakdown(s) {
    const cats  = Object.entries(s.byCategory || {}).sort((a, b) => b[1] - a[1]);
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
    const header = ['日付','申請者','支払先','金額','勘定科目','タイプ','状態','備考','ID'];
    const rows = (_active.expenses || []).map(e => [
      e.date, e.name, e.place, e.amount, e.category, e.type,
      e.settlementDate ? '精算済' : e.confirmed ? '登録済' : '申請済',
      e.note, e.id,
    ]);
    const csv = [header, ...rows]
      .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `${_active.name}_${_month}.csv`,
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
      const err = Object.assign(new Error(body.error || res.statusText), { status: res.status });
      throw err;
    }
    return res.json();
  }

  const _get  = url              => _fetch(url, { method: 'GET' });
  const _post = (url, body)      => _fetch(url, { method: 'POST',   body: JSON.stringify(body) });
  const _del  = url              => _fetch(url, { method: 'DELETE' });

  // ── ユーティリティ ───────────────────────────────────────────────────────
  function _showGridError(msg) {
    document.getElementById('clientGrid').innerHTML =
      `<div class="col-12"><div class="alert alert-danger">${_esc(msg)}</div></div>`;
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => Accountant.init());
