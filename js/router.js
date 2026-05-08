/**
 * シングルページルーター
 * ボトムナビのボタンに応じてビューを切り替える
 */
const Router = (() => {

  const VIEWS = {
    submit:   SubmitView,
    list:     ListView,
    summary:  SummaryView,
    settings: SettingsView,
    admin:    AdminView,
  };

  let _current = null;

  function init(initialView = 'submit') {
    document.querySelectorAll('.nav-item-btn').forEach(btn => {
      btn.addEventListener('click', () => navigate(btn.dataset.view));
    });
    navigate(initialView);
  }

  async function navigate(viewName) {
    if (!VIEWS[viewName]) return;
    _current = viewName;

    // ナビアクティブ状態
    document.querySelectorAll('.nav-item-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    const main = document.getElementById('appMain');
    main.innerHTML = '<div class="text-center py-5"><div class="spinner-border text-primary" role="status"></div></div>';

    const view = VIEWS[viewName];
    main.innerHTML = view.render();
    await view.bindEvents(main);
  }

  function current() { return _current; }

  return { init, navigate, current };
})();
