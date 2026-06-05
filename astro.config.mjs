import { defineConfig } from 'astro/config';

export default defineConfig({
  // 本番URL（canonical / 構造化データで使用）
  site: 'https://keihi-log.com',

  // 既存の静的ファイル（HTML/CSS/JS）はpublic/に置いてそのまま配信
  // ブログは src/pages/blog/ → dist/blog/ に出力
  outDir: './dist',
  publicDir: './public',

  // /blog/ 以下のみAstroが担当
  base: '/',

  build: {
    // アセットのハッシュを付与してキャッシュを最適化
    assets: 'blog-assets',
  },
});
