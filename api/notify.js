import { kv } from '@vercel/kv';
import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 無認証でメール送信＋KV書き込みが走るため、IP単位でレート制限する
  // （自ドメインを踏み台にしたメール爆撃・KV肥大化の防止）。
  const rl = await rateLimit(req, { prefix: 'notify', limit: 5, window: 600 });
  if (!rl.ok) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' });
  }

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const key = `notify:${normalizedEmail}`;
  await kv.set(key, { email: normalizedEmail, registeredAt: new Date().toISOString() });

  // オートリプライメール送信
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL || 'support@keihi-log.com',
        to: [normalizedEmail],
        subject: '【経費ログ】リリース通知のご登録ありがとうございます',
        html: `
<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#333;text-align:center;">
  <span style="font-size:2rem;">🚀</span>
  <h2 style="margin:8px 0 16px;font-size:1.3rem;">ご登録ありがとうございます</h2>
  <p style="margin:0 0 12px;">経費ログのリリース通知にご登録いただきありがとうございます。</p>
  <p style="margin:0 0 12px;">現在、2026年6月中旬のリリースに向けて鋭意開発中です。<br>
  リリースの際は、このメールアドレス宛にご連絡いたします。</p>
  <p style="margin:0 0 24px;">それまでの間、デモ画面で機能をお試しいただけます。</p>
  <a href="https://keihi-log.com/app?demo"
     style="background:#0d6efd;color:#fff;padding:12px 28px;border-radius:999px;text-decoration:none;font-weight:bold;display:inline-block;">
    デモを見る
  </a>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
  <p style="font-size:0.85rem;color:#888;margin:0;">
    合同会社Smart&amp;Smooth<br>
    <a href="https://keihi-log.com" style="color:#888;">keihi-log.com</a>
  </p>
</div>`,
      }),
    }).catch(() => {}); // メール送信失敗でも登録自体は成功とする
  }

  return res.status(200).json({ ok: true });
}
