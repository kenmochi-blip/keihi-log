/**
 * 申請フォームビュー
 * 既存GASアプリの index.html をSPA用に移植
 * 電帳法対応：申請日時はサーバー時刻を使用、画像ハッシュはSHA-256
 */
const SubmitView = (() => {

  // フォーム状態
  let _selectedFiles    = []; // [{base64, mimeType, name}]
  let _compressedFiles  = []; // 圧縮済みキャッシュ [{base64, mimeType, name}]
  let _compressPromise  = null; // 圧縮の並列実行プロミス
  let _existingUrls     = []; // 編集時の既存証票URL
  let _existingHash     = '';
  let _editId           = null;
  let _withholdingAmount = 0; // AIが検出した源泉徴収税額
  let _currentType      = '領収書';
  let _cats             = [];
  let _paySources       = [];
  let _customFlags      = [];
  let _pendingEdit   = null; // 一覧表からの編集キュー {id, expenses}
  let _returnAfterEdit = null; // 編集保存後の遷移先ビュー名
  let _historyAll      = []; // 自分の全履歴（ソート済）
  let _historyExpenses = []; // 全経費データ（編集用）
  let _historyShown    = 15;
  const _HIST_PAGE     = 15;

  // プリフェッチ状態
  let _aiAutoPromise  = null; // 写真選択後に自動開始するAI解析のPromise
  let _aiAutoVersion  = 0;   // 写真が差し替えられた際に古い結果を破棄するためのバージョン番号
  let _prefetchedTime = null; // { jst: string, fetchedAt: number } 申請時刻のプリフェッチ

  const TYPES = ['領収書', '領収書なし', '電車/バス', '自家用車'];
  const _typeId = t => t.replace(/\//g, '');
  const CAR_RATE_KEY = 'keihi_car_rate';

  function render() {
    const ssId   = localStorage.getItem('keihi_sheet_id');
    const licKey = localStorage.getItem('keihi_license_key');
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const setupIncomplete = !isDemo && (!ssId || !licKey);

    return `
<div class="pt-3">

  <!-- 初期設定未完了バナー -->
  ${setupIncomplete ? `
  <div class="alert alert-warning d-flex align-items-center gap-2 py-2 mb-3" role="alert">
    <i class="bi bi-exclamation-triangle-fill flex-shrink-0"></i>
    <div class="small">初期設定が完了していません。<strong>設定タブ</strong>から初期設定を完了してください。</div>
  </div>` : ''}

  <!-- 編集モードバナー -->
  <div id="editBanner" class="edit-banner d-none mb-3">
    <i class="bi bi-pencil-square me-1"></i>修正モード
    <button class="btn btn-link btn-sm text-muted p-0 ms-2" id="btnCancelEdit">キャンセル</button>
  </div>

  <!-- ヒーローゾーン（証票撮影/選択） -->
  <div class="hero-zone mb-3" id="heroZone">
    <input type="file" class="d-none" id="camInput-領収書" accept="image/*" capture="environment">
    <input type="file" class="d-none" id="fileInput-領収書" accept="*/*" multiple>
    <div id="heroDefault">
      <div class="hero-icon-wrap">
        <i class="bi bi-camera-fill"></i>
      </div>
      <div class="hero-title">領収書を撮影 / ファイルを選択</div>
      <button class="hero-btn-camera" id="btnCamera-領収書">
        <i class="bi bi-camera-fill"></i>カメラで領収書を撮影
      </button>
      <button class="hero-btn-file" id="btnFile-領収書">
        <i class="bi bi-folder-fill"></i>ファイルから証票を選択 or ドロップ
      </button>
    </div>
    <div id="heroPreview" class="d-none text-start">
      <div class="d-flex align-items-start gap-2 flex-wrap">
        <div class="d-flex flex-wrap gap-2 flex-1" id="previewArea-領収書"></div>
        <button class="upload-card-sm" style="flex-shrink:0;" id="btnAddMore">
          <i class="bi bi-plus me-1"></i>追加
        </button>
      </div>
    </div>
  </div>

  <!-- AIボタン（ファイル選択後のみ表示） -->
  <button class="btn-ai d-none mb-3" id="btnAnalyze">
    <i class="bi bi-stars me-2"></i>AIで読み取る
  </button>

  <!-- AI解析後フォーム（領収書） -->
  <div id="receiptFields" class="d-none">
    ${_dateField()}
    ${_placeField('支払先（店名・会社名）')}
    ${_invoiceField()}
    ${_amountSectionNoReceipt()}
    ${_noteField()}
  </div>

  <!-- その他のタイプの申請 -->
  <div class="card border shadow-sm mb-3" id="subtypeCard" style="border-color:#dee2e6 !important;">
    <div class="card-body py-3 px-3">
      <div class="subtype-divider mb-3">その他のタイプの申請</div>
      <div class="subtype-row">
        <button class="subtype-pill" data-type="電車/バス">
          <i class="bi bi-train-front-fill"></i>電車/バス
        </button>
        <button class="subtype-pill" data-type="自家用車">
          <i class="bi bi-car-front-fill"></i>自家用車
        </button>
        <button class="subtype-pill" data-type="領収書なし">
          <i class="bi bi-pencil-square"></i>領収書なし
        </button>
      </div>
    </div>
  </div>

  <!-- 領収書なし -->
  <div id="panel-領収書なし" class="d-none">
    ${_dateField()}
    ${_placeField('支払先・目的')}
    ${_amountSectionNoReceipt()}
    <div class="mb-2">
      <label class="form-label small fw-semibold">理由・詳細 <span class="text-danger">*</span></label>
      <textarea class="form-control form-control-sm" id="txtReason" rows="3"
        placeholder="領収書がない理由を具体的に記入してください"></textarea>
    </div>
    <div class="mb-2">
      <label class="form-label small fw-semibold">参考資料（任意）</label>
      <div class="d-flex flex-wrap gap-2 mb-2" id="previewArea-領収書なし"></div>
      <input type="file" class="d-none" id="camInput-領収書なし" accept="image/*" capture="environment">
      <input type="file" class="d-none" id="fileInput-領収書なし" accept="*/*" multiple>
      <div class="d-flex gap-2">
        <button class="upload-card-sm flex-fill" id="btnCamera-領収書なし">
          <i class="bi bi-camera-fill"></i>カメラ
        </button>
        <button class="upload-card-sm flex-fill" id="btnFile-領収書なし">
          <i class="bi bi-folder-fill"></i>ファイル
        </button>
      </div>
    </div>
  </div>

  <!-- 電車/バス -->
  <div id="panel-電車バス" class="d-none">
    ${_dateField()}
    <div class="row g-2 mb-2">
      <div class="col-6">
        <label class="form-label small fw-semibold">出発駅・バス停</label>
        <input type="text" class="form-control form-control-sm" id="txtFrom">
      </div>
      <div class="col-6">
        <label class="form-label small fw-semibold">到着駅・バス停</label>
        <input type="text" class="form-control form-control-sm" id="txtTo">
      </div>
    </div>
    <button class="btn btn-outline-secondary btn-sm w-100" id="btnYahooTransit">
      <i class="bi bi-search me-1"></i>料金を検索して入力
    </button>
    <div id="transitResult" class="d-none mt-2 mb-3 p-2 rounded" style="background:#f0f7ff;border:1px solid #c8e0f8;font-size:0.82rem;">
      <div id="transitResultRoute" class="fw-semibold mb-1"></div>
      <div id="transitResultFare" class="text-primary fw-bold mb-1"></div>
      <div class="d-flex gap-3">
        <a id="transitResultLinkYahoo" href="#" target="_blank" class="btn btn-link btn-sm p-0 text-decoration-none">
          <i class="bi bi-box-arrow-up-right me-1"></i>Yahoo乗換で確認
        </a>
        <a id="transitResultLinkGoogle" href="#" target="_blank" class="btn btn-link btn-sm p-0 text-decoration-none">
          <i class="bi bi-map me-1"></i>Googleマップで確認
        </a>
      </div>
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
      <div class="d-flex flex-wrap gap-2 mb-2" id="previewArea-電車バス"></div>
      <input type="file" class="d-none" id="camInput-電車バス" accept="image/*" capture="environment">
      <input type="file" class="d-none" id="fileInput-電車バス" accept="*/*" multiple>
      <div class="d-flex gap-2">
        <button class="upload-card-sm flex-fill" id="btnCamera-電車バス">
          <i class="bi bi-camera-fill"></i>カメラ
        </button>
        <button class="upload-card-sm flex-fill" id="btnFile-電車バス">
          <i class="bi bi-folder-fill"></i>ファイル
        </button>
      </div>
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
        <label class="form-label small fw-semibold">レート（円/km） <a href="/faq#q307" class="text-muted" style="font-size:0.78rem;" title="キロ単価について"><i class="bi bi-question-circle"></i></a></label>
        <input type="number" class="form-control form-control-sm" id="numCarRate" min="1" step="1"
          value="${localStorage.getItem(CAR_RATE_KEY) || 20}" readonly>
        <div class="form-text small text-muted d-none" id="carRateHint">管理者が設定します</div>
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
      <input type="file" class="d-none" id="camInput-自家用車" accept="image/*" capture="environment">
      <input type="file" class="d-none" id="fileInput-自家用車" accept="*/*" multiple>
      <div class="d-flex gap-2">
        <button class="upload-card-sm flex-fill" id="btnCamera-自家用車">
          <i class="bi bi-camera-fill"></i>カメラ
        </button>
        <button class="upload-card-sm flex-fill" id="btnFile-自家用車">
          <i class="bi bi-folder-fill"></i>ファイル
        </button>
      </div>
    </div>
  </div>

  <!-- カスタムフラグ -->
  <div id="customFlagWrap" class="d-none mb-3">
    <label class="form-label small fw-semibold">カスタムフラグ <span class="text-muted fw-normal">（任意）</span> <a href="/faq#q109" class="text-muted" style="font-size:0.78rem;" title="カスタムフラグについて"><i class="bi bi-question-circle"></i></a></label>
    <select class="form-select form-select-sm" id="selCustomFlag">
      <option value="">未設定</option>
    </select>
  </div>

  <!-- 統合送信カード（初期は非表示） -->
  <div class="submit-unit d-none mt-3 mb-4 no-print" id="submitUnit">
    <input type="checkbox" id="chkCorpPay" class="d-none">
    <div class="submit-unit-inner">
      <div class="pay-segment" id="paySegMain">
        <button type="button" class="pay-seg-btn active" id="btnPaySelf">
          <i class="bi bi-person-fill"></i>自分が立替（精算あり）
        </button>
        <button type="button" class="pay-seg-btn" id="btnPayCorp">
          <i class="bi bi-building"></i>会社払い（精算なし）
        </button>
      </div>
      <div id="corpPayDetails" class="d-none submit-unit-source">
        <label class="form-label small fw-semibold mb-1">支払元 <span class="text-danger">*</span></label>
        <select class="form-select form-select-sm" id="selPaySource">
          <option value="">支払元を選択</option>
        </select>
      </div>
    </div>
    <div class="submit-unit-inner">
      <button class="submit-unit-action" id="btnSubmit">
        <i class="bi bi-send me-1"></i>登録する
      </button>
    </div>
  </div>

  <!-- 直近履歴 -->
  <hr class="mt-4 mb-3">
  <div id="historySection" class="mb-4">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <h6 class="fw-bold mb-0">直近の自分の履歴</h6>
      <div class="d-flex gap-2 align-items-center">
        <button class="btn btn-link btn-sm text-decoration-none text-secondary p-0" id="btnRefreshHistory">
          <i class="bi bi-arrow-clockwise me-1"></i>更新
        </button>
      </div>
    </div>
    <div id="historyList"><div class="text-muted small text-center py-3">読み込み中...</div></div>
  </div>

  <!-- 訂正・削除防止規程（確定済みの場合のみ表示） -->
  ${(() => {
    try {
      const reg = (typeof Demo !== 'undefined' && Demo.isActive())
        ? Demo.REGULATION
        : JSON.parse(localStorage.getItem('keihi_regulation') || 'null');
      if (!reg?.confirmedAt) return '';
      const text = SettingsView.buildRegulationText(reg);
      return `
  <div class="accordion mt-3 mb-4" id="regulationAcc">
    <div class="accordion-item border">
      <h2 class="accordion-header">
        <button class="accordion-button collapsed py-2 small" type="button"
          data-bs-toggle="collapse" data-bs-target="#regulationBody">
          <i class="bi bi-file-text me-2 text-success"></i>
          訂正・削除防止規程（電帳法）— 確定済み ${SettingsView._formatConfirmedAt ? SettingsView._formatConfirmedAt(reg.confirmedAt) : reg.confirmedAt.slice(0, 10)}
        </button>
      </h2>
      <div id="regulationBody" class="accordion-collapse collapse">
        <div class="accordion-body p-3">
          <pre style="font-size:0.72rem;white-space:pre-wrap;font-family:inherit;color:#333;">${text.replace(/</g,'&lt;')}</pre>
        </div>
      </div>
    </div>
  </div>`;
    } catch (_) { return ''; }
  })()}

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
        <div class="d-flex align-items-center gap-2">
          <button class="btn btn-link btn-sm p-0 text-decoration-none btn-toggle-split">明細分割</button>
          <a href="/faq#q302" class="text-muted" style="font-size:0.78rem;" title="明細分割について"><i class="bi bi-question-circle"></i></a>
        </div>
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
      <div class="d-flex align-items-center gap-1 mt-1">
        <span class="text-muted" style="font-size:0.72rem;">税区分:</span>
        <select id="selTaxRate" class="form-select form-select-sm" style="width:auto;font-size:0.72rem;padding-top:0.1rem;padding-bottom:0.1rem;">
          <option value="課税10%">課税10%</option>
          <option value="課税8%">課税8%（軽減税率）</option>
          <option value="混在">混在（複数税率）</option>
          <option value="非課税">非課税</option>
          <option value="不課税">不課税</option>
        </select>
      </div>
    </div>`;
  }

  function _amountSectionNoReceipt() {
    return `
    <div class="mb-2">
      <label class="form-label small fw-semibold mb-1">金額・勘定科目 <span class="text-danger">*</span></label>
      <div id="splitLines"></div>
      <div id="splitTotal" class="text-end text-muted small mt-1">合計: <span id="lblSplitTotal">0</span>円</div>
    </div>`;
  }

  async function bindEvents(el, opts = {}) {
    // マスタデータ読み込み
    try {
      const master = await App.getMaster();
      _cats        = master.categories;
      _paySources  = master.paySources;
      _customFlags = master.customFlags || [];
    } catch (_) {}

    // fromCache=true のとき：キャッシュ済みHTMLに正しい選択肢・選択値が含まれるため再描画不要
    if (!opts.fromCache) _populateSelects(el);
    _bindAmountInputs(el);
    _bindSubtypePills(el);
    _bindFileInputs(el);
    _bindSplitToggle(el);
    // 領収書・領収書なしは常に分割モード → 初期1行を追加
    [el.querySelector('#receiptFields'), el.querySelector('#panel-領収書なし')].forEach(pnl => {
      if (!pnl) return;
      const s = pnl.querySelector('#splitLines');
      if (s && s.children.length === 0) _addSplitRowTo(s, pnl);
    });
    _bindCorpPay(el);
    _bindTransitCalc(el);
    _initCarRate(el);
    _bindCarCalc(el);
    _bindSubmit(el);
    el.querySelector('#btnRefreshHistory')?.addEventListener('click', () => _loadHistory(el, true));
    el.querySelector('#btnCancelEdit')?.addEventListener('click', () => _cancelEdit(el));
    el.querySelector('#btnAddMore')?.addEventListener('click', () => el.querySelector('#fileInput-領収書')?.click());
    // fromCache=true のとき：スワイプ由来でキャッシュ済みHTMLが表示されているため再ロード不要
    // 手動リフレッシュボタンはいつでも使える
    if (!opts.fromCache) _loadHistory(el);

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
    return el.querySelector(`[id="panel-${_typeId(_currentType)}"]`) || el;
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

    // カスタムフラグ：選択肢を埋める（表示は submitUnit と連動するため初期は隠したまま）
    const cfWrap = el.querySelector('#customFlagWrap');
    const cfSel  = el.querySelector('#selCustomFlag');
    if (_customFlags.length > 0 && cfSel) {
      cfSel.innerHTML = '<option value="">未設定</option>' +
        _customFlags.map(f => `<option value="${f}">${f}</option>`).join('');
    }
    if (cfWrap) cfWrap.classList.add('d-none');
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

function _bindSubtypePills(el) {
  el.querySelectorAll('.subtype-pill[data-type]').forEach(pill => {
    pill.addEventListener('click', () => {
      const type = pill.dataset.type;
      const subtypeCard = el.querySelector('#subtypeCard');
      if (_currentType === type) {
        // 同じピルを再クリック → 解除、領収書モードに戻る
        _currentType = '領収書';
        _selectedFiles = []; _compressedFiles = []; _compressPromise = null;
        _aiAutoPromise = null; _prefetchedTime = null; ++_aiAutoVersion;
        el.querySelectorAll('.subtype-pill').forEach(p => p.classList.remove('active'));
        ['領収書なし', '電車/バス', '自家用車'].forEach(t => {
          el.querySelector(`#panel-${_typeId(t)}`)?.classList.add('d-none');
        });
        el.querySelector('#heroZone')?.classList.remove('d-none');
        _setSubmitUnitVisible(el, false);
        if (subtypeCard) subtypeCard.classList.remove('subtype-active');
        return;
      }
      _currentType = type;
      _selectedFiles = []; _compressedFiles = []; _compressPromise = null;
      _aiAutoPromise = null; _prefetchedTime = null; ++_aiAutoVersion;
      el.querySelectorAll('.subtype-pill').forEach(p => p.classList.toggle('active', p === pill));
      ['領収書なし', '電車/バス', '自家用車'].forEach(t => {
        el.querySelector(`#panel-${_typeId(t)}`)?.classList.toggle('d-none', t !== type);
      });
      el.querySelector('#heroZone')?.classList.add('d-none');
      el.querySelector('#btnAnalyze')?.classList.add('d-none');
      el.querySelector('#receiptFields')?.classList.add('d-none');
      _setSubmitUnitVisible(el, true);
      if (subtypeCard) subtypeCard.classList.add('subtype-active');
    });
  });
}

  function _bindFileInputs(el) {
    const processFiles = async (el, type, files) => {
      // 領収書の場合：base64変換を待たずに即座にAIボタン画面へ遷移
      if (type === '領収書' && files.length > 0) {
        el.querySelector('#heroDefault')?.classList.add('d-none');
        el.querySelector('#heroPreview')?.classList.remove('d-none');
        el.querySelector('#btnAnalyze')?.classList.remove('d-none');
      }

      for (const file of files) {
        if (file.size > 10 * 1024 * 1024) { App.showToast(`${file.name} は10MBを超えています`, 'warning'); continue; }
        const base64 = await Drive.fileToBase64(file);
        _selectedFiles.push({ base64, mimeType: file.type, name: file.name });
        _addPreviewItem(el, type, base64, file.type, _selectedFiles.length - 1);
      }

      // 全ファイルがサイズエラーで追加されなかった場合はUIを元に戻す
      if (type === '領収書' && _selectedFiles.filter(Boolean).length === 0 && _existingUrls.filter(Boolean).length === 0) {
        el.querySelector('#heroDefault')?.classList.remove('d-none');
        el.querySelector('#heroPreview')?.classList.add('d-none');
        el.querySelector('#btnAnalyze')?.classList.add('d-none');
        return;
      }

      // 領収書タイプの場合：写真選択直後にバックグラウンドで先読みを開始
      if (type === '領収書' && _selectedFiles.length > 0) {
        _compressedFiles = [];
        _aiAutoPromise = null;
        const version = ++_aiAutoVersion; // 写真差し替え時に古い結果を捨てるバージョン
        _compressPromise = Gemini.precompress(_selectedFiles);
        Gemini.warmup();

        // 圧縮完了次第 AI 解析をバックグラウンドで先行実行（ボタン押下時にすぐ結果を返すため）
        _compressPromise.then(compressed => {
          _compressedFiles = compressed;
          if (version !== _aiAutoVersion) return; // 別の写真に差し替えられた場合は破棄
          _aiAutoPromise = Gemini.analyzeReceipt(compressed, _cats, false).catch(() => null);
        });

        // 申請時刻をプリフェッチ（申請ボタン押下時の待ちをゼロにする）
        _prefetchServerTime();
      }
    };

    TYPES.forEach(type => {
      const tid = _typeId(type);
      const fileInput = el.querySelector(`#fileInput-${tid}`);
      if (!fileInput) return;

      // カメラボタン：専用input（capture="environment"）を使いシステム選択ダイアログを回避
      const camInput = el.querySelector(`#camInput-${tid}`);
      const camBtn   = el.querySelector(`#btnCamera-${tid}`);
      if (camBtn && camInput) {
        camBtn.addEventListener('click', () => camInput.click());
        const onCamChange = e => {
          if (!e.target.files?.length) return;
          const files = Array.from(e.target.files);
          e.target.value = '';
          processFiles(el, type, files).catch(err => App.showToast('ファイル読み込みエラー: ' + err.message, 'danger'));
        };
        camInput.addEventListener('change', onCamChange);
        camInput.addEventListener('input', onCamChange);
      }

      // ファイルボタン：通常のファイル選択
      const fileBtn = el.querySelector(`#btnFile-${tid}`);
      if (fileBtn) fileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => { processFiles(el, type, e.target.files); e.target.value = ''; });

      // ドラッグ＆ドロップ（領収書ヒーローゾーン全体 or 参考資料エリア）
      const dropZone = type === '領収書'
        ? el.querySelector('#heroZone')
        : el.querySelector(`#previewArea-${_typeId(type)}`)?.closest('.mb-2') ?? null;
      if (!dropZone) return;

      dropZone.addEventListener('dragover', e => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
      });
      dropZone.addEventListener('dragleave', e => {
        if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
      });
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = Array.from(e.dataTransfer.files);
        if (files.length) processFiles(el, type, files);
      });
    });

    el.querySelector('#btnAnalyze')?.addEventListener('click', () => _runAiAnalysis(el));
  }

  function _addPreviewItem(el, type, base64, mimeType, idx) {
    const area = el.querySelector(`#previewArea-${_typeId(type)}`);
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
      if (type === '領収書') {
        const area2 = el.querySelector('#previewArea-領収書');
        if (area2 && area2.children.length === 0 && _existingUrls.filter(Boolean).length === 0) {
          el.querySelector('#heroDefault')?.classList.remove('d-none');
          el.querySelector('#heroPreview')?.classList.add('d-none');
          el.querySelector('#btnAnalyze')?.classList.add('d-none');
        }
      }
    });
    area.appendChild(div);
  }

  /** 編集モード開始時に既存証票URLをプレビューエリアに表示する */
  function _renderExistingUrlPreviews(el, type) {
    const area = el.querySelector(`#previewArea-${_typeId(type)}`);
    if (!area) return;
    area.replaceChildren();
    _existingUrls.forEach((url, i) => {
      if (!url) return;
      const div = document.createElement('div');
      div.className = 'file-preview-item';
      div.dataset.existingIdx = i;
      // サムネイル取得はCORSで失敗するためアイコン+リンクで表示
      div.innerHTML =
        `<a href="${url}" target="_blank" rel="noopener"
            style="display:flex;align-items:center;justify-content:center;
                   width:80px;height:80px;border-radius:4px;background:#f0f4ff;
                   border:1px solid #c8d8f8;text-decoration:none;flex-direction:column;gap:4px;">
           <i class="bi bi-file-earmark-image" style="font-size:1.8rem;color:#4a90d9;"></i>
           <span style="font-size:0.6rem;color:#555;">証票を開く</span>
         </a>
         <button class="remove-btn" data-existing-idx="${i}">✕</button>`;
      div.querySelector('.remove-btn').addEventListener('click', () => {
        _existingUrls[i] = null;
        div.remove();
      });
      area.appendChild(div);
    });
  }

  function _bindSplitToggle(el) {
    // querySelectorAll で全パネルのトグルボタンにバインド
    el.querySelectorAll('.btn-toggle-split').forEach(btn => {
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

  const _TAX_OPTIONS = [
    ['課税10%', '課税10%'],
    ['課税8%',  '課税8%（軽減）'],
    ['非課税',  '非課税'],
    ['不課税',  '不課税'],
  ];

  function _addSplitRowTo(container, pnl) {
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'split-row py-2 border-bottom border-light-subtle';
    row.innerHTML = `
      <div class="row g-1 align-items-center mb-1">
        <div class="col"><input type="text" inputmode="numeric" class="form-control form-control-sm split-amount amount-input" placeholder="金額"></div>
        <div class="col-auto"><button class="btn btn-outline-danger btn-sm btn-del-row"><i class="bi bi-x"></i></button></div>
      </div>
      <div class="row g-1">
        <div class="col-7"><select class="form-select form-select-sm split-cat">
          ${_cats.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select></div>
        <div class="col-5"><select class="form-select form-select-sm split-tax">
          ${_TAX_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select></div>
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
    function setCorpPay(isCorp) {
      const chk = el.querySelector('#chkCorpPay');
      if (chk) chk.checked = isCorp;
      el.querySelector('#btnPaySelf')?.classList.toggle('active', !isCorp);
      el.querySelector('#btnPayCorp')?.classList.toggle('active', isCorp);
      const details = el.querySelector('#corpPayDetails');
      if (details) details.classList.toggle('d-none', !isCorp);
      if (isCorp) {
        const sel = el.querySelector('#selPaySource');
        if (sel && !sel.value && _paySources.length > 0) sel.value = _paySources[0];
      }
    }
    el.querySelector('#btnPaySelf')?.addEventListener('click', () => setCorpPay(false));
    el.querySelector('#btnPayCorp')?.addEventListener('click', () => setCorpPay(true));
  }

  function _bindTransitCalc(el) {
    const calcTotal = () => {
      const raw  = (el.querySelector('#numTransitFare')?.value || '').replace(/[^\d]/g, '');
      const fare = Number(raw) || 0;
      const round = el.querySelector('#chkRoundTrip')?.checked ? 2 : 1;
      el.querySelector('#lblTransitTotal').textContent = (fare * round).toLocaleString() + '円';
    };
    el.querySelector('#numTransitFare')?.addEventListener('input', calcTotal);
    el.querySelector('#chkRoundTrip')?.addEventListener('change', calcTotal);

    el.querySelector('#btnYahooTransit')?.addEventListener('click', async () => {
      const from = el.querySelector('#txtFrom')?.value.trim();
      const to   = el.querySelector('#txtTo')?.value.trim();
      if (!from || !to) return App.showToast('出発駅・バス停と到着駅・バス停を入力してください', 'warning');

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

        const yahooUrl = `https://transit.yahoo.co.jp/search/result?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&type=1&expkind=1&userpass=1&ticket=ic&shin=1&seat=1`;
        const googleUrl = `https://www.google.com/maps/dir/${encodeURIComponent(from)}/${encodeURIComponent(to)}`;

        if (!resp.ok || !data.fare) {
          App.showToast(data.error || '運賃を取得できませんでした。リンクから手動で確認してください', 'warning');
          if (resultDiv) {
            el.querySelector('#transitResultRoute').textContent = `${from} → ${to}`;
            el.querySelector('#transitResultFare').textContent = '運賃を取得できませんでした';
            el.querySelector('#transitResultFare').className = 'text-warning fw-bold mb-1';
            const linkYahoo = el.querySelector('#transitResultLinkYahoo');
            if (linkYahoo) linkYahoo.href = data?.yahooUrl || yahooUrl;
            const linkGoogle = el.querySelector('#transitResultLinkGoogle');
            if (linkGoogle) linkGoogle.href = data?.resultUrl || googleUrl;
            resultDiv.classList.remove('d-none');
          }
          return;
        }

        const fareInput = el.querySelector('#numTransitFare');
        if (fareInput) fareInput.value = data.fare.toLocaleString('ja-JP');
        calcTotal();

        if (resultDiv) {
          const transfers = data.transfers?.length ? data.transfers.join(' → ') : null;
          const routeText = transfers ? `${from} → ${transfers} → ${to}` : `${from} → ${to}`;
          el.querySelector('#transitResultRoute').textContent = routeText;
          el.querySelector('#transitResultFare').textContent =
            `最安値（IC）: ¥${data.fare.toLocaleString()} ／片道`;
          el.querySelector('#transitResultFare').className = 'text-primary fw-bold mb-1';
          const linkGoogle = el.querySelector('#transitResultLinkGoogle');
          if (linkGoogle) linkGoogle.href = data.resultUrl || googleUrl;
          const linkYahoo = el.querySelector('#transitResultLinkYahoo');
          if (linkYahoo) linkYahoo.href = data.yahooUrl || yahooUrl;
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

  async function _initCarRate(el) {
    const isAdmin = App.isAdmin();
    const rateInput = el.querySelector('#numCarRate');
    const rateHint  = el.querySelector('#carRateHint');
    if (!rateInput) return;

    // 登録画面では常にreadonly（設定タブから変更）
    rateInput.readOnly = true;
    rateInput.classList.add('bg-light');
    if (rateHint) rateHint.classList.remove('d-none');

    // シートから最新のレートを取得（localStorageをフォールバックとして使用）
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    if (!isDemo) {
      try {
        const sheetRate = await Sheets.readSetting('B7');
        if (sheetRate && !isNaN(Number(sheetRate)) && Number(sheetRate) >= 1) {
          rateInput.value = Number(sheetRate);
          localStorage.setItem(CAR_RATE_KEY, sheetRate);
        }
      } catch (_) {}
    }
  }

  function _bindCarCalc(el) {
    const calc = () => {
      const km   = Number(el.querySelector('#numCarKm')?.value)   || 0;
      const rate = Number(el.querySelector('#numCarRate')?.value)  || 20;
      el.querySelector('#lblCarTotal').textContent = Math.ceil(km * rate).toLocaleString() + '円';
    };
    el.querySelector('#numCarKm')?.addEventListener('input', calc);
  }

  /** 為替レート取得（複数APIを順に試す） */
  async function _fetchExchangeRate(from, to, date = null) {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    // date が指定された場合は過去レート、なければ当日レートを取得
    // 週末・祝日は各APIが直近営業日に自動フォールバックする
    const dateStr = date || 'latest';

    // 1. CDN-backed currency API（CORS確実、無料）
    try {
      const resp = await fetch(
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dateStr}/v1/currencies/${f}.json`
      );
      if (resp.ok) {
        const data = await resp.json();
        const rate = data[f]?.[t];
        if (rate) return rate;
      }
    } catch (_) {}

    // 2. Frankfurter dev（過去レート対応）
    try {
      const endpoint = date ? date : 'latest';
      const resp = await fetch(
        `https://api.frankfurter.dev/v1/${endpoint}?base=${from.toUpperCase()}&symbols=${to.toUpperCase()}`
      );
      if (resp.ok) {
        const data = await resp.json();
        const rate = data.rates?.[to.toUpperCase()];
        if (rate) return rate;
      }
    } catch (_) {}

    // 3. ExchangeRate-API 無料枠（最新レートのみ対応）
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

  async function _downloadExistingForAnalysis() {
    const results = [];
    for (const url of _existingUrls.filter(Boolean)) {
      const fileId = url.match(/\/d\/([^/?]+)/)?.[1];
      if (!fileId) { console.warn('[download existing] fileId not found in URL:', url); continue; }
      try {
        const resp = await Auth.authFetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`
        );
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.warn(`[download existing] ${resp.status} ${resp.statusText}`, errText);
          continue;
        }
        const blob = await resp.blob();
        const base64 = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
        results.push({ base64, mimeType: blob.type, name: fileId });
      } catch (e) { console.warn('[download existing]', e); }
    }
    return results;
  }

  async function _runAiAnalysis(el) {
    let files = _selectedFiles.filter(Boolean);
    const btn = el.querySelector('#btnAnalyze');
    if (btn?.disabled) return;

    if (files.length === 0 && _existingUrls.filter(Boolean).length > 0) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>ダウンロード中...';
      try {
        files = await _downloadExistingForAnalysis();
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-stars me-2"></i>AIで読み取る';
      }
      if (files.length === 0) {
        // Drive API でアクセスできない場合（drive.file スコープ制限）
        // 証票リンクを開いて手動で再選択するよう案内する
        const existingUrl = _existingUrls.filter(Boolean)[0];
        const safeUrl = existingUrl ? existingUrl.replace(/[<>"'&]/g, '') : '';
        const msg = safeUrl
          ? `証票ファイルに直接アクセスできません。<a href="${safeUrl}" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline;">証票を開いてダウンロード</a>後、「ファイル」から再選択してください。`
          : '証票ファイルにアクセスできません。ファイルを再選択してください。';
        App.showToast(msg, 'warning', 8000);
        return;
      }
    }

    if (files.length === 0) return App.showToast('ファイルを選択してから解析してください', 'warning');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>解析中...';
    try {
      let result = null;

      // バックグラウンド解析が完了済み or 実行中の場合はその結果を使用
      // → 完了済みなら await は即時 return（待ち時間ゼロ）
      // → 実行中なら残り時間だけ待つ（フルで待つより大幅に短い）
      if (_aiAutoPromise) {
        const savedPromise = _aiAutoPromise;
        _aiAutoPromise = null;
        result = await savedPromise.catch(() => null);
      }

      if (!result) {
        // バックグラウンド解析が未開始 or 失敗 → 通常のAPI呼び出し
        if (_compressPromise) {
          _compressedFiles = await _compressPromise;
          _compressPromise = null;
        }
        const filesToAnalyze = _compressedFiles.length > 0 ? _compressedFiles : files;
        result = await Gemini.analyzeReceipt(filesToAnalyze, _cats, true, (attempt, max) => {
          btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>リトライ中 (${attempt}/${max - 1})...`;
        });
      }

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

      // 金額・勘定科目：常に分割行モード（1件でも split 行に流す）
      const pnlRF = _activePanel(el);
      const rfSplitLines = pnlRF.querySelector('#splitLines');
      if (rfSplitLines) {
        rfSplitLines.innerHTML = '';
        pnlRF.querySelector('#btnAddSplitRow')?.remove();
      }

      const hasMultiItems = result.items && result.items.length > 1;

      if (hasMultiItems) {
        // 2件以上の明細 → 各 item を1行ずつ追加
        result.items.forEach(item => {
          _addSplitRow(el);
          const rows = rfSplitLines.querySelectorAll('.split-row');
          const lastRow = rows[rows.length - 1];
          if (lastRow) {
            const amtInput = lastRow.querySelector('.split-amount');
            const catSel   = lastRow.querySelector('.split-cat');
            if (amtInput) amtInput.value = Number(item.amount || 0).toLocaleString('ja-JP');
            if (catSel && item.category) {
              [...catSel.options].forEach(o => o.selected = o.value === item.category);
            }
            const taxSel = lastRow.querySelector('.split-tax');
            if (taxSel && item.tax_rate) taxSel.value = item.tax_rate;
          }
        });
        _calcSplitTotal(el);
        filled++;
      } else {
        // 1件 or items なし → split 行1行に統合（items[0] を優先して拾う）
        const singleItem  = result.items?.[0];
        const totalAmount = singleItem?.amount  ?? result.total_amount;
        const singleCat   = singleItem?.category ?? result.category;
        const singleTax   = singleItem?.tax_rate ?? result.tax_rate;

        _addSplitRow(el);
        const firstRow = rfSplitLines?.querySelector('.split-row');

        if (result.fx_currency && result.fx_amount) {
          // 外貨：取引日のレートを取得して換算（取引日 → AI認識日付 → 当日 の順でフォールバック）
          const txDate = el.querySelector('#inputDate')?.value || result.date || null;
          const baseRate = await _fetchExchangeRate(result.fx_currency, 'JPY', txDate);
          if (baseRate) {
            const markupPct = 3;
            const rate = baseRate * (1 + markupPct / 100);
            const jpy = Math.floor(Number(result.fx_amount) * rate);
            if (firstRow) firstRow.querySelector('.split-amount').value = jpy.toLocaleString('ja-JP');
            const noteInput = el.querySelector('#inputNote');
            const markupNote = markupPct > 0 ? `＋手数料${markupPct}%` : '';
            if (noteInput) noteInput.value =
              `${result.fx_currency} ${Number(result.fx_amount).toLocaleString()} × ${rate.toFixed(2)}${markupNote} = ¥${jpy.toLocaleString()}${txDate ? `（${txDate}レート）` : ''}`;
            App.showToast(
              `外貨換算: ${result.fx_currency} ${Number(result.fx_amount).toLocaleString()} × ${rate.toFixed(2)}${markupNote} = ¥${jpy.toLocaleString()}${txDate ? `（${txDate}レート）` : ''}（確認してください）`,
              'warning'
            );
            filled++;
          } else {
            App.showToast(`外貨検出（${result.fx_currency} ${result.fx_amount}）。為替レートが取得できませんでした。手動で入力してください`, 'warning');
          }
        } else if (totalAmount != null && totalAmount !== '') {
          if (firstRow) firstRow.querySelector('.split-amount').value = Number(totalAmount).toLocaleString('ja-JP');
          filled++;
        }

        if (singleCat && firstRow) {
          const catSel = firstRow.querySelector('.split-cat');
          if (catSel) [...catSel.options].forEach(o => o.selected = o.value === singleCat);
          filled++;
          if (result.category_fallback) {
            App.showToast('勘定科目を判断できなかったため仮で「' + singleCat + '」を設定しました。送信前に確認してください。', 'warning');
          }
        }
        if (singleTax && firstRow) {
          const taxSel = firstRow.querySelector('.split-tax');
          if (taxSel) taxSel.value = singleTax;
        }
        if (rfSplitLines) _calcSplitTotal(el);
      }

      // 源泉徴収税額を保存（備考への記載は送信時に行う）
      _withholdingAmount = Number(result.withholding_amount) || 0;
      if (_withholdingAmount > 0) {
        App.showToast(`源泉徴収税額 ¥${_withholdingAmount.toLocaleString()} を検出しました`, 'info');
      }

      // 解析完了後、登録ボタンが下端に来るようスクロール
      el.querySelector('#submitUnit')?.scrollIntoView({ behavior: 'smooth', block: 'end' });

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

  /** 「登録する」セクション（submitUnit）とカスタムフラグを連動して表示/非表示する。
   *  カスタムフラグはマスタに登録がある場合のみ submitUnit と一緒に出す。 */
  function _setSubmitUnitVisible(el, show) {
    const su = el.querySelector('#submitUnit');
    if (su) {
      if (show) { su.classList.remove('d-none'); su.style.display = 'flex'; }
      else su.classList.add('d-none');
    }
    const cf = el.querySelector('#customFlagWrap');
    if (cf) cf.classList.toggle('d-none', !(show && _customFlags.length > 0));
    const hs = el.querySelector('#historySection');
    if (hs) {
      hs.classList.remove('d-none');
      hs.classList.toggle('history-inactive', show);
    }
  }

  function _showReceiptFields(el) {
    el.querySelector('#receiptFields')?.classList.remove('d-none');
    el.querySelector('#subtypeCard')?.classList.add('d-none');
    _setSubmitUnitVisible(el, true);
  }

  /** サーバー時刻を事前取得して _prefetchedTime に保存する（申請時の待ちをゼロにする） */
  function _prefetchServerTime() {
    if (_prefetchedTime) return; // 既にプリフェッチ済み
    const _licKey = localStorage.getItem('keihi_license_key') || '';
    const base = window.APP_CONFIG?.apiBase || '';
    fetch(`${base}/api/time`, {
      method: _licKey ? 'POST' : 'GET',
      headers: _licKey ? { 'Content-Type': 'application/json' } : {},
      body: _licKey ? JSON.stringify({ key: _licKey }) : undefined,
    }).then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.jst) _prefetchedTime = { jst: data.jst, fetchedAt: Date.now() }; })
      .catch(() => {});
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

    App.showLoading('保存中...');
    try {
      // 1. サーバー時刻取得（電帳法対応）
      //    写真選択時にプリフェッチ済みの場合は待ちゼロ（経過時間を加算して精度維持）
      const _licKey = localStorage.getItem('keihi_license_key') || '';
      const _timePrefetchTTL = 5 * 60 * 1000; // プリフェッチ有効期限 5分
      let appliedAt;
      if (_prefetchedTime && (Date.now() - _prefetchedTime.fetchedAt) < _timePrefetchTTL) {
        const elapsed = Date.now() - _prefetchedTime.fetchedAt;
        appliedAt = new Date(new Date(_prefetchedTime.jst).getTime() + elapsed)
          .toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        _prefetchedTime = null;
      } else {
        _prefetchedTime = null;
        const timeResp = await fetch(`${window.APP_CONFIG?.apiBase || ''}/api/time`, {
          method: _licKey ? 'POST' : 'GET',
          headers: _licKey ? { 'Content-Type': 'application/json' } : {},
          body: _licKey ? JSON.stringify({ key: _licKey }) : undefined,
        });
        appliedAt = timeResp.ok
          ? (await timeResp.json()).jst
          : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      }

      // 2. ファイルアップロード + SHA-256ハッシュ計算（並列実行）
      // 圧縮済みファイルが揃っていればそちらを使う（バックグラウンド圧縮がまだ走っていれば待つ）
      if (_compressPromise) {
        _compressedFiles = await _compressPromise;
        _compressPromise = null;
      }
      const _rawFiles = _selectedFiles.filter(Boolean);
      const activeFiles = _compressedFiles.length === _rawFiles.length
        ? _compressedFiles  // 圧縮済みを優先
        : _rawFiles;        // 未圧縮フォールバック（交通費等でprecompressが走らないケース）
      const uploadedUrls = _existingUrls.filter(Boolean);
      const hashes = _existingHash ? [_existingHash] : [];

      const master = await App.getMaster();
      const userName = master.members.find(m => m.email === Auth.getUserEmail())?.name
        || Auth.getUserInfo()?.name || Auth.getUserEmail();
      const dateStr  = data.date.replace(/-/g, '');
      const amtStr   = String(data.amount);
      const placeStr = (data.place || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 20);

      // Drive アップロード（複数ファイル並列）と expenses キャッシュ取得を同時に走らせる
      const uploadPromises = activeFiles.map((f, i) => {
        const ext      = f.mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        const filename = `${dateStr}_${placeStr}_${amtStr}円_${userName}_${i + 1}.${ext}`;
        return Drive.uploadReceiptFile(f.base64, f.mimeType, filename);
      });
      const [uploadResults, expenses] = await Promise.all([
        Promise.all(uploadPromises),
        App.getExpenses(),  // アップロード中にキャッシュを温める
      ]);
      for (const { url, hash, warn } of uploadResults) {
        uploadedUrls.push(url);
        hashes.push(hash);
        if (warn) App.showToast(warn, 'warning');
      }

      // 3. AI監査チェック（重複・2ヶ月超・同一画像）
      const alerts = _runAuditChecks(expenses, data, hashes);
      if (alerts.length > 0) {
        App.hideLoading();
        const ok = await App.confirm(
          `⚠️ 以下の問題が検出されました:\n\n${alerts.map(a => `• ${a}`).join('\n')}\n\nこのまま申請しますか？`
        );
        if (!ok) return;
        App.showLoading('保存中...');
      }

      // 4. AI監査フラグ設定
      const aiAudit = alerts.length > 0 ? `⛔ ${alerts.join(' / ')}` : '✅ OK';

      // 5. 備考への自動注記
      let finalNote = data.note || '';
      // 固定資産警告（10万円以上）
      if (data.amount >= 300000) {
        if (!finalNote.includes('【30万円以上】')) finalNote = [finalNote, '【30万円以上】'].filter(Boolean).join('\n');
      } else if (data.amount >= 100000) {
        if (!finalNote.includes('【10万円〜30万円未満】')) finalNote = [finalNote, '【10万円〜30万円未満】'].filter(Boolean).join('\n');
      }
      // 源泉徴収注記
      if (_withholdingAmount > 0) {
        const payAmt = data.amount - _withholdingAmount;
        const withholdingNote = `源泉徴収 ¥${_withholdingAmount.toLocaleString()}（支払額 ¥${payAmt.toLocaleString()}）`;
        if (!finalNote.includes('源泉徴収')) finalNote = [finalNote, withholdingNote].filter(Boolean).join('\n');
      }

      // 6. 行データ組み立て
      const row = Sheets.expenseToRow({
        appliedAt,
        name:           userName,
        type:           _currentType,
        date:           data.date,
        place:          data.place,
        amount:         data.amount,
        category:       data.category,
        note:           finalNote,
        imageLinks:     uploadedUrls.join(', '),
        confirmed:      App.isAdmin(),
        aiAudit,
        settlementDate: data.corpPay ? `会社払い（${data.paySource}）` : '',
        invoice:        data.invoice,
        aiAmount:       0,
        imageHash:      hashes.join(','),
        email:          Auth.getUserEmail(),
        id:             _editId || crypto.randomUUID(),
        device:         navigator.userAgent,
        taxRate:        data.taxRate,
        withholding:    _withholdingAmount,
        customFlag:     data.customFlag,
      });

      // 7. 編集の場合は修正履歴に旧データを保存してから更新
      if (_editId) {
        if (Sheets.useProxy && Sheets.useProxy()) {
          // B'プロキシ：旧データ保存・認可・更新をサーバーが一括で行う
          await Sheets.editExpense(_editId, row);
        } else {
          const rowNum = await Sheets.findRowById(_editId);
          if (rowNum > 0) {
            const oldRows = await Sheets.read(`経費一覧!A${rowNum}:U${rowNum}`);
            const r = oldRows[0] || [];
            const oldSummary = [
              `日付: ${r[3] || ''}`,
              `支払先: ${r[4] || ''}`,
              `金額: ${r[5] || ''}`,
              `科目: ${r[6] || ''}`,
              `タイプ: ${r[2] || ''}`,
              `備考: ${r[7] || ''}`,
              `精算日: ${r[11] || ''}`,
              `インボイス: ${r[12] || ''}`,
              `税区分: ${r[18] || ''}`,
            ].filter(s => !s.endsWith(': ')).join(' / ');
            // 修正履歴への追記と経費一覧の更新を並列実行
            await Promise.all([
              Sheets.prependRow('修正履歴', [appliedAt, Auth.getUserEmail(), oldSummary]),
              Sheets.update(`経費一覧!A${rowNum}:U${rowNum}`, [row]),
            ]);
          }
        }
      } else {
        await Sheets.prependExpense(row);
      }

      App.clearExpensesCache(); // 申請・修正後はキャッシュを破棄して一覧/集計を最新化
      App.showToast(_editId ? '修正しました' : '登録しました', 'success');
      const returnTo = _editId ? _returnAfterEdit : null;
      _resetForm(el);
      _loadHistory(el);
      if (returnTo) Router.navigate(returnTo);
    } catch (err) {
      App.showToast('登録エラー: ' + err.message, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _collectFormData(el) {
    const pnl  = _activePanel(el);
    const date = pnl.querySelector('#inputDate')?.value;

    // place は交通費・自家用車では専用フィールドから生成
    let place = '';
    if (_currentType === '電車/バス') {
      const from = el.querySelector('#txtFrom')?.value.trim();
      const to   = el.querySelector('#txtTo')?.value.trim();
      if (!from) { App.showToast('出発駅・バス停を入力してください', 'danger'); return null; }
      if (!to)   { App.showToast('到着駅・バス停を入力してください', 'danger'); return null; }
      const isRound = el.querySelector('#chkRoundTrip')?.checked;
      place = `${from} ${isRound ? '↔' : '→'} ${to}`;
    } else if (_currentType === '自家用車') {
      place = el.querySelector('#txtCarRoute')?.value.trim() || '';
      if (!place) { App.showToast('案件・経路名を入力してください', 'danger'); return null; }
    } else {
      place = pnl.querySelector('#inputPlace')?.value?.trim() || '';
      const placeLabel = _currentType === '領収書なし' ? '支払先・目的' : '支払先（店名・会社名）';
      if (!place) { App.showToast(`${placeLabel}を入力してください`, 'danger'); return null; }
    }

    if (!date) { App.showToast('日付を入力してください', 'danger'); return null; }

    let amount = 0, category = '', note = '';

    if (_currentType === '電車/バス') {
      const raw   = (el.querySelector('#numTransitFare')?.value || '').replace(/[^\d]/g, '');
      const fare  = Number(raw) || 0;
      const round = el.querySelector('#chkRoundTrip')?.checked ? 2 : 1;
      amount   = fare * round;
      category = el.querySelector('#selCatTransit')?.value || '';
      note     = pnl.querySelector('#inputNote')?.value?.trim() || '';
      if (amount === 0) { App.showToast('片道運賃（円）を入力してください', 'danger'); return null; }
    } else if (_currentType === '自家用車') {
      const km   = Number(el.querySelector('#numCarKm')?.value)  || 0;
      const rate = Number(el.querySelector('#numCarRate')?.value) || 20;
      amount   = Math.ceil(km * rate);
      category = el.querySelector('#selCatCar')?.value || '';
      note     = pnl.querySelector('#inputNote')?.value?.trim() || '';
      if (km === 0) { App.showToast('距離（km）を入力してください', 'danger'); return null; }
    } else {
      const isSplit = !pnl.querySelector('#splitLines')?.classList.contains('d-none');
      if (isSplit) {
        const rows = pnl.querySelectorAll('.split-row');
        const rowData = Array.from(rows).map(r => {
          const raw = (r.querySelector('.split-amount')?.value || '').replace(/[^\d]/g, '');
          return {
            amt: Number(raw) || 0,
            cat: r.querySelector('.split-cat')?.value || '',
            tax: r.querySelector('.split-tax')?.value || '課税10%',
          };
        });
        amount   = rowData.reduce((s, r) => s + r.amt, 0);
        // "科目:金額:税区分" 形式で保存（edit時・CSV展開時に復元可能にする）
        category = rowData.map(r => r.amt ? `${r.cat}:${r.amt}:${r.tax}` : r.cat).join('/');
      } else {
        const rawAmt = (pnl.querySelector('#inputAmount')?.value || '').replace(/[^\d]/g, '');
        amount   = Number(rawAmt) || 0;
        category = pnl.querySelector('#selCategory')?.value || '';
      }
      note = pnl.querySelector('#inputNote')?.value?.trim() || '';
      if (!Number.isInteger(amount) || amount < 1) { App.showToast('金額は1以上の整数を入力してください', 'danger'); return null; }
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

    // split時はrow別税区分から全体taxRateを自動計算（単一なら共通値、複数なら「混在」）
    const isSplitMode = !pnl.querySelector('#splitLines')?.classList.contains('d-none');
    let taxRate;
    if (isSplitMode) {
      const splitTaxes = [...new Set(
        Array.from(pnl.querySelectorAll('.split-row .split-tax')).map(s => s.value || '課税10%')
      )];
      taxRate = splitTaxes.length === 1 ? splitTaxes[0] : '混在';
    } else {
      taxRate = el.querySelector('#selTaxRate')?.value || '課税10%';
    }
    return {
      date, place, amount, category, note,
      invoice:    pnl.querySelector('#inputInvoice')?.value?.trim() || '',
      taxRate,
      customFlag: el.querySelector('#selCustomFlag')?.value || '',
      corpPay, paySource,
    };
  }

  function _runAuditChecks(expenses, data, newHashes) {
    const alerts = [];

    // 1. 2ヶ月以上前の日付チェック（電帳法対応）
    const expDate = new Date(data.date);
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    if (expDate < twoMonthsAgo) {
      alerts.push(`2ヶ月以上前の日付 (${data.date})`);
    }

    // 2. インボイス番号＋金額の重複チェック（最優先・確実な重複）
    if (data.invoice && data.invoice.trim()) {
      const invNorm = data.invoice.trim().toUpperCase();
      const invDup = expenses.find(e => {
        if (e.id === _editId) return false;
        return e.invoice &&
          e.invoice.trim().toUpperCase() === invNorm &&
          Number(e.amount) === Number(data.amount);
      });
      if (invDup) {
        alerts.push(`インボイス番号と金額が一致する申請済みデータがあります (${invDup.date} ${invDup.place} ¥${Number(invDup.amount).toLocaleString('ja-JP')})`);
      }
    }

    // 3. 画像ハッシュ重複チェック
    if (newHashes.length > 0) {
      const dup = expenses.find(e => {
        if (e.id === _editId) return false;
        return e.imageHash && newHashes.some(h => e.imageHash.split(',').includes(h));
      });
      if (dup) alerts.push(`同一画像が既に申請済み (${dup.date} ${dup.place})`);
    }

    // 4. 同日・同額・類似取引先の重複チェック（揺らぎ許容）
    function _similarPlace(a, b) {
      if (!a || !b) return false;
      const na = a.trim().toLowerCase().replace(/[\s　]/g, '');
      const nb = b.trim().toLowerCase().replace(/[\s　]/g, '');
      if (na === nb) return true;
      if (na.length >= 3 && (nb.includes(na) || na.includes(nb))) return true;
      if (na.length >= 4 && nb.length >= 4 && na.slice(0, 4) === nb.slice(0, 4)) return true;
      return false;
    }
    const dupEntry = expenses.find(e => {
      if (e.id === _editId) return false;
      return e.date === data.date &&
        Number(e.amount) === Number(data.amount) &&
        _similarPlace(e.place, data.place);
    });
    if (dupEntry) {
      alerts.push(`重複の疑い: ${dupEntry.date} ${dupEntry.place} ¥${Number(dupEntry.amount).toLocaleString('ja-JP')}`);
    }

    return alerts;
  }

  async function _loadHistory(el, force) {
    const list = el.querySelector('#historyList');
    if (!list) return;
    list.innerHTML = '<div class="text-muted small text-center py-2">読み込み中...</div>';
    // シートIDが確定するまで待機（別経費ログの履歴が一瞬表示されるのを防ぐ）
    await App.waitSheetReady();
    try {
      const all = await App.getExpenses(force);
      _historyExpenses = all;
      _historyAll = all
        .filter(e => e.email === Auth.getUserEmail())
        .sort((a, b) => String(b.appliedAt || b.date || '').localeCompare(String(a.appliedAt || a.date || '')));
      _historyShown = _HIST_PAGE;
      _renderHistory(el);
    } catch (err) {
      list.innerHTML = `<div class="text-danger small text-center py-2">${err.message}</div>`;
    }
  }

  function _renderHistory(el) {
    const list = el.querySelector('#historyList');
    if (!list) return;
    if (_historyAll.length === 0) {
      list.innerHTML = '<div class="text-muted small text-center py-3">申請履歴がありません</div>';
      return;
    }
    const visible = _historyAll.slice(0, _historyShown);
    const hasMore = _historyShown < _historyAll.length;
    list.innerHTML = visible.map(e => _renderHistoryCard(e)).join('') +
      (hasMore
        ? `<button class="btn btn-outline-secondary btn-sm w-100 mt-1" id="btnHistoryMore">
             <i class="bi bi-chevron-down me-1"></i>もっと見る
           </button>`
        : '');
    list.querySelectorAll('.btn-edit-history').forEach(btn => {
      btn.addEventListener('click', () => _startEdit(el, btn.dataset.id, _historyExpenses));
    });
    list.querySelectorAll('.btn-del-history').forEach(btn => {
      btn.addEventListener('click', () => _deleteExpense(btn.dataset.id, el));
    });
    list.querySelector('#btnHistoryMore')?.addEventListener('click', () => {
      _historyShown += _HIST_PAGE;
      _renderHistory(el);
    });
  }

  function _renderHistoryCard(e) {
    const statusClass = e.settlementDate ? 'badge-settled'
      : e.confirmed ? 'badge-confirmed'
      : e.aiAudit?.startsWith('⛔') ? 'badge-duplicate' : 'badge-pending';
    const statusText = e.settlementDate ? '精算済'
      : e.confirmed ? '登録済'
      : e.aiAudit?.startsWith('⛔') ? '要確認' : '申請済';

    const imageBtn = e.imageLinks
      ? `<a href="${e.imageLinks.split(',')[0].trim()}" target="_blank" class="btn btn-sm btn-outline-primary">
           <i class="bi bi-image me-1"></i>証票
         </a>`
      : '';
    const isAdmin = App.isAdmin();
    const isSettled = !!e.settlementDate && !String(e.settlementDate).startsWith('会社払い');
    const canEdit = !isSettled && (isAdmin || (!e.settlementDate && !e.confirmed));
    const editBtn = canEdit
      ? `<button class="btn btn-sm btn-outline-secondary btn-edit-history" data-id="${e.id}">
           <i class="bi bi-pencil"></i>
         </button>` : '';
    const delBtn = canEdit
      ? `<button class="btn btn-sm btn-outline-danger btn-del-history" data-id="${e.id}">
           <i class="bi bi-trash"></i>
         </button>` : '';

    const noteId = `hn-${e.id}`;
    const noteToggle = e.note
      ? `<button class="btn btn-link btn-sm p-0 text-secondary text-decoration-none history-note-toggle"
           data-bs-toggle="collapse" data-bs-target="#${noteId}" aria-expanded="false">
           <i class="bi bi-chevron-down" style="font-size:0.75rem;"></i>
         </button>` : '';
    const noteBody = e.note
      ? `<div class="collapse mt-1" id="${noteId}">
           <div class="history-note-body"><i class="bi bi-chat-text me-1 text-secondary"></i>${_escape(e.note)}</div>
         </div>` : '';

    return `
    <div class="history-card">
      <div class="d-flex justify-content-between align-items-start">
        <span class="h-place">${e.settlementDate?.startsWith('会社払い') ? '🏢 ' : ''}${_escape(e.place)}</span>
        <span class="h-amount">¥${e.amount.toLocaleString()}</span>
      </div>
      <div class="d-flex justify-content-between align-items-center mt-1">
        <div class="d-flex align-items-center gap-1">
          <span class="h-meta">${e.date} / ${_escape(App.categoryLabel(e.category))} (${e.type})</span>
          ${noteToggle}
        </div>
        <span class="badge ${statusClass} rounded-pill px-2">${statusText}</span>
      </div>
      ${noteBody}
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
    _currentType = e.type;

    // サブタイプピルの状態とパネル表示
    el.querySelectorAll('.subtype-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.type === e.type);
    });
    ['領収書なし', '電車/バス', '自家用車'].forEach(t => {
      el.querySelector(`#panel-${_typeId(t)}`)?.classList.toggle('d-none', t !== e.type);
    });

    setTimeout(() => {
      if (e.type === '領収書') {
        _showReceiptFields(el);
        if (_existingUrls.filter(Boolean).length > 0) {
          el.querySelector('#heroDefault')?.classList.add('d-none');
          el.querySelector('#heroPreview')?.classList.remove('d-none');
          el.querySelector('#btnAnalyze')?.classList.remove('d-none');
        }
      } else {
        el.querySelector('#heroZone')?.classList.add('d-none');
        el.querySelector('#btnAnalyze')?.classList.add('d-none');
      }

      const pnl = _activePanel(el);

      // 共通フィールド（パネルにスコープ）
      const dateInput = pnl.querySelector('#inputDate');
      if (dateInput) dateInput.value = e.date;
      const noteInput = pnl.querySelector('#inputNote');
      if (noteInput) noteInput.value = e.note || '';

      // タイプ別フィールド（keep exact same logic as original)
      if (e.type === '領収書' || e.type === '領収書なし') {
        const placeInput = pnl.querySelector('#inputPlace');
        if (placeInput) placeInput.value = e.place || '';
        const invInput = pnl.querySelector('#inputInvoice');
        if (invInput) invInput.value = e.invoice || '';
        const splitParts = App.parseSplitCategory(e.category);
        // singleLineがないパネル（領収書なし）は常に分割パスへ
        const noSingleLine = !pnl.querySelector('#singleLine');
        if (splitParts.length > 1 || noSingleLine) {
          const splitLines = pnl.querySelector('#splitLines');
          const singleLine = pnl.querySelector('#singleLine');
          const splitTotalEl = pnl.querySelector('#splitTotal');
          if (splitLines && singleLine && splitLines.classList.contains('d-none')) {
            singleLine.classList.add('d-none');
            splitLines.classList.remove('d-none');
            if (splitTotalEl) splitTotalEl.classList.remove('d-none');
          }
          if (splitLines) {
            splitLines.innerHTML = '';
            pnl.querySelector('#btnAddSplitRow')?.remove();
            splitParts.forEach(({ cat, amount: partAmt, taxRate: partTax }) => {
              _addSplitRowTo(splitLines, pnl);
              const rows = splitLines.querySelectorAll('.split-row');
              const lastRow = rows[rows.length - 1];
              if (lastRow) {
                const catSel = lastRow.querySelector('.split-cat');
                if (catSel) [...catSel.options].forEach(o => o.selected = o.value === cat);
                // 旧形式（amount未埋め込み）は e.amount にフォールバック
                const resolvedAmt = partAmt !== null ? partAmt : (splitParts.length === 1 ? e.amount : null);
                if (resolvedAmt !== null) {
                  const amtInp = lastRow.querySelector('.split-amount');
                  if (amtInp) amtInp.value = Number(resolvedAmt).toLocaleString('ja-JP');
                }
                if (partTax) {
                  const taxSel = lastRow.querySelector('.split-tax');
                  if (taxSel) taxSel.value = partTax;
                } else if (e.taxRate) {
                  const taxSel = lastRow.querySelector('.split-tax');
                  if (taxSel) taxSel.value = e.taxRate;
                }
              }
            });
            _calcSplitTotalIn(pnl);
          }
        } else {
          const amtInput = pnl.querySelector('#inputAmount');
          if (amtInput) amtInput.value = Number(e.amount).toLocaleString('ja-JP');
          const sel = pnl.querySelector('#selCategory');
          if (sel) [...sel.options].forEach(o => o.selected = o.value === e.category);
        }
        const taxSel = el.querySelector('#selTaxRate');
        if (taxSel && e.taxRate) taxSel.value = e.taxRate;
        const cfSel = el.querySelector('#selCustomFlag');
        if (cfSel && e.customFlag) cfSel.value = e.customFlag;
      } else if (e.type === '電車/バス') {
        const parts = (e.place || '').split(/ [→↔] /);
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

      // 会社払いセグメントの状態を復元
      if (e.corpPay) {
        el.querySelector('#chkCorpPay') && (el.querySelector('#chkCorpPay').checked = true);
        el.querySelector('#btnPaySelf')?.classList.remove('active');
        el.querySelector('#btnPayCorp')?.classList.add('active');
        el.querySelector('#corpPayDetails')?.classList.remove('d-none');
        const sel = el.querySelector('#selPaySource');
        if (sel && e.paySource) sel.value = e.paySource;
      }

      _renderExistingUrlPreviews(el, e.type);

      el.querySelector('#editBanner')?.classList.remove('d-none');
      el.querySelector('#subtypeCard')?.classList.add('d-none');
      el.querySelector('#regulationAcc')?.classList.add('d-none');
      _setSubmitUnitVisible(el, true);
      const btn = el.querySelector('#btnSubmit');
      if (btn) { btn.textContent = '上書き保存'; btn.style.cssText = 'background:#cc8800;'; }
      el.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }

  async function _deleteExpense(id, el) {
    const ok = await App.confirm('この申請を削除しますか？削除後は元に戻せません。');
    if (!ok) return;
    App.showLoading('削除中...');
    try {
      if (Sheets.useProxy && Sheets.useProxy()) {
        // B'プロキシ：削除一覧への退避・認可・削除をサーバーが一括で行う
        await Sheets.deleteExpense(id);
      } else {
        const expenses = await Sheets.readExpenses();
        const e = expenses.find(x => x.id === id);
        if (!e) throw new Error('申請が見つかりません');

        const rowNum = await Sheets.findRowById(id);
        if (rowNum < 0) throw new Error('行が見つかりません');

        // 削除一覧に移動
        const timeResp = await fetch(`${window.APP_CONFIG?.apiBase || ''}/api/time`);
        const deletedAt = timeResp.ok
          ? (await timeResp.json()).jst
          : new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
        await Sheets.prependRow('削除一覧', [deletedAt, Auth.getUserEmail(), ...Sheets.expenseToRow(e)]);

        // 元の行を削除
        await Sheets.deleteRow('経費一覧', rowNum);
      }

      App.clearExpensesCache();
      App.showToast('削除しました', 'success');
      _loadHistory(el, true);
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
    _selectedFiles = []; _compressedFiles = []; _compressPromise = null;
    _aiAutoPromise = null; _prefetchedTime = null; ++_aiAutoVersion;
    _editId = null;
    _returnAfterEdit = null;
    _withholdingAmount = 0;

    // AIボタンをリセット（非表示に戻す）
    const analyzeBtn = el.querySelector('#btnAnalyze');
    if (analyzeBtn) {
      analyzeBtn.innerHTML = '<i class="bi bi-stars me-2"></i>AIで読み取る';
      analyzeBtn.disabled = false;
      analyzeBtn.className = 'btn-ai d-none mb-3';
    }

    // ヒーローゾーンをリセット
    el.querySelector('#editBanner')?.classList.add('d-none');
    el.querySelector('#heroZone')?.classList.remove('d-none');
    el.querySelector('#heroDefault')?.classList.remove('d-none');
    el.querySelector('#heroPreview')?.classList.add('d-none');
    el.querySelector('#subtypeCard')?.classList.remove('d-none');
    el.querySelector('#regulationAcc')?.classList.remove('d-none');
    _setSubmitUnitVisible(el, false);
    el.querySelector('#receiptFields')?.classList.add('d-none');

    // タイプリセット
    _currentType = '領収書';
    el.querySelectorAll('.subtype-pill').forEach(p => p.classList.remove('active'));
    ['領収書なし', '電車/バス', '自家用車'].forEach(t => {
      el.querySelector(`#panel-${_typeId(t)}`)?.classList.add('d-none');
    });

    // 送信ボタンをリセット
    const btn = el.querySelector('#btnSubmit');
    if (btn) {
      btn.innerHTML = '<i class="bi bi-send me-1"></i>登録する';
      btn.className = 'submit-unit-action';
      btn.style.cssText = '';
    }

    // 会社払いをリセット
    el.querySelector('#btnPaySelf')?.classList.add('active');
    el.querySelector('#btnPayCorp')?.classList.remove('active');
    el.querySelector('#chkCorpPay') && (el.querySelector('#chkCorpPay').checked = false);
    el.querySelector('#corpPayDetails')?.classList.add('d-none');

    // ファイルプレビューをクリア
    TYPES.forEach(t => el.querySelector(`#previewArea-${_typeId(t)}`)?.replaceChildren());

    // フォームフィールドをクリア
    const today = new Date().toISOString().split('T')[0];
    el.querySelectorAll('#inputDate').forEach(i => { i.value = today; });
    el.querySelectorAll('#inputPlace').forEach(i => { i.value = ''; });
    el.querySelectorAll('#inputAmount').forEach(i => { i.value = ''; });
    el.querySelectorAll('#inputNote').forEach(i => { i.value = ''; });
    el.querySelectorAll('#inputInvoice').forEach(i => { i.value = ''; });
    el.querySelector('#txtFrom')        && (el.querySelector('#txtFrom').value = '');
    el.querySelector('#txtTo')          && (el.querySelector('#txtTo').value = '');
    el.querySelector('#txtCarRoute')    && (el.querySelector('#txtCarRoute').value = '');
    el.querySelector('#numTransitFare') && (el.querySelector('#numTransitFare').value = '');
    el.querySelector('#numCarKm')       && (el.querySelector('#numCarKm').value = '');
    el.querySelector('#txtReason')      && (el.querySelector('#txtReason').value = '');
    const chkRound = el.querySelector('#chkRoundTrip');
    if (chkRound) chkRound.checked = false;
    el.querySelector('#transitResult')?.classList.add('d-none');
    const lblTotal = el.querySelector('#lblTransitTotal');
    if (lblTotal) lblTotal.textContent = '¥0';

    // 領収書・領収書なしパネルの分割行を初期1行にリセット
    [el.querySelector('#receiptFields'), el.querySelector('#panel-領収書なし')].forEach(pnl => {
      if (!pnl) return;
      const s = pnl.querySelector('#splitLines');
      if (s) { s.innerHTML = ''; pnl.querySelector('#btnAddSplitRow')?.remove(); _addSplitRowTo(s, pnl); }
    });
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function queueEdit(id, expenses, returnTo = null) {
    _pendingEdit = { id, expenses };
    _returnAfterEdit = returnTo;
  }

  return { render, bindEvents, queueEdit };
})();
