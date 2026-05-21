/**
 * 経路・運賃検索プロキシ
 * GOOGLE_MAPS_API_KEY が設定されていれば Google Maps Routes API を使用。
 * 未設定の場合は Yahoo乗換スクレイピングにフォールバック。
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from と to が必要です' });

  if (process.env.GOOGLE_MAPS_API_KEY) {
    return _googleMaps(req, res, from, to);
  }
  return _yahoo(req, res, from, to);
}

// ─── Google Maps Routes API ───────────────────────────────────────────────────

async function _googleMaps(req, res, from, to) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const resultUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

  try {
    const resp = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.fare,routes.legs.steps.transitDetails,routes.localizedValues',
      },
      body: JSON.stringify({
        origin: { address: `${from},日本` },
        destination: { address: `${to},日本` },
        travelMode: 'TRANSIT',
        transitPreferences: {
          routingPreference: 'FEWER_TRANSFERS',
          allowedTravelModes: ['TRAIN', 'SUBWAY', 'BUS', 'TRAM', 'RAIL'],
        },
        languageCode: 'ja',
        units: 'METRIC',
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Google Maps error:', err);
      // Google Maps が失敗したら Yahoo にフォールバック
      return _yahoo(req, res, from, to);
    }

    const data = await resp.json();
    const route = data.routes?.[0];

    // 運賃の取得（日本円）
    let fare = null;
    const fareText = route?.fare?.localizedValues?.price?.text || '';
    const fareMatch = fareText.match(/([\d,]+)/);
    if (fareMatch) fare = parseInt(fareMatch[1].replace(/,/g, ''), 10);

    // 乗換駅の抽出（transit steps の到着駅）
    const transfers = [];
    if (route?.legs) {
      for (const leg of route.legs) {
        for (const step of (leg.steps || [])) {
          const td = step.transitDetails;
          if (td?.stopDetails?.arrivalStop?.name && transfers.length < 3) {
            const name = td.stopDetails.arrivalStop.name;
            // 最終目的地は除く
            if (!name.includes(to.replace(/駅|バス停/, ''))) {
              transfers.push(name.replace(/駅$/, ''));
            }
          }
        }
      }
    }

    if (!fare) {
      // 運賃が取れなかった場合は Yahoo にフォールバック
      return _yahoo(req, res, from, to);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ fare, transfers, resultUrl });
  } catch (err) {
    console.error('Google Maps exception:', err.message);
    return _yahoo(req, res, from, to);
  }
}

// ─── Yahoo乗換フォールバック ──────────────────────────────────────────────────

async function _yahoo(req, res, from, to) {
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

  const resultUrl =
    `https://transit.yahoo.co.jp/search/result?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&type=1&expkind=1&userpass=1${ticketParam}&y=${sy}&m=${sm}&d=${sdd}&hh=${sh}&m2=${sn}`;

  try {
    const resp = await fetch(resultUrl, {
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

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ fare, transfers, resultUrl });
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
