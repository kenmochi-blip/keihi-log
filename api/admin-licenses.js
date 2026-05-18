/**
 * 発行済みライセンス一覧 API（管理者専用）
 * GET    /api/admin-licenses?secret=ADMIN_SECRET          一覧取得
 * POST   /api/admin-licenses?secret=ADMIN_SECRET          手動発行
 * PATCH  /api/admin-licenses?secret=ADMIN_SECRET          手動アップグレード
 * DELETE /api/admin-licenses?secret=ADMIN_SECRET&key=KL-  削除
 */

import { kv } from '@vercel/kv';
import crypto from 'crypto';
import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  // 認証前にレートリミット（ブルートフォース対策）
  const { ok } = await rateLimit(req, { prefix: 'rl:admin', limit: 10, window: 60 });
  if (!ok) return res.status(429).json({ error: 'too_many_requests' });

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

  // PATCH: 手動アップグレード（Stripe外決済用）
  if (req.method === 'PATCH') {
    const { key, action } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    const data = await kv.get(`license:${key}`).catch(() => null);
    if (!data) return res.status(404).json({ error: 'not found' });

    if (action === 'upgrade') {
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      const updated = {
        ...data,
        upgradedAt: new Date().toISOString(),
        expiresAt:  expiresAt.toISOString().split('T')[0],
        note:       (data.note ? data.note + ' ' : '') + '→有料転換（手動）',
      };
      await kv.set(`license:${key}`, updated);
      console.log(`License manually upgraded: ${key}`);
      return res.status(200).json({ ok: true, ...updated });
    }

    return res.status(400).json({ error: 'unknown action' });
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

    // メール送信（RESEND_API_KEY が設定されている場合のみ）
    if (process.env.RESEND_API_KEY) {
      const from   = process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com');
      const appUrl = 'https://keihi-log.smartandsmooth.com/app.html';

      await _sendEmail(from, email, '【経費ログ】ライセンスキーのご案内', `
<p>${licenseData.company} 様</p>
<p>経費ログのライセンスキーをお送りします。</p>
<p style="font-size:1.2em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul>
  <li>有効期限：${licenseData.expiresAt}</li>
  <li>アプリURL：<a href="${appUrl}">${appUrl}</a></li>
</ul>
<p>アプリの設定画面でライセンスキーを入力してください。ご不明な点はお気軽にお問い合わせください。</p>
      `.trim());

      if (process.env.ADMIN_NOTIFY_EMAIL) {
        await _sendEmail(from, process.env.ADMIN_NOTIFY_EMAIL, `【経費ログ】手動ライセンス発行 — ${licenseData.company}`, `
<p>手動でライセンスを発行しました。</p>
<table style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 12px 4px 0;color:#666;">会社名・氏名</td><td>${licenseData.company}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">メールアドレス</td><td>${email}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">ライセンスキー</td><td style="font-family:monospace;">${licenseKey}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">プラン</td><td>${licenseData.plan}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">有効期限</td><td>${licenseData.expiresAt}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">備考</td><td>${licenseData.note}</td></tr>
</table>
        `.trim());
      }
    }

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

async function _sendEmail(from, to, subject, html) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!resp.ok) console.error('Resend error:', await resp.text());
}
