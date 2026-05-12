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

  async function init() {
    // デモモード：認証・ライセンス・シート確認をスキップ
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      _masterCache = Demo.MASTER;
      const demoRole = Demo.getRole();
      _userRole = demoRole;
      _isAdmin = demoRole === 'admin';
      _setupUI('submit');
      const titleEl = document.getElementById('navAppTitle');
      if (titleEl) titleEl.textContent = `経費ログ - ${Demo.COMPANY_NAME}`;
      const navEmail = document.getElementById('navUserEmail');
      if (navEmail) navEmail.textContent = Demo.getUserEmail();
      _applyDemoNavVisibility(demoRole);
      _insertDemoRoleSwitcher();
      showToast('デモモード：サンプルデータで動作中', 'info');
      return;
    }

    // 認証トークン確認（未認証ならログイン画面へ）
    try {
      await Auth.getToken();
    } catch (_) {
      window.location.href = 'index.html';
      return;
    }

    // Driveから設定を読み込んでlocalStorageに反映（端末間同期）
    try {
      const saved = await Drive.loadSettings();
      if (saved) {
        if (saved.licenseKey) localStorage.setItem('keihi_license_key', saved.licenseKey);
        if (saved.sheetId)    localStorage.setItem('keihi_sheet_id',    saved.sheetId);
        if (saved.folderId)   localStorage.setItem('keihi_folder_id',   saved.folderId);
      }
    } catch (_) { /* Drive読み込み失敗は無視してlocalStorageで続行 */ }

    // ライセンス・シート未設定の場合は申請画面を表示してバナーで案内
    const licKey = localStorage.getItem('keihi_license_key');
    if (!licKey || !localStorage.getItem('keihi_sheet_id')) {
      _setupUI('submit');
      return;
    }
    const lic = await License.verify(licKey);
    if (!lic.valid) {
      _setupUI('submit');
      return;
    }

    // マスターデータ読み込みと管理者判定
    try {
      _masterCache = await Sheets.readMaster();
      const email  = Auth.getUserEmail().toLowerCase();
      // 管理者が誰も登録されていない場合（初期状態）は現ユーザーを管理者扱い
      if (_masterCache.admins.length === 0 || _masterCache.admins.includes(email)) {
        _userRole = 'admin';
      } else if (_masterCache.viewers && _masterCache.viewers.includes(email)) {
        _userRole = 'viewer';
      } else {
        _userRole = 'member';
      }
      _isAdmin = _userRole === 'admin';

      // メンバー制限：登録メンバーが1人以上いる場合、未登録ユーザーはアクセス不可
      if (_masterCache.members.length > 0 && !_masterCache.members.some(m => m.email.toLowerCase() === email)) {
        _setupUI('settings');
        showToast('このアプリへのアクセス権がありません。管理者に連絡してください。', 'danger');
        return;
      }
    } catch (_) {
      _masterCache = { members: [], categories: [], paySources: [], admins: [], viewers: [] };
      _userRole = 'admin';
      _isAdmin = true; // マスタ読み込み失敗時も管理者扱いにして設定できるようにする
    }

    // 会社名をナビタイトルに反映
    try {
      const companyName = await Sheets.readSetting('B2');
      if (companyName) {
        const titleEl = document.getElementById('navAppTitle');
        if (titleEl) titleEl.textContent = `経費ログ - ${companyName}`;
      }
    } catch (_) {}

    _setupUI('submit');
  }

  function _setupUI(initialView = 'submit') {
    // URLをシートID付きパスに書き換え（例: /app.html → /SHEET_ID）デモ中は除外
    if (!(typeof Demo !== 'undefined' && Demo.isActive())) {
      const _ssId = localStorage.getItem('keihi_sheet_id');
      if (_ssId && location.pathname === '/app.html') {
        history.replaceState(null, '', '/' + _ssId);
      }
    }

    // 保存済みナビカラーを適用（デモは青、通常はオリーブをデフォルトに）
    const _defaultNavColor = (typeof Demo !== 'undefined' && Demo.isActive()) ? '#0d6efd' : '#808000';
    const savedNavColor = localStorage.getItem('keihi_nav_color') || _defaultNavColor;
    const navbar = document.querySelector('nav.navbar.sticky-top');
    if (navbar) navbar.style.setProperty('background-color', savedNavColor, 'important');

    // ナビゲーションにユーザーEmail表示
    const nav = document.getElementById('navUserEmail');
    if (nav) nav.textContent = Auth.getUserEmail();

    // ログアウトボタン
    document.getElementById('btnLogout')?.addEventListener('click', () => Auth.signOut());

    // ボトムナビのボタンにイベントリスナーを登録（常に実行）
    Router.init(initialView);

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

  return {
    init,
    confirm,
    getMaster,
    clearMasterCache,
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

  // 通常モード：gapi・GIS を動的ロードしてから初期化
  let gapiReady = false, gisReady = false;
  let _apiLoadFailed = false;

  function _onApiLoadError(name) {
    if (_apiLoadFailed) return;
    _apiLoadFailed = true;
    _bootError(`Google APIの読み込みに失敗しました（${name}）。ネットワーク接続を確認してページを再読み込みしてください。`);
  }

  function _onBothReady() {
    try {
      gapi.load('client', async () => {
        try {
          await gapi.client.init({
            discoveryDocs: [
              'https://sheets.googleapis.com/$discovery/rest?version=v4',
              'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'
            ]
          });
          Auth.init();
          App.init().catch(err => {
            console.error('App.init error:', err);
            _bootError(`初期化エラー: ${err.message}`);
          });
        } catch (err) {
          console.error('gapi.client.init error:', err);
          _bootError(`Google APIの初期化に失敗しました: ${err.message}`);
        }
      });
    } catch (err) {
      console.error('gapi.load error:', err);
      _bootError(`Google APIの読み込みに失敗しました: ${err.message}`);
    }
  }

  const gapiScript = document.createElement('script');
  gapiScript.src = 'https://apis.google.com/js/api.js';
  gapiScript.onload = () => { gapiReady = true; if (gisReady) _onBothReady(); };
  gapiScript.onerror = () => _onApiLoadError('gapi');
  document.head.appendChild(gapiScript);

  const gisScript = document.createElement('script');
  gisScript.src = 'https://accounts.google.com/gsi/client';
  gisScript.onload = () => { gisReady = true; if (gapiReady) _onBothReady(); };
  gisScript.onerror = () => _onApiLoadError('GIS');
  document.head.appendChild(gisScript);

  // 30秒以内にGoogle APIが準備できなければタイムアウトエラーを表示
  setTimeout(() => {
    if (!gapiReady || !gisReady) {
      _onApiLoadError('タイムアウト');
    }
  }, 30000);
});
