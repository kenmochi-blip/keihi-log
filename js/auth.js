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
        _tokenClient.requestAccessToken({ prompt: _accessToken ? '' : 'consent' });
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
  // 環境変数はconfig.jsで設定
  if (!window.APP_CONFIG?.clientId) {
    document.getElementById('loginError').textContent =
      'CLIENT_IDが設定されていません。config.jsを確認してください。';
    document.getElementById('loginError').classList.remove('d-none');
    return;
  }

  Auth.init();

  // Google One-Tap / Sign In With Google ボタン
  google.accounts.id.initialize({
    client_id: window.APP_CONFIG.clientId,
    callback: _onCredentialResponse,
    auto_select: true,
  });

  google.accounts.id.renderButton(
    document.getElementById('googleSignInBtn'),
    { theme: 'outline', size: 'large', locale: 'ja', width: 280 }
  );

  // GSIボタンが描画されなかった場合（ドメイン未登録等）はフォールバックボタンを表示
  setTimeout(() => {
    const btn = document.getElementById('googleSignInBtn');
    if (!btn || !btn.querySelector('iframe, div[role]')) {
      document.getElementById('fallbackSignInBtn')?.classList.remove('d-none');
    }
  }, 1500);

  document.getElementById('fallbackSignInBtn')?.addEventListener('click', () => {
    Auth.getToken().then(() => {
      window.location.href = 'app.html';
    }).catch(err => {
      document.getElementById('loginError').textContent = 'ログインに失敗しました: ' + err.message;
      document.getElementById('loginError').classList.remove('d-none');
    });
  });

  google.accounts.id.prompt();
}

function _onCredentialResponse(response) {
  document.getElementById('loadingArea').classList.remove('d-none');
  document.getElementById('loginArea').classList.add('d-none');

  // JWT decode (検証はサーバーサイドでやるが、ここでは画面遷移のため簡易デコード)
  const payload = JSON.parse(atob(response.credential.split('.')[1]));
  const email = payload.email;

  // トークンを取得してアプリ画面へ
  Auth.getToken().then(() => {
    window.location.href = 'app.html';
  }).catch(err => {
    document.getElementById('loadingArea').classList.add('d-none');
    document.getElementById('loginArea').classList.remove('d-none');
    document.getElementById('loginError').textContent = 'ログインに失敗しました: ' + err.message;
    document.getElementById('loginError').classList.remove('d-none');
  });
}
