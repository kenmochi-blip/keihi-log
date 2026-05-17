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
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim());
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET?.trim());
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (event.type === 'checkout.session.completed') {
    await _issueNewLicense(event.data.object);
  }

  // invoice.paid は更新時（subscription_cycle）のみ有効期限を延長する
  // subscription_create はcheckout.session.completedで処理済みのためスキップ
  if (event.type === 'invoice.paid') {
    const inv = event.data.object;
    if (inv.billing_reason !== 'subscription_create') {
      await _renewLicense(inv);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    await _suspendLicense(event.data.object);
  }

  res.status(200).json({ received: true });
}

async function _issueNewLicense(session) {
  // SET NX でアトミックにロックを取得（同一セッションへの同時リクエスト・リトライを完全排除）
  // NX = "Not eXists" のときのみセット。複数の呼び出しが同時到達しても1つだけ 'OK' を返す。
  const SESSION_TTL = 60 * 60 * 24 * 30; // 30日（Stripeの冪等性ウィンドウを大幅に超える）
  const locked = await kv.set(`session:${session.id}`, 'issuing', { nx: true, ex: SESSION_TTL });
  if (!locked) {
    console.log(`Duplicate session ${session.id}, skipping`);
    return;
  }

  const customerEmail = session.customer_details?.email || session.customer_email || '';
  const customerName  = session.customer_details?.name  || customerEmail;
  const plan = session.metadata?.plan || 'standard';

  // 同一メールアドレスで既存ライセンスがある場合は再発行せず既存キーを再送
  const existingKey = await kv.get(`email_to_license:${customerEmail}`);
  if (existingKey) {
    const existingData = await kv.get(`license:${existingKey}`);
    if (existingData && !existingData.suspended) {
      console.log(`License already exists for ${customerEmail}: ${existingKey}, resending`);
      if (process.env.RESEND_API_KEY) {
        await _sendLicenseEmail(customerEmail, customerName, existingKey, existingData.expiresAt);
      }
      return;
    }
  }

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

  // ロックキーを発行済みキーで上書き（以降の参照でキーが分かるように）
  await kv.set(`session:${session.id}`, licenseKey, { ex: SESSION_TTL });

  // メールアドレスからキーを逆引きできるインデックスも保存
  await kv.set(`email_to_license:${customerEmail}`, licenseKey);

  console.log(`License issued: ${licenseKey} for ${customerEmail}`);

  // RESEND_API_KEY が設定されていればメール送信
  if (process.env.RESEND_API_KEY) {
    await _sendLicenseEmail(customerEmail, customerName, licenseKey, licenseData.expiresAt);
    // 管理者通知
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await _sendAdminNotifyEmail(customerEmail, customerName, licenseKey, licenseData.expiresAt);
    }
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
  <li>アプリURL：https://keihi-log.smartandsmooth.com</li>
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

async function _sendAdminNotifyEmail(customerEmail, customerName, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `【経費ログ】ライセンス発行通知 — ${customerName}`,
    html: `
<p>新しいライセンスが発行されました。</p>
<table style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 12px 4px 0;color:#666;">購入者名</td><td>${customerName}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">メールアドレス</td><td>${customerEmail}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">ライセンスキー</td><td style="font-family:monospace;">${licenseKey}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">有効期限</td><td>${expiresAt}</td></tr>
</table>
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
  if (!resp.ok) console.error('Admin notify error:', await resp.text());
}

async function _renewLicense(invoice) {
  const email = invoice.customer_email || '';
  if (!email) return;
  const key = await kv.get(`email_to_license:${email}`);
  if (!key) return;
  const data = await kv.get(`license:${key}`);
  if (!data) return;
  // 有効期限を1年延長
  const newExpiry = new Date(data.expiresAt);
  newExpiry.setFullYear(newExpiry.getFullYear() + 1);
  await kv.set(`license:${key}`, { ...data, expiresAt: newExpiry.toISOString().split('T')[0] });
  console.log(`License renewed: ${key} for ${email} until ${newExpiry.toISOString().split('T')[0]}`);
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
