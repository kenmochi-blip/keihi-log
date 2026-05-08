/**
 * サーバー時刻発行 API（電帳法対応）
 * クライアントの時計操作による日時改ざんを防ぐためサーバー側で時刻を発行する
 */
export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    serverTime: new Date().toISOString(),  // ISO 8601, UTC
    jst: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
  });
}
