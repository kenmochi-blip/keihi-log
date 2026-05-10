/**
 * 高速料金取得プロキシ
 * Yahoo乗換の車ルート印刷ページをスクレイピングして高速料金を返す
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from と to が必要です' });

  const resultUrl =
    `https://map.yahoo.co.jp/route/car?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const printUrl =
    `https://transit.yahoo.co.jp/search/car?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&type=1&ws=3`;

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
      return res.json({ toll: null, km: null, resultUrl });
    }

    const html = await resp.text();
    const { toll, km } = _parse(html);

    res.setHeader('Cache-Control', 'no-store');
    res.json({ toll, km, resultUrl });
  } catch (err) {
    res.json({ toll: null, km: null, resultUrl });
  }
}

function _parse(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&yen;/g, '¥')
    .replace(/\s+/g, ' ');

  let toll = null;
  const tollPatterns = [
    /ETC\s*[：:]?\s*([\d,]+)\s*円/,
    /高速料金\s*[：:]?\s*([\d,]+)\s*円/,
    /有料道路\s*[：:]?\s*([\d,]+)\s*円/,
    /通行料\s*[：:]?\s*([\d,]+)\s*円/,
    /料金\s*[：:]?\s*([\d,]+)\s*円/,
  ];
  for (const p of tollPatterns) {
    const m = text.match(p);
    if (m) {
      const v = parseInt(m[1].replace(/,/g, ''), 10);
      if (v > 0 && v < 100000) { toll = v; break; }
    }
  }

  let km = null;
  const kmMatch = text.match(/(\d+(?:\.\d+)?)\s*km/i);
  if (kmMatch) km = parseFloat(kmMatch[1]);

  return { toll, km };
}
