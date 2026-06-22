/**
 * Stripe カスタマーポータルセッション生成 API
 *
 * ライセンスキーを受け取り、対応する Stripe カスタマーのポータル URL を返す。
 * ポータルでプラン変更・解約・支払い方法の更新が行える。
 */

import Stripe from 'stripe';
import { kv } from '@vercel/kv';
import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { ok } = await rateLimit(req, { prefix: 'rl:portal', limit: 10, window: 60 });
  if (!ok) return res.status(429).json({ error: 'too_many_requests' });

  const { key } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'missing_key' });
  }

  const data = await kv.get(`license:${key}`);
  if (!data) return res.status(404).json({ error: 'not_found' });

  if (data.trial) return res.status(400).json({ error: 'trial_user' });

  const sessionId = data.stripeSessionId;
  if (!sessionId) return res.status(400).json({ error: 'no_session' });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim());

    // カスタマーIDを解決（優先順：KV直接保存 → チェックアウトセッション → サブスクリプション）
    let customerId    = data.stripeCustomerId     || null;
    let subscriptionId = data.stripeSubscriptionId || null;

    if (!customerId) {
      // チェックアウトセッションから取得（旧データ互換）
      const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
      customerId     = checkoutSession.customer     || null;
      subscriptionId = subscriptionId || checkoutSession.subscription || null;
      console.log(`[portal] session ${sessionId}: customer=${customerId}, sub=${subscriptionId}`);

      // フォールバック：サブスクリプションから直接カスタマーを取得
      if (!customerId && subscriptionId) {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        customerId = sub.customer || null;
        console.log(`[portal] Fallback from sub ${subscriptionId}: customer=${customerId}`);
      }
    }

    if (!customerId) {
      console.error(`[portal] no_customer for key=${key} session=${sessionId}`);
      return res.status(400).json({ error: 'no_customer' });
    }

    // トライアル中（カード未登録）はポータルを開けない — KV の trial フラグが誤っている場合の保険
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (sub.status === 'trialing') {
        return res.status(400).json({ error: 'trial_user' });
      }
    }

    const origin = req.headers.origin || 'https://keihi-log.com';
    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${origin}/app?plan_updated=1`,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal error:', err);
    return res.status(500).json({ error: 'stripe_error', message: err.message });
  }
}
