import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const key = `notify:${email.toLowerCase().trim()}`;
  await kv.set(key, { email, registeredAt: new Date().toISOString() });

  return res.status(200).json({ ok: true });
}
