/**
 * 設定・管理ビュー（統合版）
 * 全ユーザー：ライセンス・スプレッドシート設定
 * 管理者のみ：会社名・Gemini APIキー・メンバー管理・勘定科目・支払元
 */
const SettingsView = (() => {

  let _master = null;

  function render() {
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const ssId   = isDemo ? Demo.SHEET_ID : (localStorage.getItem('keihi_sheet_id') || '');
    const licKey = localStorage.getItem('keihi_license_key') || '';
    const email  = Auth.getUserEmail();
    const isAdmin = App.isAdmin();

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

  <!-- 初期設定 -->
  <div class="accordion mb-3" id="initSettingsAcc">
    <div class="accordion-item">
      <h2 class="accordion-header">
        <button class="accordion-button collapsed py-2" type="button"
          data-bs-toggle="collapse" data-bs-target="#initSettingsBody">
          <i class="bi bi-sliders me-2 text-primary"></i>初期設定
          ${!ssId ? '<span class="badge bg-danger ms-2" style="font-size:0.65rem;">要設定</span>' : ''}
        </button>
      </h2>
      <div id="initSettingsBody" class="accordion-collapse collapse">
        <div class="accordion-body px-3 py-2">

          <!-- ① 社名（管理者のみ） -->
          ${isAdmin ? `
          <div class="settings-step-title">① 社名・団体名・屋号等${!ssId ? ' <span class="text-danger" style="font-size:0.8rem;">*</span>' : ''}</div>
          <div class="settings-step-hint">ヘッダー名及びスプレッドシートタイトルに使用されます（後から変更可）</div>
          <div class="${ssId ? 'input-group' : ''} mb-3">
            <input type="text" class="form-control form-control-sm" id="inputCompanyName"
              placeholder="例：〇〇株式会社、NPO法人〇〇、屋号など">
            ${ssId ? '<button class="btn btn-outline-primary btn-sm" id="btnSaveCompanyName">保存</button>' : ''}
          </div>
          <div id="companyNameMsg" class="form-text" style="margin-top:-0.75rem;"></div>
          ` : ''}

          <!-- ② 証票データ・スプレッドシート保存先フォルダ（管理者のみ） -->
          ${isAdmin ? `
          <div class="settings-step-title">② 証票データ・スプレッドシート保存先フォルダ</div>
          ${!ssId ? `
          <div class="settings-step-hint">スプレッドシートと証票画像の保存先（空欄でマイドライブのルートに作成）</div>
          <input type="text" class="form-control form-control-sm mb-2" id="inputFolderUrl"
            placeholder="Google Drive フォルダのURL（任意）">
          <button class="btn btn-primary btn-sm w-100 mb-2" id="btnCreateSheet">
            <i class="bi bi-plus-circle me-1"></i>データ保存先を新規作成
          </button>
          <div id="createSheetMsg" class="form-text mb-3"></div>
          ` : `
          <div class="input-group mb-1">
            <input type="text" class="form-control form-control-sm" id="inputReceiptFolderUrl"
              placeholder="Google Drive フォルダのURL">
            <button class="btn btn-outline-primary btn-sm" id="btnSaveReceiptFolder">変更</button>
          </div>
          <div id="receiptFolderMsg" class="form-text mb-1"></div>
          <div id="folderOpenLinkWrap" class="mb-3"></div>
          `}
          ` : ''}

          <!-- ③ ライセンスキー -->
          <div class="settings-step-title">${isAdmin ? '③ ' : ''}ライセンスキー</div>
          <div id="licenseStatus" class="mb-2"></div>
          ${!licKey ? `<div class="settings-step-hint mb-2">メールにて通知されたライセンスキーを入力してください<br>例：<code>KL-XXXXXXXXXXXXXXXXXXXX</code></div>` : ''}
          <div class="input-group mb-1">
            <input type="password" class="form-control form-control-sm" id="inputLicenseKey"
              placeholder="KL-XXXXXXXXXXXXXXXXXXXX" value="${_escape(licKey)}">
            <button class="btn btn-outline-primary btn-sm" id="btnVerifyLicense">確認</button>
          </div>
          <div id="licenseMsg" class="form-text mb-2"></div>

          <!-- ④ Gemini APIキー（管理者のみ） -->
          ${isAdmin ? `
          <div class="settings-step-title">④ Gemini APIキー</div>
          <div class="settings-step-hint">全メンバー共用 — メンバーは個別取得不要。Google AI Studioで取得してください。</div>
          <div class="input-group mb-1">
            <input type="password" class="form-control form-control-sm" id="inputGeminiKey" placeholder="AIzaSy...">
            <button class="btn btn-outline-primary btn-sm" id="btnSaveGeminiKey">保存</button>
          </div>
          <div id="geminiKeyMsg" class="form-text"></div>
          ${_renderRegulationInitStep()}` : ''}

        </div>
      </div>
    </div>
  </div>

  ${isAdmin ? _renderMasterSections() : ''}

  <!-- スプレッドシートを直接開く（管理者のみ・最下部） -->
  ${isAdmin && ssId ? `
  <div class="text-center mt-3 mb-2">
    <a href="https://docs.google.com/spreadsheets/d/${ssId}" target="_blank" rel="noopener"
      class="btn btn-link btn-sm text-decoration-none text-secondary" style="font-size:0.78rem;">
      <i class="bi bi-table me-1"></i>スプレッドシートを直接開く
    </a>
  </div>` : ''}
</div>`;
  }

  function _renderMasterSections() {
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const ssId = isDemo ? '' : (localStorage.getItem('keihi_sheet_id') || '');
    const shareUrl = ssId ? `${location.origin}/${ssId}` : '';
    return `
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

  <!-- メンバー招待URL（管理者のみ・メンバー管理の下） -->
  ${ssId ? `
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">経費ログWebアプリURL</div>
      <div class="settings-step-hint mb-2">
        上のメンバー管理に氏名・メールアドレス・権限を登録してから、このURLをメンバーに連絡してください。
      </div>
      <div class="input-group input-group-sm">
        <input type="text" class="form-control form-control-sm" id="shareUrlDisplay"
          value="${_escape(shareUrl)}" readonly>
        <button class="btn btn-outline-secondary btn-sm" id="btnCopyShareUrl">
          <i class="bi bi-clipboard"></i>
        </button>
      </div>
    </div>
  </div>
  ` : ''}

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
  </div>



  <!-- ヘッダー色（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">アプリのヘッダーカラー</div>
      <p class="text-muted small mb-2">「経費ログ」と表示されている上部ナビバーの背景色を変更します。</p>
      <div class="d-flex align-items-center gap-2 mb-1">
        <input type="color" class="form-control form-control-color" id="inputHeaderColor"
          value="#0d6efd" style="width:3rem;height:2rem;padding:2px;">
        <button class="btn btn-outline-primary btn-sm" id="btnApplyHeaderColor">
          <i class="bi bi-palette me-1"></i>適用
        </button>
        <span id="headerColorMsg" class="form-text mb-0"></span>
      </div>
    </div>
  </div>
`;
  }

  async function bindEvents(el) {
    el.querySelector('#btnLogoutSettings')?.addEventListener('click', () => Auth.signOut());

    // 訂正・削除防止規程（初期設定⑤版）
    el.querySelector('#btnConfirmRegulationInit')?.addEventListener('click', () => {
      const orgName = el.querySelector('#regInitOrgName')?.value.trim();
      const repName = el.querySelector('#regInitRepName')?.value.trim();
      const address = el.querySelector('#regInitAddress')?.value.trim();
      const msg = el.querySelector('#regulationInitMsg');
      if (!orgName || !repName || !address) {
        msg.innerHTML = '<span class="text-danger">すべての項目を入力してください</span>';
        return;
      }
      const today = new Date();
      const confirmedAt = `${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日`;
      _saveRegulation({ orgName, repName, address, confirmedAt });
      App.showToast('訂正・削除防止規程を確定しました', 'success');
      Router.navigate('settings');
    });
    el.querySelector('#btnEditRegulationInit')?.addEventListener('click', () => {
      el.querySelector('#regulationInitForm')?.classList.remove('d-none');
    });

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
        // 購入者メールが一致する場合は管理者に昇格して画面を再描画
        if (result.ownerEmail && result.ownerEmail === Auth.getUserEmail().toLowerCase()) {
          await App.reloadMaster();
          Router.navigate('settings');
          return;
        }
        _syncSettingsToDrive();
      } else {
        msg.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>無効なライセンスキーです（${result.reason || ''}）</span>`;
      }
      _updateLicenseStatus(el, result);
    });
    _updateLicenseStatus(el, _getCachedLicenseResult());

    // スプレッドシート新規作成（シート未設定時のみ表示）
    el.querySelector('#btnCreateSheet')?.addEventListener('click', async () => {
      const name = el.querySelector('#inputCompanyName').value.trim();
      if (!name) { App.showToast('会社名・チーム名を入力してください', 'danger'); return; }

      const folderUrl = el.querySelector('#inputFolderUrl')?.value.trim() || '';
      const parentFolderId = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1] || null;

      const msg = el.querySelector('#createSheetMsg');
      const btn = el.querySelector('#btnCreateSheet');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>作成中...';
      msg.textContent = '';
      try {
        const ssId    = await Setup.createSpreadsheet(name, parentFolderId);
        const shareUrl = `${location.origin}/${ssId}`;
        const qrUrl   = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(shareUrl)}`;
        const mailSubject = encodeURIComponent(`【経費ログ】${name} へのご招待`);
        const mailBody = encodeURIComponent(
          `${name} の経費ログにご参加ください。\n\n` +
          `以下のURLからアクセスしてGoogleアカウントでログインしてください。\n\n` +
          `${shareUrl}\n\n` +
          `（QRコードは設定画面からご確認いただけます）`
        );
        msg.innerHTML = `
          <div class="alert alert-success py-2 mt-2 mb-0">
            <div class="fw-semibold mb-2"><i class="bi bi-check-circle me-1"></i>スプレッドシートを作成しました</div>
            <div class="mb-2 small">メンバーに以下のURLを共有してください：</div>
            <div class="input-group input-group-sm mb-2">
              <input type="text" class="form-control form-control-sm" id="shareUrlDisplay"
                value="${_escape(shareUrl)}" readonly>
              <button class="btn btn-outline-secondary btn-sm" id="btnCopyShareUrl">
                <i class="bi bi-clipboard"></i>
              </button>
            </div>
            <div class="text-center mb-2">
              <img src="${qrUrl}" alt="QRコード" width="160" height="160"
                class="rounded border" style="image-rendering:pixelated;">
              <div class="text-muted" style="font-size:0.7rem;">QRコードをスクリーンショットしてメールなどで共有できます</div>
            </div>
            <div class="d-flex gap-2">
              <button class="btn btn-outline-primary btn-sm flex-fill" id="btnSendMail">
                <i class="bi bi-envelope me-1"></i>メールで送る
              </button>
              <button class="btn btn-primary btn-sm flex-fill" id="btnReloadAfterCreate">
                <i class="bi bi-arrow-clockwise me-1"></i>再読み込みして開始
              </button>
            </div>
          </div>`;
        el.querySelector('#btnCopyShareUrl')?.addEventListener('click', () => {
          navigator.clipboard.writeText(shareUrl).then(() => App.showToast('URLをコピーしました', 'success'));
        });
        el.querySelector('#btnReloadAfterCreate')?.addEventListener('click', () => location.reload());
        el.querySelector('#btnSendMail')?.addEventListener('click', () => {
          window.location.href = `mailto:?subject=${mailSubject}&body=${mailBody}`;
        });
        App.showToast('スプレッドシートを作成しました', 'success');
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-plus-circle me-1"></i>データ保存先を新規作成';
      }
    });

    // 招待URLコピーボタン（常時表示カード）
    el.querySelector('#btnCopyShareUrl')?.addEventListener('click', () => {
      const url = el.querySelector('#shareUrlDisplay')?.value;
      if (url) navigator.clipboard.writeText(url).then(() => App.showToast('URLをコピーしました', 'success'));
    });

    if (!App.isAdmin()) return;

    // 会社名の読み込みと保存（ssId がある場合のみ。新規作成時は作成ボタンで使用される）
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const ssId = localStorage.getItem('keihi_sheet_id');
    if (isDemo) {
      if (el.querySelector('#inputCompanyName')) el.querySelector('#inputCompanyName').value = Demo.COMPANY_NAME;
    } else if (ssId) {
      try {
        const companyName = await Sheets.readSetting('B2');
        if (el.querySelector('#inputCompanyName')) {
          el.querySelector('#inputCompanyName').value = companyName || '';
        }
      } catch (_) {}
    }

    el.querySelector('#btnSaveCompanyName')?.addEventListener('click', async () => {
      const name = el.querySelector('#inputCompanyName').value.trim();
      const msg  = el.querySelector('#companyNameMsg');
      try {
        await Sheets.update('設定!B2', [[name]]);
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
        App.showToast('会社名を保存しました', 'success');
        const titleEl = document.getElementById('navAppTitle');
        if (titleEl) titleEl.textContent = name ? `経費ログ - ${name}` : '経費ログ';
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
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

    // 証票フォルダ：現在値をURLとしてinputに表示＋フォルダを開くリンクを生成
    const currentFolderId = localStorage.getItem('keihi_folder_id') || await Sheets.readSetting('B4').catch(() => '');
    const folderInput = el.querySelector('#inputReceiptFolderUrl');
    const folderOpenWrap = el.querySelector('#folderOpenLinkWrap');
    const _setFolderLink = fid => {
      if (!folderOpenWrap) return;
      folderOpenWrap.innerHTML = fid
        ? `<a href="https://drive.google.com/drive/folders/${fid}" target="_blank" class="btn btn-outline-secondary btn-sm w-100">
             <i class="bi bi-folder-fill me-1 text-warning"></i>フォルダを開く
           </a>`
        : '';
    };
    if (folderInput && currentFolderId) {
      folderInput.value = `https://drive.google.com/drive/folders/${currentFolderId}`;
    }
    _setFolderLink(currentFolderId);

    el.querySelector('#btnSaveReceiptFolder')?.addEventListener('click', async () => {
      const raw = el.querySelector('#inputReceiptFolderUrl').value.trim();
      const folderId = raw.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1] || '';
      const msg = el.querySelector('#receiptFolderMsg');
      if (!folderId) {
        msg.innerHTML = '<span class="text-danger">DriveフォルダのURLを正しく入力してください</span>';
        return;
      }
      try {
        await Sheets.update('設定!B4', [[folderId]]);
        localStorage.setItem('keihi_folder_id', folderId);
        Drive.saveSettings({
          licenseKey: localStorage.getItem('keihi_license_key') || '',
          sheetId:    localStorage.getItem('keihi_sheet_id')    || '',
          folderId,
        }).catch(() => {});
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
        _setFolderLink(folderId);
        App.showToast('証票フォルダを変更しました', 'success');
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      }
    });

    // ヘッダー色：localStorageから読み込み
    const colorInput = el.querySelector('#inputHeaderColor');
    if (colorInput) {
      const saved = localStorage.getItem('keihi_nav_color');
      colorInput.value = saved || '#0d6efd';
      // リアルタイムプレビュー
      colorInput.addEventListener('input', () => _applyNavColor(colorInput.value));
    }

    el.querySelector('#btnApplyHeaderColor')?.addEventListener('click', () => {
      const color = el.querySelector('#inputHeaderColor').value;
      const msg   = el.querySelector('#headerColorMsg');
      localStorage.setItem('keihi_nav_color', color);
      _applyNavColor(color);
      msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>適用しました</span>';
      App.showToast('ヘッダーカラーを変更しました', 'success');
      setTimeout(() => { msg.innerHTML = ''; }, 3000);
    });
  }

  function _applyNavColor(hexColor) {
    const navbar = document.querySelector('nav.navbar.sticky-top');
    if (!navbar) return;
    navbar.style.setProperty('background-color', hexColor, 'important');
    // 明度を計算して文字色を白/黒に自動切替
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const textColor = luminance > 0.55 ? '#212529' : '#ffffff';
    navbar.querySelectorAll('.navbar-brand, .text-white-50, .btn-outline-light').forEach(el => {
      el.style.color = textColor;
    });
    navbar.querySelector('.btn-outline-light')?.style.setProperty('border-color', textColor);
  }

  function _renderMembers(el) {
    const container = el.querySelector('#memberList');
    if (!container) return;
    if (!_master?.members?.length) {
      container.innerHTML = '<div class="text-muted small">メンバーが登録されていません</div>';
      return;
    }
    container.innerHTML = _master.members.map((m, i) => {
      const roleBadge = m.role === 'admin'
        ? '<span class="badge bg-primary ms-1" style="font-size:0.6rem;cursor:pointer;" data-bs-toggle="tooltip" data-bs-placement="top" title="全操作・メンバー管理・設定変更が可能"><i class="bi bi-shield-fill-check me-1"></i>管理者</span>'
        : m.role === 'viewer'
          ? '<span class="badge bg-info text-dark ms-1" style="font-size:0.6rem;cursor:pointer;" data-bs-toggle="tooltip" data-bs-placement="top" title="申請＋全体の一覧・集計の閲覧が可能"><i class="bi bi-eye-fill me-1"></i>閲覧者</span>'
          : '<span class="badge bg-secondary ms-1" style="font-size:0.6rem;cursor:pointer;" data-bs-toggle="tooltip" data-bs-placement="top" title="自分の経費申請のみ可能"><i class="bi bi-person-fill me-1"></i>一般</span>';
      return `
      <div class="d-flex align-items-center gap-2 py-2 border-bottom">
        <div class="flex-grow-1">
          <div class="master-item-name">${_escape(m.name)}</div>
          <div class="text-muted" style="font-size:0.72rem;">${_escape(m.email)}${m.dept ? ' / ' + _escape(m.dept) : ''}
            ${roleBadge}
          </div>
        </div>
        <button class="btn btn-outline-secondary btn-sm btn-edit-member" data-index="${i}"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-outline-danger btn-sm btn-del-member" data-index="${i}"><i class="bi bi-trash"></i></button>
      </div>`;
    }).join('');
    container.querySelectorAll('.btn-edit-member').forEach(btn =>
      btn.addEventListener('click', () => _showMemberForm(el, Number(btn.dataset.index))));
    container.querySelectorAll('.btn-del-member').forEach(btn =>
      btn.addEventListener('click', () => _deleteMember(el, Number(btn.dataset.index))));
    // ロールバッジのツールチップ初期化
    container.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(tipEl => {
      const tooltip = new bootstrap.Tooltip(tipEl, { trigger: 'manual' });
      let _hideTimer = null;
      // PC：ホバーで表示・離れたら消去
      tipEl.addEventListener('mouseenter', () => { clearTimeout(_hideTimer); tooltip.show(); });
      tipEl.addEventListener('mouseleave', () => { _hideTimer = setTimeout(() => tooltip.hide(), 150); });
      // モバイル：タップで表示・2秒後に自動消去
      tipEl.addEventListener('touchstart', e => {
        e.preventDefault();
        clearTimeout(_hideTimer);
        tooltip.show();
        _hideTimer = setTimeout(() => tooltip.hide(), 2000);
      }, { passive: false });
    });
  }

  function _renderSimpleList(el, containerId, items, type) {
    const container = el.querySelector(`#${containerId}`);
    if (!container) return;
    if (!items?.length) { container.innerHTML = '<div class="text-muted small">登録がありません</div>'; return; }
    container.innerHTML = items.map((item, i) => `
      <div class="d-flex align-items-center gap-2 py-1 border-bottom">
        <span class="flex-grow-1 master-item-name">${_escape(item)}</span>
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
                  <option value="member" ${!m.role || m.role === 'member' ? 'selected' : ''}>一般（申請のみ）</option>
                  <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>閲覧者（申請＋全体一覧・集計の閲覧）</option>
                  <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>管理者（全操作・メンバー管理）</option>
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
      const oldEmail = isNew ? null : (_master.members[idx]?.email || null);
      if (isNew) _master.members.push(updated);
      else       _master.members[idx] = updated;
      // Drive権限：メールアドレスが変わった場合は旧アドレスの権限を削除
      if (oldEmail && oldEmail.toLowerCase() !== updated.email.toLowerCase()) {
        _revokeMemberAccess(oldEmail).catch(() => {});
      }
      // 新規追加または新しいメールアドレスに権限付与
      if (isNew || (oldEmail && oldEmail.toLowerCase() !== updated.email.toLowerCase())) {
        _grantMemberAccess(updated.email).catch(() => {});
      }
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
    const member = _master.members[idx];
    const ok = await App.confirm(`${member.name} を削除しますか？`);
    if (!ok) return;
    _master.members.splice(idx, 1);
    _revokeMemberAccess(member.email).catch(() => {});
    await _saveMasterToSheet(el);
  }

  async function _grantMemberAccess(email) {
    const ssId     = localStorage.getItem('keihi_sheet_id');
    const folderId = localStorage.getItem('keihi_folder_id');
    const tasks = [];
    if (ssId)     tasks.push(Drive.grantEditorAccess(email, ssId).catch(() => {}));
    if (folderId) tasks.push(Drive.grantEditorAccess(email, folderId).catch(() => {}));
    await Promise.all(tasks);
  }

  async function _revokeMemberAccess(email) {
    const ssId     = localStorage.getItem('keihi_sheet_id');
    const folderId = localStorage.getItem('keihi_folder_id');
    const tasks = [];
    if (ssId)     tasks.push(Drive.revokeAccess(email, ssId).catch(() => {}));
    if (folderId) tasks.push(Drive.revokeAccess(email, folderId).catch(() => {}));
    await Promise.all(tasks);
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

    const syncCount = await _syncMemberNamesToExpenses(_master.members);
    if (syncCount > 0) App.showToast(`${syncCount}件の申請データの表示名を更新しました`, 'info');

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
      members.forEach(m => { if (m.email && m.name) emailToName[m.email.toLowerCase()] = m.name; });
      const updates = [];
      allRows.forEach((row, i) => {
        const email = (row[15] || '').toLowerCase();
        const currentName = row[1] || '';
        const newName = emailToName[email];
        if (newName && newName !== currentName) updates.push({ range: `経費一覧!B${i + 2}`, values: [[newName]] });
      });
      if (updates.length > 0) await Sheets.batchUpdateValues(updates);
      return updates.length;
    } catch (_) { return 0; }
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

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function _syncSettingsToDrive() {
    Drive.saveSettings({
      licenseKey: localStorage.getItem('keihi_license_key') || '',
      sheetId:    localStorage.getItem('keihi_sheet_id')    || '',
      folderId:   localStorage.getItem('keihi_folder_id')   || '',
    }).catch(() => {});
  }

  function _renderRegulationInitStep() {
    const reg = _loadRegulation();
    const previewReg = {
      orgName: '〇〇株式会社',
      repName: '代表者氏名',
      address: '所在地',
      confirmedAt: '〇〇年〇〇月〇〇日'
    };
    const previewText = buildRegulationText(previewReg).replace(/</g, '&lt;');
    const confirmedBadge = reg?.confirmedAt
      ? `<div class="alert alert-success py-1 mb-2 small"><i class="bi bi-check-circle me-1"></i>確定済み（${reg.confirmedAt}）<button class="btn btn-link btn-sm p-0 ms-2 text-secondary" id="btnEditRegulationInit">再編集</button></div>`
      : '';
    return `
          <hr class="my-3">
          <div class="settings-step-title">⑤ 訂正・削除防止規程（電帳法）</div>
          <div class="settings-step-hint mb-2">スキャナ保存で紙の原本を廃棄可能にするために必要な社内規程です。確定するとアプリ内に表示されます。</div>
          ${confirmedBadge}
          <div class="accordion mb-2" id="regPreviewAcc">
            <div class="accordion-item border rounded" style="background:#f8f9fa;">
              <h2 class="accordion-header">
                <button class="accordion-button collapsed py-1" type="button"
                  data-bs-toggle="collapse" data-bs-target="#regPreviewBody"
                  style="background:#f8f9fa;font-size:0.78rem;color:#555;">
                  <i class="bi bi-eye me-1 text-primary"></i>規程ひな型を確認する
                </button>
              </h2>
              <div id="regPreviewBody" class="accordion-collapse collapse">
                <div class="accordion-body px-2 py-2">
                  <pre style="font-size:0.65rem;white-space:pre-wrap;font-family:inherit;color:#555;max-height:200px;overflow-y:auto;">${previewText}</pre>
                </div>
              </div>
            </div>
          </div>
          <div id="regulationInitForm"${reg?.confirmedAt ? ' class="d-none"' : ''}>
            <div class="mb-2">
              <label class="form-label small mb-1">団体名（会社名・屋号等）</label>
              <input type="text" class="form-control form-control-sm" id="regInitOrgName"
                value="${_escape(reg?.orgName || localStorage.getItem('keihi_company_name') || '')}"
                placeholder="例：〇〇株式会社">
            </div>
            <div class="mb-2">
              <label class="form-label small mb-1">代表者名</label>
              <input type="text" class="form-control form-control-sm" id="regInitRepName"
                value="${_escape(reg?.repName || '')}" placeholder="例：山田 太郎">
            </div>
            <div class="mb-2">
              <label class="form-label small mb-1">所在地</label>
              <input type="text" class="form-control form-control-sm" id="regInitAddress"
                value="${_escape(reg?.address || '')}" placeholder="例：東京都千代田区〇〇1-2-3">
            </div>
            <button class="btn btn-primary btn-sm w-100" id="btnConfirmRegulationInit">
              <i class="bi bi-check-circle me-1"></i>確定して規程を作成する
            </button>
            <div id="regulationInitMsg" class="form-text mt-1"></div>
          </div>`;
  }

  function _loadRegulation() {
    try { return JSON.parse(localStorage.getItem('keihi_regulation') || 'null'); }
    catch (_) { return null; }
  }

  function _saveRegulation(data) {
    localStorage.setItem('keihi_regulation', JSON.stringify(data));
  }

  function buildRegulationText(reg) {
    return `国税関係書類に係るスキャナ保存 訂正・削除防止規程

第1条（目的）
本規程は、電子帳簿保存法第4条第3項に規定するスキャナ保存を行うにあたり、国税関係書類の電磁的記録の訂正・削除を防止するための事務処理手続を定めることを目的とする。

第2条（適用範囲）
本規程は、${reg.orgName}が電子帳簿保存法に基づきスキャナ保存する一切の国税関係書類に適用する。

第3条（責任者）
スキャナ保存に関する事務処理の責任者は、${reg.repName}とする。

第4条（スキャナ保存の手続）
1. 国税関係書類の受領後、速やかに（原則として受領日から2ヶ月以内に）スキャンを行い、所定の経費管理システムに入力する。
2. 入力画像の解像度は200万画素以上、カラーで保存する。

第5条（訂正・削除の禁止）
1. 保存した電磁的記録は、原則として訂正・削除を行わない。
2. やむを得ず訂正・削除を行う場合は、必ず経費管理システムの所定の機能（修正・削除機能）を使用し、その事実・内容・理由を記録する。
3. スプレッドシートへの直接編集は禁止する。

第6条（検索機能の確保）
保存した電磁的記録は、取引年月日・取引金額・取引先で検索できる状態を維持する。

第7条（原本の廃棄）
スキャナ保存の要件を満たした電磁的記録が適正に保存されたことを確認した後、紙の原本を廃棄することができる。

第8条（保存期間）
電磁的記録は、法令の定める期間（原則7年間）保存する。

第9条（規程の遵守）
役員・従業員・関与メンバーは本規程を遵守しなければならない。

制定日：${reg.confirmedAt}
所在地：${reg.address}
${reg.orgName}
代表者：${reg.repName}`;
  }

  return { render, bindEvents, buildRegulationText, _loadRegulation };
})();
