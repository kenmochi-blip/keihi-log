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
  const key = req.method === 'POST' ? (req.body?.key || '') : (req.query?.key || '');
  if (key && key.startsWith('KL-')) {
    const ym = new Date().toISOString().slice(0, 7); // "YYYY-MM"
    kv.incr(`usage:${key}:${ym}`).catch(err => console.error('Usage increment failed:', err));
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    serverTime: new Date().toISOString(),
    jst: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
  });
}
