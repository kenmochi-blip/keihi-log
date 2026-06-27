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

  const { key, flow } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ error: 'missing_key' });
  }
  // flow: 'update'（プラン変更画面へ直行）/ 'cancel'（解約画面へ直行）/ 未指定（ポータルトップ）
  const flowType = flow === 'update' || flow === 'cancel' ? flow : null;

  const data = await kv.get(`license:${key}`);
  if (!data) return res.status(404).json({ error: 'not_found' });

  if (data.trial) return res.status(400).json({ error: 'trial_user' });

  const sessionId = data.stripeSessionId;
  if (!sessionId) return res.status(400).json({ error: 'no_session' });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim());

    // カスタマーIDを解決（優先順：KV直接保存 → チェックアウトセッション → サブスクリプション → メール検索）
    // 旧トライアル転換組は紐付け（session/sub）が削除済みで壊れていることがあるため、
    // 各Stripe呼び出しは個別にtry-catchで保護し、最後はメールから実顧客を検索する。
    let customerId     = data.stripeCustomerId     || null;
    let subscriptionId = data.stripeSubscriptionId || null;

    // 保存済み customerId が「使う前に」実在するか検証する。
    // テストモードで作られた顧客IDが本番キーに残っている等で 'No such customer' になるため、
    // 無効なら null 化して下のフォールバック（session/sub/メール検索）に流す。
    if (customerId) {
      try {
        const c = await stripe.customers.retrieve(customerId);
        if (c?.deleted) { console.warn(`[portal] stored customer ${customerId} is deleted`); customerId = null; }
      } catch (e) {
        console.warn(`[portal] stored customer ${customerId} invalid:`, e.message);
        customerId = null;
      }
    }

    if (!customerId) {
      // チェックアウトセッションから取得（旧データ互換）
      try {
        const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
        customerId     = checkoutSession.customer     || null;
        subscriptionId = subscriptionId || checkoutSession.subscription || null;
        console.log(`[portal] session ${sessionId}: customer=${customerId}, sub=${subscriptionId}`);
      } catch (e) {
        console.warn(`[portal] checkout session ${sessionId} not retrievable:`, e.message);
      }
    }

    // フォールバック1：サブスクリプションから直接カスタマーを取得
    if (!customerId && subscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        customerId = sub.customer || null;
        console.log(`[portal] Fallback from sub ${subscriptionId}: customer=${customerId}`);
      } catch (e) {
        console.warn(`[portal] subscription ${subscriptionId} not retrievable:`, e.message);
      }
    }

    // フォールバック2：ライセンスのメールからStripe顧客を検索（紐付けが完全に壊れた旧データの救済）
    if (!customerId && data.email) {
      try {
        const found = await stripe.customers.list({ email: data.email, limit: 1 });
        customerId = found.data[0]?.id || null;
        if (customerId) console.log(`[portal] Fallback from email ${data.email}: customer=${customerId}`);
      } catch (e) {
        console.warn(`[portal] customer lookup by email failed:`, e.message);
      }
    }

    if (!customerId) {
      console.error(`[portal] no_customer for key=${key} session=${sessionId}`);
      return res.status(400).json({ error: 'no_customer' });
    }

    // 自己修復：解決できた customerId を KV に書き戻し、次回以降のStripeAPI往復を省く
    if (customerId !== data.stripeCustomerId) {
      kv.set(`license:${key}`, { ...data, stripeCustomerId: customerId }).catch(() => {});
    }

    // トライアル中（カード未登録）はポータルを開けない — KV の trial フラグが誤っている場合の保険
    if (subscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        if (sub.status === 'trialing') {
          return res.status(400).json({ error: 'trial_user' });
        }
      } catch (subErr) {
        // トライアルsubがStripe側で削除済みの場合はスキップ（KVのtrial:falseを信頼）
        console.warn(`[portal] subscription ${subscriptionId} not retrievable, skipping trial check:`, subErr.message);
      }
    }

    // flow 指定時はポータルの該当画面（プラン変更/解約）へ直行させる。
    // 対象サブスクは「現在アクティブなもの」を採用（保存IDが古い場合に備えて顧客から引く）。
    let flowData;
    if (flowType) {
      let activeSub = null;
      try {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
        activeSub = subs.data[0] || null;
      } catch (e) {
        console.warn('[portal] active subscription lookup failed:', e.message);
      }
      if (activeSub) {
        // 既に「期間終了時キャンセル」予約済みのサブスクに対して解約フローは開けない
        // （Stripeが "already set to be canceled" を返す）。その場合はトップを開き、
        // ユーザーが状態確認・解約取り消しできるようにする。
        if (flowType === 'cancel' && activeSub.cancel_at_period_end) {
          flowData = undefined;
        } else {
          flowData = flowType === 'update'
            ? { type: 'subscription_update', subscription_update: { subscription: activeSub.id } }
            : { type: 'subscription_cancel', subscription_cancel: { subscription: activeSub.id } };
        }
      }
      // アクティブなサブスクが無い場合は flow_data を付けずにポータルトップを開く（フォールバック）
    }

    const origin = req.headers.origin || 'https://keihi-log.com';
    const createParams = {
      customer:   customerId,
      return_url: `${origin}/app?plan_updated=1`,
    };
    let portalSession;
    try {
      portalSession = await stripe.billingPortal.sessions.create({
        ...createParams,
        ...(flowData ? { flow_data: flowData } : {}),
      });
    } catch (e) {
      // flow_data 付き生成に失敗した場合（解約予約済み等の競合）はトップを開いてフォールバック
      if (flowData) {
        console.warn('[portal] flow create failed, retrying without flow_data:', e.message);
        portalSession = await stripe.billingPortal.sessions.create(createParams);
      } else {
        throw e;
      }
    }

    return res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal error:', err);
    // Stripe ダッシュボードでカスタマーポータルが未設定（未保存）の場合、
    // billingPortal.sessions.create は "No configuration provided..." 例外を投げる。
    // これは恒久的な設定不備なので専用コードで返し、クライアントが正しく案内できるようにする。
    const isPortalUnconfigured = /configuration/i.test(err.message || '')
      && /portal|customer/i.test(err.message || '');
    if (isPortalUnconfigured) {
      return res.status(500).json({ error: 'portal_not_configured', message: err.message });
    }
    return res.status(500).json({ error: 'stripe_error', message: err.message });
  }
}
