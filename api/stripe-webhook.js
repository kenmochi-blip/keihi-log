/**
 * Stripe Webhook → ライセンスキー自動発行
 *
 * 購入完了時にライセンスキーを生成して Vercel KV に保存する。
 * Google Sheets・サービスアカウント不要。
 *
 * 環境変数:
 *   STRIPE_SECRET_KEY      - Stripeシークレットキー
 *   STRIPE_WEBHOOK_SECRET  - Stripe Webhookシークレット（署名検証用）
 *
 * KV 保存形式:
 *   license:{キー} → { company, plan, expiresAt, email, stripeSessionId, createdAt, suspended }
 */

import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await _getRawBody(req);
  const sig     = req.headers['stripe-signature'];

  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed' ||
      event.type === 'invoice.paid') {
    await _issueNewLicense(event.data.object);
  }

  if (event.type === 'customer.subscription.deleted') {
    await _suspendLicense(event.data.object);
  }

  res.status(200).json({ received: true });
}

async function _issueNewLicense(session) {
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  const customerName  = session.customer_details?.name  || customerEmail;
  const plan = session.metadata?.plan || 'standard';

  // ライセンスキー生成
  const licenseKey = `KL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

  // 有効期限（1年後）
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  const licenseData = {
    company:         customerName,
    plan,
    expiresAt:       expiresAt.toISOString().split('T')[0],
    email:           customerEmail,
    stripeSessionId: session.id,
    createdAt:       new Date().toISOString(),
    suspended:       false,
  };

  // KV に保存
  await kv.set(`license:${licenseKey}`, licenseData);

  // セッションIDからキーを引けるインデックス（サンクスページ用・7日TTL）
  await kv.set(`session:${session.id}`, licenseKey, { ex: 60 * 60 * 24 * 7 });

  // メールアドレスからキーを逆引きできるインデックスも保存
  await kv.set(`email_to_license:${customerEmail}`, licenseKey);

  console.log(`License issued: ${licenseKey} for ${customerEmail}`);

  // RESEND_API_KEY が設定されていればメール送信
  if (process.env.RESEND_API_KEY) {
    await _sendLicenseEmail(customerEmail, customerName, licenseKey, licenseData.expiresAt);
  }
}

async function _sendLicenseEmail(to, name, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to,
    subject: '【経費ログ】ライセンスキーのご案内',
    html: `
<p>${name} 様</p>
<p>この度は経費ログをご購入いただきありがとうございます。</p>
<p>以下のライセンスキーをアプリの設定画面に入力してください。</p>
<p style="font-size:1.2em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul>
  <li>有効期限：${expiresAt}</li>
  <li>アプリURL：https://keihi-log.vercel.app</li>
</ul>
<p>ご不明な点はお気軽にお問い合わせください。</p>
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
  if (!resp.ok) console.error('Resend error:', await resp.text());
}

async function _suspendLicense(subscription) {
  // メタデータからメールを取得してキーを停止
  const email = subscription.customer_email || '';
  if (!email) return;
  const key = await kv.get(`email_to_license:${email}`);
  if (!key) return;
  const data = await kv.get(`license:${key}`);
  if (data) await kv.set(`license:${key}`, { ...data, suspended: true });
  console.log(`License suspended for ${email}`);
}

function _getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
