/**
 * Google Identity Services (GIS) 認証モジュール
 * アクセストークンはメモリ + sessionStorage で保持（タブを閉じると消える）
 */
const Auth = (() => {
  // GCPコンソールで発行したOAuthクライアントID
  const CLIENT_ID = window.APP_CONFIG?.clientId || '';

  const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.appdata',
    'https://www.googleapis.com/auth/userinfo.email',
    'profile',
    'email'
  ].join(' ');

  const SESSION_KEY = 'keihi_auth_session';

  let _tokenClient = null;
  let _accessToken  = null;
  let _userInfo     = null;
  let _tokenExpiry  = 0;

  // コールバックキューを使ってトークン取得を直列化
  let _pendingResolves = [];

  function init() {
    // デモモード：トークン不要
    if (typeof Demo !== 'undefined' && Demo.isActive()) return;
    // sessionStorage からトークンを復元（ページ遷移後もポップアップ不要）
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (saved && saved.expiry > Date.now()) {
        _accessToken = saved.access_token;
        _tokenExpiry = saved.expiry;
        _userInfo    = saved.userInfo;
        gapi.client.setToken({ access_token: _accessToken });
      }
    } catch (_) {}

    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: _handleTokenResponse,
    });
  }

  function _handleTokenResponse(resp) {
    if (resp.error) {
      _pendingResolves.forEach(({ reject }) => reject(new Error(resp.error)));
      _pendingResolves = [];
      return;
    }
    _accessToken = resp.access_token;
    _tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
    gapi.client.setToken({ access_token: _accessToken });

    // ユーザー情報を取得してから sessionStorage に保存
    _fetchUserInfo().then(() => {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        access_token: _accessToken,
        expiry: _tokenExpiry,
        userInfo: _userInfo,
      }));
      _pendingResolves.forEach(({ resolve }) => resolve(_userInfo));
      _pendingResolves = [];
    });
  }

  async function _fetchUserInfo() {
    try {
      const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${_accessToken}` }
      });
      _userInfo = await resp.json();
    } catch (e) {
      _userInfo = null;
    }
  }

  /**
   * トークンを取得する。有効なトークンがあればそれを返す。
   * sessionStorage に復元済みの場合はポップアップなしで即返す。
   * 期限切れの場合は GIS のサイレントリフレッシュを試みる。
   */
  function _demoUserInfo() {
    const email = Demo.getUserEmail();
    const member = Demo.MASTER.members.find(m => m.email === email);
    return { email, name: member?.name || 'デモ ユーザー', picture: '' };
  }

  function getToken() {
    return new Promise((resolve, reject) => {
      if (typeof Demo !== 'undefined' && Demo.isActive()) {
        resolve(_demoUserInfo());
        return;
      }
      if (_accessToken && Date.now() < _tokenExpiry) {
        resolve(_userInfo);
        return;
      }
      _pendingResolves.push({ resolve, reject });
      if (_pendingResolves.length === 1) {
        // prompt:'' = 既に同意済みならポップアップなしでサイレント取得
        _tokenClient.requestAccessToken({ prompt: '' });
      }
    });
  }

  function getAccessToken() { return _accessToken; }
  function getUserInfo()    {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return _demoUserInfo();
    return _userInfo;
  }
  function getUserEmail()   {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return Demo.getUserEmail();
    return _userInfo?.email || '';
  }

  function signOut() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      Demo.disable();
      sessionStorage.removeItem(SESSION_KEY);
      window.location.href = 'index.html';
      return;
    }
    if (_accessToken) {
      google.accounts.oauth2.revoke(_accessToken);
    }
    _accessToken = null;
    _userInfo    = null;
    _tokenExpiry = 0;
    sessionStorage.removeItem(SESSION_KEY);
    gapi.client.setToken(null);
    window.location.href = 'index.html';
  }

  /** Bearer ヘッダー付きのfetch */
  async function authFetch(url, options = {}) {
    await getToken();
    return fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${_accessToken}`,
      }
    });
  }

  return { init, getToken, getAccessToken, getUserInfo, getUserEmail, signOut, authFetch };
})();

/**
 * ログイン画面の初期化（index.html から呼ばれる）
 */
function initLogin() {
  if (!window.APP_CONFIG?.clientId) {
    document.getElementById('loginError').textContent =
      'CLIENT_IDが設定されていません。config.jsを確認してください。';
    document.getElementById('loginError').classList.remove('d-none');
    return;
  }

  Auth.init();

  // ボタンクリックから直接OAuthポップアップを開く（ブラウザのポップアップブロック回避）
  document.getElementById('signInBtn').addEventListener('click', () => {
    document.getElementById('loginError').classList.add('d-none');
    Auth.getToken().then(() => {
      window.location.href = 'app.html';
    }).catch(err => {
      document.getElementById('loginError').textContent = 'ログインに失敗しました: ' + err.message;
      document.getElementById('loginError').classList.remove('d-none');
    });
  });
}
