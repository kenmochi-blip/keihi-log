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
      _isAdmin = true;
      _userRole = 'admin';
      _setupUI('submit');
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
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const colorMap = { success: 'bg-success', danger: 'bg-danger', warning: 'bg-warning text-dark', info: 'bg-info' };
    const div = document.createElement('div');
    div.className = `toast-item alert ${colorMap[type] || 'bg-info'} text-white shadow py-2 px-3`;
    div.style.cssText = 'animation: fadeIn 0.2s ease;';
    div.textContent = message;
    container.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; div.style.transition = 'opacity 0.3s'; setTimeout(() => div.remove(), 300); }, 3000);
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
    App.init();
    return;
  }

  // 通常モード：gapi・GIS を動的ロードしてから初期化
  let gapiReady = false, gisReady = false;

  function _onBothReady() {
    gapi.load('client', async () => {
      await gapi.client.init({
        discoveryDocs: [
          'https://sheets.googleapis.com/$discovery/rest?version=v4',
          'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'
        ]
      });
      Auth.init();
      App.init();
    });
  }

  const gapiScript = document.createElement('script');
  gapiScript.src = 'https://apis.google.com/js/api.js';
  gapiScript.onload = () => { gapiReady = true; if (gisReady) _onBothReady(); };
  document.head.appendChild(gapiScript);

  const gisScript = document.createElement('script');
  gisScript.src = 'https://accounts.google.com/gsi/client';
  gisScript.onload = () => { gisReady = true; if (gapiReady) _onBothReady(); };
  document.head.appendChild(gisScript);
});
