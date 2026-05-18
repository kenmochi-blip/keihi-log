/**
 * サーバーサイド Sentry 初期化ヘルパー
 * 環境変数 SENTRY_DSN が設定されている場合のみ有効化。
 * 未設定時はダミー関数を返すのでコード側の分岐不要。
 */

import * as Sentry from '@sentry/node';

let _initialized = false;

function init() {
  if (_initialized || !process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.VERCEL_ENV || 'development',
    tracesSampleRate: 0.2,
  });
  _initialized = true;
}

export function captureException(err, context = {}) {
  init();
  if (!process.env.SENTRY_DSN) return;
  Sentry.withScope(scope => {
    Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
    Sentry.captureException(err);
  });
}
