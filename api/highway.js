/**
 * 高速料金取得プロキシ
 * Yahoo乗換の車ルート印刷ページをスクレイピングして高速料金を返す
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from と to が必要です' });

  // IC名の揺れを吸収: 末尾にIC/インター/インターチェンジがなければ「IC」を付与して候補を生成
  const _variants = (name) => {
    if (/IC$|インター(チェンジ)?$/.test(name)) return [name];
    return [name + 'IC', name + 'インターチェンジ', name];
  };
  const fromList = _variants(from);
  const toList   = _variants(to);

  // resultUrlはオリジナル入力値を使用（IC自動補完は内部試行のみ、URLに反映しない）
  const resultUrl =
    `https://transit.yahoo.co.jp/search/car?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&type=1`;

  // 組み合わせを順に試してtollが取れた時点で返す
  let toll = null, km = null;
  outer: for (const f of fromList) {
    for (const t of toList) {
      const printUrl =
        `https://transit.yahoo.co.jp/search/car?` +
        `from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}&type=1&ws=3`;
      try {
        const resp = await fetch(printUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ja,en-US;q=0.9',
            'Accept': 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) continue;
        const parsed = _parse(await resp.text());
        if (parsed.toll) { toll = parsed.toll; km = parsed.km; break outer; }
        if (!km && parsed.km) km = parsed.km;
      } catch { /* 次の候補へ */ }
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ toll, km, resultUrl });
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
