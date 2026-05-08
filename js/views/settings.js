/**
 * 設定ビュー
 * ライセンスキー・スプレッドシートURL・初回セットアップを管理する
 */
const SettingsView = (() => {

  function render() {
    const ssId  = localStorage.getItem('keihi_sheet_id')  || '';
    const licKey = localStorage.getItem('keihi_license_key') || '';
    const email = Auth.getUserEmail();

    return `
<div class="pt-3">
  <h5 class="fw-bold mb-3"><i class="bi bi-gear-fill me-2 text-primary"></i>設定</h5>

  <!-- アカウント情報 -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">アカウント</div>
      <div class="d-flex align-items-center gap-2">
        <i class="bi bi-person-circle text-secondary" style="font-size:1.5rem;"></i>
        <div>
          <div class="fw-semibold small">${_escape(email)}</div>
          <div class="text-muted" style="font-size:0.75rem;">Googleアカウントでログイン中</div>
        </div>
        <button class="btn btn-outline-danger btn-sm ms-auto" id="btnLogoutSettings">
          <i class="bi bi-box-arrow-right me-1"></i>ログアウト
        </button>
      </div>
    </div>
  </div>

  <!-- ライセンス -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">ライセンス</div>
      <div id="licenseStatus" class="mb-2"></div>
      <label class="form-label small fw-semibold">ライセンスキー</label>
      <div class="input-group">
        <input type="password" class="form-control form-control-sm" id="inputLicenseKey"
          placeholder="KL-XXXXXXXXXXXXXXXXXXXX" value="${_escape(licKey)}">
        <button class="btn btn-outline-primary btn-sm" id="btnVerifyLicense">確認</button>
      </div>
      <div id="licenseMsg" class="form-text"></div>
    </div>
  </div>

  <!-- スプレッドシート設定 -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">スプレッドシート</div>
      <label class="form-label small fw-semibold">スプレッドシートURL または ID</label>
      <div class="input-group mb-2">
        <input type="text" class="form-control form-control-sm" id="inputSheetUrl"
          placeholder="https://docs.google.com/spreadsheets/d/..." value="${_escape(ssId ? `https://docs.google.com/spreadsheets/d/${ssId}` : '')}">
        <button class="btn btn-outline-primary btn-sm" id="btnSaveSheetUrl">保存</button>
      </div>
      <div id="sheetMsg" class="form-text"></div>
      ${ssId ? `<a href="https://docs.google.com/spreadsheets/d/${ssId}" target="_blank" class="btn btn-outline-secondary btn-sm mt-1 w-100">
        <i class="bi bi-table me-1"></i>スプレッドシートを開く</a>` : ''}

      <hr class="my-3">

      <div class="settings-section-title">初回セットアップ</div>
      <p class="text-muted small mb-2">スプレッドシートがまだない場合は自動作成できます。</p>
      <input type="text" class="form-control form-control-sm mb-2" id="inputCompanyName"
        placeholder="会社名・チーム名">
      <button class="btn btn-primary btn-sm w-100" id="btnCreateSheet">
        <i class="bi bi-plus-circle me-1"></i>スプレッドシートを新規作成
      </button>
      <div id="createSheetMsg" class="form-text mt-2"></div>
    </div>
  </div>

  <!-- バージョン情報 -->
  <div class="text-center text-muted mt-4 mb-2" style="font-size:0.7rem;">
    経費ログ v2.0.0 — <span class="badge-denchou">電帳法対応</span>
  </div>
</div>`;
  }

  function bindEvents(el) {
    el.querySelector('#btnLogoutSettings')?.addEventListener('click', () => Auth.signOut());

    // ライセンス確認
    el.querySelector('#btnVerifyLicense')?.addEventListener('click', async () => {
      const key = el.querySelector('#inputLicenseKey').value.trim();
      if (!key) return;
      const btn = el.querySelector('#btnVerifyLicense');
      btn.disabled = true;
      btn.textContent = '確認中...';
      License.clearCache();
      const result = await License.verify(key);
      btn.disabled = false;
      btn.textContent = '確認';
      const msg = el.querySelector('#licenseMsg');
      if (result.valid) {
        localStorage.setItem('keihi_license_key', key);
        msg.innerHTML = `<span class="text-success"><i class="bi bi-check-circle me-1"></i>有効（${result.company || ''}）${result.expiresAt ? ' 期限: ' + result.expiresAt.split('T')[0] : ''}</span>`;
        App.showToast('ライセンスを確認しました', 'success');
        _syncSettingsToDrive();
      } else {
        msg.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>無効なライセンスキーです（${result.reason || ''}）</span>`;
      }
      _updateLicenseStatus(el, result);
    });

    // シートURL保存
    el.querySelector('#btnSaveSheetUrl')?.addEventListener('click', () => {
      const raw = el.querySelector('#inputSheetUrl').value.trim();
      const id  = _extractSheetId(raw);
      const msg = el.querySelector('#sheetMsg');
      if (!id) {
        msg.innerHTML = '<span class="text-danger">URLまたはIDを正しく入力してください</span>';
        return;
      }
      localStorage.setItem('keihi_sheet_id', id);
      msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
      App.showToast('スプレッドシートIDを保存しました', 'success');
      _syncSettingsToDrive();
    });

    // スプレッドシート新規作成
    el.querySelector('#btnCreateSheet')?.addEventListener('click', async () => {
      const name = el.querySelector('#inputCompanyName').value.trim();
      const msg  = el.querySelector('#createSheetMsg');
      const btn  = el.querySelector('#btnCreateSheet');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>作成中...';
      msg.textContent = '';
      try {
        const ssId = await Setup.createSpreadsheet(name);
        const url  = `https://docs.google.com/spreadsheets/d/${ssId}`;
        msg.innerHTML = `
          <span class="text-success"><i class="bi bi-check-circle me-1"></i>作成完了！</span><br>
          <a href="${url}" target="_blank" class="small">${url}</a><br>
          <span class="text-muted small">↑ このURLをメンバーに共有してください（Googleドライブで共有設定をお忘れなく）</span>
        `;
        App.showToast('スプレッドシートを作成しました', 'success');
        // URLフィールドを更新
        el.querySelector('#inputSheetUrl').value = url;
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-plus-circle me-1"></i>スプレッドシートを新規作成';
      }
    });

    // 現在のライセンス状態を表示
    const cached = _getCachedLicenseResult();
    _updateLicenseStatus(el, cached);
  }

  function _updateLicenseStatus(el, result) {
    const div = el.querySelector('#licenseStatus');
    if (!div) return;
    if (!result) {
      div.innerHTML = '<span class="text-muted small">ライセンス未確認</span>';
    } else if (result.valid) {
      div.innerHTML = `<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>ライセンス有効</span>
        ${result.expiresAt ? `<span class="text-muted small ms-2">期限: ${result.expiresAt.split('T')[0]}</span>` : ''}`;
    } else {
      div.innerHTML = '<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>ライセンス無効</span>';
    }
  }

  function _getCachedLicenseResult() {
    try {
      const c = JSON.parse(localStorage.getItem('keihi_license_cache') || 'null');
      return c?.result || null;
    } catch (_) { return null; }
  }

  function _extractSheetId(urlOrId) {
    if (!urlOrId) return '';
    const m = urlOrId.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId)) return urlOrId;
    return '';
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function _syncSettingsToDrive() {
    const settings = {
      licenseKey: localStorage.getItem('keihi_license_key') || '',
      sheetId:    localStorage.getItem('keihi_sheet_id')    || '',
      folderId:   localStorage.getItem('keihi_folder_id')   || '',
    };
    Drive.saveSettings(settings).catch(() => {});
  }

  return { render, bindEvents };
})();
