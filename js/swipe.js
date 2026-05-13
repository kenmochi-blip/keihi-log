/**
 * 横スワイプビュー遷移
 * 指に追従してリアルタイムにスライド、離した瞬間にスナップ
 */
const SwipeNav = (() => {
  const ORDER = ['submit', 'list', 'summary', 'settings'];
  const COMMIT_RATIO = 0.28; // 画面幅の28%以上でコミット

  const _views = () => ({
    submit:   typeof SubmitView   !== 'undefined' ? SubmitView   : null,
    list:     typeof ListView     !== 'undefined' ? ListView     : null,
    summary:  typeof SummaryView  !== 'undefined' ? SummaryView  : null,
    settings: typeof SettingsView !== 'undefined' ? SettingsView : null,
  });

  let _sx = 0, _sy = 0;
  let _decided = false;   // horizontal/vertical の判定済みフラグ
  let _isHoriz = false;
  let _wrapper = null;
  let _savedHTML = '';
  let _W = 0;

  function init() {
    const el = document.getElementById('appMain');
    el.addEventListener('touchstart',  _onStart,  { passive: true  });
    el.addEventListener('touchmove',   _onMove,   { passive: false });
    el.addEventListener('touchend',    _onEnd,    { passive: true  });
    el.addEventListener('touchcancel', _onCancel, { passive: true  });
  }

  function _onStart(e) {
    _sx      = e.touches[0].clientX;
    _sy      = e.touches[0].clientY;
    _decided = false;
    _isHoriz = false;
  }

  function _onMove(e) {
    const dx = e.touches[0].clientX - _sx;
    const dy = e.touches[0].clientY - _sy;

    // 方向未確定：8px 動いたら判定
    if (!_decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      _decided = true;
      _isHoriz = Math.abs(dx) > Math.abs(dy);
      if (_isHoriz) _initPanels();
    }

    if (!_isHoriz || !_wrapper) return;
    e.preventDefault(); // 縦スクロールを止める

    _wrapper.style.transform = `translateX(${-_W + dx}px)`;
  }

  function _onEnd(e) {
    if (!_isHoriz || !_wrapper) return;
    const dx = e.changedTouches[0].clientX - _sx;
    _snap(dx);
  }

  function _onCancel() {
    if (!_wrapper) return;
    _restore();
  }

  // ── パネル構築 ─────────────────────────────────────────────

  function _initPanels() {
    const main = document.getElementById('appMain');
    const cur  = Router.current();
    const idx  = ORDER.indexOf(cur);
    if (idx === -1) { _isHoriz = false; return; }

    _W = main.offsetWidth;
    _savedHTML = main.innerHTML;

    const views   = _views();
    const prev    = ORDER[(idx + ORDER.length - 1) % ORDER.length];
    const next    = ORDER[(idx + 1) % ORDER.length];

    _wrapper = document.createElement('div');
    _wrapper.style.cssText =
      `display:flex;width:${_W * 3}px;transform:translateX(${-_W}px);will-change:transform;`;

    [prev, cur, next].forEach((name, i) => {
      const panel = document.createElement('div');
      panel.style.cssText =
        `width:${_W}px;flex-shrink:0;overflow:hidden;` +
        (i !== 1 ? 'opacity:0.6;pointer-events:none;' : '');
      try {
        panel.innerHTML = i === 1 ? _savedHTML : (views[name]?.render() || '');
      } catch (_) { panel.innerHTML = ''; }
      _wrapper.appendChild(panel);
    });

    main.style.overflow = 'hidden';
    main.innerHTML = '';
    main.appendChild(_wrapper);
  }

  // ── スナップ ───────────────────────────────────────────────

  function _snap(dx) {
    if (!_wrapper) return;
    const cur   = Router.current();
    const idx   = ORDER.indexOf(cur);
    const threshold = _W * COMMIT_RATIO;

    let targetX, targetView;
    if (dx < -threshold) {
      targetX    = -_W * 2;
      targetView = ORDER[(idx + 1) % ORDER.length];
    } else if (dx > threshold) {
      targetX    = 0;
      targetView = ORDER[(idx + ORDER.length - 1) % ORDER.length];
    } else {
      _restore();
      return;
    }

    _wrapper.style.transition = 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)';
    _wrapper.style.transform  = `translateX(${targetX}px)`;
    _wrapper.addEventListener('transitionend', () => {
      _wrapper = null;
      const main = document.getElementById('appMain');
      main.style.overflow = '';
      Router.navigate(targetView);
    }, { once: true });
  }

  // スナップバック（キャンセル or 距離不足）
  function _restore() {
    if (!_wrapper) return;
    _wrapper.style.transition = 'transform 0.2s cubic-bezier(0.25,0.46,0.45,0.94)';
    _wrapper.style.transform  = `translateX(${-_W}px)`;
    _wrapper.addEventListener('transitionend', () => {
      _wrapper = null;
      const main = document.getElementById('appMain');
      main.style.overflow = '';
      main.innerHTML = _savedHTML;
      const cur = Router.current();
      try { _views()[cur]?.bindEvents(main); } catch (_) {}
    }, { once: true });
  }

  return { init };
})();
