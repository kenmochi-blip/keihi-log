/**
 * デモモード
 * ログイン・スプレッドシート不要でサンプルデータを表示する
 */
const Demo = (() => {
  const KEY = 'keihi_demo_mode';
  const ROLE_KEY = 'keihi_demo_role';

  let _role = sessionStorage.getItem(ROLE_KEY) || 'admin';

  function enable() {
    sessionStorage.setItem(KEY, '1');
  }
  function disable()  { sessionStorage.removeItem(KEY); sessionStorage.removeItem(ROLE_KEY); _role = 'admin'; }
  function isActive() { return sessionStorage.getItem(KEY) === '1'; }
  function getRole()  { return _role; }
  function setRole(r) { _role = r; sessionStorage.setItem(ROLE_KEY, r); }
  function getUserEmail() {
    if (_role === 'viewer') return 'suzuki@example.com';
    if (_role === 'member') return 'tanaka@example.com';
    return 'demo@example.com';
  }

  const MASTER = {
    members: [
      { name: 'デモ ユーザー', email: 'demo@example.com',   dept: '管理部', role: 'admin' },
      { name: '田中 太郎',     email: 'tanaka@example.com', dept: '営業部', role: '' },
      { name: '鈴木 花子',     email: 'suzuki@example.com', dept: '総務部', role: 'viewer' },
      { name: '佐藤 次郎',     email: 'sato@example.com',   dept: '開発部', role: '' },
    ],
    categories: ['会議費', '旅費交通費', '消耗品費', '接待交際費', '通信費', '研修費', '新聞図書費', '福利厚生費'],
    paySources: ['法人カード（三井住友）', '法人カード（楽天）'],
    admins: ['demo@example.com'],
    viewers: [],
  };

  // ── 日付スライド ───────────────────────────────────────────────
  // デモデータは「執筆時点 = 2026年6月」を基準に作成。実際の現在月との差分（月単位）
  // だけ全日付をずらすことで、時間が経っても常に直近のデータに見えるようにする。
  const _ANCHOR_Y = 2026, _ANCHOR_M0 = 5; // 0-based: 2026年6月
  const _now = new Date();
  const _shiftMonths = (_now.getFullYear() * 12 + _now.getMonth()) - (_ANCHOR_Y * 12 + _ANCHOR_M0);

  // 'YYYY-MM-DD' を _shiftMonths ヶ月ずらす（月末日はクランプ）
  function _shiftYMD(ymd) {
    if (!_shiftMonths) return ymd;
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(y, m - 1 + _shiftMonths, 1);
    const ty = t.getFullYear(), tm = t.getMonth();
    const lastDay = new Date(ty, tm + 1, 0).getDate();
    const td = Math.min(d, lastDay);
    return `${ty}-${String(tm + 1).padStart(2, '0')}-${String(td).padStart(2, '0')}`;
  }

  // ISO日時の日付部分だけスライド（時刻は維持）
  function _shiftISO(iso) {
    if (!_shiftMonths) return iso;
    const m = iso.match(/^(\d{4}-\d{2}-\d{2})(T.*)$/);
    return m ? _shiftYMD(m[1]) + m[2] : iso;
  }

  function _e(id, appliedAt, name, email, type, date, place, amount, category, note, confirmed, invoice, imageLinks = '', settlementDate = '', taxRate = '') {
    appliedAt = _shiftISO(appliedAt);
    date = _shiftYMD(date);
    // settlementDate が日付形式のときのみスライド（「会社払い（…）」等の文字列はそのまま）
    if (/^\d{4}-\d{2}-\d{2}$/.test(settlementDate)) settlementDate = _shiftYMD(settlementDate);
    return { id, appliedAt, name, email, type, date, place, amount, category, note, confirmed, invoice,
             imageLinks, aiAudit: '', settlementDate, aiAmount: amount, imageHash: '', device: 'demo',
             taxRate: taxRate || '課税10%' };
  }

  const _img = f => `demo/receipts/${f}`;

  const EXPENSES = [
    // ── 2026-05 ──
    _e('demo-001', '2026-05-09T09:15:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2026-05-09', '大阪ビジネスホテル', 12000, '旅費交通費', '大阪出張 宿泊', false, 'T1234567890123',
       _img('receipt_hotel.svg')),
    _e('demo-001b', '2026-05-09T09:20:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2026-05-09', '大阪ビジネスホテル ダイニング', 8400, '旅費交通費', '大阪出張 夕食', false, '',
       _img('receipt_hotel_dinner.svg')),
    // ── 請求書＋銀行振込票の2枚添付サンプル ──
    //   業者への外注費など、銀行振込で支払う取引では請求書と振込証明をセットで保存する。
    //   1つの取引として1レコードに2枚添付するケース。
    _e('demo-inv', '2026-05-07T10:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2026-05-07', 'クリエイティブスタジオ合同会社', 110000, '外注費', '【請求書＋振込票】LP制作費（請求書No.2026-042）',
       false, 'T5555555555555',
       _img('receipt_invoice.svg') + ',' + _img('receipt_bank_transfer.svg')),
    _e('demo-002', '2026-05-08T14:30:00Z', '田中 太郎', 'tanaka@example.com',
       '電車/バス', '2026-05-08', '東京→横浜（往復）', 940, '旅費交通費', '取引先訪問', false, ''),
    _e('demo-003', '2026-05-07T10:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2026-05-07', 'オフィスデポ', 3280, '消耗品費', 'コピー用紙・文具', true, '',
       _img('receipt_office.svg')),
    _e('demo-004', '2026-05-06T16:00:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2026-05-06', '技術書典オンライン', 2750, '研修費', 'Webアーキテクチャ本', false, 'T9876543210987',
       _img('receipt_book.svg')),
    _e('demo-005', '2026-05-02T12:30:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2026-05-02', '銀座グリル', 8400, '接待交際費', '〇〇商事様との会食', false, 'T1111111111111',
       _img('receipt_restaurant.svg')),
    // ── 明細分割サンプル（1枚のレシートを科目・税率違いで分割した例）──
    //   コンビニで「文具（消耗品費・課税10%）」と「会議用のお茶菓子（会議費・軽減税率8%）」を
    //   同時購入 → 同一証票を2明細に分割。科目も税率も異なるケース。
    _e('demo-sp1', '2026-05-01T11:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2026-05-01', 'セブン-イレブン 渋谷店', 880, '消耗品費', '【明細分割①/②】ボールペン・付箋（標準税率10%）', false, '',
       _img('receipt_office.svg'), '', '課税10%'),
    _e('demo-sp2', '2026-05-01T11:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2026-05-01', 'セブン-イレブン 渋谷店', 1080, '会議費', '【明細分割②/②】会議用のお茶・菓子（軽減税率8%）', false, '',
       _img('receipt_office.svg'), '', '課税8%'),
    // ── 2026-04 ──
    _e('demo-006', '2026-04-28T09:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '自家用車', '2026-04-28', '本社→埼玉工場', 1200, '旅費交通費', '60km × 20円/km', true, '', '', '2026-05-10'),
    _e('demo-007', '2026-04-25T13:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書なし', '2026-04-25', 'クライアント慶弔', 5000, '接待交際費', '取引先ご就任祝い（領収書なし）', true, '', '', '2026-05-10'),
    _e('demo-008', '2026-04-22T11:00:00Z', '田中 太郎', 'tanaka@example.com',
       '電車/バス', '2026-04-22', '新宿→品川（往復）', 760, '旅費交通費', '社内研修参加', true, '', '', '2026-05-10'),
    _e('demo-009', '2026-04-18T15:00:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2026-04-18', 'AWS Summit Tokyo', 10000, '研修費', 'カンファレンス参加費', true, 'T2222222222222'),
    _e('demo-010', '2026-04-10T10:30:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2026-04-10', 'コワーキングスペース渋谷', 3280, '会議費', 'チームミーティング会場費', true, '',
       _img('receipt_office.svg'), '2026-05-10'),
    // ── 2026-03 ──
    _e('demo-011', '2026-03-28T14:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2026-03-28', '帝国ホテル 宴会場', 15000, '接待交際費', '年度末お礼会食', true, 'T3333333333333', '', '2026-04-10'),
    _e('demo-012', '2026-03-20T09:30:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2026-03-20', 'Amazon.co.jp', 4580, '消耗品費', 'オフィス備品', true, '', '', '2026-04-10'),
    _e('demo-013', '2026-03-15T16:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '電車/バス', '2026-03-15', '東京→名古屋（新幹線往復）', 27000, '旅費交通費', '取締役会出席', true, '', '', '2026-04-10'),
    _e('demo-014', '2026-03-05T11:00:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2026-03-05', 'Udemy（オンライン）', 1800, '研修費', 'React上級コース', true, '', '', '2026-04-10'),
    // ── 2026-02 ──
    _e('demo-015', '2026-02-25T13:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2026-02-25', '新橋 居酒屋あじ', 6200, '接待交際費', '部門歓迎会', true, '', '', '2026-03-10'),
    _e('demo-016', '2026-02-20T10:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2026-02-20', '郵便局', 850, '通信費', '書類発送', true, '', '', '2026-03-10'),
    _e('demo-017', '2026-02-14T09:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '自家用車', '2026-02-14', '本社→川崎支店', 800, '旅費交通費', '40km × 20円/km', true, '', '', '2026-03-10'),
    _e('demo-018', '2026-02-07T14:30:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2026-02-07', "O'Reilly Japan", 4200, '新聞図書費', 'Kubernetes実践ガイド', true, '', '', '2026-03-10'),
    // ── 2026-01 ──
    _e('demo-019', '2026-01-28T10:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2026-01-28', 'ビックカメラ 有楽町店', 18500, '消耗品費', 'プレゼン用HDMIアダプター他', true, '', '', '2026-02-10'),
    _e('demo-020', '2026-01-20T13:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2026-01-20', 'ロフト 渋谷店', 1650, '消耗品費', '事務用品', true, '', '', '2026-02-10'),
    _e('demo-021', '2026-01-15T09:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '電車/バス', '2026-01-15', '渋谷→池袋（往復）', 580, '旅費交通費', '新年挨拶回り', true, '', '', '2026-02-10'),
    _e('demo-022', '2026-01-08T16:00:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2026-01-08', 'GitHub（SaaS）', 3500, '通信費', 'GitHub Copilot 年間', true, '', '', '2026-02-10'),
    // ── 2025-12 ──
    _e('demo-023', '2025-12-25T12:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2025-12-25', '八芳園', 22000, '接待交際費', '忘年会（15名分担）', true, 'T4444444444444'),
    _e('demo-024', '2025-12-18T10:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2025-12-18', 'ヤマト運輸', 1230, '通信費', '年末ご挨拶便', true, ''),
    _e('demo-025', '2025-12-10T14:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2025-12-10', 'サンシャインホテル', 9800, '旅費交通費', '出張宿泊（仙台）', true, ''),
    // ── 2025-11 ──
    _e('demo-026', '2025-11-28T11:00:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2025-11-28', 'Microsoft（オンライン）', 5060, '通信費', 'Azure サブスクリプション', true, ''),
    _e('demo-027', '2025-11-15T13:30:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2025-11-15', '上野精養軒', 7500, '接待交際費', '取引先接待', true, 'T5555555555555'),
    _e('demo-028', '2025-11-05T10:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2025-11-05', 'カウネット', 2890, '消耗品費', 'トナーカートリッジ', true, ''),
    // ── 2025-10 ──
    _e('demo-029', '2025-10-25T09:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '自家用車', '2025-10-25', '本社→千葉営業所', 1600, '旅費交通費', '80km × 20円/km', true, ''),
    _e('demo-030', '2025-10-15T14:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2025-10-15', 'ホテルグランヴィア', 14000, '旅費交通費', '出張宿泊（京都）', true, ''),
    _e('demo-031', '2025-10-08T11:30:00Z', '佐藤 次郎', 'sato@example.com',
       '電車/バス', '2025-10-08', '東京→横浜（往復）', 940, '旅費交通費', 'セミナー参加', true, ''),
    // ── 2025-09 ──
    _e('demo-032', '2025-09-28T10:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2025-09-28', 'ダイソー', 550, '消耗品費', '文具補充', true, ''),
    _e('demo-033', '2025-09-20T15:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2025-09-20', 'ANA（航空券）', 45000, '旅費交通費', '大阪出張（往復航空券）', true, 'T6666666666666'),
    _e('demo-034', '2025-09-10T12:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2025-09-10', 'スターバックス 丸の内店', 1200, '会議費', '取引先との打ち合わせ', true, ''),
    // ── 2025-08 ──
    _e('demo-035', '2025-08-20T10:00:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2025-08-20', 'Tech Conference 2025', 20000, '研修費', 'エンジニア向けカンファレンス', true, 'T7777777777777'),
    _e('demo-036', '2025-08-05T14:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2025-08-05', 'アスクル', 3750, '消耗品費', '夏季備品補充', true, ''),
    // ── 2025-07 ──
    _e('demo-037', '2025-07-25T13:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '電車/バス', '2025-07-25', '新宿→立川（往復）', 1000, '旅費交通費', '官公庁訪問', true, ''),
    _e('demo-038', '2025-07-10T10:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2025-07-10', '丸の内ホール', 8800, '接待交際費', '得意先との会食', true, 'T8888888888888'),
    // ── 2025-06 ──
    _e('demo-039', '2025-06-28T11:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2025-06-28', 'キンコーズ', 2200, '消耗品費', '資料印刷・製本', true, ''),
    _e('demo-040', '2025-06-15T14:30:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書なし', '2025-06-15', '社内会議用飲み物', 800, '会議費', '自動販売機利用（領収書なし）', true, ''),
    _e('demo-041', '2025-06-05T09:30:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2025-06-05', 'Amazon Business', 4860, '消耗品費', 'USBハブ・ケーブル類', true, 'T3000000000003'),
    _e('demo-042', '2025-05-20T14:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '電車/バス', '2025-05-20', '渋谷→品川（往復）', 560, '旅費交通費', '取引先定例MTG', true, ''),
    _e('demo-043', '2025-05-10T11:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書なし', '2025-05-10', 'コインパーキング', 400, '旅費交通費', '客先訪問時駐車代', true, ''),
    _e('demo-044', '2025-04-25T10:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2025-04-25', 'ビックカメラ', 12800, '消耗品費', 'ウェブカメラ購入（テレワーク用）', true, 'T4000000000004'),
    // ── 会社払いサンプル ──
    _e('demo-c01', '2026-05-10T10:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2026-05-10', 'AWS（クラウド利用料）', 38500, '通信費', '5月分クラウド費用', true, '', '', '会社払い（三井住友）'),
    _e('demo-c02', '2026-04-30T09:00:00Z', '田中 太郎', 'tanaka@example.com',
       '領収書', '2026-04-30', 'ANAビジネスクラス', 85000, '旅費交通費', '海外出張（ニューヨーク往復）', true, 'T9000000000001', '', '会社払い（楽天）'),
    _e('demo-c03', '2026-03-25T11:00:00Z', '鈴木 花子', 'suzuki@example.com',
       '領収書', '2026-03-25', 'リクナビNEXT 掲載費', 55000, '消耗品費', '中途採用求人掲載（3月）', true, '', '', '会社払い（三井住友）'),
    _e('demo-c04', '2026-02-28T14:00:00Z', 'デモ ユーザー', 'demo@example.com',
       '領収書', '2026-02-28', 'Adobe Creative Cloud', 6578, '通信費', '年間契約・月次引き落とし', true, '', '', '会社払い（楽天）'),
    _e('demo-c05', '2026-01-31T13:00:00Z', '佐藤 次郎', 'sato@example.com',
       '領収書', '2026-01-31', 'Slack（プロプラン）', 4500, '通信費', '月次利用料（25名分）', true, '', '', '会社払い（三井住友）'),
  ];

  const COMPANY_NAME = 'デモCo.';
  // デモ用スプレッドシートID（「リンクを知っている全員が閲覧可」のシートIDを入力）
  const SHEET_ID = '18wDzX43PgeUAXm_Wri-vPogEkkhWNeUhk5F_R1OyFi4';

  const REGULATION = {
    orgName: 'デモCo.',
    repName: 'デモ 太郎',
    address: '東京都渋谷区デモ町1-2-3',
    confirmedAt: '2026年1月1日',
  };

  return { enable, disable, isActive, getRole, setRole, getUserEmail, MASTER, EXPENSES, SHEET_ID, COMPANY_NAME, REGULATION };
})();
