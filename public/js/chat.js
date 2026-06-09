/**
 * サポートチャットウィジェット
 * FAQをシステムプロンプトとしたClaude Haikuによる自動回答
 */
const SupportChat = (() => {
  const QUICK_REPLIES = {
    setup: [
      'ライセンスキーが無効と表示される',
      'Gemini APIキーの取得方法',
      '電帳法対応は必須ですか',
      'セットアップが失敗する',
    ],
    submit: [
      'AI解析で読み取れない場合は',
      '外貨の経費はどう入力する',
      'バス・電車の運賃検索ができない',
      '会社払いの登録方法',
    ],
    list: [
      '申請済・登録済・精算済の違い',
      '承認（登録済にする）方法',
      '提出済みの申請を修正したい',
      '精算解除の方法',
    ],
    summary: [
      '集計の絞り込み方法',
      '精算処理の方法',
      'CSVでエクスポートできますか',
      '特定メンバーの集計を見たい',
    ],
    settings: [
      'Gemini APIキーの設定方法',
      'メンバーの権限変更',
      'プランの変更・解約方法',
      'ライセンスの有効期限確認',
    ],
  };

  let _history = [];
  let _open = false;
  let _context = 'app'; // 'setup' | 'app'

  function _el(id) { return document.getElementById(id); }

  function init() {
    _render();
    _bind();
    _renderQuickReplies();
  }

  function _render() {
    const wrap = document.createElement('div');
    wrap.id = 'supportChatRoot';
    wrap.innerHTML = `
      <!-- FABボタン -->
      <button class="chat-fab" id="chatFab" aria-label="サポートチャットを開く">
        <span class="fab-icon"><i class="bi bi-chat-dots-fill"></i></span>
        ヘルプ
      </button>

      <!-- チャットウィンドウ -->
      <div class="chat-window d-none" id="chatWindow" role="dialog" aria-label="サポートチャット">
        <div class="chat-header">
          <div class="chat-header-icon"><i class="bi bi-robot"></i></div>
          <div class="chat-header-info">
            <div class="chat-header-title">サポートAI</div>
            <div class="chat-header-sub">FAQをもとに回答します</div>
          </div>
          <button class="chat-close-btn" id="chatReset" aria-label="会話をリセット" title="会話をリセット"><i class="bi bi-arrow-counterclockwise"></i></button>
          <button class="chat-close-btn" id="chatClose" aria-label="閉じる"><i class="bi bi-x-lg"></i></button>
        </div>

        <div class="chat-messages" id="chatMessages">
          <!-- 初期メッセージ -->
          ${_botBubble('こんにちは！経費ログのサポートAIです。<br>ご不明な点をお気軽にどうぞ。<br><a href="https://forms.gle/wPBbW8aniDdoynXAA" target="_blank" rel="noopener" class="chat-faq-link"><i class="bi bi-megaphone me-1"></i>バグ・改善要望はこちら</a>')}
        </div>

        <div class="chat-quick-replies" id="chatQuickReplies"></div>

        <div class="chat-input-area">
          <textarea class="chat-input" id="chatInput" placeholder="質問を入力..." rows="1" maxlength="500"></textarea>
          <button class="chat-send-btn" id="chatSend" aria-label="送信"><i class="bi bi-send-fill"></i></button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  function _bind() {
    _el('chatFab').addEventListener('click', _openChat);
    _el('chatClose').addEventListener('click', _closeChat);
    _el('chatReset').addEventListener('click', _resetChat);

    _el('chatSend').addEventListener('click', _sendMessage);
    _el('chatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendMessage(); }
    });
    // テキストエリアの高さ自動調整
    _el('chatInput').addEventListener('input', () => {
      const el = _el('chatInput');
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 80) + 'px';
    });

    document.getElementById('chatQuickReplies').addEventListener('click', e => {
      const btn = e.target.closest('.chat-qr-btn');
      if (!btn) return;
      _el('chatInput').value = btn.dataset.msg;
      _sendMessage();
    });
  }

  function _openChat() {
    _open = true;
    _el('chatFab').classList.add('d-none');
    _el('chatWindow').classList.remove('d-none');
    _el('chatInput').focus();
  }

  function _closeChat() {
    _open = false;
    _el('chatWindow').classList.add('d-none');
    _el('chatFab').classList.remove('d-none');
  }

  function _resetChat() {
    _history = [];
    const msgs = _el('chatMessages');
    msgs.innerHTML = _botBubble('こんにちは！経費ログのサポートAIです。<br>ご不明な点をお気軽にどうぞ。<br><a href="https://forms.gle/wPBbW8aniDdoynXAA" target="_blank" rel="noopener" class="chat-faq-link"><i class="bi bi-megaphone me-1"></i>バグ・改善要望はこちら</a>');
    _renderQuickReplies();
    _el('chatQuickReplies').classList.remove('d-none');
  }

  function _renderQuickReplies() {
    const replies = QUICK_REPLIES[_context] || QUICK_REPLIES.submit;
    _el('chatQuickReplies').innerHTML = replies
      .map(q => `<button class="chat-qr-btn" data-msg="${q}">${q}</button>`).join('');
  }

  function setContext(ctx) {
    _context = QUICK_REPLIES[ctx] ? ctx : 'submit';
    _renderQuickReplies();
  }

  async function _sendMessage() {
    const input = _el('chatInput');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    input.style.height = 'auto';

    // クイック返信を非表示（一度使ったら隠す）
    _el('chatQuickReplies').classList.add('d-none');

    _appendBubble('user', message);
    _history.push({ role: 'user', content: message });

    const typingId = _appendTyping();
    _el('chatSend').disabled = true;

    try {
      const apiBase = window.APP_CONFIG?.apiBase || '';
      const resp = await fetch(`${apiBase}/api/data/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history: _history.slice(-8) }),
      });

      _removeTyping(typingId);

      if (resp.status === 429) {
        _appendBubbleHtml('bot', '申し訳ありません。利用制限に達しました。1時間後に再試行してください。');
        return;
      }
      if (!resp.ok) throw new Error('server_error');

      const data = await resp.json();
      const reply = data.reply || '回答を取得できませんでした。';
      _history.push({ role: 'assistant', content: reply });

      // FAQリンクをアンカータグに変換
      const html = _formatReply(reply);
      _appendBubbleHtml('bot', html);

    } catch (_) {
      _removeTyping(typingId);
      _appendBubbleHtml('bot', '通信エラーが発生しました。再試行してください。<br><a href="/faq" class="chat-faq-link">FAQを直接見る</a>');
    } finally {
      _el('chatSend').disabled = false;
      _el('chatInput').focus();
    }
  }

  function _formatReply(text) {
    // /faq#qXXX を clickable リンクに変換
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return escaped
      .replace(/\n/g, '<br>')
      .replace(/(詳細: )(\/faq#q\d+)/g, '<a href="$2" class="chat-faq-link"><i class="bi bi-question-circle me-1"></i>$1$2</a>');
  }

  function _botBubble(html) {
    return `<div class="chat-bubble-wrap">
      <div class="chat-avatar"><i class="bi bi-robot" style="font-size:0.7rem;"></i></div>
      <div class="chat-bubble is-bot">${html}</div>
    </div>`;
  }

  function _appendBubble(role, text) {
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    _appendBubbleHtml(role, escaped);
  }

  function _appendBubbleHtml(role, html) {
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = `chat-bubble-wrap${isUser ? ' is-user' : ''}`;
    div.innerHTML = isUser
      ? `<div class="chat-avatar is-user"><i class="bi bi-person" style="font-size:0.7rem;"></i></div>
         <div class="chat-bubble is-user">${html}</div>`
      : `<div class="chat-avatar"><i class="bi bi-robot" style="font-size:0.7rem;"></i></div>
         <div class="chat-bubble is-bot">${html}</div>`;
    const msgs = _el('chatMessages');
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function _appendTyping() {
    const id = 'typing_' + Date.now();
    const div = document.createElement('div');
    div.className = 'chat-bubble-wrap';
    div.id = id;
    div.innerHTML = `<div class="chat-avatar"><i class="bi bi-robot" style="font-size:0.7rem;"></i></div>
      <div class="chat-bubble is-bot chat-typing"><span></span><span></span><span></span></div>`;
    const msgs = _el('chatMessages');
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return id;
  }

  function _removeTyping(id) {
    document.getElementById(id)?.remove();
  }

  return { init, setContext };
})();
