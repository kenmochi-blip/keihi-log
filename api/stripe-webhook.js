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

  // KV に保存（有効期限 + 7日間は検索できるようにTTL設定しない）
  await kv.set(`license:${licenseKey}`, licenseData);

  // メールアドレスからキーを逆引きできるインデックスも保存
  await kv.set(`email_to_license:${customerEmail}`, licenseKey);

  console.log(`License issued: ${licenseKey} for ${customerEmail}`);

  // TODO: customerEmail にライセンスキーをメール送信
  // SendGrid / Resend / Stripe の自動メール等で対応
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
