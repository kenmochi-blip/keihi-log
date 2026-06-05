// ブログの書き手（2名）。どちらも経費ログ運営側であることを明示する。
// tint = 記事カード／記事ページの背景色、accent = アクセント線・アバター色。
export interface Author {
  name: string;
  role: string;
  initial: string;
  tint: string;     // 淡い背景色
  accent: string;   // アバター・アクセント線
  badgeBg: string;  // 名前バッジの背景
  badgeFg: string;  // 名前バッジの文字色
}

export const authors: Record<string, Author> = {
  owner: {
    name: '剱持',
    role: '経費ログ 運営者',
    initial: '剱',
    tint: '#eef4ff',
    accent: '#3F51B5',
    badgeBg: '#e7eeff',
    badgeFg: '#2c3e9e',
  },
  staff: {
    name: 'みなみ',
    role: '経費ログ 運営チーム（個人事業主）',
    initial: 'み',
    tint: '#fff5ef',
    accent: '#f08a5d',
    badgeBg: '#ffeadd',
    badgeFg: '#c0613a',
  },
};

export const getAuthor = (key: string | undefined): Author =>
  authors[key ?? 'owner'] ?? authors.owner;
