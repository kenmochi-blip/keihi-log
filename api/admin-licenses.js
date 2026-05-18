/**
 * 発行済みライセンス一覧 API（管理者専用）
 * GET /api/admin-licenses?secret=ADMIN_SECRET
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // DELETE: ライセンス削除
  if (req.method === 'DELETE') {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key required' });
    const data = await kv.get(`license:${key}`).catch(() => null);
    await kv.del(`license:${key}`);
    if (data?.email) await kv.del(`email_to_license:${data.email}`).catch(() => {});
    if (data?.stripeSessionId) await kv.del(`session:${data.stripeSessionId}`).catch(() => {});
    console.log(`License deleted: ${key}`);
    return res.status(200).json({ deleted: true });
  }

  try {
    // KV から license:* キーを全スキャン
    const keys = [];
    let cursor = 0;
    do {
      const [nextCursor, batch] = await kv.scan(cursor, { match: 'license:*', count: 100 });
      keys.push(...batch);
      cursor = Number(nextCursor);
    } while (cursor !== 0);

    // 各キーのデータと当月・先月の申請カウンターを取得
    const thisYM = new Date().toISOString().slice(0, 7);
    const lastYM = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();

    const licenses = await Promise.all(
      keys.map(async key => {
        const licKey = key.replace('license:', '');
        const [data, usageThis, usageLast] = await Promise.all([
          kv.get(key),
          kv.get(`usage:${licKey}:${thisYM}`),
          kv.get(`usage:${licKey}:${lastYM}`),
        ]);
        return { key: licKey, ...data, usageThis: usageThis || 0, usageLast: usageLast || 0 };
      })
    );

    // 発行日時の新しい順にソート
    licenses.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.status(200).json({ total: licenses.length, licenses });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
}
