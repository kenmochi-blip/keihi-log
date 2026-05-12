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

  function render() {
    const { fromYM, toYM } = _defaultRange();
    return `
<div class="pt-3">
  <div class="d-flex justify-content-between align-items-center mb-3">
    <h5 class="fw-bold mb-0"><i class="bi bi-list-ul me-2 text-primary"></i>一覧表</h5>
    <div class="d-flex gap-2">
      <button class="btn btn-outline-secondary btn-sm no-print" id="btnExportCsv">
        <i class="bi bi-download me-1"></i>CSV
      </button>
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
      <!-- タイプ・承認状態・申請者・キーワード（横4列） -->
      <div class="row g-2">
        <div class="col-6 col-md-3">
          <select class="form-select form-select-sm" id="filterType">
            <option value="">タイプ（全て）</option>
            <option>領収書</option><option>領収書なし</option>
            <option>交通費</option><option>自家用車</option>
          </select>
        </div>
        <div class="col-6 col-md-3">
          <select class="form-select form-select-sm" id="filterStatus">
          <option value="">ステータス（全て）</option>
            <option value="申請済">申請済</option>
            <option value="登録済">登録済</option>
            <option value="精算済">精算済</option>
          </select>
        </div>
        <div class="col-6 col-md-3" id="filterMemberWrap" style="display:none;">
          <select class="form-select form-select-sm" id="filterMember">
            <option value="">申請者（全員）</option>
          </select>
        </div>
        <div class="col-6 col-md-3">
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
    <div class="d-flex align-items-center gap-2">
      <span class="text-muted small" id="lblCount">読み込み中...</span>
      <span class="text-muted" style="font-size:0.72rem;">🏢 = 会社直接支払</span>
    </div>
    <span class="fw-bold" id="lblFilterTotal"></span>
  </div>

  <!-- PC テーブル（lg以上） -->
  <div class="d-none d-lg-block table-responsive">
    <table class="table table-hover list-table list-table-pc">
      <thead class="table-light">
        <tr>
          <th class="text-center">日付</th>
          <th class="text-center">支払先</th>
          <th class="text-center">タイプ</th>
          <th class="text-center">金額</th>
          <th class="text-center">科目</th>
          <th class="text-center">備考</th>
          <th class="text-center">状態</th>
          <th class="text-center">精算日</th>
          <th class="no-print text-center">操作</th>
        </tr>
      </thead>
      <tbody id="listTbodyPc">
        <tr><td colspan="8" class="text-center text-muted py-3">読み込み中...</td></tr>
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

  <!-- スプレッドシートリンク（管理者のみ） -->
  <div id="sheetLinkArea" class="mt-3 d-none no-print">
    <a id="sheetDirectLink" href="#" target="_blank" class="btn btn-outline-secondary btn-sm w-100">
      <i class="bi bi-table me-1"></i>スプレッドシートで開く（会計ソフト連携・詳細編集）
    </a>
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

  async function bindEvents(el) {
    // PC では幅制限を解除してゆったり表示
    const main = document.getElementById('appMain');
    if (main) main.style.maxWidth = '';

    try {
      _master   = await App.getMaster();
      _userRole = App.getUserRole();
      _isAdmin  = _userRole === 'admin';
      _showAll  = _userRole === 'admin' || _userRole === 'viewer';
      _expenses = await Sheets.readExpenses();
    } catch (err) {
      el.querySelector('#listTbodyPc').innerHTML = `<tr><td colspan="8" class="text-danger text-center">${err.message}</td></tr>`;
      el.querySelector('#listCardsSp').innerHTML = `<div class="text-danger text-center py-3">${err.message}</div>`;
      return;
    }

    // 管理者・閲覧者：メンバー選択ボックスを表示
    if (_isAdmin || _userRole === 'viewer') {
      el.querySelector('#filterMemberWrap').style.display = '';
      const sel = el.querySelector('#filterMember');
      _master.members.forEach(m => {
        sel.innerHTML += `<option value="${m.email}">${m.name}</option>`;
      });
    }
    // スプレッドシートリンク（管理者のみ）
    if (_isAdmin) {
      const ssId = localStorage.getItem('keihi_sheet_id');
      if (ssId) {
        el.querySelector('#sheetLinkArea').classList.remove('d-none');
        el.querySelector('#sheetDirectLink').href = `https://docs.google.com/spreadsheets/d/${ssId}`;
      }
    }

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
    const _reset = () => { _shownCount = 50; _renderTable(el); };
    el.querySelector('#filterMonthFrom')?.addEventListener('change', _reset);
    el.querySelector('#filterMonthTo')?.addEventListener('change', _reset);

    // フィルタリング
    ['filterType','filterStatus','filterKeyword','filterMember'].forEach(id => {
      el.querySelector(`#${id}`)?.addEventListener('input', _reset);
    });

    el.querySelector('#btnRefreshList')?.addEventListener('click', async () => {
      try {
        _expenses = await Sheets.readExpenses();
        _renderTable(el);
        App.showToast('更新しました', 'success');
      } catch (err) {
        App.showToast(err.message, 'danger');
      }
    });

    el.querySelector('#btnExportCsv')?.addEventListener('click', () => _exportCsv(el));

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
    const keyword = (el.querySelector('#filterKeyword')?.value || '').toLowerCase();
    const member  = el.querySelector('#filterMember')?.value   || '';
    const email   = Auth.getUserEmail();

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
      if (keyword && ![e.place, e.note, e.category].join(' ').toLowerCase().includes(keyword)) return false;
      return true;
    }).sort((a, b) => {
      // 申請日時（新しい順）→ 日付（新しい順）の優先順でソート
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
      tbodyPc.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-3">該当する申請がありません</td></tr>';
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
      const statusBadge = _statusBadge(status);
      // 編集可否：精算済は全員不可、申請済は本人のみ、登録済は管理者本人のみ
      const canEdit = status !== '精算済' && e.email === email &&
        (status === '申請済' || (_isAdmin && status === '登録済'));
      // 承認ボタン（申請済→登録済）：管理者のみ
      const approveBtn = _isAdmin && status === '申請済'
        ? `<button class="btn btn-outline-success btn-sm py-0 px-1 btn-approve" data-id="${e.id}" title="登録済にする"><i class="bi bi-check"></i></button>` : '';
      const editBtn = canEdit
        ? `<button class="btn btn-outline-secondary btn-sm py-0 px-1 btn-edit-list" data-id="${e.id}"><i class="bi bi-pencil"></i></button>` : '';
      const ops = `<div class="d-flex gap-1">${approveBtn}${editBtn}</div>`;

      // 証票リンク（複数対応）
      const imgUrls = e.imageLinks ? e.imageLinks.split(',').map(s => s.trim()).filter(Boolean) : [];
      const receiptBtns = imgUrls.map((url, i) =>
        `<a href="${url}" target="_blank" class="btn btn-outline-primary btn-sm py-0 px-2">
           <i class="bi bi-image me-1"></i>${imgUrls.length > 1 ? `証票${i + 1}` : '証票'}
         </a>`
      ).join('');

      // PC行（8列）+ 金額クリックで開く詳細行
      const hasDetail = e.note || imgUrls.length > 0;
      rowsPc.push(`<tr>
        <td class="list-date">${e.date}</td>
        <td class="list-place">
          <div>${e.settlementDate?.startsWith('会社払い') ? '🏢 ' : ''}${_escape(e.place)}</div>
          <div class="text-muted" style="font-size:0.7rem;">${_escape(e.name)}</div>
        </td>
        <td class="list-type-cell">${_escape(e.type)}</td>
        <td class="text-end list-amount${hasDetail ? ' list-amount-toggle' : ''}" data-detail="${e.id}"
          ${hasDetail ? `title="クリックして備考・証票を表示"` : ''}>
          ¥${e.amount.toLocaleString()}
        </td>
        <td class="list-cat">${_escape(e.category)}</td>
        <td class="list-note-cell text-muted">${_escape(e.note || '')}</td>
        <td>${statusBadge}</td>
        <td class="text-center" style="font-size:0.75rem;white-space:nowrap;">${_escape(e.settlementDate || '')}</td>
        <td class="no-print">${ops}</td>
      </tr>
      ${hasDetail ? `<tr class="list-detail-row d-none" data-detail-row="${e.id}">
        <td colspan="9" class="px-3 py-2">
          ${e.note ? `<div class="text-muted mb-1"><i class="bi bi-chat-text me-1 text-secondary"></i>${_escape(e.note)}</div>` : ''}
          ${receiptBtns ? `<div class="d-flex flex-wrap gap-1">${receiptBtns}</div>` : ''}
        </td>
      </tr>` : ''}`);

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
              <div class="list-sp-name">${_escape(e.name)}</div>
            </div>
            <div class="list-sp-amount flex-shrink-0${hasExtra ? ' expandable' : ''}">
              ¥${e.amount.toLocaleString()}
              ${hasExtra ? '<i class="bi bi-chevron-down chevron"></i>' : ''}
            </div>
          </div>
          <div class="d-flex justify-content-between align-items-center mt-1 gap-2">
            <div class="d-flex align-items-center gap-1 flex-wrap" style="min-width:0;">
              ${statusBadge}
              <span class="list-sp-cat">${_escape(e.category)}</span>
              ${e.note ? `<span class="list-sp-note">${_escape(e.note)}</span>` : ''}
            </div>
            <div class="no-print flex-shrink-0">${ops}</div>
          </div>
          ${hasExtra ? `
          <div class="list-sp-extra d-none">
            ${e.note ? `<div class="list-sp-extra-note"><i class="bi bi-chat-text me-1 text-secondary"></i>${_escape(e.note)}</div>` : ''}
            ${receiptBtns ? `<div class="d-flex flex-wrap gap-1">${receiptBtns}</div>` : ''}
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
          SubmitView.queueEdit(btn.dataset.id, _expenses);
          Router.navigate('submit');
        });
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

    // SP：金額タップで詳細エリアトグル
    cardsSp.querySelectorAll('.list-sp-amount.expandable').forEach(amountEl => {
      amountEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const card  = amountEl.closest('.list-sp-card');
        const extra = card?.querySelector('.list-sp-extra');
        if (!extra) return;
        const opening = extra.classList.contains('d-none');
        extra.classList.toggle('d-none', !opening);
        amountEl.classList.toggle('open', opening);
      });
    });
  }

  function _fmtDateShort(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    return `${Number(parts[1])}/${Number(parts[2])}`;
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
      const rowNum = await Sheets.findRowById(id);
      if (rowNum < 0) throw new Error('行が見つかりません');
      await Sheets.update(`経費一覧!J${rowNum}`, [[true]]);
      const e = _expenses.find(x => x.id === id);
      if (e) e.confirmed = true;
      _renderTable(el);
      App.showToast('登録済にしました', 'success');
    } catch (err) {
      App.showToast('承認エラー: ' + err.message, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _getStatus(e) {
    if (e.settlementDate) return '精算済';
    if (e.confirmed)      return '登録済';
    return '申請済';
  }

  function _statusBadge(status) {
    if (status === '精算済') return `<span class="badge" style="background:#6c757d;font-size:0.65rem;">精算済</span>`;
    if (status === '登録済') return `<span class="badge badge-confirmed" style="font-size:0.65rem;">登録済</span>`;
    return `<span class="badge badge-pending" style="font-size:0.65rem;">申請済</span>`;
  }

  function _exportCsv(el) {
    const filtered = _getFiltered(el);
    const header = ['申請日時','申請者名','タイプ','日付','支払先','金額','勘定科目','備考','証票URL','ステータス','インボイス番号','申請者Email','ID','精算日'];
    const _isoToSlash = s => s ? String(s).replace(/^(\d{4})-(\d{2})-(\d{2}).*/, '$1/$2/$3') : '';
    const rows = filtered.map(e => [
      _isoToSlash(e.appliedAt), e.name, e.type, _isoToSlash(e.date), e.place, e.amount,
      e.category, e.note, e.imageLinks.split(',')[0]?.trim() || '',
      _getStatus(e), e.invoice, e.email, e.id,
      e.settlementDate || ''
    ]);
    const csv = [header, ...rows].map(r =>
      r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const bom = '﻿'; // Excel用BOM
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `経費一覧_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return { render, bindEvents };
})();
