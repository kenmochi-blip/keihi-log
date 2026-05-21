/**
 * 経路・運賃検索プロキシ
 * GOOGLE_MAPS_API_KEY が設定されていれば Google Maps Directions API を使用。
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

// ─── Google Maps Directions API ──────────────────────────────────────────────

function _addStation(name) {
  // バス停・空港など駅以外のキーワードが含まれる場合はそのまま
  if (/(?:バス停|空港|港|IC|インター|ターミナル|バスターミナル)/.test(name)) return name;
  // 既に「駅」で終わっていればそのまま
  if (name.endsWith('駅')) return name;
  return name + '駅';
}

async function _googleMaps(req, res, from, to) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const resultUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

  const fromQ = _addStation(from) + ',Japan';
  const toQ   = _addStation(to) + ',Japan';

  try {
    // departure_time は現在時刻+5分を指定（コールドスタート遅延対策）
    const departureTime = Math.floor(Date.now() / 1000) + 300;
    const url = `https://maps.googleapis.com/maps/api/directions/json?` +
      `origin=${encodeURIComponent(fromQ)}&` +
      `destination=${encodeURIComponent(toQ)}&` +
      `mode=transit&` +
      `departure_time=${departureTime}&` +
      `region=jp&` +
      `language=ja&` +
      `key=${apiKey}`;

    console.log('Google Maps query:', fromQ, '->', toQ);
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!resp.ok) {
      console.error('Google Maps HTTP error:', resp.status);
      return _yahoo(req, res, from, to);
    }

    const data = await resp.json();

    if (data.status !== 'OK' || !data.routes?.length) {
      console.error('Google Maps status:', data.status, '| query:', fromQ, '->', toQ);
      return _yahoo(req, res, from, to);
    }

    // 運賃（複数ルートから最安値）
    let fare = null;
    for (const route of data.routes) {
      if (route.fare?.value) {
        const v = Math.round(route.fare.value);
        if (!fare || v < fare) fare = v;
      }
    }

    // 乗換駅の抽出（transit steps の出発停留所）
    const transfers = [];
    const route = data.routes[0];
    for (const leg of (route.legs || [])) {
      for (const step of (leg.steps || [])) {
        if (step.travel_mode === 'TRANSIT') {
          const dep = step.transit_details?.departure_stop?.name;
          if (dep && !transfers.includes(dep) && transfers.length < 3) {
            transfers.push(dep.replace(/駅$/, ''));
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
