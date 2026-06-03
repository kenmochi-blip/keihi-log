/**
 * アプリケーション本体
 * 認証確認・マスターデータキャッシュ・UIユーティリティ
 */
const App = (() => {

  let _masterCache  = null;
  let _isAdmin      = false;
  let _userRole     = 'member'; // 'admin' | 'viewer' | 'member'
  let _confirmModal = null;
  let _confirmResolve = null;
  let _aliasNotFound = false; // URLにエイリアスが指定されたが存在しなかった場合にtrue
  let _sheetIdChanged = false; // quickStart後に別シートが検出されたフラグ（init完了後に再描画）
  // シートID確定を待つ Promise（_loadHistory など API 呼び出し前に await する）
  let _sheetReadyResolve = null;
  const _sheetReadyPromise = new Promise(res => { _sheetReadyResolve = res; });
  let _expensesCache    = null; // readExpenses() の結果キャッシュ
  let _expensesCacheAt  = 0;   // キャッシュ取得時刻（ms）
  let _expensesInflight = null; // 進行中のfetchPromise（重複リクエスト防止）
  const EXPENSES_CACHE_TTL = 5 * 60 * 1000; // 5分（この間はキャッシュを即返す）
  const EXPENSES_STALE_TTL = 30 * 60 * 1000; // 30分（この間は古いデータを即返しつつバックグラウンドで更新）

  // マスターデータのlocalStorageキャッシュTTL（10分）
  const MASTER_CACHE_TTL = 10 * 60 * 1000;

  async function init() {
    // デモモード：認証・ライセンス・シート確認をスキップ
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      _masterCache = Demo.MASTER;
      const demoRole = Demo.getRole();
      _userRole = demoRole;
      _isAdmin = demoRole === 'admin';
      _sheetReadyResolve?.(); // waitSheetReady() を即時解決（履歴読み込みのブロック解除）
      _setupUI('submit');
      const titleEl = document.getElementById('navAppTitle');
      if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(Demo.COMPANY_NAME)}`;
      const navEmail = document.getElementById('navUserEmail');
      if (navEmail) navEmail.textContent = Demo.getUserEmail();
      _applyDemoNavVisibility(demoRole);
      _insertDemoRoleSwitcher();
      showToast('デモモード：サンプルデータで動作中', 'info');
      return;
    }

    // ━━ 即時起動（キャッシュ優先）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // localStorageのキャッシュが揃っていれば、ネットワーク待ちなしでUIを即描画。
    // バックグラウンドで非同期検証し、問題があれば後からエラーを表示する。
    const _quickStarted = _tryQuickStart();
    if (_quickStarted) {
      _applyAdminVisibility(); // キャッシュのロールで設定タブ表示を即時確定
    }

    // ━━ 非同期検証フェーズ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ① パス解決・セットアップ・認証トークン取得を並列実行
    const [,, tokenResult] = await Promise.allSettled([
      _resolveSetupParam(),
      _resolvePathAlias(),
      Auth.getToken(),
    ]);
    // _resolvePathAlias() 完了 → シートIDが確定。waitSheetReady() を解除する
    _sheetReadyResolve?.();
    if (tokenResult.status === 'rejected') {
      const _isGenericPath = location.pathname === '/app.html' || location.pathname === '/app' || location.pathname === '/';
      let ret = _isGenericPath ? '' : location.pathname;
      if (!ret) { const ca = _getCookieAlias(); if (ca) ret = '/' + ca; }
      window.location.href = 'login.html' + (ret ? '?return=' + encodeURIComponent(ret) : '');
      return;
    }

    // ライセンス・シート未設定の場合
    let licKey = localStorage.getItem('keihi_license_key');
    const ssId = localStorage.getItem('keihi_sheet_id');

    // スプレッドシートアクセス確認
    // 管理者（シート作成者）は drive.file で直接アクセス可能。
    // メンバー（共有されたシートへのアクセス）は drive.file では不可のため、
    // 初回のみ spreadsheets スコープへの追加認可を促す。
    if (ssId && !Picker.isAuthorized(ssId)) {
      const probe = await Auth.authFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=spreadsheetId`
      ).catch(() => null);
      if (probe?.ok) {
        Picker.markAuthorized(ssId);
      } else {
        // アクセス不可 → spreadsheets スコープへの追加認可画面を表示
        const _mainEl = document.getElementById('appMain');
        if (_mainEl) _mainEl.innerHTML = `
          <div class="text-center py-5 px-3">
            <i class="bi bi-shield-lock text-primary" style="font-size:3rem;"></i>
            <h5 class="mt-3 fw-bold">スプレッドシートへのアクセス許可（初回のみ）</h5>
            <p class="text-muted mb-3" style="font-size:0.88rem; line-height:1.8;">
              チームのスプレッドシートにアクセスするため、<br>Googleの追加権限が必要です。<br><br>
              次の画面で確認が表示された場合は<br>
              <strong>「詳細設定」→「keihi-logに移動」</strong>を選択してください。<br>
              <small class="text-muted">※Googleによるアプリ審査の完了まで表示される確認です</small>
            </p>
            <button id="btnGrantSheets" class="btn btn-primary w-100">
              <i class="bi bi-google me-2"></i>アクセスを許可する（初回のみ）
            </button>
          </div>`;
        const _navEl = document.querySelector('nav.fixed-bottom');
        if (_navEl) _navEl.classList.add('d-none');
        document.getElementById('btnGrantSheets')?.addEventListener('click', () => {
          Auth.requestSpreadsheetsScope();
        });
        return;
      }
    }

    // シートIDはあるがライセンスキーが未設定の場合、シートから自動取得（メンバー向け）
    if (!licKey && ssId) {
      try {
        const sheetLicKey = await Sheets.readSetting('B3');
        if (sheetLicKey && sheetLicKey.startsWith('KL-')) {
          localStorage.setItem('keihi_license_key', sheetLicKey);
          licKey = sheetLicKey;
        }
      } catch (_) {}
    }
    if (_aliasNotFound) { _showAliasNotFoundError(); return; }
    if (!ssId) { window.location.replace('/setup'); return; }
    if (!licKey) {
      if (!_quickStarted) _setupUI('submit');
      return;
    }

    // ③ 経費データのバックグラウンド先読み
    // 認証・シートIDが確定した直後に開始し、ライセンス検証と並列で走らせる。
    // ユーザーがスワイプするより前に完了することが多く、一覧/集計タブを即表示できる。
    // _expensesInflight があれば相乗りするだけで重複リクエストは発生しない。
    if (!_expensesCache) getExpenses().catch(() => {});

    // ④ ライセンス検証・マスターデータ・設定シートを一斉並列実行
    const _userEmail = Auth.getUserEmail().toLowerCase();
    const _licCache  = (() => { try { return JSON.parse(localStorage.getItem('keihi_license_cache') || 'null'); } catch (_) { return null; } })();
    const _isOwner   = !!(_licCache?.result?.ownerEmail && _licCache.result.ownerEmail === _userEmail);

    const _cachedMaster = (() => {
      try {
        const c = JSON.parse(localStorage.getItem('keihi_master_cache') || 'null');
        if (c?._cachedAt && Date.now() - c._cachedAt < MASTER_CACHE_TTL) return c;
      } catch (_) {}
      return null;
    })();
    const masterPromise = _cachedMaster
      ? Promise.resolve(_cachedMaster)
      : Sheets.readMaster().then(m => {
          try { localStorage.setItem('keihi_master_cache', JSON.stringify({ ...m, _cachedAt: Date.now() })); } catch (_) {}
          return m;
        });

    const [licResult, masterResult, cfgResult] = await Promise.allSettled([
      License.verify(licKey),
      masterPromise,
      Sheets.readAllSettings(),
    ]);

    // ライセンス検証
    const lic = licResult.status === 'fulfilled' ? licResult.value : { valid: false, reason: 'error' };
    if (!lic.valid) {
      const reason = lic.reason === 'expired'  ? 'ライセンスの有効期限が切れています。' :
                     lic.reason === 'suspended' ? 'ライセンスが停止されています。' :
                                                  'ライセンスキーが無効です。';
      if (_quickStarted) {
        Router.navigate('settings'); // 即時描画済みのUIを設定画面で上書き
      } else {
        _setupUI('settings');
      }
      setTimeout(() => showToast(`${reason}設定画面からライセンスキーを更新してください。`, 'danger', 8000), 500);
      return;
    }

    // マスターデータ処理
    if (masterResult.status === 'fulfilled') {
      _masterCache = masterResult.value;
      // 明示的に member/viewer 権限で登録されている場合は admins 空配列フォールバックを適用しない
      const _myEntry = _masterCache.members.find(m => m.email?.toLowerCase() === _userEmail);
      const _explicitNonAdmin = _myEntry && ['member', 'viewer'].includes((_myEntry.role || '').toLowerCase());
      if (_isOwner || (!_explicitNonAdmin && _masterCache.admins.length === 0) || _masterCache.admins.includes(_userEmail)) {
        _userRole = 'admin';
      } else if (_masterCache.viewers && _masterCache.viewers.includes(_userEmail)) {
        _userRole = 'viewer';
      } else {
        _userRole = 'member';
      }
      _isAdmin = _userRole === 'admin';
      if (_userRole !== 'admin' && _masterCache.members.length > 0 && !_masterCache.members.some(m => m.email.toLowerCase() === _userEmail)) {
        _showAccessDeniedError(_userEmail);
        return;
      }
    } else {
      const err = masterResult.reason;
      if (err?.message?.includes('403')) { _showSheetAccessDeniedError(); return; }
      if (!_quickStarted) {
        _masterCache = { members: [], categories: [], paySources: [], admins: [], viewers: [] };
        if (_isOwner) { _userRole = 'admin'; _isAdmin = true; }
      }
    }

    // 設定シート（B2:B7）処理
    let _companyName = localStorage.getItem('keihi_company_name') || '';
    if (cfgResult.status === 'fulfilled') {
      const cfg = cfgResult.value;
      const fetched = cfg.B2 || '';
      if (fetched && fetched !== _companyName) {
        _companyName = fetched;
        localStorage.setItem('keihi_company_name', fetched);
      }
      if (cfg.B4 && !localStorage.getItem('keihi_folder_id')) localStorage.setItem('keihi_folder_id', cfg.B4);
      if (cfg.B6) localStorage.setItem('keihi_regulation', cfg.B6);
    }

    if (!_quickStarted) {
      // 通常起動：全検証完了後にUIを初期化
      if (_companyName) {
        const titleEl = document.getElementById('navAppTitle');
        if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(_companyName)}`;
        document.title = `経費ログ | ${_companyName}`;
      }
      _setupUI('submit', _companyName);
    } else {
      // 即時起動済み：会社名・タブ表示のみ更新（再描画なし）
      if (_companyName) {
        const titleEl = document.getElementById('navAppTitle');
        if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(_companyName)}`;
        document.title = `経費ログ | ${_companyName}`;
      }
    }
    _applyAdminVisibility(); // 最新ロールで再適用（キャッシュと異なる場合を考慮）

    // quickStart 中に別スプレッドシートが検出された場合、
    // 正しいシートIDで現在のビューを再描画（旧シートのデータが表示されるのを防ぐ）
    if (_quickStarted && _sheetIdChanged) {
      Router.navigate(Router.current());
    }
  }

  /**
   * セッション・sheetId・licKeyが存在すれば、キャッシュの有効期限に関わらず即UIを描画する。
   * 認証・ライセンス・マスタの検証はバックグラウンドで行い、問題があれば後から上書きする。
   * 数日ぶりのアクセスでもスピナーなしで起動できるよう、有効期限チェックを撤廃。
   */
  function _tryQuickStart() {
    try {
      // リフレッシュトークンがあれば再認証可能（アクセストークン期限は問わない）
      const session = JSON.parse(localStorage.getItem('keihi_auth_session') || 'null');
      if (!session?.refresh_token && !session?.access_token) return false;

      // スプレッドシートIDとライセンスキーが設定済みであること
      const ssId   = localStorage.getItem('keihi_sheet_id');
      const licKey = localStorage.getItem('keihi_license_key');
      if (!ssId || !licKey) return false;

      // ライセンス・マスターはキャッシュがあれば期限切れでも使用（バックグラウンドで更新）
      const licCache  = JSON.parse(localStorage.getItem('keihi_license_cache') || 'null');
      const masterRaw = JSON.parse(localStorage.getItem('keihi_master_cache') || 'null');
      const master    = masterRaw || { members: [], categories: [], paySources: [], admins: [], viewers: [] };

      // ロールを手元のキャッシュから暫定決定（バックグラウンド検証後に再適用）
      const email   = (session.userInfo?.email || localStorage.getItem('keihi_user_email') || '').toLowerCase();
      const isOwner = !!(licCache?.result?.ownerEmail && licCache.result.ownerEmail === email);
      _masterCache  = master;
      const myEntry = master.members?.find(m => m.email?.toLowerCase() === email);
      const explicitNonAdmin = myEntry && ['member', 'viewer'].includes((myEntry.role || '').toLowerCase());
      // admins.length===0 フォールバックはキャッシュがある場合のみ適用
      // （キャッシュ未取得の初回アクセス時に全員adminと判定されるのを防ぐ）
      const hasMasterCache = masterRaw !== null;
      if (isOwner || (hasMasterCache && !explicitNonAdmin && master.admins.length === 0) || master.admins.includes(email)) {
        _userRole = 'admin';
      } else if (master.viewers?.includes(email)) {
        _userRole = 'viewer';
      } else {
        _userRole = 'member';
      }
      _isAdmin = _userRole === 'admin';

      // 経費データを localStorage から先読み（bindEvents で getExpenses() が即返すよう）
      // _tryQuickStart() → Router.init() → bindEvents の順に同期で動くため、
      // ここで _expensesCache を設定しておけば最初の await getExpenses() が
      // マイクロタスクで解決し、ブラウザが描画する前にテーブルが埋まる
      try {
        const stored  = JSON.parse(localStorage.getItem('keihi_expenses_cache') || 'null');
        const sheetId = localStorage.getItem('keihi_sheet_id');
        if (stored?.sheetId === sheetId && Array.isArray(stored.data)) {
          _expensesCache   = stored.data;
          _expensesCacheAt = Date.now() - EXPENSES_CACHE_TTL - 1; // ステール扱いでバックグラウンド更新
        }
      } catch (_) {}

      // UIを即時描画（会社名・規程もキャッシュから）
      const companyName = localStorage.getItem('keihi_company_name') || '';
      _setupUI('submit', companyName);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 管理者以外の設定タブを非表示にする（_isAdmin の変化に追従） */
  function _applyAdminVisibility() {
    const btn = document.querySelector('.nav-item-btn[data-view="settings"]');
    if (!btn) return;
    if (_isAdmin) {
      btn.classList.remove('d-none');
    } else {
      btn.classList.add('d-none');
    }
  }

  function _showAliasNotFoundError() {
    const main = document.getElementById('appMain');
    if (main) main.innerHTML = `
      <div class="text-center py-5 px-3">
        <i class="bi bi-exclamation-circle text-warning" style="font-size:3rem;"></i>
        <h5 class="mt-3 fw-bold">このURLは見つかりませんでした</h5>
        <p class="text-muted small mt-2">URLが正しくない可能性があります。<br>管理者から共有されたURLをご確認ください。</p>
        <a href="/" class="btn btn-outline-primary btn-sm mt-2">トップページへ</a>
      </div>`;
    const bottomNav = document.querySelector('nav.fixed-bottom');
    if (bottomNav) bottomNav.classList.add('d-none');
  }

  function _showAccessDeniedError(email) {
    const main = document.getElementById('appMain');
    if (main) main.innerHTML = `
      <div class="text-center py-5 px-3">
        <i class="bi bi-lock-fill text-danger" style="font-size:3rem;"></i>
        <h5 class="mt-3 fw-bold">アクセスできません</h5>
        <p class="text-muted small mt-2">
          このページへのアクセス権がありません。<br>
          URLが正しいかご確認いただくか、管理者にお問い合わせください。
        </p>
        <p class="text-muted small">ログイン中：${email}</p>
        <a href="/" class="btn btn-outline-secondary btn-sm mt-1">トップページへ</a>
        <button class="btn btn-outline-danger btn-sm mt-1 ms-2" id="btnAccessDeniedLogout">別のアカウントでログイン</button>
      </div>`;
    document.getElementById('btnAccessDeniedLogout')?.addEventListener('click', () => Auth.signOut());
    const bottomNav = document.querySelector('nav.fixed-bottom');
    if (bottomNav) bottomNav.classList.add('d-none');
  }

  function _showSheetAccessDeniedError() {
    const email = Auth.getUserEmail();
    const main = document.getElementById('appMain');
    if (main) main.innerHTML = `
      <div class="text-center py-5 px-3">
        <i class="bi bi-file-earmark-lock text-warning" style="font-size:3rem;"></i>
        <h5 class="mt-3 fw-bold">スプレッドシートにアクセスできません</h5>
        <p class="text-muted small mt-2">
          このURLの経費ログはまだあなたのアカウントに共有されていません。<br>
          管理者にスプレッドシートの共有を依頼してください。
        </p>
        <p class="text-muted small">ログイン中：${email}</p>
        <button class="btn btn-outline-danger btn-sm mt-1" id="btnSheetDeniedLogout">別のアカウントでログイン</button>
      </div>`;
    document.getElementById('btnSheetDeniedLogout')?.addEventListener('click', () => Auth.signOut());
    const bottomNav = document.querySelector('nav.fixed-bottom');
    if (bottomNav) bottomNav.classList.add('d-none');
  }

  function _setupUI(initialView = 'submit', companyName = '') {
    // URLをシートID付きパスに書き換え（例: /app.html → /SHEET_ID）デモ中は除外
    if (!(typeof Demo !== 'undefined' && Demo.isActive())) {
      const _ssId  = localStorage.getItem('keihi_sheet_id');
      const _alias = localStorage.getItem('keihi_alias');
      // alias を Cookie にも保存（SafariとPWAで共有、既存ユーザー移行）
      if (_alias) _setCookieAlias(_alias);
      if (_ssId && (location.pathname === '/app.html' || location.pathname === '/app')) {
        history.replaceState(null, '', '/' + (_alias || _ssId));
      }
    }

    // 保存済みナビカラーを適用（旧デフォルト#808000は青にリセット）
    const _defaultNavColor = '#0d6efd';
    const _rawNavColor = localStorage.getItem('keihi_nav_color');
    if (_rawNavColor === '#808000') localStorage.removeItem('keihi_nav_color');
    const savedNavColor = (localStorage.getItem('keihi_nav_color')) || _defaultNavColor;
    const navbar = document.querySelector('nav.navbar.sticky-top');
    if (navbar) navbar.style.setProperty('background-color', savedNavColor, 'important');

    // ナビゲーションにユーザーEmail表示
    const nav = document.getElementById('navUserEmail');
    if (nav) nav.textContent = Auth.getUserEmail();

    // ログアウトボタン
    document.getElementById('btnLogout')?.addEventListener('click', () => Auth.signOut());

    // ボトムナビのボタンにイベントリスナーを登録（常に実行）
    Router.init(initialView);
    SwipeNav.init();

    // 確認モーダル初期化
    const modalEl = document.getElementById('confirmModal');
    if (modalEl) {
      _confirmModal = new bootstrap.Modal(modalEl);
      document.getElementById('confirmOk')?.addEventListener('click', () => {
        _confirmModal.hide();
        if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
      });
      document.getElementById('confirmCancel')?.addEventListener('click', () => {
        if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
      });
      modalEl.addEventListener('hidden.bs.modal', () => {
        if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
      });
    }
  }

  /** 確認ダイアログを表示してOK/キャンセルをPromiseで返す
   * @param {string} message メインメッセージ（テキスト）
   * @param {string} [detailHtml] メッセージ下部に追加表示するHTML（任意）
   */
  function confirm(message, detailHtml = '') {
    // 前のダイアログが未解決の場合はキャンセル扱いで閉じてから開く
    if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
    return new Promise(resolve => {
      _confirmResolve = resolve;
      const body = document.getElementById('confirmModalBody');
      if (body) {
        body.innerHTML = '';
        const p = document.createElement('p');
        p.className = 'mb-2';
        p.textContent = message;
        body.appendChild(p);
        if (detailHtml) {
          const detail = document.createElement('div');
          detail.innerHTML = detailHtml;
          body.appendChild(detail);
        }
      }
      _confirmModal?.show();
      // 別モーダルが開いている場合に最前面に表示されるようz-indexを強制設定
      const modalEl2 = document.getElementById('confirmModal');
      if (modalEl2) {
        modalEl2.style.zIndex = '1070';
        setTimeout(() => {
          const backdrops = document.querySelectorAll('.modal-backdrop');
          if (backdrops.length > 0) {
            backdrops[backdrops.length - 1].style.zIndex = '1065';
          }
        }, 0);
      }
    });
  }

  /** マスターデータを返す（キャッシュがあればキャッシュ優先） */
  async function getMaster() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return Demo.MASTER;
    if (_masterCache) return _masterCache;
    _masterCache = await Sheets.readMaster();
    const email = Auth.getUserEmail().toLowerCase();
    if (_masterCache.admins.includes(email)) {
      _userRole = 'admin';
    } else if (_masterCache.viewers && _masterCache.viewers.includes(email)) {
      _userRole = 'viewer';
    } else {
      _userRole = 'member';
    }
    _isAdmin = _userRole === 'admin';
    return _masterCache;
  }

  function clearMasterCache() {
    _masterCache = null;
    try { localStorage.removeItem('keihi_master_cache'); } catch (_) {}
  }

  /**
   * 経費データを返す（Stale-While-Revalidate + 重複リクエスト防止）
   *
   * - 5分以内のキャッシュ  → 即返す（フェッチなし）
   * - 5〜30分のキャッシュ  → 古いデータを即返しつつバックグラウンドで更新（一覧が即表示される）
   * - 30分超 or force=true → 待ってから最新データを返す
   * - 同時複数呼び出し      → 1本のフェッチを共有（重複API呼び出し防止）
   *
   * @param {boolean} [force=false] trueの場合はキャッシュを無視して再取得し結果を待つ
   */
  async function getExpenses(force = false) {
    // デモモード：localStorageキャッシュを読まずに固定サンプルデータを返す
    if (typeof Demo !== 'undefined' && Demo.isActive()) return Demo.EXPENSES;

    // ページリロード後の初回呼び出し：localStorage からキャッシュを復元
    // シートIDが一致する場合のみ使用（別スプレッドシートのデータを表示しないため）
    if (!_expensesCache) {
      try {
        const stored  = JSON.parse(localStorage.getItem('keihi_expenses_cache') || 'null');
        const sheetId = localStorage.getItem('keihi_sheet_id');
        if (stored?.sheetId === sheetId && Array.isArray(stored.data)) {
          _expensesCache   = stored.data;
          // 「やや古い」状態として扱い、次の呼び出し時にバックグラウンド更新させる
          _expensesCacheAt = Date.now() - EXPENSES_CACHE_TTL - 1;
        }
      } catch (_) {}
    }

    const now = Date.now();
    const age = now - _expensesCacheAt;

    // ① フレッシュキャッシュ：即返す
    if (!force && _expensesCache && age < EXPENSES_CACHE_TTL) {
      return _expensesCache;
    }

    // ② ステールキャッシュ（5〜30分）：古いデータを即返しつつバックグラウンド更新
    if (!force && _expensesCache && age < EXPENSES_STALE_TTL) {
      // すでにバックグラウンド更新中でなければ開始（結果は次回呼び出し時に使われる）
      if (!_expensesInflight) {
        _expensesInflight = Sheets.readExpenses()
          .then(rows => {
            _expensesCache   = rows;
            _expensesCacheAt = Date.now();
            _saveExpensesLocal(rows);
          })
          .catch(() => {}) // バックグラウンド失敗は無視（古いデータを継続使用）
          .finally(() => { _expensesInflight = null; });
      }
      return _expensesCache; // 古いデータを即返す
    }

    // ③ キャッシュなし / 30分超 / force=true：重複リクエストがあれば相乗り
    if (_expensesInflight) {
      await _expensesInflight;
      return _expensesCache;
    }
    let resolve, reject;
    _expensesInflight = new Promise((res, rej) => { resolve = res; reject = rej; });
    try {
      const rows       = await Sheets.readExpenses();
      _expensesCache   = rows;
      _expensesCacheAt = Date.now();
      _saveExpensesLocal(rows);
      resolve(rows);
      return _expensesCache;
    } catch (err) {
      reject(err);
      throw err;
    } finally {
      _expensesInflight = null;
    }
  }

  /** 経費データを localStorage に保存（次回起動時の即時表示用） */
  function _saveExpensesLocal(rows) {
    try {
      const sheetId = localStorage.getItem('keihi_sheet_id') || '';
      localStorage.setItem('keihi_expenses_cache', JSON.stringify({ data: rows, sheetId }));
    } catch (_) {} // quota 超過は無視
  }

  /** 経費データキャッシュを破棄（申請・修正・削除後に呼ぶ） */
  function clearExpensesCache() {
    _expensesCache   = null;
    _expensesCacheAt = 0;
    try { localStorage.removeItem('keihi_expenses_cache'); } catch (_) {}
  }

  /**
   * メンバー管理表に登録された名前を返す。
   * 未登録の場合は fallback（シートのB列名やGoogle表示名）を使用。
   */
  function getMemberName(email, fallback) {
    if (!email || !_masterCache?.members?.length) return fallback || email || '';
    const member = _masterCache.members.find(m => m.email.toLowerCase() === email.toLowerCase());
    return (member?.name) || fallback || email || '';
  }

  /** ライセンス確認後に管理者権限を即時反映するためマスターを再読み込みする */
  async function reloadMaster() {
    _masterCache = null;
    const licKey = localStorage.getItem('keihi_license_key') || '';
    const lic = licKey ? await License.verify(licKey) : { valid: false };
    if (!lic.valid) return;
    try {
      _masterCache = await Sheets.readMaster();
    } catch (_) {
      _masterCache = { members: [], categories: [], paySources: [], admins: [], viewers: [] };
    }
    const email = Auth.getUserEmail().toLowerCase();
    const myEntry2 = _masterCache.members?.find(m => m.email?.toLowerCase() === email);
    const explicitNonAdmin2 = myEntry2 && ['member', 'viewer'].includes((myEntry2.role || '').toLowerCase());
    if ((!explicitNonAdmin2 && _masterCache.admins.length === 0) || _masterCache.admins.includes(email)) {
      _userRole = 'admin';
    } else if (_masterCache.viewers?.includes(email)) {
      _userRole = 'viewer';
    } else {
      _userRole = 'member';
    }
    _isAdmin = _userRole === 'admin';
  }

  function isAdmin() { return _isAdmin; }
  function getUserRole() { return _userRole; }

  function _applyDemoNavVisibility(role) {
    const summaryBtn  = document.querySelector('.nav-item-btn[data-view="summary"]');
    const settingsBtn = document.querySelector('.nav-item-btn[data-view="settings"]');
    summaryBtn?.classList.remove('d-none');
    if (role === 'member' || role === 'viewer') {
      settingsBtn?.classList.add('d-none');
    } else {
      settingsBtn?.classList.remove('d-none');
    }
  }

  function _switchDemoRole(role) {
    Demo.setRole(role);
    _userRole = role;
    _isAdmin = role === 'admin';

    const navEmail = document.getElementById('navUserEmail');
    if (navEmail) navEmail.textContent = Demo.getUserEmail();

    document.querySelectorAll('.demo-role-btn').forEach(btn => {
      btn.classList.remove('btn-dark', 'btn-outline-dark');
      btn.classList.add(btn.dataset.role === role ? 'btn-dark' : 'btn-outline-dark');
    });

    _applyDemoNavVisibility(role);

    const cur = Router.current();
    Router.navigate(cur === 'settings' && role !== 'admin' ? 'submit' : cur);
  }

  function _insertDemoRoleSwitcher() {
    const existing = document.getElementById('demoRoleSwitcher');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'demoRoleSwitcher';
    panel.style.cssText = [
      'position:fixed', 'bottom:68px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:9000', 'background:rgba(255,193,7,0.95)', 'border-radius:20px',
      'padding:4px 10px', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'display:flex', 'align-items:center', 'gap:4px',
      'font-size:0.72rem', 'white-space:nowrap'
    ].join(';');

    const label = document.createElement('span');
    label.style.cssText = 'color:#212529;font-weight:600;margin-right:2px;';
    label.textContent = 'デモ:';
    panel.appendChild(label);

    [{ key: 'admin', label: '管理者' }, { key: 'viewer', label: '閲覧者' }, { key: 'member', label: '一般' }].forEach(({ key, label: lbl }) => {
      const btn = document.createElement('button');
      btn.className = `demo-role-btn btn btn-sm ${key === _userRole ? 'btn-dark' : 'btn-outline-dark'}`;
      btn.dataset.role = key;
      btn.textContent = lbl;
      btn.style.cssText = 'padding:2px 8px;font-size:0.7rem;border-radius:12px;line-height:1.4;';
      btn.addEventListener('click', () => _switchDemoRole(key));
      panel.appendChild(btn);
    });

    document.body.appendChild(panel);
  }

  /** ローディングオーバーレイを表示 */
  function showLoading(msg = '処理中...') {
    const el = document.getElementById('loadingOverlay');
    const msgEl = document.getElementById('loadingMsg');
    if (msgEl) msgEl.textContent = msg;
    el?.classList.remove('d-none');
  }

  /** ローディングオーバーレイを非表示 */
  function hideLoading() {
    document.getElementById('loadingOverlay')?.classList.add('d-none');
  }

  /**
   * トースト通知を表示
   * @param {string} message
   * @param {'success'|'danger'|'warning'|'info'} type
   */
  function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const colorMap = { success: 'bg-success', danger: 'bg-danger', warning: 'bg-warning text-dark', info: 'bg-info' };
    const div = document.createElement('div');
    div.className = `toast-item alert ${colorMap[type] || 'bg-info'} text-white shadow py-2 px-3`;
    div.style.cssText = 'animation: fadeIn 0.2s ease;pointer-events:auto;';
    // HTML タグが含まれる場合は innerHTML で描画（リンクなど）
    if (/<[a-z][\s\S]*>/i.test(message)) {
      div.innerHTML = message;
    } else {
      div.textContent = message;
    }
    container.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 0.3s'; setTimeout(() => div.remove(), 300); }, duration);
  }

  function _truncateCompany(name) {
    return name;
  }

  async function _resolveSetupParam() {
    const setupCode = new URLSearchParams(location.search).get('setup');
    if (!setupCode) return;
    try {
      const base = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
      const r = await fetch(`${base}/api/alias?setup=${encodeURIComponent(setupCode)}`);
      if (r.ok) {
        const { licenseKey } = await r.json();
        if (licenseKey && licenseKey.startsWith('KL-')) {
          localStorage.setItem('keihi_license_key', licenseKey);
          localStorage.setItem('keihi_setup_code', setupCode);
        }
      }
    } catch (_) {}
    // URLからsetupパラメータを除去
    try {
      const url = new URL(location.href);
      url.searchParams.delete('setup');
      history.replaceState(null, '', url.pathname + (url.searchParams.size ? '?' + url.searchParams : ''));
    } catch (_) {}
  }

  async function _resolvePathAlias() {
    const match = location.pathname.match(/^\/([a-zA-Z0-9_-]{3,})$/);
    if (!match) {
      // /app.html・/app・/ で起動（PWAショートカット等）
      if (location.pathname === '/app.html' || location.pathname === '/app' || location.pathname === '/') {
        // localStorageを優先（cookieはlocalStorageが空の端末向けフォールバック）
        const alias = localStorage.getItem('keihi_alias') || _getCookieAlias();
        if (alias) {
          try { history.replaceState(null, '', '/' + alias); } catch (_) {}
        }
      }
      return;
    }
    const token = match[1];
    // 44文字以上はシートID直指定
    if (token.length >= 44) {
      const prevSheetId = localStorage.getItem('keihi_sheet_id');
      if (prevSheetId && prevSheetId !== token) {
        ['keihi_company_name', 'keihi_master_cache', 'keihi_folder_id', 'keihi_setup_code',
         'keihi_nav_color', 'keihi_gemini_key', 'keihi_alias', 'keihi_user_email',
         'keihi_regulation', 'keihi_expenses_cache'].forEach(k => localStorage.removeItem(k));
        _expensesCache = null; _expensesCacheAt = 0; // メモリキャッシュも即時クリア
        _sheetIdChanged = true; // init完了後に現在ビューを再描画するフラグ
      }
      sessionStorage.setItem('keihi_sheet_id', token);
      localStorage.setItem('keihi_sheet_id', token);
      return;
    }
    // 3秒タイムアウト・リトライなし（タイムアウト時は既存localStorageのIDで続行）
    try {
      const base = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(base + '/api/alias?code=' + encodeURIComponent(token),
        { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) {
        const data = await r.json();
        if (data.sheetId) {
          const prevSheetId = localStorage.getItem('keihi_sheet_id');
          const prevAlias   = localStorage.getItem('keihi_alias');
          if ((prevSheetId && prevSheetId !== data.sheetId) || (prevAlias && prevAlias !== token)) {
            // 別チームのシートまたは別エイリアスに切り替わる場合、チーム固有データをクリア
            // ライセンスキーはユーザーレベルのため保持（init()内の検証・B3自動取得で上書きされる）
            ['keihi_company_name', 'keihi_master_cache', 'keihi_folder_id', 'keihi_setup_code',
             'keihi_nav_color', 'keihi_gemini_key', 'keihi_alias', 'keihi_user_email',
             'keihi_regulation', 'keihi_expenses_cache'].forEach(k => localStorage.removeItem(k));
            _expensesCache = null; _expensesCacheAt = 0; // メモリキャッシュも即時クリア
            _sheetIdChanged = true; // init完了後に現在ビューを再描画するフラグ
          }
          sessionStorage.setItem('keihi_sheet_id', data.sheetId);
          localStorage.setItem('keihi_sheet_id', data.sheetId);
          localStorage.setItem('keihi_alias', token);
          _setCookieAlias(token);
          if (data.licenseKey && data.licenseKey.startsWith('KL-')) {
            localStorage.setItem('keihi_license_key', data.licenseKey);
          }
          // 会社名が取得できた場合は保存（Picker のフィルタ・案内文に使用）
          if (data.companyName) {
            localStorage.setItem('keihi_company_name', data.companyName);
          }
        } else if (data.licenseKey && data.licenseKey.startsWith('KL-')) {
          localStorage.setItem('keihi_license_key', data.licenseKey);
          localStorage.setItem('keihi_setup_code', token); // setupCodeとしてパスのトークンを保存
        } else {
          // APIは応答したがエイリアスに対応するシートIDもライセンスキーも見つからなかった
          _aliasNotFound = true;
          // 別エイリアスのキャッシュを使わないようシートIDをクリア
          if (localStorage.getItem('keihi_alias') !== token) {
            localStorage.removeItem('keihi_sheet_id');
            sessionStorage.removeItem('keihi_sheet_id');
          }
        }
      } else if (r.status === 404) {
        // 存在しないエイリアス：別エイリアスのキャッシュデータを表示しないようクリア
        _aliasNotFound = true;
        if (localStorage.getItem('keihi_alias') !== token) {
          localStorage.removeItem('keihi_sheet_id');
          sessionStorage.removeItem('keihi_sheet_id');
        }
      }
    } catch (_) {
      // タイムアウト・ネットワークエラーは無視してlocalStorageのIDで続行
    }
  }

  function _setCookieAlias(alias) {
    const maxAge = 365 * 24 * 60 * 60; // 1年
    document.cookie = `keihi_alias=${encodeURIComponent(alias)}; path=/; max-age=${maxAge}; SameSite=Lax`;
  }

  function _getCookieAlias() {
    const m = document.cookie.match(/(?:^|;\s*)keihi_alias=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  /** シートIDが確定するまで待機（_loadHistory など他シートのデータを誤表示しないため） */
  function waitSheetReady() { return _sheetReadyPromise; }

  return {
    init,
    confirm,
    getMaster,
    clearMasterCache,
    reloadMaster,
    getMemberName,
    getExpenses,
    clearExpensesCache,
    waitSheetReady,
    isAdmin,
    getUserRole,
    showLoading,
    hideLoading,
    showToast,
  };
})();

// アプリ起動
document.addEventListener('DOMContentLoaded', () => {
  const _bootError = (msg) => {
    const main = document.getElementById('appMain');
    if (!main) return;
    main.innerHTML = `<div class="pt-4">
      <div class="alert alert-danger small">
        <i class="bi bi-exclamation-triangle-fill me-2"></i>${msg}
      </div>
      <button class="btn btn-outline-secondary btn-sm" onclick="location.reload()">
        <i class="bi bi-arrow-clockwise me-1"></i>再読み込み
      </button>
    </div>`;
  };

  // 必須スクリプトの存在チェック（読み込み失敗で真っ白になるのを防ぐ）
  // 注：トップレベルの const は window に attach されないので typeof で直接参照する
  const missing = [];
  try { if (typeof Demo    === 'undefined') missing.push('Demo'); }    catch (_) { missing.push('Demo'); }
  try { if (typeof Auth    === 'undefined') missing.push('Auth'); }    catch (_) { missing.push('Auth'); }
  try { if (typeof Sheets  === 'undefined') missing.push('Sheets'); }  catch (_) { missing.push('Sheets'); }
  try { if (typeof Router  === 'undefined') missing.push('Router'); }  catch (_) { missing.push('Router'); }
  try { if (typeof App     === 'undefined') missing.push('App'); }     catch (_) { missing.push('App'); }
  if (missing.length > 0) {
    _bootError(`スクリプトの読み込みに失敗しました: ${missing.join(', ')}`);
    return;
  }

  const params = new URLSearchParams(location.search);

  // ?demo パラメータで直接デモ起動（/demo リダイレクト経由）
  if (params.has('demo')) {
    Demo.enable();
  } else {
    // ?demo なしでアクセスした場合は必ずデモを解除（同一タブでの残留対策）
    Demo.disable();
  }

  // ?sheet=SHEET_ID_OR_URL でスプレッドシートを自動設定（管理者がメンバーに共有するURL用）
  const sheetParam = params.get('sheet');
  if (sheetParam) {
    const m = sheetParam.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    const sheetId = m ? m[1] : (/^[a-zA-Z0-9_-]{20,}$/.test(sheetParam) ? sheetParam : null);
    if (sheetId) localStorage.setItem('keihi_sheet_id', sheetId);
  }

  // デモモード：Googleスクリプトを読み込まず即時起動（ポップアップブロック回避）
  if (typeof Demo !== 'undefined' && Demo.isActive()) {
    App.init().catch(err => {
      console.error('App.init error:', err);
      _bootError(`デモモード初期化エラー: ${err.message}`);
    });
    return;
  }

  // 通常モード：PKCE フローのため gapi/GIS 待ちは不要。直接初期化。
  Auth.init();

  // 25秒以内に画面が描画されなければログインページへ強制リダイレクト
  // （License.verifyやSheets APIのタイムアウト漏れ対策）
  const _safetyTimer = setTimeout(() => {
    const main = document.getElementById('appMain');
    if (main && !main.querySelector('h5, .pt-3, form, table, .card, [data-view]')) {
      window.location.href = 'login.html';
    }
  }, 25000);

  App.init()
    .then(() => clearTimeout(_safetyTimer))
    .catch(err => {
      clearTimeout(_safetyTimer);
      console.error('App.init error:', err);
      _bootError(`初期化エラー: ${err.message}`);
    });
});
