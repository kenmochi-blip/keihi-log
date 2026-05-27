/**
 * シングルページルーター
 * ボトムナビのボタンに応じてビューを切り替える
 */
const Router = (() => {

  // ビューモジュールが未定義でもRouter自体は壊れないように、
  // typeofで存在を確認してから登録する（スクリプト読み込み失敗の耐性）
  const VIEWS = {};
  if (typeof SubmitView   !== 'undefined') VIEWS.submit   = SubmitView;
  if (typeof ListView     !== 'undefined') VIEWS.list     = ListView;
  if (typeof SummaryView  !== 'undefined') VIEWS.summary  = SummaryView;
  if (typeof SettingsView !== 'undefined') VIEWS.settings = SettingsView;
  if (typeof AdminView    !== 'undefined') VIEWS.admin    = AdminView;

  let _current = null;

  function init(initialView = 'submit') {
    document.querySelectorAll('.nav-item-btn').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.view));
    });
    navigate(initialView);
  }

  /**
   * ビューを切り替える
   * @param {string} viewName
   * @param {{ skipRender?: boolean, skipFade?: boolean }} [opts]
   *   skipRender: trueのとき render()/innerHTML 書き換えをスキップ（swipe完了後用）
   *   skipFade:   trueのとき フェードインアニメーションをスキップ
   */
  async function navigate(viewName, opts = {}) {
    const main = document.getElementById('appMain');
    if (!main) return;

    if (!VIEWS[viewName]) {
      main.innerHTML = _errorHtml(`ビュー「${viewName}」が見つかりません。スクリプトの読み込みに失敗した可能性があります。ページを再読み込みしてください。`);
      return;
    }
    _current = viewName;

    // ナビアクティブ状態
    document.querySelectorAll('.nav-item-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    if (!opts.skipRender) {
      main.style.maxWidth = '480px'; // 集計ビューが広げた場合にリセット
      // type="password" フィールドを削除前に type="text" へ変換
      // （Chrome: DOMからpasswordフィールドが消えるとパスワード保存ダイアログが出るため）
      main.querySelectorAll('input[type="password"]').forEach(el => { el.type = 'text'; });
      main.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';

      const view = VIEWS[viewName];
      try {
        main.innerHTML = view.render();
        // フェードイン（タブボタンタップ時のみ）
        // スワイプ遷移はアニメーション済みのためスキップ（skipFade=true）
        if (!opts.skipFade) {
          main.classList.remove('view-fade-in');
          requestAnimationFrame(() => main.classList.add('view-fade-in'));
        }
      } catch (err) {
        console.error('view.render error:', err);
        main.innerHTML = _errorHtml(`画面の表示でエラーが発生しました: ${err.message}`);
        return;
      }
    }

    const view = VIEWS[viewName];
    try {
      await view.bindEvents(main);
    } catch (err) {
      console.error('view.bindEvents error:', err);
      // 既にrenderされた画面はそのまま、トーストで通知のみ
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast(`画面の初期化でエラー: ${err.message}`, 'danger');
      }
    }
  }

  function _errorHtml(msg) {
    return `<div class="pt-4">
      <div class="alert alert-danger small">
        <i class="bi bi-exclamation-triangle-fill me-2"></i>${msg}
      </div>
      <button class="btn btn-outline-secondary btn-sm" onclick="location.reload()">
        <i class="bi bi-arrow-clockwise me-1"></i>再読み込み
      </button>
    </div>`;
  }

  function current() { return _current; }

  return { init, navigate, current };
})();
