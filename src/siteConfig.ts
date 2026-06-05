// ブログの公開フラグ。
// 記事が十分たまったら true に変えるだけで、
//   - 検索エンジンの noindex 解除
//   - LP からのブログ導線の表示（※LPは public/index.html 側で手動リンク）
// が有効になる。false の間は noindex でプレビューのみ。
export const BLOG_PUBLISHED = false;
