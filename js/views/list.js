/**
 * 一覧表ビュー
 * 経費一覧シートのデータをWebページで表示する（新規機能）
 * 管理者：全メンバー分表示・承認操作可
 * 一般：自分の分のみ表示
 */
const ListView = (() => {

  let _expenses = [];
  let _master   = null;
  let _isAdmin  = false;
  let _showAll  = false;

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
      <!-- タイプ・状態・キーワード -->
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
            <option value="">承認状態（全て）</option>
            <option value="confirmed">承認済</option>
            <option value="pending">未確認</option>
          </select>
        </div>
        <div class="col-12 col-md-6">
          <div class="input-group input-group-sm">
            <span class="input-group-text"><i class="bi bi-search"></i></span>
            <input type="text" class="form-control" id="filterKeyword" placeholder="支払先・備考・勘定科目で検索">
          </div>
        </div>
        <div class="col-6 col-md-3" id="filterMemberWrap" style="display:none;">
          <select class="form-select form-select-sm" id="filterMember">
            <option value="">申請者（全員）</option>
          </select>
        </div>
        <div class="col-6 col-md-3 d-flex align-items-center gap-2" id="adminToggleWrap" style="display:none;">
          <div class="form-check form-switch mb-0">
            <input class="form-check-input" type="checkbox" id="chkShowAll">
            <label class="form-check-label small" for="chkShowAll">全員分表示</label>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 合計表示 -->
  <div class="d-flex justify-content-between align-items-center mb-2">
    <span class="text-muted small" id="lblCount">読み込み中...</span>
    <span class="fw-bold" id="lblFilterTotal"></span>
  </div>

  <!-- テーブル -->
  <div class="table-responsive">
    <table class="table table-hover list-table">
      <thead class="table-light">
        <tr>
          <th class="text-center">日付</th>
          <th class="text-center">支払先</th>
          <th class="d-none d-md-table-cell text-center">タイプ</th>
          <th class="text-center">金額</th>
          <th class="text-center">科目</th>
          <th class="d-none d-md-table-cell text-center">備考</th>
          <th class="text-center">状態</th>
          <th class="no-print text-center">操作</th>
        </tr>
      </thead>
      <tbody id="listTableBody">
        <tr><td colspan="8" class="text-center text-muted py-3">読み込み中...</td></tr>
      </tbody>
    </table>
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
      _master  = await App.getMaster();
      _isAdmin = App.isAdmin();
      _expenses = await Sheets.readExpenses();
    } catch (err) {
      el.querySelector('#listTableBody').innerHTML =
        `<tr><td colspan="8" class="text-danger text-center">${err.message}</td></tr>`;
      return;
    }

    // 管理者用UI
    if (_isAdmin) {
      el.querySelector('#adminToggleWrap').style.display = '';
      el.querySelector('#filterMemberWrap').style.display = '';
      const sel = el.querySelector('#filterMember');
      _master.members.forEach(m => {
        sel.innerHTML += `<option value="${m.email}">${m.name}</option>`;
      });
      // スプレッドシートリンク
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
        _renderTable(el);
      });
    });
    el.querySelector('#filterMonthFrom')?.addEventListener('change', () => _renderTable(el));
    el.querySelector('#filterMonthTo')?.addEventListener('change', () => _renderTable(el));

    // フィルタリング
    ['filterType','filterStatus','filterKeyword','filterMember'].forEach(id => {
      el.querySelector(`#${id}`)?.addEventListener('input', () => _renderTable(el));
    });
    el.querySelector('#chkShowAll')?.addEventListener('change', e => {
      _showAll = e.target.checked;
      el.querySelector('#filterMemberWrap').style.display = _showAll ? '' : 'none';
      _renderTable(el);
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
    requestAnimationFrame(() => _initResizableColumns(el.querySelector('.list-table')));
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
      // 表示対象
      if (!_isAdmin || !_showAll) {
        if (e.email !== email) return false;
      } else if (member && e.email !== member) return false;

      if (fromDate && e.date < fromDate) return false;
      if (toDate   && e.date > toDate)   return false;
      if (type && e.type !== type) return false;
      if (status === 'confirmed' && !e.confirmed)  return false;
      if (status === 'pending'   &&  e.confirmed)  return false;
      if (keyword && ![e.place, e.note, e.category].join(' ').toLowerCase().includes(keyword)) return false;
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));
  }

  function _renderTable(el) {
    const filtered = _getFiltered(el);
    const total = filtered.reduce((s, e) => s + e.amount, 0);
    el.querySelector('#lblCount').textContent = `${filtered.length}件`;
    el.querySelector('#lblFilterTotal').textContent = filtered.length > 0
      ? `合計 ¥${total.toLocaleString()}` : '';

    const tbody = el.querySelector('#listTableBody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-3">該当する申請がありません</td></tr>';
      return;
    }
    const email = Auth.getUserEmail();
    tbody.innerHTML = filtered.map(e => {
      const statusBadge = e.confirmed
        ? `<span class="badge badge-confirmed" style="font-size:0.65rem;">承認済</span>`
        : `<span class="badge badge-pending" style="font-size:0.65rem;">未確認</span>`;

      const canEdit = !e.confirmed && e.email === email;
      const imageBtn = e.imageLinks
        ? `<a href="${e.imageLinks.split(',')[0].trim()}" target="_blank" class="btn btn-outline-primary btn-sm py-0">
            <i class="bi bi-image"></i></a>` : '';

      const approveBtn = _isAdmin && !e.confirmed
        ? `<button class="btn btn-outline-success btn-sm py-0 btn-approve" data-id="${e.id}">
            <i class="bi bi-check"></i></button>` : '';

      const editBtn = canEdit
        ? `<button class="btn btn-outline-secondary btn-sm py-0 btn-edit-list" data-id="${e.id}">
            <i class="bi bi-pencil"></i></button>` : '';

      const applicantSub = `<div class="text-muted" style="font-size:0.7rem;">${_escape(e.name)}</div>`;

      return `<tr>
        <td class="list-date">${e.date}</td>
        <td class="list-place">
          <div>${_escape(e.place)}</div>
          ${applicantSub}
        </td>
        <td class="d-none d-md-table-cell list-type-cell">${_escape(e.type)}</td>
        <td class="text-end list-amount">¥${e.amount.toLocaleString()}</td>
        <td class="list-cat">${_escape(e.category)}</td>
        <td class="d-none d-md-table-cell list-note-cell text-muted">${_escape(e.note || '')}</td>
        <td>${statusBadge}</td>
        <td class="no-print">
          <div class="d-flex gap-1">${imageBtn}${approveBtn}${editBtn}</div>
        </td>
      </tr>`;
    }).join('');

    // 承認ボタンのイベント
    tbody.querySelectorAll('.btn-approve').forEach(btn => {
      btn.addEventListener('click', () => _approveExpense(btn.dataset.id, el));
    });

    // 編集ボタン：申請タブへ遷移して編集モードを起動
    tbody.querySelectorAll('.btn-edit-list').forEach(btn => {
      btn.addEventListener('click', () => {
        SubmitView.queueEdit(btn.dataset.id, _expenses);
        Router.navigate('submit');
      });
    });
  }

  async function _approveExpense(id, el) {
    const ok = await App.confirm('この申請を承認しますか？');
    if (!ok) return;
    App.showLoading('承認中...');
    try {
      const rowNum = await Sheets.findRowById(id);
      if (rowNum < 0) throw new Error('行が見つかりません');
      await Sheets.update(`経費一覧!J${rowNum}`, [[true]]);
      const e = _expenses.find(x => x.id === id);
      if (e) e.confirmed = true;
      _renderTable(el);
      App.showToast('承認しました', 'success');
    } catch (err) {
      App.showToast('承認エラー: ' + err.message, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _exportCsv(el) {
    const filtered = _getFiltered(el);
    const header = ['申請日時','申請者名','タイプ','日付','支払先','金額','勘定科目','備考','証票URL','承認状態','インボイス番号','申請者Email','ID'];
    const rows = filtered.map(e => [
      e.appliedAt, e.name, e.type, e.date, e.place, e.amount,
      e.category, e.note, e.imageLinks.split(',')[0]?.trim() || '',
      e.confirmed ? '承認済' : '未確認', e.invoice, e.email, e.id
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
