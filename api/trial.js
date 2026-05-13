/**
 * 2週間無料トライアルライセンス発行
 * POST /api/trial  { email }
 *
 * - 同一メールアドレスからのトライアルは1回のみ
 * - ライセンスキー形式: TR-XXXX...（購入ライセンスと区別）
 * - 有効期限: 14日
 */

import { kv } from '@vercel/kv';
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // 同一メールの重複チェック
  const existing = await kv.get(`trial_email:${normalizedEmail}`);
  if (existing) {
    return res.status(409).json({ error: 'already_used' });
  }

  // トライアルキー生成
  const licenseKey = `TR-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

  // 有効期限（14日後）
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 14);
  const expiresAtStr = expiresAt.toISOString().split('T')[0];

  const licenseData = {
    company:   normalizedEmail,
    plan:      'trial',
    expiresAt: expiresAtStr,
    email:     normalizedEmail,
    createdAt: new Date().toISOString(),
    suspended: false,
  };

  // KV に保存（ライセンス自体は永続、メール重複防止キーも永続）
  await kv.set(`license:${licenseKey}`, licenseData);
  await kv.set(`trial_email:${normalizedEmail}`, licenseKey);

  // メール送信
  if (process.env.RESEND_API_KEY) {
    await _sendTrialEmail(normalizedEmail, licenseKey, expiresAtStr);
  }

  return res.status(200).json({ licenseKey, expiresAt: expiresAtStr });
}

async function _sendTrialEmail(to, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@smartandsmooth.com',
    to,
    subject: '【経費ログ】2週間無料トライアルのライセンスキー',
    html: `
<p>経費ログをお試しいただきありがとうございます。</p>
<p>以下のライセンスキーをアプリの設定画面に入力してください。</p>
<p style="font-size:1.2em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul>
  <li>有効期限：${expiresAt}（2週間）</li>
  <li>アプリURL：https://keihi-log.vercel.app</li>
</ul>
<p>トライアル終了後にご継続いただける場合は、アプリ内またはサイトから購入手続きをお願いします。</p>
<p>ご不明な点はお気軽にお問い合わせください。<br>support@smartandsmooth.com</p>
    `.trim(),
  };

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('Resend trial email error:', await resp.text());
}
