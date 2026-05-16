/**
 * セッションIDからライセンスキーを返す（サンクスページ用）
 * GET /api/get-license?session=cs_xxx
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { session } = req.query;
  if (!session) return res.status(400).json({ error: 'session required' });

  try {
    const licenseKey = await kv.get(`session:${session}`);
    if (!licenseKey) return res.status(404).json({ error: 'not_found' });

    const data = await kv.get(`license:${licenseKey}`);
    if (!data)    return res.status(404).json({ error: 'not_found' });

    return res.status(200).json({
      licenseKey,
      company:   data.company,
      expiresAt: data.expiresAt,
      email:     data.email,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  }
}
