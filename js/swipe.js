/**
 * 横スワイプビュー遷移
 * position:fixed のオーバーレイで3パネルを構築し、ビューポートで確実にクリップ
 */
const SwipeNav = (() => {
  const ORDER = ['submit', 'list', 'summary', 'settings'];
  const COMMIT_RATIO = 0.28;

  const _views = () => ({
    submit:   typeof SubmitView   !== 'undefined' ? SubmitView   : null,
    list:     typeof ListView     !== 'undefined' ? ListView     : null,
    summary:  typeof SummaryView  !== 'undefined' ? SummaryView  : null,
    settings: typeof SettingsView !== 'undefined' ? SettingsView : null,
  });

  let _sx = 0, _sy = 0;
  let _decided = false, _isHoriz = false;
  let _overlay = null, _track = null;
  let _W = 0, _cur = '';

  function init() {
    const el = document.getElementById('appMain');
    el.addEventListener('touchstart',  _onStart,  { passive: true  });
    el.addEventListener('touchmove',   _onMove,   { passive: false });
    el.addEventListener('touchend',    _onEnd,    { passive: true  });
    el.addEventListener('touchcancel', _onCancel, { passive: true  });
  }

  function _onStart(e) {
    if (_overlay) return;
    _sx = e.touches[0].clientX;
    _sy = e.touches[0].clientY;
    _decided = false;
    _isHoriz = false;
  }

  function _onMove(e) {
    // スライド中：指に追従
    if (_overlay && _isHoriz) {
      e.preventDefault();
      const dx = e.touches[0].clientX - _sx;
      _track.style.transform = `translateX(${-_W + dx}px)`;
      return;
    }
    if (_decided) return;

    const dx = e.touches[0].clientX - _sx;
    const dy = e.touches[0].clientY - _sy;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;

    _decided = true;
    _isHoriz = Math.abs(dx) > Math.abs(dy);
    if (_isHoriz) {
      e.preventDefault();
      _build();
      // 初動のdxをすぐ反映
      _track.style.transform = `translateX(${-_W + dx}px)`;
    }
  }

  function _onEnd(e) {
    if (!_overlay || !_isHoriz) return;
    _snap(e.changedTouches[0].clientX - _sx);
  }

  function _onCancel() {
    if (_overlay) _snapBack();
  }

  // ── パネル構築（position:fixed で確実にクリップ）─────────────

  function _build() {
    const main = document.getElementById('appMain');
    _cur = Router.current();
    const idx = ORDER.indexOf(_cur);
    if (idx === -1) { _isHoriz = false; return; }

    _W = window.innerWidth;

    const views    = _views();
    const prevName = ORDER[(idx + ORDER.length - 1) % ORDER.length];
    const nextName = ORDER[(idx + 1) % ORDER.length];

    // ナビバー・ボトムナビのHTMLを複製（スワイプ中も画面全体がスライドして見える）
    const navbarHTML    = document.querySelector('nav.navbar.sticky-top')?.outerHTML  || '';
    const bottomNavHTML = document.querySelector('nav.navbar.fixed-bottom')?.outerHTML || '';

    // スワイプ中は元のコンテンツを隠す（透過による残像を防ぐ）
    main.style.visibility = 'hidden';

    // fixed オーバーレイ（ビューポートに固定 → 必ずクリップされる）
    _overlay = document.createElement('div');
    _overlay.style.cssText = 'position:fixed;inset:0;z-index:500;overflow:hidden;background:#f8f9fa;';

    // トラック（3パネル横並び）
    _track = document.createElement('div');
    _track.style.cssText =
      `position:absolute;top:0;left:0;height:100%;` +
      `width:${_W * 3}px;transform:translateX(${-_W}px);will-change:transform;`;

    [[prevName, 0], [_cur, 1], [nextName, 2]].forEach(([name, pos]) => {
      const panel = document.createElement('div');
      panel.style.cssText =
        `position:absolute;top:0;left:${pos * _W}px;width:${_W}px;height:100%;` +
        `background:#f8f9fa;overflow:hidden;` +
        (pos !== 1 ? 'opacity:0.65;' : '');

      // ナビバー
      panel.insertAdjacentHTML('beforeend', navbarHTML);

      // コンテンツ
      const inner = document.createElement('div');
      inner.style.cssText = 'max-width:480px;margin:0 auto;padding-bottom:80px;overflow-y:auto;height:calc(100vh - 56px - 65px);';
      try {
        inner.innerHTML = pos === 1
          ? main.innerHTML
          : (views[name]?.render() || '');
      } catch (_) { /* 隣パネルのrenderに失敗しても続行 */ }
      panel.appendChild(inner);

      // ボトムナビ
      panel.insertAdjacentHTML('beforeend', bottomNavHTML);

      _track.appendChild(panel);
    });

    _overlay.appendChild(_track);
    document.body.appendChild(_overlay);
  }

  // ── スナップ ───────────────────────────────────────────────

  function _snap(dx) {
    const threshold = _W * COMMIT_RATIO;
    const idx = ORDER.indexOf(_cur);
    if (dx < -threshold) {
      _animate(-_W * 2, ORDER[(idx + 1) % ORDER.length]);
    } else if (dx > threshold) {
      _animate(0, ORDER[(idx + ORDER.length - 1) % ORDER.length]);
    } else {
      _snapBack();
    }
  }

  function _animate(targetX, targetView) {
    _track.style.transition = 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)';
    _track.style.transform  = `translateX(${targetX}px)`;
    _track.addEventListener('transitionend', () => {
      _cleanup();
      Router.navigate(targetView);
    }, { once: true });
  }

  function _snapBack() {
    _track.style.transition = 'transform 0.2s cubic-bezier(0.25,0.46,0.45,0.94)';
    _track.style.transform  = `translateX(${-_W}px)`;
    _track.addEventListener('transitionend', () => _cleanup(), { once: true });
  }

  function _cleanup() {
    _overlay?.remove();
    _overlay = null;
    _track   = null;
    _isHoriz = false;
    _decided = false;
    const main = document.getElementById('appMain');
    if (main) main.style.visibility = '';
  }

  return { init };
})();
