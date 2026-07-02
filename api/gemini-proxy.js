/**
 * Gemini API プロキシ（デモモード用）
 * APIキーはVercel環境変数で管理し、ソースコードには含まない
 */
import { rateLimit } from './_rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // デモ用の共有キー（サーバー所有）を無認証で叩けるため、IP単位でレート制限する。
  // 未制限だとオーナー課金のGeminiキー/クォータを第三者に枯渇させられる。
  const rl = await rateLimit(req, { prefix: 'demo-gemini', limit: 20, window: 600 });
  if (!rl.ok) {
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらくしてからお試しください。' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Gemini APIキーが設定されていません' });

  // gemini-2.5-flash は無料枠が20 RPD/日に削減されたため、500 RPD の flash-lite を使用（2026-06確認）
  const MODEL   = 'gemini-3.1-flash-lite';
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  try {
    const resp = await fetch(`${API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(504).json({ error: 'Gemini APIがタイムアウトしました' });
    res.status(500).json({ error: err.message });
  }
}
