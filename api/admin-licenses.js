/**
 * 発行済みライセンス一覧 API（管理者専用）
 * GET /api/admin-licenses?secret=ADMIN_SECRET
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
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

    // 各キーのデータを取得
    const licenses = await Promise.all(
      keys.map(async key => {
        const data = await kv.get(key);
        return { key: key.replace('license:', ''), ...data };
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
