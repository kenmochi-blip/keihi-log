"""
セットアップガイド用画像処理スクリプト（座標実測版）
"""

from PIL import Image, ImageFilter, ImageDraw
import os

UPLOADS = '/root/.claude/uploads/d2fb3ce7-193f-5ab9-9c1d-397d290658b4/'
OUTPUT = '/home/user/keihi-log/public/img/setup-guide/'
os.makedirs(OUTPUT, exist_ok=True)

HIGHLIGHT_COLOR = '#FF3B30'
HIGHLIGHT_WIDTH = 8
CORNER_RADIUS = 16

def blur_region(img, box, radius=28):
    x1, y1, x2, y2 = [max(0, v) for v in box]
    region = img.crop((x1, y1, x2, y2))
    blurred = region.filter(ImageFilter.GaussianBlur(radius=radius))
    img.paste(blurred, (x1, y1))

def highlight(img, box, color=HIGHLIGHT_COLOR, width=HIGHLIGHT_WIDTH, r=CORNER_RADIUS):
    draw = ImageDraw.Draw(img, 'RGBA')
    x1, y1, x2, y2 = box
    pad = 8
    draw.rounded_rectangle([x1-pad*2, y1-pad*2, x2+pad*2, y2+pad*2],
                           radius=r+8, outline=(255, 59, 48, 60), width=4)
    draw.rounded_rectangle([x1-pad, y1-pad, x2+pad, y2+pad],
                           radius=r+4, outline=(255, 59, 48, 120), width=5)
    draw.rounded_rectangle([x1, y1, x2, y2], radius=r,
                           outline=color, width=width)

# 実測値に基づく座標定義
# 864x1939 画像: y=455-512 がステップドット付近
# 1080x2424 画像: step13-15
STEPS = [
    {   # step01: メール → CTA青ボタン（実測: 青y=971-1073）
        'src': '74a2b97a-1000003449.png',
        'out': 'step01.png',
        'blur': [(0, 462, 864, 525)],           # To: メールアドレス行
        'hl':   [(50, 960, 815, 1082)],          # 青ボタン（実測y=971-1073）
    },
    {   # step02: ライセンスキー確認（実測: 青y=862-940）
        'src': 'c2d2c5bc-1000003450.png',
        'out': 'step02.png',
        'blur': [],
        'hl':   [(38, 852, 826, 948)],           # 確認して次へ（実測y=862-940）
    },
    {   # step03: チーム基本情報・空（実測: 青「次へ」y=1187-1265）
        'src': '5aa8e56c-1000003451.png',
        'out': 'step03.png',
        'blur': [],
        'hl':   [(28, 700, 836, 790)],           # 会社名入力欄（次へy=1187の上）
    },
    {   # step04: URL確認（実測: 黄ボタンy=1266-1329）
        'src': '4172d526-1000003452.png',
        'out': 'step04.png',
        'blur': [(28, 695, 500, 790)],           # test-k テキスト
        'hl':   [(28, 1255, 335, 1338),          # URLを入力するボタン
                 (340, 1255, 700, 1338)],        # このまま続けるボタン
    },
    {   # step05: Gemini API入力（実測: 青「次へ」y=1813-1888, 白入力欄y=1683-1812）
        'src': '7b6ed001-1000003453.png',
        'out': 'step05.png',
        'blur': [(28, 1683, 720, 1812)],         # AlzaSy... APIキー値
        'hl':   [(28, 1808, 836, 1896)],         # 次へ（実測y=1813-1888）
    },
    {   # step06: AI Studio APIキー一覧
        'src': 'd120d9b8-1000003454.png',
        'out': 'step06.png',
        'blur': [
            (28, 340, 240, 402),                 # 1枚目 キー名 ...hr_g（実測y=351-393）
            (260, 420, 720, 530),                # 1枚目 プロジェクトID・日付（実測y=494-519）
            (28, 490, 240, 530),                 # 2枚目 キー名 ...5hzw の一部
            (260, 640, 720, 720),                # 2枚目 プロジェクト情報
            (28, 570, 240, 620),                 # 3枚目 キー名 ...WTUQ（実測y=580-602）
        ],
        'hl':   [(590, 172, 856, 242)],          # APIキーを作成ボタン（ページ上部右）
    },
    {   # step07: 新しいキー作成ダイアログ（実測: 暗テキストy=1081-1103付近）
        'src': '5be52da8-1000003455.png',
        'out': 'step07.png',
        'blur': [],
        'hl':   [(524, 1140, 832, 1188)],        # キーを作成ボタン
    },
    {   # step08: APIキー詳細（実測: 暗テキストy=575-606=API key行）
        'src': '8403d5ad-1000003456.png',
        'out': 'step08.png',
        'blur': [
            (28, 558, 748, 618),                 # APIキー文字列（実測y=575-606）
            (28, 778, 700, 822),                 # プロジェクト名（実測y=784-810）
            (28, 892, 700, 932),                 # プロジェクト番号（実測y=903-923）
        ],
        'hl':   [(752, 558, 836, 618)],          # コピーアイコン
    },
    {   # step09: 電帳法対応（実測: 青「次へ」y=1504-1583）
        'src': '3463f07d-1000003457.png',
        'out': 'step09.png',
        'blur': [],
        'hl':   [(28, 1590, 700, 1658)],         # スキップリンク（次へy=1504-1583の直下）
    },
    {   # step10: セットアップ実行（実測: 青「セットアップ開始」y=942-1020）
        'src': '757b7cf5-1000003458.png',
        'out': 'step10.png',
        'blur': [(448, 738, 752, 822)],          # test-k（サマリーカード右列）
        'hl':   [(38, 935, 826, 1028)],          # セットアップ開始（実測y=942-1020）
    },
    {   # step11: セットアップ完了（実測: 青「アプリを開く」y=1660-1819, QRy=1012-1318）
        'src': '3bb8ca79-1000003459.png',
        'out': 'step11.png',
        'blur': [
            (28, 603, 762, 660),                 # チームURL（実測y=613-652）
            (140, 1005, 572, 1325),              # QRコード（実測y=1012-1318）
        ],
        'hl':   [(38, 1652, 826, 1828)],         # アプリを開く（実測y=1660-1819）
    },
    {   # step12: アプリ起動（実測: 青ヘッダーy=242-348）
        'src': '057c0b9e-1000003460.png',
        'out': 'step12.png',
        'blur': [(228, 262, 438, 322)],          # - test-k（ヘッダー内チーム名部分）
        'hl':   [],
    },
    {   # step13: Chromeメニュー 1080x2424（実測: テキスト行 453-484, 510-541）
        'src': 'ae7fb780-1000003461.png',
        'out': 'step13.png',
        'blur': [],
        'hl':   [(28, 492, 872, 558)],           # ホーム画面に追加（3番目メニュー項目）
    },
    {   # step14: ホーム画面追加ダイアログ 1080x2424（実測: ショートカットy=1825-1875）
        'src': 'f5c953c7-1000003462.png',
        'out': 'step14.png',
        'blur': [],
        'hl':   [(28, 1808, 1052, 2095)],        # ショートカットを作成（実測y=1825-2066）
    },
    {   # step15: ショートカット確認 1080x2424（実測: テキストy=1977-2007）
        'src': '0889d6f8-1000003463.png',
        'out': 'step15.png',
        'blur': [],
        'hl':   [(800, 1965, 1052, 2018)],       # 追加ボタン（実測y=1977-2007）
    },
]

for step in STEPS:
    img = Image.open(UPLOADS + step['src']).convert('RGBA')
    for box in step['blur']:
        blur_region(img, box)
    for box in step['hl']:
        highlight(img, box)
    img.convert('RGB').save(OUTPUT + step['out'], 'PNG', optimize=True)
    print(f'  ✓ {step["out"]}')

print(f'\n完了: {OUTPUT}')
