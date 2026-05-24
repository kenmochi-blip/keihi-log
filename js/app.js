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

  async function init() {
    // デモモード：認証・ライセンス・シート確認をスキップ
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      _masterCache = Demo.MASTER;
      const demoRole = Demo.getRole();
      _userRole = demoRole;
      _isAdmin = demoRole === 'admin';
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

    // ?setup= パラメータがあればライセンスキーをlocalStorageに自動入力
    await _resolveSetupParam();

    // URLパスからエイリアス/シートIDを解決してlocalStorageに反映
    await _resolvePathAlias();

    // 認証トークン確認（未認証・リフレッシュ失敗時はログイン画面へ）
    try {
      await Auth.getToken();
    } catch (_) {
      const _isGenericPath = location.pathname === '/app.html' || location.pathname === '/app' || location.pathname === '/';
      let ret = _isGenericPath ? '' : location.pathname;
      if (!ret) { const ca = _getCookieAlias(); if (ca) ret = '/' + ca; }
      window.location.href = 'login.html' + (ret ? '?return=' + encodeURIComponent(ret) : '');
      return;
    }

    // ライセンス・シート未設定の場合は申請画面を表示してバナーで案内
    let licKey = localStorage.getItem('keihi_license_key');
    const ssId = localStorage.getItem('keihi_sheet_id');
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
    if (!ssId) {
      if (_aliasNotFound) {
        _showAliasNotFoundError();
      } else {
        window.location.replace('/setup');
      }
      return;
    }
    if (!licKey) {
      _setupUI('submit');
      return;
    }
    const lic = await License.verify(licKey);
    if (!lic.valid) {
      _setupUI('settings');
      // ライセンス無効の理由をトーストで案内
      const reason = lic.reason === 'expired'   ? 'ライセンスの有効期限が切れています。' :
                     lic.reason === 'suspended'  ? 'ライセンスが停止されています。' :
                                                   'ライセンスキーが無効です。';
      setTimeout(() => showToast(
        `${reason}設定画面からライセンスキーを更新してください。`,
        'danger', 8000
      ), 500);
      return;
    }

    // マスターデータ読み込みと管理者判定
    try {
      _masterCache = await Sheets.readMaster();
      const email  = Auth.getUserEmail().toLowerCase();

      // ライセンス購入者メールをキャッシュから取得（シート設定に関わらず管理者扱い）
      let isOwner = false;
      try {
        const _lc = JSON.parse(localStorage.getItem('keihi_license_cache') || 'null');
        if (_lc?.result?.ownerEmail && _lc.result.ownerEmail === email) isOwner = true;
      } catch (_e) {}

      if (isOwner || _masterCache.admins.length === 0 || _masterCache.admins.includes(email)) {
        _userRole = 'admin';
      } else if (_masterCache.viewers && _masterCache.viewers.includes(email)) {
        _userRole = 'viewer';
      } else {
        _userRole = 'member';
      }
      _isAdmin = _userRole === 'admin';

      // メンバー制限：登録メンバーが1人以上いる場合、未登録ユーザーはアクセス不可
      // 管理者（isOwner含む）はメンバーリストの有無に関わらず常にアクセス許可
      if (_userRole !== 'admin' && _masterCache.members.length > 0 && !_masterCache.members.some(m => m.email.toLowerCase() === email)) {
        // 組織名をヘッダーに表示してからアクセス拒否を案内する
        const _cachedCompany = localStorage.getItem('keihi_company_name') || '';
        if (_cachedCompany) {
          const titleEl = document.getElementById('navAppTitle');
          if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(_cachedCompany)}`;
        }
        Sheets.readSetting('B2').then(fetched => {
          if (fetched) {
            if (fetched !== _cachedCompany) localStorage.setItem('keihi_company_name', fetched);
            const titleEl = document.getElementById('navAppTitle');
            if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(fetched)}`;
          }
        }).catch(() => {});
        _setupUI('settings');
        showToast('このアプリへのアクセス権がありません。管理者に連絡してください。', 'danger', 8000);
        return;
      }
    } catch (_) {
      _masterCache = { members: [], categories: [], paySources: [], admins: [], viewers: [] };
      // ライセンスオーナーのみ管理者フォールバック（設定画面で復旧できるように）
      try {
        const _cached = JSON.parse(localStorage.getItem('keihi_license_cache') || 'null');
        const _email  = Auth.getUserEmail().toLowerCase();
        if (_cached?.result?.ownerEmail && _cached.result.ownerEmail === _email) {
          _userRole = 'admin';
          _isAdmin  = true;
        }
      } catch (_e) {}
    }

    // 会社名をナビタイトルに反映（キャッシュ優先で即時表示、APIで更新）
    let _companyName = localStorage.getItem('keihi_company_name') || '';
    if (_companyName) {
      const titleEl = document.getElementById('navAppTitle');
      if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(_companyName)}`;
      document.title = `経費ログ | ${_companyName}`;
    }
    try {
      const fetched = await Sheets.readSetting('B2') || '';
      if (fetched && fetched !== _companyName) {
        _companyName = fetched;
        localStorage.setItem('keihi_company_name', fetched);
        const titleEl = document.getElementById('navAppTitle');
        if (titleEl) titleEl.textContent = `経費ログ - ${_truncateCompany(fetched)}`;
        document.title = `経費ログ | ${fetched}`;
      }
    } catch (_) {}

    // フォルダIDをシートから復元（新ドメイン等でlocalStorageが空の場合）
    if (!localStorage.getItem('keihi_folder_id')) {
      Sheets.readSetting('B4').then(fid => {
        if (fid) localStorage.setItem('keihi_folder_id', fid);
      }).catch(() => {});
    }

    _setupUI('submit', _companyName);

    // 管理者以外は設定タブを非表示
    if (!_isAdmin) {
      document.querySelector('.nav-item-btn[data-view="settings"]')?.classList.add('d-none');
    }
  }

  function _showAliasNotFoundError() {
    const boot = document.getElementById('initialBoot');
    if (boot) boot.innerHTML = `
      <div class="text-center py-5 px-3">
        <i class="bi bi-exclamation-circle text-warning" style="font-size:3rem;"></i>
        <h5 class="mt-3 fw-bold">このURLは見つかりませんでした</h5>
        <p class="text-muted small mt-2">URLが正しくない可能性があります。<br>管理者から共有されたURLをご確認ください。</p>
        <a href="/" class="btn btn-outline-primary btn-sm mt-2">トップページへ</a>
      </div>`;
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
      // チーム別ショートカット用：動的マニフェストを生成してstart_urlにエイリアスURLを設定
      const startPath = '/' + (_alias || _ssId || 'app.html');
      _injectDynamicManifest(startPath, companyName);
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

  function clearMasterCache() { _masterCache = null; }

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
    if (_masterCache.admins.length === 0 || _masterCache.admins.includes(email)) {
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
    div.style.cssText = 'animation: fadeIn 0.2s ease;';
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
        // alias があれば URL バーだけ書き換える（ページリロードなし）
        // 動的マニフェストがすでに start_url に alias を設定しているため
        // location.replace による再読み込みは不要
        const alias = _getCookieAlias() || localStorage.getItem('keihi_alias');
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
        ['keihi_company_name', 'keihi_license_key', 'keihi_license_cache',
         'keihi_master_cache', 'keihi_folder_id', 'keihi_setup_code',
         'keihi_nav_color', 'keihi_gemini_key', 'keihi_alias', 'keihi_user_email'].forEach(k => localStorage.removeItem(k));
      }
      sessionStorage.setItem('keihi_sheet_id', token);
      localStorage.setItem('keihi_sheet_id', token);
      return;
    }
    // 5秒タイムアウト・リトライなし（タイムアウト時は既存localStorageのIDで続行）
    try {
      const base = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || '';
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(base + '/api/alias?code=' + encodeURIComponent(token),
        { signal: ctrl.signal });
      clearTimeout(tid);
      if (r.ok) {
        const data = await r.json();
        if (data.sheetId) {
          const prevSheetId = localStorage.getItem('keihi_sheet_id');
          if (prevSheetId && prevSheetId !== data.sheetId) {
            // 別チームのシートに切り替わる場合、チーム固有データをクリア
            ['keihi_company_name', 'keihi_license_key', 'keihi_license_cache',
             'keihi_master_cache', 'keihi_folder_id', 'keihi_setup_code',
             'keihi_nav_color', 'keihi_gemini_key', 'keihi_alias', 'keihi_user_email'].forEach(k => localStorage.removeItem(k));
          }
          sessionStorage.setItem('keihi_sheet_id', data.sheetId);
          localStorage.setItem('keihi_sheet_id', data.sheetId);
          localStorage.setItem('keihi_alias', token);
          _setCookieAlias(token);
        } else if (data.licenseKey && data.licenseKey.startsWith('KL-')) {
          localStorage.setItem('keihi_license_key', data.licenseKey);
          localStorage.setItem('keihi_setup_code', token); // setupCodeとしてパスのトークンを保存
        } else if (!localStorage.getItem('keihi_sheet_id')) {
          // APIは応答したがエイリアスに対応するシートIDもライセンスキーも見つからなかった
          _aliasNotFound = true;
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

  function _injectDynamicManifest(startPath, companyName) {
    try {
      const appName = companyName ? `経費ログ - ${companyName}` : '経費ログ';
      const manifest = {
        name: appName,
        short_name: companyName || '経費ログ',
        description: 'AI領収書解析・経費申請・承認・集計をブラウザで完結できる経費管理Webアプリ',
        start_url: startPath,
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#0d6efd',
        lang: 'ja',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      };
      const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
      const url  = URL.createObjectURL(blob);
      const link = document.querySelector('link[rel="manifest"]');
      if (link) link.href = url;
    } catch (_) {}
  }

  function updateDynamicManifest(startPath, companyName) {
    _injectDynamicManifest(startPath, companyName || '');
  }

  return {
    init,
    confirm,
    getMaster,
    clearMasterCache,
    reloadMaster,
    getMemberName,
    isAdmin,
    getUserRole,
    showLoading,
    hideLoading,
    showToast,
    updateDynamicManifest,
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
