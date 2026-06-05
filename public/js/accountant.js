/**
 * 会計事務所ダッシュボード
 * - 顧問先 × 月別ピボットテーブル（顧問先名列は左固定）
 * - 会社名クリック → 全期間経費一覧モーダル
 * - 「科目別内訳 ▼」展開で勘定科目サブ行を表示
 * - 科目金額セルのホバーで経費明細ツールチップ
 */
const Accountant = (() => {
  let _summaries    = [];
  let _months       = [];
  let _monthsCount  = 6;
  let _active       = null;
  let _catTip       = null; // ホバーツールチップ要素
  let _baseExpenses = []; // モーダル表示中の全経費（フィルター前）
  let _filterState  = { name: '', cat: '', status: '', sort: 'date_desc' };

  // ── デモデータ（12ヶ月分） ────────────────────────────────────────────────
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
    const M = DEMO_MONTHS;
    function mkD(expenses) {
      const total = expenses.reduce((s, e) => s + e.amount, 0);
      const byCategory = {};
      expenses.forEach(e => { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount; });
      return { total, count: expenses.length, byCategory, expenses };
    }
    function mkS(byCategory) {
      const total = Object.values(byCategory).reduce((s, v) => s + v, 0);
      return { total, count: Math.ceil(total / 20000) + 1, byCategory, expenses: [] };
    }
    function emp() { return { total: 0, count: 0, byCategory: {}, expenses: [] }; }

    // 顧問先1: 直近6ヶ月は明細あり、それ以前は集計のみ
    const c1 = {
      ...Object.fromEntries(M.slice(0, 6).map((m, i) => [m, mkS([
        { '旅費交通費': [52000,38000,71000,45000,60000,42000][i],
          '接待交際費': [47000,32000,54000,28000,51000,35000][i],
          '消耗品費':   [22000,18000,31000,15000,24000,19000][i],
          '通信費':     8800,
        }[[],[],[],[],[],[],'旅費交通費'] !== undefined ? 0 : 0, // placeholder
      ][0] || [
        ['旅費交通費', [52000,38000,71000,45000,60000,42000][i]],
        ['接待交際費', [47000,32000,54000,28000,51000,35000][i]],
        ['消耗品費',   [22000,18000,31000,15000,24000,19000][i]],
        ['通信費',     8800],
      ].reduce((o, [k, v]) => { o[k] = v; return o; }, {}))
      ])),
      [M[6]]:  mkD([
        { date:`${M[6]}-15`, name:'田中 花子', place:'JR東日本',      amount:5200,  category:'旅費交通費', type:'電車バス', confirmed:true,  settlementDate:'', note:'出張交通費', id:'c1a', imageLinks:'' },
        { date:`${M[6]}-20`, name:'鈴木 一郎', place:'○○レストラン',  amount:15000, category:'接待交際費', type:'領収書',  confirmed:true,  settlementDate:'', note:'顧客打ち合わせ', id:'c1b', imageLinks:'' },
      ]),
      [M[7]]:  mkD([
        { date:`${M[7]}-10`, name:'田中 花子', place:'Amazon',        amount:9800,  category:'消耗品費',   type:'領収書',  confirmed:true,  settlementDate:'', note:'事務用品', id:'c2a', imageLinks:'' },
        { date:`${M[7]}-18`, name:'佐藤 二郎', place:'ソフトバンク',   amount:8800,  category:'通信費',     type:'領収書',  confirmed:true,  settlementDate:'', note:'携帯電話代', id:'c2b', imageLinks:'' },
      ]),
      [M[8]]:  mkD([
        { date:`${M[8]}-05`, name:'鈴木 一郎', place:'銀座レストラン', amount:32000, category:'接待交際費', type:'領収書',  confirmed:true,  settlementDate:'', note:'新規顧客接待', id:'c3a', imageLinks:'/api/data/receipt?fileId=demo&exp=0&sig=0' },
        { date:`${M[8]}-22`, name:'田中 花子', place:'タクシー',       amount:3200,  category:'旅費交通費', type:'領収書',  confirmed:true,  settlementDate:'', note:'深夜帰宅', id:'c3b', imageLinks:'' },
      ]),
      [M[9]]:  mkD([
        { date:`${M[9]}-08`, name:'佐藤 二郎', place:'ANA',           amount:45000, category:'旅費交通費', type:'領収書',  confirmed:true,  settlementDate:'', note:'大阪出張 往復', id:'c4a', imageLinks:'' },
        { date:`${M[9]}-15`, name:'田中 花子', place:'ヤマト運輸',     amount:1200,  category:'通信費',     type:'領収書',  confirmed:true,  settlementDate:'', note:'書類送付', id:'c4b', imageLinks:'' },
      ]),
      [M[10]]: mkD([
        { date:`${M[10]}-12`, name:'鈴木 一郎', place:'会議室レンタル', amount:22000, category:'会議費', type:'領収書',   confirmed:true,  settlementDate:'', note:'外部会議室 半日', id:'c5a', imageLinks:'' },
        { date:`${M[10]}-25`, name:'田中 花子', place:'セミナー参加費', amount:18000, category:'研修費', type:'領収書',   confirmed:true,  settlementDate:'', note:'マーケティングセミナー', id:'c5b', imageLinks:'' },
      ]),
      [M[11]]: mkD([
        { date:`${M[11]}-03`, name:'田中 花子', place:'JR東日本',      amount:3240,  category:'旅費交通費', type:'電車バス', confirmed:true,  settlementDate:'', note:'東京→大阪 出張', id:'c6a', imageLinks:'' },
        { date:`${M[11]}-01`, name:'鈴木 一郎', place:'銀座 ○○レストラン', amount:32000, category:'接待交際費', type:'領収書', confirmed:true, settlementDate:'', note:'既存顧客接待', id:'c6b', imageLinks:'/api/data/receipt?fileId=demo&exp=0&sig=0' },
        { date:`${M[11]}-02`, name:'田中 花子', place:'Amazon',        amount:12800, category:'消耗品費',   type:'領収書',  confirmed:false, settlementDate:'', note:'プリンター用紙・インク', id:'c6c', imageLinks:'' },
        { date:`${M[11]}-01`, name:'佐藤 二郎', place:'ソフトバンク',   amount:8800,  category:'通信費',     type:'領収書',  confirmed:false, settlementDate:'', note:'携帯電話代今月分', id:'c6d', imageLinks:'' },
      ]),
    };
    // slice(0,6) の単純な集計を修正
    for (let i = 0; i < 6; i++) {
      const tots = { '旅費交通費': [52000,38000,71000,45000,60000,42000][i], '接待交際費': [47000,32000,54000,28000,51000,35000][i], '消耗品費': [22000,18000,31000,15000,24000,19000][i], '通信費': 8800 };
      c1[M[i]] = mkS(tots);
    }

    const c2 = {
      ...Object.fromEntries(M.slice(0, 6).map((m, i) => [m,
        [emp(), mkS({'通信費':8000}), emp(), mkS({'外注費':40000,'消耗品費':15200}), emp(), mkS({'通信費':8000,'外注費':30000})][i]
      ])),
      [M[6]]:  mkD([{ date:`${M[6]}-10`,  name:'山田 美咲', place:'Adobe',        amount:8000,  category:'通信費', type:'領収書', confirmed:true,  settlementDate:'', note:'Creative Cloud月額', id:'d1a', imageLinks:'' }]),
      [M[7]]:  emp(),
      [M[8]]:  mkD([
        { date:`${M[8]}-14`, name:'山田 美咲', place:'フリーランサーA', amount:40000, category:'外注費',   type:'領収書', confirmed:true,  settlementDate:'', note:'ロゴデザイン制作', id:'d3a', imageLinks:'' },
        { date:`${M[8]}-20`, name:'山田 美咲', place:'画材屋',          amount:15200, category:'消耗品費', type:'領収書', confirmed:true,  settlementDate:'', note:'デザイン用画材', id:'d3b', imageLinks:'' },
      ]),
      [M[9]]:  emp(),
      [M[10]]: mkD([{ date:`${M[10]}-01`, name:'山田 美咲', place:'Adobe',        amount:8000,  category:'通信費', type:'領収書', confirmed:true,  settlementDate:'', note:'Creative Cloud月額', id:'d5a', imageLinks:'' }]),
      [M[11]]: mkD([
        { date:`${M[11]}-01`, name:'山田 美咲', place:'Adobe',          amount:8000,  category:'通信費', type:'領収書',  confirmed:true,  settlementDate:'', note:'Creative Cloud月額', id:'d6a', imageLinks:'' },
        { date:`${M[11]}-04`, name:'山田 美咲', place:'フリーランサーA', amount:55200, category:'外注費', type:'領収書',  confirmed:false, settlementDate:'', note:'Webサイト制作', id:'d6b', imageLinks:'' },
      ]),
    };

    return [
      { sheetId:'demo1', name:'株式会社サンプル商事', byMonth: c1 },
      { sheetId:'demo2', name:'山田デザイン事務所',   byMonth: c2 },
      { sheetId:'demo3', name:'佐々木コンサルティング', byMonth: Object.fromEntries(DEMO_MONTHS.map(m => [m, emp()])) },
    ];
  })();

  function _isDemoMode() { return new URLSearchParams(location.search).has('demo'); }
  function _activeMths()  { return _isDemoMode() ? DEMO_MONTHS.slice(-_monthsCount) : _months; }

  // ── 初期化 ──────────────────────────────────────────────────────────────
  async function init() {
    document.getElementById('signInBtn').onclick = () => Auth.initiateLogin('/accountant');
    _setupMonthSelector();

    if (_isDemoMode()) { await _showDemoMode(); return; }

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
    document.getElementById('mainContent').insertBefore(banner, document.getElementById('mainContent').firstChild.nextSibling);

    document.getElementById('referrerLabel').textContent = 'サンプル会計事務所（紹介コード: sample）';
    _summaries = DEMO_SUMMARIES;
    _months    = DEMO_MONTHS.slice(-_monthsCount);
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
      _showError('顧問先がまだ表示されていません。顧問先の管理者に「マスタ管理」で貴事務所のメールアドレスをメンバー登録するよう依頼してください。', false);
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
    if (_catTip) { _catTip.remove(); _catTip = null; }

    if (!_summaries.length) {
      _showError('顧問先がまだ登録されていません。', false);
      return;
    }

    const months = _activeMths();

    const monthHeaders = months.map(m => {
      const [y, mo] = m.split('-');
      return `<th class="text-end text-nowrap px-3">${parseInt(y)}年${parseInt(mo)}月</th>`;
    }).join('');

    const rowsHtml = _summaries.flatMap(s => {
      if (s.error) {
        const cells = months.map(() => `<td class="text-center text-danger px-3" style="font-size:.8rem;">取得失敗</td>`).join('');
        return [`<tr><td class="pivot-name-col px-3 py-2 fw-semibold">${_esc(s.name)}<br>
          <small class="text-danger fw-normal" style="font-size:.75rem;">${_esc(s.message || '')}</small>
        </td>${cells}</tr>`];
      }

      // 展開用: 全月にわたる勘定科目一覧
      const cats = [...new Set(months.flatMap(m => Object.keys(((s.byMonth || {})[m] || {}).byCategory || {})))].sort();

      const amountCells = months.map(m => {
        const d = (s.byMonth || {})[m];
        if (!d || d.count === 0) return `<td class="text-end px-3 text-muted">—</td>`;
        return `<td class="text-end px-3 pivot-cell" data-sheet="${_esc(s.sheetId)}" data-month="${_esc(m)}">
          <div class="amount">¥${d.total.toLocaleString()}</div>
          <div class="cnt">${d.count}件</div>
        </td>`;
      }).join('');

      const expandBtn = cats.length
        ? `<button class="btn btn-link btn-sm p-0 expand-btn text-muted mt-1 d-block" data-sheet="${_esc(s.sheetId)}">
             <small>科目別内訳 <i class="bi bi-chevron-down expand-icon" style="font-size:.75rem;"></i></small>
           </button>`
        : '';

      const clientRow = `<tr>
        <td class="pivot-name-col px-3 py-2">
          <div class="company-name fw-semibold" data-sheet="${_esc(s.sheetId)}">${_esc(s.name)}</div>
          ${expandBtn}
        </td>
        ${amountCells}
      </tr>`;

      const catRows = cats.map(cat => {
        const cells = months.map(m => {
          const amt = (((s.byMonth || {})[m] || {}).byCategory || {})[cat] || 0;
          const hasTip = amt > 0;
          return `<td class="text-end px-3 py-1 cat-amount-cell${hasTip ? ' has-tip' : ''}"
            data-sheet="${_esc(s.sheetId)}" data-month="${_esc(m)}" data-cat="${_esc(cat)}">
            ${amt > 0 ? '¥' + amt.toLocaleString() : '<span class="text-muted">—</span>'}
          </td>`;
        }).join('');
        return `<tr class="cat-row d-none" data-parent="${_esc(s.sheetId)}">
          <td class="pivot-name-col py-1 px-3 ps-4" style="font-size:.82rem;color:#666;">${_esc(cat)}</td>
          ${cells}
        </tr>`;
      });

      return [clientRow, ...catRows];
    }).join('');

    container.innerHTML = `<div class="card border-0 shadow-sm">
      <div class="card-body p-0">
        <div class="table-responsive">
          <table class="table table-hover table-sm align-middle mb-0">
            <thead class="table-light">
              <tr>
                <th class="pivot-name-col px-3">顧問先名</th>
                ${monthHeaders}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    </div>`;

    // デフォルトで右端（最新月）にスクロール
    requestAnimationFrame(() => {
      const scrollEl = container.querySelector('.table-responsive');
      if (scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth;
    });

    container.querySelectorAll('.pivot-cell').forEach(cell =>
      cell.addEventListener('click', () => _showDetail(cell.dataset.sheet, cell.dataset.month))
    );
    container.querySelectorAll('.company-name').forEach(el =>
      el.addEventListener('click', () => _showAllExpenses(el.dataset.sheet))
    );
    container.querySelectorAll('.expand-btn').forEach(btn =>
      btn.addEventListener('click', () => _toggleExpand(btn.dataset.sheet))
    );
    _attachCatTips(container);
  }

  function _toggleExpand(sheetId) {
    const sel = CSS.escape(sheetId);
    const btn  = document.querySelector(`.expand-btn[data-sheet="${sel}"]`);
    const rows = document.querySelectorAll(`.cat-row[data-parent="${sel}"]`);
    if (!btn) return;
    const open = btn.dataset.expanded === '1';
    btn.dataset.expanded = open ? '0' : '1';
    btn.querySelector('.expand-icon').classList.toggle('open', !open);
    rows.forEach(r => r.classList.toggle('d-none', open));
  }

  // ── ホバーツールチップ（科目別金額セル） ─────────────────────────────────
  function _attachCatTips(container) {
    container.querySelectorAll('.cat-amount-cell[data-cat]').forEach(cell => {
      cell.addEventListener('mouseenter', () => {
        const { sheet, month, cat } = cell.dataset;
        const summary  = _summaries.find(s => s.sheetId === sheet);
        const amt      = (((summary?.byMonth || {})[month] || {}).byCategory || {})[cat] || 0;
        if (!amt) return;

        const expenses = ((summary?.byMonth[month] || {}).expenses || []).filter(e => e.category === cat);

        if (_catTip) { _catTip.remove(); }
        _catTip = document.createElement('div');
        _catTip.className = 'cat-detail-tip';

        if (expenses.length) {
          _catTip.innerHTML = expenses.map(e =>
            `<div class="d-flex gap-2 justify-content-between">
               <span style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(e.place || '')}</span>
               <span style="white-space:nowrap;font-weight:600;">¥${(e.amount || 0).toLocaleString()}</span>
             </div>${e.note ? `<div style="opacity:.7;font-size:.72rem;padding-left:.1rem;">${_esc(e.note)}</div>` : ''}`
          ).join('');
        } else {
          _catTip.innerHTML = `<div style="opacity:.75;">（明細データなし）</div><div style="font-weight:600;">¥${amt.toLocaleString()}</div>`;
        }
        document.body.appendChild(_catTip);

        const r    = cell.getBoundingClientRect();
        const tipH = _catTip.offsetHeight;
        _catTip.style.left = `${Math.min(r.left, window.innerWidth - _catTip.offsetWidth - 8)}px`;
        _catTip.style.top  = `${Math.max(8, r.top - tipH - 6)}px`;
      });

      cell.addEventListener('mouseleave', () => {
        if (_catTip) { _catTip.remove(); _catTip = null; }
      });
    });
  }

  // ── 全期間経費一覧（会社名クリック） ────────────────────────────────────
  function _showAllExpenses(sheetId) {
    const summary = _summaries.find(s => s.sheetId === sheetId);
    if (!summary) return;

    const months = _activeMths();
    const allExpenses = months.flatMap(m => (summary.byMonth[m]?.expenses || []));
    const byCategory = {};
    allExpenses.forEach(e => { if (e.category) byCategory[e.category] = (byCategory[e.category] || 0) + (e.amount || 0); });
    const total = allExpenses.reduce((s, e) => s + (e.amount || 0), 0);

    const fmt = m => m.replace(/^(\d{4})-(\d{2})$/, (_, y, mo) => `${y}年${parseInt(mo)}月`);
    const range = months.length ? `${fmt(months[0])}〜${fmt(months[months.length - 1])}` : '全期間';

    _active = { expenses: allExpenses, total, byCategory, name: summary.name, month: range };
    _baseExpenses = allExpenses;
    document.getElementById('detailTitle').textContent = summary.name;
    document.getElementById('detailMonth').textContent = range;
    _openDetailModal();
    _renderCategoryBreakdown(_active);
  }

  // ── 月別経費明細ポップアップ（セルクリック） ────────────────────────────
  function _showDetail(sheetId, month) {
    const summary = _summaries.find(s => s.sheetId === sheetId);
    if (!summary) return;
    const data = (summary.byMonth || {})[month];
    if (!data) return;

    const fmt = m => m.replace(/^(\d{4})-(\d{2})$/, (_, y, mo) => `${y}年${parseInt(mo)}月`);
    _active = { ...data, sheetId, name: summary.name, month: fmt(month) };
    _baseExpenses = data.expenses || [];
    document.getElementById('detailTitle').textContent = summary.name;
    document.getElementById('detailMonth').textContent = fmt(month);
    _openDetailModal();
    _renderCategoryBreakdown(_active);
  }

  function _openDetailModal() {
    _filterState = { name: '', cat: '', status: '', sort: 'date_desc' };
    _populateFilters();
    _setupDetailFilters();
    _applyFilters();
    bootstrap.Modal.getOrCreateInstance(document.getElementById('detailModal')).show();
  }

  function _populateFilters() {
    const names = [...new Set(_baseExpenses.map(e => e.name).filter(Boolean))].sort();
    const cats  = [...new Set(_baseExpenses.map(e => e.category).filter(Boolean))].sort();

    const nameEl = document.getElementById('filterName');
    nameEl.innerHTML = '<option value="">申請者：全員</option>' +
      names.map(n => `<option value="${_esc(n)}">${_esc(n)}</option>`).join('');
    nameEl.value = _filterState.name;

    const catEl = document.getElementById('filterCat');
    catEl.innerHTML = '<option value="">勘定科目：全て</option>' +
      cats.map(c => `<option value="${_esc(c)}">${_esc(c)}</option>`).join('');
    catEl.value = _filterState.cat;

    document.getElementById('filterStatus').value = _filterState.status;
    document.getElementById('filterSort').value   = _filterState.sort;
  }

  function _setupDetailFilters() {
    ['filterName', 'filterCat', 'filterStatus', 'filterSort'].forEach(id => {
      const el = document.getElementById(id);
      el.onchange = () => {
        _filterState.name   = document.getElementById('filterName').value;
        _filterState.cat    = document.getElementById('filterCat').value;
        _filterState.status = document.getElementById('filterStatus').value;
        _filterState.sort   = document.getElementById('filterSort').value;
        _applyFilters();
      };
    });
  }

  function _applyFilters() {
    let list = _baseExpenses.slice();

    if (_filterState.name)   list = list.filter(e => e.name === _filterState.name);
    if (_filterState.cat)    list = list.filter(e => e.category === _filterState.cat);
    if (_filterState.status) {
      list = list.filter(e => {
        if (_filterState.status === 'settled')   return !!e.settlementDate;
        if (_filterState.status === 'confirmed') return !e.settlementDate && !!e.confirmed;
        if (_filterState.status === 'pending')   return !e.settlementDate && !e.confirmed;
        return true;
      });
    }

    const [sortKey, sortDir] = _filterState.sort.split('_');
    list.sort((a, b) => {
      const va = sortKey === 'date' ? (a.date || '') : (a.amount || 0);
      const vb = sortKey === 'date' ? (b.date || '') : (b.amount || 0);
      return sortDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });

    const filtered = { ...(_active || {}), expenses: list, total: list.reduce((s, e) => s + (e.amount || 0), 0) };
    _renderDetailTableRows(filtered);
  }

  function _renderDetailTableRows(d) {
    const expenses = d.expenses || [];
    document.getElementById('detailSummaryText').textContent =
      `${expenses.length}件 ／ 合計 ¥${(d.total || 0).toLocaleString()}`;

    const tbody = document.getElementById('detailTableBody');
    if (!expenses.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-3">経費がありません</td></tr>';
      return;
    }
    tbody.innerHTML = expenses.map(e => {
      const badge = e.settlementDate
        ? '<span class="badge bg-secondary" style="font-size:.7rem;">精算済</span>'
        : e.confirmed
          ? '<span class="badge bg-success" style="font-size:.7rem;">登録済</span>'
          : '<span class="badge bg-warning text-dark" style="font-size:.7rem;">申請済</span>';
      const receipt = (e.imageLinks || '').split(',').filter(u => u.trim()).map((u, i) =>
        `<a href="${_esc(u.trim())}" target="_blank" rel="noopener" class="receipt-link me-1"><i class="bi bi-image"></i>${i > 0 ? i + 1 : ''}</a>`
      ).join('') || '<span class="text-muted">—</span>';
      return `<tr>
        <td class="text-nowrap">${_esc(e.date || '')}</td>
        <td>${_esc(e.name || '')}</td>
        <td>${_esc(e.place || '')}</td>
        <td class="text-end text-nowrap">¥${(e.amount || 0).toLocaleString()}</td>
        <td style="font-size:.8rem;">${_esc(e.category || '')}</td>
        <td style="font-size:.8rem;max-width:180px;" class="text-truncate" title="${_esc(e.note || '')}">${_esc(e.note || '')}</td>
        <td>${badge}</td>
        <td>${receipt}</td>
      </tr>`;
    }).join('');
  }

  function _renderCategoryBreakdown(d) {
    const cats  = Object.entries(d.byCategory || {}).sort((a, b) => b[1] - a[1]);
    const total = cats.reduce((sum, [, v]) => sum + v, 0);
    const el    = document.getElementById('categoryBreakdown');
    if (!cats.length) { el.innerHTML = '<p class="text-muted text-center py-3">データがありません</p>'; return; }
    const colors = ['#0d6efd','#198754','#fd7e14','#6610f2','#dc3545','#0dcaf0','#ffc107'];
    el.innerHTML = cats.map(([cat, amt], i) => {
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
    const rows = (_baseExpenses || []).map(e => [
      e.date, e.name, e.place, e.amount, e.category, e.type, e.note,
      e.settlementDate ? '精算済' : e.confirmed ? '登録済' : '申請済', e.id,
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
