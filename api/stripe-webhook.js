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
    // 本番シークレットで検証、失敗したらテスト用シークレットを試す
    const secrets = [
      process.env.STRIPE_WEBHOOK_SECRET?.trim(),
      process.env.STRIPE_WEBHOOK_SECRET_TEST?.trim(),
    ].filter(Boolean);
    let lastErr;
    for (const secret of secrets) {
      try { event = stripe.webhooks.constructEvent(rawBody, sig, secret); break; } catch (e) { lastErr = e; }
    }
    if (!event) throw lastErr;
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    captureException(err, { context: 'webhook_signature' });
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // テストモードのイベントは本物のライセンスを発行しない
  // （テスト署名で検証が通っても livemode=false なら処理をスキップ。
  //   テストフロー検証時は ALLOW_TEST_WEBHOOK=1 を設定すれば通せる）
  if (!event.livemode && process.env.ALLOW_TEST_WEBHOOK !== '1') {
    console.log(`Test-mode event skipped: ${event.type} (${event.id})`);
    return res.status(200).json({ received: true, skipped: 'test_mode' });
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

  if (event.type === 'customer.subscription.updated') {
    await _handleSubscriptionUpdated(event.data.object, event.data.previous_attributes);
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

  // ── デバッグ: セッションの重要フィールドをログ ──────────────────────
  console.log('[webhook] session.id:', session.id,
    'payment_status:', session.payment_status,
    'mode:', session.mode,
    'subscription:', session.subscription || '(none)',
    'client_reference_id:', session.client_reference_id || '(none)',
    'customer_email:', session.customer_details?.email || session.customer_email || '(none)',
    'amount_total:', session.amount_total);

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
  const plan = session.metadata?.plan || 'solo';

  // サブスクリプションの請求間隔・トライアル期限を取得
  let interval = 'month';
  let trialEnd  = null; // Unix秒タイムスタンプ（トライアル中の場合のみ）
  // カード無しトライアルは payment_status が no_payment_required になる
  const isCardlessTrial = session.payment_status === 'no_payment_required';
  if (session.subscription) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim());
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      interval  = sub.items.data[0]?.price?.recurring?.interval || 'month';
      if (sub.status === 'trialing' && sub.trial_end) trialEnd = sub.trial_end;
    } catch (_) {}
  }
  // サブスク取得が失敗した場合 or サブスク自体がない（$0 一時決済型）でも
  // payment_status が no_payment_required ならカード無しトライアルと確定できる
  if (!trialEnd && isCardlessTrial) trialEnd = 1;

  // ── カード無しトライアル → 有料転換 ──────────────────────────────
  // 「有料プランに登録」ボタンは Payment Link に client_reference_id=既存ライセンスキー を
  // 付けて開く。新キーを発行せず、その既存ライセンスを課金サブスクへ付け替えて延長する。
  const refKey = (session.client_reference_id || '').trim();
  if (refKey) {
    const refData = await kv.get(`license:${refKey}`);
    if (refData) {
      await _convertLicense(refKey, refData, session, customerEmail, customerName, businessName, company, plan, interval, trialEnd);
      return;
    }
  }

  // ── メールアドレスごとの全ライセンス一覧を取得 ──────────────────
  const EMAIL_LICENSES_KEY = `email_licenses:${customerEmail}`;
  let allLicenseKeys = (await kv.get(EMAIL_LICENSES_KEY)) || [];
  const allLicenses = (await Promise.all(
    allLicenseKeys.map(async k => {
      const d = await kv.get(`license:${k}`);
      return d ? { key: k, data: d } : null;
    })
  )).filter(Boolean);

  // ── 3件上限チェック（停止済み含む全ライセンスを対象） ──────────
  const activeCount = allLicenses.filter(l => !l.data.suspended).length;
  if (activeCount >= 3) {
    console.error(`License limit (3) reached for ${customerEmail}. Refunding.`);
    captureException(new Error(`License limit reached: ${customerEmail}`), { context: 'license_limit' });
    await _refundAndNotifyLimit(session, customerEmail, customerName || businessName || company);
    return;
  }

  // ── 解約後の再申込み：停止済みStripeライセンスを再アクティブ化 ──
  const toReactivate = allLicenses.find(l => l.data.suspended && l.data.stripeSessionId);
  if (toReactivate) {
    await _reactivateLicense(toReactivate.key, toReactivate.data, session,
      customerEmail, customerName, businessName, company, plan, interval, trialEnd,
      EMAIL_LICENSES_KEY, allLicenseKeys);
    return;
  }

  // ── 同一メールで手動発行ライセンスがある場合の有料アップグレード扱い ──
  // ※トライアル申込み（trialEnd あり＝カード無し）は対象外。トライアルは課金ではないため
  //   既存ライセンスに吸収せず、新規ライセンス（最大3つ）として作成する。
  //   これをしないと、手動発行済みメールでのトライアルが trial:false / plan:solo に化ける。
  const existingKey = await kv.get(`email_to_license:${customerEmail}`);
  if (!trialEnd && existingKey) {
    const existingData = await kv.get(`license:${existingKey}`);
    if (existingData && !existingData.suspended && !existingData.stripeSessionId) {
      await _upgradeLicense(existingKey, existingData, session, customerEmail, customerName, plan, interval);
      return;
    }
  }

  // ライセンスキー生成
  const licenseKey = `KL-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

  // 有効期限：トライアルは14日固定、月額は1ヶ月後、年額は1年後
  const expiresAt = trialEnd
    ? (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d; })()
    : (() => {
        const d = new Date();
        if (interval === 'year') d.setFullYear(d.getFullYear() + 1);
        else d.setMonth(d.getMonth() + 1);
        return d;
      })();

  const licenseData = {
    company:         company,
    customerName:    customerName,
    businessName:    businessName,
    plan,
    interval,
    expiresAt:       expiresAt.toISOString().split('T')[0],
    email:           customerEmail,
    stripeSessionId: session.id,
    createdAt:       new Date().toISOString(),
    suspended:       false,
    trial:           !!trialEnd,
  };

  // KV に保存
  await kv.set(`license:${licenseKey}`, licenseData);

  // ロックキーを発行済みキーで上書き（以降の参照でキーが分かるように）
  await kv.set(`session:${session.id}`, licenseKey, { ex: SESSION_TTL });

  // メールアドレスからキーを逆引き（最新キーを指す）
  await kv.set(`email_to_license:${customerEmail}`, licenseKey);

  // メールアドレスごとの全ライセンス一覧を更新（3件上限・再アクティブ化判定に使用）
  await kv.set(EMAIL_LICENSES_KEY, [...new Set([...allLicenseKeys, licenseKey])]);

  // ── デバッグ: 発行直前ログ ──────────────────────────────────────────
  console.log('[webhook] issuing license:', licenseKey,
    'trial:', !!trialEnd, 'trialEnd:', trialEnd,
    'isCardlessTrial:', session.payment_status === 'no_payment_required',
    'expiresAt:', licenseData.expiresAt,
    'plan:', plan, 'interval:', interval);

  // サブスクリプションIDからライセンスキーを逆引き（更新・停止処理用）
  if (session.subscription) {
    await kv.set(`stripe_sub:${session.subscription}`, licenseKey);
  }

  // セットアップリンク用ランダムコードを生成・保存（双方向マッピング）
  const setupCode = crypto.randomBytes(5).toString('hex'); // 10文字の16進数
  await kv.set(`lic_ref:${setupCode}`, licenseKey);
  await kv.set(`license_ref:${licenseKey}`, setupCode); // 逆引き（alias登録時の検証用）

  console.log(`License issued: ${licenseKey} for ${customerEmail}`);

  // RESEND_API_KEY が設定されていればメール送信
  if (process.env.RESEND_API_KEY) {
    await _sendLicenseEmail(customerEmail, customerName || businessName || company, licenseKey, licenseData.expiresAt, plan, setupCode, !!trialEnd);
    // 管理者通知
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await _sendAdminNotifyEmail(customerEmail, customerName, licenseKey, licenseData.expiresAt, businessName, plan);
    }
  }
}

async function _reactivateLicense(key, oldData, session, email, name, businessName, company, plan, interval, trialEnd, emailLicensesKey, allLicenseKeys) {
  const SESSION_TTL = 60 * 60 * 24 * 30;
  const expiresAt = trialEnd
    ? new Date(trialEnd * 1000)
    : (() => {
        const d = new Date();
        if (interval === 'year') d.setFullYear(d.getFullYear() + 1);
        else d.setMonth(d.getMonth() + 1);
        return d;
      })();
  const expiresAtStr = expiresAt.toISOString().split('T')[0];

  const updated = {
    ...oldData,
    plan,
    interval,
    expiresAt:        expiresAtStr,
    stripeSessionId:  session.id,
    suspended:        false,
    trial:            !!trialEnd,
    reactivatedAt:    new Date().toISOString(),
    // businessName/company は最新の申込情報で上書き
    ...(businessName ? { businessName } : {}),
    ...(company      ? { company }      : {}),
  };
  await kv.set(`license:${key}`, updated);
  await kv.set(`session:${session.id}`, key, { ex: SESSION_TTL });
  await kv.set(`email_to_license:${email}`, key);
  if (session.subscription) await kv.set(`stripe_sub:${session.subscription}`, key);
  await kv.set(emailLicensesKey, [...new Set([...allLicenseKeys, key])]);
  console.log(`License reactivated: ${key} for ${email} until ${expiresAtStr}`);

  if (process.env.RESEND_API_KEY) {
    await _sendReactivationEmail(email, name || oldData.customerName || company, key, expiresAtStr);
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await _sendAdminNotifyEmail(email, name, key, expiresAtStr, businessName || oldData.businessName, plan);
    }
  }
}

// カード無しトライアル → 実課金への転換。新キーは発行せず既存ライセンスを延長する。
async function _convertLicense(key, oldData, session, email, name, businessName, company, plan, interval, trialEnd) {
  const SESSION_TTL = 60 * 60 * 24 * 30;
  // 新しいサブスクが（設定ミス等で）またトライアルなら trial_end までに留める＝無償の有料期間を防ぐ。
  // 実課金（card-onで paid）なら今日から interval 分を付与。
  const isStillTrial = !!trialEnd;
  const expiresAtStr = (isStillTrial
    ? new Date(trialEnd * 1000)
    : (() => {
        const d = new Date();
        if (interval === 'year') d.setFullYear(d.getFullYear() + 1);
        else d.setMonth(d.getMonth() + 1);
        return d;
      })()
  ).toISOString().split('T')[0];

  // 旧トライアルのサブスクが別に残っていればキャンセル（宙ぶらりんの trial sub を防ぐ）
  try {
    if (oldData.stripeSessionId && oldData.stripeSessionId !== session.id) {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim());
      const oldSession = await stripe.checkout.sessions.retrieve(oldData.stripeSessionId);
      const oldSub = oldSession?.subscription;
      if (oldSub && oldSub !== session.subscription) {
        await stripe.subscriptions.cancel(oldSub).catch(() => {});
        await kv.del(`stripe_sub:${oldSub}`).catch(() => {});
      }
    }
  } catch (_) {}

  const updated = {
    ...oldData,
    plan,
    interval,
    expiresAt:       expiresAtStr,
    stripeSessionId: session.id,
    suspended:       false,
    trial:           isStillTrial,
    convertedAt:     new Date().toISOString(),
    ...(businessName ? { businessName }      : {}),
    ...(company      ? { company }           : {}),
    ...(name         ? { customerName: name } : {}),
  };
  await kv.set(`license:${key}`, updated);
  await kv.set(`session:${session.id}`, key, { ex: SESSION_TTL });
  if (email) await kv.set(`email_to_license:${email}`, key);
  if (session.subscription) await kv.set(`stripe_sub:${session.subscription}`, key);
  console.log(`License converted to paid: ${key} for ${email} until ${expiresAtStr}`);

  if (process.env.RESEND_API_KEY) {
    await _sendUpgradeEmail(email, name || oldData.customerName || company, key, expiresAtStr, plan);
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await _sendAdminUpgradeEmail(email, name, key, expiresAtStr);
    }
  }
}

async function _upgradeLicense(key, oldData, session, email, name, plan, interval = 'month') {
  const expiresAt = new Date();
  if (interval === 'year') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
  else expiresAt.setMonth(expiresAt.getMonth() + 1);
  const expiresAtStr = expiresAt.toISOString().split('T')[0];

  const updated = {
    ...oldData,
    plan,
    interval,
    expiresAt:       expiresAtStr,
    stripeSessionId: session.id,
    trial:           false,
    upgradedAt:      new Date().toISOString(),
  };
  await kv.set(`license:${key}`, updated);
  await kv.set(`session:${session.id}`, key, { ex: 60 * 60 * 24 * 30 });
  if (session.subscription) {
    await kv.set(`stripe_sub:${session.subscription}`, key);
  }
  console.log(`License upgraded: ${key} for ${email}`);

  if (process.env.RESEND_API_KEY) {
    await _sendUpgradeEmail(email, name, key, expiresAtStr, plan);
    if (process.env.ADMIN_NOTIFY_EMAIL) {
      await _sendAdminUpgradeEmail(email, name, key, expiresAtStr);
    }
  }
}

async function _sendUpgradeEmail(to, name, licenseKey, expiresAt, plan = 'solo') {
  const appUrl = process.env.APP_URL || 'https://keihi-log.com/app';
  const planLabel = plan === 'team' ? 'チームプラン' : 'ソロプラン';
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to,
    subject: `【経費ログ】有料プランへのお申し込みありがとうございます`,
    html: `
<p>${name} 様</p>
<p>この度は経費ログ（${planLabel}）へのお申し込みありがとうございます。</p>
<ul>
  <li>プラン：${planLabel}</li>
  <li>有効期限：${expiresAt}</li>
</ul>
<p>サブスクリプションは自動で継続されます。解約される場合はStripeの請求メールに記載のリンクからお手続きください。解約後も経費データはGoogleスプレッドシート上に保持されます。</p>
<p>ご不明な点は <a href="mailto:support@keihi-log.com">support@keihi-log.com</a> までお気軽にお問い合わせください。</p>
    `.trim(),
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('Resend error:', await resp.text());
}

async function _sendReactivationEmail(to, name, licenseKey, expiresAt) {
  const appUrl   = process.env.APP_URL || 'https://keihi-log.com/app';
  const setupUrl = process.env.APP_URL
    ? process.env.APP_URL.replace('/app', '')
    : 'https://keihi-log.com';
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to,
    subject: `【経費ログ】ライセンスが再アクティブ化されました`,
    html: `
<p>${name} 様</p>
<p>経費ログへの再申し込みありがとうございます。以前のライセンスキーが再アクティブ化されました。</p>
<p style="font-size:1.2em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul>
  <li>有効期限：${expiresAt}</li>
  <li>アプリURL：<a href="${appUrl}">${appUrl}</a></li>
</ul>
<p>以前の設定（スプレッドシート等）はそのまま引き続きご利用いただけます。</p>
<p>ご不明な点はお気軽にお問い合わせください。</p>
    `.trim(),
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('Resend reactivation error:', await resp.text());
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

async function _sendLicenseEmail(to, name, licenseKey, expiresAt, plan = 'solo', setupCode = '', trial = false) {
  const planLabel = plan === 'team' ? 'チームプラン' : 'ソロプラン';
  const setupUrl = setupCode
    ? `https://keihi-log.com/${setupCode}`
    : 'https://keihi-log.com/app';
  const trialNotice = trial ? `
<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin:1.5rem 0;font-size:0.95em;">
  <strong>📅 2週間の無料トライアル期間について</strong><br>
  トライアル期間中はソロ・チーム問わず全機能をお使いいただけます。<br>
  <strong>トライアル終了後は自動課金されません。</strong>引き続きご利用の場合は、
  <strong>2週間以内にアプリの設定タブから有料プランへの切り替え</strong>をお願いします。
</div>` : '';
  const intro = trial
    ? `この度は経費ログのトライアルにお申し込みいただきありがとうございます。`
    : `この度は経費ログ（${planLabel}）にお申し込みいただきありがとうございます。`;
  const licInfo = trial
    ? `<li>トライアル期限：${expiresAt}</li>`
    : `<li>プラン：${planLabel}</li><li>有効期限：${expiresAt}</li>`;
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to,
    subject: trial ? `【経費ログ】無料トライアル開始のご案内` : `【経費ログ】ご利用開始のご案内`,
    html: `
<p>${name} 様</p>

<p>${intro}</p>
<p>以下のリンクからアプリを開くと、ライセンスキーが自動的に入力された状態で設定を始められます。</p>

<p style="margin:1.5rem 0;">
  <a href="${setupUrl}" style="display:inline-block;background:#0d6efd;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:1rem;font-weight:600;">経費ログを開いてセットアップする</a>
</p>

<p style="color:#555;font-size:0.9em;">
  ボタンが開かない場合は以下のURLをコピーして <strong>Safari・Chromeなどのブラウザ</strong> に貼り付けて開いてください：<br>
  <a href="${setupUrl}">${setupUrl}</a><br>
  <span style="color:#e67e22;">※ LINEやSlackのアプリ内ブラウザではGoogleログインが動作しない場合があります。必ずブラウザで開いてください。</span>
</p>

${trialNotice}

<hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0;">

<p><strong>ライセンスキー（手動入力用）</strong></p>
<p style="font-size:1.1em;font-family:monospace;background:#f5f5f5;padding:12px 16px;border-radius:6px;letter-spacing:1px;">
  <strong>${licenseKey}</strong>
</p>
<ul style="color:#555;font-size:0.9em;">
  ${licInfo}
</ul>

<hr style="border:none;border-top:1px solid #eee;margin:1.5rem 0;">

<p><strong>はじめかた（5ステップ）</strong></p>
<ol style="line-height:2.2;font-size:0.95em;">
  <li><strong>Safari・Chromeなどのブラウザ</strong>で上のリンクを開き、Googleアカウントでログイン</li>
  <li>ライセンスキーを確認（すでに自動入力されています）→「確認して次へ」</li>
  <li>会社名・チームURLを入力（チームURLは後から変更できません。任意）</li>
  <li>Gemini APIキーを設定（AI領収書解析用。無料で取得できます）。電帳法対応の社内規程作成は任意でスキップ可能</li>
  <li>「セットアップ開始」をタップ → Google Driveにスプレッドシートとフォルダーが自動作成されます。完了後に表示される<strong>チームURL</strong>をメンバーに共有するだけで、メンバーはそのURLを開いてGoogleログインするだけで使い始められます</li>
</ol>

<p style="color:#555;font-size:0.9em;">ご不明な点は <a href="mailto:support@keihi-log.com">support@keihi-log.com</a> までお気軽にお問い合わせください。</p>
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
  const soloUrl  = process.env.STRIPE_LINK_SOLO  || 'https://keihi-log.com/#pricing';
  const teamUrl  = process.env.STRIPE_LINK_TEAM  || 'https://keihi-log.com/#pricing';
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
  <li>アプリURL：<a href="https://keihi-log.com/app">https://keihi-log.com/app</a></li>
</ul>
<p>今回の申し込みはStripeより自動的にキャンセル処理いたします。</p>
<hr style="border:none;border-top:1px solid #eee;margin:1rem 0;">
<p style="font-size:0.9em;color:#555;">
  <strong>別の組織でもご利用になる場合は</strong>、組織ごとに別のメールアドレスでお申し込みください。<br>
  ご継続のお申し込みはこちらから：
  <a href="${soloUrl}">ソロプラン</a> ／ <a href="${teamUrl}">チームプラン</a>
</p>
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

async function _refundAndNotifyLimit(session, email, name) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim());
  const from   = process.env.RESEND_FROM_EMAIL || 'support@keihi-log.com';

  // 自動返金（payment_intent がある場合のみ。トライアルは payment_intent なし）
  let refunded = false;
  if (session.payment_intent) {
    try {
      await stripe.refunds.create({ payment_intent: session.payment_intent });
      refunded = true;
      console.log(`Refunded payment_intent ${session.payment_intent} for ${email}`);
    } catch (err) {
      console.error('Refund failed:', err.message);
      captureException(err, { context: 'refund_limit' });
    }
  }

  // ユーザーへ通知
  if (process.env.RESEND_API_KEY) {
    const body = {
      from,
      to: email,
      subject: '【経費ログ】ライセンス発行上限のお知らせ',
      html: `
<p>${name} 様</p>
<p>この度はお申し込みいただきありがとうございます。</p>
<p>誠に恐れ入りますが、同一メールアドレスでご利用いただけるライセンスは<strong>最大3件</strong>までとなっております。すでに上限に達しているため、今回のライセンス発行ができませんでした。</p>
${refunded ? '<p>ご決済いただいた金額は自動的に全額返金いたします。返金の反映にはカード会社により数日かかる場合があります。</p>' : '<p>返金処理が自動で完了できませんでした。大変お手数ですが <a href="mailto:support@keihi-log.com">support@keihi-log.com</a> までご連絡ください。</p>'}
<p>4チーム目以降をご利用になりたい場合は、<strong>別のメールアドレス</strong>でお申し込みください。</p>
<p>ご不明な点は <a href="mailto:support@keihi-log.com">support@keihi-log.com</a> までお気軽にお問い合わせください。</p>
      `.trim(),
    };
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.error('Resend limit notify error:', await resp.text());
  }

  // 管理者アラート
  if (process.env.RESEND_API_KEY && process.env.ADMIN_NOTIFY_EMAIL) {
    const body = {
      from,
      to: process.env.ADMIN_NOTIFY_EMAIL,
      subject: `【経費ログ】ライセンス上限超過 — ${email}`,
      html: `
<p>同一メールアドレスでの3件上限により、ライセンスを発行できませんでした。</p>
<table style="border-collapse:collapse;font-size:14px;">
  <tr><td style="padding:4px 12px 4px 0;color:#666;">メール</td><td>${email}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">名前</td><td>${name}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">返金</td><td>${refunded ? '自動返金済み' : '返金失敗 → 手動対応要'}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">payment_intent</td><td style="font-family:monospace;">${session.payment_intent || '（トライアル・なし）'}</td></tr>
</table>
      `.trim(),
    };
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  }
}

async function _sendAdminNotifyEmail(customerEmail, customerName, licenseKey, expiresAt, businessName = '', plan = 'solo') {
  const planLabel = plan === 'team' ? 'チームプラン' : 'ソロプラン';
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
  <tr><td style="padding:4px 12px 4px 0;color:#666;">プラン</td><td>${planLabel}</td></tr>
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
  // サブスクリプションIDで正確なライセンスキーを特定（複数チーム対応）
  let key = invoice.subscription
    ? await kv.get(`stripe_sub:${invoice.subscription}`).catch(() => null)
    : null;
  // フォールバック：メールアドレスからの逆引き（旧データ互換）
  if (!key) {
    const email = invoice.customer_email || '';
    if (!email) return;
    key = await kv.get(`email_to_license:${email}`);
  }
  if (!key) return;
  const data = await kv.get(`license:${key}`);
  if (!data) return;

  // Stripeの請求期間終了日を優先して使用（最も正確）
  // フォールバック：保存済みintervalに応じて現在の期限から延長
  let newExpiry;
  const periodEnd = invoice.lines?.data?.[0]?.period?.end;
  if (periodEnd) {
    newExpiry = new Date(periodEnd * 1000);
  } else {
    newExpiry = new Date(data.expiresAt);
    if (data.interval === 'year') newExpiry.setFullYear(newExpiry.getFullYear() + 1);
    else newExpiry.setMonth(newExpiry.getMonth() + 1);
  }
  await kv.set(`license:${key}`, { ...data, expiresAt: newExpiry.toISOString().split('T')[0], trial: false });
  console.log('[webhook] License renewed:', key, 'until', newExpiry.toISOString().split('T')[0],
    'billing_reason:', 'renewal', 'periodEnd:', periodEnd || '(fallback)');
}

async function _handleSubscriptionUpdated(subscription, previousAttributes) {
  // プラン変更のみ処理（それ以外のsub更新は無視）
  const prevItems = previousAttributes?.items;
  if (!prevItems) return;

  const key = await kv.get(`stripe_sub:${subscription.id}`).catch(() => null);
  if (!key) return;
  const data = await kv.get(`license:${key}`);
  if (!data) return;

  // 現在のプライスIDからプランを判定（metadataが最優先、なければ商品名で判定）
  const currentItem = subscription.items?.data?.[0];
  const productId = currentItem?.price?.product;
  const priceId   = currentItem?.price?.id;
  if (!priceId) return;

  // Stripeから商品情報を取得してメタデータのplanを確認
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY?.trim());
  let newPlan = data.plan; // デフォルトは変更なし
  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ['product'] });
    const planMeta = price.metadata?.plan || price.product?.metadata?.plan;
    if (planMeta) {
      newPlan = planMeta;
    } else {
      // メタデータがない場合は商品名で判定
      const productName = (price.product?.name || '').toLowerCase();
      if (productName.includes('team') || productName.includes('チーム')) newPlan = 'team';
      else if (productName.includes('solo') || productName.includes('ソロ')) newPlan = 'solo';
    }
  } catch (_) {}

  if (newPlan === data.plan) return; // プラン変更なし

  const updated = { ...data, plan: newPlan, planChangedAt: new Date().toISOString() };
  await kv.set(`license:${key}`, updated);
  console.log(`Plan changed via portal: ${key} ${data.plan} → ${newPlan}`);

  if (process.env.RESEND_API_KEY) {
    await _sendPlanChangeEmail(data.email, data.customerName || data.company, newPlan, data.plan);
  }
}

async function _sendPlanChangeEmail(to, name, newPlan, oldPlan) {
  const newLabel = newPlan === 'team' ? 'チームプラン' : 'ソロプラン';
  const oldLabel = oldPlan === 'team' ? 'チームプラン' : 'ソロプラン';
  const body = {
    from: process.env.RESEND_FROM_EMAIL || 'noreply@' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'example.com'),
    to,
    subject: `【経費ログ】プランを${newLabel}に変更しました`,
    html: `
<p>${name} 様</p>
<p>プランを<strong>${oldLabel}から${newLabel}</strong>へ変更しました。</p>
<p>プランは即時変更され、日割りで精算されます。ライセンスキーはそのまま変わりません。</p>
<p>ご不明な点は <a href="mailto:support@keihi-log.com">support@keihi-log.com</a> までお気軽にお問い合わせください。</p>
    `.trim(),
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) console.error('Resend plan change error:', await resp.text());
}

async function _suspendLicense(subscription) {
  // サブスクリプションIDで正確なライセンスキーを特定（複数チーム対応）
  let key = subscription.id
    ? await kv.get(`stripe_sub:${subscription.id}`).catch(() => null)
    : null;
  // フォールバック：メールアドレスからの逆引き（旧データ互換）
  if (!key) {
    const email = subscription.customer_email || '';
    if (!email) return;
    key = await kv.get(`email_to_license:${email}`);
  }
  if (!key) return;
  const data = await kv.get(`license:${key}`);
  if (data) await kv.set(`license:${key}`, { ...data, suspended: true });
  console.log(`License suspended: ${key}`);
}

function _getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
