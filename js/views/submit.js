/**
 * 申請フォームビュー
 * 既存GASアプリの index.html をSPA用に移植
 * 電帳法対応：申請日時はサーバー時刻を使用、画像ハッシュはSHA-256
 */
const SubmitView = (() => {

  // フォーム状態
  let _selectedFiles = []; // [{base64, mimeType, name}]
  let _existingUrls  = []; // 編集時の既存証票URL
  let _existingHash  = '';
  let _editId        = null;
  let _currentType   = '領収書';
  let _cats          = [];
  let _paySources    = [];
  let _pendingEdit   = null; // 一覧表からの編集キュー {id, expenses}

  const TYPES = ['領収書', '領収書なし', '交通費', '自家用車'];
  const CAR_RATE_KEY = 'keihi_car_rate';
  let _transitMode = '電車・バス'; // 電車・バス / 高速

  function render() {
    return `
<div class="pt-3">

  <!-- 編集モードバナー -->
  <div id="editBanner" class="edit-banner d-none mb-3">
    <i class="bi bi-pencil-square me-1"></i>修正モード
    <button class="btn btn-link btn-sm text-muted p-0 ms-2" id="btnCancelEdit">キャンセル</button>
  </div>

  <!-- タイプ選択 2×2グリッド -->
  <div class="type-grid mb-3">
    <button class="type-card active" data-type="領収書">
      <i class="bi bi-camera-fill"></i>領収書
    </button>
    <button class="type-card" data-type="領収書なし">
      <i class="bi bi-pencil-square"></i>領収書なし
    </button>
    <button class="type-card" data-type="交通費">
      <i class="bi bi-train-front-fill"></i>電車/バス
    </button>
    <button class="type-card" data-type="自家用車">
      <i class="bi bi-car-front-fill"></i>自家用車
    </button>
  </div>

  <!-- 会社払いトグル -->
  <div class="card mb-3 border-0 shadow-sm">
    <div class="card-body py-2">
      <div class="form-check form-switch d-flex align-items-center gap-2 mb-0">
        <input class="form-check-input" type="checkbox" id="chkCorpPay" style="width:2.5rem;height:1.3rem;">
        <label class="form-check-label fw-semibold" for="chkCorpPay">会社払い（立替精算なし）</label>
      </div>
      <div id="corpPayDetails" class="d-none mt-2">
        <select class="form-select form-select-sm" id="selPaySource">
          <option value="">支払元を選択</option>
        </select>
      </div>
    </div>
  </div>

  <!-- 領収書：カメラ/ファイル → プレビュー → AI → フォーム -->
  <div id="panel-領収書">
    <input type="file" class="d-none" id="camInput-領収書" accept="image/*" capture="environment">
    <input type="file" class="d-none" id="fileInput-領収書" accept="*/*" multiple>
    <div class="upload-grid mb-3">
      <button class="upload-card" id="btnCamera-領収書">
        <i class="bi bi-camera-fill"></i>カメラ
      </button>
      <button class="upload-card" id="btnFile-領収書">
        <i class="bi bi-folder-fill"></i>ファイル
      </button>
    </div>
    <div id="previewArea-領収書" class="d-flex flex-wrap gap-2 mb-3"></div>
    <button class="btn btn-primary w-100 mb-2" id="btnAnalyze">
      <i class="bi bi-stars me-2"></i>AIで読み取る
    </button>
    <div class="text-center mb-3">
      <button class="btn btn-link btn-sm text-decoration-none text-muted" id="btnManualInput">
        手動で入力する
      </button>
    </div>
    <div id="receiptFields" class="d-none">
      ${_dateField()}
      ${_placeField('支払先（店名・会社名）')}
      ${_invoiceField()}
      ${_amountSection()}
      ${_noteField()}
    </div>
  </div>

  <!-- 領収書なし -->
  <div id="panel-領収書なし" class="d-none">
    ${_dateField()}
    ${_placeField('支払先・目的')}
    ${_amountSection()}
    <div class="mb-2">
      <label class="form-label small fw-semibold">理由・詳細 <span class="text-danger">*</span></label>
      <textarea class="form-control form-control-sm" id="txtReason" rows="3"
        placeholder="領収書がない理由を具体的に記入してください"></textarea>
    </div>
    <div class="mb-2">
      <label class="form-label small fw-semibold">参考資料（任意）</label>
      <div class="d-flex flex-wrap gap-2 mb-2" id="previewArea-領収書なし"></div>
      <input type="file" class="d-none" id="fileInput-領収書なし" accept="*/*" multiple>
      <button class="btn btn-outline-secondary btn-sm" id="btnFile-領収書なし">
        <i class="bi bi-folder2-open me-1"></i>ファイル選択
      </button>
    </div>
  </div>

  <!-- 交通費 -->
  <div id="panel-交通費" class="d-none">
    ${_dateField()}
    <!-- サブタイプ選択 -->
    <div class="btn-group btn-group-sm w-100 mb-2" id="transitModeGroup">
      <button class="btn btn-secondary" data-mode="電車・バス">
        <i class="bi bi-train-front-fill me-1"></i>電車・バス
      </button>
      <button class="btn btn-outline-secondary" data-mode="高速">
        <i class="bi bi-car-front-fill me-1"></i>高速
      </button>
    </div>
    <div class="row g-2 mb-2">
      <div class="col-6">
        <label class="form-label small fw-semibold">出発駅・バス停</label>
        <input type="text" class="form-control form-control-sm" id="txtFrom" placeholder="例：渋谷 / 聖母病院入口/都営バス">
      </div>
      <div class="col-6">
        <label class="form-label small fw-semibold">到着駅・バス停</label>
        <input type="text" class="form-control form-control-sm" id="txtTo" placeholder="例：新宿 / 飯田橋/都営バス">
      </div>
    </div>
    <div class="text-muted mb-2" style="font-size:0.75rem;">※バス停は「バス停名/事業者名」形式で入力（例：聖母病院入口/都営バス）</div>
    <button class="btn btn-outline-secondary btn-sm w-100" id="btnYahooTransit">
      <i class="bi bi-search me-1"></i>料金を検索して入力
    </button>
    <!-- 検索結果表示エリア -->
    <div id="transitResult" class="d-none mt-2 mb-3 p-2 rounded" style="background:#f0f7ff;border:1px solid #c8e0f8;font-size:0.82rem;">
      <div id="transitResultRoute" class="fw-semibold mb-1"></div>
      <div id="transitResultFare" class="text-primary fw-bold mb-1"></div>
      <a id="transitResultLink" href="#" target="_blank" class="btn btn-link btn-sm p-0 text-decoration-none">
        <i class="bi bi-box-arrow-up-right me-1"></i>Yahoo乗換で検索結果を確認する
      </a>
    </div>
    <div class="row g-2 mb-2">
      <div class="col-6">
        <label class="form-label small fw-semibold">片道運賃（円）</label>
        <input type="text" inputmode="numeric" class="form-control form-control-sm amount-input" id="numTransitFare" placeholder="0">
      </div>
      <div class="col-6 d-flex align-items-end pb-1">
        <div class="form-check">
          <input class="form-check-input" type="checkbox" id="chkRoundTrip">
          <label class="form-check-label small" for="chkRoundTrip">往復</label>
        </div>
      </div>
    </div>
    <div class="d-flex align-items-center gap-2 mb-2 px-1">
      <span class="small text-muted">合計</span>
      <span class="fw-bold fs-5" id="lblTransitTotal">¥0</span>
    </div>
    <div class="mb-2">
      <label class="form-label small fw-semibold">勘定科目</label>
      <select class="form-select form-select-sm" id="selCatTransit"></select>
    </div>
    ${_noteField()}
    <div class="mb-2">
      <label class="form-label small fw-semibold">領収書（任意）</label>
      <div class="d-flex flex-wrap gap-2 mb-2" id="previewArea-交通費"></div>
      <input type="file" class="d-none" id="fileInput-交通費" accept="*/*" multiple>
      <button class="btn btn-outline-secondary btn-sm" id="btnFile-交通費">
        <i class="bi bi-folder2-open me-1"></i>ファイル選択
      </button>
    </div>
  </div>

  <!-- 自家用車 -->
  <div id="panel-自家用車" class="d-none">
    ${_dateField()}
    <div class="mb-2">
      <label class="form-label small fw-semibold">案件・経路名</label>
      <input type="text" class="form-control form-control-sm" id="txtCarRoute" placeholder="例：〇〇社訪問 東京→横浜">
    </div>
    <div class="row g-2 mb-2">
      <div class="col-6">
        <label class="form-label small fw-semibold">距離（km）</label>
        <input type="number" class="form-control form-control-sm" id="numCarKm" min="0" step="0.1">
      </div>
      <div class="col-6">
        <label class="form-label small fw-semibold">レート（円/km）</label>
        <input type="number" class="form-control form-control-sm" id="numCarRate" min="1" step="1"
          value="${localStorage.getItem(CAR_RATE_KEY) || 20}">
      </div>
    </div>
    <div class="d-flex align-items-center gap-2 mb-2 px-1">
      <span class="small text-muted">合計</span>
      <span class="fw-bold fs-5" id="lblCarTotal">¥0</span>
    </div>
    <div class="mb-2">
      <label class="form-label small fw-semibold">勘定科目</label>
      <select class="form-select form-select-sm" id="selCatCar"></select>
    </div>
    ${_noteField()}
    <div class="mb-2">
      <label class="form-label small fw-semibold">地図・参考資料（任意）</label>
      <div class="d-flex flex-wrap gap-2 mb-2" id="previewArea-自家用車"></div>
      <input type="file" class="d-none" id="fileInput-自家用車" accept="*/*" multiple>
      <button class="btn btn-outline-secondary btn-sm" id="btnFile-自家用車">
        <i class="bi bi-folder2-open me-1"></i>ファイル選択
      </button>
    </div>
  </div>

  <!-- 申請ボタン -->
  <div class="d-grid mt-3 mb-4 no-print">
    <button class="btn btn-primary btn-lg rounded-3" id="btnSubmit">
      <i class="bi bi-send me-2"></i>申請する
    </button>
  </div>

  <!-- 直近履歴 -->
  <div class="mt-2 mb-4">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <h6 class="fw-bold mb-0">直近の履歴</h6>
      <button class="btn btn-link btn-sm text-decoration-none text-secondary p-0" id="btnRefreshHistory">
        <i class="bi bi-arrow-clockwise me-1"></i>更新
      </button>
    </div>
    <div id="historyList"><div class="text-muted small text-center py-3">読み込み中...</div></div>
  </div>

</div>`;
  }

  // ヘルパーHTML生成関数
  function _dateField() {
    const today = new Date().toISOString().split('T')[0];
    return `<div class="mb-2">
      <label class="form-label small fw-semibold">日付 <span class="text-danger">*</span></label>
      <input type="date" class="form-control form-control-sm" id="inputDate" value="${today}" max="${today}">
    </div>`;
  }
  function _placeField(placeholder) {
    return `<div class="mb-2">
      <label class="form-label small fw-semibold">支払先 <span class="text-danger">*</span></label>
      <input type="text" class="form-control form-control-sm" id="inputPlace" placeholder="${placeholder}">
    </div>`;
  }
  function _invoiceField() {
    return `<div class="mb-2">
      <label class="form-label small fw-semibold">インボイス番号（T+13桁）</label>
      <input type="text" class="form-control form-control-sm" id="inputInvoice" placeholder="T0000000000000">
    </div>`;
  }
  function _noteField() {
    return `<div class="mb-2">
      <label class="form-label small fw-semibold">備考</label>
      <textarea class="form-control form-control-sm" id="inputNote" rows="2"></textarea>
    </div>`;
  }
  function _amountSection() {
    return `
    <div class="mb-2">
      <div class="d-flex justify-content-between align-items-center mb-1">
        <label class="form-label small fw-semibold mb-0">金額・勘定科目 <span class="text-danger">*</span></label>
        <button class="btn btn-link btn-sm p-0 text-decoration-none" id="btnToggleSplit">明細分割</button>
      </div>
      <div id="singleLine" class="row g-2">
        <div class="col-5">
          <input type="text" inputmode="numeric" class="form-control form-control-sm amount-input" id="inputAmount" placeholder="金額（円）">
        </div>
        <div class="col-7">
          <select class="form-select form-select-sm" id="selCategory"></select>
        </div>
      </div>
      <div id="splitLines" class="d-none"></div>
      <div id="splitTotal" class="text-end text-muted small d-none">合計: <span id="lblSplitTotal">0</span>円</div>
    </div>`;
  }

  async function bindEvents(el) {
    // マスタデータ読み込み
    try {
      const master = await App.getMaster();
      _cats       = master.categories;
      _paySources = master.paySources;
    } catch (_) {}

    _populateSelects(el);
    _bindAmountInputs(el);
    _bindTypeButtons(el);
    _bindFileInputs(el);
    _bindSplitToggle(el);
    _bindCorpPay(el);
    _bindTransitCalc(el);
    _bindCarCalc(el);
    _bindSubmit(el);
    el.querySelector('#btnRefreshHistory')?.addEventListener('click', () => _loadHistory(el));
    el.querySelector('#btnCancelEdit')?.addEventListener('click', () => _cancelEdit(el));
    _loadHistory(el);

    // 一覧表の鉛筆ボタンからのジャンプ処理
    if (_pendingEdit) {
      const { id, expenses } = _pendingEdit;
      _pendingEdit = null;
      _startEdit(el, id, expenses);
    }
  }

  /** アクティブなパネルのルート要素を返す（複数パネルでIDが重複するため必須） */
  function _activePanel(el) {
    if (_currentType === '領収書') {
      return el.querySelector('#receiptFields') || el;
    }
    // 属性セレクタを使うと日本語IDもエスケープ不要
    return el.querySelector(`[id="panel-${_currentType}"]`) || el;
  }

  function _populateSelects(el) {
    const opts     = _cats.map(c => `<option value="${c}">${c}</option>`).join('');
    const fallback = '<option value="">（勘定科目なし）</option>';
    el.querySelectorAll('#selCategory, #selCatTransit, #selCatCar').forEach(s => {
      s.innerHTML = opts || fallback;
    });
    // 交通費・自家用車のデフォルトを旅費交通費に
    el.querySelectorAll('#selCatTransit, #selCatCar').forEach(sel => {
      const opt = [...sel.options].find(o => o.value === '旅費交通費');
      if (opt) opt.selected = true;
    });
    const psHtml = '<option value="">支払元を選択</option>' +
      _paySources.map(p => `<option value="${p}">${p}</option>`).join('');
    el.querySelectorAll('#selPaySource').forEach(s => { s.innerHTML = psHtml; });
  }

  /** 金額入力欄を自動カンマ整形する */
  function _bindAmountInputs(el) {
    const fmt = inp => {
      const raw = inp.value.replace(/[^\d]/g, '');
      inp.value = raw ? Number(raw).toLocaleString('ja-JP') : '';
    };
    // 既存の入力欄にバインド（動的に追加される split-amount は _addSplitRowTo 内でバインド）
    el.querySelectorAll('.amount-input').forEach(inp => {
      inp.addEventListener('input', () => fmt(inp));
    });
  }

  function _bindTypeButtons(el) {
    el.querySelectorAll('[data-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        _currentType = btn.dataset.type;
        _selectedFiles = [];
        el.querySelectorAll('[data-type]').forEach(b => {
          b.classList.toggle('active', b.dataset.type === _currentType);
        });
        TYPES.forEach(t => {
          el.querySelector(`#panel-${t}`)?.classList.toggle('d-none', t !== _currentType);
        });
        // 領収書以外はフォームをそのまま表示
        if (_currentType !== '領収書') return;
        el.querySelector('#receiptFields')?.classList.add('d-none');
      });
    });
  }

  function _bindFileInputs(el) {
    const handleFiles = async (el, type, e) => {
      for (const file of e.target.files) {
        const base64 = await Drive.fileToBase64(file);
        if (file.size > 10 * 1024 * 1024) { App.showToast(`${file.name} は10MBを超えています`, 'warning'); continue; }
        _selectedFiles.push({ base64, mimeType: file.type, name: file.name });
        _addPreviewItem(el, type, base64, file.type, _selectedFiles.length - 1);
      }
      e.target.value = '';
    };

    TYPES.forEach(type => {
      const fileInput = el.querySelector(`#fileInput-${type}`);
      if (!fileInput) return;

      // カメラボタン：専用input（capture="environment"）を使いシステム選択ダイアログを回避
      const camInput = el.querySelector(`#camInput-${type}`);
      const camBtn   = el.querySelector(`#btnCamera-${type}`);
      if (camBtn && camInput) {
        camBtn.addEventListener('click', () => camInput.click());
        camInput.addEventListener('change', e => handleFiles(el, type, e));
      }

      // ファイルボタン：通常のファイル選択
      const fileBtn = el.querySelector(`#btnFile-${type}`);
      if (fileBtn) fileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => handleFiles(el, type, e));
    });

    el.querySelector('#btnAnalyze')?.addEventListener('click', () => _runAiAnalysis(el));
    el.querySelector('#btnManualInput')?.addEventListener('click', () => _showReceiptFields(el));
  }

  function _addPreviewItem(el, type, base64, mimeType, idx) {
    const area = el.querySelector(`#previewArea-${type}`);
    if (!area) return;
    const div = document.createElement('div');
    div.className = 'file-preview-item';
    div.dataset.idx = idx;
    if (mimeType === 'application/pdf') {
      div.innerHTML = `<div class="file-icon d-flex align-items-center justify-content-center bg-light text-danger">
        <i class="bi bi-filetype-pdf" style="font-size:1.5rem;"></i></div>`;
    } else {
      div.innerHTML = `<img src="${base64}" alt="preview">`;
    }
    div.innerHTML += `<button class="remove-btn" data-file-idx="${idx}">✕</button>`;
    div.querySelector('.remove-btn').addEventListener('click', () => {
      _selectedFiles[idx] = null;
      div.remove();
    });
    area.appendChild(div);
  }

  function _bindSplitToggle(el) {
    // querySelectorAll で全パネルのトグルボタンにバインド
    el.querySelectorAll('#btnToggleSplit').forEach(btn => {
      btn.addEventListener('click', () => {
        // クリックされたボタンの親パネルを特定
        const pnl    = btn.closest('#receiptFields') || btn.closest('[id^="panel-"]') || el;
        const single = pnl.querySelector('#singleLine');
        const split  = pnl.querySelector('#splitLines');
        const total  = pnl.querySelector('#splitTotal');
        if (!single || !split || !total) return;
        const isSplit = !split.classList.contains('d-none');
        single.classList.toggle('d-none', !isSplit);
        split.classList.toggle('d-none', isSplit);
        total.classList.toggle('d-none', isSplit);
        if (!isSplit && split.children.length === 0) _addSplitRowTo(split, pnl);
      });
    });
  }

  function _addSplitRow(el) {
    const pnl = _activePanel(el);
    _addSplitRowTo(pnl.querySelector('#splitLines'), pnl);
  }

  function _addSplitRowTo(container, pnl) {
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'split-row py-2 row g-2 align-items-center';
    row.innerHTML = `
      <div class="col-4"><input type="text" inputmode="numeric" class="form-control form-control-sm split-amount amount-input" placeholder="金額"></div>
      <div class="col-6"><select class="form-select form-select-sm split-cat">
        ${_cats.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select></div>
      <div class="col-2 text-end">
        <button class="btn btn-outline-danger btn-sm btn-del-row"><i class="bi bi-x"></i></button>
      </div>`;
    row.querySelector('.btn-del-row').addEventListener('click', () => {
      row.remove();
      _calcSplitTotalIn(pnl);
    });
    const amtInp = row.querySelector('.split-amount');
    const fmtAmt = () => {
      const raw = amtInp.value.replace(/[^\d]/g, '');
      amtInp.value = raw ? Number(raw).toLocaleString('ja-JP') : '';
    };
    amtInp.addEventListener('input', () => { fmtAmt(); _calcSplitTotalIn(pnl); });
    container.appendChild(row);

    if (!pnl.querySelector('#btnAddSplitRow')) {
      const btn = document.createElement('button');
      btn.id = 'btnAddSplitRow';
      btn.className = 'btn btn-outline-secondary btn-sm mt-1 w-100';
      btn.innerHTML = '<i class="bi bi-plus me-1"></i>行を追加';
      btn.addEventListener('click', () => _addSplitRowTo(container, pnl));
      container.after(btn);
    }
  }

  function _calcSplitTotal(el) {
    _calcSplitTotalIn(_activePanel(el));
  }

  function _calcSplitTotalIn(pnl) {
    const total = Array.from(pnl.querySelectorAll('.split-amount'))
      .reduce((s, i) => s + (Number(i.value.replace(/[^\d]/g, '')) || 0), 0);
    const lbl = pnl.querySelector('#lblSplitTotal');
    if (lbl) lbl.textContent = total.toLocaleString();
  }

  function _bindCorpPay(el) {
    el.querySelector('#chkCorpPay')?.addEventListener('change', e => {
      el.querySelector('#corpPayDetails').classList.toggle('d-none', !e.target.checked);
    });
  }

  // サブタイプごとのラベル・プレースホルダー設定
  const _TRANSIT_MODE_CONFIG = {
    '電車・バス': { fromLabel: '出発駅・バス停', toLabel: '到着駅・バス停', fromPh: '例：渋谷', toPh: '例：新宿' },
    '高速':       { fromLabel: '入口IC',         toLabel: '出口IC',         fromPh: '例：東名川崎IC', toPh: '例：東名横浜IC' },
  };

  function _bindTransitCalc(el) {
    const calcTotal = () => {
      const raw  = (el.querySelector('#numTransitFare')?.value || '').replace(/[^\d]/g, '');
      const fare = Number(raw) || 0;
      const round = el.querySelector('#chkRoundTrip')?.checked ? 2 : 1;
      el.querySelector('#lblTransitTotal').textContent = (fare * round).toLocaleString() + '円';
    };
    el.querySelector('#numTransitFare')?.addEventListener('input', calcTotal);
    el.querySelector('#chkRoundTrip')?.addEventListener('change', calcTotal);

    // サブタイプ切り替え
    el.querySelectorAll('#transitModeGroup [data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        _transitMode = btn.dataset.mode;
        el.querySelectorAll('#transitModeGroup [data-mode]').forEach(b => {
          b.classList.toggle('btn-secondary', b === btn);
          b.classList.toggle('btn-outline-secondary', b !== btn);
        });
        const cfg = _TRANSIT_MODE_CONFIG[_transitMode];
        el.querySelector('#lblTransitFrom').textContent = cfg.fromLabel;
        el.querySelector('#lblTransitTo').textContent   = cfg.toLabel;
        el.querySelector('#txtFrom').placeholder = cfg.fromPh;
        el.querySelector('#txtTo').placeholder   = cfg.toPh;
        // 高速：NEXCO リンクを表示、電車/バス：Yahoo 乗換を表示
        const isHighway = _transitMode === '高速';
        el.querySelector('#btnYahooTransit').classList.toggle('d-none', isHighway);
        el.querySelector('#btnNexco').classList.toggle('d-none', !isHighway);
        el.querySelector('#transitResult')?.classList.add('d-none');
      });
    });

    el.querySelector('#btnNexco')?.addEventListener('click', async () => {
      const from = el.querySelector('#txtFrom')?.value.trim();
      const to   = el.querySelector('#txtTo')?.value.trim();
      if (!from || !to) return App.showToast('入口ICと出口ICを入力してください', 'warning');

      const btn = el.querySelector('#btnNexco');
      const resultDiv = el.querySelector('#transitResult');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>検索中...';
      resultDiv?.classList.add('d-none');

      try {
        const apiBase = window.APP_CONFIG?.apiBase || '';
        const resp = await fetch(
          `${apiBase}/api/highway?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
        );
        const data = await resp.json();

        if (data.toll) {
          const fareInput = el.querySelector('#numTransitFare');
          if (fareInput) fareInput.value = data.toll.toLocaleString('ja-JP');
          calcTotal();

          if (resultDiv) {
            const kmText = data.km ? `（${data.km}km）` : '';
            el.querySelector('#transitResultRoute').textContent = `${from} → ${to}${kmText}`;
            el.querySelector('#transitResultFare').textContent = `高速料金（ETC）: ¥${data.toll.toLocaleString()} ／片道`;
            const link = el.querySelector('#transitResultLink');
            if (link) {
              link.href = data.resultUrl;
              link.innerHTML = '<i class="bi bi-box-arrow-up-right me-1"></i>Yahoo地図で経路・料金を確認する';
            }
            resultDiv.classList.remove('d-none');
          }
          App.showToast(`高速料金 ¥${data.toll.toLocaleString()} を入力しました`, 'success');
        } else {
          App.showToast('料金を自動取得できませんでした。Yahoo地図を開きます', 'warning');
          window.open(data.resultUrl, '_blank');
        }
      } catch (err) {
        App.showToast('検索エラー: ' + err.message, 'danger');
        window.open(
          `https://map.yahoo.co.jp/route/car?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          '_blank'
        );
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-car-front-fill me-1"></i>Yahoo地図で経路・料金を確認';
      }
    });

    el.querySelector('#btnYahooTransit')?.addEventListener('click', async () => {
      const from = el.querySelector('#txtFrom')?.value.trim();
      const to   = el.querySelector('#txtTo')?.value.trim();
      if (!from || !to) return App.showToast('出発駅・停留所と到着駅・停留所を入力してください', 'warning');

      const btn = el.querySelector('#btnYahooTransit');
      const resultDiv  = el.querySelector('#transitResult');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>検索中...';
      resultDiv?.classList.add('d-none');

      try {
        const apiBase = window.APP_CONFIG?.apiBase || '';
        const mode = 'train'; // 電車・バス統合モード（Yahoo乗換が最安値を自動選択）
        const resp = await fetch(
          `${apiBase}/api/transit?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
          { cache: 'no-store' }
        );
        const data = await resp.json();

        if (!resp.ok || !data.fare) {
          App.showToast(data.error || '運賃を取得できませんでした', 'warning');
          window.open(
            `https://transit.yahoo.co.jp/search/result?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&type=1&expkind=1&userpass=1&ticket=ic`,
            '_blank'
          );
          return;
        }

        const fareInput = el.querySelector('#numTransitFare');
        if (fareInput) fareInput.value = data.fare.toLocaleString('ja-JP');
        calcTotal();

        if (resultDiv) {
          const transfers = data.transfers?.length ? data.transfers.join('・') : null;
          const routeText = transfers ? `${from} → ${transfers} → ${to}` : `${from} → ${to}`;
          const timeText  = data.minutes ? `（約${data.minutes}分）` : '';
          el.querySelector('#transitResultRoute').textContent = `${routeText}${timeText}`;
          el.querySelector('#transitResultFare').textContent =
            `${fareLabel}: ¥${data.fare.toLocaleString()} ／片道`;
          const link = el.querySelector('#transitResultLink');
          if (link) link.href = data.resultUrl;
          resultDiv.classList.remove('d-none');
        }

        App.showToast(`片道 ¥${data.fare.toLocaleString()} を入力しました`, 'success');
      } catch (err) {
        App.showToast('検索エラー: ' + err.message, 'danger');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-search me-1"></i>料金を検索して入力';
      }
    });
  }

  function _bindCarCalc(el) {
    const calc = () => {
      const km   = Number(el.querySelector('#numCarKm')?.value)   || 0;
      const rate = Number(el.querySelector('#numCarRate')?.value)  || 20;
      el.querySelector('#lblCarTotal').textContent = Math.ceil(km * rate).toLocaleString() + '円';
      localStorage.setItem(CAR_RATE_KEY, rate);
    };
    el.querySelector('#numCarKm')?.addEventListener('input', calc);
    el.querySelector('#numCarRate')?.addEventListener('input', calc);
  }

  /** 為替レート取得（複数APIを順に試す） */
  async function _fetchExchangeRate(from, to) {
    const f = from.toLowerCase();
    const t = to.toLowerCase();

    // 1. CDN-backed currency API（CORS確実、無料）
    try {
      const resp = await fetch(
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${f}.json`
      );
      if (resp.ok) {
        const data = await resp.json();
        const rate = data[f]?.[t];
        if (rate) return rate;
      }
    } catch (_) {}

    // 2. Frankfurter dev（旧 .app から移行済み）
    try {
      const resp = await fetch(
        `https://api.frankfurter.dev/v1/latest?base=${from.toUpperCase()}&symbols=${to.toUpperCase()}`
      );
      if (resp.ok) {
        const data = await resp.json();
        const rate = data.rates?.[to.toUpperCase()];
        if (rate) return rate;
      }
    } catch (_) {}

    // 3. ExchangeRate-API 無料枠
    try {
      const resp = await fetch(
        `https://open.er-api.com/v6/latest/${from.toUpperCase()}`
      );
      if (resp.ok) {
        const data = await resp.json();
        const rate = data.rates?.[to.toUpperCase()];
        if (rate) return rate;
      }
    } catch (_) {}

    return null;
  }

  async function _runAiAnalysis(el) {
    const files = _selectedFiles.filter(Boolean);
    if (files.length === 0) return App.showToast('ファイルを選択してから解析してください', 'warning');
    const btn = el.querySelector('#btnAnalyze');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>解析中...';
    try {
      const result = await Gemini.analyzeReceipt(files, _cats);
      console.log('[AI解析結果]', result);

      _showReceiptFields(el);

      let filled = 0;
      if (result.date) {
        el.querySelector('#inputDate').value = result.date;
        filled++;
      }
      if (result.shop) {
        el.querySelector('#inputPlace').value = result.shop;
        filled++;
      }
      if (result.invoice) {
        el.querySelector('#inputInvoice').value = result.invoice;
        filled++;
      }

      // 金額・勘定科目：items が複数なら分割、それ以外は単一行に統合
      const hasMultiItems = result.items && result.items.length > 1;

      if (hasMultiItems) {
        // 2件以上の明細 → 分割モード
        const isSplit = !el.querySelector('#splitLines')?.classList.contains('d-none');
        if (!isSplit) el.querySelector('#btnToggleSplit')?.click();
        const container = el.querySelector('#splitLines');
        if (container) {
          container.innerHTML = '';
          el.querySelector('#btnAddSplitRow')?.remove();
          result.items.forEach(item => {
            _addSplitRow(el);
            const rows = container.querySelectorAll('.split-row');
            const lastRow = rows[rows.length - 1];
            if (lastRow) {
              const amtInput = lastRow.querySelector('.split-amount');
              const catSel   = lastRow.querySelector('.split-cat');
              if (amtInput) amtInput.value = Number(item.amount || 0).toLocaleString('ja-JP');
              if (catSel && item.category) {
                [...catSel.options].forEach(o => o.selected = o.value === item.category);
              }
            }
          });
          _calcSplitTotal(el);
        }
        filled++;
      } else {
        // 1件 or items なし → 単一行モード（items[0] を優先して拾う）
        const singleItem   = result.items?.[0];
        const totalAmount  = singleItem?.amount  ?? result.total_amount;
        const singleCat    = singleItem?.category ?? result.category;

        if (result.fx_currency && result.fx_amount) {
          // 外貨：複数APIを順に試して換算
          const rate = await _fetchExchangeRate(result.fx_currency, 'JPY');
          if (rate) {
            const jpy = Math.ceil(Number(result.fx_amount) * rate);
            const amtInput = el.querySelector('#inputAmount');
            if (amtInput) amtInput.value = jpy.toLocaleString('ja-JP');
            // 備考欄に換算内訳を自動入力
            const noteInput = el.querySelector('#inputNote');
            if (noteInput) noteInput.value =
              `${result.fx_currency} ${Number(result.fx_amount).toLocaleString()} × ${rate.toFixed(2)} = ¥${jpy.toLocaleString()}`;
            App.showToast(
              `外貨換算: ${result.fx_currency} ${Number(result.fx_amount).toLocaleString()} × ${rate.toFixed(2)} = ¥${jpy.toLocaleString()}（確認してください）`,
              'warning'
            );
            filled++;
          } else {
            App.showToast(`外貨検出（${result.fx_currency} ${result.fx_amount}）。為替レートが取得できませんでした。手動で入力してください`, 'warning');
          }
        } else if (totalAmount != null && totalAmount !== '') {
          const amtInput = el.querySelector('#inputAmount');
          if (amtInput) amtInput.value = Number(totalAmount).toLocaleString('ja-JP');
          filled++;
        }

        if (singleCat) {
          const sel = el.querySelector('#selCategory');
          if (sel) [...sel.options].forEach(o => o.selected = o.value === singleCat);
          filled++;
        }
      }

      // 解析完了後、フォームを画面内にスクロール
      el.querySelector('#receiptFields')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      if (filled === 0) {
        App.showToast('読み取れませんでした。内容を手動で入力してください', 'warning');
      } else {
        App.showToast('AI解析完了。内容を確認してください', 'success');
      }
    } catch (err) {
      console.error('[AI解析エラー]', err);
      App.showToast('AI解析エラー: ' + err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-stars me-2"></i>AIで読み取る';
    }
  }

  function _showReceiptFields(el) {
    el.querySelector('#receiptFields')?.classList.remove('d-none');
  }

  function _bindSubmit(el) {
    el.querySelector('#btnSubmit')?.addEventListener('click', () => _handleSubmit(el));
  }

  async function _handleSubmit(el) {
    const data = _collectFormData(el);
    if (!data) return; // バリデーション失敗

    // 2ヶ月以上前の日付チェック（電帳法対応）
    const dateVal = new Date(data.date);
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    if (dateVal < twoMonthsAgo) {
      const ok = await App.confirm(
        `日付が2ヶ月以上前（${data.date}）です。\n電子帳簿保存法では受領後速やかな保存が求められます。\nこのまま申請しますか？`
      );
      if (!ok) return;
    }

    App.showLoading('申請中...');
    try {
      // 1. サーバー時刻取得（電帳法対応）
      const timeResp = await fetch(`${window.APP_CONFIG?.apiBase || ''}/api/time`);
      const { jst: appliedAt } = await timeResp.json();

      // 2. ファイルアップロード + SHA-256ハッシュ計算
      const activeFiles = _selectedFiles.filter(Boolean);
      const uploadedUrls = [..._existingUrls];
      const hashes = _existingHash ? [_existingHash] : [];

      const master = await App.getMaster();
      const userName = master.members.find(m => m.email === Auth.getUserEmail())?.name
        || Auth.getUserInfo()?.name || Auth.getUserEmail();

      const dateStr = data.date.replace(/-/g, '');
      const amtStr  = String(data.amount);

      for (let i = 0; i < activeFiles.length; i++) {
        const f = activeFiles[i];
        const ext = f.mimeType.split('/')[1] || 'jpg';
        const filename = `${dateStr}_${amtStr}円_${userName}_${i + 1}.${ext}`;
        const { url, hash, warn } = await Drive.uploadReceiptFile(f.base64, f.mimeType, filename);
        uploadedUrls.push(url);
        hashes.push(hash);
        if (warn) App.showToast(warn, 'warning');
      }

      // 3. 重複チェック
      const expenses = await Sheets.readExpenses();
      const dup = _checkDuplicate(expenses, data, hashes);
      if (dup) {
        App.hideLoading(); // ダイアログ表示前にオーバーレイを隠す
        const ok = await App.confirm(`⚠️ ${dup}\nこのまま申請しますか？`);
        if (!ok) return;
        App.showLoading('申請中...'); // 続行する場合は再表示
      }

      // 4. AI監査フラグ設定
      const aiAudit = dup ? `⛔ ${dup}` : '✅ OK';

      // 5. 行データ組み立て
      const row = Sheets.expenseToRow({
        appliedAt,
        name:       userName,
        type:       _currentType,
        date:       data.date,
        place:      data.place,
        amount:     data.amount,
        category:   data.category,
        note:       data.note,
        imageLinks: uploadedUrls.join(', '),
        confirmed:  false,
        aiAudit,
        payment:    data.corpPay ? `会社払い（${data.paySource}）` : '',
        invoice:    data.invoice,
        aiAmount:   0,
        imageHash:  hashes.join(','),
        email:      Auth.getUserEmail(),
        id:         _editId || crypto.randomUUID(),
        device:     navigator.userAgent,
      });

      // 6. 編集の場合は修正履歴に旧データを保存してから更新
      if (_editId) {
        const rowNum = await Sheets.findRowById(_editId);
        if (rowNum > 0) {
          const oldRows = await Sheets.read(`経費一覧!A${rowNum}:R${rowNum}`);
          await Sheets.append('修正履歴', [appliedAt, Auth.getUserEmail(), JSON.stringify(oldRows[0])]);
          await Sheets.update(`経費一覧!A${rowNum}:R${rowNum}`, [row]);
        }
      } else {
        await Sheets.append('経費一覧', row);
      }

      App.showToast(_editId ? '修正しました' : '申請しました', 'success');
      _resetForm(el);
      _loadHistory(el);
    } catch (err) {
      App.showToast('申請エラー: ' + err.message, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _collectFormData(el) {
    const pnl  = _activePanel(el);
    const date = pnl.querySelector('#inputDate')?.value;

    // place は交通費・自家用車では専用フィールドから生成
    let place = '';
    if (_currentType === '交通費') {
      const from = el.querySelector('#txtFrom')?.value.trim();
      const to   = el.querySelector('#txtTo')?.value.trim();
      place = [from, to].filter(Boolean).join(' → ');
    } else if (_currentType === '自家用車') {
      place = el.querySelector('#txtCarRoute')?.value.trim() || '';
    } else {
      place = pnl.querySelector('#inputPlace')?.value?.trim() || '';
    }

    if (!date)  { App.showToast('日付を入力してください', 'danger'); return null; }
    if (!place) { App.showToast('支払先・経路を入力してください', 'danger'); return null; }

    let amount = 0, category = '', note = '';

    if (_currentType === '交通費') {
      const raw   = (el.querySelector('#numTransitFare')?.value || '').replace(/[^\d]/g, '');
      const fare  = Number(raw) || 0;
      const round = el.querySelector('#chkRoundTrip')?.checked ? 2 : 1;
      amount   = fare * round;
      category = el.querySelector('#selCatTransit')?.value || '';
      note     = pnl.querySelector('#inputNote')?.value?.trim() || '';
      if (amount === 0) { App.showToast('運賃を入力してください', 'danger'); return null; }
    } else if (_currentType === '自家用車') {
      const km   = Number(el.querySelector('#numCarKm')?.value)  || 0;
      const rate = Number(el.querySelector('#numCarRate')?.value) || 20;
      amount   = Math.ceil(km * rate);
      category = el.querySelector('#selCatCar')?.value || '';
      note     = pnl.querySelector('#inputNote')?.value?.trim() || '';
      if (amount === 0) { App.showToast('距離を入力してください', 'danger'); return null; }
    } else {
      const isSplit = !pnl.querySelector('#splitLines')?.classList.contains('d-none');
      if (isSplit) {
        const rows = pnl.querySelectorAll('.split-row');
        amount   = Array.from(rows).reduce((s, r) => {
          const raw = (r.querySelector('.split-amount')?.value || '').replace(/[^\d]/g, '');
          return s + (Number(raw) || 0);
        }, 0);
        category = Array.from(rows).map(r => r.querySelector('.split-cat')?.value).join('/');
      } else {
        const rawAmt = (pnl.querySelector('#inputAmount')?.value || '').replace(/[^\d]/g, '');
        amount   = Number(rawAmt) || 0;
        category = pnl.querySelector('#selCategory')?.value || '';
      }
      note = pnl.querySelector('#inputNote')?.value?.trim() || '';
      if (amount === 0) { App.showToast('金額を入力してください', 'danger'); return null; }
    }

    // 勘定科目は必須
    if (!category) { App.showToast('勘定科目を選択してください', 'danger'); return null; }

    // 領収書なしは理由が必須、かつnoteに合算
    if (_currentType === '領収書なし') {
      const reason = pnl.querySelector('#txtReason')?.value?.trim();
      if (!reason) { App.showToast('理由・詳細を入力してください', 'danger'); return null; }
      note = [reason, note].filter(Boolean).join('\n');
    }

    const corpPay   = el.querySelector('#chkCorpPay')?.checked || false;
    const paySource = el.querySelector('#selPaySource')?.value || '';
    if (corpPay && !paySource) { App.showToast('会社払いの支払元を選択してください', 'danger'); return null; }

    return {
      date, place, amount, category, note,
      invoice:   pnl.querySelector('#inputInvoice')?.value?.trim() || '',
      corpPay, paySource,
    };
  }

  function _checkDuplicate(expenses, data, newHashes) {
    const userEmail = Auth.getUserEmail();
    // 同一申請者の既存レコードと照合
    for (const e of expenses) {
      if (e.id === _editId) continue; // 自分自身は除く
      // 日付・支払先・金額の完全一致
      if (e.date === data.date && e.place === data.place && e.amount === data.amount && e.email === userEmail) {
        return '同じ日付・支払先・金額の申請が既に存在します';
      }
      // 画像ハッシュの重複
      if (newHashes.length > 0 && e.imageHash) {
        const existingHashes = e.imageHash.split(',');
        if (newHashes.some(h => existingHashes.includes(h))) {
          return '同じ証票画像が既に申請されています（重複の可能性）';
        }
      }
    }
    return null;
  }

  async function _loadHistory(el) {
    const list = el.querySelector('#historyList');
    if (!list) return;
    list.innerHTML = '<div class="text-muted small text-center py-2">読み込み中...</div>';
    try {
      const all = await Sheets.readExpenses();
      const email = Auth.getUserEmail();
      const mine  = all.filter(e => e.email === email).slice(-30).reverse();
      if (mine.length === 0) {
        list.innerHTML = '<div class="text-muted small text-center py-3">申請履歴がありません</div>';
        return;
      }
      list.innerHTML = mine.map(e => _renderHistoryCard(e)).join('');
      list.querySelectorAll('.btn-edit-history').forEach(btn => {
        btn.addEventListener('click', () => _startEdit(el, btn.dataset.id, all));
      });
      list.querySelectorAll('.btn-del-history').forEach(btn => {
        btn.addEventListener('click', () => _deleteExpense(btn.dataset.id, el));
      });
    } catch (err) {
      list.innerHTML = `<div class="text-danger small text-center py-2">${err.message}</div>`;
    }
  }

  function _renderHistoryCard(e) {
    const statusClass = e.confirmed ? 'badge-confirmed'
      : e.aiAudit?.startsWith('⛔') ? 'badge-duplicate' : 'badge-pending';
    const statusText = e.confirmed ? '承認済' : e.aiAudit?.startsWith('⛔') ? '要確認' : '未確認';

    const imageBtn = e.imageLinks
      ? `<a href="${e.imageLinks.split(',')[0].trim()}" target="_blank" class="btn btn-sm btn-outline-primary">
           <i class="bi bi-image me-1"></i>証票
         </a>`
      : '';
    const editBtn = e.confirmed ? '' :
      `<button class="btn btn-sm btn-outline-secondary btn-edit-history" data-id="${e.id}">
         <i class="bi bi-pencil"></i>
       </button>`;
    const delBtn = e.confirmed ? '' :
      `<button class="btn btn-sm btn-outline-danger btn-del-history" data-id="${e.id}">
         <i class="bi bi-trash"></i>
       </button>`;

    return `
    <div class="history-card">
      <div class="d-flex justify-content-between align-items-start">
        <span class="h-place">${_escape(e.place)}</span>
        <span class="h-amount">¥${e.amount.toLocaleString()}</span>
      </div>
      <div class="d-flex justify-content-between align-items-center mt-1">
        <span class="h-meta">${e.date} / ${_escape(e.category)} (${e.type})</span>
        <span class="badge ${statusClass} rounded-pill px-2">${statusText}</span>
      </div>
      <div class="d-flex gap-2 mt-2 align-items-center">
        ${imageBtn}
        <div class="ms-auto d-flex gap-1">${editBtn}${delBtn}</div>
      </div>
    </div>`;
  }

  function _startEdit(el, id, expenses) {
    const e = expenses.find(x => x.id === id);
    if (!e) return;
    _editId = id;
    _existingUrls = e.imageLinks ? e.imageLinks.split(',').map(s => s.trim()).filter(Boolean) : [];
    _existingHash = e.imageHash || '';

    // タイプ切り替え（_currentType も更新される）
    const typeBtn = el.querySelector(`[data-type="${e.type}"]`);
    if (typeBtn) typeBtn.click();

    setTimeout(() => {
      if (e.type === '領収書') _showReceiptFields(el);
      const pnl = _activePanel(el);

      // 共通フィールド（パネルにスコープ）
      const dateInput = pnl.querySelector('#inputDate');
      if (dateInput) dateInput.value = e.date;
      const noteInput = pnl.querySelector('#inputNote');
      if (noteInput) noteInput.value = e.note || '';

      // タイプ別フィールド
      if (e.type === '領収書' || e.type === '領収書なし') {
        const placeInput = pnl.querySelector('#inputPlace');
        if (placeInput) placeInput.value = e.place || '';
        const invInput = pnl.querySelector('#inputInvoice');
        if (invInput) invInput.value = e.invoice || '';
        const amtInput = pnl.querySelector('#inputAmount');
        if (amtInput) amtInput.value = Number(e.amount).toLocaleString('ja-JP');
        const sel = pnl.querySelector('#selCategory');
        if (sel) [...sel.options].forEach(o => o.selected = o.value === e.category);
      } else if (e.type === '交通費') {
        const parts = (e.place || '').split(' → ');
        const fromInput = el.querySelector('#txtFrom');
        const toInput   = el.querySelector('#txtTo');
        if (fromInput) fromInput.value = parts[0] || e.place;
        if (toInput)   toInput.value   = parts[1] || '';
        const fareInput = el.querySelector('#numTransitFare');
        if (fareInput) fareInput.value = Number(e.amount).toLocaleString('ja-JP');
        const selT = el.querySelector('#selCatTransit');
        if (selT) [...selT.options].forEach(o => o.selected = o.value === e.category);
      } else if (e.type === '自家用車') {
        const routeInput = el.querySelector('#txtCarRoute');
        if (routeInput) routeInput.value = e.place || '';
        const selC = el.querySelector('#selCatCar');
        if (selC) [...selC.options].forEach(o => o.selected = o.value === e.category);
      }

      el.querySelector('#editBanner')?.classList.remove('d-none');
      const btn = el.querySelector('#btnSubmit');
      if (btn) { btn.textContent = '上書き保存'; btn.className = 'btn btn-warning btn-lg rounded-3'; }
      el.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  async function _deleteExpense(id, el) {
    const ok = await App.confirm('この申請を削除しますか？削除後は元に戻せません。');
    if (!ok) return;
    App.showLoading('削除中...');
    try {
      const expenses = await Sheets.readExpenses();
      const e = expenses.find(x => x.id === id);
      if (!e) throw new Error('申請が見つかりません');

      const rowNum = await Sheets.findRowById(id);
      if (rowNum < 0) throw new Error('行が見つかりません');

      // 削除一覧に移動
      const timeResp = await fetch(`${window.APP_CONFIG?.apiBase || ''}/api/time`);
      const { jst: deletedAt } = await timeResp.json();
      await Sheets.append('削除一覧', [deletedAt, Auth.getUserEmail(), ...Sheets.expenseToRow(e)]);

      // 元の行を削除（sheetIdが必要なのでbatchUpdateを使う）
      // 簡略化：行の内容を空白で上書きしてフィルタリングする方式
      await Sheets.update(`経費一覧!A${rowNum}:R${rowNum}`, [new Array(18).fill('')]);

      App.showToast('削除しました', 'success');
      _loadHistory(el);
    } catch (err) {
      App.showToast('削除エラー: ' + err.message, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _cancelEdit(el) {
    _editId = null;
    _existingUrls = [];
    _existingHash = '';
    _resetForm(el);
  }

  function _resetForm(el) {
    _selectedFiles = [];
    _editId = null;
    el.querySelector('#editBanner')?.classList.add('d-none');
    const btn = el.querySelector('#btnSubmit');
    if (btn) { btn.innerHTML = '<i class="bi bi-send me-2"></i>申請する'; btn.className = 'btn btn-primary btn-lg rounded-3'; }
    TYPES.forEach(t => el.querySelector(`#previewArea-${t}`)?.replaceChildren());
    el.querySelector('#receiptFields')?.classList.add('d-none');
    // 重複IDは querySelectorAll で全パネル一括リセット
    const today = new Date().toISOString().split('T')[0];
    el.querySelectorAll('#inputDate').forEach(i => { i.value = today; });
    el.querySelectorAll('#inputPlace').forEach(i => { i.value = ''; });
    el.querySelectorAll('#inputAmount').forEach(i => { i.value = ''; });
    el.querySelectorAll('#inputNote').forEach(i => { i.value = ''; });
    el.querySelectorAll('#inputInvoice').forEach(i => { i.value = ''; });
    el.querySelector('#chkCorpPay') && (el.querySelector('#chkCorpPay').checked = false);
    el.querySelector('#corpPayDetails')?.classList.add('d-none');
    // 交通費・自家用車の専用フィールドもクリア
    el.querySelector('#txtFrom')     && (el.querySelector('#txtFrom').value = '');
    el.querySelector('#txtTo')       && (el.querySelector('#txtTo').value = '');
    // 交通費サブタイプを電車・バスにリセット
    _transitMode = '電車・バス';
    el.querySelectorAll('#transitModeGroup [data-mode]').forEach(b => {
      b.classList.toggle('btn-secondary', b.dataset.mode === '電車・バス');
      b.classList.toggle('btn-outline-secondary', b.dataset.mode !== '電車・バス');
    });
    const cfg0 = _TRANSIT_MODE_CONFIG['電車・バス'];
    el.querySelector('#lblTransitFrom') && (el.querySelector('#lblTransitFrom').textContent = cfg0.fromLabel);
    el.querySelector('#lblTransitTo')   && (el.querySelector('#lblTransitTo').textContent   = cfg0.toLabel);
    el.querySelector('#txtFrom')?.setAttribute('placeholder', cfg0.fromPh);
    el.querySelector('#txtTo')?.setAttribute('placeholder', cfg0.toPh);
    el.querySelector('#btnYahooTransit')?.classList.remove('d-none');
    el.querySelector('#btnNexco')?.classList.add('d-none');
    el.querySelector('#txtCarRoute') && (el.querySelector('#txtCarRoute').value = '');
    el.querySelector('#numTransitFare') && (el.querySelector('#numTransitFare').value = '');
    el.querySelector('#numCarKm')       && (el.querySelector('#numCarKm').value = '');
    el.querySelector('#txtReason')      && (el.querySelector('#txtReason').value = '');
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function queueEdit(id, expenses) { _pendingEdit = { id, expenses }; }

  return { render, bindEvents, queueEdit };
})();
