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
import { captureException } from './_sentry.js';

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
    captureException(err, { context: 'webhook_signature' });
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
  // "顧客の氏名を収集" → customer_details.name / individual_name（新APIでは両方あり）
  const customerName  = session.customer_details?.individual_name
                     || session.customer_details?.name
                     || session.collected_information?.individual_name
                     || '';
  // "ビジネス名を収集" → 新APIでは collected_information.business_name / customer_details.business_name
  // 旧APIでは custom_fields に business_name キーで入る
  const businessName = session.collected_information?.business_name
                    || session.customer_details?.business_name
                    || session.custom_fields?.find(
                         f => ['business_name','businessname','company_name','companyname'].includes(f.key)
                       )?.text?.value
                    || '';
  // 表示用 company: ビジネス名 → 氏名 → メール の優先順
  const company = businessName || customerName || customerEmail;
  const plan = session.metadata?.plan || 'standard';

  // 同一メールアドレスで既存ライセンスがある場合
  const existingKey = await kv.get(`email_to_license:${customerEmail}`);
  if (existingKey) {
    const existingData = await kv.get(`license:${existingKey}`);
    if (existingData && !existingData.suspended) {
      if (!existingData.stripeSessionId) {
        // 手動（無料）ライセンス → 有料アップグレード
        await _upgradeLicense(existingKey, existingData, session, customerEmail, customerName, plan);
      } else {
        // 既に有料ライセンスあり → セッションキーを更新してから再送メール
        // （session:xxx が 'issuing' のままだと get-license が 404 を返すため必ず上書きする）
        await kv.set(`session:${session.id}`, existingKey, { ex: SESSION_TTL });
        console.log(`License already exists for ${customerEmail}: ${existingKey}, resending`);
        if (process.env.RESEND_API_KEY) {
          await _sendDuplicateLicenseEmail(customerEmail, customerName, existingKey, existingData.expiresAt);
        }
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
    company:         company,
    customerName:    customerName,
    businessName:    businessName,
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
    await _sendLicenseEmail(customerEmail, customerName || businessName || company, licenseKey, licenseData.expiresAt);
    // 管理者通知
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await _sendAdminNotifyEmail(customerEmail, customerName, licenseKey, licenseData.expiresAt, businessName);
    }
  }
}

async function _upgradeLicense(key, oldData, session, email, name, plan) {
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  const expiresAtStr = expiresAt.toISOString().split('T')[0];

  const updated = {
    ...oldData,
    plan,
    expiresAt:       expiresAtStr,
    stripeSessionId: session.id,
    upgradedAt:      new Date().toISOString(),
  };
  await kv.set(`license:${key}`, updated);
  await kv.set(`session:${session.id}`, key, { ex: 60 * 60 * 24 * 30 });
  console.log(`License upgraded: ${key} for ${email}`);

  if (process.env.RESEND_API_KEY) {
    await _sendUpgradeEmail(email, name, key, expiresAtStr);
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await _sendAdminUpgradeEmail(email, name, key, expiresAtStr);
    }
  }
}

async function _sendUpgradeEmail(to, name, licenseKey, expiresAt) {
  const appUrl = process.env.APP_URL || 'https://keihi-log.com/app.html';
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to,
    subject: '【経費ログ】有料プランへのアップグレードが完了しました',
    html: `
<p>${name} 様</p>
<p>この度は経費ログ有料プランへのアップグレードありがとうございます。</p>
<p>引き続き同じライセンスキーをお使いください。有効期限が更新されました。</p>
<p style="font-size:1.2em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul>
  <li>新しい有効期限：${expiresAt}</li>
  <li>アプリURL：<a href="${appUrl}">${appUrl}</a></li>
</ul>
<p>ご不明な点はお気軽にお問い合わせください。</p>
    `.trim(),
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('Resend error:', await resp.text());
}

async function _sendAdminUpgradeEmail(email, name, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `【経費ログ】有料転換 — ${name}`,
    html: `
<p>手動ライセンスが有料プランにアップグレードされました。</p>
<table style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 12px 4px 0;color:#666;">氏名・会社名</td><td>${name}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">メール</td><td>${email}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">ライセンスキー</td><td style="font-family:monospace;">${licenseKey}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">新しい有効期限</td><td>${expiresAt}</td></tr>
</table>
    `.trim(),
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('Admin upgrade notify error:', await resp.text());
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
  <li>アプリURL：<a href="https://keihi-log.com/app.html">https://keihi-log.com/app.html</a></li>
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

async function _sendDuplicateLicenseEmail(to, name, licenseKey, expiresAt) {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to,
    subject: '【経費ログ】ライセンスキーのご案内（登録済み）',
    html: `
<p>${name} 様</p>
<p>このメールアドレスにはすでにライセンスキーが発行されています。</p>
<p>以下の既存キーをそのままお使いください。</p>
<p style="font-size:1.2em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul>
  <li>有効期限：${expiresAt}</li>
  <li>アプリURL：<a href="https://keihi-log.com/app.html">https://keihi-log.com/app.html</a></li>
</ul>
<p>今回の購入はStripeより返金処理いたします。ご不明な点はお気軽にお問い合わせください。</p>
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

async function _sendAdminNotifyEmail(customerEmail, customerName, licenseKey, expiresAt, businessName = '') {
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `【経費ログ】ライセンス発行通知 — ${businessName || customerName}`,
    html: `
<p>新しいライセンスが発行されました。</p>
<table style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 12px 4px 0;color:#666;">氏名</td><td>${customerName || '—'}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">ビジネス名</td><td>${businessName || '—'}</td></tr>
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
