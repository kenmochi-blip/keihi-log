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

  /**
   * 領収書画像を解析してJSON情報を返す
   * @param {Array<{base64: string, mimeType: string}>} files
   * @param {string[]} categories 勘定科目リスト
   */
  async function analyzeReceipt(files, categories) {
    // デモモード時はプロキシ経由のため画像を圧縮（Vercel 4.5MB上限対策）
    const isDemo = typeof Demo !== 'undefined' && Demo.isActive();
    const processedFiles = isDemo
      ? await Promise.all(files.map(async f => ({
          ...f,
          base64: await _compressImage(f.base64, f.mimeType),
          mimeType: f.mimeType.startsWith('image/') ? 'image/jpeg' : f.mimeType,
        })))
      : files;

    const imageParts = processedFiles.map(f => ({
      inlineData: {
        mimeType: f.mimeType,
        data: f.base64.replace(/^data:[^;]+;base64,/, ''),
      }
    }));

    const prompt = `
以下の領収書画像を解析して、JSON形式で情報を抽出してください。
勘定科目は次のリストから最も適切なものを選んでください：${categories.join('、')}

必ず以下のJSON形式で回答してください（コードブロックなし）：
{
  "date": "YYYY-MM-DD",
  "shop": "支払先名",
  "invoice": "T+13桁のインボイス番号またはnull",
  "total_amount": 金額（日本円の場合）またはnull（外貨の場合）,
  "category": "勘定科目（単一カテゴリの場合）",
  "items": [{"amount": 金額, "category": "勘定科目"}] または null（明細分割の場合のみ使用）,
  "fx_currency": "USD/EUR等の通貨コードまたはnull",
  "fx_amount": 外貨金額またはnull
}

注意：
- 金額が日本円なら total_amount に数値を入れ fx_* は null
- 外貨なら total_amount は null にして fx_currency と fx_amount を埋める
- 複数カテゴリに分けられる場合は items を使い category は null
- インボイス番号は T+13桁の数字で始まる番号
`;

    const body = JSON.stringify({
      contents: [{ parts: [...imageParts, { text: prompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    });

    // デモモード：サーバーサイドプロキシ経由（APIキーをフロントに持たない）
    let resp;
    if (typeof Demo !== 'undefined' && Demo.isActive()) {
      const apiBase = window.APP_CONFIG?.apiBase || '';
      resp = await fetch(`${apiBase}/api/gemini-proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } else {
      const key = await _getApiKey();
      resp = await fetch(`${API_URL}?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini API error: ${resp.status}`);
    }

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

  return { analyzeReceipt, clearApiKey };
})();
