/**
 * Stripe Webhook → ライセンス台帳自動登録
 *
 * 環境変数:
 *   STRIPE_SECRET_KEY           - Stripeシークレットキー
 *   STRIPE_WEBHOOK_SECRET       - Stripe Webhookシークレット（署名検証用）
 *   GOOGLE_SERVICE_ACCOUNT_JSON - サービスアカウントJSONキー
 *   LICENSE_SHEET_ID            - ライセンス台帳スプレッドシートID
 */

import Stripe from 'stripe';
import { google } from 'googleapis';
import { kv } from '@vercel/kv';
import crypto from 'crypto';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  // リクエストボディを生バイトで取得（署名検証のため）
  const rawBody = await _getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // 支払い完了イベントのみ処理
  if (event.type === 'checkout.session.completed' ||
      event.type === 'invoice.paid') {
    await _handlePaymentSuccess(event);
  }

  // サブスクリプションキャンセル
  if (event.type === 'customer.subscription.deleted') {
    await _handleSubscriptionCancelled(event);
  }

  res.status(200).json({ received: true });
}

async function _handlePaymentSuccess(event) {
  const session = event.data.object;
  const customerEmail = session.customer_details?.email || session.customer_email || '';
  const customerName  = session.customer_details?.name  || '';
  const plan = _getPlan(session);

  // ライセンスキーを生成（プレフィックス + ランダム）
  const licenseKey = `KL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

  // 有効期限（1年後）
  const expiresAt = new Date();
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  await _appendToLedger([
    licenseKey,
    customerName || customerEmail,
    plan,
    expiresAt.toISOString().split('T')[0],  // YYYY-MM-DD
    `Stripe: ${session.id}`,
    'false',  // 停止フラグ
  ]);

  // KVキャッシュをクリア（新規キーは台帳にあるため）
  try {
    await kv.del(`license:${licenseKey}`);
  } catch (_) {}

  // TODO: customerEmail へライセンスキーをメール送信
  // 現状はStripe Customer Portalのメタデータにキーを保存することを推奨
  console.log(`License issued: ${licenseKey} for ${customerEmail}`);
}

async function _handleSubscriptionCancelled(event) {
  const sub = event.data.object;
  // 台帳の停止フラグを true にする処理（省略：台帳を手動で更新することを推奨）
  console.log(`Subscription cancelled: ${sub.id}`);
}

function _getPlan(session) {
  // Stripeの商品メタデータからプランを取得する
  return session.metadata?.plan || 'standard';
}

async function _appendToLedger(row) {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const sheetId = process.env.LICENSE_SHEET_ID;

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'ライセンス台帳!A1',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

function _getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
