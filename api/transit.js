/**
 * Yahoo乗換 最安値取得プロキシ
 * クライアントからCORSなしでYahoo Transit HTMLを取得・解析して返す
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const { from, to, mode } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from と to が必要です' });

  // 電車・バス共通で IC 優先（Yahoo乗換が最安値を自動選択）
  const ticketParam = '&ticket=ic';

  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const jstHour = jstNow.getUTCHours();

  // 22時〜翌6時は翌朝10時に丸める（終電・始発を避けて昼間の便を取得）
  // それ以外は現在時刻をそのまま使用。printUrlとresultUrlを同じ時刻で統一。
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

  // search/result（複数ルート一覧）を取得して全ルートのIC運賃から最安値を選ぶ
  // type=1（到着時刻順）で現在時刻以降の便を取得。printUrlとresultUrlは同じURL。
  const resultUrl =
    `https://transit.yahoo.co.jp/search/result?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&type=1&expkind=1&userpass=1${ticketParam}&y=${sy}&m=${sm}&d=${sdd}&hh=${sh}&m2=${sn}`;

  const printUrl = resultUrl; // 同じページを取得して複数ルートから最安値を解析

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
    const { fare, minutes, transfers } = _parse(html);

    if (!fare) {
      return res.status(404).json({ error: '運賃を取得できませんでした。駅名を確認してください。' });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ fare, minutes, transfers, resultUrl });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return res.status(504).json({ error: 'Yahoo乗換への接続がタイムアウトしました' });
    }
    res.status(500).json({ error: err.message });
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

  // --- IC運賃の抽出（search/resultの複数ルートから最安値を選択）---
  // 結果一覧ページのIC優先運賃は "IC優先：387円" 形式で各ルートに記載されている
  // matchAllで全ルート分を拾い Math.min() で最安値を得る
  const icFares = [...text.matchAll(/IC(?:優先)?\s*[：:]\s*([\d,]+)\s*円/g)]
    .map(m => parseInt(m[1].replace(/,/g, ''), 10))
    .filter(v => v >= 100 && v < 100000);
  let fare = icFares.length > 0 ? Math.min(...icFares) : null;

  // IC表記なし → 汎用パターンで最安値を探す
  if (!fare) {
    const allFares = [...text.matchAll(/([\d,]+)\s*円/g)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(v => v >= 100 && v <= 50000);
    if (allFares.length > 0) fare = Math.min(...allFares);
  }

  // --- 所要時間 ---
  const timeHourMin = text.match(/(\d+)\s*時間\s*(\d+)\s*分/);
  const timeHourOnly = text.match(/(\d+)\s*時間/);
  const timeMinOnly = text.match(/(\d+)\s*分/);
  let minutes = null;
  if (timeHourMin) minutes = parseInt(timeHourMin[1], 10) * 60 + parseInt(timeHourMin[2], 10);
  else if (timeHourOnly) minutes = parseInt(timeHourOnly[1], 10) * 60;
  else if (timeMinOnly) minutes = parseInt(timeMinOnly[1], 10);

  // --- 乗換駅（中間駅）の抽出 ---
  // 実際の乗換には「○○ 3分乗換」のように待ち時間が付く
  // ナビUI（「乗換案内」「乗換が少ない順」等）には数字がないので区別できる
  const transferSet = new Set();
  const transferRe = /([一-鿿ぁ-ゖァ-ヶー]{2,6}(?:駅|バス停)?)\s*\d+分乗換/g;
  for (const m of text.matchAll(transferRe)) {
    const name = m[1].replace(/(?:駅|バス停)$/, '').trim();
    if (name.length >= 2) transferSet.add(name);
    if (transferSet.size >= 4) break;
  }
  const transfers = [...transferSet];

  return { fare, minutes, transfers };
}
