/**
 * 経路・運賃検索プロキシ
 * Yahoo乗換で運賃を取得し、確認リンクはGoogleマップ（コンシューマー版）を使用。
 * バス停を含む経路でもGoogleマップ側で正しく表示される。
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from と to が必要です' });

  return _yahoo(req, res, from, to);
}

// ─── Yahoo乗換（運賃取得） ────────────────────────────────────────────────────

async function _yahoo(req, res, from, to) {
  // 確認リンクはGoogleマップ（バス停・徒歩含む経路も正確に表示）
  const resultUrl =
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${encodeURIComponent(from)}` +
    `&destination=${encodeURIComponent(to)}` +
    `&travelmode=transit`;

  const ticketParam = '&ticket=ic&shin=1&seat=1';

  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const jstHour = jstNow.getUTCHours();

  let sd;
  if (jstHour >= 22) {
    sd = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000);
    sd.setUTCHours(10, 0, 0, 0);
  } else if (jstHour < 6) {
    sd = new Date(jstNow);
    sd.setUTCHours(10, 0, 0, 0);
  } else {
    sd = jstNow;
  }
  const sy = sd.getUTCFullYear(), sm = sd.getUTCMonth() + 1, sdd = sd.getUTCDate();
  const sh = sd.getUTCHours(), sn = sd.getUTCMinutes();

  const yahooUrl =
    `https://transit.yahoo.co.jp/search/result?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&type=1&expkind=1&userpass=1${ticketParam}&y=${sy}&m=${sm}&d=${sdd}&hh=${sh}&m2=${sn}`;

  try {
    const resp = await fetch(yahooUrl, {
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
    const { fare, transfers } = _parseYahoo(html);

    if (!fare) {
      return res.status(404).json({ error: '運賃を取得できませんでした。駅名・バス停名を確認してください。' });
    }

    // yahooUrl: Yahoo乗換の結果ページ
    // resultUrl: Google Maps のルート検索URL（transit）
    const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ fare, transfers, resultUrl, yahooUrl });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Yahoo乗換への接続がタイムアウトしました' });
    }
    return res.status(500).json({ error: err.message });
  }
}

function _parseYahoo(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&yen;/g, '¥')
    .replace(/\s+/g, ' ');

  // ① IC系合計運賃を優先（IC優先・IC展示・IC運賃 etc.）
  const icFares = [...text.matchAll(/IC[^\s:：]*\s*[：:]\s*([\d,]+)\s*円/g)]
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(v => v >= 100 && v < 100000);
  let fare = icFares.length > 0 ? Math.min(...icFares) : null;

  // ② IC運賃なし → 指定席・自由席の最大値（区間運賃ではなく合計に近い値）
  if (!fare) {
    const seatFares = [...text.matchAll(/(?:指定席|自由席)\s*[：:]\s*([\d,]+)\s*円/g)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(v => v >= 100 && v < 100000);
    if (seatFares.length > 0) fare = Math.max(...seatFares);
  }

  // ③ 汎用フォールバック
  if (!fare) {
    const allFares = [...text.matchAll(/([\d,]+)\s*円/g)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(v => v >= 100 && v <= 50000);
    if (allFares.length > 0) fare = Math.min(...allFares);
  }

  const transferSet = new Set();
  for (const m of text.matchAll(/([一-鿿ぁ-ゖァ-ヶー]{2,6}(?:駅|バス停)?)\s*\d+分乗換/g)) {
    const name = m[1].replace(/(?:駅|バス停)$/, '').trim();
    if (name.length >= 2) transferSet.add(name);
    if (transferSet.size >= 4) break;
  }

  return { fare, transfers: [...transferSet] };
}
