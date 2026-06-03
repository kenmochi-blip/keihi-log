/**
 * Google Picker モジュール
 * drive.file スコープ環境でユーザーにスプレッドシートを選ばせる
 * 一度選んだファイルIDは localStorage に記録し、次回以降はスキップする
 */
const Picker = (() => {
  const AUTHED_KEY = 'keihi_picker_authed';

  function _getAuthed() {
    try { return JSON.parse(localStorage.getItem(AUTHED_KEY) || '[]'); }
    catch (_) { return []; }
  }

  /** セットアップ時にアプリが作成したシート、またはPicker選択済みのシートとして記録 */
  function markAuthorized(sheetId) {
    if (!sheetId) return;
    const arr = _getAuthed();
    if (!arr.includes(sheetId)) {
      arr.push(sheetId);
      try { localStorage.setItem(AUTHED_KEY, JSON.stringify(arr)); } catch (_) {}
    }
  }

  function isAuthorized(sheetId) {
    if (!sheetId) return false;
    return _getAuthed().includes(sheetId);
  }

  function _loadGapiPicker() {
    return new Promise((resolve, reject) => {
      function doLoad() { gapi.load('picker', { callback: resolve, onerror: reject }); }
      if (typeof gapi !== 'undefined') {
        doLoad();
      } else {
        const s = document.createElement('script');
        s.src = 'https://apis.google.com/js/api.js';
        s.onload = doLoad;
        s.onerror = () => reject(new Error('gapi_load_failed'));
        document.head.appendChild(s);
      }
    });
  }

  function _openPicker(expectedSheetId) {
    return new Promise(async (resolve, reject) => {
      const apiKey = window.APP_CONFIG?.pickerApiKey;
      if (!apiKey) { reject(new Error('no_api_key')); return; }
      const token = (typeof Auth !== 'undefined') ? Auth.getAccessToken() : null;
      if (!token) { reject(new Error('no_token')); return; }

      try { await _loadGapiPicker(); }
      catch (_) { reject(new Error('picker_load_failed')); return; }

      const myView = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(false).setSelectFolderEnabled(false);
      const sharedView = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(false).setSelectFolderEnabled(false).setOwnedByMe(false);

      const picker = new google.picker.PickerBuilder()
        .setTitle('チームのスプレッドシートを選択')
        .addView(myView)
        .addView(sharedView)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setCallback(data => {
          if (data.action === google.picker.Action.PICKED) {
            const fileId = data.docs[0]?.id;
            if (expectedSheetId && fileId !== expectedSheetId) {
              reject(new Error('wrong_file')); return;
            }
            markAuthorized(fileId);
            resolve(fileId);
          } else if (data.action === google.picker.Action.CANCEL) {
            reject(new Error('cancelled'));
          }
        })
        .build();
      picker.setVisible(true);
    });
  }

  /**
   * Picker オーバーレイを表示してユーザーにファイルを選ばせる
   * pickerApiKey が未設定の場合は何もしない（開発環境用フォールバック）
   */
  async function requestAuthorization(expectedSheetId) {
    if (!window.APP_CONFIG?.pickerApiKey) return;

    const overlay = document.createElement('div');
    overlay.id = 'picker-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.25);">
        <i class="bi bi-folder2-open" style="font-size:2.2rem;color:#0d6efd;"></i>
        <h5 class="mt-3 mb-1" style="font-size:1rem;font-weight:700;">スプレッドシートへのアクセス許可</h5>
        <p class="text-muted mb-3" style="font-size:0.85rem;line-height:1.6;">
          初回のみ必要な操作です。<br>
          Googleドライブからチームのスプレッドシートを選択してください。
        </p>
        <div id="picker-error" class="text-danger mb-2" style="display:none;font-size:0.82rem;"></div>
        <button id="picker-btn" class="btn btn-primary w-100 mb-2">
          <i class="bi bi-google me-2"></i>Googleドライブから選択
        </button>
        <div class="text-muted" style="font-size:0.75rem;">管理者から共有されたスプレッドシートを選んでください</div>
      </div>`;
    document.body.appendChild(overlay);

    return new Promise((resolve, reject) => {
      const btn   = overlay.querySelector('#picker-btn');
      const errEl = overlay.querySelector('#picker-error');

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>選択中...';
        errEl.style.display = 'none';
        try {
          const fileId = await _openPicker(expectedSheetId);
          overlay.remove();
          resolve(fileId);
        } catch (err) {
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-google me-2"></i>Googleドライブから選択';
          if (err.message === 'wrong_file') {
            errEl.textContent = '選択されたファイルが正しくありません。チームのスプレッドシートを選んでください。';
            errEl.style.display = '';
          } else if (err.message === 'cancelled') {
            // キャンセルは再試行を促すだけ
          } else {
            overlay.remove();
            reject(err);
          }
        }
      });
    });
  }

  return { markAuthorized, isAuthorized, requestAuthorization };
})();
