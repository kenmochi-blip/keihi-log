/**
 * Gemini API クライアント
 * APIキーは設定シート（B5）から読み取る（管理者が1つ設定、メンバーは不要）
 * ブラウザから直接呼び出すため、開発者サーバーにデータは送られない
 */
const Gemini = (() => {

  const MODEL   = 'gemini-2.5-flash-preview-04-17';
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  // 設定シートから読んだAPIキーをメモリにキャッシュ
  let _apiKey = '';

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
    const key = await _getApiKey();

    const imageParts = files.map(f => ({
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

    const resp = await fetch(`${API_URL}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            ...imageParts,
            { text: prompt }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        }
      })
    });

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
