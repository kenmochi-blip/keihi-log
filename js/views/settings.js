/**
 * 設定・管理ビュー（統合版）
 * 全ユーザー：ライセンス・スプレッドシート設定
 * 管理者のみ：メンバー管理・勘定科目・支払元・Gemini APIキー
 */
const SettingsView = (() => {

  let _master = null;

  function render() {
    const ssId   = localStorage.getItem('keihi_sheet_id')    || '';
    const licKey = localStorage.getItem('keihi_license_key') || '';
    const email  = Auth.getUserEmail();
    const isAdmin = App.isAdmin();
    // シート未設定の新規ユーザーにも作成ボタンを表示（鶏と卵問題の回避）
    const showSetup = isAdmin || !ssId;

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
          <div class="text-muted" style="font-size:0.75rem;">
            Googleアカウントでログイン中
            ${isAdmin ? '<span class="badge bg-primary ms-1" style="font-size:0.65rem;">管理者</span>' : ''}
          </div>
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
      <div class="input-group mb-2">
        <input type="text" class="form-control form-control-sm" id="inputSheetUrl"
          placeholder="https://docs.google.com/spreadsheets/d/..." value="${_escape(ssId ? `https://docs.google.com/spreadsheets/d/${ssId}` : '')}">
        <button class="btn btn-outline-primary btn-sm" id="btnSaveSheetUrl">保存</button>
      </div>
      <div id="sheetMsg" class="form-text"></div>
      ${ssId ? `<a href="https://docs.google.com/spreadsheets/d/${ssId}" target="_blank" class="btn btn-outline-secondary btn-sm mt-1 w-100">
        <i class="bi bi-table me-1"></i>スプレッドシートを開く</a>` : ''}
    </div>
  </div>

  ${showSetup ? _renderAdminSections(ssId, isAdmin) : ''}

  <!-- バージョン情報 -->
  <div class="text-center text-muted mt-4 mb-2" style="font-size:0.7rem;">
    経費ログ v2.0.0 — <span class="badge-denchou">電帳法対応</span>
  </div>
</div>`;
  }

  function _renderAdminSections(ssId, isAdmin) {
    return `
  <!-- 初回セットアップ -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">スプレッドシート新規作成</div>
      ${ssId ? '<div class="alert alert-warning small py-2">⚠️ 既にスプレッドシートが設定されています。新規作成すると別のシートが作られます。</div>' : ''}
      <p class="text-muted small mb-2">スプレッドシートがまだない場合は自動作成できます。</p>
      <input type="text" class="form-control form-control-sm mb-2" id="inputCompanyName" placeholder="会社名・チーム名">
      <button class="btn btn-primary btn-sm w-100" id="btnCreateSheet">
        <i class="bi bi-plus-circle me-1"></i>スプレッドシートを新規作成
      </button>
      <div id="createSheetMsg" class="form-text mt-2"></div>
    </div>
  </div>

  ${isAdmin ? `
  <!-- スプレッドシート書式修正（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">スプレッドシート書式修正</div>
      <p class="text-muted small mb-2">ヘッダー行のセンタリング・フィルター設定・データ行の書式リセットを行います。</p>
      <button class="btn btn-outline-secondary btn-sm w-100" id="btnRepairFormat">
        <i class="bi bi-magic me-1"></i>経費一覧の書式を修正する
      </button>
      <div id="repairFormatMsg" class="form-text mt-1"></div>
    </div>
  </div>

  <!-- Gemini APIキー（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">Gemini APIキー（全メンバー共用）</div>
      <p class="text-muted small mb-2">Google AI Studioで取得したAPIキーを入力してください。メンバーは個別取得不要です。</p>
      <div class="input-group">
        <input type="password" class="form-control form-control-sm" id="inputGeminiKey" placeholder="AIzaSy...">
        <button class="btn btn-outline-primary btn-sm" id="btnSaveGeminiKey">保存</button>
      </div>
      <div id="geminiKeyMsg" class="form-text"></div>
    </div>
  </div>

  <!-- メンバー管理（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title d-flex justify-content-between align-items-center">
        <span>メンバー管理</span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddMember"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <div id="memberList" class="mt-2">
        <div class="text-muted small text-center py-2">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- 勘定科目（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title d-flex justify-content-between align-items-center">
        <span>勘定科目</span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddCategory"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <div id="categoryList" class="mt-2">
        <div class="text-muted small text-center py-2">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- 会社払い支払元（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title d-flex justify-content-between align-items-center">
        <span>会社払い支払元</span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddPaySource"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <div id="paySourceList" class="mt-2">
        <div class="text-muted small text-center py-2">読み込み中...</div>
      </div>
    </div>
  </div>` : ''}`;
  }

  async function bindEvents(el) {
    el.querySelector('#btnLogoutSettings')?.addEventListener('click', () => Auth.signOut());

    // ライセンス確認
    el.querySelector('#btnVerifyLicense')?.addEventListener('click', async () => {
      const key = el.querySelector('#inputLicenseKey').value.trim();
      if (!key) return;
      const btn = el.querySelector('#btnVerifyLicense');
      btn.disabled = true; btn.textContent = '確認中...';
      License.clearCache();
      const result = await License.verify(key);
      btn.disabled = false; btn.textContent = '確認';
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
    _updateLicenseStatus(el, _getCachedLicenseResult());

    // シートURL保存
    el.querySelector('#btnSaveSheetUrl')?.addEventListener('click', async () => {
      const raw = el.querySelector('#inputSheetUrl').value.trim();
      const id  = _extractSheetId(raw);
      const msg = el.querySelector('#sheetMsg');
      if (!id) { msg.innerHTML = '<span class="text-danger">URLまたはIDを正しく入力してください</span>'; return; }
      const btn = el.querySelector('#btnSaveSheetUrl');
      btn.disabled = true; btn.textContent = '確認中...';
      try {
        // アクセス確認（読み取りテスト）
        await Sheets.read('A1', id);
      } catch (err) {
        const status = (err.message || '').match(/\d{3}/)?.[0];
        if (status === '403') {
          msg.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle me-1"></i>このスプレッドシートへのアクセス権がありません。共有設定を確認してください。</span>';
          btn.disabled = false; btn.textContent = '保存';
          return;
        } else if (status === '404') {
          msg.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle me-1"></i>スプレッドシートが見つかりません。URLを確認してください。</span>';
          btn.disabled = false; btn.textContent = '保存';
          return;
        }
        // その他のエラーは無視して保存続行
      } finally {
        btn.disabled = false; btn.textContent = '保存';
      }
      localStorage.setItem('keihi_sheet_id', id);
      msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました。ページを再読み込みして反映してください。</span>';
      App.showToast('スプレッドシートIDを保存しました', 'success');
      _syncSettingsToDrive();
    });

    // スプレッドシート新規作成（シート未設定ユーザーにも開放）
    el.querySelector('#btnCreateSheet')?.addEventListener('click', async () => {
      const existing = localStorage.getItem('keihi_sheet_id');
      if (existing) {
        const ok = await App.confirm('既にスプレッドシートが設定されています。\n新規作成すると別のシートが作られ、元のデータは残ります。\n本当に新規作成しますか？');
        if (!ok) return;
      }
      const name = el.querySelector('#inputCompanyName').value.trim();
      const msg  = el.querySelector('#createSheetMsg');
      const btn  = el.querySelector('#btnCreateSheet');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>作成中...';
      msg.textContent = '';
      try {
        const ssId = await Setup.createSpreadsheet(name);
        const url  = `https://docs.google.com/spreadsheets/d/${ssId}`;
        msg.innerHTML = `<span class="text-success"><i class="bi bi-check-circle me-1"></i>作成完了！</span><br>
          <a href="${url}" target="_blank" class="small">${url}</a><br>
          <span class="text-muted small">↑ このURLをメンバーに共有してください</span>`;
        App.showToast('スプレッドシートを作成しました', 'success');
        el.querySelector('#inputSheetUrl').value = url;
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-plus-circle me-1"></i>スプレッドシートを新規作成';
      }
    });

    if (!App.isAdmin()) return;

    // 書式修正
    el.querySelector('#btnRepairFormat')?.addEventListener('click', async () => {
      const btn = el.querySelector('#btnRepairFormat');
      const msg = el.querySelector('#repairFormatMsg');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>修正中...';
      msg.textContent = '';
      try {
        await _repairSheetFormatting();
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>書式を修正しました</span>';
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-magic me-1"></i>経費一覧の書式を修正する';
      }
    });

    // Gemini APIキー読み込みと保存
    try {
      const geminiKey = await Sheets.readSetting('B5');
      if (el.querySelector('#inputGeminiKey')) el.querySelector('#inputGeminiKey').value = geminiKey || '';
    } catch (_) {}

    el.querySelector('#btnSaveGeminiKey')?.addEventListener('click', async () => {
      const key = el.querySelector('#inputGeminiKey').value.trim();
      const msg = el.querySelector('#geminiKeyMsg');
      try {
        await Sheets.update('設定!B5', [[key]]);
        Gemini.clearApiKey();
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
        App.showToast('Gemini APIキーを保存しました', 'success');
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      }
    });

    // マスタデータ読み込み
    try {
      _master = await App.getMaster();
      _renderMembers(el);
      _renderSimpleList(el, 'categoryList', _master.categories, 'category');
      _renderSimpleList(el, 'paySourceList', _master.paySources, 'paySource');
    } catch (err) {
      App.showToast('マスタデータの読み込みに失敗しました', 'danger');
    }

    el.querySelector('#btnAddMember')?.addEventListener('click', () => _showMemberForm(el, null));
    el.querySelector('#btnAddCategory')?.addEventListener('click', () => _showInlineAdd(el, 'category'));
    el.querySelector('#btnAddPaySource')?.addEventListener('click', () => _showInlineAdd(el, 'paySource'));
  }

  function _renderMembers(el) {
    const container = el.querySelector('#memberList');
    if (!container) return;
    if (!_master?.members?.length) {
      container.innerHTML = '<div class="text-muted small">メンバーが登録されていません</div>';
      return;
    }
    container.innerHTML = _master.members.map((m, i) => `
      <div class="d-flex align-items-center gap-2 py-2 border-bottom">
        <div class="flex-grow-1">
          <div class="fw-semibold small">${_escape(m.name)}</div>
          <div class="text-muted" style="font-size:0.72rem;">${_escape(m.email)}${m.dept ? ' / ' + _escape(m.dept) : ''}
            ${m.role === 'admin' ? '<span class="badge bg-primary ms-1" style="font-size:0.6rem;">管理者</span>' : ''}
          </div>
        </div>
        <button class="btn btn-outline-secondary btn-sm btn-edit-member" data-index="${i}"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-outline-danger btn-sm btn-del-member" data-index="${i}"><i class="bi bi-trash"></i></button>
      </div>`).join('');
    container.querySelectorAll('.btn-edit-member').forEach(btn =>
      btn.addEventListener('click', () => _showMemberForm(el, Number(btn.dataset.index))));
    container.querySelectorAll('.btn-del-member').forEach(btn =>
      btn.addEventListener('click', () => _deleteMember(el, Number(btn.dataset.index))));
  }

  function _renderSimpleList(el, containerId, items, type) {
    const container = el.querySelector(`#${containerId}`);
    if (!container) return;
    if (!items?.length) { container.innerHTML = '<div class="text-muted small">登録がありません</div>'; return; }
    container.innerHTML = items.map((item, i) => `
      <div class="d-flex align-items-center gap-2 py-1 border-bottom">
        <span class="flex-grow-1 small">${_escape(item)}</span>
        <button class="btn btn-outline-danger btn-sm btn-del-item" data-type="${type}" data-index="${i}">
          <i class="bi bi-trash"></i>
        </button>
      </div>`).join('');
    container.querySelectorAll('.btn-del-item').forEach(btn =>
      btn.addEventListener('click', () => _deleteSimpleItem(el, btn.dataset.type, Number(btn.dataset.index))));
  }

  function _showMemberForm(el, idx) {
    const m = idx !== null ? _master.members[idx] : { name: '', email: '', dept: '', role: '' };
    const isNew = idx === null;
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h6 class="modal-title">${isNew ? 'メンバー追加' : 'メンバー編集'}</h6>
              <button class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2"><label class="form-label small">氏名</label>
                <input type="text" class="form-control form-control-sm" id="mName" value="${_escape(m.name)}"></div>
              <div class="mb-2"><label class="form-label small">メールアドレス</label>
                <input type="email" class="form-control form-control-sm" id="mEmail" value="${_escape(m.email)}"></div>
              <div class="mb-2"><label class="form-label small">所属</label>
                <input type="text" class="form-control form-control-sm" id="mDept" value="${_escape(m.dept)}"></div>
              <div class="mb-2"><label class="form-label small">権限</label>
                <select class="form-select form-select-sm" id="mRole">
                  <option value="" ${!m.role || m.role === 'member' ? 'selected' : ''}>一般ユーザー</option>
                  <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>管理者</option>
                </select></div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button class="btn btn-primary btn-sm" id="btnSaveMember">保存</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);
    const modal = new bootstrap.Modal(div.querySelector('.modal'));
    modal.show();
    div.querySelector('#btnSaveMember').addEventListener('click', async () => {
      const updated = {
        name:  div.querySelector('#mName').value.trim(),
        email: div.querySelector('#mEmail').value.trim(),
        dept:  div.querySelector('#mDept').value.trim(),
        role:  div.querySelector('#mRole').value,
      };
      if (!updated.name || !updated.email) return App.showToast('氏名・メールは必須です', 'danger');
      if (isNew) _master.members.push(updated);
      else       _master.members[idx] = updated;
      await _saveMasterToSheet(el);
      modal.hide();
    });
    div.querySelector('.modal').addEventListener('hidden.bs.modal', () => div.remove());
  }

  function _showInlineAdd(el, type) {
    const containerId = type === 'category' ? 'categoryList' : 'paySourceList';
    const container = el.querySelector(`#${containerId}`);
    const row = document.createElement('div');
    row.className = 'd-flex gap-1 mt-2';
    row.innerHTML = `<input type="text" class="form-control form-control-sm" placeholder="追加する項目名">
      <button class="btn btn-primary btn-sm">追加</button>
      <button class="btn btn-secondary btn-sm">✕</button>`;
    container.prepend(row);
    row.querySelector('input').focus();
    row.querySelectorAll('button')[1].addEventListener('click', () => row.remove());
    row.querySelectorAll('button')[0].addEventListener('click', async () => {
      const val = row.querySelector('input').value.trim();
      if (!val) return;
      if (type === 'category') _master.categories.push(val);
      else _master.paySources.push(val);
      await _saveMasterToSheet(el);
      row.remove();
    });
  }

  async function _deleteMember(el, idx) {
    const ok = await App.confirm(`${_master.members[idx].name} を削除しますか？`);
    if (!ok) return;
    _master.members.splice(idx, 1);
    await _saveMasterToSheet(el);
  }

  async function _deleteSimpleItem(el, type, idx) {
    if (type === 'category') _master.categories.splice(idx, 1);
    else _master.paySources.splice(idx, 1);
    await _saveMasterToSheet(el);
  }

  async function _saveMasterToSheet(el) {
    const maxRows = Math.max(_master.members.length, _master.categories.length, _master.paySources.length, 1);
    const rows = [];
    for (let i = 0; i < maxRows; i++) {
      const m = _master.members[i]    || {};
      const c = _master.categories[i] || '';
      const p = _master.paySources[i] || '';
      rows.push([m.name || '', m.email || '', m.dept || '', p, c, m.role || '', '']);
    }
    await Sheets.update(`マスタ表!A2:G${rows.length + 1}`, rows);
    App.showToast('保存しました', 'success');

    // メンバー名が登録されている場合、既存申請データの表示名を一括更新
    const syncCount = await _syncMemberNamesToExpenses(_master.members);
    if (syncCount > 0) {
      App.showToast(`${syncCount}件の申請データの表示名を更新しました`, 'info');
    }

    App.clearMasterCache();
    _master = await App.getMaster();
    _renderMembers(el);
    _renderSimpleList(el, 'categoryList', _master.categories, 'category');
    _renderSimpleList(el, 'paySourceList', _master.paySources, 'paySource');
  }

  async function _syncMemberNamesToExpenses(members) {
    const ssId = localStorage.getItem('keihi_sheet_id');
    if (!ssId || !members.length) return 0;
    try {
      const allRows = await Sheets.read('経費一覧!A2:R');
      if (!allRows.length) return 0;

      const emailToName = {};
      members.forEach(m => {
        if (m.email && m.name) emailToName[m.email.toLowerCase()] = m.name;
      });

      const updates = [];
      allRows.forEach((row, i) => {
        const email = (row[15] || '').toLowerCase(); // P列: 申請者Email
        const currentName = row[1] || '';            // B列: 申請者名
        const newName = emailToName[email];
        if (newName && newName !== currentName) {
          updates.push({ range: `経費一覧!B${i + 2}`, values: [[newName]] });
        }
      });

      if (updates.length > 0) await Sheets.batchUpdateValues(updates);
      return updates.length;
    } catch (_) {
      return 0;
    }
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
    try { return JSON.parse(localStorage.getItem('keihi_license_cache') || 'null')?.result || null; }
    catch (_) { return null; }
  }

  function _extractSheetId(urlOrId) {
    if (!urlOrId) return '';
    const m = urlOrId.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{20,}$/.test(urlOrId) ? urlOrId : '';
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function _repairSheetFormatting() {
    const ssId = localStorage.getItem('keihi_sheet_id');
    if (!ssId) throw new Error('スプレッドシートが設定されていません');

    // シートIDを取得
    const resp = await Auth.authFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=sheets.properties`
    );
    if (!resp.ok) throw new Error(`メタデータ取得エラー: ${resp.status}`);
    const meta = await resp.json();
    const sheetIdMap = {};
    meta.sheets?.forEach(s => { sheetIdMap[s.properties.title] = s.properties.sheetId; });

    const expId = sheetIdMap['経費一覧'];
    if (expId === undefined) throw new Error('経費一覧シートが見つかりません');

    await Sheets.batchUpdate([
      // ヘッダー行: 濃紺・白太字・センタリング
      {
        repeatCell: {
          range: { sheetId: expId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.27, green: 0.51, blue: 0.71 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              horizontalAlignment: 'CENTER',
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
        }
      },
      // データ行: 白背景・標準テキスト（書式引き継ぎをリセット）
      {
        repeatCell: {
          range: { sheetId: expId, startRowIndex: 1, endRowIndex: 5000 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 1, green: 1, blue: 1 },
              textFormat: { bold: false, foregroundColor: { red: 0, green: 0, blue: 0 } },
              horizontalAlignment: 'LEFT',
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
        }
      },
      // フィルター設定
      {
        setBasicFilter: {
          filter: {
            range: { sheetId: expId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: 18 }
          }
        }
      },
      // ヘッダー行を固定
      {
        updateSheetProperties: {
          properties: { sheetId: expId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount'
        }
      },
    ], ssId);
  }

  function _syncSettingsToDrive() {
    Drive.saveSettings({
      licenseKey: localStorage.getItem('keihi_license_key') || '',
      sheetId:    localStorage.getItem('keihi_sheet_id')    || '',
      folderId:   localStorage.getItem('keihi_folder_id')   || '',
    }).catch(() => {});
  }

  return { render, bindEvents };
})();
