/**
 * Google Picker モジュール
 * drive.file スコープ環境でユーザーにスプレッドシートを選ばせる
 * 一度選んだファイルIDは localStorage に記録し、次回以降はスキップする
 */
const Picker = (() => {
  const AUTHED_KEY = 'keihi_picker_authed';

  // モジュールレベルでPickerロード状態をキャッシュ（重複ロード防止・同期判定用）
  let _pickerLoaded = false;
  let _loadPromise = null;

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
    if (_pickerLoaded) return Promise.resolve();
    if (_loadPromise) return _loadPromise;
    _loadPromise = new Promise((resolve, reject) => {
      function doLoad() {
        gapi.load('picker', {
          callback: () => { _pickerLoaded = true; resolve(); },
          onerror: reject,
        });
      }
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
    return _loadPromise;
  }

  /**
   * Pickerを同期的に開く（_pickerLoaded が true のときのみ呼ぶこと）
   * Promise executorは同期実行されるため、picker.setVisible(true) が
   * クリックハンドラのコールスタック内で呼ばれ、モバイルのジェスチャーが維持される
   */
  function _openPicker(expectedSheetId) {
    return new Promise((resolve, reject) => {
      const apiKey = window.APP_CONFIG?.pickerApiKey;
      if (!apiKey) { reject(new Error('no_api_key')); return; }
      const token = (typeof Auth !== 'undefined') ? Auth.getAccessToken() : null;
      if (!token) { reject(new Error('no_token')); return; }

      const myView = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(false).setSelectFolderEnabled(false);
      const sharedView = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
        .setIncludeFolders(false).setSelectFolderEnabled(false).setOwnedByMe(false);

      const companyName = localStorage.getItem('keihi_company_name') || '';
      const sheetTitle  = companyName ? `経費ログ - ${companyName}` : '経費ログ';
      let builder = new google.picker.PickerBuilder()
        .setTitle('チームのスプレッドシートを選択')
        .addView(myView)
        .addView(sharedView)
        .setOAuthToken(token)
        .setDeveloperKey(apiKey)
        .setQuery(sheetTitle);
      const picker = builder
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
      picker.setVisible(true); // クリックと同一コールスタック内で実行
    });
  }

  /**
   * Picker オーバーレイを表示してユーザーにファイルを選ばせる
   * pickerApiKey が未設定の場合は何もしない（開発環境用フォールバック）
   */
  async function requestAuthorization(expectedSheetId) {
    if (!window.APP_CONFIG?.pickerApiKey) return;

    // オーバーレイ表示と並行してPickerライブラリをプリロード開始
    // → ユーザーがボタンを押す頃にはロード完了しており、クリック時に非同期処理が入らない
    _loadGapiPicker().catch(() => {});

    const companyName = localStorage.getItem('keihi_company_name') || '';
    const sheetName   = companyName ? `経費ログ - ${companyName}` : null;
    const fileHint    = sheetName
      ? `「<strong>${sheetName}</strong>」を選んでください。`
      : '経費ログのスプレッドシートを選んでください（ファイル名は「経費ログ - 会社名」の形式です）。';
    const overlay = document.createElement('div');
    overlay.id = 'picker-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:28px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.25);">
        <i class="bi bi-folder2-open" style="font-size:2.2rem;color:#0d6efd;"></i>
        <h5 class="mt-3 mb-1" style="font-size:1rem;font-weight:700;">スプレッドシートへのアクセス許可</h5>
        <p class="text-muted mb-3" style="font-size:0.85rem;line-height:1.6;">
          初回のみ必要な操作です。<br>${fileHint}
        </p>
        <div id="picker-error" class="text-danger mb-2" style="display:none;font-size:0.82rem;"></div>
        <button id="picker-btn" class="btn btn-primary w-100 mb-2" disabled>
          <span class="spinner-border spinner-border-sm me-2" id="picker-load-spinner" role="status"></span>読み込み中...
        </button>
        <div class="text-muted" style="font-size:0.75rem;">ボタンを押すと候補ファイルが表示されます（初回のみ）</div>
      </div>`;
    document.body.appendChild(overlay);

    const card  = overlay.querySelector('div');
    const btn   = overlay.querySelector('#picker-btn');
    const errEl = overlay.querySelector('#picker-error');

    // ライブラリロード完了でボタンを有効化
    _loadGapiPicker()
      .then(() => {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-google me-2"></i>Googleドライブから選択';
      })
      .catch(() => {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-google me-2"></i>Googleドライブから選択';
        errEl.textContent = 'ライブラリの読み込みに失敗しました。ページを再読み込みしてから再試行してください。';
        errEl.style.display = '';
      });

    return new Promise((resolve, reject) => {
      // クリックハンドラを非同期にしない: picker.setVisible(true) がジェスチャーと同一スタックで呼ばれるよう保証
      btn.addEventListener('click', () => {
        if (!_pickerLoaded) return;
        errEl.style.display = 'none';
        // カードを隠してPickerが全面に出るようにする
        card.style.display = 'none';
        overlay.style.background = 'transparent';
        overlay.style.zIndex = '100';
        _openPicker(expectedSheetId)
          .then(fileId => {
            overlay.remove();
            resolve(fileId);
          })
          .catch(err => {
            // カードを再表示
            card.style.display = '';
            overlay.style.background = 'rgba(0,0,0,0.6)';
            overlay.style.zIndex = '9999';
            if (err.message === 'wrong_file') {
              errEl.textContent = '別のファイルが選択されました。もう一度ボタンを押して、チームのスプレッドシートを選び直してください。';
              errEl.style.display = '';
            } else if (err.message === 'cancelled') {
              // キャンセルは再試行を促すだけ
            } else {
              overlay.remove();
              reject(err);
            }
          });
      });
    });
  }

  return { markAuthorized, isAuthorized, requestAuthorization };
})();
