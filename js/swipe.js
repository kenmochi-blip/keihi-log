/**
 * 横スワイプビュー遷移
 * - オーバーレイ z-index:499 → 実ナビバー(z:1020)・ボトムナビ(z:1030)が上に残る
 * - スクロール位置は transform:translateY で再現（scrollTop の非同期問題を回避）
 */
const SwipeNav = (() => {
  const COMMIT_RATIO = 0.28;

  // ボトムナビに表示されているボタンの順序を動的に取得（非表示タブはスワイプ対象外）
  function _order() {
    return Array.from(document.querySelectorAll('.nav-item-btn:not(.d-none)'))
      .map(b => b.dataset.view)
      .filter(Boolean);
  }

  // 各ビューの最終レンダリング結果をキャッシュ
  const _cache = {};
  // 各ビューの .table-responsive 横スクロール位置をキャッシュ
  const _scrollCache = {};

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
  let _inScrollX = false; // タッチ開始位置が横スクロール可能な要素内 → スワイプをスキップ

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
    // .table-responsive 内のタッチはスワイプナビをスキップ（横スクロールを優先）
    _inScrollX = !!e.target.closest('.table-responsive');
    // タッチ開始時に現在ビューの HTML をキャッシュ（データ読み込み済みの状態を保存）
    const cur = Router.current();
    const main = document.getElementById('appMain');
    if (cur && main) {
      // .table-responsive の横スクロール位置をキャッシュ（集計表などの表示位置を保持）
      _scrollCache[cur] = [];
      main.querySelectorAll('.table-responsive').forEach(el => {
        _scrollCache[cur].push(el.scrollLeft);
      });
      // type="password" を type="text" に変換してからキャッシュ
      // （スワイプで innerHTML が置き換わる前に変換することで
      //   Chrome の「パスワードを保存しますか？」ダイアログを抑制する）
      main.querySelectorAll('input[type="password"]').forEach(el => { el.type = 'text'; });
      _cache[cur] = main.innerHTML;
    }
  }

  function _onMove(e) {
    if (_overlay && _isHoriz) {
      e.preventDefault();
      _track.style.transform = `translateX(${-_W + (e.touches[0].clientX - _sx)}px)`;
      return;
    }
    if (_decided) return;
    // .table-responsive 内のタッチはブラウザネイティブの横スクロールに委ねる
    if (_inScrollX) return;

    const dx = e.touches[0].clientX - _sx;
    const dy = e.touches[0].clientY - _sy;
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;

    _decided = true;
    _isHoriz = Math.abs(dx) > Math.abs(dy);
    if (_isHoriz) {
      e.preventDefault();
      _build();
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

  // ── パネル構築 ─────────────────────────────────────────────

  function _build() {
    const main = document.getElementById('appMain');
    _cur = Router.current();
    const order = _order();
    const idx = order.indexOf(_cur);
    if (idx === -1) { _isHoriz = false; return; }

    _W = window.innerWidth;

    // スワイプ開始時のスクロール位置
    const scrollY = window.scrollY;

    // ナビバーの実際の高さを取得
    const navH = document.querySelector('nav.navbar.sticky-top')?.offsetHeight || 56;

    const views    = _views();
    const prevName = order[(idx + order.length - 1) % order.length];
    const nextName = order[(idx + 1) % order.length];

    // 非表示にする前にクラスとスタイルを取得（visibility:hidden が混入するのを防ぐ）
    const mainClassName = main.className;
    const mainStyleStr  = main.getAttribute('style') || '';

    // オーバーレイ：z-index 499 にすることで
    // 実ナビバー(Bootstrap z-index:1020)とボトムナビ(1030)が上に浮いたままになる
    _overlay = document.createElement('div');
    _overlay.style.cssText = 'position:fixed;inset:0;z-index:499;overflow:hidden;background:#f8f9fa;';

    _track = document.createElement('div');
    _track.style.cssText =
      `position:absolute;top:0;left:0;height:100%;` +
      `width:${_W * 3}px;transform:translateX(${-_W}px);will-change:transform;`;

    [[prevName, 0], [_cur, 1], [nextName, 2]].forEach(([name, pos]) => {
      const panel = document.createElement('div');
      panel.style.cssText =
        `position:absolute;top:0;left:${pos * _W}px;width:${_W}px;height:100%;` +
        `background:#f8f9fa;overflow:hidden;` +
        (pos !== 1 ? 'opacity:0.6;' : '');

      const inner = document.createElement('div');
      inner.className = mainClassName;
      // view-fade-in クラスを除去：CSSアニメーション(opacity:0→1, translateY(4px)→0)は
      // インラインスタイルより優先度が高く、translateY(offsetY)を上書きして
      // コンテンツが上詰めになる・タイトルが消える原因になるため
      inner.classList.remove('view-fade-in');
      inner.style.cssText = mainStyleStr;

      try {
        // 隣パネル：キャッシュ済みHTML（データ読み込み済）→ 新規render() の順で使用
        inner.innerHTML = pos === 1
          ? main.innerHTML
          : (_cache[name] || views[name]?.render() || '');
      } catch (_) {}

      // .table-responsive の横スクロール位置を復元（集計表などで右端を表示中の場合）
      const savedScrolls = _scrollCache[name];
      if (savedScrolls?.length) {
        const tbls = inner.querySelectorAll('.table-responsive');
        savedScrolls.forEach((sl, i) => {
          if (tbls[i] && sl > 0) tbls[i].scrollLeft = sl;
        });
      }

      // スクロール位置を transform で再現
      const offsetY = navH - (pos === 1 ? scrollY : 0);
      inner.style.transform = `translateY(${offsetY}px)`;
      inner.style.paddingBottom = '80px';

      panel.appendChild(inner);
      _track.appendChild(panel);
    });

    _overlay.appendChild(_track);
    // ① オーバーレイを先に表示してから元コンテンツを隠す
    //    （先に hidden にすると 1フレーム分タイトルが消えてちらつく）
    document.body.appendChild(_overlay);
    main.style.visibility = 'hidden';
  }

  // ── スナップ ───────────────────────────────────────────────

  function _snap(dx) {
    const threshold = _W * COMMIT_RATIO;
    const order = _order();
    const idx = order.indexOf(_cur);
    if (dx < -threshold) {
      _animate(-_W * 2, order[(idx + 1) % order.length]);
    } else if (dx > threshold) {
      _animate(0, order[(idx + order.length - 1) % order.length]);
    } else {
      _snapBack();
    }
  }

  function _animate(targetX, targetView) {
    _track.style.transition = 'transform 0.22s cubic-bezier(0.25,0.46,0.45,0.94)';
    _track.style.transform  = `translateX(${targetX}px)`;
    _track.addEventListener('transitionend', () => {
      const main = document.getElementById('appMain');

      // ① オーバーレイが覆っている間に新ビューを main へ先行描画
      //    → overlay 撤去直後から正しいコンテンツが表示される（旧コンテンツが一瞬現れない）
      if (main && _views()[targetView]) {
        main.style.maxWidth = '480px';
        try { main.innerHTML = _views()[targetView].render(); } catch (_) {}
        // テーブル横スクロール位置を復元
        const savedScrolls = _scrollCache[targetView];
        if (savedScrolls?.length) {
          main.querySelectorAll('.table-responsive').forEach((el, i) => {
            if (savedScrolls[i] > 0) el.scrollLeft = savedScrolls[i];
          });
        }
      }

      window.scrollTo(0, 0);
      _cleanup(); // overlay 撤去 → main が即座に新コンテンツで表示される

      // ② Router はナビ状態・_current 更新 + bindEvents のみ実行（再描画・フェードインなし）
      Router.navigate(targetView, { skipRender: true, skipFade: true });
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
