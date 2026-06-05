// ブログの書き手（2名）。名前は非公開。役割のみ表示。
export interface Author {
  label: string;   // バイラインに表示するラベル
  icon: string;    // Bootstrap Icons クラス名
  tint: string;
  accent: string;
}

export const authors: Record<string, Author> = {
  owner: {
    label: '開発者より',
    icon: 'bi-code-slash',
    tint: '#eef4ff',
    accent: '#3F51B5',
  },
  staff: {
    label: '使ってみた話',
    icon: 'bi-person-check',
    tint: '#fff5ef',
    accent: '#f08a5d',
  },
};

export const getAuthor = (key: string | undefined): Author =>
  authors[key ?? 'owner'] ?? authors.owner;
