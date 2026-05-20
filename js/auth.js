/**
 * 認証モジュール - PKCE Authorization Code Flow
 * - 初回ログイン：Google OAuth リダイレクト → /api/token でコード交換
 * - 2回目以降：リフレッシュトークンでアクセストークンを自動更新（再ログイン不要）
 * - リフレッシュトークンは localStorage に保存（数ヶ月有効）
 */
const Auth = (() => {
  const CLIENT_ID = window.APP_CONFIG?.clientId || '';

  // プライベート状態
  let _accessToken = null;
  let _tokenExpiry = 0;
  let _userInfo    = null;

  const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
    'openid',
    'email',
    'profile',
  ].join(' ');

  const SESSION_KEY = 'keihi_auth_session';

  // redirect_uri は常に固定（GCPに登録した値と完全一致させるため）
  function _redirectUri() {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return `${location.origin}/login`;
    }
    return 'https://keihi-log.com/login';
  }

  function _loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; }
  }

  function _saveSession(data) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  function _setGapiToken(token) {
    try { gapi.client.setToken(token ? { access_token: token } : null); } catch (_) {}
  }

  /** メモリにトークンがなければ localStorage から復元する */
  function _restoreIfNeeded() {
    if (_accessToken) return;
    const saved = _loadSession();
    if (!saved) return;
    // access_token も refresh_token もない古いセッションはクリア
    if (!saved.access_token && !saved.refresh_token) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    if (saved.expiry > Date.now()) {
      _accessToken = saved.access_token;
      _tokenExpiry = saved.expiry;
      _userInfo    = saved.userInfo;
      _setGapiToken(_accessToken);
    }
  }

  function init() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return;
    _restoreIfNeeded();
  }

  // ── PKCE ユーティリティ ─────────────────────────────────
  async function _generateVerifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  async function _generateChallenge(verifier) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // ── ログイン開始 ────────────────────────────────────────
  /** Google OAuth ページにリダイレクト（ポップアップなし） */
  async function initiateLogin(returnUrl, forceConsent = false) {
    const verifier  = await _generateVerifier();
    const challenge = await _generateChallenge(verifier);
    const state     = btoa(encodeURIComponent(returnUrl || '/app'));

    localStorage.setItem('keihi_pkce_verifier', verifier);
    localStorage.setItem('keihi_oauth_state',   state);

    // forceConsent=true のとき consent を要求してリフレッシュトークンを確実に取得する
    const prompt = forceConsent ? 'consent' : 'select_account';

    const params = new URLSearchParams({
      client_id:             CLIENT_ID,
      redirect_uri:          _redirectUri(),
      response_type:         'code',
      scope:                 SCOPES,
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      state,
      access_type:           'offline',
      prompt,
    });
    location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  // ── コールバック処理 ────────────────────────────────────
  /** OAuth コールバック処理。戻り先URLを返す。コールバックでなければ null を返す。 */
  async function handleCallback() {
    const params = new URLSearchParams(location.search);
    const code   = params.get('code');
    const state  = params.get('state');
    const error  = params.get('error');

    if (error) throw new Error(error);
    if (!code) return null;

    const savedState = localStorage.getItem('keihi_oauth_state');
    if (state !== savedState) {
      // ページリロード・複数タブ等で state が上書きされた場合は古いデータをクリアして再試行可能にする
      localStorage.removeItem('keihi_pkce_verifier');
      localStorage.removeItem('keihi_oauth_state');
      throw new Error('state_mismatch');
    }

    const verifier = localStorage.getItem('keihi_pkce_verifier');
    if (!verifier) throw new Error('no_verifier');

    const exchCtrl = new AbortController();
    const exchTid  = setTimeout(() => exchCtrl.abort(), 15000);
    let tokens;
    try {
      const resp = await fetch('/api/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'exchange', code, code_verifier: verifier, redirect_uri: _redirectUri() }),
        signal:  exchCtrl.signal,
      });
      tokens = await resp.json();
    } finally {
      clearTimeout(exchTid);
    }
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    await _storeTokens(tokens);
    localStorage.removeItem('keihi_pkce_verifier');
    localStorage.removeItem('keihi_oauth_state');

    try { return decodeURIComponent(atob(state)); } catch (_) { return '/app'; }
  }

  // ── トークン管理 ────────────────────────────────────────
  async function _storeTokens(tokens) {
    _accessToken = tokens.access_token;
    _tokenExpiry = Date.now() + (tokens.expires_in - 60) * 1000;
    _setGapiToken(_accessToken);

    await _fetchUserInfo();
    if (_userInfo?.email) localStorage.setItem('keihi_user_email', _userInfo.email);

    const saved = _loadSession();
    _saveSession({
      access_token:  _accessToken,
      refresh_token: tokens.refresh_token || saved?.refresh_token || '',
      expiry:        _tokenExpiry,
      userInfo:      _userInfo,
    });
  }

  async function _fetchUserInfo() {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
        { headers: { Authorization: `Bearer ${_accessToken}` }, signal: ctrl.signal });
      _userInfo = await resp.json();
    } catch (_) {
      // タイムアウト・エラー時は保存済みuserInfoをそのまま維持
      if (!_userInfo) {
        const saved = _loadSession();
        _userInfo = saved?.userInfo || null;
      }
    } finally {
      clearTimeout(tid);
    }
  }

  /** リフレッシュトークンがない場合、consent付き再ログインに自動リダイレクト */
  function _forceRelogin() {
    _accessToken = null;
    _userInfo    = null;
    _tokenExpiry = 0;
    localStorage.removeItem(SESSION_KEY);
    localStorage.setItem('keihi_force_consent', '1');
    // ログインページ上での呼び出しはリダイレクトループを引き起こすため早期リターン
    if (location.pathname === '/login' || location.pathname.endsWith('/login.html')) {
      return;
    }
    const ret = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?return=${ret}`;
  }

  async function _refreshToken() {
    const saved = _loadSession();
    if (!saved?.refresh_token) {
      // リフレッシュトークンがない（初回ログイン時にGoogleが返さなかった等）
      // → consent付きで再ログインし、確実にリフレッシュトークンを取得する
      _forceRelogin();
      throw new Error('no_refresh_token');
    }

    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp   = await fetch('/api/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'refresh', refresh_token: saved.refresh_token }),
        signal:  ctrl.signal,
      });
      const tokens = await resp.json();
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);
      tokens.refresh_token = tokens.refresh_token || saved.refresh_token;
      await _storeTokens(tokens);
    } finally {
      clearTimeout(tid);
    }
  }

  /**
   * 有効なアクセストークンを返す（async）。
   * 期限切れなら自動リフレッシュ。リフレッシュも失敗なら reject → App.init が login.html へ飛ばす。
   */
  function getToken() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      const email = Demo.getUserEmail();
      const member = Demo.MASTER.members.find(m => m.email === email);
      return Promise.resolve({ email, name: member?.name || 'デモ ユーザー', picture: '' });
    }
    _restoreIfNeeded();
    if (_accessToken && Date.now() < _tokenExpiry) return Promise.resolve(_userInfo);
    return _refreshToken().then(() => _userInfo);
  }

  function getAccessToken() { return _accessToken; }

  function getUserInfo() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      const email = Demo.getUserEmail();
      const member = Demo.MASTER.members.find(m => m.email === email);
      return { email, name: member?.name || 'デモ ユーザー', picture: '' };
    }
    return _userInfo;
  }

  function getUserEmail() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return Demo.getUserEmail();
    return _userInfo?.email || '';
  }

  function signOut() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      Demo.disable();
      localStorage.removeItem(SESSION_KEY);
      window.location.href = 'login.html';
      return;
    }
    const saved = _loadSession();
    if (saved?.refresh_token) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${saved.refresh_token}`, { method: 'POST' }).catch(() => {});
    }
    if (_accessToken) {
      fetch(`https://oauth2.googleapis.com/revoke?token=${_accessToken}`, { method: 'POST' }).catch(() => {});
    }
    _accessToken = null;
    _userInfo    = null;
    _tokenExpiry = 0;
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('keihi_user_email');
    _setGapiToken(null);
    window.location.href = 'login.html';
  }

  async function authFetch(url, options = {}) {
    await getToken();
    // 呼び出し元が signal を指定していない場合は 20 秒タイムアウトを付与
    if (!options.signal) {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 20000);
      try {
        return await fetch(url, {
          ...options,
          headers: { ...(options.headers || {}), Authorization: `Bearer ${_accessToken}` },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(tid);
      }
    }
    return fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${_accessToken}` },
    });
  }

  return { init, getToken, getAccessToken, getUserInfo, getUserEmail, signOut, authFetch, initiateLogin, handleCallback };
})();

// ── ログイン画面初期化 ──────────────────────────────────────
async function initLogin() {
  if (!window.APP_CONFIG?.clientId) {
    document.getElementById('loginError').textContent = 'CLIENT_IDが設定されていません。config.jsを確認してください。';
    document.getElementById('loginError').classList.remove('d-none');
    return;
  }

  const _returnUrl = (() => {
    const ret = new URLSearchParams(location.search).get('return');
    if (ret && /^\/[a-zA-Z0-9_\-/.]*$/.test(ret)) return ret;
    return '/app';
  })();

  const forceConsent = localStorage.getItem('keihi_force_consent') === '1';

  const _showLoginBtn = (errMsg, overrideReturnUrl) => {
    document.getElementById('loadingArea').classList.add('d-none');
    document.getElementById('loginArea').classList.remove('d-none');
    if (errMsg) {
      document.getElementById('loginError').textContent = errMsg;
      document.getElementById('loginError').classList.remove('d-none');
    }
    const dest = overrideReturnUrl || _returnUrl;
    document.getElementById('signInBtn').onclick = () => {
      document.getElementById('loginError').classList.add('d-none');
      Auth.initiateLogin(dest, forceConsent);
    };
  };

  // OAuthコールバック処理（?code= が URL にある場合）
  if (location.search.includes('code=')) {
    document.getElementById('loginArea').classList.add('d-none');
    document.getElementById('loadingArea').classList.remove('d-none');
    try {
      const returnUrl = await Auth.handleCallback();
      if (returnUrl) { window.location.replace(returnUrl); return; }
    } catch (err) {
      // state_mismatch 時でも state から元のリターン先を回収して再試行に引き継ぐ
      // （state の信頼性は失われているが、ナビゲーション先として使うだけなので安全）
      let recoveredReturnUrl = null;
      if (err.message === 'state_mismatch') {
        const rawState = new URLSearchParams(location.search).get('state');
        if (rawState) {
          try { recoveredReturnUrl = decodeURIComponent(atob(rawState)); } catch (_) {}
        }
      }
      const msg = err.message === 'state_mismatch'
        ? 'ページの再読み込みや複数タブが原因でログインに失敗しました。もう一度「Googleでログイン」を押してください。'
        : err.message === 'access_denied'
        ? 'Googleアカウントへのアクセスが拒否されました。もう一度お試しください。'
        : 'ログインに失敗しました: ' + err.message;
      _showLoginBtn(msg, recoveredReturnUrl);
      return;
    }
  }

  // 有効なトークンがあれば即リダイレクト
  Auth.init();
  if (Auth.getAccessToken()) {
    window.location.replace(_returnUrl);
    return;
  }

  // リフレッシュトークンでサイレント更新を試みる
  try {
    await Auth.getToken();
    window.location.replace(_returnUrl);
    return;
  } catch (_) {}

  // ログインボタンを表示
  // keihi_force_consent が立っている場合は consent でリフレッシュトークンを強制取得
  if (forceConsent) {
    localStorage.removeItem('keihi_force_consent');
    _showLoginBtn('セッションの有効期限が切れました。もう一度ログインしてください。');
  } else {
    _showLoginBtn(null);
  }
}
