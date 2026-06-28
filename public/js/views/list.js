/**
 * 一覧表ビュー
 * 経費一覧シートのデータをWebページで表示する（新規機能）
 * 管理者：全メンバー分表示・承認操作可
 * 一般：自分の分のみ表示
 */
const ListView = (() => {

  let _expenses  = [];
  let _master    = null;
  let _isAdmin   = false;
  let _userRole  = 'member';
  let _showAll   = false;
  let _shownCount = 50;
  let _sortMode  = 'applied'; // 'applied'=登録順 / 'date'=日付順

  function render() {
    const { fromYM, toYM } = _defaultRange();
    return `
<div class="pt-3">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="fw-bold mb-0"><i class="bi bi-list-ul me-2 text-primary"></i>一覧表</h5>
    <div class="d-flex gap-2">
      <div class="btn-group no-print">
        <button class="btn btn-outline-secondary btn-sm" id="btnExportCsv">
          <i class="bi bi-download me-1"></i>CSV
        </button>
        <button class="btn btn-outline-secondary btn-sm dropdown-toggle dropdown-toggle-split px-2"
          data-bs-toggle="dropdown" aria-expanded="false"></button>
        <ul class="dropdown-menu dropdown-menu-end">
          <li><h6 class="dropdown-header" style="font-size:0.7rem;">会計ソフト形式 <a href="/faq#q702" class="text-muted" style="font-size:0.75rem;" title="CSVエクスポートについて"><i class="bi bi-question-circle"></i></a></h6></li>
          <li><a class="dropdown-item small" href="#" id="btnExportFreee">freee 経費精算</a></li>
          <li><a class="dropdown-item small" href="#" id="btnExportYayoi">弥生 仕訳日記帳</a></li>
          <li><a class="dropdown-item small" href="#" id="btnExportMfc">MFクラウド 仕訳帳</a></li>
        </ul>
      </div>
      <button class="btn btn-outline-secondary btn-sm no-print" id="btnRefreshList">
        <i class="bi bi-arrow-clockwise"></i>
      </button>
    </div>
  </div>

  <!-- フィルターパネル -->
  <div class="card mb-3 no-print">
    <div class="card-body py-2 px-3">
      <!-- 期間プリセット（集計表と統一） -->
      <div class="d-flex flex-wrap gap-2 align-items-center mb-2">
        <div class="btn-group btn-group-sm" id="listPresetBtns">
          <button class="btn btn-outline-secondary" data-months="3">3ヶ月</button>
          <button class="btn btn-outline-secondary" data-months="6">6ヶ月</button>
          <button class="btn btn-outline-primary active" data-months="12">12ヶ月</button>
          <button class="btn btn-outline-secondary" data-months="0">カスタム</button>
        </div>
        <div id="listCustomRange" class="d-none d-flex align-items-center gap-1">
          <input type="month" class="form-control form-control-sm" id="filterMonthFrom"
            value="${fromYM}" style="width:140px;">
          <span class="text-muted small">〜</span>
          <input type="month" class="form-control form-control-sm" id="filterMonthTo"
            value="${toYM}" style="width:140px;">
        </div>
      </div>
      <!-- タイプ・承認状態・申請者・支払元・キーワード（PC:1行、SP:2列） -->
      <div class="row g-2">
        <div class="col-6 col-md">
          <select class="form-select form-select-sm" id="filterType">
            <option value="">タイプ（全て）</option>
            <option>領収書</option><option>領収書なし</option>
            <option>電車/バス</option><option>自家用車</option>
          </select>
        </div>
        <div class="col-6 col-md">
          <select class="form-select form-select-sm" id="filterStatus">
            <option value="">ステータス（全て）</option>
            <option value="申請済">申請済</option>
            <option value="登録済">登録済</option>
            <option value="精算済">精算済</option>
          </select>
        </div>
        <div class="col-6 col-md" id="filterMemberWrap" style="display:none;">
          <select class="form-select form-select-sm" id="filterMember">
            <option value="">申請者（全員）</option>
          </select>
        </div>
        <div class="col-6 col-md">
          <select class="form-select form-select-sm" id="filterPaySource">
            <option value="">支払元（全て）</option>
          </select>
        </div>
        <div class="col-6 col-md">
          <select class="form-select form-select-sm" id="filterCustomFlag">
            <option value="">フラグ（全て）</option>
          </select>
        </div>
        <div class="col-6 col-md">
          <div class="input-group input-group-sm">
            <span class="input-group-text"><i class="bi bi-search"></i></span>
            <input type="text" class="form-control" id="filterKeyword" placeholder="支払先・備考・科目">
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 合計表示 -->
  <div class="d-flex justify-content-between align-items-center mb-2">
    <div class="d-flex align-items-center gap-2 flex-wrap">
      <span class="text-muted small" id="lblCount">読み込み中...</span>
      <span class="text-muted" style="font-size:0.72rem;">🏢 = 会社直接支払</span>
      <div class="btn-group btn-group-sm no-print" id="listSortBtns">
        <button class="btn btn-outline-secondary active" data-sort="applied" style="font-size:0.72rem;padding:0.1rem 0.5rem;">登録順</button>
        <button class="btn btn-outline-secondary" data-sort="date" style="font-size:0.72rem;padding:0.1rem 0.5rem;">日付順</button>
      </div>
    </div>
    <span class="fw-bold" id="lblFilterTotal"></span>
  </div>

  <!-- PC テーブル（lg以上） -->
  <div class="d-none d-lg-block table-responsive">
    <table class="table table-hover list-table list-table-pc">
      <thead class="table-light">
        <tr>
          <th class="text-center">日付</th>
          <th class="text-center">申請者</th>
          <th class="text-center">支払先</th>
          <th class="text-center">タイプ</th>
          <th class="text-center">金額</th>
          <th class="text-center">科目</th>
          <th class="text-center">備考</th>
          <th class="text-center">証票</th>
          <th class="text-center">状態</th>
          <th class="text-center">精算日</th>
          <th class="no-print text-center">操作</th>
        </tr>
      </thead>
      <tbody id="listTbodyPc">
        <tr><td colspan="11" class="text-center text-muted py-3">読み込み中...</td></tr>
      </tbody>
    </table>
  </div>

  <!-- スマホカードリスト（lg未満） -->
  <div class="d-lg-none" id="listCardsSp">
    <div class="text-center text-muted py-3">読み込み中...</div>
  </div>

  <!-- もっと見る -->
  <div id="listLoadMore" class="text-center mt-2 mb-1 d-none no-print">
    <button class="btn btn-outline-secondary btn-sm px-4" id="btnLoadMore">
      <i class="bi bi-chevron-down me-1"></i>もっと見る
    </button>
  </div>

</div>`;
  }

  // ─── 期間ヘルパー ────────────────────────────────────────────
  function _defaultRange() { return _rangeForMonths(12); }

  function _rangeForMonths(n) {
    const now  = new Date();
    const toYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const from = new Date(now.getFullYear(), now.getMonth() - (n - 1), 1);
    const fromYM = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
    return { fromYM, toYM };
  }

  async function bindEvents(el, opts = {}) {
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    if (!isDemo && (!localStorage.getItem('keihi_sheet_id') || !localStorage.getItem('keihi_license_key'))) {
      el.innerHTML = `<div class="text-center py-5 text-muted">
        <i class="bi bi-table" style="font-size:2.5rem;opacity:0.3;"></i>
        <div class="mt-3">初期設定が完了していません。</div>
        <button class="btn btn-primary btn-sm mt-3" onclick="Router.navigate('settings')">設定画面へ</button>
      </div>`;
      return;
    }

    // PC では幅制限を解除してゆったり表示
    const main = document.getElementById('appMain');
    if (main) main.style.maxWidth = '';

    try {
      _master   = await App.getMaster();
      _userRole = App.getUserRole();
      _isAdmin  = _userRole === 'admin';
      _showAll  = _userRole === 'admin' || _userRole === 'viewer';
      _expenses = await App.getExpenses();
    } catch (err) {
      if (!opts.fromCache) {
        const msg = App.friendlyError(err, 'load');
        el.querySelector('#listTbodyPc').innerHTML = `<tr><td colspan="11" class="text-danger text-center">${msg}</td></tr>`;
        el.querySelector('#listCardsSp').innerHTML = `<div class="text-danger text-center py-3">${msg}</div>`;
      }
      return;
    }

    // fromCache=true のとき：スワイプ由来でキャッシュ済みHTMLが表示されているため
    // テーブル再レンダリングをスキップ（チカチカ防止）
    if (opts.fromCache) {
      // ロールが変わった場合（init完了後にviewerに変わった等）は再レンダリング
      const _freshRole = App.getUserRole();
      if (_freshRole !== _userRole) {
        _userRole = _freshRole;
        _isAdmin  = _freshRole === 'admin';
        _showAll  = _freshRole === 'admin' || _freshRole === 'viewer';
        _renderTable(el);
      }
      // イベントハンドラのみ再バインドして早期リターン
      el.querySelector('#btnRefreshList')?.addEventListener('click', async () => {
        try {
          _expenses = await App.getExpenses(true);
          _populatePaySourceFilter(el);
          _renderTable(el);
          App.showToast('更新しました', 'success');
        } catch (err) { App.showToast(App.friendlyError(err, 'load'), 'danger'); }
      });
      el.querySelector('#btnExportCsv')?.addEventListener('click', () => _exportCsv(el));
      el.querySelector('#btnExportFreee')?.addEventListener('click', e => { e.preventDefault(); _exportFreee(el); });
      el.querySelector('#btnExportYayoi')?.addEventListener('click', e => { e.preventDefault(); _exportYayoi(el); });
      el.querySelector('#btnExportMfc')?.addEventListener('click', e => { e.preventDefault(); _exportMfc(el); });
      ['filterType','filterStatus','filterKeyword','filterMember','filterPaySource','filterCustomFlag'].forEach(id => {
        el.querySelector(`#${id}`)?.addEventListener('input', () => { _shownCount = 50; _renderTable(el); });
      });
      el.querySelectorAll('#listSortBtns [data-sort]').forEach(btn => {
        btn.addEventListener('click', () => {
          _sortMode = btn.dataset.sort;
          el.querySelectorAll('#listSortBtns [data-sort]').forEach(b => {
            b.classList.toggle('active', b === btn);
          });
          _shownCount = 50; _renderTable(el);
        });
      });
      el.querySelectorAll('#listPresetBtns [data-months]').forEach(btn => {
        btn.addEventListener('click', () => {
          el.querySelectorAll('#listPresetBtns [data-months]').forEach(b => {
            b.classList.remove('active', 'btn-outline-primary');
            b.classList.add('btn-outline-secondary');
          });
          btn.classList.add('active', 'btn-outline-primary');
          btn.classList.remove('btn-outline-secondary');
          const months = Number(btn.dataset.months);
          const customRange = el.querySelector('#listCustomRange');
          if (months === 0) { customRange.classList.remove('d-none'); }
          else {
            customRange.classList.add('d-none');
            const { fromYM, toYM } = _rangeForMonths(months);
            el.querySelector('#filterMonthFrom').value = fromYM;
            el.querySelector('#filterMonthTo').value   = toYM;
          }
          _shownCount = 50; _renderTable(el);
        });
      });
      requestAnimationFrame(() => _initResizableColumns(el.querySelector('.list-table-pc')));
      return;
    }

    // 管理者・閲覧者：メンバー選択ボックスを表示
    if (_isAdmin || _userRole === 'viewer') {
      el.querySelector('#filterMemberWrap').style.display = '';
      const sel = el.querySelector('#filterMember');
      sel.insertAdjacentHTML('beforeend',
        _master.members.map(m => `<option value="${m.email}">${m.name}</option>`).join(''));
    }

    // 支払元フィルター：データから動的に生成
    _populatePaySourceFilter(el);

    // 期間プリセットボタン
    el.querySelectorAll('#listPresetBtns [data-months]').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('#listPresetBtns [data-months]').forEach(b => {
          b.classList.remove('active', 'btn-outline-primary');
          b.classList.add('btn-outline-secondary');
        });
        btn.classList.add('active');
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-outline-primary');

        const months = Number(btn.dataset.months);
        const customRange = el.querySelector('#listCustomRange');
        if (months === 0) {
          customRange.classList.remove('d-none');
        } else {
          customRange.classList.add('d-none');
          const { fromYM, toYM } = _rangeForMonths(months);
          el.querySelector('#filterMonthFrom').value = fromYM;
          el.querySelector('#filterMonthTo').value   = toYM;
        }
        _shownCount = 50; _renderTable(el);
      });
    });
    const _reset = () => {
      const from = el.querySelector('#filterMonthFrom')?.value;
      const to   = el.querySelector('#filterMonthTo')?.value;
      if (from && to && from > to) {
        App.showToast('終了年月は開始年月より後に設定してください', 'warning');
        el.querySelector('#filterMonthTo').value = from;
        return;
      }
      _shownCount = 50; _renderTable(el);
    };
    el.querySelector('#filterMonthFrom')?.addEventListener('change', _reset);
    el.querySelector('#filterMonthTo')?.addEventListener('change', _reset);

    // カスタムフラグフィルター選択肢をマスタから生成
    const customFlags = _master.customFlags || [];
    if (customFlags.length > 0) {
      const cfSel = el.querySelector('#filterCustomFlag');
      if (cfSel) cfSel.insertAdjacentHTML('beforeend',
        customFlags.map(f => `<option value="${f}">${f}</option>`).join(''));
    }

    // フィルタリング
    ['filterType','filterStatus','filterKeyword','filterMember','filterPaySource','filterCustomFlag'].forEach(id => {
      el.querySelector(`#${id}`)?.addEventListener('input', _reset);
    });

    el.querySelector('#btnRefreshList')?.addEventListener('click', async () => {
      try {
        _expenses = await App.getExpenses(true); // キャッシュ無視で強制再取得
        _populatePaySourceFilter(el);
        _renderTable(el);
        App.showToast('更新しました', 'success');
      } catch (err) {
        App.showToast(App.friendlyError(err, 'load'), 'danger');
      }
    });

    el.querySelector('#btnExportCsv')?.addEventListener('click', () => _exportCsv(el));
    el.querySelector('#btnExportFreee')?.addEventListener('click', e => { e.preventDefault(); _exportFreee(el); });
    el.querySelector('#btnExportYayoi')?.addEventListener('click', e => { e.preventDefault(); _exportYayoi(el); });
    el.querySelector('#btnExportMfc')?.addEventListener('click', e => { e.preventDefault(); _exportMfc(el); });

    el.querySelectorAll('#listSortBtns [data-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        _sortMode = btn.dataset.sort;
        el.querySelectorAll('#listSortBtns [data-sort]').forEach(b => {
          b.classList.toggle('active', b === btn);
        });
        _shownCount = 50; _renderTable(el);
      });
    });

    _renderTable(el);
    requestAnimationFrame(() => _initResizableColumns(el.querySelector('.list-table-pc')));
  }

  const _COL_WIDTHS_KEY = 'keihi_list_col_widths';

  function _initResizableColumns(table) {
    if (!table) return;
    const ths = [...table.querySelectorAll('thead tr th')];
    const saved = JSON.parse(localStorage.getItem(_COL_WIDTHS_KEY) || 'null');

    // colgroup > col で幅を管理（th直接指定より確実）
    const colgroup = document.createElement('colgroup');
    const cols = ths.map((th, i) => {
      const col = document.createElement('col');
      // 保存値があれば復元、なければ描画幅をそのまま使用
      const w = (saved && saved.length === ths.length) ? saved[i] : th.offsetWidth;
      col.style.width = w + 'px';
      colgroup.appendChild(col);
      return col;
    });
    table.prepend(colgroup);
    table.style.tableLayout = 'fixed';
    // テーブル幅 = 全列幅の合計に固定（これがないと他列が連動して動く）
    const syncTableWidth = () => {
      table.style.width = cols.reduce((s, c) => s + parseInt(c.style.width), 0) + 'px';
    };
    syncTableWidth();

    const saveWidths = () => {
      localStorage.setItem(_COL_WIDTHS_KEY,
        JSON.stringify(cols.map(c => parseInt(c.style.width))));
    };

    ths.forEach((th, i) => {
      if (i === ths.length - 1) return; // 操作列はスキップ
      const resizer = document.createElement('div');
      resizer.className = 'col-resizer';
      th.style.position = 'relative';
      th.appendChild(resizer);

      let startX, startW;
      resizer.addEventListener('mousedown', e => {
        e.preventDefault();
        startX = e.pageX;
        startW = parseInt(cols[i].style.width);
        resizer.classList.add('dragging');
        const onMove = e2 => {
          const newW = Math.max(40, startW + e2.pageX - startX);
          cols[i].style.width = newW + 'px';
          syncTableWidth(); // ドラッグした列だけ変わり他列は不変
        };
        const onUp = () => {
          resizer.classList.remove('dragging');
          saveWidths();
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  function _getFiltered(el) {
    const fromYM  = el.querySelector('#filterMonthFrom')?.value || _defaultRange().fromYM;
    const toYM    = el.querySelector('#filterMonthTo')?.value   || _defaultRange().toYM;
    const fromDate = fromYM ? `${fromYM}-01` : '';
    const toDate   = toYM   ? `${toYM}-31`   : '';
    const type    = el.querySelector('#filterType')?.value     || '';
    const status  = el.querySelector('#filterStatus')?.value   || '';
    const keyword    = (el.querySelector('#filterKeyword')?.value    || '').toLowerCase();
    const member     = el.querySelector('#filterMember')?.value     || '';
    const paySrc     = el.querySelector('#filterPaySource')?.value  || '';
    const customFlag = el.querySelector('#filterCustomFlag')?.value || '';
    const email      = Auth.getUserEmail();

    return _expenses.filter(e => {
      if (!e.id) return false;
      // 表示対象：admin/viewer は全員分、member は自分のみ
      if (!_showAll) {
        if (e.email !== email) return false;
      } else if (member && e.email !== member) return false;

      if (fromDate && e.date < fromDate) return false;
      if (toDate   && e.date > toDate)   return false;
      if (type && e.type !== type) return false;
      if (status && _getStatus(e) !== status) return false;
      if (customFlag && e.customFlag !== customFlag) return false;
      if (keyword && ![e.place, e.note, App.categoryLabel(e.category)].join(' ').toLowerCase().includes(keyword)) return false;
      if (paySrc) {
        const corpSrc = _corpPaySource(e);
        if (paySrc === '__individual__') { if (corpSrc) return false; }
        else if (corpSrc !== paySrc) return false;
      }
      return true;
    }).sort((a, b) => {
      if (_sortMode === 'date') {
        // 日付順（新しい順）→ 申請日時順
        const d = String(b.date || '').localeCompare(String(a.date || ''));
        if (d !== 0) return d;
        return String(b.appliedAt || '').localeCompare(String(a.appliedAt || ''));
      }
      // 登録順（デフォルト）：申請日時（新しい順）→ 日付（新しい順）
      const aKey = String(a.appliedAt || a.date || '');
      const bKey = String(b.appliedAt || b.date || '');
      if (bKey !== aKey) return bKey.localeCompare(aKey);
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
  }

  function _renderTable(el) {
    const filtered = _getFiltered(el);
    const total = filtered.reduce((s, e) => s + e.amount, 0);
    el.querySelector('#lblCount').textContent = `${filtered.length}件`;
    el.querySelector('#lblFilterTotal').textContent = filtered.length > 0
      ? `合計 ¥${total.toLocaleString()}` : '';

    const tbodyPc  = el.querySelector('#listTbodyPc');
    const cardsSp  = el.querySelector('#listCardsSp');
    const loadMore = el.querySelector('#listLoadMore');
    const visible  = filtered.slice(0, _shownCount);

    if (filtered.length === 0) {
      tbodyPc.innerHTML = '<tr><td colspan="11" class="text-center text-muted py-3">該当する申請がありません</td></tr>';
      cardsSp.innerHTML = '<div class="text-center text-muted py-3">該当する申請がありません</div>';
      loadMore?.classList.add('d-none');
      return;
    }

    // もっと見るボタン制御
    if (loadMore) {
      if (_shownCount < filtered.length) {
        loadMore.classList.remove('d-none');
        loadMore.querySelector('#btnLoadMore').onclick = () => {
          _shownCount += 50;
          _renderTable(el);
        };
      } else {
        loadMore.classList.add('d-none');
      }
    }

    const email = Auth.getUserEmail();
    const rowsPc = [], cardHtmls = [];

    visible.forEach(e => {
      const status = _getStatus(e);
      const statusBadge = _statusBadge(status, e);
      // 精算済み判定：サーバー側 _isRealSettled と同じロジック
      const isSettled = status === '精算済' && !String(e.settlementDate || '').startsWith('会社払い');
      // 編集可否：精算済は不可。管理者は全ステータス可、一般は申請済かつ本人のみ
      const canEdit = !isSettled && (_isAdmin || (status === '申請済' && e.email === email));
      // 承認ボタン（申請済→登録済）：管理者のみ
      const approveBtn = _isAdmin && status === '申請済'
        ? `<button class="btn btn-outline-success btn-sm py-0 px-1 btn-approve" data-id="${e.id}" title="登録済にする"><i class="bi bi-check"></i></button>` : '';
      const editBtn = canEdit
        ? `<button class="btn btn-outline-secondary btn-sm py-0 px-1 btn-edit-list" data-id="${e.id}"><i class="bi bi-pencil"></i></button>` : '';
      // 削除可否：精算済は不可
      const canDelete = canEdit;
      const deleteBtn = canDelete
        ? `<button class="btn btn-outline-danger btn-sm py-0 px-1 btn-del-list" data-id="${e.id}" title="削除"><i class="bi bi-trash"></i></button>` : '';
      // 精算解除ボタン（精算済→登録済に戻す）：管理者のみ。誤精算の訂正用。
      const unsettleBtn = _isAdmin && isSettled
        ? `<button class="btn btn-outline-warning btn-sm py-0 px-1 btn-unsettle" data-id="${e.id}" title="精算を解除して登録済に戻す"><i class="bi bi-arrow-counterclockwise"></i></button>` : '';
      const ops = `<div class="d-flex gap-1">${approveBtn}${editBtn}${deleteBtn}${unsettleBtn}</div>`;

      // 証票リンク（複数対応）
      const imgUrls = e.imageLinks ? e.imageLinks.split(',').map(s => s.trim()).filter(Boolean) : [];
      const urlsJson = imgUrls.length ? _escape(JSON.stringify(imgUrls)) : '';
      const receiptBtns = imgUrls.map((url, i) =>
        `<button type="button" class="btn btn-outline-primary btn-sm py-0 px-2 btn-receipt-view" data-urls="${urlsJson}" data-idx="${i}">
           <i class="bi bi-image me-1"></i>${imgUrls.length > 1 ? `証票${i + 1}` : '証票'}
         </button>`
      ).join('');

      // PC行（10列）
      rowsPc.push(`<tr>
        <td class="list-date">${e.date}</td>
        <td class="list-member">${_escape(App.getMemberName(e.email, e.name))}</td>
        <td class="list-place">${e.settlementDate?.startsWith('会社払い') ? '🏢 ' : ''}${_escape(e.place)}</td>
        <td class="list-type-cell">${_escape(e.type)}</td>
        <td class="text-end list-amount">¥${e.amount.toLocaleString()}</td>
        <td class="list-cat">${_escape(App.categoryLabel(e.category))}${_effectiveTaxRate(e) !== '課税10%' ? `<br><span class="badge text-bg-light border" style="font-size:0.65rem;font-weight:normal;">${_escape(_effectiveTaxRate(e))}</span>` : ''}</td>
        <td class="list-note-cell text-muted${e.note ? ' expandable' : ''}">${e.note ? `<span class="note-text">${_escape(e.note)}</span><i class="bi bi-chevron-down note-expand-chevron"></i>` : ''}</td>
        <td class="text-center"><div class="d-flex flex-wrap gap-1 justify-content-center">${receiptBtns}</div></td>
        <td>${statusBadge}</td>
        <td class="text-center" style="font-size:0.75rem;white-space:nowrap;">${_escape(_fmtSettlement(e.settlementDate))}</td>
        <td class="no-print">${ops}</td>
      </tr>`);

      // SPカード
      const hasExtra = e.note || imgUrls.length > 0;
      cardHtmls.push(`
        <div class="list-sp-card" data-id="${e.id}">
          <div class="d-flex justify-content-between align-items-start gap-2">
            <div class="flex-grow-1" style="min-width:0;">
              <div class="d-flex align-items-baseline gap-1">
                <span class="list-sp-date">${_fmtDateShort(e.date)}</span>
                <span class="list-sp-place">${e.settlementDate?.startsWith('会社払い') ? '🏢 ' : ''}${_escape(e.place)}</span>
              </div>
              <div class="list-sp-name">${_escape(App.getMemberName(e.email, e.name))}</div>
            </div>
            <div class="flex-shrink-0 text-end">
              <div class="list-sp-amount">
                ¥${e.amount.toLocaleString()}
              </div>
              ${receiptBtns ? `<div class="d-flex flex-wrap gap-1 justify-content-end mt-1">${receiptBtns}</div>` : ''}
            </div>
          </div>
          <div class="d-flex justify-content-between align-items-center mt-1 gap-2">
            <div class="d-flex align-items-center gap-1 flex-wrap" style="min-width:0;">
              ${statusBadge}
              <span class="list-sp-cat">${_escape(App.categoryLabel(e.category))}</span>
              ${_effectiveTaxRate(e) !== '課税10%' ? `<span class="badge text-bg-light border" style="font-size:0.65rem;font-weight:normal;">${_escape(_effectiveTaxRate(e))}</span>` : ''}
              ${e.note ? `<span class="list-sp-note-wrap expandable"><span class="list-sp-note">${_escape(e.note)}</span><i class="bi bi-chevron-down chevron"></i></span>` : ''}
            </div>
            <div class="no-print flex-shrink-0">${ops}</div>
          </div>
          ${e.note ? `
          <div class="list-sp-extra d-none">
            <div class="list-sp-extra-note"><i class="bi bi-chat-text me-1 text-secondary"></i>${_escape(e.note)}</div>
          </div>` : ''}
        </div>`);
    });

    tbodyPc.innerHTML = rowsPc.join('');
    cardsSp.innerHTML = cardHtmls.join('');

    // イベントをPC・SPの両方にバインド
    [tbodyPc, cardsSp].forEach(container => {
      container.querySelectorAll('.btn-approve').forEach(btn => {
        btn.addEventListener('click', () => _approveExpense(btn.dataset.id, el));
      });
      container.querySelectorAll('.btn-edit-list').forEach(btn => {
        btn.addEventListener('click', () => {
          SubmitView.queueEdit(btn.dataset.id, _expenses, 'list');
          Router.navigate('submit');
        });
      });
      container.querySelectorAll('.btn-del-list').forEach(btn => {
        btn.addEventListener('click', () => _deleteExpense(btn.dataset.id, el));
      });
      container.querySelectorAll('.btn-unsettle').forEach(btn => {
        btn.addEventListener('click', () => _unsettleExpense(btn.dataset.id, el));
      });
    });

    // PC：金額クリックで詳細行トグル
    tbodyPc.querySelectorAll('.list-amount-toggle').forEach(td => {
      td.addEventListener('click', () => {
        const detailRow = tbodyPc.querySelector(`[data-detail-row="${td.dataset.detail}"]`);
        if (!detailRow) return;
        const open = !detailRow.classList.contains('d-none');
        detailRow.classList.toggle('d-none', open);
        td.style.color = open ? '' : '#0a58ca';
      });
    });

    // SP：備考末尾のシェブロンタップで詳細エリアトグル
    cardsSp.querySelectorAll('.list-sp-note-wrap.expandable').forEach(wrapEl => {
      wrapEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const card  = wrapEl.closest('.list-sp-card');
        const extra = card?.querySelector('.list-sp-extra');
        if (!extra) return;
        const opening = extra.classList.contains('d-none');
        extra.classList.toggle('d-none', !opening);
        wrapEl.classList.toggle('open', opening);
      });
    });

    // PC：備考末尾のシェブロンクリックで全文展開トグル
    tbodyPc.querySelectorAll('.list-note-cell.expandable').forEach(td => {
      td.addEventListener('click', () => {
        td.classList.toggle('open');
      });
    });
  }

  function _fmtDateShort(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    return `${Number(parts[1])}/${Number(parts[2])}`;
  }

  // 精算日の表示用整形。Sheetsが日付セルをシリアル値（例: 46177）で返す場合があるため
  // 数値なら YYYY-MM-DD に変換する。会社払いマーカーや既に日付文字列の場合はそのまま返す。
  function _fmtSettlement(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^\d+(\.\d+)?$/.test(s)) {
      // Google Sheets のシリアル日付（基準日 1899-12-30）
      const serial = Math.floor(Number(s));
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return s;
  }

  async function _approveExpense(id, el) {
    const expense = _expenses.find(x => x.id === id);
    const aiAudit = expense?.aiAudit?.trim();
    const detailHtml = aiAudit
      ? `<div class="alert alert-info py-2 mb-0 small">
           <i class="bi bi-stars me-1"></i><strong>AI監査：</strong>${_escape(aiAudit)}
         </div>`
      : '';
    const ok = await App.confirm('この申請を登録済にしますか？', detailHtml);
    if (!ok) return;
    App.showLoading('承認中...');
    try {
      if (typeof Demo !== 'undefined' && Demo.isActive()) {
        await new Promise(r => setTimeout(r, 400));
      } else if (Sheets.useProxy && Sheets.useProxy()) {
        await Sheets.approveExpense(id);
      } else {
        const rowNum = await Sheets.findRowById(id);
        if (rowNum < 0) throw new Error('行が見つかりません');
        await Sheets.update(`経費一覧!J${rowNum}`, [[true]]);
      }
      const e = _expenses.find(x => x.id === id);
      if (e) e.confirmed = true;
      _renderTable(el);
      App.showToast('登録済にしました', 'success');
    } catch (err) {
      App.showToast('登録済への変更に失敗しました。' + App.friendlyError(err), 'danger');
    } finally {
      App.hideLoading();
    }
  }

  async function _unsettleExpense(id, el) {
    const e = _expenses.find(x => x.id === id);
    const detailHtml = `<div class="alert alert-warning py-2 mb-0 small">
        精算日：${_escape(_fmtSettlement(e?.settlementDate))}<br>
        精算ステータスを解除し「登録済」に戻します。誤って精算した場合の訂正用です。
      </div>`;
    const ok = await App.confirm('この申請の精算を解除して登録済に戻しますか？', detailHtml);
    if (!ok) return;
    App.showLoading('精算解除中...');
    try {
      await Sheets.batchUnsettle([id]);
      if (e) e.settlementDate = '';
      _renderTable(el);
      App.showToast('精算を解除しました', 'success');
    } catch (err) {
      App.showToast('精算解除に失敗しました。' + App.friendlyError(err), 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _getStatus(e) {
    if (e.settlementDate) return '精算済';
    if (e.confirmed)      return '登録済';
    return '申請済';
  }

  function _statusBadge(status, e) {
    if (status === '精算済') {
      // 会社払いは実精算ではなく編集可能。紛らわしいので専用バッジで区別する。
      if (e && String(e.settlementDate || '').startsWith('会社払い'))
        return `<span class="badge bg-secondary" style="font-size:0.65rem;">会社払い</span>`;
      return `<span class="badge badge-settled" style="font-size:0.65rem;">精算済</span>`;
    }
    if (status === '登録済') return `<span class="badge badge-confirmed" style="font-size:0.65rem;">登録済</span>`;
    return `<span class="badge badge-pending" style="font-size:0.65rem;">申請済</span>`;
  }

  function _exportCsv(el) {
    const filtered = _getFiltered(el);
    const header = ['申請日時','申請者名','タイプ','日付','支払先','金額','勘定科目',
      '備考','証票URL','ステータス','インボイス番号','申請者Email','ID','精算日','税区分','支払元','源泉徴収','カスタムフラグ'];
    const _isoToSlash = s => s ? String(s).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$1/$2/$3') : '';
    const rows = filtered.map(e => {
      const corpSrc = _corpPaySource(e);
      const paySource = corpSrc ? corpSrc : `個人（${App.getMemberName(e.email, e.name)}）`;
      return [
        _isoToSlash(e.appliedAt), App.getMemberName(e.email, e.name), e.type, _isoToSlash(e.date), e.place, e.amount,
        App.categoryLabel(e.category),
        e.note, e.imageLinks.split(',')[0]?.trim() || '',
        _getStatus(e), e.invoice, e.email, e.id,
        e.settlementDate || '', _effectiveTaxRate(e), paySource,
        e.withholding || 0, e.customFlag || ''
      ];
    });
    const csv = [header, ...rows].map(r =>
      r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    _downloadCsv(csv, `経費一覧_${new Date().toISOString().split('T')[0]}.csv`);
  }

  async function _deleteExpense(id, el) {
    const ok = await App.confirm('この申請を削除しますか？削除後は元に戻せません。');
    if (!ok) return;
    App.showLoading('削除中...');
    try {
      const e = _expenses.find(x => x.id === id);
      if (!e) throw new Error('レコードが見つかりません');
      if (Sheets.useProxy && Sheets.useProxy()) {
        await Sheets.deleteExpense(id);
      } else {
        const ssId = localStorage.getItem('keihi_sheet_id');
        const timeResp = await fetch('/api/time');
        const deletedAt = timeResp.ok
          ? (await timeResp.json()).jst
          : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        await Sheets.prependRow('削除一覧', [deletedAt, Auth.getUserEmail(), ...Sheets.expenseToRow(e)], ssId);
        const rowIndex = await Sheets.findRowById(id, ssId);
        if (rowIndex > 0) await Sheets.deleteRow('経費一覧', rowIndex, ssId);
      }
      _expenses = _expenses.filter(x => x.id !== id);
      _renderTable(el);
      App.showToast('削除しました', 'success');
    } catch (err) {
      App.showToast('削除に失敗しました。' + App.friendlyError(err), 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _downloadCsv(csv, filename) {
    const bom = '﻿';
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function _populatePaySourceFilter(el) {
    const sel = el.querySelector('#filterPaySource');
    if (!sel) return;
    const sources = new Set();
    let hasIndividual = false;
    _expenses.forEach(e => {
      const s = _corpPaySource(e);
      if (s) sources.add(s);
      else hasIndividual = true;
    });
    // innerHTML += を繰り返すと都度 DOM 再解析が走るため、まとめて追記する
    const opts = [];
    if (hasIndividual) opts.push('<option value="__individual__">個人払い</option>');
    [...sources].sort().forEach(s => opts.push(`<option value="${s}">${s}</option>`));
    if (opts.length) sel.insertAdjacentHTML('beforeend', opts.join(''));
  }

  // "会社払い（◯◯）" から支払元名を抽出。会社払いでなければ空文字。
  function _corpPaySource(e) {
    const m = (e.settlementDate || '').match(/^会社払い（(.+)）$/);
    return m ? m[1] : '';
  }

  // 電車/バス・自家用車は旧データでも常に課税10%として扱う
  function _effectiveTaxRate(e) {
    if (e.type === '電車/バス' || e.type === '自家用車') return '課税10%';
    return e.taxRate || '課税10%';
  }

  // taxRate に応じた消費税額と各会計ソフト用の税区分文字列を返す
  function _taxInfo(amount, taxRate) {
    const r = taxRate || '課税10%';
    if (r === '課税8%') return { tax: Math.floor(amount * 8 / 108),  freeeKbn: '課対仕入8%軽減', yayoiKbn: '課対仕入8%', mfcKbn: '課税仕入8%(軽)' };
    if (r === '非課税')  return { tax: 0, freeeKbn: '非課税仕入',    yayoiKbn: '非課税',           mfcKbn: '非課税仕入' };
    if (r === '不課税')  return { tax: 0, freeeKbn: '対象外',        yayoiKbn: '対象外',           mfcKbn: '対象外' };
    // 課税10%・混在はどちらも10%で処理
    return { tax: Math.floor(amount * 10 / 110), freeeKbn: '課対仕入10%', yayoiKbn: '課対仕入10%', mfcKbn: '課税仕入10%' };
  }

  function _exportFreee(el) {
    const filtered = _getFiltered(el);
    const _isoToSlash = s => s ? String(s).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$1/$2/$3') : '';
    const header = ['発生日','勘定科目','税区分','金額(税込)','税額','摘要','支払方法','申請者','備考'];
    const rows = [];
    filtered.forEach(e => {
      const totalAmt = Number(e.amount) || 0;
      const corpSrc  = _corpPaySource(e);
      const payMethod = corpSrc ? corpSrc : `個人（${App.getMemberName(e.email, e.name)}）`;
      const splitParts = App.parseSplitCategory(e.category);
      const isSplit = splitParts.length > 1 && splitParts.every(p => p.amount !== null);
      if (isSplit) {
        splitParts.forEach(p => {
          const { tax, freeeKbn } = _taxInfo(p.amount, p.taxRate || _effectiveTaxRate(e));
          rows.push([_isoToSlash(e.date), p.cat, freeeKbn, p.amount, tax,
            e.place, payMethod, App.getMemberName(e.email, e.name), e.note]);
        });
      } else {
        const { tax, freeeKbn } = _taxInfo(totalAmt, _effectiveTaxRate(e));
        rows.push([_isoToSlash(e.date), App.categoryLabel(e.category), freeeKbn, totalAmt, tax,
          e.place, payMethod, App.getMemberName(e.email, e.name), e.note]);
      }
      const wh = Number(e.withholding) || 0;
      if (wh > 0) {
        rows.push([_isoToSlash(e.date), '預り金', '対象外', -wh, 0,
          `${e.place}（源泉徴収）`, payMethod, App.getMemberName(e.email, e.name), '']);
      }
    });
    const csv = [header, ...rows].map(r =>
      r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    _downloadCsv(csv, `freee経費_${new Date().toISOString().split('T')[0]}.csv`);
  }

  function _exportYayoi(el) {
    const filtered = _getFiltered(el);
    const _isoToSlash = s => s ? String(s).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$1/$2/$3') : '';
    const header = ['伝票No.','決算','取引日','借方勘定科目','借方補助科目','借方税区分','借方金額','借方消費税額','貸方勘定科目','貸方補助科目','貸方税区分','貸方金額','貸方消費税額','摘要','番号'];
    const rows = [];
    let slipNo = 0;
    filtered.forEach(e => {
      slipNo++;
      const totalAmt  = Number(e.amount) || 0;
      const corpSrc   = _corpPaySource(e);
      const creditSub = corpSrc ? corpSrc : `個人（${App.getMemberName(e.email, e.name)}）`;
      const summary   = `${e.place}${e.note ? ' ' + e.note : ''}`;
      const wh = Number(e.withholding) || 0;
      const splitParts = App.parseSplitCategory(e.category);
      const isSplit = splitParts.length > 1 && splitParts.every(p => p.amount !== null);
      if (isSplit) {
        splitParts.forEach((p, i) => {
          const { tax, yayoiKbn } = _taxInfo(p.amount, p.taxRate || _effectiveTaxRate(e));
          const payAmt = i === 0 && wh > 0 ? p.amount - wh : p.amount;
          rows.push([slipNo, '', _isoToSlash(e.date),
            p.cat, '', yayoiKbn, p.amount, tax,
            '未払金', creditSub, '', payAmt, '',
            summary, e.id]);
        });
        if (wh > 0) rows.push([slipNo, '', _isoToSlash(e.date), '', '', '', '', '',
          '預り金', '源泉徴収', '', wh, '', `${e.place}（源泉徴収）`, e.id]);
      } else {
        const { tax, yayoiKbn } = _taxInfo(totalAmt, _effectiveTaxRate(e));
        if (wh > 0) {
          const payAmt = totalAmt - wh;
          rows.push([slipNo, '', _isoToSlash(e.date),
            App.categoryLabel(e.category), '', yayoiKbn, totalAmt, tax,
            '未払金', creditSub, '', payAmt, '', summary, e.id]);
          rows.push([slipNo, '', _isoToSlash(e.date), '', '', '', '', '',
            '預り金', '源泉徴収', '', wh, '', `${e.place}（源泉徴収）`, e.id]);
        } else {
          rows.push([slipNo, '', _isoToSlash(e.date),
            App.categoryLabel(e.category), '', yayoiKbn, totalAmt, tax,
            '未払金', creditSub, '', totalAmt, '', summary, e.id]);
        }
      }
    });
    const csv = [header, ...rows].map(r =>
      r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    _downloadCsv(csv, `弥生仕訳_${new Date().toISOString().split('T')[0]}.csv`);
  }

  function _exportMfc(el) {
    const filtered = _getFiltered(el);
    const _isoToSlash = s => s ? String(s).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$1/$2/$3') : '';
    const header = ['取引日','借方勘定科目','借方補助科目','借方税区分','借方金額','貸方勘定科目','貸方補助科目','貸方税区分','貸方金額','摘要','メモ'];
    const rows = [];
    filtered.forEach(e => {
      const totalAmt  = Number(e.amount) || 0;
      const corpSrc   = _corpPaySource(e);
      const creditSub = corpSrc ? corpSrc : `個人（${App.getMemberName(e.email, e.name)}）`;
      const summary   = `${e.place}${e.note ? ' ' + e.note : ''}`;
      const wh = Number(e.withholding) || 0;
      const splitParts = App.parseSplitCategory(e.category);
      const isSplit = splitParts.length > 1 && splitParts.every(p => p.amount !== null);
      if (isSplit) {
        splitParts.forEach((p, i) => {
          const { mfcKbn } = _taxInfo(p.amount, p.taxRate || _effectiveTaxRate(e));
          const payAmt = i === 0 && wh > 0 ? p.amount - wh : p.amount;
          rows.push([_isoToSlash(e.date),
            p.cat, '', mfcKbn, p.amount,
            '未払金', creditSub, '', payAmt,
            summary, e.id]);
        });
        if (wh > 0) rows.push([_isoToSlash(e.date),
          '未払金', creditSub, '', wh,
          '預り金', '源泉徴収', '', wh,
          `${e.place}（源泉徴収）`, e.id]);
      } else {
        const { mfcKbn } = _taxInfo(totalAmt, _effectiveTaxRate(e));
        if (wh > 0) {
          const payAmt = totalAmt - wh;
          rows.push([_isoToSlash(e.date),
            App.categoryLabel(e.category), '', mfcKbn, totalAmt,
            '未払金', creditSub, '', payAmt, summary, e.id]);
          rows.push([_isoToSlash(e.date),
            '未払金', creditSub, '', wh,
            '預り金', '源泉徴収', '', wh,
            `${e.place}（源泉徴収）`, e.id]);
        } else {
          rows.push([_isoToSlash(e.date),
            App.categoryLabel(e.category), '', mfcKbn, totalAmt,
            '未払金', creditSub, '', totalAmt, summary, e.id]);
        }
      }
    });
    const csv = [header, ...rows].map(r =>
      r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');
    _downloadCsv(csv, `MFクラウド仕訳_${new Date().toISOString().split('T')[0]}.csv`);
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // summary.js のドリルダウンから呼び出せる承認関数（UI更新なし）
  async function approveExpense(id) {
    if (Sheets.useProxy && Sheets.useProxy()) {
      await Sheets.approveExpense(id);
    } else {
      const rowNum = await Sheets.findRowById(id);
      if (rowNum < 0) throw new Error('行が見つかりません');
      await Sheets.update(`経費一覧!J${rowNum}`, [[true]]);
    }
    const e = _expenses.find(x => x.id === id);
    if (e) e.confirmed = true;
  }

  // summary.js のドリルダウンから呼び出せる削除関数（UI更新なし）
  async function deleteExpense(id) {
    if (Sheets.useProxy && Sheets.useProxy()) {
      await Sheets.deleteExpense(id);
    } else {
      const e = _expenses.find(x => x.id === id);
      if (!e) throw new Error('レコードが見つかりません');
      const ssId = localStorage.getItem('keihi_sheet_id');
      const timeResp = await fetch('/api/time');
      const deletedAt = timeResp.ok
        ? (await timeResp.json()).jst
        : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      await Sheets.prependRow('削除一覧', [deletedAt, Auth.getUserEmail(), ...Sheets.expenseToRow(e)], ssId);
      const rowIndex = await Sheets.findRowById(id, ssId);
      if (rowIndex > 0) await Sheets.deleteRow('経費一覧', rowIndex, ssId);
    }
    _expenses = _expenses.filter(x => x.id !== id);
  }

  // ── 証票ビューア ──────────────────────────────────────────────────────────────
  (function _initReceiptViewer() {
    const viewer   = document.getElementById('receiptViewer');
    const img      = document.getElementById('receiptViewerImg');
    const pdfWrap  = document.getElementById('receiptViewerPdf');
    const pdfLink  = document.getElementById('receiptViewerPdfLink');
    const closeBtn  = document.getElementById('receiptViewerClose');
    const navBar    = document.getElementById('receiptViewerNav');
    const prevBtn   = document.getElementById('receiptViewerPrev');
    const nextBtn   = document.getElementById('receiptViewerNext');
    const pageEl    = document.getElementById('receiptViewerPage');
    const errWrap   = document.getElementById('receiptViewerError');
    const errLink   = document.getElementById('receiptViewerErrorLink');
    if (!viewer) return;

    let _urls = [], _cur = 0;
    let _historyPushed = false;

    function _show(urls, idx) {
      _urls = urls; _cur = idx;
      _pzReset();
      const url = urls[_cur];
      const isPdf = url.toLowerCase().includes('pdf') || url.includes('application%2Fpdf');
      img.style.display = isPdf ? 'none' : 'block';
      pdfWrap.style.display = isPdf ? 'block' : 'none';
      if (errWrap) errWrap.style.display = 'none';
      if (isPdf) { pdfLink.href = url; }
      else { img.src = url; }
      navBar.style.display = urls.length > 1 ? 'block' : 'none';
      if (pageEl) pageEl.textContent = `${_cur + 1} / ${urls.length}`;
      viewer.style.display = 'block';
      document.body.style.overflow = 'hidden';
      // Androidバックジェスチャーでポップアップを閉じるためのダミー履歴エントリ
      if (!_historyPushed) {
        history.pushState({ receiptViewer: true }, '');
        _historyPushed = true;
      }
    }

    function _close() {
      _pzReset();
      viewer.style.display = 'none';
      img.src = '';
      if (errWrap) errWrap.style.display = 'none';
      document.body.style.overflow = '';
      // ダミー履歴エントリを除去（バックで閉じた場合は既にpopstateで除去済みなのでスキップ）
      if (_historyPushed) {
        _historyPushed = false;
        history.back();
      }
    }

    // Androidバックジェスチャー / ブラウザ戻るボタン → ポップアップを閉じる
    window.addEventListener('popstate', e => {
      if (viewer.style.display !== 'none') {
        window.__keihiReceiptViewerCloseTs = Date.now(); // 編集popstateとの競合回避用
        _historyPushed = false;
        _pzReset();
        viewer.style.display = 'none';
        img.src = '';
        if (errWrap) errWrap.style.display = 'none';
        document.body.style.overflow = '';
      }
    });

    img.addEventListener('error', () => {
      if (viewer.style.display === 'none') return;
      img.style.display = 'none';
      if (errWrap) {
        errWrap.style.display = 'block';
        if (errLink) {
          const u = _urls[_cur] || '';
          const m = u.match(/[?&]fileId=([a-zA-Z0-9_-]+)/);
          errLink.href = m ? `https://drive.google.com/file/d/${m[1]}/view` : u || '#';
        }
      }
    });

    closeBtn?.addEventListener('click', _close);
    viewer.addEventListener('click', e => { if (e.target === viewer) _close(); });
    prevBtn?.addEventListener('click', () => _show(_urls, (_cur - 1 + _urls.length) % _urls.length));
    nextBtn?.addEventListener('click', () => _show(_urls, (_cur + 1) % _urls.length));
    document.addEventListener('keydown', e => { if (viewer.style.display !== 'none' && e.key === 'Escape') _close(); });

    // ピンチズーム（タッチデバイス向け）
    let _pz = { scale: 1, baseSc: 1, dist: 0 };
    function _pzReset() { _pz.scale = 1; img.style.transform = ''; img.style.transformOrigin = ''; }
    const innerEl = document.getElementById('receiptViewerInner');
    if (innerEl) {
      innerEl.addEventListener('touchstart', e => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        _pz.dist   = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        _pz.baseSc = _pz.scale;
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const rect = img.getBoundingClientRect();
        img.style.transformOrigin = `${((mx - rect.left) / rect.width * 100).toFixed(1)}% ${((my - rect.top) / rect.height * 100).toFixed(1)}%`;
      }, { passive: false });
      innerEl.addEventListener('touchmove', e => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        _pz.scale = Math.max(1, Math.min(6, _pz.baseSc * d / _pz.dist));
        img.style.transform = `scale(${_pz.scale})`;
      }, { passive: false });
      innerEl.addEventListener('touchend', () => { if (_pz.scale < 1.05) _pzReset(); }, { passive: true });
    }

    // 証票ボタンへのイベント委任（動的に生成される行に対応）
    document.addEventListener('click', e => {
      const btn = e.target.closest('.btn-receipt-view');
      if (!btn) return;
      e.preventDefault();
      try {
        const urls = JSON.parse(btn.dataset.urls || '[]');
        const idx  = parseInt(btn.dataset.idx || '0', 10);
        if (urls.length) _show(urls, idx);
      } catch (_) {}
    });
  })();

  return { render, bindEvents, approveExpense, deleteExpense };
})();
