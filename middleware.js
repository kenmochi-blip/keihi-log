/**
 * Vercel Edge Middleware: alias URL の OGP を動的生成
 *
 * LINE / Facebook 等のクローラーがチームの共有 URL（例: /h4jircd83m）を
 * アクセスした際、グループ名を含む OGP HTML を返す。
 * 通常ユーザーはそのまま通過させ app.html のルーティングに委ねる。
 */

const BOT_UA = /facebookexternalhit|Twitterbot|Slackbot|Discordbot|TelegramBot|WhatsApp|LinkedInBot|Line\/|LINESEARCHBOT|Googlebot|bingbot|Baiduspider|DuckDuckBot|Applebot|Pinterestbot/i;

const RESERVED = new Set([
  '', 'app', 'login', 'setup', 'faq', 'guide', 'demo', 'privacy', 'terms',
  'tokusho', 'success', 'licenses', 'accountant', 'lp-b', 'blog', 'api',
]);

const SITE_URL = 'https://keihi-log.com';

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const json = await r.json();
    return json.result ?? null;
  } catch {
    return null;
  }
}

export default async function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  if (!BOT_UA.test(ua)) return; // 通常ユーザーはスルー

  const { pathname } = new URL(request.url);
  // 最初のパスセグメントを取得（例: "/h4jircd83m" → "h4jircd83m"）
  const seg = pathname.replace(/^\//, '').split('/')[0];

  // 予約済みパスや静的アセットはスルー
  if (RESERVED.has(seg)) return;
  if (!/^[a-zA-Z0-9_-]{3,}$/.test(seg)) return;

  // KV からエイリアス情報を並列取得
  const [sheetId, companyName] = await Promise.all([
    kvGet(`alias:${seg}`),
    kvGet(`alias_company:${seg}`),
  ]);

  // 有効なエイリアスでなければスルー
  if (!sheetId) return;

  const title = companyName ? `経費ログ - ${companyName}` : '経費ログ';
  const description = companyName
    ? `${companyName}の経費記録`
    : '領収書を撮るだけでAIが自動入力。Googleアカウントで使う経費記録アプリ。';
  const pageUrl = `${SITE_URL}/${seg}`;
  const imageUrl = `${SITE_URL}/icons/icon-512.png`;

  const e = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${e(title)}</title>
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${e(pageUrl)}">
<meta property="og:image" content="${e(imageUrl)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(description)}">
<meta name="twitter:image" content="${e(imageUrl)}">
</head>
<body></body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=60',
    },
  });
}

export const config = {
  matcher: ['/((?!_next|api/|js/|css/|img/|icons/|favicon|sw\\.js|robots\\.txt|sitemap\\.xml|manifest\\.json).*)'],
};
