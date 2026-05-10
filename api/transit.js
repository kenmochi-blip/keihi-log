/**
 * Yahoo乗換 最安値取得プロキシ
 * クライアントからCORSなしでYahoo Transit HTMLを取得・解析して返す
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { from, to, mode } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from と to が必要です' });

  // バスモードは IC 優先なし、電車はIC優先
  const ticketParam = mode === 'bus' ? '' : '&ticket=ic';

  // Vercel は UTC 動作のため JST (UTC+9) に変換して Yahoo 乗換に渡す
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y  = jst.getUTCFullYear();
  const mo = jst.getUTCMonth() + 1;
  const d  = jst.getUTCDate();
  const hh = jst.getUTCHours();
  const m2 = jst.getUTCMinutes();
  const timeParams = `&y=${y}&m=${mo}&d=${d}&hh=${hh}&m2=${m2}`;

  const printUrl =
    `https://transit.yahoo.co.jp/search/print?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&type=2&expkind=1&userpass=1&ws=3${ticketParam}${timeParams}`;

  const resultUrl =
    `https://transit.yahoo.co.jp/search/result?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&type=2&expkind=1&userpass=1${ticketParam}${timeParams}`;

  try {
    const resp = await fetch(printUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ja,en-US;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      return res.status(502).json({ error: `Yahoo乗換がエラーを返しました (${resp.status})` });
    }

    const html = await resp.text();
    const { fare, minutes, lines } = _parse(html);

    if (!fare) {
      return res.status(404).json({ error: '運賃を取得できませんでした。駅名を確認してください。' });
    }

    res.setHeader('Cache-Control', 's-maxage=1800'); // 30分キャッシュ
    res.json({ fare, minutes, lines, resultUrl });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Yahoo乗換への接続がタイムアウトしました' });
    }
    res.status(500).json({ error: err.message });
  }
}

function _parse(html) {
  // スクリプト・スタイルを除去してテキスト化
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&yen;/g, '¥')
    .replace(/\s+/g, ' ');

  // --- IC運賃の抽出 ---
  // Yahoo乗換の印刷ページは "IC 230円" や "IC　230円" のような形式
  let fare = null;
  const farePatterns = [
    /IC\s*[：:]?\s*([\d,]+)\s*円/,       // "IC 230円" / "IC: 230円"
    /合計\s*IC\s*([\d,]+)\s*円/,         // "合計 IC 230円"
    /IC優先\s*([\d,]+)\s*円/,            // "IC優先 230円"
    /運賃[\s\S]{0,30}?([\d,]+)\s*円/,   // "運賃 ... 230円"
    /料金[\s\S]{0,30}?([\d,]+)\s*円/,   // "料金 ... 230円"
  ];
  for (const p of farePatterns) {
    const m = text.match(p);
    if (m) {
      fare = parseInt(m[1].replace(/,/g, ''), 10);
      if (fare > 0 && fare < 100000) break; // 妥当な範囲にある場合のみ採用
      fare = null;
    }
  }
  // 最終フォールバック：最初に出てくる円表記（ただし1件目が時刻などでないか検証）
  if (!fare) {
    const all = [...text.matchAll(/([\d,]+)\s*円/g)];
    for (const m of all) {
      const v = parseInt(m[1].replace(/,/g, ''), 10);
      if (v >= 100 && v <= 50000) { fare = v; break; } // 100円〜50,000円を妥当な運賃と判断
    }
  }

  // --- 所要時間 ---
  const timeMatch = text.match(/(\d+)\s*分/);
  const minutes = timeMatch ? parseInt(timeMatch[1], 10) : null;

  // --- 路線名 ---
  const lineSet = new Set();
  const lineRe = /([^\s　、。「」（）\d]{2,10}(?:線|鉄道|地下鉄|モノレール|ライナー|エクスプレス|バス))/g;
  for (const m of text.matchAll(lineRe)) {
    lineSet.add(m[1]);
    if (lineSet.size >= 5) break;
  }
  const lines = [...lineSet];

  return { fare, minutes, lines };
}
