/**
 * 発行済みライセンス一覧 API（管理者専用）
 * GET    /api/admin-licenses?secret=ADMIN_SECRET          一覧取得
 * POST   /api/admin-licenses?secret=ADMIN_SECRET          手動発行
 * DELETE /api/admin-licenses?secret=ADMIN_SECRET&key=KL-  削除
 */

import { kv } from '@vercel/kv';
import crypto from 'crypto';

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

  // POST: 手動発行
  if (req.method === 'POST') {
    const { company, email, plan, expiresAt, note } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    // 同一メールで既存ライセンスがある場合はエラー
    const existing = await kv.get(`email_to_license:${email}`).catch(() => null);
    if (existing) {
      const existingData = await kv.get(`license:${existing}`).catch(() => null);
      if (existingData && !existingData.suspended) {
        return res.status(409).json({ error: 'duplicate_email', existingKey: existing });
      }
    }

    const licenseKey = `KL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
    const defaultExpiry = new Date();
    defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 1);

    const licenseData = {
      company:   company || email,
      plan:      plan || 'standard',
      expiresAt: expiresAt || defaultExpiry.toISOString().split('T')[0],
      email,
      note:      note || '手動発行',
      createdAt: new Date().toISOString(),
      suspended: false,
    };

    await kv.set(`license:${licenseKey}`, licenseData);
    await kv.set(`email_to_license:${email}`, licenseKey);
    console.log(`License manually issued: ${licenseKey} for ${email}`);

    return res.status(200).json({ key: licenseKey, ...licenseData });
  }

  // GET: 一覧取得
  try {
    const keys = [];
    let cursor = 0;
    do {
      const [nextCursor, batch] = await kv.scan(cursor, { match: 'license:*', count: 100 });
      keys.push(...batch);
      cursor = Number(nextCursor);
    } while (cursor !== 0);

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

    licenses.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return res.status(200).json({ total: licenses.length, licenses });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
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
