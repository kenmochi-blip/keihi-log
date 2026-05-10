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

  // printUrl: 翌日9時固定（常に未来時刻 → 終電に進まない。運賃は時間帯依存なし）
  const jstTomorrow = new Date(jstNow.getTime() + 24 * 60 * 60 * 1000);
  const ty = jstTomorrow.getUTCFullYear();
  const tm = jstTomorrow.getUTCMonth() + 1;
  const td = jstTomorrow.getUTCDate();

  // resultUrl: 現在のJST時刻（ユーザーが検索した時点の電車を表示）
  const ry = jstNow.getUTCFullYear();
  const rm = jstNow.getUTCMonth() + 1;
  const rd = jstNow.getUTCDate();
  const rh = jstNow.getUTCHours();
  const rn = jstNow.getUTCMinutes();

  const printUrl =
    `https://transit.yahoo.co.jp/search/print?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&type=3&expkind=1&userpass=1&ws=3${ticketParam}&y=${ty}&m=${tm}&d=${td}&hh=9&m2=0`;

  const resultUrl =
    `https://transit.yahoo.co.jp/search/result?` +
    `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
    `&type=3&expkind=1&userpass=1${ticketParam}&y=${ry}&m=${rm}&d=${rd}&hh=${rh}&m2=${rn}`;

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

    res.setHeader('Cache-Control', 'no-store'); // 時刻パラメータが含まれるためキャッシュ無効
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

  // --- IC運賃の抽出（最初にマッチした合計IC運賃を採用）---
  // type=2（料金安い順）でリクエストするため先頭ルートが最安値
  // Math.min()は区間ごとの部分運賃を拾うため使用しない
  const icFareMatch = text.match(/IC\s*[：:]?\s*([\d,]+)\s*円/);
  const icFareVal = icFareMatch ? parseInt(icFareMatch[1].replace(/,/g, ''), 10) : 0;
  let fare = (icFareVal >= 100 && icFareVal < 100000) ? icFareVal : null;

  if (!fare) {
    // IC表記なし → 合計・運賃・料金パターンを順に試す
    for (const p of [
      /合計\s*IC\s*([\d,]+)\s*円/,
      /IC優先\s*([\d,]+)\s*円/,
      /運賃[\s\S]{0,30}?([\d,]+)\s*円/,
      /料金[\s\S]{0,30}?([\d,]+)\s*円/,
    ]) {
      const m = text.match(p);
      if (m) {
        const v = parseInt(m[1].replace(/,/g, ''), 10);
        if (v >= 100 && v < 100000) { fare = v; break; }
      }
    }
  }
  // 最終フォールバック：妥当な範囲の最初の円表記
  if (!fare) {
    for (const m of text.matchAll(/([\d,]+)\s*円/g)) {
      const v = parseInt(m[1].replace(/,/g, ''), 10);
      if (v >= 100 && v <= 50000) { fare = v; break; }
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
