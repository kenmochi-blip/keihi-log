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

  const TYPES = ['領収書', '領収書なし', '交通費', '自家用車'];
  const CAR_RATE_KEY = 'keihi_car_rate';

  function render() {
    return `
<div class="pt-3">

  <!-- 編集モードバナー -->
  <div id="editBanner" class="edit-banner d-none mb-3">
    <i class="bi bi-pencil-square me-1"></i>修正モード
    <button class="btn btn-link btn-sm text-muted p-0 ms-2" id="btnCancelEdit">キャンセル</button>
  </div>

  <!-- 会社払いトグル -->
  <div class="card mb-3">
    <div class="card-body py-2">
      <div class="form-check form-switch d-flex align-items-center gap-2 mb-0">
        <input class="form-check-input" type="checkbox" id="chkCorpPay" style="width:2.5rem;">
        <label class="form-check-label small" for="chkCorpPay">会社払い（立替精算なし）</label>
      </div>
      <div id="corpPayDetails" class="d-none mt-2">
        <select class="form-select form-select-sm" id="selPaySource">
          <option value="">支払元を選択</option>
        </select>
      </div>
    </div>
  </div>

  <!-- タイプ選択タブ -->
  <div class="d-flex gap-2 overflow-auto pb-2 mb-3 no-print">
    ${TYPES.map(t => `
      <button class="btn type-tab-btn ${t === '領収書' ? 'btn-primary' : 'btn-outline-secondary'} flex-shrink-0"
        data-type="${t}">${t === '領収書' ? '📷 領収書' : t === '領収書なし' ? '📝 ' + t : t === '交通費' ? '🚃 ' + t : '🚗 ' + t}</button>
    `).join('')}
  </div>

  <!-- フォーム本体 -->
  <div class="card mb-3">
    <div class="card-body">

      <!-- 領収書タイプ -->
      <div id="form-領収書">
        <div class="mb-3">
          <label class="form-label small fw-semibold">証票ファイル</label>
          <div class="d-flex gap-2 mb-2" id="previewArea-領収書"></div>
          <input type="file" class="d-none" id="fileInput-領収書" accept="image/*,.pdf" multiple capture="environment">
          <div class="d-flex gap-2">
            <button class="btn btn-outline-secondary btn-sm" id="btnCamera-領収書">
              <i class="bi bi-camera me-1"></i>撮影
            </button>
            <button class="btn btn-outline-secondary btn-sm" id="btnFile-領収書">
              <i class="bi bi-folder2-open me-1"></i>ファイル選択
            </button>
            <button class="btn btn-outline-primary btn-sm" id="btnAnalyze">
              <i class="bi bi-stars me-1"></i>AI解析
            </button>
          </div>
        </div>
        ${_dateField()}
        ${_placeField('支払先（店名・会社名）')}
        ${_invoiceField()}
        ${_amountSection()}
        ${_noteField()}
      </div>

      <!-- 領収書なしタイプ -->
      <div id="form-領収書なし" class="d-none">
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
          <div class="d-flex gap-2 mb-2" id="previewArea-領収書なし"></div>
          <input type="file" class="d-none" id="fileInput-領収書なし" accept="image/*" multiple>
          <button class="btn btn-outline-secondary btn-sm" id="btnFile-領収書なし">
            <i class="bi bi-folder2-open me-1"></i>ファイル選択
          </button>
        </div>
      </div>

      <!-- 交通費タイプ -->
      <div id="form-交通費" class="d-none">
        ${_dateField()}
        <div class="row g-2 mb-2">
          <div class="col-6">
            <label class="form-label small fw-semibold">出発駅</label>
            <input type="text" class="form-control form-control-sm" id="txtFrom" placeholder="例：渋谷">
          </div>
          <div class="col-6">
            <label class="form-label small fw-semibold">到着駅</label>
            <input type="text" class="form-control form-control-sm" id="txtTo" placeholder="例：新宿">
          </div>
        </div>
        <button class="btn btn-outline-secondary btn-sm mb-2 w-100" id="btnYahooTransit">
          <i class="bi bi-train-front me-1"></i>Yahoo乗換で検索
        </button>
        <div class="row g-2 mb-2">
          <div class="col-6">
            <label class="form-label small fw-semibold">片道運賃（円）</label>
            <input type="number" class="form-control form-control-sm" id="numTransitFare" min="0" step="1">
          </div>
          <div class="col-6 d-flex align-items-end">
            <div class="form-check mb-1">
              <input class="form-check-input" type="checkbox" id="chkRoundTrip">
              <label class="form-check-label small" for="chkRoundTrip">往復</label>
            </div>
          </div>
        </div>
        <div class="mb-2 d-flex align-items-center gap-2">
          <span class="small">合計：</span>
          <span class="fw-bold" id="lblTransitTotal">0円</span>
        </div>
        <div class="mb-2">
          <label class="form-label small fw-semibold">勘定科目</label>
          <select class="form-select form-select-sm" id="selCatTransit"></select>
        </div>
        ${_noteField()}
        <div class="mb-2">
          <label class="form-label small fw-semibold">領収書（任意）</label>
          <div class="d-flex gap-2 mb-2" id="previewArea-交通費"></div>
          <input type="file" class="d-none" id="fileInput-交通費" accept="image/*,.pdf" multiple>
          <button class="btn btn-outline-secondary btn-sm" id="btnFile-交通費">
            <i class="bi bi-folder2-open me-1"></i>ファイル選択
          </button>
        </div>
      </div>

      <!-- 自家用車タイプ -->
      <div id="form-自家用車" class="d-none">
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
        <div class="mb-2 d-flex align-items-center gap-2">
          <span class="small">合計：</span>
          <span class="fw-bold" id="lblCarTotal">0円</span>
        </div>
        <div class="mb-2">
          <label class="form-label small fw-semibold">勘定科目</label>
          <select class="form-select form-select-sm" id="selCatCar"></select>
        </div>
        ${_noteField()}
        <div class="mb-2">
          <label class="form-label small fw-semibold">地図・参考資料（任意）</label>
          <div class="d-flex gap-2 mb-2" id="previewArea-自家用車"></div>
          <input type="file" class="d-none" id="fileInput-自家用車" accept="image/*" multiple>
          <button class="btn btn-outline-secondary btn-sm" id="btnFile-自家用車">
            <i class="bi bi-folder2-open me-1"></i>ファイル選択
          </button>
        </div>
      </div>

    </div>
  </div>

  <!-- 提出ボタン -->
  <div class="d-grid gap-2 no-print">
    <button class="btn btn-primary" id="btnSubmit">
      <i class="bi bi-send me-1"></i>申請する
    </button>
  </div>

  <!-- 直近申請履歴 -->
  <div class="mt-4">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <h6 class="fw-bold mb-0"><i class="bi bi-clock-history me-1 text-secondary"></i>直近の申請</h6>
      <button class="btn btn-link btn-sm text-decoration-none" id="btnRefreshHistory">
        <i class="bi bi-arrow-clockwise"></i>
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
          <input type="number" class="form-control form-control-sm" id="inputAmount" min="0" placeholder="金額（円）">
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
  }

  function _populateSelects(el) {
    const opts = _cats.map(c => `<option value="${c}">${c}</option>`).join('');
    ['selCategory', 'selCatTransit', 'selCatCar'].forEach(id => {
      const s = el.querySelector(`#${id}`);
      if (s) s.innerHTML = opts || '<option value="">（勘定科目なし）</option>';
    });
    const ps = el.querySelector('#selPaySource');
    if (ps) {
      ps.innerHTML = '<option value="">支払元を選択</option>' +
        _paySources.map(p => `<option value="${p}">${p}</option>`).join('');
    }
  }

  function _bindTypeButtons(el) {
    el.querySelectorAll('[data-type]').forEach(btn => {
      btn.addEventListener('click', () => {
        _currentType = btn.dataset.type;
        _selectedFiles = [];
        el.querySelectorAll('[data-type]').forEach(b => {
          b.classList.toggle('btn-primary', b.dataset.type === _currentType);
          b.classList.toggle('btn-outline-secondary', b.dataset.type !== _currentType);
        });
        TYPES.forEach(t => {
          el.querySelector(`#form-${t}`)?.classList.toggle('d-none', t !== _currentType);
        });
      });
    });
  }

  function _bindFileInputs(el) {
    TYPES.forEach(type => {
      const fileInput = el.querySelector(`#fileInput-${type}`);
      if (!fileInput) return;

      // カメラボタン（領収書のみ）
      const camBtn = el.querySelector(`#btnCamera-${type}`);
      if (camBtn) {
        camBtn.addEventListener('click', () => {
          fileInput.setAttribute('capture', 'environment');
          fileInput.click();
        });
      }

      // ファイル選択ボタン
      const fileBtn = el.querySelector(`#btnFile-${type}`);
      if (fileBtn) {
        fileBtn.addEventListener('click', () => {
          fileInput.removeAttribute('capture');
          fileInput.click();
        });
      }

      fileInput.addEventListener('change', async e => {
        for (const file of e.target.files) {
          const base64 = await Drive.fileToBase64(file);
          const sizeOk = file.size <= 10 * 1024 * 1024; // 10MB上限
          if (!sizeOk) { App.showToast(`${file.name} は10MBを超えています`, 'warning'); continue; }
          _selectedFiles.push({ base64, mimeType: file.type, name: file.name });
          _addPreviewItem(el, type, base64, file.type, _selectedFiles.length - 1);
        }
        fileInput.value = '';
      });
    });

    // AI解析ボタン
    el.querySelector('#btnAnalyze')?.addEventListener('click', () => _runAiAnalysis(el));
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
    el.querySelector('#btnToggleSplit')?.addEventListener('click', () => {
      const single = el.querySelector('#singleLine');
      const split  = el.querySelector('#splitLines');
      const total  = el.querySelector('#splitTotal');
      const isSplit = !split.classList.contains('d-none');
      single.classList.toggle('d-none', !isSplit);
      split.classList.toggle('d-none', isSplit);
      total.classList.toggle('d-none', isSplit);
      if (!isSplit && split.children.length === 0) _addSplitRow(el);
    });
  }

  function _addSplitRow(el) {
    const container = el.querySelector('#splitLines');
    const row = document.createElement('div');
    row.className = 'split-row py-2 row g-2 align-items-center';
    row.innerHTML = `
      <div class="col-4"><input type="number" class="form-control form-control-sm split-amount" min="0" placeholder="金額"></div>
      <div class="col-6"><select class="form-select form-select-sm split-cat">
        ${_cats.map(c => `<option value="${c}">${c}</option>`).join('')}
      </select></div>
      <div class="col-2 text-end">
        <button class="btn btn-outline-danger btn-sm btn-del-row"><i class="bi bi-x"></i></button>
      </div>`;
    row.querySelector('.btn-del-row').addEventListener('click', () => { row.remove(); _calcSplitTotal(el); });
    row.querySelector('.split-amount').addEventListener('input', () => _calcSplitTotal(el));
    container.appendChild(row);

    const addBtn = el.querySelector('#btnAddSplitRow');
    if (!addBtn) {
      const btn = document.createElement('button');
      btn.id = 'btnAddSplitRow';
      btn.className = 'btn btn-outline-secondary btn-sm mt-1 w-100';
      btn.innerHTML = '<i class="bi bi-plus me-1"></i>行を追加';
      btn.addEventListener('click', () => _addSplitRow(el));
      container.after(btn);
    }
  }

  function _calcSplitTotal(el) {
    const total = Array.from(el.querySelectorAll('.split-amount'))
      .reduce((s, i) => s + (Number(i.value) || 0), 0);
    el.querySelector('#lblSplitTotal').textContent = total.toLocaleString();
  }

  function _bindCorpPay(el) {
    el.querySelector('#chkCorpPay')?.addEventListener('change', e => {
      el.querySelector('#corpPayDetails').classList.toggle('d-none', !e.target.checked);
    });
  }

  function _bindTransitCalc(el) {
    const calc = () => {
      const fare = Number(el.querySelector('#numTransitFare')?.value) || 0;
      const round = el.querySelector('#chkRoundTrip')?.checked ? 2 : 1;
      el.querySelector('#lblTransitTotal').textContent = (fare * round).toLocaleString() + '円';
    };
    el.querySelector('#numTransitFare')?.addEventListener('input', calc);
    el.querySelector('#chkRoundTrip')?.addEventListener('change', calc);

    el.querySelector('#btnYahooTransit')?.addEventListener('click', () => {
      const from = el.querySelector('#txtFrom')?.value.trim();
      const to   = el.querySelector('#txtTo')?.value.trim();
      if (!from || !to) return App.showToast('出発・到着駅を入力してください', 'warning');
      window.open(`https://transit.yahoo.co.jp/search/print?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&fromgid=&togid=&flatlon=&tlatlon=&via=&viacode=&y=&m=&d=&hh=&s=0&m2=00&type=1&ws=3&s=0&expkind=1&userpass=1&ws=3&prop=0&ticket=ic`, '_blank');
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

  async function _runAiAnalysis(el) {
    const files = _selectedFiles.filter(Boolean);
    if (files.length === 0) return App.showToast('ファイルを選択してから解析してください', 'warning');
    const btn = el.querySelector('#btnAnalyze');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>解析中...';
    try {
      const result = await Gemini.analyzeReceipt(files, _cats);
      if (result.date)  el.querySelector('#inputDate').value  = result.date;
      if (result.shop)  el.querySelector('#inputPlace').value = result.shop;
      if (result.invoice) el.querySelector('#inputInvoice').value = result.invoice;
      if (result.total_amount) el.querySelector('#inputAmount').value = result.total_amount;
      if (result.category) {
        const sel = el.querySelector('#selCategory');
        [...sel.options].forEach(o => o.selected = o.value === result.category);
      }
      // 外貨処理
      if (result.fx_currency && result.fx_amount) {
        App.showToast(`外貨検出: ${result.fx_currency} ${result.fx_amount}。為替レートを確認して金額を入力してください。`, 'warning');
      }
      App.showToast('AI解析完了。内容を確認してください', 'success');
    } catch (err) {
      App.showToast('AI解析エラー: ' + err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-stars me-1"></i>AI解析';
    }
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
        const ok = await App.confirm(`⚠️ ${dup}\nこのまま申請しますか？`);
        if (!ok) { App.hideLoading(); return; }
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
    const date  = el.querySelector('#inputDate')?.value;
    const place = el.querySelector('#inputPlace')?.value?.trim();

    if (!date)  { App.showToast('日付を入力してください', 'danger'); return null; }
    if (!place) { App.showToast('支払先を入力してください', 'danger'); return null; }

    let amount = 0, category = '', note = '';

    if (_currentType === '交通費') {
      const fare  = Number(el.querySelector('#numTransitFare')?.value) || 0;
      const round = el.querySelector('#chkRoundTrip')?.checked ? 2 : 1;
      amount   = fare * round;
      category = el.querySelector('#selCatTransit')?.value || '';
      note     = el.querySelector('#inputNote')?.value?.trim() || '';
      if (amount === 0) { App.showToast('運賃を入力してください', 'danger'); return null; }
    } else if (_currentType === '自家用車') {
      const km   = Number(el.querySelector('#numCarKm')?.value)  || 0;
      const rate = Number(el.querySelector('#numCarRate')?.value) || 20;
      amount   = Math.ceil(km * rate);
      category = el.querySelector('#selCatCar')?.value || '';
      note     = el.querySelector('#inputNote')?.value?.trim() || '';
      if (amount === 0) { App.showToast('距離を入力してください', 'danger'); return null; }
    } else {
      const isSplit = !el.querySelector('#splitLines')?.classList.contains('d-none');
      if (isSplit) {
        const rows = el.querySelectorAll('.split-row');
        amount   = Array.from(rows).reduce((s, r) => s + (Number(r.querySelector('.split-amount')?.value) || 0), 0);
        category = Array.from(rows).map(r => r.querySelector('.split-cat')?.value).join('/');
      } else {
        amount   = Number(el.querySelector('#inputAmount')?.value) || 0;
        category = el.querySelector('#selCategory')?.value || '';
      }
      note = el.querySelector('#inputNote')?.value?.trim() || '';
      if (amount === 0) { App.showToast('金額を入力してください', 'danger'); return null; }
    }

    const corpPay  = el.querySelector('#chkCorpPay')?.checked || false;
    const paySource = el.querySelector('#selPaySource')?.value || '';
    if (corpPay && !paySource) { App.showToast('会社払いの支払元を選択してください', 'danger'); return null; }

    return {
      date, place, amount, category, note,
      invoice:   el.querySelector('#inputInvoice')?.value?.trim() || '',
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
    const statusBadge = e.confirmed
      ? `<span class="badge badge-confirmed">承認済</span>`
      : e.aiAudit?.startsWith('⛔')
      ? `<span class="badge badge-duplicate">要確認</span>`
      : `<span class="badge badge-pending">未確認</span>`;

    const btns = e.confirmed ? '' : `
      <button class="btn btn-outline-secondary btn-sm btn-edit-history" data-id="${e.id}"><i class="bi bi-pencil"></i></button>
      <button class="btn btn-outline-danger btn-sm btn-del-history" data-id="${e.id}"><i class="bi bi-trash"></i></button>`;

    const imageLink = e.imageLinks
      ? `<a href="${e.imageLinks.split(',')[0].trim()}" target="_blank" class="btn btn-outline-primary btn-sm">
          <i class="bi bi-image me-1"></i>証票</a>`
      : '';

    return `
    <div class="card mb-2 expense-card ${e.confirmed ? 'confirmed' : ''}">
      <div class="card-body py-2 px-3">
        <div class="d-flex justify-content-between align-items-start mb-1">
          <div>
            <span class="fw-semibold small">${_escape(e.place)}</span>
            <span class="text-muted small ms-2">${e.date}</span>
          </div>
          ${statusBadge}
        </div>
        <div class="d-flex justify-content-between align-items-center">
          <div class="small">
            <span class="list-amount">¥${e.amount.toLocaleString()}</span>
            <span class="text-muted ms-2">${_escape(e.category)}</span>
            <span class="badge bg-light text-dark ms-1" style="font-size:0.65rem;">${e.type}</span>
          </div>
          <div class="d-flex gap-1">
            ${imageLink}
            ${btns}
          </div>
        </div>
      </div>
    </div>`;
  }

  function _startEdit(el, id, expenses) {
    const e = expenses.find(x => x.id === id);
    if (!e) return;
    _editId = id;
    _existingUrls = e.imageLinks ? e.imageLinks.split(',').map(s => s.trim()).filter(Boolean) : [];
    _existingHash = e.imageHash || '';

    // フォームに値を復元
    const typeBtn = el.querySelector(`[data-type="${e.type}"]`);
    if (typeBtn) typeBtn.click();

    setTimeout(() => {
      el.querySelector('#inputDate').value  = e.date;
      el.querySelector('#inputPlace').value = e.place;
      if (el.querySelector('#inputInvoice')) el.querySelector('#inputInvoice').value = e.invoice || '';
      el.querySelector('#inputNote').value  = e.note || '';
      const sel = el.querySelector('#selCategory');
      if (sel) [...sel.options].forEach(o => o.selected = o.value === e.category);
      el.querySelector('#inputAmount').value = e.amount;
      el.querySelector('#editBanner')?.classList.remove('d-none');
      const btn = el.querySelector('#btnSubmit');
      if (btn) { btn.textContent = '上書き保存'; btn.className = 'btn btn-warning'; }
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
    if (btn) { btn.innerHTML = '<i class="bi bi-send me-1"></i>申請する'; btn.className = 'btn btn-primary'; }
    ['領収書', '領収書なし', '交通費', '自家用車'].forEach(t => {
      el.querySelector(`#previewArea-${t}`)?.replaceChildren();
    });
    el.querySelector('#inputPlace').value  = '';
    el.querySelector('#inputAmount').value = '';
    el.querySelector('#inputNote').value   = '';
    el.querySelector('#chkCorpPay').checked = false;
    el.querySelector('#corpPayDetails')?.classList.add('d-none');
    el.querySelector('#inputDate').value = new Date().toISOString().split('T')[0];
    if (el.querySelector('#inputInvoice')) el.querySelector('#inputInvoice').value = '';
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  return { render, bindEvents };
})();
