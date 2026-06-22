"""
セットアップガイド用画像処理スクリプト
- 個人情報・APIキーをぼかし
- 操作箇所に赤枠ハイライトを追加
- public/img/setup-guide/ に出力
"""

from PIL import Image, ImageFilter, ImageDraw
import os

UPLOADS = '/root/.claude/uploads/d2fb3ce7-193f-5ab9-9c1d-397d290658b4/'
OUTPUT = '/home/user/keihi-log/public/img/setup-guide/'
os.makedirs(OUTPUT, exist_ok=True)

HIGHLIGHT_COLOR = '#FF3B30'  # 赤
HIGHLIGHT_WIDTH = 8
CORNER_RADIUS = 16

def blur_region(img, box, radius=25):
    """指定領域をガウスぼかし"""
    x1, y1, x2, y2 = [max(0, v) for v in box]
    region = img.crop((x1, y1, x2, y2))
    blurred = region.filter(ImageFilter.GaussianBlur(radius=radius))
    img.paste(blurred, (x1, y1))

def highlight(img, box, color=HIGHLIGHT_COLOR, width=HIGHLIGHT_WIDTH, r=CORNER_RADIUS):
    """赤枠ハイライト（角丸・外側に拡張）"""
    draw = ImageDraw.Draw(img, 'RGBA')
    x1, y1, x2, y2 = box
    pad = 8
    # 半透明の赤い外側グロー
    draw.rounded_rectangle([x1-pad*2, y1-pad*2, x2+pad*2, y2+pad*2],
                           radius=r+8, outline=(255, 59, 48, 60), width=4)
    draw.rounded_rectangle([x1-pad, y1-pad, x2+pad, y2+pad],
                           radius=r+4, outline=(255, 59, 48, 120), width=5)
    # メインの赤枠
    draw.rounded_rectangle([x1, y1, x2, y2], radius=r,
                           outline=color, width=width)

# ──────────────────────────────────────────
# 各ステップの処理定義
# blur: [(x1,y1,x2,y2), ...]  ぼかし領域
# hl:   [(x1,y1,x2,y2), ...]  ハイライト領域
# ──────────────────────────────────────────
STEPS = [
    {   # Step 01: メール → 「経費ログを開いてセットアップする」
        'src': '74a2b97a-1000003449.png',
        'out': 'step01.png',
        'blur': [(0, 88, 864, 130)],          # To: メールアドレス
        'hl':   [(48, 610, 820, 730)],         # 青ボタン
    },
    {   # Step 02: ライセンスキー入力
        'src': 'c2d2c5bc-1000003450.png',
        'out': 'step02.png',
        'blur': [],
        'hl':   [(38, 666, 826, 748)],         # 確認して次へ
    },
    {   # Step 03: チームの基本情報（入力例）
        'src': '5aa8e56c-1000003451.png',
        'out': 'step03.png',
        'blur': [],
        'hl':   [(28, 360, 836, 442)],         # 会社名・チーム名 入力欄
    },
    {   # Step 04: チームURL確認
        'src': '4172d526-1000003452.png',
        'out': 'step04.png',
        'blur': [(28, 348, 500, 410)],         # "test-k" テキスト
        'hl':   [(28, 616, 336, 688),          # URLを入力するボタン
                 (340, 616, 692, 688)],        # このまま続けるボタン
    },
    {   # Step 05: Gemini APIキー設定画面（セットアップ内）
        'src': '7b6ed001-1000003453.png',
        'out': 'step05.png',
        'blur': [(28, 826, 720, 890)],         # AlzaSy... APIキー
        'hl':   [(28, 958, 836, 1040)],        # 次へボタン
    },
    {   # Step 06: Google AI Studio – APIキー一覧
        'src': 'd120d9b8-1000003454.png',
        'out': 'step06.png',
        'blur': [
            (28, 330, 220, 380),               # ...hr_g キー名
            (28, 440, 600, 475),               # プロジェクトID
            (28, 490, 600, 520),               # 作成日時
            (28, 575, 220, 625),               # ...5hzw キー名
            (28, 688, 600, 720),               # プロジェクトID
            (28, 735, 600, 765),               # 作成日時
            (28, 828, 220, 875),               # ...WTUQ キー名
        ],
        'hl':   [(612, 138, 852, 210)],        # APIキーを作成ボタン
    },
    {   # Step 07: 新しいキーを作成ダイアログ
        'src': '5be52da8-1000003455.png',
        'out': 'step07.png',
        'blur': [],
        'hl':   [(602, 1128, 820, 1212)],      # キーを作成ボタン
    },
    {   # Step 08: APIキーの詳細 → コピー
        'src': '8403d5ad-1000003456.png',
        'out': 'step08.png',
        'blur': [
            (28, 478, 756, 528),               # APIキー文字列
            (28, 590, 700, 640),               # プロジェクト名
            (28, 670, 700, 720),               # プロジェクト番号
        ],
        'hl':   [(738, 480, 808, 536)],        # コピーアイコン
    },
    {   # Step 09: 電帳法対応（スキップ可）
        'src': '3463f07d-1000003457.png',
        'out': 'step09.png',
        'blur': [],
        'hl':   [(28, 1628, 700, 1690)],       # スキップして後で設定する
    },
    {   # Step 10: セットアップ実行
        'src': '757b7cf5-1000003458.png',
        'out': 'step10.png',
        'blur': [(498, 648, 748, 698)],        # test-k チーム名
        'hl':   [(38, 748, 826, 848)],         # セットアップ開始ボタン
    },
    {   # Step 11: セットアップ完了
        'src': '3bb8ca79-1000003459.png',
        'out': 'step11.png',
        'blur': [
            (28, 578, 780, 645),               # チームURL
            (148, 658, 568, 978),              # QRコード
        ],
        'hl':   [(38, 1082, 826, 1165)],       # アプリを開くボタン
    },
    {   # Step 12: アプリ起動確認
        'src': '057c0b9e-1000003460.png',
        'out': 'step12.png',
        'blur': [(348, 170, 700, 225)],        # - test-k チーム名部分
        'hl':   [],
    },
    {   # Step 13: Chromeメニュー → ホーム画面に追加
        'src': 'ae7fb780-1000003461.png',
        'out': 'step13.png',
        'blur': [],
        'hl':   [(28, 840, 800, 948)],         # ホーム画面に追加
    },
    {   # Step 14: ホーム画面に追加ダイアログ
        'src': 'f5c953c7-1000003462.png',
        'out': 'step14.png',
        'blur': [],
        'hl':   [(28, 1632, 1052, 1748)],      # インストール
    },
    {   # Step 15: ショートカットを追加
        'src': '0889d6f8-1000003463.png',
        'out': 'step15.png',
        'blur': [],
        'hl':   [(788, 1648, 1052, 1732)],     # 追加ボタン
    },
]

for step in STEPS:
    img = Image.open(UPLOADS + step['src']).convert('RGBA')
    for box in step['blur']:
        blur_region(img, box)
    for box in step['hl']:
        highlight(img, box)
    # RGBAをRGBに変換して保存
    img.convert('RGB').save(OUTPUT + step['out'], 'PNG', optimize=True)
    print(f"  ✓ {step['out']}")

print(f'\n完了: {OUTPUT}')
