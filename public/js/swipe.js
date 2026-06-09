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
  // _build() で隣パネルをキャッシュHTMLから構築したか記録（_animate の fromCache 判定用）
  const _builtFromCache = {};

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
  let _scrollXEl = null;  // _inScrollX のとき、対象の .table-responsive 要素

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
    _scrollXEl = e.target.closest('.table-responsive');
    _inScrollX = !!_scrollXEl;
    // タッチ開始時に現在ビューの HTML をキャッシュ（データ読み込み済みの状態を保存）
    const cur = Router.current();
    const main = document.getElementById('appMain');
    if (cur && main) {
      // .table-responsive の横スクロール位置をキャッシュ（集計表などの表示位置を保持）
      _scrollCache[cur] = [];
      main.querySelectorAll('.table-responsive').forEach(el => {
        _scrollCache[cur].push(el.scrollLeft);
      });
      // input の .value プロパティを value 属性に同期する
      // innerHTML は HTML 属性しか保存しないため、JS でセットした値（社名・APIキー等）が
      // キャッシュに含まれずスワイプ中のパネルで空欄になる問題を防ぐ
      main.querySelectorAll('input').forEach(inp => {
        if (inp.value !== (inp.getAttribute('value') || '')) {
          inp.setAttribute('value', inp.value);
        }
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

    const dx = e.touches[0].clientX - _sx;
    const dy = e.touches[0].clientY - _sy;

    // .table-responsive 内のタッチ：スクロール端に達している方向のスワイプはナビに委ねる
    if (_inScrollX && _scrollXEl) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      const atLeft  = _scrollXEl.scrollLeft <= 0;
      const atRight = _scrollXEl.scrollLeft + _scrollXEl.clientWidth >= _scrollXEl.scrollWidth - 1;
      if ((dx > 0 && atLeft) || (dx < 0 && atRight)) {
        _inScrollX = false; // 端まで達しているのでスワイプナビに引き渡す
      } else {
        return; // まだスクロール余地あり → ブラウザの横スクロールに委ねる
      }
    }
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
        `background:#f8f9fa;overflow:hidden;`;

      const inner = document.createElement('div');
      inner.className = mainClassName;
      // view-fade-in クラスを除去：CSSアニメーション(opacity:0→1, translateY(4px)→0)は
      // インラインスタイルより優先度が高く、translateY(offsetY)を上書きして
      // コンテンツが上詰めになる・タイトルが消える原因になるため
      inner.classList.remove('view-fade-in');
      inner.style.cssText = mainStyleStr;

      try {
        // 隣パネル：キャッシュ済みHTML（データ読み込み済）→ 新規render() の順で使用
        if (pos === 1) {
          inner.innerHTML = main.innerHTML;
        } else {
          const cached = _cache[name];
          inner.innerHTML = cached || views[name]?.render() || '';
          // キャッシュ由来かどうかを記録（_animate で fromCache 判定に使用）
          _builtFromCache[name] = !!cached;
        }
      } catch (_) {}

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

    // ② DOM 追加後に横スクロール位置を復元する
    //    detached 状態では scrollLeft が layout コンテキストなしで 0 にリセットされるため、
    //    document.body に追加した後でないと正しく設定できない
    [[prevName, 0], [_cur, 1], [nextName, 2]].forEach(([name, pos]) => {
      const savedScrolls = _scrollCache[name];
      if (!savedScrolls?.length) return;
      const inner = _track.children[pos]?.firstElementChild;
      if (!inner) return;
      inner.querySelectorAll('.table-responsive').forEach((el, i) => {
        if (savedScrolls[i] > 0) el.scrollLeft = savedScrolls[i];
      });
    });
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
    // transitionend が発火しない場合（稀なブラウザ挙動）のフォールバック
    const fallback = setTimeout(() => _finish(targetX, targetView), 350);
    _track.addEventListener('transitionend', () => {
      clearTimeout(fallback);
      _finish(targetX, targetView);
    }, { once: true });
  }

  function _finish(targetX, targetView) {
    if (!_overlay) return; // 二重呼び出し防止
    const main = document.getElementById('appMain');

    // ① オーバーレイが覆っている間に新ビューを main へ先行描画
    if (main) {
      main.style.maxWidth = ['summary', 'list'].includes(targetView) ? '' : '480px';
      const panelIndex = targetX === 0 ? 0 : 2;
      const panelInner = _track.children[panelIndex]?.firstElementChild;
      if (panelInner) {
        main.innerHTML = panelInner.innerHTML;
      } else if (_views()[targetView]) {
        try { main.innerHTML = _views()[targetView].render(); } catch (_) {}
      }
      const savedScrolls = _scrollCache[targetView];
      if (savedScrolls?.length) {
        main.querySelectorAll('.table-responsive').forEach((el, i) => {
          if (savedScrolls[i] > 0) el.scrollLeft = savedScrolls[i];
        });
      }
    }

    if (main) main.classList.add('swipe-settling');
    _cleanup();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById('appMain')?.classList.remove('swipe-settling');
    }));

    const fromCache = !!_builtFromCache[targetView];
    Router.navigate(targetView, { skipRender: true, skipFade: true, fromCache });
  }

  function _snapBack() {
    _track.style.transition = 'transform 0.2s cubic-bezier(0.25,0.46,0.45,0.94)';
    _track.style.transform  = `translateX(${-_W}px)`;
    const fallback = setTimeout(() => _cleanup(), 350);
    _track.addEventListener('transitionend', () => { clearTimeout(fallback); _cleanup(); }, { once: true });
  }

  function _cleanup() {
    _overlay?.remove();
    _overlay = null;
    _track   = null;
    _isHoriz = false;
    _decided = false;
    const main = document.getElementById('appMain');
    if (main) {
      // スクロールを最上部に戻してから main を表示することで、
      // 旧スクロール位置が1フレームでも見えるのを防ぐ
      window.scrollTo({ top: 0, behavior: 'instant' });
      main.style.visibility = '';
    }
  }

  // プログラム的にスワイプアニメーションで遷移する
  function swipeTo(targetView) {
    if (_overlay) return;
    const cur = Router.current();
    if (cur === targetView) return;

    const order = _order();
    const idx = order.indexOf(cur);
    if (idx === -1) { Router.navigate(targetView); return; }

    const prevName = order[(idx + order.length - 1) % order.length];
    const nextName = order[(idx + 1) % order.length];

    // 隣接ビュー以外はフォールバック
    if (targetView !== prevName && targetView !== nextName) {
      Router.navigate(targetView);
      return;
    }

    _decided = true;
    _isHoriz = true;
    _build();

    // _build() と _animate() が同一フレームで実行されると、ブラウザが初期 transform を
    // 描画前にバッチ処理してトランジションをスキップする。offsetWidth 参照でレイアウトを
    // 強制コミットしてからアニメーション開始位置を確定させる。
    // eslint-disable-next-line no-unused-expressions
    void _track.offsetWidth;

    const targetX = targetView === nextName ? -_W * 2 : 0;
    _animate(targetX, targetView);
  }

  return { init, swipeTo };
})();
