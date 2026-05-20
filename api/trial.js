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
import { rateLimit } from './_rateLimit.js';
import { captureException } from './_sentry.js';

export default async function handler(req, res) {
  // Vercel Cron からの日次リマインド処理
  if (req.method === 'GET' && req.query.action === 'cron') {
    return _cronReminder(req, res);
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { ok } = await rateLimit(req, { prefix: 'rl:trial', limit: 5, window: 300 });
  if (!ok) return res.status(429).json({ error: 'too_many_requests' });

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

// ── 日次クーロン：トライアル前日リマインド ──────────────────────────
async function _cronReminder(req, res) {
  // CRON_SECRET で不正アクセスを防ぐ
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).end();
  }

  // 明日の日付文字列（JST = UTC+9）
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC→JST
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  // KV の全ライセンスキーをスキャン
  const keys = await kv.keys('license:*');
  let reminded = 0;

  for (const key of keys) {
    const data = await kv.get(key);
    if (!data || data.suspended) continue;
    if (data.expiresAt !== tomorrowStr) continue;

    const licenseKey = key.replace('license:', '');

    if (data.plan === 'trial') {
      // トライアル期限切れ前日
      await _sendTrialEndingEmail(data.email, data.company, licenseKey, data.expiresAt);
    } else {
      // 有料ライセンス年次更新前日
      await _sendLicenseEndingEmail(data.email, data.company, licenseKey, data.expiresAt);
    }
    reminded++;
  }

  console.log(`Cron reminder: ${reminded} emails sent for ${tomorrowStr}`);
  return res.json({ ok: true, reminded, date: tomorrowStr });
}

async function _sendTrialEndingEmail(to, name, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@keihi-log.com',
    to,
    subject: '【経費ログ】無料トライアルは明日終了します',
    html: `
<p>${name} 様</p>
<p>経費ログの無料トライアルが <strong>明日（${expiresAt}）</strong> に終了します。</p>
<p>引き続きご利用いただくには、下記から有料プランへのお申し込みをお願いします。</p>
<p>
  <a href="https://keihi-log.com/#pricing"
     style="display:inline-block;background:#0d6efd;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">
    プランを選んで継続する
  </a>
</p>
<p style="color:#666;font-size:0.9em;">
  ※ 有料プランに移行しない場合、明日以降はライセンスキーが無効になります。<br>
  ※ データ（スプレッドシート）はそのまま保持されます。
</p>
<p>ご不明な点はお気軽にお問い合わせください。<br>support@keihi-log.com</p>
    `.trim(),
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('Trial ending email error:', await resp.text());
}

async function _sendLicenseEndingEmail(to, name, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@keihi-log.com',
    to,
    subject: '【経費ログ】ライセンスの有効期限は明日です',
    html: `
<p>${name} 様</p>
<p>経費ログのライセンス有効期限が <strong>明日（${expiresAt}）</strong> になります。</p>
<p>Stripeによる自動更新が設定されている場合は自動的に延長されますのでご安心ください。</p>
<p>自動更新をご希望でない場合や、ご不明な点がございましたらお気軽にお問い合わせください。<br>support@keihi-log.com</p>
    `.trim(),
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('License ending email error:', await resp.text());
}

async function _sendTrialEmail(to, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@keihi-log.com',
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
  <li>アプリURL：<a href="https://keihi-log.com/app.html">https://keihi-log.com/app.html</a></li>
</ul>
<p>トライアル終了後にご継続いただける場合は、アプリ内またはサイトから購入手続きをお願いします。</p>
<p>ご不明な点はお気軽にお問い合わせください。<br>support@keihi-log.com</p>
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
