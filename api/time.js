/**
 * サーバー時刻発行 API（電帳法対応）
 * クライアントの時計操作による日時改ざんを防ぐためサーバー側で時刻を発行する
 * ライセンスキーが渡された場合、月次申請カウンターをインクリメントする
 */
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 月次申請カウンター（件数のみ記録、経費内容は一切記録しない）
  // TTL: 分析（最大36ヶ月）を削らない範囲で末端キーの無限増加を防ぐため4年。
  //   月初の初回インクリメント(=1)時のみ expire を張り、過去月のキーは増えないので
  //   最後の書き込みから4年後に自然消滅する（KVコマンド数を毎回倍増させない）。
  const USAGE_TTL_SEC = 60 * 60 * 24 * 365 * 4;
  const key = req.method === 'POST' ? (req.body?.key || '') : (req.query?.key || '');
  if (key && key.startsWith('KL-')) {
    const ym = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    const usageKey = `usage:${key}:${ym}`;
    kv.incr(usageKey)
      .then(n => { if (n === 1) return kv.expire(usageKey, USAGE_TTL_SEC); })
      .catch(err => console.error('Usage increment failed:', err));
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    serverTime: new Date().toISOString(),
    jst: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
  });
}
