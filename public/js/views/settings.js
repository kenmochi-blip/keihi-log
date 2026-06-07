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
    const licKey = isDemo ? 'KL-XXXXXXXXXXXXXXXXXXXX（デモ）' : (localStorage.getItem('keihi_license_key') || '');
    const email  = Auth.getUserEmail();
    const isAdmin = App.isAdmin();

    return `
<div class="pt-3">
  <h5 class="fw-bold mb-3"><i class="bi bi-gear-fill me-2 text-primary"></i>設定</h5>

  <!-- アプリの表示名（管理者のみ・トップ） -->
  ${isAdmin ? `
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">アプリの表示名</div>
      <div class="settings-step-hint">アプリのヘッダーに表示されます（変更可）</div>
      <div class="input-group input-group-sm mb-1">
        <input type="text" class="form-control form-control-sm" id="inputCompanyName"
          placeholder="例：〇〇株式会社、NPO法人〇〇、屋号など">
        <button class="btn btn-outline-primary btn-sm" id="btnSaveCompanyName">保存</button>
      </div>
      <div id="companyNameMsg" class="form-text"></div>
    </div>
  </div>` : ''}

  <!-- 管理者セクション（メンバー管理・勘定科目・支払元・カスタムフラグ・ヘッダー色） -->
  ${isAdmin ? _renderMasterSections() : ''}

  <!-- 証票保存フォルダを開く（管理者・ssId設定済みの場合のみ・ヘッダー色の下） -->
  ${isAdmin && ssId ? `
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">証票保存フォルダ</div>
      <div id="folderOpenLinkWrap"></div>
    </div>
  </div>` : ''}

  <!-- 初期設定（末尾・SSを開くの上） -->
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

          <!-- チームURL（管理者・シート未設定時のみ） -->
          ${isAdmin && !ssId ? `
          <div class="settings-step-title">チームURL <span style="font-size:0.75rem;font-weight:400;color:#888;">任意・設定後変更不可</span></div>
          <div class="settings-step-hint">メンバーがアプリを開く共有URLのパスを決めます。空欄の場合はランダムで自動生成されます。</div>
          <div class="input-group input-group-sm mb-1">
            <span class="input-group-text" style="font-size:0.78rem;">${location.origin}/</span>
            <input type="text" class="form-control form-control-sm" id="inputAliasCode"
              placeholder="例: yamada-trading（英数字・ハイフン、6文字以上）"
              pattern="[a-zA-Z0-9\\-]{6,}" maxlength="40">
          </div>
          <div id="aliasCheckMsg" class="form-text mb-3"></div>
          ` : ''}

          <!-- 証票データ保存先（管理者・シート未設定時のみ） -->
          ${isAdmin && !ssId ? `
          <div class="settings-step-title">証票データ保存先フォルダ</div>
          <div class="settings-step-hint">スプレッドシートと証票画像の保存先（空欄でマイドライブのルートに作成）</div>
          <input type="text" class="form-control form-control-sm mb-2" id="inputFolderUrl"
            placeholder="Google Drive フォルダのURL（任意）">
          <button class="btn btn-primary btn-sm w-100 mb-2" id="btnCreateSheet">
            <i class="bi bi-plus-circle me-1"></i>データ保存先を新規作成
          </button>
          <div id="createSheetMsg" class="form-text mb-3"></div>
          ` : ''}

          <!-- ライセンスキー -->
          <div class="settings-step-title">ライセンスキー <a href="/faq#q1001" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></div>
          <div id="licenseStatus" class="mb-2"></div>
          ${!licKey ? `<div class="settings-step-hint mb-2">メールにて通知されたライセンスキーを入力してください<br>例：<code>KL-XXXXXXXXXXXXXXXXXXXX</code></div>` : ''}
          <div class="input-group mb-1">
            <input type="text" class="form-control form-control-sm keihi-masked" id="inputLicenseKey"
              autocomplete="off" spellcheck="false" placeholder="KL-XXXXXXXXXXXXXXXXXXXX" value="${_escape(licKey)}">
            <button class="btn btn-outline-secondary btn-sm" id="btnToggleLicenseKey" type="button" tabindex="-1">
              <i class="bi bi-eye"></i>
            </button>
            <button class="btn btn-outline-primary btn-sm" id="btnVerifyLicense">確認</button>
          </div>
          <div id="licenseMsg" class="form-text mb-2"></div>
          <div id="trialUpgradeBox" class="mb-2" style="display:none;"></div>

          <!-- Gemini APIキー（管理者のみ） -->
          ${isAdmin ? `
          <div class="settings-step-title">Gemini APIキー <a href="/faq#q402" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></div>
          <div class="settings-step-hint">全メンバー共用 — メンバーは個別取得不要です。</div>
          <div class="card bg-light border-0 p-2 mb-2" style="font-size:0.82rem;line-height:1.6;">
            <div class="fw-semibold mb-1"><i class="bi bi-key me-1 text-warning"></i>APIキーの取得手順</div>
            <ol class="mb-1 ps-3">
              <li>下のリンクをタップしてGoogle AI Studioを開く</li>
              <li>「Get API key」→「APIキーを作成」をタップ</li>
              <li>表示されたキー（AIzaSy...）をコピー</li>
              <li>このページに戻って下の欄に貼り付けて「保存」</li>
            </ol>
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener"
               class="btn btn-warning btn-sm rounded-pill px-3 mt-1">
              <i class="bi bi-box-arrow-up-right me-1"></i>Google AI Studioでキーを取得する
            </a>
          </div>
          <div class="accordion accordion-flush mb-2" id="geminiSecAccordion">
            <div class="accordion-item border border-warning border-opacity-50 rounded" style="background:#fffdf0;">
              <h2 class="accordion-header">
                <button class="accordion-button collapsed py-2 px-3 rounded" type="button"
                  data-bs-toggle="collapse" data-bs-target="#geminiSecBody"
                  style="background:transparent;font-size:0.82rem;font-weight:600;color:inherit;">
                  <i class="bi bi-shield-check me-1 text-warning"></i>セキュリティ推奨設定（任意）
                </button>
              </h2>
              <div id="geminiSecBody" class="accordion-collapse collapse">
                <div class="accordion-body py-2 px-3" style="font-size:0.82rem;line-height:1.6;">
                  <p class="mb-1">APIキーに利用元ドメインの制限をかけると、万一キーが流出しても悪用を防げます。</p>
                  <ol class="mb-1 ps-3">
                    <li>Google Cloud Console で APIキーを開く</li>
                    <li>「APIの制限」→「HTTPリファラー（ウェブサイト）」を選択</li>
                    <li><code>keihi-log.com/*</code> を追加して保存</li>
                  </ol>
                  <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" class="text-warning fw-semibold" style="font-size:0.82rem;">
                    <i class="bi bi-box-arrow-up-right me-1"></i>Google Cloud Consoleでキーを編集する
                  </a>
                </div>
              </div>
            </div>
          </div>
          <div class="input-group mb-1">
            <input type="text" class="form-control form-control-sm keihi-masked" id="inputGeminiKey"
              autocomplete="off" spellcheck="false" placeholder="AIzaSy...">
            <button class="btn btn-outline-primary btn-sm" id="btnSaveGeminiKey">保存</button>
          </div>
          <div id="geminiKeyMsg" class="form-text"></div>

          ${_renderRegulationInitStep()}` : ''}

        </div>
      </div>
    </div>
  </div>

  <!-- SAプロキシ共有の再設定（管理者・ssId設定済み・デモ以外のみ） -->
  ${isAdmin && ssId && !isDemo ? `
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">プロキシ共有の再設定</div>
      <p style="font-size:0.82rem;color:#666;">セットアップ時に共有設定が失敗した場合はここで再実行できます。</p>
      <button class="btn btn-outline-secondary btn-sm" id="btnReShareSA">
        <i class="bi bi-arrow-repeat me-1"></i>サービスアカウントを再共有する
      </button>
      <div id="reShareMsg" class="mt-2" style="font-size:0.82rem;display:none;"></div>
    </div>
  </div>` : ''}

  <!-- スプレッドシートを直接開く（管理者・ssId設定済み・デモ以外のみ・最下部） -->
  ${isAdmin && ssId && !isDemo ? `
  <div class="text-center mt-3 mb-2">
    <a href="https://docs.google.com/spreadsheets/d/${ssId}" target="_blank" rel="noopener"
      class="btn btn-link btn-sm text-decoration-none text-secondary" style="font-size:0.78rem;">
      <i class="bi bi-table me-1"></i>スプレッドシートを直接開く
    </a>
    <div class="text-muted" style="font-size:0.72rem;">⚠️ シートの内容を直接編集するとアプリが正常に動作しなくなる場合があります</div>
  </div>` : ''}
</div>`;
  }

  function _renderMasterSections() {
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const ssId = isDemo ? '' : (localStorage.getItem('keihi_sheet_id') || '');
    const alias = isDemo ? '' : (localStorage.getItem('keihi_alias') || '');
    // 現在のURLパスがエイリアス形式であればそれを優先（ブラウザURLと設定表示を一致させる）
    const pathToken = location.pathname.match(/^\/([a-zA-Z0-9_-]{3,43})$/)?.[1];
    const effectiveAlias = (pathToken && pathToken !== 'app' && pathToken !== 'faq') ? pathToken : alias;
    const shareUrl = effectiveAlias ? `${location.origin}/${effectiveAlias}` : (ssId ? `${location.origin}/${ssId}` : '');
    return `
  <!-- メンバー管理（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title d-flex justify-content-between align-items-center">
        <span>メンバー管理 <a href="/faq#q104" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddMember"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <div id="memberPlanHint" class="d-none mt-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="text-muted small"><i class="bi bi-info-circle me-1"></i>メンバー追加はチームプランでご利用いただけます</span>
          <button class="btn btn-primary btn-sm" id="btnUpgradePlan">
            <i class="bi bi-arrow-up-circle me-1"></i>プランを切り替える
          </button>
        </div>
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
      <div class="input-group input-group-sm mb-2">
        <input type="text" class="form-control form-control-sm" id="shareUrlDisplay"
          value="${_escape(shareUrl)}" readonly>
        <button class="btn btn-outline-secondary btn-sm" id="btnCopyShareUrl">
          <i class="bi bi-clipboard"></i>
        </button>
      </div>
      <div class="form-text mb-2"><i class="bi bi-exclamation-circle me-1 text-warning"></i>LINEのアプリ内リンクから開くとGoogleログインがブロックされます。Safari・ChromeなどのブラウザアプリのURLバーに貼り付けて開くよう案内してください。</div>
      <div class="accordion" id="qrAcc">
        <div class="accordion-item border-0">
          <h2 class="accordion-header">
            <button class="accordion-button collapsed py-1 px-0 bg-transparent shadow-none text-primary"
              style="font-size:0.8rem;" type="button"
              data-bs-toggle="collapse" data-bs-target="#qrBody">
              <i class="bi bi-qr-code me-1"></i>QRコードを表示
            </button>
          </h2>
          <div id="qrBody" class="accordion-collapse collapse">
            <div class="accordion-body px-0 py-2 text-center">
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}"
                alt="QRコード" width="180" height="180" class="rounded border">
              <div class="text-muted mt-1" style="font-size:0.7rem;">スクリーンショットしてメールなどで共有できます</div>
            </div>
          </div>
        </div>
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
        <span>会社払い支払元 <a href="/faq#q107" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddPaySource"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <div id="paySourceList" class="mt-2">
        <div class="text-muted small text-center py-2">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- カスタムフラグ（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title d-flex justify-content-between align-items-center">
        <span>カスタムフラグ <a href="/faq#q109" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddCustomFlag"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <p class="text-muted small mb-2">部門・プロジェクト等、申請時に自由に使えるタグを定義します。</p>
      <div id="customFlagList" class="mt-2">
        <div class="text-muted small text-center py-2">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- 自家用車レート（管理者のみ） -->
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">自家用車レート（円/km） <a href="/faq#q307" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></div>
      <p class="text-muted small mb-2">全メンバー共通のキロ単価です。メンバーは参照のみ可能です。</p>
      <div class="input-group input-group-sm mb-1" style="max-width:200px;">
        <input type="number" class="form-control form-control-sm" id="inputCarRate" min="1" step="1" placeholder="20">
        <button class="btn btn-outline-primary btn-sm" id="btnSaveCarRate">保存</button>
      </div>
      <div id="carRateMsg" class="form-text"></div>
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

  async function bindEvents(el, opts = {}) {

    // スプレッドシートの規程データと localStorage を比較し、新しい方を使う
    {
      const _isDemo = typeof Demo !== 'undefined' && Demo.isActive();
      const _regSsId = !_isDemo && localStorage.getItem('keihi_sheet_id');
      if (_regSsId) {
        Sheets.readSetting('B6').then(raw => {
          if (!raw) return;
          try {
            const sheetData = JSON.parse(raw);
            if (!sheetData?.confirmedAt) return;
            // シートの規程データを常に優先（ワークスペース切り替え後の混在を防ぐ）
            const prev = localStorage.getItem(_regulationKey());
            const next = JSON.stringify(sheetData);
            localStorage.setItem(_regulationKey(), next);
            // データが変わった場合のみ再描画（無限ループ防止）
            if (prev !== next) {
              // regulationSectionを直接差し替え（Router.navigateは現ビューでは動作しないため）
              const section = el.querySelector('#regulationSection');
              if (section) {
                const tmp = document.createElement('div');
                tmp.innerHTML = _renderRegulationInitStep();
                const newSection = tmp.querySelector('#regulationSection');
                if (newSection) section.replaceWith(newSection);
              }
            }
          } catch (_) {}
        }).catch(() => {});
      }
    }

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
      const existing = _loadRegulation();
      if (existing?.confirmedAt) {
        // 再確定は確定日が今日の日付に更新されるため明示的に確認
        if (!confirm(`規程を再確定すると確定日が今日の日付（${new Date().getFullYear()}年${new Date().getMonth()+1}月${new Date().getDate()}日）に更新されます。\n現在の確定日：${existing.confirmedAt}\n\n続けますか？`)) return;
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

    // ライセンスキー表示/非表示トグル（CSSマスクのオン・オフ）
    el.querySelector('#btnToggleLicenseKey')?.addEventListener('click', () => {
      const inp = el.querySelector('#inputLicenseKey');
      const icon = el.querySelector('#btnToggleLicenseKey i');
      if (inp.classList.contains('keihi-masked')) {
        inp.classList.remove('keihi-masked');
        icon.className = 'bi bi-eye-slash';
      } else {
        inp.classList.add('keihi-masked');
        icon.className = 'bi bi-eye';
      }
    });

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
        // シートが接続済みならB3にも書き込み（メンバーが自動取得できるようにする）
        if (localStorage.getItem('keihi_sheet_id')) {
          Sheets.writeSetting('B3', key).catch(() => {});
        }
        msg.innerHTML = `<span class="text-success"><i class="bi bi-check-circle me-1"></i>有効（${result.company || ''}）${result.expiresAt ? ' 期限: ' + result.expiresAt.split('T')[0] : ''}</span>`;
        App.showToast('ライセンスを確認しました', 'success');
        // 社名が未入力なら Stripe 登録の会社名を自動入力
        const companyInput = el.querySelector('#inputCompanyName');
        if (companyInput && !companyInput.value.trim() && result.company) {
          companyInput.value = result.company;
        }
        // 購入者メールが一致する場合は管理者に昇格して画面を再描画
        if (result.ownerEmail && result.ownerEmail === Auth.getUserEmail().toLowerCase()) {
          await App.reloadMaster();
          Router.navigate('settings');
          return;
        }
      } else {
        msg.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>無効なライセンスキーです（${result.reason || ''}）</span>`;
      }
      _updateLicenseStatus(el, result);
      _applyMemberPlanRestriction(el);
    });
    _updateLicenseStatus(el, _getCachedLicenseResult());

    // スプレッドシート新規作成（シート未設定時のみ表示）
    el.querySelector('#btnCreateSheet')?.addEventListener('click', async () => {
      const name = el.querySelector('#inputCompanyName').value.trim();
      if (!name) { App.showToast('会社名・チーム名を入力してください', 'danger'); return; }

      const folderUrl = el.querySelector('#inputFolderUrl')?.value.trim() || '';
      const parentFolderId = folderUrl.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1] || null;

      // カスタムエイリアスの検証
      const aliasInput = el.querySelector('#inputAliasCode');
      const aliasCheckMsg = el.querySelector('#aliasCheckMsg');
      const customAlias = aliasInput?.value.trim().toLowerCase() || '';
      if (customAlias) {
        if (!/^[a-zA-Z0-9-]{6,40}$/.test(customAlias)) {
          aliasCheckMsg.innerHTML = '<span class="text-danger">英数字・ハイフンのみ、6〜40文字で入力してください</span>';
          return;
        }
        const base = window.APP_CONFIG?.apiBase || '';
        const chk = await fetch(`${base}/api/alias?code=${encodeURIComponent(customAlias)}`);
        if (chk.ok) {
          aliasCheckMsg.innerHTML = '<span class="text-danger">このURLはすでに使われています。別の文字列を入力してください</span>';
          return;
        }
        if (aliasCheckMsg) aliasCheckMsg.textContent = '';
      }

      const msg = el.querySelector('#createSheetMsg');
      const btn = el.querySelector('#btnCreateSheet');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>作成中...';
      msg.textContent = '';
      try {
        const ssId    = await Setup.createSpreadsheet(name, parentFolderId, customAlias);
        localStorage.setItem('keihi_company_name', name);
        // シート作成後、localStorageにライセンスキーがあればB3に確実に書き込む
        // （_writeInitialDataでも書くが、タイミングによっては空になる場合の保険）
        // セットアップ直後はSA共有前の可能性があるため作成者自身のトークンで直接書き込む
        const _lic = localStorage.getItem('keihi_license_key');
        if (_lic) Sheets.update('設定!B3', [[_lic]]).catch(() => {});
        // 作成されたフォルダURLをフォルダURL欄に反映
        const createdFolderId = localStorage.getItem('keihi_folder_id') || '';
        if (createdFolderId) {
          const folderInput = el.querySelector('#inputFolderUrl');
          if (folderInput) folderInput.value = `https://drive.google.com/drive/folders/${createdFolderId}`;
        }
        const alias   = localStorage.getItem('keihi_alias') || '';
        // エイリアスURLをアドレスバーに即反映（リロード前にホーム画面追加しても正しいURLになる）
        if (alias) {
          history.replaceState(null, '', '/' + alias);
        }
        const shareUrl = alias ? `${location.origin}/${alias}` : `${location.origin}/${ssId}`;
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

    // fromCache=true のとき：スワイプ由来でキャッシュ済みHTMLが表示されているため
    // シートからの再読み込み（社名・Gemini APIキー・車両レート）をスキップ
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const ssId = localStorage.getItem('keihi_sheet_id');
    if (!opts.fromCache) {
    // 設定シートをB2:B7まとめて1回のAPIコールで読み込む
    if (isDemo) {
      if (el.querySelector('#inputCompanyName')) el.querySelector('#inputCompanyName').value = Demo.COMPANY_NAME;
    } else if (ssId) {
      try {
        const cfg = await Sheets.readAllSettings();
        // 会社名 (B2)
        if (cfg.B2 && el.querySelector('#inputCompanyName')) {
          el.querySelector('#inputCompanyName').value = cfg.B2;
        }
        // Gemini APIキー (B5)
        const geminiInput = el.querySelector('#inputGeminiKey');
        if (geminiInput) geminiInput.value = cfg.B5 || localStorage.getItem('keihi_gemini_key') || '';
        if (cfg.B5) localStorage.setItem('keihi_gemini_key', cfg.B5);
        // 自家用車レート (B7)
        const carRateInput = el.querySelector('#inputCarRate');
        if (carRateInput && cfg.B7) {
          carRateInput.value = cfg.B7;
          localStorage.setItem('keihi_car_rate', cfg.B7);
        }
      } catch (err) {
        // 読み込み失敗時はキャッシュから復元
        const cached = localStorage.getItem('keihi_gemini_key');
        const geminiInput = el.querySelector('#inputGeminiKey');
        if (cached && geminiInput) {
          geminiInput.value = cached;
        } else {
          const geminiMsg = el.querySelector('#geminiKeyMsg');
          if (geminiMsg) geminiMsg.innerHTML = '<span class="text-warning small"><i class="bi bi-exclamation-triangle me-1"></i>読み込みに失敗しました。キーを再入力して保存してください</span>';
        }
      }
    }
    } // end !opts.fromCache

    // fromCache=true のとき：innerHTML は input の .value プロパティを保存しないため
    // localStorage から input 値を復元する（APIコールなし）
    if (opts.fromCache) {
      const companyInput = el.querySelector('#inputCompanyName');
      if (companyInput) companyInput.value = localStorage.getItem('keihi_company_name') || '';
      const geminiInput = el.querySelector('#inputGeminiKey');
      if (geminiInput) geminiInput.value = localStorage.getItem('keihi_gemini_key') || '';
      const carRateInput = el.querySelector('#inputCarRate');
      const cachedRate = localStorage.getItem('keihi_car_rate');
      if (carRateInput && cachedRate) carRateInput.value = cachedRate;
    }

    el.querySelector('#btnSaveCompanyName')?.addEventListener('click', async () => {
      const name = el.querySelector('#inputCompanyName').value.trim();
      const msg  = el.querySelector('#companyNameMsg');
      try {
        await Sheets.writeSetting('B2', name);
        localStorage.setItem('keihi_company_name', name);
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
        App.showToast('会社名を保存しました', 'success');
        const titleEl = document.getElementById('navAppTitle');
        if (titleEl) titleEl.textContent = name ? `経費ログ - ${name}` : '経費ログ';
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      }
    });

    el.querySelector('#btnSaveGeminiKey')?.addEventListener('click', async () => {
      const key = el.querySelector('#inputGeminiKey').value.trim();
      const msg = el.querySelector('#geminiKeyMsg');
      if (!key) {
        msg.innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle me-1"></i>APIキーを入力してください（空白では保存できません）</span>';
        return;
      }
      try {
        await Sheets.writeSetting('B5', key);
        localStorage.setItem('keihi_gemini_key', key);
        Gemini.clearApiKey();
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
        App.showToast('Gemini APIキーを保存しました', 'success');
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      }
    });

    el.querySelector('#btnSaveCarRate')?.addEventListener('click', async () => {
      const rate = el.querySelector('#inputCarRate').value.trim();
      const msg = el.querySelector('#carRateMsg');
      if (!rate || isNaN(Number(rate)) || Number(rate) < 1) {
        msg.innerHTML = '<span class="text-danger"><i class="bi bi-exclamation-circle me-1"></i>1以上の数値を入力してください</span>';
        return;
      }
      try {
        await Sheets.writeSetting('B7', Number(rate));
        localStorage.setItem('keihi_car_rate', rate);
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>保存しました</span>';
        App.showToast('自家用車レートを保存しました', 'success');
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${_escape(err.message)}</span>`;
      }
    });


    // マスタデータ読み込み
    // fromCache=true のとき：スワイプ由来でキャッシュ済みHTMLが表示されているため
    // リスト再レンダリングをスキップ（チカチカ防止）。_master は後続イベントで使うため常に取得。
    try {
      _master = await App.getMaster();
      if (!opts.fromCache) {
        _renderMembers(el);
        _renderCategoryList(el);
        _renderSimpleList(el, 'paySourceList',  _master.paySources,        'paySource');
        _renderSimpleList(el, 'customFlagList', _master.customFlags || [], 'customFlag');
      }
    } catch (err) {
      if (!opts.fromCache) App.showToast('マスタデータの読み込みに失敗しました', 'danger');
    }

    _applyMemberPlanRestriction(el);
    el.querySelector('#btnAddMember')?.addEventListener('click', () => _showMemberForm(el, null));
    el.querySelector('#btnUpgradePlan')?.addEventListener('click', () => _openStripePortal());
    el.querySelector('#btnAddCategory')?.addEventListener('click', () => _showInlineAdd(el, 'category'));
    el.querySelector('#btnAddPaySource')?.addEventListener('click', () => _showInlineAdd(el, 'paySource'));
    el.querySelector('#btnAddCustomFlag')?.addEventListener('click', () => _showInlineAdd(el, 'customFlag'));

    // 証票フォルダ：フォルダを開くリンクを生成（ssId設定済み・デモ以外のみ）
    const currentFolderId = isDemo ? '' : (localStorage.getItem('keihi_folder_id') || await Sheets.readSetting('B4').catch(() => ''));
    const folderOpenWrap = el.querySelector('#folderOpenLinkWrap');
    const _setFolderLink = fid => {
      if (!folderOpenWrap) return;
      folderOpenWrap.innerHTML = fid
        ? `<a href="https://drive.google.com/drive/folders/${fid}" target="_blank" class="btn btn-outline-secondary btn-sm w-100">
             <i class="bi bi-folder-fill me-1 text-warning"></i>保存先フォルダを開く
           </a>`
        : '<span class="text-muted small">フォルダが設定されていません</span>';
    };
    _setFolderLink(currentFolderId);

    // チームURLリアルタイム重複チェック
    let _aliasCheckTimer = null;
    el.querySelector('#inputAliasCode')?.addEventListener('input', (e) => {
      clearTimeout(_aliasCheckTimer);
      const val = e.target.value.trim().toLowerCase();
      const msgEl = el.querySelector('#aliasCheckMsg');
      if (!val) { msgEl.textContent = ''; return; }
      if (!/^[a-zA-Z0-9-]{1,40}$/.test(val)) {
        msgEl.innerHTML = '<span class="text-danger">英数字・ハイフンのみ使用できます</span>';
        return;
      }
      if (val.length < 6) {
        msgEl.innerHTML = '<span class="text-muted">6文字以上必要です</span>';
        return;
      }
      msgEl.innerHTML = '<span class="text-muted">確認中…</span>';
      _aliasCheckTimer = setTimeout(async () => {
        const base = window.APP_CONFIG?.apiBase || '';
        const r = await fetch(`${base}/api/alias?code=${encodeURIComponent(val)}`).catch(() => null);
        if (!r) { msgEl.textContent = ''; return; }
        if (r.ok) {
          msgEl.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle me-1"></i>このURLはすでに使われています</span>';
        } else {
          msgEl.innerHTML = `<span class="text-success"><i class="bi bi-check-circle me-1"></i>${location.origin}/${val} は使用可能です</span>`;
        }
      }, 600);
    });

    el.querySelector('#btnCreateFolder')?.addEventListener('click', async () => {
      const btn = el.querySelector('#btnCreateFolder');
      const msg = el.querySelector('#receiptFolderMsg');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>作成中...';
      try {
        const companyName = (await Sheets.readSetting('B2').catch(() => '')) || '';
        const newFolderId = await Drive.createFolder(`経費証票 - ${companyName}`.trim());
        await Sheets.writeSetting('B4', newFolderId);
        localStorage.setItem('keihi_folder_id', newFolderId);
        if (folderInput) folderInput.value = `https://drive.google.com/drive/folders/${newFolderId}`;
        _setFolderLink(newFolderId);
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>証票フォルダを作成しました</span>';
        btn.innerHTML = '<i class="bi bi-check-circle me-1"></i>作成済み';
      } catch (e) {
        msg.innerHTML = `<span class="text-danger">作成に失敗しました: ${e.message}</span>`;
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-folder-plus me-1"></i>証票フォルダを自動作成';
      }
    });

    el.querySelector('#btnSaveReceiptFolder')?.addEventListener('click', async () => {
      const raw = el.querySelector('#inputReceiptFolderUrl').value.trim();
      const folderId = raw.match(/folders\/([a-zA-Z0-9_-]+)/)?.[1] || '';
      const msg = el.querySelector('#receiptFolderMsg');
      if (!folderId) {
        msg.innerHTML = '<span class="text-danger">DriveフォルダのURLを正しく入力してください</span>';
        return;
      }
      try {
        await Sheets.writeSetting('B4', folderId);
        localStorage.setItem('keihi_folder_id', folderId);
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

    el.querySelector('#btnReShareSA')?.addEventListener('click', async () => {
      const btn = el.querySelector('#btnReShareSA');
      const msg = el.querySelector('#reShareMsg');
      const ssId     = localStorage.getItem('keihi_sheet_id') || '';
      const folderId = localStorage.getItem('keihi_folder_id') || '';
      const SA_EMAIL = 'keihi-log-proxy@keihi-log.iam.gserviceaccount.com';
      btn.disabled = true;
      msg.style.display = 'none';
      try {
        await Promise.all([
          ssId     ? Drive.grantEditorAccess(SA_EMAIL, ssId)     : Promise.resolve(),
          folderId ? Drive.grantEditorAccess(SA_EMAIL, folderId) : Promise.resolve(),
        ]);
        msg.style.display = '';
        msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>共有設定が完了しました</span>';
      } catch (e) {
        msg.style.display = '';
        msg.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle me-1"></i>失敗しました: ${e.message}</span>`;
        btn.disabled = false;
      }
    });

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
      // スプレッドシート未作成時：現在ユーザーを管理者プレビューとして表示
      const userInfo  = Auth.getUserInfo();
      const userEmail = Auth.getUserEmail();
      const userName  = userInfo?.name || userEmail || '';
      container.innerHTML = `
        <div class="d-flex align-items-center gap-2 py-2 border-bottom">
          <div class="flex-grow-1">
            <div class="master-item-name">${_escape(userName)}</div>
            <div class="text-muted" style="font-size:0.72rem;">${_escape(userEmail)}
              <span class="badge bg-primary ms-1" style="font-size:0.6rem;"><i class="bi bi-shield-fill-check me-1"></i>管理者</span>
            </div>
          </div>
        </div>
        <div class="text-muted mt-2" style="font-size:0.72rem;"><i class="bi bi-info-circle me-1"></i>データ保存先を新規作成すると正式に登録されます</div>`;
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

  function _renderCategoryList(el) {
    const container = el.querySelector('#categoryList');
    if (!container) return;
    const categories = _master.categories || [];
    if (!categories.length) { container.innerHTML = '<div class="text-muted small">登録がありません</div>'; return; }
    container.innerHTML = categories.map((item, i) => `
      <div class="d-flex align-items-center gap-2 py-1 border-bottom cat-row" data-index="${i}">
        <i class="bi bi-grip-vertical text-muted cat-drag-handle"
           style="font-size:1.1rem;cursor:grab;flex-shrink:0;" title="ドラッグして並び替え"></i>
        <span class="flex-grow-1 small master-item-name">${_escape(item)}</span>
        <button class="btn btn-outline-danger btn-sm btn-del-item" data-type="category" data-index="${i}">
          <i class="bi bi-trash"></i>
        </button>
      </div>`).join('');

    // ── ドラッグ＆ドロップ並び替え ──
    let _dragIdx = null;
    function _clearDragHighlight() {
      container.querySelectorAll('.cat-row').forEach(r => { r.style.background = ''; r.style.opacity = ''; });
    }
    container.querySelectorAll('.cat-row').forEach(row => {
      const handle = row.querySelector('.cat-drag-handle');
      handle.addEventListener('mousedown', () => { row.draggable = true; });
      document.addEventListener('mouseup', () => { row.draggable = false; }, { once: false });
      row.addEventListener('dragstart', e => {
        _dragIdx = Number(row.dataset.index);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => { row.style.opacity = '0.4'; }, 0);
      });
      row.addEventListener('dragend', () => { row.draggable = false; _clearDragHighlight(); });
      row.addEventListener('dragover', e => {
        e.preventDefault();
        container.querySelectorAll('.cat-row').forEach(r => { r.style.background = ''; });
        row.style.background = '#e8f4fd';
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        const dropIdx = Number(row.dataset.index);
        _clearDragHighlight();
        if (_dragIdx === null || _dragIdx === dropIdx) return;
        const moved = _master.categories.splice(_dragIdx, 1)[0];
        _master.categories.splice(dropIdx, 0, moved);
        _dragIdx = null;
        _renderCategoryList(el); // ローカルデータで即再描画
        _saveCategoriesQuiet().catch(() => App.showToast('並び替えの保存に失敗しました', 'danger'));
      });
    });

    // ── 削除 ──
    container.querySelectorAll('.btn-del-item').forEach(btn =>
      btn.addEventListener('click', () => _deleteSimpleItem(el, btn.dataset.type, Number(btn.dataset.index))));
  }

  function _showMemberForm(el, idx) {
    const m = idx !== null ? _master.members[idx] : { name: '', email: '', dept: '', role: '' };
    const isNew = idx === null;
    const mRole = (m.role || '').toLowerCase();
    const currentEmail = (Auth.getUserEmail() || '').toLowerCase();
    const adminCount = _master.members.filter(m2 => (m2.role || '').toLowerCase() === 'admin').length;
    const isLastAdminSelf = !isNew && mRole === 'admin' && adminCount <= 1 && m.email?.toLowerCase() === currentEmail;
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
                <input type="email" class="form-control form-control-sm" id="mEmail" value="${_escape(m.email)}" ${!isNew ? 'readonly' : ''}>
                <div class="form-text"><i class="bi bi-google me-1 text-primary"></i>Googleアカウントに紐づいたメールアドレスを入力してください（Gmail・Google Workspace）</div>
              </div>
              <div class="mb-2"><label class="form-label small">所属</label>
                <input type="text" class="form-control form-control-sm" id="mDept" value="${_escape(m.dept)}"></div>
              <div class="mb-2"><label class="form-label small">権限</label>
                <select class="form-select form-select-sm" id="mRole" ${isLastAdminSelf ? 'disabled title="唯一の管理者のため変更できません"' : ''}>
                  <option value="admin" ${mRole === 'admin' ? 'selected' : ''}>管理者（全操作・メンバー管理）</option>
                  <option value="viewer" ${mRole === 'viewer' ? 'selected' : ''}>閲覧者（申請＋全体一覧・集計の閲覧）</option>
                  <option value="" ${mRole !== 'admin' && mRole !== 'viewer' ? 'selected' : ''}>一般（申請のみ）</option>
                </select>
                ${isLastAdminSelf ? '<div class="form-text text-danger small"><i class="bi bi-lock-fill me-1"></i>唯一の管理者のため変更できません</div>' : ''}
              </div>
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
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updated.email)) return App.showToast('有効なメールアドレスを入力してください', 'danger');
      if (isLastAdminSelf) updated.role = 'admin';
      if (!isNew && ((_master.members[idx]?.role || '').toLowerCase() === 'admin') && updated.role !== 'admin') {
        const cnt = _master.members.filter(m => (m.role || '').toLowerCase() === 'admin').length;
        if (cnt <= 1) {
          App.showToast('管理者が1人のため降格できません。先に他のメンバーを管理者に設定してください。', 'danger');
          return;
        }
      }
      const oldEmail = isNew ? null : (_master.members[idx]?.email || null);
      if (isNew) _master.members.push(updated);
      else       _master.members[idx] = updated;
      await _saveMasterToSheet(el);
      modal.hide();
    });
    div.querySelector('.modal').addEventListener('hidden.bs.modal', () => div.remove());
  }

  function _showInlineAdd(el, type) {
    const containerIds = { category: 'categoryList', paySource: 'paySourceList', customFlag: 'customFlagList' };
    const container = el.querySelector(`#${containerIds[type]}`);
    const row = document.createElement('div');
    row.className = 'd-flex gap-1 mt-2';
    row.innerHTML = `<input type="text" class="form-control form-control-sm" placeholder="追加する項目名">
      <button class="btn btn-primary btn-sm px-2" title="追加"><i class="bi bi-check-lg"></i></button>
      <button class="btn btn-secondary btn-sm px-2" title="キャンセル"><i class="bi bi-x-lg"></i></button>`;
    container.prepend(row);
    row.querySelector('input').focus();
    row.querySelectorAll('button')[1].addEventListener('click', () => row.remove());
    row.querySelectorAll('button')[0].addEventListener('click', async () => {
      const val = row.querySelector('input').value.trim();
      if (!val) return;
      if (type === 'category')        _master.categories.push(val);
      else if (type === 'paySource')  _master.paySources.push(val);
      else if (type === 'customFlag') { if (!_master.customFlags) _master.customFlags = []; _master.customFlags.push(val); }
      await _saveMasterToSheet(el);
      row.remove();
    });
  }

  async function _deleteMember(el, idx) {
    const member = _master.members[idx];
    const ok = await App.confirm(`${member.name} を削除しますか？`);
    if (!ok) return;
    _master.members.splice(idx, 1);
    try {
      await _saveMasterToSheet(el);
    } catch (err) {
      App.showToast(`削除エラー: ${err.message}`, 'danger');
      _master.members.splice(idx, 0, member); // ロールバック
      _renderMembers(el);
    }
  }

  async function _deleteSimpleItem(el, type, idx) {
    const lists = { category: _master.categories, paySource: _master.paySources, customFlag: _master.customFlags || [] };
    const labels = { category: '勘定科目', paySource: '会社払い支払元', customFlag: 'カスタムフラグ' };
    const item = lists[type]?.[idx];
    if (!item) return;
    const ok = await App.confirm(`「${item}」を削除しますか？`);
    if (!ok) return;
    lists[type].splice(idx, 1);
    await _saveMasterToSheet(el);
  }

  // カテゴリ専用の静かな保存（シート再読込・全体再描画なし）
  async function _saveCategoriesQuiet() {
    const customFlags = _master.customFlags || [];
    const maxRows = Math.max(_master.members.length, _master.categories.length, _master.paySources.length, customFlags.length, 1);
    const rows = [];
    for (let i = 0; i < maxRows; i++) {
      const m = _master.members[i]    || {};
      const c = _master.categories[i] || '';
      const p = _master.paySources[i] || '';
      const f = customFlags[i]        || '';
      rows.push([m.name || '', m.email || '', m.dept || '', m.role || '', '', p, c, f]);
    }
    await Sheets.update(`マスタ表!A2:H${rows.length + 1}`, rows);
    App.clearMasterCache();
  }

  async function _saveMasterToSheet(el) {
    const customFlags = _master.customFlags || [];
    const maxRows = Math.max(_master.members.length, _master.categories.length, _master.paySources.length, customFlags.length, 1);
    const rows = [];
    for (let i = 0; i < maxRows; i++) {
      const m = _master.members[i]    || {};
      const c = _master.categories[i] || '';
      const p = _master.paySources[i] || '';
      const f = customFlags[i]        || '';
      // A:氏名 B:メール C:所属 D:権限 E:備考 F:会社払い支払元 G:勘定科目 H:カスタムフラグ
      rows.push([m.name || '', m.email || '', m.dept || '', m.role || '', '', p, c, f]);
    }
    await Sheets.writeMaster(rows);
    App.showToast('保存しました', 'success');

    const syncCount = await _syncMemberNamesToExpenses(_master.members);
    if (syncCount > 0) App.showToast(`${syncCount}件の申請データの表示名を更新しました`, 'info');

    App.clearMasterCache();
    _master = await App.getMaster();
    _renderMembers(el);
    _renderCategoryList(el);
    _renderSimpleList(el, 'paySourceList',  _master.paySources,        'paySource');
    _renderSimpleList(el, 'customFlagList', _master.customFlags || [], 'customFlag');
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

  async function _openStripePortal() {
    const key = localStorage.getItem('keihi_license_key');
    if (!key) { App.showToast('ライセンスキーが設定されていません', 'danger'); return; }
    App.showLoading('ポータルを開いています...');
    try {
      const res = await fetch('/api/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const { url, error } = await res.json();
      if (!url) throw new Error(error || 'portal_error');
      window.location.href = url;
    } catch (err) {
      const msg = err.message === 'stripe_error'
        ? 'カスタマーポータルを開けませんでした。support@keihi-log.com までお問い合わせください。'
        : 'ポータルを開けませんでした: ' + err.message;
      App.showToast(msg, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _applyMemberPlanRestriction(el) {
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const result = _getCachedLicenseResult();
    // トライアル中は全機能（チーム機能含む）を解放 → ソロ制限はかけない
    const isSolo = !isDemo && result?.plan === 'solo' && result?.trial !== true;
    const btn  = el.querySelector('#btnAddMember');
    const hint = el.querySelector('#memberPlanHint');
    if (!btn) return;
    if (isSolo) {
      btn.disabled = true;
      btn.classList.replace('btn-outline-primary', 'btn-outline-secondary');
      hint?.classList.remove('d-none');
    } else {
      btn.disabled = false;
      btn.classList.replace('btn-outline-secondary', 'btn-outline-primary');
      hint?.classList.add('d-none');
    }
  }

  function _updateLicenseStatus(el, result) {
    const div = el.querySelector('#licenseStatus');
    if (!div) return;
    if (!result) {
      div.innerHTML = '<span class="text-muted small">ライセンス未確認</span>';
    } else if (result.valid) {
      div.innerHTML = `<span class="badge ${result.trial ? 'bg-warning text-dark' : 'bg-success'}"><i class="bi bi-check-circle me-1"></i>${result.trial ? 'トライアル中' : 'ライセンス有効'}</span>
        ${result.expiresAt ? `<span class="text-muted small ms-2">${result.trial ? 'トライアル期限' : '期限'}: ${result.expiresAt.split('T')[0]}</span>` : ''}
        ${(!result.trial && result.hasPortal) ? `<button class="btn btn-link btn-sm p-0 ms-2" style="font-size:0.78rem;" id="btnCustomerPortal">支払い・解約の管理</button>` : ''}`;
    } else {
      div.innerHTML = '<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>ライセンス無効</span>';
    }
    _updateTrialUpgradeBox(el, result);
    const portalBtn = el.querySelector('#btnCustomerPortal');
    if (portalBtn) {
      portalBtn.addEventListener('click', async () => {
        portalBtn.disabled = true;
        portalBtn.textContent = '読み込み中...';
        try {
          const key = localStorage.getItem('keihi_license_key') || '';
          const base = (window.APP_CONFIG?.apiBase || '');
          const resp = await fetch(`${base}/api/portal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
          });
          const data = await resp.json();
          if (data.url) {
            window.open(data.url, '_blank');
          } else {
            alert('ポータルURLの取得に失敗しました。しばらく後にお試しください。');
          }
        } catch (_) {
          alert('通信エラーが発生しました。しばらく後にお試しください。');
        } finally {
          portalBtn.disabled = false;
          portalBtn.textContent = '支払い・解約の管理';
        }
      });
    }
  }

  // トライアル中（または期限切れ）の管理者に「有料プランに登録する」ボタンを表示
  function _updateTrialUpgradeBox(el, result) {
    const box = el.querySelector('#trialUpgradeBox');
    if (!box) return;
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const isTrial = !isDemo && result && (result.trial === true || result.reason === 'expired');
    if (!isTrial || !App.isAdmin()) { box.style.display = 'none'; return; }
    const key   = localStorage.getItem('keihi_license_key') || '';
    const email = (typeof Auth !== 'undefined' && Auth.getUserEmail && Auth.getUserEmail()) || '';
    const planButtons = App.buildPlanChoiceButtons(key, email);
    if (!planButtons) { box.style.display = 'none'; return; }
    box.innerHTML = `
      <div class="alert alert-warning py-2 px-3 mb-0" style="font-size:0.83rem;">
        <div class="mb-2"><i class="bi bi-stars me-1"></i>${result.reason === 'expired'
          ? 'トライアル期間が終了しました。引き続きご利用いただくには、下のボタンからプランを選んで登録してください。'
          : `トライアル中です（ソロ・チーム問わず全機能をお試しいただけます）。<strong>2週間以内に下のボタンからソロまたはチームプランへ切り替えをお願いします。</strong>トライアル期間終了後は自動課金されません。`}</div>
        ${planButtons}
        <div class="text-muted mt-1" style="font-size:0.75rem;">どちらを選んでもライセンスキー・データ・設定はそのまま引き継がれます。</div>
      </div>`;
    box.style.display = '';
  }

  function _getCachedLicenseResult() {
    try { return JSON.parse(localStorage.getItem('keihi_license_cache') || 'null')?.result || null; }
    catch (_) { return null; }
  }

  function _escape(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
      ? `<div class="alert alert-success py-1 mb-2 small"><i class="bi bi-check-circle me-1"></i>確定済み（${_formatConfirmedAt(reg.confirmedAt)}）<button class="btn btn-link btn-sm p-0 ms-2 text-secondary" id="btnEditRegulationInit">再編集</button></div>`
      : '';
    return `
          <hr class="my-3">
          <div id="regulationSection">
          <div class="settings-step-title">訂正・削除防止規程（電帳法） <a href="/faq#q802" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></div>
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
          </div>
          </div>`;
  }

  function _regulationKey() {
    const ssId = localStorage.getItem('keihi_sheet_id') || '';
    return ssId ? `keihi_regulation_${ssId}` : 'keihi_regulation';
  }

  function _loadRegulation() {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return Demo.REGULATION;
    try { return JSON.parse(localStorage.getItem(_regulationKey()) || 'null'); }
    catch (_) { return null; }
  }

  function _formatConfirmedAt(val) {
    if (!val) return '';
    // ISO形式（2026-05-25T...）を日本語表記に変換
    const d = new Date(val);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
    return val; // すでに日本語形式の場合はそのまま
  }

  function _saveRegulation(data) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return;
    localStorage.setItem(_regulationKey(), JSON.stringify(data));
    // スプレッドシートにもバックアップ（失敗時は警告 - シートとlocalStorageの不整合を防ぐ）
    const ssId = localStorage.getItem('keihi_sheet_id');
    if (ssId) {
      Sheets.writeSetting('B6', JSON.stringify(data)).catch(() => {
        App.showToast('規程のバックアップ保存に失敗しました。再度「確定」を押してください。', 'warning');
      });
    }
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

制定日：${_formatConfirmedAt(reg.confirmedAt)}
所在地：${reg.address}
${reg.orgName}
代表者：${reg.repName}`;
  }

  // バックグラウンドinitがライセンス検証を完了した後に呼ばれる
  // キャッシュなしの最新結果でライセンス表示・メンバー制限を再適用する
  function refreshLicenseUI(licResult) {
    const el = document.getElementById('appMain');
    if (!el || !el.querySelector('#licenseStatus')) return;
    _updateLicenseStatus(el, licResult);
    _applyMemberPlanRestriction(el);
  }

  return { render, bindEvents, buildRegulationText, _loadRegulation, _formatConfirmedAt, refreshLicenseUI };
})();
