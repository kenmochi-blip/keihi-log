/**
 * Sentry API プロキシ（管理者専用）
 * GET /api/sentry-proxy?secret=ADMIN_SECRET&path=/organizations/.../issues/...
 */
export default async function handler(req, res) {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'SENTRY_AUTH_TOKEN not configured' });
  }

  const sentryPath = req.query.path;
  if (!sentryPath || !sentryPath.startsWith('/')) {
    return res.status(400).json({ error: 'invalid path' });
  }

  const url = `https://us.sentry.io/api/0${sentryPath}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    // X-Hits ヘッダーを転送
    const hits = resp.headers.get('X-Hits');
    if (hits) res.setHeader('X-Hits', hits);
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
