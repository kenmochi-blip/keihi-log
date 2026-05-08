/**
 * Google Identity Services (GIS) 認証モジュール
 * アクセストークンはメモリのみ保持（sessionStorageも使わない）
 */
const Auth = (() => {
  // GCPコンソールで発行したOAuthクライアントID
  const CLIENT_ID = window.APP_CONFIG?.clientId || '';

  const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
    'profile',
    'email'
  ].join(' ');

  let _tokenClient = null;
  let _accessToken  = null;
  let _userInfo     = null;
  let _tokenExpiry  = 0;

  // コールバックキューを使ってトークン取得を直列化
  let _pendingResolves = [];

  function init() {
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
    _tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000; // 60秒余裕を持たせる
    gapi.client.setToken({ access_token: _accessToken });

    // ユーザー情報を取得
    _fetchUserInfo().then(() => {
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
   * なければGoogleのポップアップを表示してユーザーに許可を求める。
   */
  function getToken() {
    return new Promise((resolve, reject) => {
      if (_accessToken && Date.now() < _tokenExpiry) {
        resolve(_userInfo);
        return;
      }
      _pendingResolves.push({ resolve, reject });
      if (_pendingResolves.length === 1) {
        // 初回リクエストのみポップアップを開く
        _tokenClient.requestAccessToken({ prompt: '' });
      }
    });
  }

  function getAccessToken() { return _accessToken; }
  function getUserInfo()    { return _userInfo;    }
  function getUserEmail()   { return _userInfo?.email || ''; }

  function signOut() {
    if (_accessToken) {
      google.accounts.oauth2.revoke(_accessToken);
    }
    _accessToken = null;
    _userInfo    = null;
    _tokenExpiry = 0;
    gapi.client.setToken(null);
    // ログイン画面に戻る
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
