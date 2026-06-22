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
  let _confirmPendingResult = null; // OKクリック時に 'ok' をセット、hidden.bs.modal で解決
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

  // シートアクセス確認済みキャッシュ
  // （drive.file で Sheets API アクセス可能と確認できたシートIDを記録し、次回以降の probe を省く）
  const _SHEET_OK_KEY = 'keihi_sheet_access_ok';
  function _isSheetAccessVerified(id) {
    if (!id) return false;
    try { return JSON.parse(localStorage.getItem(_SHEET_OK_KEY) || '[]').includes(id); }
    catch (_) { return false; }
  }
  function _markSheetAccessVerified(id) {
    if (!id) return;
    try {
      const arr = JSON.parse(localStorage.getItem(_SHEET_OK_KEY) || '[]');
      if (!arr.includes(id)) { arr.push(id); localStorage.setItem(_SHEET_OK_KEY, JSON.stringify(arr)); }
    } catch (_) {}
  }

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
    // メンバー（別管理者が作成した共有シート）への直接アクセスは drive.file では不可。
    // → メンバーアクセスはプロキシ経由（クリーンAPI / B'案）で別途実装予定。
    //   未実装の現時点では、直接アクセスできないユーザーには案内のみ表示する。
    if (ssId && !_isSheetAccessVerified(ssId)) {
      const _proxyOn = Sheets.useProxy && Sheets.useProxy();
      // プロキシ有効時は最初からプロキシでアクセス確認（無駄な直接プローブ＝404を出さない）。
      // 無効時のみ従来の drive.file 直接プローブを行う。
      const probe = _proxyOn ? null : await Auth.authFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=spreadsheetId`
      ).catch(() => null);
      if (probe?.ok) {
        _markSheetAccessVerified(ssId);
      } else if (_proxyOn && await Sheets.verifyProxyAccess(ssId).catch(() => false)) {
        // B'プロキシでメンバー確認できれば続行。以降のデータ読み書きはプロキシ経由。
        _markSheetAccessVerified(ssId);
      } else {
        // drive.file では共有シートにアクセスできない（管理者以外）
        // → プロキシ経由のメンバーアクセス実装までは案内のみ表示
        const _mainEl = document.getElementById('appMain');
        if (_mainEl) _mainEl.innerHTML = `
          <div class="text-center py-5 px-3">
            <i class="bi bi-exclamation-circle text-warning" style="font-size:3rem;"></i>
            <h5 class="mt-3 fw-bold">シートにアクセスできません</h5>
            <p class="text-muted mb-3" style="font-size:0.88rem; line-height:1.8;">
              スプレッドシートへの接続に失敗しました。<br>
              セットアップ時に共有設定が完了していない可能性があります。
            </p>
            <p style="font-size:0.83rem;">
              <strong>管理者の方：</strong>下の「設定」タブを開き、<br>
              「サービスアカウントを再共有する」を実行してください。
            </p>
          </div>`;
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
    const _licCache  = (() => { try { return JSON.parse(localStorage.getItem('keihi_license_cache_v2') || 'null'); } catch (_) { return null; } })();
    const _isOwner   = !!(_licCache?.result?.ownerEmail && _licCache.result.ownerEmail === _userEmail);

    const _cachedMaster = (() => {
      try {
        const c = JSON.parse(localStorage.getItem('keihi_master_cache') || 'null');
        // email が一致する場合のみ使用（別アカウントの admin 判定を引き継がない）
        if (c?._cachedAt && c._email === _userEmail && Date.now() - c._cachedAt < MASTER_CACHE_TTL) return c;
      } catch (_) {}
      return null;
    })();
    const masterPromise = _cachedMaster
      ? Promise.resolve(_cachedMaster)
      : Sheets.readMaster().then(m => {
          try { localStorage.setItem('keihi_master_cache', JSON.stringify({ ...m, _cachedAt: Date.now(), _email: _userEmail })); } catch (_) {}
          return m;
        });

    // Stripeポータルからの帰還時（plan_updated=1）はライセンスキャッシュをクリアして再取得
    if (new URLSearchParams(location.search).get('plan_updated') === '1') {
      License.clearCache();
      history.replaceState(null, '', location.pathname);
    }

    const [licResult, masterResult, cfgResult] = await Promise.allSettled([
      License.verify(licKey),
      masterPromise,
      Sheets.readAllSettings(),
    ]);

    // ライセンス検証
    const lic = licResult.status === 'fulfilled' ? licResult.value : { valid: false, reason: 'error' };
    if (!lic.valid) {
      // 期限切れ・停止 → 有料登録導線つきの専用画面（期日後にアプリを開いたときの案内）
      if (lic.reason === 'expired' || lic.reason === 'suspended') {
        if (_quickStarted) Router.navigate('settings'); else _setupUI('settings');
        _showLicenseExpired(lic);
        return;
      }
      // not_found / invalid → 設定画面でキー入力を促す
      if (_quickStarted) {
        Router.navigate('settings'); // 即時描画済みのUIを設定画面で上書き
      } else {
        _setupUI('settings');
      }
      setTimeout(() => showToast('ライセンスキーが無効です。設定画面からライセンスキーを更新してください。', 'danger', 8000), 500);
      return;
    }

    // マスターデータ処理
    // owner判定はキャッシュ（_isOwner）より検証直後の lic.ownerEmail を優先（初回ロードでも正確に）
    const _isOwnerFresh = (lic.valid && lic.ownerEmail) ? (lic.ownerEmail === _userEmail) : _isOwner;
    if (masterResult.status === 'fulfilled') {
      _masterCache = masterResult.value;
      _userRole = _computeRole(_masterCache, _userEmail, _isOwnerFresh);
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
        if (_isOwnerFresh) { _userRole = 'admin'; _isAdmin = true; }
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
    _updateTrialBanner(lic);
    // 設定タブが既に描画済みの場合、ライセンス表示・メンバー制限を最新結果で上書き
    if (typeof SettingsView !== 'undefined') SettingsView.refreshLicenseUI(lic);

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

      // ロールを手元のキャッシュから暫定決定（バックグラウンド検証後に再適用）
      const email   = (session.userInfo?.email || localStorage.getItem('keihi_user_email') || '').toLowerCase();

      // ライセンス・マスターはキャッシュがあれば期限切れでも使用（バックグラウンドで更新）
      const licCache  = JSON.parse(localStorage.getItem('keihi_license_cache_v2') || 'null');
      const masterRaw = JSON.parse(localStorage.getItem('keihi_master_cache') || 'null');
      // マスタキャッシュはチーム全員で共通（admins/membersリストは同一）。
      // 別アカウントが取得したキャッシュでも現ユーザーのロール判定（admins/members照合）に使用可能。
      // init() の _cachedMaster では email タグで TTL チェックするため、
      // email 不一致時は必ずサーバーから再取得される（セキュリティはサーバー側で担保）。
      const master    = masterRaw || { members: [], categories: [], paySources: [], admins: [], viewers: [] };
      const isOwner = !!(licCache?.result?.ownerEmail && licCache.result.ownerEmail === email);
      // キャッシュがある場合のみ _masterCache にセット。
      // ない場合は null のままにして getMaster() にサーバーから取得させる（空スタブを返すと勘定科目が空になる）
      if (masterRaw) _masterCache = master;
      _userRole = _computeRole(master, email, isOwner);
      _isAdmin = _userRole === 'admin';

      // 経費データを localStorage から先読み（bindEvents で getExpenses() が即返すよう）
      // _tryQuickStart() → Router.init() → bindEvents の順に同期で動くため、
      // ここで _expensesCache を設定しておけば最初の await getExpenses() が
      // マイクロタスクで解決し、ブラウザが描画する前にテーブルが埋まる
      try {
        const stored  = JSON.parse(localStorage.getItem('keihi_expenses_cache') || 'null');
        const sheetId = localStorage.getItem('keihi_sheet_id');
        // sheetId と email の両方が一致する場合のみ使用（別アカウントのデータ表示を防ぐ）
        if (stored?.sheetId === sheetId && stored.email === email && Array.isArray(stored.data)) {
          _expensesCache   = stored.data;
          _expensesCacheAt = Date.now() - EXPENSES_CACHE_TTL - 1; // ステール扱いでバックグラウンド更新
        }
      } catch (_) {}

      // UIを即時描画（会社名・規程もキャッシュから）
      const companyName = localStorage.getItem('keihi_company_name') || '';
      if (companyName) {
        document.title = `経費ログ | ${companyName}`;
        const titleEl = document.getElementById('navAppTitle');
        if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(companyName)}`;
      }
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

  /** Stripe Payment Link（有料転換用）のURLを組み立てる。client_reference_id に
   *  既存ライセンスキーを載せることで、webhook が新キーを発行せず既存ライセンスを延長する。
   *  プラン（solo/team）は支払い時に選ぶ＝同じキーに選んだプランが適用される。 */
  /**
   * "消耗品費:880:課税10%/会議費:1080:課税8%" → [{cat, amount, taxRate}, ...]
   * "消耗品費:880/会議費:1080"（旧: taxRateなし）→ taxRate: null
   * "消耗品費/会議費"（旧: amountなし）→ amount: null, taxRate: null
   */
  function parseSplitCategory(categoryStr) {
    return (categoryStr || '').split('/').map(s => {
      const parts = s.trim().split(':');
      const cat     = parts[0].trim();
      const amount  = parts[1] !== undefined ? Number(parts[1]) : null;
      const taxRate = parts[2] || null;
      return { cat, amount, taxRate };
    }).filter(p => p.cat);
  }

  /** "消耗品費:880/会議費:1080" → "消耗品費/会議費"（表示用） */
  function categoryLabel(categoryStr) {
    return parseSplitCategory(categoryStr).map(p => p.cat).join('/');
  }

  function buildUpgradeUrl(plan, licenseKey, email) {
    const s = (window.APP_CONFIG && window.APP_CONFIG.stripe) || {};
    const p = plan === 'team' ? 'team' : 'solo';
    const base = (s.upgradeLinks && s.upgradeLinks[p]) || (s.signupLinks && s.signupLinks[p]) || '';
    if (!base) return '';
    let url = base + (base.includes('?') ? '&' : '?') + 'client_reference_id=' + encodeURIComponent(licenseKey || '');
    if (email) url += '&prefilled_email=' + encodeURIComponent(email);
    return url;
  }

  /** 有料登録のソロ/チーム2択ボタンHTMLを返す（キーは継続・支払い時にプラン確定）。
   *  どちらのリンクも設定が無ければ空文字を返す。 */
  function buildPlanChoiceButtons(licenseKey, email) {
    const solo = buildUpgradeUrl('solo', licenseKey, email);
    const team = buildUpgradeUrl('team', licenseKey, email);
    if (!solo && !team) return '';
    const card = (url, name, price, desc, primary) => !url ? '' : `
      <a href="${url}" target="_blank" rel="noopener" class="btn ${primary ? 'btn-primary' : 'btn-outline-primary'} d-block text-start rounded-3 px-3 py-2 mb-2">
        <span class="fw-bold">${name}</span> <span class="ms-1" style="font-size:0.85rem;">${price}</span>
        <span class="d-block text-muted-light" style="font-size:0.74rem;opacity:0.85;">${desc}</span>
      </a>`;
    return `<div class="mx-auto" style="max-width:340px;">
      ${card(solo, 'ソロプラン', '月330円（税込）', '1人で使う', false)}
      ${card(team, 'チームプラン', '月825円（税込）', 'チームで使う', true)}
    </div>`;
  }

  /** トライアル中バナーを表示（残り日数を毎回計算） */
  function _updateTrialBanner(lic) {
    const banner = document.getElementById('trialBanner');
    const textEl = document.getElementById('trialBannerText');
    if (!banner || !textEl) return;
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    if (isDemo || !lic?.valid || !lic.trial) {
      banner.style.display = 'none';
      return;
    }
    const msLeft = lic.expiresAt ? new Date(lic.expiresAt) - new Date() : Infinity;
    const daysLeft = msLeft === Infinity ? null : Math.max(0, Math.ceil(msLeft / 86400000));
    textEl.textContent = daysLeft !== null
      ? `無料トライアル中（残り${daysLeft}日）`
      : '無料トライアル中';
    // バナーボタン：管理者は設定タブへ誘導、非管理者は非表示
    const upgradeBtn = document.getElementById('trialBannerUpgradeBtn');
    if (upgradeBtn) {
      if (_isAdmin) {
        upgradeBtn.style.display = '';
        upgradeBtn.removeAttribute('href');
        upgradeBtn.removeAttribute('target');
        upgradeBtn.removeAttribute('rel');
        upgradeBtn.onclick = (e) => {
          e.preventDefault();
          document.querySelector('[data-view=settings]')?.click();
        };
      } else {
        upgradeBtn.style.display = 'none';
      }
    }
    banner.style.display = '';
  }

  /**
   * Stripeの支払い完了後に別タブから戻った時にキャッシュをクリアしてバナーを即時更新する。
   * visibilitychange イベント用。直前のライセンスが trial だった場合のみ再検証する。
   */
  async function recheckTrialAfterReturn() {
    const key = localStorage.getItem('keihi_license_key');
    if (!key) return;
    try {
      const cached = JSON.parse(localStorage.getItem('keihi_license_cache_v2') || 'null');
      if (!cached?.result?.trial) return; // trial でなければ不要
    } catch (_) { return; }
    License.clearCache();
    const lic = await License.verify(key).catch(() => null);
    if (!lic) return;
    _updateTrialBanner(lic);
    // 設定タブの trialUpgradeBox も更新（現在設定タブが表示中であれば反映）
    if (typeof Settings !== 'undefined' && Settings.refreshLicenseUI) {
      Settings.refreshLicenseUI(lic);
    }
  }

  /** トライアル期限切れ／ライセンス無効時の案内画面（有料登録ボタン付き） */
  function _showLicenseExpired(lic) {
    const main = document.getElementById('appMain');
    if (!main) return;
    const key   = localStorage.getItem('keihi_license_key') || '';
    const email = (typeof Auth !== 'undefined' && Auth.getUserEmail && Auth.getUserEmail()) || '';
    const isExpired = lic.reason === 'expired';
    const wasTrial  = lic.trial === true;
    const planButtons = buildPlanChoiceButtons(key, email);
    const heading = isExpired
      ? (wasTrial ? '無料トライアルが終了しました' : 'ライセンスの有効期限が切れています')
      : (lic.reason === 'suspended' ? 'ライセンスが停止されています' : 'ライセンスキーが無効です');
    const lead = isExpired && !wasTrial
      ? 'クレジットカードの有効期限切れなどでお支払いが完了しなかった可能性があります。<br>カスタマーポータルでカード情報を更新してください。'
      : isExpired
        ? '引き続きご利用いただくには、下からプランを選んでお支払い手続きをお願いします。<br>登録後もライセンスキー・データ・設定はそのまま引き継がれます。'
        : '設定画面からライセンスキーをご確認ください。';
    main.innerHTML = `
      <div class="text-center py-5 px-3">
        <i class="bi bi-stars text-warning" style="font-size:3rem;"></i>
        <h5 class="mt-3 fw-bold">${heading}</h5>
        <p class="text-muted small mt-2" style="line-height:1.9;">${lead}</p>
        ${isExpired && !wasTrial ? `
          <button class="btn btn-primary mt-2" id="btnOpenPortal">
            <i class="bi bi-arrow-repeat me-1"></i>カスタマーポータルを開く
          </button>
          ${planButtons ? `
          <div class="mt-4 pt-3 border-top">
            <p class="text-muted small mb-2">プランを変更する場合はこちら</p>
            ${planButtons}
          </div>` : ''}
          <div class="text-muted mt-3" style="font-size:0.78rem;">
            ご不明な点は <a href="mailto:support@keihi-log.com">support@keihi-log.com</a> までご連絡ください。
          </div>` : isExpired && planButtons ? `
          <div class="mt-3">${planButtons}</div>
          <div class="text-muted mt-2" style="font-size:0.78rem;">
            お支払いはStripeの安全な決済ページで行われます。<br>
            ご不明な点は <a href="mailto:support@keihi-log.com">support@keihi-log.com</a> までご連絡ください。
          </div>` : `
          <button class="btn btn-outline-primary btn-sm mt-2" id="btnExpiredToSettings">設定画面を開く</button>`}
      </div>`;
    document.getElementById('btnExpiredToSettings')?.addEventListener('click', () => Router.navigate('settings'));
    document.getElementById('btnOpenPortal')?.addEventListener('click', async () => {
      if (!key) { showToast('ライセンスキーが設定されていません', 'danger'); return; }
      showLoading('ポータルを開いています...');
      try {
        const res = await fetch('/api/portal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
        const { url, error } = await res.json();
        if (!url) throw new Error(error || 'portal_error');
        window.location.href = url;
      } catch (err) {
        const msg = ['stripe_error', 'no_session', 'no_customer'].includes(err.message)
          ? 'カスタマーポータルを開けませんでした。support@keihi-log.com までお問い合わせください。'
          : 'ポータルを開けませんでした: ' + err.message;
        showToast(msg, 'danger');
      } finally {
        hideLoading();
      }
    });
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

  function _applyStoredNavColor() {
    const defaultColor = '#0d6efd';
    const ssId = localStorage.getItem('keihi_sheet_id');
    const key  = ssId ? `keihi_nav_color_${ssId}` : 'keihi_nav_color';
    const raw  = localStorage.getItem(key);
    const color = (raw && raw !== '#808000') ? raw : defaultColor;
    const navbar = document.querySelector('nav.navbar.sticky-top');
    if (navbar) navbar.style.setProperty('background-color', color, 'important');
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

    // 保存済みナビカラーを適用（シート固有キー優先、グローバルキーは旧互換）
    _applyStoredNavColor();

    // ナビゲーションにユーザーEmail表示
    const nav = document.getElementById('navUserEmail');
    if (nav) nav.textContent = Auth.getUserEmail();

    // ロゴ／タイトルクリックで申請タブ（初期画面）へ
    document.getElementById('btnNavHome')?.addEventListener('click', () => Router.navigate('submit'));

    // ログアウトボタン
    document.getElementById('btnLogout')?.addEventListener('click', () => Auth.signOut());

    // ボトムナビのボタンにイベントリスナーを登録（常に実行）
    Router.init(initialView);
    SwipeNav.init();

    // 確認モーダル初期化
    const modalEl = document.getElementById('confirmModal');
    if (modalEl) {
      _confirmModal = new bootstrap.Modal(modalEl);
      // OK: 結果を記録してモーダルを閉じ、hidden.bs.modal で解決（フェードアウト中の二重発火を防ぐ）
      document.getElementById('confirmOk')?.addEventListener('click', () => {
        _confirmPendingResult = 'ok';
        _confirmModal.hide();
      });
      // Cancel: data-bs-dismiss がhideを起動するので結果だけ記録
      document.getElementById('confirmCancel')?.addEventListener('click', () => {
        _confirmPendingResult = 'cancel';
      });
      // hidden.bs.modal: モーダルが完全に閉じてから Promise を解決する
      modalEl.addEventListener('hidden.bs.modal', () => {
        const result = _confirmPendingResult;
        _confirmPendingResult = null;
        if (_confirmResolve) { _confirmResolve(result === 'ok'); _confirmResolve = null; }
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
    // getMaster はライセンス情報を持たないため isOwner=false。
    // init/reloadMaster で確定済みの _isAdmin は上書きしない。
    const role = _computeRole(_masterCache, email, false);
    if (role !== _userRole) { _userRole = role; _isAdmin = role === 'admin'; }
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
        // sheetId と email の両方が一致する場合のみ使用（別アカウントのデータ表示を防ぐ）
        if (stored?.sheetId === sheetId && stored.email === _curEmail() && Array.isArray(stored.data)) {
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
    //    ただし force（明示更新）の場合は古い相乗り結果で済まさず必ず取り直す
    if (_expensesInflight && !force) {
      await _expensesInflight;
      return _expensesCache;
    }
    let resolve, reject;
    _expensesInflight = new Promise((res, rej) => { resolve = res; reject = rej; });
    try {
      // force 時はサーバーKVキャッシュもバイパス
      const rows       = await Sheets.readExpenses(undefined, force);
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

  /**
   * ロールを決定する単一ヘルパー（クライアント・サーバー共通ルール）。
   * admin = D列='admin'。D列に admin が一人もいない時のみ owner を admin にフォールバック昇格。
   * これにより「購入者が D列で別の人に admin を譲って自分は降りる」が成立し、
   * 全 admin 消滅時は owner が自動復帰してロックアウトを防ぐ。
   */
  function _computeRole(master, email, isOwner) {
    const e = (email || '').toLowerCase();
    const admins = master.admins || [];
    if (admins.includes(e) || (isOwner && admins.length === 0)) return 'admin';
    if ((master.viewers || []).includes(e)) return 'viewer';
    return 'member';
  }

  /** 現在ログイン中のユーザーemail（小文字）。同一端末でのアカウント切替検出に使う。 */
  function _curEmail() {
    try {
      const s = JSON.parse(localStorage.getItem('keihi_auth_session') || 'null');
      return (s?.userInfo?.email || localStorage.getItem('keihi_user_email') || '').toLowerCase();
    } catch (_) {
      return (localStorage.getItem('keihi_user_email') || '').toLowerCase();
    }
  }

  /** 経費データを localStorage に保存（次回起動時の即時表示用）。
   *  email を付与し、別アカウントで開いた際に他人のデータを表示しないようにする。 */
  function _saveExpensesLocal(rows) {
    try {
      const sheetId = localStorage.getItem('keihi_sheet_id') || '';
      // 署名URLは7日TTLなので正規化せずそのまま保存。
      // 復元時に有効な署名URLがそのまま使われ、画像が即表示される。
      localStorage.setItem('keihi_expenses_cache', JSON.stringify({ data: rows, sheetId, email: _curEmail() }));
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
    const licCache2 = (() => { try { return JSON.parse(localStorage.getItem('keihi_license_cache_v2') || 'null'); } catch (_) { return null; } })();
    const isOwner2 = !!(licCache2?.result?.ownerEmail && licCache2.result.ownerEmail === email);
    _userRole = _computeRole(_masterCache, email, isOwner2);
    _isAdmin = _userRole === 'admin';
    _applyAdminVisibility();
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
   * エラーをユーザー向けの日本語メッセージに変換する。
   * FAQリンクを含むHTMLを返す場合あり。
   */
  function friendlyError(err, context) {
    const m = String(err?.message || '');
    if (m.includes('admin_only'))
      return 'この操作には管理者権限が必要です（マスタ表のD列にadminが設定されていないか、ライセンス購入メールとログインメールが異なる可能性があります）';
    if (m.startsWith('proxy') && m.includes('503'))
      return 'サーバーがスプレッドシートにアクセスできません。管理者にサービスアカウントの共有設定を確認するよう依頼してください。';
    if (m.startsWith('proxy') && m.includes('403'))
      return 'メンバーとして認識されていません。設定でメールアドレスの権限を確認し、ページを再読み込みしてください。';
    if (m.includes('403') || m.includes('permission') || m.includes('PERMISSION_DENIED'))
      return `アクセス権がありません。管理者に共有設定を依頼してください。<a href="/faq#q801" class="alert-link ms-1">詳細</a>`;
    if (m.includes('401') || m.toLowerCase().includes('unauthorized') || m.includes('token'))
      return 'セッションが切れました。ページを再読み込みしてください。';
    if (m.toLowerCase().includes('failed to fetch') || m.includes('network') || m.includes('NetworkError'))
      return '通信エラーが発生しました。ネットワーク接続を確認してください。';
    if (m.includes('quota') || m.includes('RESOURCE_EXHAUSTED') || m.includes('429'))
      return `APIの利用上限に達しました。しばらくしてから再試行してください。<a href="/faq#q403" class="alert-link ms-1">詳細</a>`;
    if (context === 'load')
      return `データの読み込みに失敗しました。再読み込みしてください。<a href="/faq#q801" class="alert-link ms-1">詳細</a>`;
    return '処理に失敗しました。しばらく経ってから再試行してください。';
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
         'keihi_gemini_key', 'keihi_alias', 'keihi_user_email',
         'keihi_regulation', 'keihi_expenses_cache'].forEach(k => localStorage.removeItem(k));
        _expensesCache = null; _expensesCacheAt = 0; // メモリキャッシュも即時クリア
        _sheetIdChanged = true; // init完了後に現在ビューを再描画するフラグ
      }
      sessionStorage.setItem('keihi_sheet_id', token);
      localStorage.setItem('keihi_sheet_id', token);
      _applyStoredNavColor();
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
             'keihi_gemini_key', 'keihi_alias', 'keihi_user_email',
             'keihi_regulation', 'keihi_expenses_cache'].forEach(k => localStorage.removeItem(k));
            _expensesCache = null; _expensesCacheAt = 0; // メモリキャッシュも即時クリア
            _sheetIdChanged = true; // init完了後に現在ビューを再描画するフラグ
          }
          sessionStorage.setItem('keihi_sheet_id', data.sheetId);
          localStorage.setItem('keihi_sheet_id', data.sheetId);
          _applyStoredNavColor();
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
          const prevLicKey = localStorage.getItem('keihi_license_key');
          // 別ライセンスのセットアップURLを開いた場合、既存シートデータをクリアしてセットアップへ誘導
          if (prevLicKey && prevLicKey !== data.licenseKey) {
            ['keihi_sheet_id', 'keihi_alias', 'keihi_company_name', 'keihi_master_cache',
             'keihi_folder_id', 'keihi_setup_code', 'keihi_gemini_key',
             'keihi_user_email', 'keihi_regulation', 'keihi_expenses_cache'].forEach(k => localStorage.removeItem(k));
            sessionStorage.removeItem('keihi_sheet_id');
          }
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
    parseSplitCategory,
    categoryLabel,
    getMemberName,
    getExpenses,
    clearExpensesCache,
    waitSheetReady,
    isAdmin,
    getUserRole,
    showLoading,
    hideLoading,
    showToast,
    friendlyError,
    buildUpgradeUrl,
    buildPlanChoiceButtons,
    recheckTrialAfterReturn,
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
