/**
 * 設定・管理ビュー（統合版）
 * 全ユーザー：ライセンス・スプレッドシート設定
 * 管理者のみ：会社名・Gemini APIキー・メンバー管理・勘定科目・支払元
 */
const SettingsView = (() => {

  let _master = null;
  let _templates = []; // 定期経費テンプレート（家賃・新聞代など口座振替の定額経費）
  let _lineLinkedSet = new Set(); // LINE連携済みの identity（メール/合成ID・小文字）

  function render() {
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const ssId   = isDemo ? Demo.SHEET_ID : (localStorage.getItem('keihi_sheet_id') || '');
    const licKey = isDemo ? 'KL-XXXXXXXXXXXXXXXXXXXX（デモ）' : (localStorage.getItem('keihi_license_key') || '');
    const email  = Auth.getUserEmail();
    const isAdmin = App.isAdmin();
    // 共有URL（経費ログWebアプリURL）を算出（初期設定の直上のセクションで使用）
    const _alias = isDemo ? '' : (localStorage.getItem('keihi_alias') || '');
    const _pathTok = location.pathname.match(/^\/([a-zA-Z0-9_-]{3,43})$/)?.[1];
    const _effAlias = (_pathTok && _pathTok !== 'app' && _pathTok !== 'faq') ? _pathTok : _alias;
    const shareUrl = _effAlias ? `${location.origin}/${_effAlias}` : (ssId ? `${location.origin}/${ssId}` : '');

    return `
<div class="pt-3">
  <h5 class="fw-bold mb-1"><i class="bi bi-gear-fill me-2 text-primary"></i>設定</h5>
  <div class="mb-3">
    <a href="/docs/admin-guide.pdf" download="経費ログ管理者ガイド.pdf" class="text-decoration-none" style="font-size:0.82rem;">
      <i class="bi bi-file-earmark-pdf me-1"></i>管理者ガイド（PDF）をダウンロード
    </a>
  </div>

  <!-- トライアル中のアップグレードボックス（app.jsが制御） -->
  <div id="trialUpgradeBox" class="mb-3" style="display:none;"></div>

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
      <!-- LINE証票保存の状態。連携コード発行モーダルの中だけだと誰も見ないため、
           普段見る設定タブ本体に出して、認証切れに気づけるようにする。 -->
      <div id="lineDriveStatusWrap" class="mt-2"></div>
    </div>
  </div>` : ''}

  <!-- 経費ログWebアプリURL（管理者・シート設定済み・初期設定の直上） -->
  ${isAdmin && ssId ? `
  <div class="card mb-3">
    <div class="card-body">
      <div class="settings-section-title">経費ログWebアプリURL</div>
      <div class="settings-step-hint mb-2">
        メンバー管理に氏名・メールアドレス・権限を登録してから、このURLをメンバーに連絡してください。
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
          <div class="settings-step-title d-flex align-items-center justify-content-between">
            <span>ライセンスキー <a href="/faq#q1001" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></span>
            ${licKey ? `<button class="btn btn-outline-secondary btn-sm py-0 px-2" id="btnRefreshLicense" title="プラン変更などを今すぐ反映" style="font-size:0.75rem;"><i class="bi bi-arrow-clockwise me-1"></i>更新</button>` : ''}
          </div>
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

          ${_renderRegulationInitStep()}

          ${isAdmin && ssId && !isDemo ? `
          <hr class="my-3">
          <div class="settings-step-title">プロキシ共有の再設定</div>
          <p style="font-size:0.82rem;color:#666;">セットアップ時に共有設定が失敗した場合はここで再実行できます。</p>
          <button class="btn btn-outline-secondary btn-sm" id="btnReShareSA">
            <i class="bi bi-arrow-repeat me-1"></i>サービスアカウントを再共有する
          </button>
          <div id="reShareMsg" class="mt-2" style="font-size:0.82rem;display:none;"></div>` : ''}
        ` : ''}

        </div>
      </div>
    </div>
  </div>


  <!-- フィードバック（常時表示） -->
  <div class="card mb-3">
    <div class="card-body text-center">
      <a href="https://forms.gle/wPBbW8aniDdoynXAA" target="_blank" rel="noopener" class="btn btn-outline-primary w-100">
        <i class="bi bi-megaphone me-1"></i>バグ報告・改善要望を送る
      </a>
      <div class="text-muted mt-1" style="font-size:0.75rem;">ご意見・不具合のご報告はこちらから。</div>
    </div>
  </div>

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
        <div id="soloExtraMemberWarn" class="d-none mt-2 alert alert-warning py-2 px-3 small mb-0">
          <i class="bi bi-exclamation-triangle me-1"></i>ソロプランでは<strong>オーナー以外のメンバーはご利用いただけません</strong>（ログインしても操作できません）。全員で使うにはチームプランに変更してください。
        </div>
      </div>
      <div id="memberList" class="mt-2">
        <div class="text-muted small text-center py-2">読み込み中...</div>
      </div>
    </div>
  </div>

  <!-- カスタムフラグ（管理者のみ・勘定科目の上） -->
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

  <!-- 定期経費テンプレート（管理者のみ・家賃/新聞代/通信費など口座振替の定額経費用）
       id は登録タブの「定期経費を登録」ポップアップからの導線でスクロール先に使う -->
  <div class="card mb-3" id="sectionTemplates">
    <div class="card-body">
      <div class="settings-section-title d-flex justify-content-between align-items-center">
        <span>定期経費テンプレート</span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddTemplate"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <p class="text-muted small mb-2">家賃・新聞代・通信費など、毎月定額で口座振替される経費のひな形です。登録タブから1クリックで今月分を作成できます（登録タブでの表示・利用は管理者のみです）。</p>
      <div class="small mb-2 p-2 rounded" style="background:#fff8e6;border:1px solid #f0dfa8;">
        <i class="bi bi-info-circle me-1 text-warning"></i>ここから登録した経費は<strong>「領収書なし」</strong>として登録されます。カード明細・通帳等の証拠が必要な場合は、登録後にご自身で証票を追加してください。<strong>同じ月に二重登録しないよう</strong>ご注意ください。
      </div>
      <div id="templateList" class="mt-2">
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
        <span>会社払い支払元 <a href="/faq#q107" class="text-muted ms-1" style="font-size:0.78rem;" title="FAQを見る"><i class="bi bi-question-circle"></i></a></span>
        <button class="btn btn-outline-primary btn-sm" id="btnAddPaySource"><i class="bi bi-plus me-1"></i>追加</button>
      </div>
      <div id="paySourceList" class="mt-2">
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

  <!-- 有料プラン：プラン変更・解約（app.jsが制御） -->
  <div id="portalSection"></div>


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

    // ライセンス情報を手動更新（キャッシュをクリアして再取得）。プラン変更等を即反映する。
    el.querySelector('#btnRefreshLicense')?.addEventListener('click', async () => {
      const key = localStorage.getItem('keihi_license_key');
      if (!key) return;
      const btn = el.querySelector('#btnRefreshLicense');
      const orig = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
      try {
        License.clearCache();
        const lic = await License.verify(key).catch(() => null);
        if (lic) {
          _updateLicenseStatus(el, lic);
          _applyMemberPlanRestriction(el);
        }
        App.showToast('ライセンス情報を更新しました', 'success');
      } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = orig; }
      }
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
        msg.innerHTML = `<span class="text-danger">${App.friendlyError(err)}</span>`;
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
    let _cfgB4 = ''; // readAllSettings で取得したフォルダID（後段の重複読み込み回避用）

    // まず localStorage キャッシュで即時表示（API 待ちなし）
    const _applySettingsToUI = (companyName, geminiKey, carRate, folderId) => {
      if (companyName) { const inp = el.querySelector('#inputCompanyName'); if (inp) inp.value = companyName; }
      if (geminiKey)   { const inp = el.querySelector('#inputGeminiKey');   if (inp) inp.value = geminiKey; }
      { const inp = el.querySelector('#inputCarRate'); if (inp) inp.value = carRate || '20'; }
      if (folderId)    { _cfgB4 = folderId; }
    };
    _applySettingsToUI(
      isDemo ? Demo.COMPANY_NAME : localStorage.getItem('keihi_company_name'),
      localStorage.getItem('keihi_gemini_key'),
      localStorage.getItem('keihi_car_rate'),
      localStorage.getItem('keihi_folder_id'),
    );

    // バックグラウンドで最新値を取得・反映（await しない → 画面表示をブロックしない）
    if (!opts.fromCache && !isDemo && ssId) {
      Sheets.readAllSettings().then(cfg => {
        _applySettingsToUI(cfg.B2, cfg.B5, cfg.B7, cfg.B4);
        if (cfg.B2) localStorage.setItem('keihi_company_name', cfg.B2);
        if (cfg.B5) localStorage.setItem('keihi_gemini_key', cfg.B5);
        if (cfg.B7) localStorage.setItem('keihi_car_rate', cfg.B7);
        if (cfg.B4) localStorage.setItem('keihi_folder_id', cfg.B4);
        // フォルダリンクも更新
        if (cfg.B4) _setFolderLink?.(cfg.B4);
      }).catch(() => {
        const geminiMsg = el.querySelector('#geminiKeyMsg');
        if (geminiMsg && !el.querySelector('#inputGeminiKey')?.value) {
          geminiMsg.innerHTML = '<span class="text-warning small"><i class="bi bi-exclamation-triangle me-1"></i>読み込みに失敗しました。キーを再入力して保存してください</span>';
        }
      });
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
        document.title = name ? `経費ログ | ${name}` : '経費ログ';
      } catch (err) {
        msg.innerHTML = `<span class="text-danger">${App.friendlyError(err)}</span>`;
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
        msg.innerHTML = `<span class="text-danger">${App.friendlyError(err)}</span>`;
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
        msg.innerHTML = `<span class="text-danger">${App.friendlyError(err)}</span>`;
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
        _loadTemplates(el);
      }
    } catch (err) {
      if (!opts.fromCache) App.showToast('マスタデータの読み込みに失敗しました', 'danger');
    }

    _applyMemberPlanRestriction(el);
    _loadLineLinks(el);   // LINE接続状態を取得してメンバー表示を更新
    el.querySelector('#memberList')?.addEventListener('click', e => {
      const edit = e.target.closest('.btn-edit-member');
      const del  = e.target.closest('.btn-del-member');
      const line = e.target.closest('.btn-line-code');
      if (edit) _showMemberForm(el, Number(edit.dataset.index));
      if (del)  _deleteMember(el, Number(del.dataset.index));
      // ソロプランではLINEボタンを「押せる広告」にしてある（無効化すると
      // 灰色のアイコンが並ぶだけで、機能の存在が誰にも伝わらないため）。
      if (line) {
        if (line.dataset.upsell === '1') _showLineUpsell();
        else _issueLineCode(el, Number(line.dataset.index));
      }
      const unlink = e.target.closest('.badge-line-unlink');
      if (unlink) _unlinkLineMember(el, Number(unlink.dataset.index));
    });
    ['#categoryList', '#paySourceList', '#customFlagList'].forEach(sel => {
      el.querySelector(sel)?.addEventListener('click', e => {
        const btn = e.target.closest('.btn-del-item');
        if (btn) return _deleteSimpleItem(el, btn.dataset.type, Number(btn.dataset.index));
        const edit = e.target.closest('.btn-edit-item');
        if (edit) _renamePaySource(el, Number(edit.dataset.index));
      });
    });
    el.querySelector('#btnAddMember')?.addEventListener('click', () => _showMemberForm(el, null));
    // ソロ→チームのアップグレードはポータルのプラン変更（既存サブスクを日割りで変更）を使う。
    // 以前は新規チェックアウト（Payment Link）を開いており、別サブスクが作られて
    // 当該期間にソロ料金と重なる実質二重請求が発生していたため修正。
    el.querySelector('#btnUpgradePlan')?.addEventListener('click', () => _openStripePortal('update'));
    el.querySelector('#btnAddCategory')?.addEventListener('click', () => _showInlineAdd(el, 'category'));
    el.querySelector('#btnAddPaySource')?.addEventListener('click', () => _showInlineAdd(el, 'paySource'));
    el.querySelector('#btnAddCustomFlag')?.addEventListener('click', () => _showInlineAdd(el, 'customFlag'));
    el.querySelector('#btnAddTemplate')?.addEventListener('click', () => _showTemplateForm(el, null));
    el.querySelector('#templateList')?.addEventListener('click', e => {
      const editBtn = e.target.closest('.btn-edit-template');
      const delBtn = e.target.closest('.btn-del-template');
      if (editBtn) _showTemplateForm(el, _templates.find(t => t.id === editBtn.dataset.id));
      if (delBtn) _deleteTemplateItem(el, delBtn.dataset.id);
    });

    // 証票フォルダ：フォルダを開くリンクを生成（ssId設定済み・デモ以外のみ）
    // B4 は readAllSettings で取得済みのため追加のAPIコールはしない
    // （fromCache かつ localStorage 未保存の場合のみフォールバックで1回読む）
    const currentFolderId = isDemo ? ''
      : (localStorage.getItem('keihi_folder_id') || _cfgB4
         || (opts.fromCache ? await Sheets.readSetting('B4').catch(() => '') : ''));
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

    // LINE証票保存の状態を設定タブ本体に表示（認証切れを普段の画面で気づけるように）
    _loadLineDriveStatus(el);

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
        msg.innerHTML = `<span class="text-danger">${App.friendlyError(err)}</span>`;
      }
    });

    // ヘッダー色：localStorageから読み込み
    const colorInput = el.querySelector('#inputHeaderColor');
    if (colorInput) {
      const saved = localStorage.getItem(_navColorKey());
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
      localStorage.setItem(_navColorKey(), color);
      _applyNavColor(color);
      msg.innerHTML = '<span class="text-success"><i class="bi bi-check-circle me-1"></i>適用しました</span>';
      App.showToast('ヘッダーカラーを変更しました', 'success');
      setTimeout(() => { msg.innerHTML = ''; }, 3000);
    });

    // ポータル・新規契約ボタンは innerHTML で動的に生成されるため、
    // addEventListener では再描画後にリスナーが失われる。el への委譲で常に確実に動作させる。
    el.addEventListener('click', e => {
      if (e.target.closest('#btnChangePlan')) {
        _openStripePortal('update');   // プラン変更画面へ直行
      } else if (e.target.closest('#btnCancelPlan')) {
        _openStripePortal('cancel');   // 解約画面へ直行
      } else if (e.target.closest('#btnManagePortal')) {
        _openStripePortal();           // ポータルトップ（解約取り消し・プラン管理）
      }
    });
  }

  function _navColorKey() {
    const ssId = localStorage.getItem('keihi_sheet_id');
    return ssId ? `keihi_nav_color_${ssId}` : 'keihi_nav_color';
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
      // LINE専用メンバー（メールなし・合成ID）は生IDを見せず「LINE専用」と表示
      const isLineOnly = String(m.email || '').startsWith('line:');
      const isConnected = _lineLinkedSet.has(String(m.email || '').toLowerCase());
      // ① Googleのみ・未接続 → LINEボタン表示 / ② Google+接続済 → 「LINE接続済」バッジ / ③ LINE専用 → 接続済/未接続でバッジを出し分け
      // 接続済バッジはタップで連携解除の確認を出す（ボタンを増やして画面を busy に
      // しないための設計。誤タップは必ず確認ダイアログで止める）。
      const _unlinkBadge = (label) =>
        `<span class="badge ms-1 badge-line-unlink" role="button" tabindex="0" data-index="${i}"
           style="font-size:0.6rem;background:#06C755;cursor:pointer;"
           title="タップでLINE連携を解除">${label} <i class="bi bi-x" style="opacity:.75;"></i></span>`;
      const idLabel = isLineOnly
        ? (isConnected
            ? _unlinkBadge('<i class="bi bi-check-circle-fill me-1"></i>LINE専用・接続済')
            : '<span class="badge ms-1" style="font-size:0.6rem;background:#adb5bd;"><i class="bi bi-hourglass-split me-1"></i>LINE専用・未接続</span>')
        : _escape(m.email);
      const connectedBadge = (!isLineOnly && isConnected)
        ? _unlinkBadge('LINE接続済')
        : '';
      const lineBtn = (!isLineOnly && !isConnected)
        ? `<button class="btn btn-sm btn-line-code flex-shrink-0 p-0 border-0 d-inline-flex align-items-center" data-index="${i}" title="このメンバーのLINE連携を設定"><img src="/img/LINE_Brand_icon.png" width="31" height="31" alt="LINE" style="display:block;"></button>`
        : '';
      return `
      <div class="d-flex align-items-center gap-2 py-2 border-bottom">
        <div class="flex-grow-1">
          <div class="master-item-name">${_escape(m.name)}</div>
          <div class="text-muted" style="font-size:0.72rem;">${idLabel}${m.dept ? ' / ' + _escape(m.dept) : ''}
            ${roleBadge}${connectedBadge}
          </div>
        </div>
        ${lineBtn}
        <button class="btn btn-outline-secondary btn-sm btn-edit-member" data-index="${i}" title="編集"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-outline-danger btn-sm btn-del-member" data-index="${i}"><i class="bi bi-trash"></i></button>
      </div>`;
    }).join('');
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

  /** LINE連携を解除（接続済バッジのタップから）。誤操作防止のため必ず確認を挟む。 */
  async function _unlinkLineMember(el, idx) {
    const m = _master?.members?.[idx];
    if (!m) return;
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      App.showToast('デモモードでは解除できません', 'info');
      return;
    }
    const isLineOnly = String(m.email || '').startsWith('line:');
    const ok = await App.confirm(
      `${m.name} さんのLINE連携を解除しますか？\n\n` +
      `解除するとLINEからの申請ができなくなります。` +
      (isLineOnly ? '\n（LINE専用メンバーのため、解除すると申請手段がなくなります）' : '') +
      `\n連携コードを再発行すれば、いつでも再連携できます。`
    );
    if (!ok) return;
    try {
      await Sheets.unlinkLine({ identity: m.email || '' });
      App.showToast(`${m.name} さんのLINE連携を解除しました`, 'success');
      _loadLineLinks(el);   // バッジ表示を更新（未接続に戻る）
    } catch (err) {
      App.showToast('解除に失敗しました。' + App.friendlyError(err), 'danger');
    }
  }

  /** LINE連携済みの identity 一覧を取得し、メンバー表示（接続済み判定）を更新する。 */
  async function _loadLineLinks(el) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) return;
    try {
      const r = await Sheets.getLineLinks();
      _lineLinkedSet = new Set((r.identities || []).map(s => String(s).toLowerCase()));
      _renderMembers(el);              // 接続状態を反映して再描画
      _applyMemberPlanRestriction(el); // 新しいボタンにプラン制限を再適用
    } catch (_) { /* 取得失敗時は未接続扱いのまま（ボタン表示） */ }
  }

  function _renderSimpleList(el, containerId, items, type) {
    const container = el.querySelector(`#${containerId}`);
    if (!container) return;
    if (!items?.length) { container.innerHTML = '<div class="text-muted small">登録がありません</div>'; return; }
    // 支払元は銀行名の変更などで改名が起きるため、削除だけでなく編集も用意する
    const canRename = type === 'paySource';
    container.innerHTML = items.map((item, i) => `
      <div class="d-flex align-items-center gap-2 py-1 border-bottom">
        <span class="flex-grow-1 master-item-name">${_escape(item)}</span>
        ${canRename ? `<button class="btn btn-outline-secondary btn-sm btn-edit-item" data-type="${type}" data-index="${i}" title="名称を変更">
          <i class="bi bi-pencil"></i>
        </button>` : ''}
        <button class="btn btn-outline-danger btn-sm btn-del-item" data-type="${type}" data-index="${i}">
          <i class="bi bi-trash"></i>
        </button>
      </div>`).join('');
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

  }

  /** LINE専用メンバー用の合成ID（line: + 12桁hex）。既存と衝突しないものを返す。 */
  function _genSynthId() {
    const existing = new Set((_master.members || []).map(m => String(m.email || '').toLowerCase()));
    for (let attempt = 0; attempt < 20; attempt++) {
      const hex = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
      const id = 'line:' + hex;
      if (!existing.has(id)) return id;
    }
    return 'line:' + Date.now().toString(16).slice(-12);
  }

  function _showMemberForm(el, idx) {
    const m = idx !== null ? _master.members[idx] : { name: '', email: '', dept: '', role: '' };
    const isNew = idx === null;
    const mRole = (m.role || '').toLowerCase();
    const isLineOnly = String(m.email || '').startsWith('line:');
    const currentEmail = (Auth.getUserEmail() || '').toLowerCase();
    const adminCount = _master.members.filter(m2 => (m2.role || '').toLowerCase() === 'admin').length;
    const isLastAdminSelf = !isNew && mRole === 'admin' && adminCount <= 1 && m.email?.toLowerCase() === currentEmail;
    // LINE連携はチームプラン限定
    const _lic = _getCachedLicenseResult();
    const isDemoNow = typeof Demo !== 'undefined' && Demo.isActive();
    const lineAvailable = isDemoNow || !!(_lic && _lic.plan !== 'solo');

    // メールアドレス欄：新規は編集可、既存は変更不可（申請の紐付けが壊れるため）。
    // LINE専用メンバー（合成ID）は生IDを見せず「LINE専用」と表示。
    const emailField = isLineOnly
      ? `<input type="text" class="form-control form-control-sm bg-light" value="LINE専用メンバー（Googleアカウントなし）" readonly>
         <div class="form-text"><i class="bi bi-chat-dots me-1 text-success"></i>このメンバーはLINEでのみ経費を登録します</div>`
      : `<input type="email" class="form-control form-control-sm" id="mEmail" value="${_escape(m.email)}" ${!isNew ? 'readonly' : ''}
             placeholder="${isNew ? '例）name@gmail.com（LINEだけで使う人は空欄）' : ''}">
         <div class="form-text"><i class="bi bi-google me-1 text-primary"></i>Googleアカウントのメール（Gmail・Google Workspace）。${isNew ? '<strong>空欄にするとLINE専用メンバー</strong>として登録します。' : ''}</div>`;

    // LINE連携セクション
    let lineSectionHtml = '';
    if (!lineAvailable) {
      lineSectionHtml = `<div class="mt-3 pt-2 border-top">
        <div class="text-muted small"><i class="bi bi-info-circle me-1"></i>LINE連携はチームプランでご利用いただけます</div></div>`;
    } else if (isNew) {
      lineSectionHtml = `<div class="mt-3 pt-2 border-top">
        <div class="form-label small mb-1"><i class="bi bi-chat-dots me-1 text-success"></i>LINE連携</div>
        <div class="text-muted small">保存すると、このメンバーのLINE連携コードを発行できます。</div></div>`;
    } else {
      // 連携済みかどうかで文言を変える。コードは「別のLINEアカウントへの付け替え」に
      // なるため（1メンバー=1アカウント）、その旨を明示してから発行させる。
      const _isLinked = _lineLinkedSet.has(String(m.email || '').toLowerCase());
      lineSectionHtml = `<div class="mt-3 pt-2 border-top">
        <div class="form-label small mb-1"><i class="bi bi-chat-dots me-1 text-success"></i>LINE連携
          ${_isLinked ? '<span class="badge ms-1" style="font-size:0.6rem;background:#06C755;"><i class="bi bi-check-circle-fill me-1"></i>連携済</span>' : ''}
        </div>
        <div class="text-muted small mb-2">
          ${_isLinked
            ? '既にLINEと連携済みです。1人のメンバーに連携できるLINEアカウントは1つだけのため、<strong>新しいコードで連携すると現在の連携は解除されます</strong>（機種変更などの場合にご利用ください）。'
            : (isLineOnly ? 'LINEでコードを送信すると連携が完了します。' : 'このGoogleアカウントのメンバーは、LINEも併用できます（Web申請とLINE申請が同じ人に集約されます）。')}
        </div>
        <button type="button" class="btn btn-outline-${_isLinked ? 'secondary' : 'success'} btn-sm w-100" id="btnFormLineCode">
          <i class="bi bi-chat-dots me-1"></i>${_isLinked ? 'LINE連携コードを再発行（付け替え）' : 'LINE連携コードを発行'}
        </button></div>`;
    }

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
              <div class="mb-2"><label class="form-label small">メールアドレス${isNew ? '（任意）' : ''}</label>
                ${emailField}
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
                <div class="form-text ${isLineOnly ? '' : 'd-none'}" id="roleLineHint"><i class="bi bi-info-circle me-1"></i>LINE専用メンバー（メールなし）は一般権限のみです（Web管理はできません）。</div>
              </div>
              ${lineSectionHtml}
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

    // 権限ロック：LINE専用（メールなし）は一般権限のみ。新規はメール欄の入力に追従。
    const _emailInput = div.querySelector('#mEmail');
    const _roleSelect = div.querySelector('#mRole');
    const _roleHint   = div.querySelector('#roleLineHint');
    function _syncRoleLock() {
      if (isLastAdminSelf) return; // 唯一管理者ロックが優先
      const noEmail = isLineOnly || (isNew && !(_emailInput?.value || '').trim());
      if (_roleSelect) {
        _roleSelect.disabled = noEmail;
        if (noEmail) _roleSelect.value = ''; // 一般に固定
      }
      _roleHint?.classList.toggle('d-none', !noEmail);
    }
    _emailInput?.addEventListener('input', _syncRoleLock);
    _syncRoleLock();

    // フォーム内のLINE連携コード発行（既存メンバーのみ）
    div.querySelector('#btnFormLineCode')?.addEventListener('click', () => {
      modal.hide();
      _issueLineCode(el, idx);
    });

    let _saving = false; // 二重送信防止（保存ボタン連打で同じ人が重複登録されるのを防ぐ）
    div.querySelector('#btnSaveMember').addEventListener('click', async () => {
      if (_saving) return;
      const saveBtn = div.querySelector('#btnSaveMember');
      // 既存メンバーのメールは変更不可（readonly）→ 元の値を維持。新規のみ入力値を採用。
      let email;
      if (!isNew) {
        email = m.email || '';
      } else {
        email = (div.querySelector('#mEmail')?.value || '').trim();
        if (email) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return App.showToast('有効なメールアドレスを入力してください', 'danger');
          const lc = email.toLowerCase();
          if (_master.members.some((mm, i) => i !== idx && (mm.email || '').toLowerCase() === lc))
            return App.showToast('このメールアドレスは既に登録されています', 'danger');
        } else {
          // 空欄 → LINE専用メンバー（合成IDを付与）
          email = _genSynthId();
        }
      }
      const updated = {
        name:  div.querySelector('#mName').value.trim(),
        email,
        dept:  div.querySelector('#mDept').value.trim(),
        role:  div.querySelector('#mRole').value,
      };
      if (!updated.name) return App.showToast('氏名は必須です', 'danger');
      // LINE専用（メールなし・合成ID）は必ず一般権限（Web管理不可のため）
      if (String(email).startsWith('line:')) updated.role = '';
      if (isLastAdminSelf) updated.role = 'admin';
      if (!isNew && !String(email).startsWith('line:') &&
          ((_master.members[idx]?.role || '').toLowerCase() === 'admin') && updated.role !== 'admin') {
        const cnt = _master.members.filter(m => (m.role || '').toLowerCase() === 'admin').length;
        if (cnt <= 1) {
          App.showToast('管理者が1人のため降格できません。先に他のメンバーを管理者に設定してください。', 'danger');
          return;
        }
      }
      const wasLineOnlyNew = isNew && String(email).startsWith('line:');
      _saving = true;
      if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>保存中...'; }
      try {
        if (isNew) _master.members.push(updated);
        else       _master.members[idx] = updated;
        await _saveMasterToSheet(el);
        modal.hide();
        // 新規LINE専用メンバーは保存直後に連携コードを発行して手間を省く
        if (wasLineOnlyNew && lineAvailable) {
          const newIdx = _master.members.findIndex(mm => mm.email === email);
          if (newIdx >= 0) setTimeout(() => _issueLineCode(el, newIdx), 350);
        }
      } catch (err) {
        // 保存失敗時は楽観的に追加した行を巻き戻して再試行可能にする
        if (isNew) _master.members = _master.members.filter(m => m !== updated);
        _saving = false;
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
        App.showToast('保存に失敗しました: ' + (err?.message || ''), 'danger');
      }
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
      App.showToast('メンバーの削除に失敗しました。' + App.friendlyError(err), 'danger');
      _master.members.splice(idx, 0, member); // ロールバック
      _renderMembers(el);
    }
  }

  /**
   * 会社払い支払元の名称を変更する（銀行名の変更などを想定）。
   *
   * 支払元は各経費のL列に「会社払い（名称）」という文字列で保存され、集計も
   * その文字列でグループ化する。そのためマスタだけ変えると過去分が旧名称のまま
   * 残り、集計表が新旧2行に割れる。既定では過去分もあわせて置き換える。
   */
  async function _renamePaySource(el, idx) {
    const cur = _master.paySources?.[idx];
    if (!cur) return;

    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h6 class="modal-title">支払元の名称を変更</h6>
              <button class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2">
                <label class="form-label small">変更前</label>
                <input type="text" class="form-control form-control-sm" value="${_escape(cur)}" disabled>
              </div>
              <div class="mb-3">
                <label class="form-label small">変更後</label>
                <input type="text" class="form-control form-control-sm" id="psNew" value="${_escape(cur)}" maxlength="50">
              </div>
              <div class="form-check">
                <input class="form-check-input" type="checkbox" id="psPast" checked>
                <label class="form-check-label small" for="psPast">
                  過去に登録した経費の表記もあわせて変更する
                </label>
              </div>
              <div class="small text-muted mt-2" style="line-height:1.8;">
                変更しない場合、過去分は「${_escape(cur)}」のまま残り、集計表が新旧の2行に分かれます。<br>
                同じ支払元の呼び名が変わった場合（銀行名の変更など）は、変更することをおすすめします。
                金額・日付などその他の内容は一切変更されません。
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button class="btn btn-primary btn-sm" id="btnSavePs">変更する</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);
    const modal = new bootstrap.Modal(div.querySelector('.modal'));
    modal.show();
    div.querySelector('.modal').addEventListener('hidden.bs.modal', () => div.remove());

    let saving = false;
    div.querySelector('#btnSavePs').addEventListener('click', async () => {
      if (saving) return;
      const next = div.querySelector('#psNew').value.trim();
      if (!next) return App.showToast('名称を入力してください', 'danger');
      if (next === cur) { modal.hide(); return; }
      if (_master.paySources.some((p, i) => i !== idx && p === next)) {
        return App.showToast('同じ名称の支払元がすでにあります', 'danger');
      }
      const alsoPast = div.querySelector('#psPast').checked;

      saving = true;
      App.showLoading('変更中...');
      try {
        // 先に過去分を置き換える。マスタだけ先に変えると、失敗時に
        // 新旧の名称が混在したまま参照先を失うため。
        let updated = 0;
        if (alsoPast) {
          const r = await Sheets.renamePaySource(cur, next);
          updated = r?.updated || 0;
        }
        _master.paySources[idx] = next;
        await _saveMasterToSheet(el);
        App.clearExpensesCache?.();
        modal.hide();
        App.hideLoading();
        App.showToast(alsoPast ? `変更しました（過去の経費 ${updated}件も更新）` : '変更しました', 'success');
      } catch (err) {
        App.hideLoading();
        App.showToast('変更に失敗しました。' + App.friendlyError(err), 'danger');
      } finally {
        saving = false;
      }
    });
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

  /** 定期経費テンプレート一覧を取得して描画する。 */
  async function _loadTemplates(el) {
    const list = el.querySelector('#templateList');
    if (!list) return;
    try {
      const resp = await Sheets.getTemplates();
      _templates = resp.templates || [];
      _renderTemplateList(el);
    } catch (err) {
      list.innerHTML = `<div class="text-danger small text-center py-2">${App.friendlyError(err)}</div>`;
    }
  }

  function _renderTemplateList(el) {
    const list = el.querySelector('#templateList');
    if (!list) return;
    if (_templates.length === 0) {
      list.innerHTML = '<div class="text-muted small text-center py-2">登録がありません</div>';
      return;
    }
    list.innerHTML = _templates.map(t => `
      <div class="d-flex align-items-center justify-content-between py-2 border-bottom">
        <div>
          <div class="fw-semibold small">${_escape(t.payee)}</div>
          <div class="text-muted small">¥${Number(t.amount).toLocaleString('ja-JP')}${t.category ? ' ・ ' + _escape(t.category) : ''}</div>
          <div class="small">${t.corpPay
            ? `<span class="badge bg-secondary-subtle text-secondary-emphasis"><i class="bi bi-building me-1"></i>会社払い（${_escape(t.paySource)}）</span>`
            : `<span class="badge bg-primary-subtle text-primary-emphasis"><i class="bi bi-person-fill me-1"></i>自分が立替</span>`}</div>
        </div>
        <div class="d-flex gap-1">
          <button class="btn btn-outline-secondary btn-sm btn-edit-template" data-id="${_escape(t.id)}"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-outline-danger btn-sm btn-del-template" data-id="${_escape(t.id)}"><i class="bi bi-trash"></i></button>
        </div>
      </div>`).join('');
  }

  function _showTemplateForm(el, tpl) {
    const isNew = !tpl;
    const t = tpl || { id: '', payee: '', amount: '', category: '', note: '', corpPay: false, paySource: '' };
    const categoryOptions = (_master?.categories || [])
      .map(c => `<option value="${_escape(c)}" ${c === t.category ? 'selected' : ''}>${_escape(c)}</option>`).join('');
    const paySourceOptions = (_master?.paySources || [])
      .map(p => `<option value="${_escape(p)}" ${p === t.paySource ? 'selected' : ''}>${_escape(p)}</option>`).join('');
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h6 class="modal-title">${isNew ? '定期経費テンプレート追加' : 'テンプレート編集'}</h6>
              <button class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-2"><label class="form-label small">支払先</label>
                <input type="text" class="form-control form-control-sm" id="tPayee" value="${_escape(t.payee)}" placeholder="例）〇〇不動産（家賃）"></div>
              <div class="mb-2"><label class="form-label small">金額</label>
                <input type="number" class="form-control form-control-sm" id="tAmount" value="${t.amount || ''}" min="1"></div>
              <div class="mb-2"><label class="form-label small">勘定科目</label>
                <select class="form-select form-select-sm" id="tCategory">
                  <option value="">未選択</option>${categoryOptions}
                </select></div>
              <div class="mb-2"><label class="form-label small">備考（任意）</label>
                <input type="text" class="form-control form-control-sm" id="tNote" value="${_escape(t.note)}" placeholder="例）毎月27日引落"></div>
              <div class="mb-2">
                <label class="form-label small d-block mb-1">支払い方法</label>
                <div class="pay-segment" id="tPaySeg">
                  <button type="button" class="pay-seg-btn ${!t.corpPay ? 'active' : ''}" id="tPaySelf"><i class="bi bi-person-fill"></i>自分が立替（精算あり）</button>
                  <button type="button" class="pay-seg-btn ${t.corpPay ? 'active' : ''}" id="tPayCorp"><i class="bi bi-building"></i>会社払い（精算なし）</button>
                </div>
                <div id="tPaySourceWrap" class="mt-2 ${t.corpPay ? '' : 'd-none'}">
                  <select class="form-select form-select-sm" id="tPaySource">
                    <option value="">支払元を選択</option>${paySourceOptions}
                  </select>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn btn-secondary btn-sm" data-bs-dismiss="modal">キャンセル</button>
              <button class="btn btn-primary btn-sm" id="btnSaveTemplate">保存</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);
    const modal = new bootstrap.Modal(div.querySelector('.modal'));
    modal.show();
    div.querySelector('.modal').addEventListener('hidden.bs.modal', () => div.remove());

    div.querySelector('#tPaySelf').addEventListener('click', () => {
      div.querySelector('#tPaySelf').classList.add('active');
      div.querySelector('#tPayCorp').classList.remove('active');
      div.querySelector('#tPaySourceWrap').classList.add('d-none');
    });
    div.querySelector('#tPayCorp').addEventListener('click', () => {
      div.querySelector('#tPayCorp').classList.add('active');
      div.querySelector('#tPaySelf').classList.remove('active');
      div.querySelector('#tPaySourceWrap').classList.remove('d-none');
    });

    let _saving = false;
    div.querySelector('#btnSaveTemplate').addEventListener('click', async () => {
      if (_saving) return;
      const payee = div.querySelector('#tPayee').value.trim();
      const amount = Number(div.querySelector('#tAmount').value);
      if (!payee) return App.showToast('支払先は必須です', 'danger');
      if (!amount || amount <= 0) return App.showToast('金額を正しく入力してください', 'danger');
      const corpPay = div.querySelector('#tPayCorp').classList.contains('active');
      const paySource = corpPay ? div.querySelector('#tPaySource').value : '';
      if (corpPay && !paySource) return App.showToast('会社払いの支払元を選択してください', 'danger');
      const body = {
        payee, amount,
        category: div.querySelector('#tCategory').value,
        note: div.querySelector('#tNote').value.trim(),
        corpPay, paySource,
      };
      _saving = true;
      try {
        if (isNew) await Sheets.createTemplate(body);
        else await Sheets.editTemplate(t.id, body);
        modal.hide();
        App.showToast('保存しました', 'success');
        await _loadTemplates(el);
      } catch (err) {
        App.showToast('保存に失敗しました。' + App.friendlyError(err), 'danger');
      } finally {
        _saving = false;
      }
    });
  }

  async function _deleteTemplateItem(el, id) {
    const t = _templates.find(x => x.id === id);
    if (!t) return;
    const ok = await App.confirm(`「${t.payee}」を削除しますか？`);
    if (!ok) return;
    try {
      await Sheets.deleteTemplate(id);
      await _loadTemplates(el);
    } catch (err) {
      App.showToast('削除に失敗しました。' + App.friendlyError(err), 'danger');
    }
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
    await App.reloadMaster(); // 自分のロール変更を検知して設定タブ表示を再評価
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

  async function _openStripePortal(flow) {
    const key = localStorage.getItem('keihi_license_key');
    if (!key) { App.showToast('ライセンスキーが設定されていません', 'danger'); return; }
    // 別タブでポータルを開くと元タブのライセンスキャッシュが古いままになるため、
    // タブに戻った時に再取得できるよう「ポータルを開いた」フラグを立てる。
    try { sessionStorage.setItem('keihi_portal_opened', String(Date.now())); } catch (_) {}
    // ユーザー操作直後に空タブを先に開く（非同期fetch後の window.open はポップアップ
    // ブロックされやすいため）。URL確定後にそのタブへ遷移させる。
    const portalWin = window.open('', '_blank');
    App.showLoading(flow === 'cancel' ? '解約画面を開いています...' : 'プラン画面を開いています...');
    try {
      const res = await fetch('/api/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, flow }),
      });
      const json = await res.json();
      const { url, error, message: serverMsg } = json;
      if (!url) throw Object.assign(new Error(error || 'portal_error'), { serverMsg });
      if (portalWin) portalWin.location.href = url;  // 別タブで開く
      else window.location.href = url;               // ブロックされた場合は同タブ遷移
    } catch (err) {
      try { portalWin?.close(); } catch (_) {}        // 失敗時は空タブを閉じる
      // 真因切り分けのためサーバーの詳細メッセージはコンソールへ
      if (err.serverMsg) console.error('[portal]', err.message, '-', err.serverMsg);
      // 恒久的なエラー（待っても直らない）はサポート誘導する。
      // 「しばらく待って再試行」は 429(レート制限)/ネットワーク等の一時エラーにのみ使う。
      const persistent = ['portal_not_configured', 'stripe_error', 'no_customer', 'no_session', 'not_found'];
      let msg;
      if (err.message === 'trial_user') {
        msg = 'トライアル中はポータルを利用できません。有料プランへ切り替えてからご利用ください。';
      } else if (persistent.includes(err.message)) {
        msg = `カスタマーポータルを開けませんでした（${err.message}${err.serverMsg ? ': ' + err.serverMsg : ''}）。お手数ですが support@keihi-log.com までご連絡ください（解約・プラン変更はこちらから承ります）。`;
      } else {
        msg = 'ポータルを開けませんでした。通信状況をご確認のうえ、しばらくしてから再試行してください。';
      }
      App.showToast(msg, 'danger');
    } finally {
      App.hideLoading();
    }
  }

  function _applyMemberPlanRestriction(el) {
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const result = _getCachedLicenseResult();
    // APIがトライアル中は plan:'team' を返すため、単純に plan === 'solo' で判定する
    const isSolo = !isDemo && result?.plan === 'solo';
    const btn  = el.querySelector('#btnAddMember');
    const hint = el.querySelector('#memberPlanHint');
    if (!btn) return;
    const warn = el.querySelector('#soloExtraMemberWarn');
    if (isSolo) {
      btn.disabled = true;
      btn.classList.replace('btn-outline-primary', 'btn-outline-secondary');
      hint?.classList.remove('d-none');
      // オーナー以外の余剰メンバーが残っている場合（トライアル中に追加など）は警告を出す
      const extra = (_master?.members?.length || 0) > 1;
      warn?.classList.toggle('d-none', !extra);
    } else {
      btn.disabled = false;
      btn.classList.replace('btn-outline-secondary', 'btn-outline-primary');
      hint?.classList.add('d-none');
      warn?.classList.add('d-none');
    }
    // LINE連携はチームプラン限定。ソロではLINE関連の表示を丸ごと消す。
    // 連携レコードはチーム→ソロに変えても消えないため、放置すると
    // 使えないのに「LINE接続済」バッジや証票保存の案内だけが残る。
    const driveWrap = el.querySelector('#lineDriveStatusWrap');
    if (isSolo) {
      if (driveWrap) driveWrap.innerHTML = '';
      if (_lineLinkedSet.size) { _lineLinkedSet = new Set(); _renderMembers(el); }
    } else if (driveWrap && !driveWrap.innerHTML) {
      _loadLineDriveStatus(el);
    }
    // 再描画後のボタンにも効かせるため最後に適用する。
    // ソロでも disabled にはしない：押せて理由が出るほうがアップグレードの動機になる。
    el.querySelectorAll('.btn-line-code').forEach(b => {
      b.dataset.upsell = isSolo ? '1' : '';
      b.classList.toggle('line-btn-locked', isSolo);
      b.title = isSolo ? 'LINE連携はチームプランの機能です' : 'このメンバーのLINE連携を設定';
    });
  }

  /** ソロプランでLINEボタンを押したときの案内（チームプランへの導線）。 */
  function _showLineUpsell() {
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-chat-dots-fill me-2" style="color:#06C755;"></i>LINEで領収書を送るだけ</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p class="small mb-3">経費ログの公式LINEに<strong>領収書の写真を送るだけ</strong>で、AIが日付・金額・支払先を読み取って
              経費として登録します。アプリを開く必要はありません。</p>
              <ul class="small mb-3 ps-3">
                <li>撮って送るだけ。入力はAIにおまかせ</li>
                <li>「未精算」「履歴」と送れば、その場で確認できる</li>
                <li>証票画像もGoogleドライブに自動保存</li>
                <li>Googleアカウントを持たないメンバーもLINEだけで参加できる</li>
              </ul>
              <div class="alert alert-light border py-2 px-3 small mb-0">
                <i class="bi bi-info-circle me-1"></i>LINE連携は<strong>チームプラン（月額825円・税込）</strong>の機能です。
                メンバーが何人でも定額でご利用いただけます。
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary btn-sm" data-bs-dismiss="modal">閉じる</button>
              <button type="button" class="btn btn-primary btn-sm" id="btnLineUpsellUpgrade">
                <i class="bi bi-arrow-up-circle me-1"></i>プランを切り替える
              </button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);
    const modalEl = div.querySelector('.modal');
    const modal = new bootstrap.Modal(modalEl);
    modalEl.querySelector('#btnLineUpsellUpgrade').addEventListener('click', () => {
      modal.hide();
      _openStripePortal('update');
    });
    modalEl.addEventListener('hidden.bs.modal', () => div.remove());
    modal.show();
  }

  /**
   * 設定タブ本体に LINE証票保存の状態を出す。
   * 連携コード発行モーダルの中だけだと、既に運用中の組織は誰も開かないため
   * 認証切れに気づけない（実際に本番で気づかないまま止まっていた）。
   * 失効時のみオーナー向けに再有効化ボタンも並べる。
   */
  async function _loadLineDriveStatus(el) {
    const wrap = el.querySelector('#lineDriveStatusWrap');
    if (!wrap) return;
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      wrap.innerHTML = _lineDriveStatusRow({ enabled: true, valid: true, isOwner: true });
      return;
    }
    // ソロプランはLINE連携そのものが使えないので何も出さない
    if (_getCachedLicenseResult()?.plan === 'solo') { wrap.innerHTML = ''; return; }
    let s = null;
    try { s = await Sheets.getLineDriveStatus(); } catch (_) { return; }
    wrap.innerHTML = _lineDriveStatusRow(s);
    wrap.querySelector('#btnDriveReenable')?.addEventListener('click', async (ev) => {
      const b = ev.currentTarget;
      b.disabled = true; b.textContent = '有効化しています…';
      try {
        const rt = Auth.getRefreshToken && Auth.getRefreshToken();
        if (!rt) { App.showToast('一度サインアウトして再度ログインしてからお試しください', 'warning'); return; }
        const r = await Sheets.enableLineDrive(rt);
        App.showToast(r.verified ? '証票保存を有効化しました' : '有効化に失敗しました', r.verified ? 'success' : 'danger');
        await _loadLineDriveStatus(el);
      } catch (err) {
        App.showToast('有効化に失敗しました：' + (err.message || ''), 'danger');
      } finally {
        b.disabled = false;
      }
    });
  }

  /** 設定タブ用の1行表示。3状態（有効／認証切れ／未設定）を出し分ける。 */
  function _lineDriveStatusRow(s) {
    if (!s) return '';
    if (s.enabled && s.valid === false) {
      return `<div class="alert alert-warning py-2 px-3 small mb-0">
        <i class="bi bi-exclamation-triangle-fill me-1"></i><strong>LINE証票保存の認証が切れています</strong><br>
        いまのままではLINEから送られた画像が保存されません。${s.isOwner
          ? '<button type="button" class="btn btn-warning btn-sm mt-2" id="btnDriveReenable">証票保存を有効化し直す</button>'
          : `オーナー（${_escape(s.ownerEmail || 'ライセンス購入者')}）に有効化し直すようご依頼ください。`}
      </div>`;
    }
    if (s.enabled) {
      return `<div class="text-success small mt-1"><i class="bi bi-check-circle-fill me-1"></i>LINEから送られた証票画像も保存されます</div>`;
    }
    return `<div class="text-muted small mt-1"><i class="bi bi-info-circle me-1"></i>LINEから送られた証票画像は保存されません${
      s.isOwner ? '（メンバーの連携コード発行時に有効化できます）' : ''}</div>`;
  }

  /** 証票保存の状態に応じた案内HTML（連携コードモーダル内に表示・有効化ボタンは置かない）。 */
  function _lineDriveSectionHtml(s) {
    if (!s) return '';
    // 保存されていても、トークンが失効していれば証票は保存されない。
    // 「設定済み」と「実際に動く」は別物なので分けて表示する。
    if (s.enabled && s.valid === false) {
      return `<div class="alert alert-warning py-2 px-3 small text-start mt-3 mb-0" id="lineDriveBox">
        <i class="bi bi-exclamation-triangle-fill me-1"></i><strong>証票保存の認証が切れています</strong><br>
        いまのままではLINEから送った画像が保存されません。${s.isOwner
          ? '下の「証票保存を有効化」を押し直してください。'
          : `オーナー（${_escape(s.ownerEmail || 'ライセンス購入者')}）に有効化し直すようご依頼ください。`}
        <a href="#" class="ms-2 text-danger" id="lineDriveDisableLink">無効化</a></div>`;
    }
    if (s.enabled) {
      return `<div class="alert alert-success py-2 px-3 small text-start mt-3 mb-0" id="lineDriveBox">
        <i class="bi bi-check-circle-fill me-1"></i>証票画像も保存されます
        <a href="#" class="ms-2 text-danger" id="lineDriveDisableLink">無効化</a></div>`;
    }
    const note = s.isOwner
      ? '証票画像は保存されません（後で有効化もできます）'
      : `オーナー（${_escape(s.ownerEmail || 'ライセンス購入者')}）が有効化すると証票画像も保存されます`;
    return `<div class="alert alert-secondary py-2 px-3 small text-start mt-3 mb-0" id="lineDriveBox">
      <i class="bi bi-info-circle me-1"></i>${note}</div>`;
  }

  /**
   * 証票保存の有効化を促す専用ポップアップ（未有効化かつオーナー時に、コード画面より先に出す）。
   * ユーザーの選択（有効化/スキップ）後に、最新の状態を resolve する。
   */
  function _promptEnableLineDrive(status) {
    return new Promise((resolve) => {
      const div = document.createElement('div');
      div.innerHTML = `
        <div class="modal fade" tabindex="-1">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title"><i class="bi bi-image me-2 text-success"></i>証票画像の保存</h5>
              </div>
              <div class="modal-body">
                <p class="small mb-2">LINEで送られた領収書画像を経費ログのGoogleドライブ（証票フォルダ）に保存するには、
                <strong>オーナー（あなた）のGoogleアカウントで一度だけ有効化</strong>が必要です。</p>
                <p class="text-muted small mb-0">有効化しない場合、LINEの経費は<strong>証票画像なし</strong>で登録されます（後から有効化も可能）。</p>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary btn-sm" id="btnDriveSkip">スキップ</button>
                <button type="button" class="btn btn-success btn-sm" id="btnDriveEnable"><i class="bi bi-shield-check me-1"></i>証票保存を有効化</button>
              </div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(div);
      const modalEl = div.querySelector('.modal');
      const modal = new bootstrap.Modal(modalEl, { backdrop: 'static' });
      let _result = status, _settled = false;
      modalEl.querySelector('#btnDriveSkip').addEventListener('click', () => modal.hide());
      modalEl.querySelector('#btnDriveEnable').addEventListener('click', async () => {
        const rt = Auth.getRefreshToken();
        if (!rt) { App.showToast('リフレッシュトークンがありません。一度ログアウト→再ログインしてから有効化してください', 'warning'); return; }
        const b = modalEl.querySelector('#btnDriveEnable'), skip = modalEl.querySelector('#btnDriveSkip');
        b.disabled = true; b.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>有効化中…'; if (skip) skip.disabled = true;
        try {
          const r = await Sheets.enableLineDrive(rt);
          App.showToast(r.verified ? '証票保存を有効化しました' : '有効化しましたが動作確認に失敗しました。再ログイン後に再度お試しください', r.verified ? 'success' : 'warning');
          try { _result = await Sheets.getLineDriveStatus(); } catch (_) { _result = { ...status, enabled: true }; }
          modal.hide();
        } catch (err) {
          App.showToast('有効化に失敗しました：' + (err.message || ''), 'danger');
          b.disabled = false; b.innerHTML = '<i class="bi bi-shield-check me-1"></i>証票保存を有効化'; if (skip) skip.disabled = false;
        }
      });
      modalEl.addEventListener('hidden.bs.modal', () => { div.remove(); if (!_settled) { _settled = true; resolve(_result); } });
      modal.show();
    });
  }

  /** メンバーのLINE連携コードを発行してモーダルで表示。 */
  async function _issueLineCode(el, idx) {
    const m = _master?.members?.[idx];
    if (!m) return;
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      return _showLineCodeModal(m.name, '123456', true, 'https://line.me/R/ti/p/@demo', { enabled: true });
    }
    try {
      App.showToast('連携コードを発行しています…', 'info');
      // 既存メンバーは email を identity に、LINE専用メンバーは既存の合成IDを引き継ぐため identity=email(=合成ID)
      const res = await Sheets.issueLineCode(m.email || '', m.name);
      let driveStatus = null;
      try { driveStatus = await Sheets.getLineDriveStatus(); } catch (_) {}
      // 未有効化かつオーナーなら、案内画面より先に有効化の許諾ポップアップを出す（見過ごし防止）
      if (driveStatus && !driveStatus.enabled && driveStatus.isOwner) {
        driveStatus = await _promptEnableLineDrive(driveStatus);
      }
      _showLineCodeModal(m.name, res.code, false, res.addFriendUrl || '', driveStatus);
    } catch (err) {
      App.showToast('コード発行に失敗しました：' + (err.message || ''), 'danger');
    }
  }

  /** 連携コード表示モーダル。addFriendUrl があれば友だち追加QR/リンクも表示する。 */
  function _showLineCodeModal(name, code, isDemo, addFriendUrl, driveStatus) {
    // 本人にテキストで送れる案内文（URL＋コード）
    const _msgLines = [`${name} さん`, '', '経費ログのLINE連携のご案内です。', ''];
    if (addFriendUrl) {
      _msgLines.push('① 下のリンクから「経費ログ」公式アカウントを友だち追加してください', addFriendUrl, '');
      _msgLines.push('② 追加後、トークで下の6桁コードを送信してください', code);
    } else {
      _msgLines.push('① 経費ログの公式アカウントを友だち追加してください');
      _msgLines.push('② 追加後、トークで下の6桁コードを送信してください', code);
    }
    _msgLines.push('（有効期限：24時間・1回のみ有効）', '', 'その後は領収書の写真を送るだけで経費を登録できます。');
    const messageText = _msgLines.join('\n');

    // 友だち追加セクション（公式アカウントのURLが設定されている場合のみ）
    const friendSection = addFriendUrl ? `
      <div class="mt-3 pt-3 border-top">
        <div class="fw-semibold small mb-2"><span class="badge bg-success">STEP 1</span> 公式アカウントを友だち追加</div>
        <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(addFriendUrl)}"
             width="150" height="150" alt="友だち追加QR" style="border:1px solid #eee;border-radius:8px;">
        <div class="mt-2">
          <a href="${_escape(addFriendUrl)}" target="_blank" rel="noopener" class="btn btn-success btn-sm">
            <i class="bi bi-chat-dots-fill me-1"></i>友だち追加リンクを開く
          </a>
        </div>
        <div class="text-muted mt-1" style="font-size:0.7rem;">スマホでQRを読み取るか、リンクから追加できます</div>
      </div>
      <div class="mt-3 pt-2">
        <div class="fw-semibold small mb-2"><span class="badge bg-success">STEP 2</span> トークで下のコードを送信</div>
      </div>` : `
      <div class="text-muted small mt-2">
        公式アカウントを友だち追加し、このコードをトークで送信すると連携が完了します。
      </div>`;

    const div = document.createElement('div');
    div.innerHTML = `
      <div class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-chat-dots me-2 text-success"></i>LINE連携（${_escape(name)} さん）</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body text-center">
              ${friendSection}
              <div class="fw-bold mt-2" style="font-size:2.4rem;letter-spacing:0.3rem;">${_escape(code)}</div>
              <div class="text-warning small mt-1">有効期限：24時間（使い捨て）</div>
              ${isDemo ? '<div class="text-info small mt-2">※デモモードのため実際には発行されません</div>' : ''}
              <div class="mt-3 pt-3 border-top text-start">
                <div class="fw-semibold small mb-1"><i class="bi bi-envelope me-1 text-primary"></i>メール・チャットで送る案内文</div>
                <textarea class="form-control form-control-sm" id="lineMsgText" rows="7" readonly style="font-size:0.78rem;resize:vertical;">${_escape(messageText)}</textarea>
                <div class="text-muted mt-1" style="font-size:0.7rem;">下の「案内文をコピー」で全文コピー → 本人にそのまま送れます。</div>
              </div>
              ${_lineDriveSectionHtml(driveStatus)}
            </div>
            <div class="modal-footer flex-wrap">
              <button type="button" class="btn btn-primary btn-sm" id="btnCopyLineMsg"><i class="bi bi-clipboard-check me-1"></i>案内文をコピー</button>
              <button type="button" class="btn btn-outline-secondary btn-sm" id="btnCopyLineCode"><i class="bi bi-clipboard me-1"></i>コードのみ</button>
              <button type="button" class="btn btn-secondary btn-sm" data-bs-dismiss="modal">閉じる</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);
    const modalEl = div.querySelector('.modal');
    const modal = new bootstrap.Modal(modalEl);
    modalEl.querySelector('#btnCopyLineMsg')?.addEventListener('click', () => {
      navigator.clipboard.writeText(messageText).then(() => App.showToast('案内文をコピーしました', 'success'));
    });
    modalEl.querySelector('#btnCopyLineCode')?.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => App.showToast('コードをコピーしました', 'success'));
    });

    // 証票保存の有効化/無効化（モーダル内で完結。状態はその場で再描画）
    const _rerenderDrive = async () => {
      let s = null;
      try { s = await Sheets.getLineDriveStatus(); } catch (_) {}
      const box = modalEl.querySelector('#lineDriveBox');
      if (box) { box.outerHTML = _lineDriveSectionHtml(s); _wireDrive(); }
    };
    function _wireDrive() {
      // 無効化は確認なしで即実行（誤操作しても再有効化は容易なため）
      modalEl.querySelector('#lineDriveDisableLink')?.addEventListener('click', async (e) => {
        e.preventDefault();
        try { await Sheets.disableLineDrive(); App.showToast('証票保存を無効化しました', 'success'); await _rerenderDrive(); }
        catch (err) { App.showToast('無効化に失敗しました：' + (err.message || ''), 'danger'); }
      });
    }
    _wireDrive();

    modalEl.addEventListener('hidden.bs.modal', () => div.remove());
    modal.show();
  }

  function _updateLicenseStatus(el, result) {
    const div = el.querySelector('#licenseStatus');
    if (!div) return;
    if (!result) {
      div.innerHTML = '<span class="text-muted small">ライセンス未確認</span>';
    } else if (result.valid) {
      const planLabel = !result.trial && result.plan
        ? `<span class="badge bg-info text-dark ms-2"><i class="bi bi-person${result.plan === 'team' ? 's' : ''}-fill me-1"></i>${result.plan === 'team' ? 'チームプラン' : 'ソロプラン'}</span>`
        : '';
      const pendingNote = (!result.trial && result.pendingPlan)
        ? `<div class="text-muted small mt-1"><i class="bi bi-arrow-right-circle me-1"></i>${result.pendingPlan === 'team' ? 'チームプラン' : 'ソロプラン'}に変更予定${result.pendingPlanAt ? `（${result.pendingPlanAt}〜）` : ''}</div>`
        : '';
      div.innerHTML = `<span class="badge ${result.trial ? 'bg-warning text-dark' : 'bg-success'}"><i class="bi bi-check-circle me-1"></i>${result.trial ? 'トライアル中' : 'ライセンス有効'}</span>${planLabel}
        ${result.expiresAt ? `<span class="text-muted small ms-2">${result.trial ? 'トライアル期限' : '期限'}: ${result.expiresAt.split('T')[0]}</span>` : ''}${pendingNote}
`;
    } else {
      div.innerHTML = '<span class="badge bg-danger"><i class="bi bi-x-circle me-1"></i>ライセンス無効</span>';
    }
    _updateTrialUpgradeBox(el, result);
    _updatePortalSection(el, result);
  }

  // 有料プランのポータルボタンを設定ページ末尾に表示
  function _updatePortalSection(el, result) {
    const section = el.querySelector('#portalSection');
    if (!section) return;
    if (!result?.valid || result.trial || !result.hasPortal) {
      section.innerHTML = '';
      return;
    }
    if (result.cancelScheduled) {
      // 解約予約済み：再解約させず、状態表示＋管理（取り消し）ボタンのみ
      const endTxt = result.cancelAt ? `${_escape(result.cancelAt)} に終了予定` : '現在の期間終了時に終了予定';
      section.innerHTML = `
      <div class="card mb-3 border-warning">
        <div class="card-body">
          <div class="alert alert-warning py-2 mb-2 small">
            <i class="bi bi-clock-history me-1"></i><strong>解約予約済み</strong>：${endTxt}。それまでは通常どおりご利用いただけます。
          </div>
          <button class="btn btn-outline-primary w-100" id="btnManagePortal">
            <i class="bi bi-gear me-1"></i>解約を取り消す／プランを管理する
          </button>
          <div class="text-muted mt-1" style="font-size:0.75rem;text-align:center;">Stripeの画面で解約の取り消し・プラン変更ができます。</div>
        </div>
      </div>
      `;
    } else {
      section.innerHTML = `
      <div class="card mb-3">
        <div class="card-body">
          <button class="btn btn-outline-primary w-100 mb-2" id="btnChangePlan">
            <i class="bi bi-arrow-repeat me-1"></i>プランを変更する
          </button>
          <button class="btn btn-outline-secondary w-100" id="btnCancelPlan">
            <i class="bi bi-x-circle me-1"></i>プランを解約する
          </button>
          <div class="text-muted mt-1" style="font-size:0.75rem;text-align:center;">ボタンを押すと、Stripeの安全な画面で手続きできます。</div>
        </div>
      </div>
      `;
    }
    // クリックは bindEvents の委譲リスナーで処理（innerHTML 再描画後もリスナーが確実に機能する）
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
          : `トライアル中です（ソロ・チーム問わず全機能をお試しいただけます）。<strong>トライアル期間内に下のボタンからソロまたはチームプランへ切り替えをお願いします。</strong>トライアル期間終了後は自動課金されません。`}</div>
        ${planButtons}
        <div class="text-muted mt-1" style="font-size:0.75rem;">どちらを選んでもライセンスキー・データ・設定はそのまま引き継がれます。</div>
      </div>`;
    box.style.display = '';
  }

  function _getCachedLicenseResult() {
    try { return JSON.parse(localStorage.getItem('keihi_license_cache_v2') || 'null')?.result || null; }
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
