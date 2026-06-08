/**
 * Gemini API クライアント
 * APIキーは設定シート（B5）から読み取る（管理者が1つ設定、メンバーは不要）
 * ブラウザから直接呼び出すため、開発者サーバーにデータは送られない
 */
const Gemini = (() => {

  const MODEL   = 'gemini-2.5-flash';
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  // 設定シートから読んだAPIキーをメモリにキャッシュ
  let _apiKey = '';

  // 画像をCanvas経由でリサイズ・圧縮してbase64を返す（プロキシの4.5MB上限対策）
  async function _compressImage(base64, mimeType, maxPx = 1600, quality = 0.82) {
    if (!mimeType.startsWith('image/')) return base64; // 非画像はそのまま
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width  * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(base64);
      img.src = base64;
    });
  }

  async function _getApiKey() {
    if (_apiKey) return _apiKey;
    // まずlocalStorageの個人設定を確認（任意のオーバーライド）
    const personal = localStorage.getItem('keihi_gemini_key');
    if (personal) { _apiKey = personal; return _apiKey; }
    // 設定シートのB5を読む
    try {
      const val = await Sheets.readSetting('B5');
      if (val) { _apiKey = val; return _apiKey; }
    } catch (_) {}
    throw new Error('Gemini APIキーが設定されていません。管理者に設定シートへのキー入力を依頼してください。');
  }

  /** APIキーをプリフェッチしてキャッシュに乗せる（呼び出し元はawait不要） */
  function warmup() {
    // B' プロキシモードではキーをブラウザに持たない（サーバーが代理保持）ためプリフェッチ不要
    if (typeof Sheets !== 'undefined' && Sheets.useProxy && Sheets.useProxy()) return;
    _getApiKey().catch(() => {});
  }

  /**
   * 画像を事前圧縮してキャッシュ用に返す（ファイル選択直後に呼び出す）
   * @param {Array<{base64: string, mimeType: string, name: string}>} files
   */
  async function precompress(files) {
    return Promise.all(files.map(async f => ({
      ...f,
      base64: await _compressImage(f.base64, f.mimeType, 2000, 0.85),
      mimeType: f.mimeType.startsWith('image/') ? 'image/jpeg' : f.mimeType,
    })));
  }

  /** 呼び出し経路を選択して fetch を1回実行する */
  async function _doApiFetch(body) {
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      const apiBase = window.APP_CONFIG?.apiBase || '';
      return fetch(`${apiBase}/api/gemini-proxy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
    }
    if (typeof Sheets !== 'undefined' && Sheets.useProxy && Sheets.useProxy()) {
      const idToken = await Auth.getIdToken();
      const ssId = localStorage.getItem('keihi_sheet_id') || '';
      return fetch(`/api/data/gemini?sheetId=${encodeURIComponent(ssId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body,
      });
    }
    const key = await _getApiKey();
    return fetch(`${API_URL}?key=${key}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
  }

  /**
   * 503/429 をリトライしながら fetch する（最大3回、指数バックオフ 1→2→4秒）
   * @param {string} body
   * @param {function(attempt:number, max:number):void} [onRetry]
   */
  const _STATUS_HINT = {
    400: 'リクエスト不正（画像が破損しているか、対応していない形式の可能性があります）',
    401: 'APIキーが無効です。設定シートのGemini APIキーを確認してください',
    403: 'APIキーに権限がありません。Google AI StudioでGemini APIが有効になっているか確認してください',
    404: 'モデルが見つかりません。管理者にお問い合わせください',
    429: 'リクエスト制限を超えました。無料枠（1日1,500件）を超えた可能性があります',
    500: 'Geminiサーバーの内部エラーです。しばらく待ってから再試行してください',
    503: 'Geminiサーバーが一時的に過負荷です。しばらく待ってから再試行してください',
  };

  async function _fetchWithRetry(body, onRetry, maxRetries = 3) {
    const RETRYABLE = new Set([429, 503]);
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        onRetry?.(attempt, maxRetries);
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
      const resp = await _doApiFetch(body);
      if (resp.ok) return resp;
      if (!RETRYABLE.has(resp.status) || attempt === maxRetries - 1) {
        const err = await resp.json().catch(() => ({}));
        const apiMsg  = err.error?.message || '';
        const hint    = _STATUS_HINT[resp.status] || `Gemini API error: ${resp.status}`;
        throw new Error(apiMsg ? `${hint}（${apiMsg}）` : hint);
      }
      // RETRYABLE かつまだ試行回数が残っている → 次のループへ
    }
  }

  /**
   * 領収書画像を解析してJSON情報を返す
   * @param {Array<{base64: string, mimeType: string}>} files
   * @param {string[]} categories 勘定科目リスト
   * @param {boolean} alreadyCompressed 圧縮済みの場合はtrueで圧縮をスキップ
   * @param {function(attempt:number, max:number):void} [onRetry] リトライ時に呼ばれるコールバック
   */
  async function analyzeReceipt(files, categories, alreadyCompressed = false, onRetry = null) {
    // 電帳法要件（200万画素以上）を満たしつつ圧縮（2000px長辺・quality 0.85）
    // precompress済みの場合はスキップ
    const processedFiles = alreadyCompressed ? files : await Promise.all(files.map(async f => ({
      ...f,
      base64: await _compressImage(f.base64, f.mimeType, 2000, 0.85),
      mimeType: f.mimeType.startsWith('image/') ? 'image/jpeg' : f.mimeType,
    })));

    const imageParts = processedFiles.map(f => ({
      inlineData: {
        mimeType: f.mimeType,
        data: f.base64.replace(/^data:[^;]+;base64,/, ''),
      }
    }));

    const prompt = `
以下の領収書画像を解析して、JSON形式で情報を抽出してください。
勘定科目は次のリストから必ず1つ選んでください（リスト外の値は返さないこと）：${categories.join('、')}
判断が難しい場合はリストの先頭（${categories[0]}）を返し、category_fallback を true にしてください。

必ず以下のJSON形式で回答してください（コードブロックなし）：
{
  "date": "YYYY-MM-DD",
  "shop": "支払先名",
  "invoice": "T+13桁のインボイス番号またはnull",
  "total_amount": 金額（日本円の場合）またはnull（外貨の場合）,
  "category": "勘定科目（単一カテゴリの場合）",
  "category_fallback": true または false（勘定科目の判断が難しくリスト先頭を返した場合はtrue）,
  "items": [{"amount": 金額（合算後）, "category": "勘定科目", "tax_rate": "課税10%/課税8%/非課税/不課税のいずれか"}] または null（明細分割の場合のみ使用）,
  "fx_currency": "USD/EUR等の通貨コードまたはnull",
  "fx_amount": 外貨金額またはnull,
  "tax_rate": "課税10%/課税8%/混在/非課税/不課税のいずれか",
  "withholding_amount": 源泉徴収税額（整数）またはnull
}

注意：
- 金額が日本円なら total_amount に数値を入れ fx_* は null
- 外貨なら total_amount は null にして fx_currency と fx_amount を埋める
- 複数カテゴリ・税区分が混在する場合は items を使い category は null
- items の集約ルール：「勘定科目」と「税区分」の組み合わせが同じ明細は1行に合算すること
  （例：消耗品費・課税8% が3行あれば合計額で1行に、消耗品費・課税10% が別途あれば別行）
  全品目が同じ勘定科目・同じ税区分なら items は null にして category と tax_rate のみ返す
- インボイス番号は T+13桁の数字で始まる番号
- tax_rate：食品・飲料なら「課税8%」、非課税取引（医療・教育・住宅家賃等）なら「非課税」、不課税取引（給与・保険料等）なら「不課税」、複数税率混在なら「混在」、それ以外は「課税10%」
- withholding_amount：請求書に源泉徴収税額の記載がある場合のみ数値を入れる（ない場合はnull）
`;

    const body = JSON.stringify({
      contents: [{ parts: [...imageParts, { text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    });

    const resp = await _fetchWithRetry(body, onRetry);

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    try {
      return JSON.parse(text);
    } catch (_) {
      // JSONパース失敗時は正規表現で抽出を試みる
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error('AI解析結果のパースに失敗しました');
    }
  }

  /** キャッシュをクリアする（APIキーが変更された場合など） */
  function clearApiKey() { _apiKey = ''; }

  return { analyzeReceipt, precompress, warmup, clearApiKey };
})();
