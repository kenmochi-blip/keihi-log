/**
 * 経費ログ診断ウィジェット
 * /check（単独ページ）とLP（トップページ埋め込み）の両方から使う共通実装。
 * 質問・判定ロジック・結果文言はすべてここに集約する（二重管理禁止）。
 *
 * 使い方: Diagnosis.mount(document.getElementById('...'), { source: 'lp' })
 *   source は GA イベント（diagnosis_start / diagnosis_result）の区別用。
 */
const Diagnosis = (() => {
  'use strict';

  const QUESTIONS = [
    {
      key: 'receipts',
      title: '毎月あつかう領収書・レシートは、どのくらいありますか？',
      opts: [
        { v: 'few',  icon: 'bi-receipt',        label: 'ほとんどない（月5枚以下）' },
        { v: 'some', icon: 'bi-receipt-cutoff', label: 'そこそこある（月6〜30枚）' },
        { v: 'many', icon: 'bi-files',          label: 'たくさんある（月31枚以上）' },
      ],
    },
    {
      key: 'members',
      title: '経費の立替（自腹で払って後で精算）が発生するのは？',
      opts: [
        { v: 'solo', icon: 'bi-person',      label: '自分だけ', sub: 'ひとり社長・個人事業主など' },
        { v: 'team', icon: 'bi-people',      label: '2人以上いる', sub: '社員・スタッフも立て替える' },
        { v: 'none', icon: 'bi-credit-card', label: '立替はほぼない', sub: 'ほぼすべて法人カード・会社払い' },
      ],
    },
    {
      key: 'accounting',
      title: '経理・会計処理は、いまどうしていますか？',
      opts: [
        { v: 'outsource', icon: 'bi-briefcase', label: '税理士・会計事務所に任せている', sub: '領収書を渡して記帳はお任せ' },
        { v: 'self-own',  icon: 'bi-laptop',    label: '自分で会計ソフトに入力し、申告も自分でやる' },
        { v: 'self-tax',  icon: 'bi-laptop',    label: '自分で会計ソフトに入力し、申告は税理士に依頼' },
        { v: 'piled',     icon: 'bi-inboxes',   label: '正直、レシートが溜まりがち…' },
      ],
    },
    {
      key: 'size',
      title: '従業員数は？（役員・パート含むおおよそで）',
      opts: [
        { v: 's1',  icon: 'bi-person-badge', label: '自分ひとり' },
        { v: 's10', icon: 'bi-people',       label: '2〜10名くらい' },
        { v: 's30', icon: 'bi-building',     label: '11〜30名くらい' },
        { v: 's31', icon: 'bi-buildings',    label: '31名以上' },
      ],
    },
    {
      key: 'revenue',
      title: '年間の売上規模は？',
      opts: [
        { v: 'r1',     icon: 'bi-graph-up',       label: '〜1億円くらい' },
        { v: 'r5',     icon: 'bi-graph-up-arrow', label: '1〜5億円くらい' },
        { v: 'r5plus', icon: 'bi-bank',           label: '5億円超' },
      ],
    },
  ];

  /* 判定ロジック
     - 領収書がほぼ無い（月5枚以下）→ 立替の有無に関わらず不要かも（正直判定）
     - 立替が自分だけ → ソロプラン／2人以上 → チームプラン
     - 立替ほぼ無し（会社払い中心）は従業員1人ならソロ・複数ならチーム
     - 31名以上／売上5億超 は結果を変えず注意書きだけ添える */
  function judge(a) {
    if (a.receipts === 'few') return 'no-need';
    if (a.members === 'solo') return 'solo';
    if (a.members === 'team') return 'team';
    return (a.size === 's1') ? 'solo' : 'team';
  }

  /* 埋め込み先のページCSSと衝突しないよう dg- プレフィックスで完結させる */
  const CSS = `
    .dg-card { background:#fff; border:1px solid #e3e8ef; border-radius:18px; padding:1.6rem 1.4rem; box-shadow:0 4px 18px rgba(13,110,253,0.06); text-align:left; }
    .dg-progress { height:6px; background:#e3ecf7; border-radius:50px; overflow:hidden; margin-bottom:1rem; }
    .dg-progress > div { height:100%; background:#0d6efd; transition:width 0.3s; }
    .dg-num { color:#0d6efd; font-weight:700; font-size:0.82rem; letter-spacing:0.06em; }
    .dg-title { font-weight:700; font-size:1.12rem; line-height:1.6; margin:0.35rem 0 1.1rem; color:#2c3e50; }
    .dg-opt { display:flex; align-items:center; gap:0.7rem; width:100%; background:#fff; border:1.5px solid #d7e2f0; border-radius:12px; padding:0.85rem 1rem; margin-bottom:0.65rem; text-align:left; font-size:0.96rem; font-weight:600; color:#2c3e50; transition:border-color 0.12s, background 0.12s; }
    .dg-opt i { color:#0d6efd; font-size:1.1rem; flex-shrink:0; }
    @media (hover:hover) { .dg-opt:hover { border-color:#0d6efd; background:#f4f9ff; } }
    .dg-opt:active { border-color:#0d6efd; background:#eaf3ff; }
    .dg-sub { display:block; font-size:0.78rem; font-weight:400; color:#8593a4; margin-top:0.15rem; }
    .dg-back { font-size:0.85rem; color:#8593a4; text-decoration:none; }
    .dg-badge { display:inline-block; padding:0.35rem 1rem; border-radius:50px; font-size:0.82rem; font-weight:700; margin-bottom:0.8rem; }
    .dg-result-title { font-weight:800; font-size:1.4rem; line-height:1.5; color:#2c3e50; }
    .dg-note { background:#f4f9ff; border-left:3px solid #0d6efd; border-radius:0 10px 10px 0; padding:0.8rem 1rem; font-size:0.9rem; line-height:1.9; margin-top:1rem; color:#2c3e50; }
    .dg-caveat { background:#fff8ec; border-left:3px solid #f0a832; border-radius:0 10px 10px 0; padding:0.8rem 1rem; font-size:0.88rem; line-height:1.9; margin-top:0.8rem; color:#6b5417; }
    .dg-price { font-size:1.05rem; color:#2c3e50; }
    .dg-price strong { font-size:1.6rem; color:#0d6efd; }
    .dg-muted { color:#8593a4; }
  `;

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
  function ga(name, params) { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); }

  function mount(root, opts = {}) {
    if (!root) return;
    const source = opts.source || 'page';

    if (!document.getElementById('dgStyle')) {
      const st = document.createElement('style');
      st.id = 'dgStyle';
      st.textContent = CSS;
      document.head.appendChild(st);
    }

    root.innerHTML = '<div class="dg-progress"><div style="width:0%"></div></div><div class="dg-stage"></div>';
    const bar = root.querySelector('.dg-progress > div');
    const stage = root.querySelector('.dg-stage');
    const answers = {};
    let step = 0;

    function scrollTop() {
      root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderQuestion() {
      const q = QUESTIONS[step];
      bar.style.width = `${(step / QUESTIONS.length) * 100}%`;
      stage.innerHTML = `
        <div class="dg-card">
          <div class="dg-num">Q${step + 1} / ${QUESTIONS.length}</div>
          <div class="dg-title">${esc(q.title)}</div>
          ${q.opts.map((o, i) => `
            <button type="button" class="dg-opt" data-i="${i}">
              <i class="bi ${o.icon}"></i>
              <span>${esc(o.label)}${o.sub ? `<span class="dg-sub">${esc(o.sub)}</span>` : ''}</span>
            </button>`).join('')}
          ${step > 0 ? '<div class="text-center mt-2"><a href="#" class="dg-back" data-act="back"><i class="bi bi-arrow-left me-1"></i>ひとつ前に戻る</a></div>' : ''}
        </div>`;
      stage.querySelectorAll('.dg-opt').forEach(btn => {
        btn.addEventListener('click', () => {
          answers[q.key] = q.opts[Number(btn.dataset.i)].v;
          if (step === 0) ga('diagnosis_start', { source });
          step += 1;
          if (step < QUESTIONS.length) renderQuestion(); else renderResult();
          scrollTop();
        });
      });
      stage.querySelector('[data-act="back"]')?.addEventListener('click', (e) => {
        e.preventDefault();
        step -= 1;
        renderQuestion();
      });
    }

    function renderResult() {
      bar.style.width = '100%';
      const a = answers;
      const verdict = judge(a);

      const acctNote = {
        outsource: '税理士・会計事務所には、<strong>CSVやスプレッドシートの共有で渡すだけ</strong>になります。領収書の原本を封筒で送る作業から卒業できます。',
        'self-own': '会計ソフトには<strong>CSVで取り込めます</strong>（勘定科目・税区分つき）。手入力の二度打ちがなくなります。',
        'self-tax': '会計ソフトには<strong>CSVで取り込めます</strong>（勘定科目・税区分つき）。申告を依頼している税理士にも、CSVやスプレッドシートの共有でそのまま渡せます。',
        piled: '経費ログは<strong>「撮って送るだけ」</strong>なので、その場で記録が終わり、レシートが溜まりません。溜まりがちな方にこそ向いています。',
      }[a.accounting] || '';

      const caveats = [];
      if (a.accounting === 'outsource') {
        caveats.push('記帳をお任せしている場合、事務所へのデータの渡し方が変わります。<strong>導入の前に、顧問税理士にも一言ご相談のうえお決めください。</strong>税理士さんに見せられる<a href="/for-accountants">会計事務所向けのご案内ページ</a>もあります。');
      }
      if (a.accounting === 'self-own') {
        caveats.push('CSVの取り込み（会計ソフト側での列の対応づけ）は<strong>ご自身で行っていただく形</strong>になります。CSV操作に不安がある場合は活かしきれない可能性があるため、まず無料トライアルで実際のCSVをお試しください。');
      }
      if (a.size === 's31') {
        caveats.push('従業員31名以上とのこと。経費ログは1チーム定額でそのまま使えますが、<strong>多段階承認や事前申請などの複雑なワークフローが必須</strong>の場合は、大手の経費精算SaaSとの比較もおすすめします（経費ログは意図的にそれらを搭載していません）。');
      }
      if (a.revenue === 'r5plus') {
        caveats.push('売上5億円超の場合、消費税の仕入税額控除で個別対応（いわゆる95%ルールの適用外）が必要になることがあります。経費ログは税区分つきでデータを出せますが、<strong>運用は顧問税理士に一度ご相談ください</strong>。');
      }

      let html = '';
      if (verdict === 'no-need') {
        html = `
          <div class="dg-card text-center">
            <span class="dg-badge" style="background:#eef2f7;color:#5a6b7f;">診断結果</span>
            <div class="dg-result-title mb-2">いまは、まだ必要ないかもしれません</div>
            <p class="dg-muted" style="font-size:0.92rem;line-height:1.9;">
              領収書が月5枚以下なら、<br class="d-none d-sm-block">
              現状のやり方で十分回っている可能性が高いです。<br>
              無理に導入をおすすめしません。
            </p>
            <div class="dg-note text-start">
              件数が増えてきたら、また思い出してください。<br>
              2週間の無料トライアル（カード登録不要）はいつでも試せます。
            </div>
            <a href="/app?demo" class="btn btn-outline-primary rounded-pill px-4 mt-3">
              <i class="bi bi-play-circle me-1"></i>いちおうデモをさわってみる
            </a>
          </div>`;
      } else {
        const isSolo = verdict === 'solo';
        html = `
          <div class="dg-card">
            <div class="text-center">
              <span class="dg-badge" style="background:#e7f1ff;color:#0d6efd;">診断結果</span>
              <div class="dg-result-title mb-1">${isSolo ? 'ソロプランが合いそうです' : 'チームプランが合いそうです'}</div>
              <p class="dg-price mt-2 mb-1"><strong>${isSolo ? '330' : '825'}</strong> 円 / 月（税込）${isSolo ? '' : '・メンバー何人でも定額'}</p>
              <p class="dg-muted mb-0" style="font-size:0.85rem;">
                ${isSolo
                  ? 'AI領収書解析・集計・CSV・電帳法対応まで、ひとりで使う機能はすべて入っています。'
                  : 'メンバーはURLを開いてGoogleでログインするだけ。承認・精算の管理、LINEでの申請にも対応します。'}
              </p>
            </div>
            ${acctNote ? `<div class="dg-note">${acctNote}</div>` : ''}
            ${caveats.map(c => `<div class="dg-caveat"><i class="bi bi-info-circle me-1"></i>${c}</div>`).join('')}
            <div class="d-grid gap-2 mt-4">
              <a href="https://buy.stripe.com/5kQ28r1Ps7ut2kv4io9oc08" class="btn btn-primary rounded-pill py-2">
                2週間無料で使ってみる（カード登録不要）
              </a>
              <a href="/app?demo" class="btn btn-outline-primary rounded-pill py-2">
                <i class="bi bi-play-circle me-1"></i>先にデモをさわってみる
              </a>
            </div>
            <p class="text-center dg-muted mt-3 mb-0" style="font-size:0.76rem;">
              トライアル後に自動課金されることはありません。<br>プランは有料切替のときに選べば大丈夫です。
            </p>
          </div>`;
      }

      html += `
        <div class="text-center mt-3">
          <a href="#" class="dg-back" data-act="retry"><i class="bi bi-arrow-counterclockwise me-1"></i>最初からやり直す</a>
        </div>`;

      stage.innerHTML = html;
      ga('diagnosis_result', { result: verdict, source });
      stage.querySelector('[data-act="retry"]')?.addEventListener('click', (e) => {
        e.preventDefault();
        step = 0;
        for (const k of Object.keys(answers)) delete answers[k];
        renderQuestion();
        scrollTop();
      });
    }

    renderQuestion();
  }

  return { mount, judge, QUESTIONS };
})();
window.Diagnosis = Diagnosis;
