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
# 864x1939 画像: step01-12
# 1080x2424 画像: step13（step14・15は削除済み）
STEPS = [
    {   # step01: メール → CTA青ボタン（実測: 青y=971-1073）
        'src': '74a2b97a-1000003449.png',
        'out': 'step01.png',
        'blur': [
            (0, 455, 864, 568),                  # To: + ttt様 + メールアドレス行（y=540-552まで拡張）
            (0, 720, 864, 820),                  # 本文内URL・アドレス（実測y=740-800）
            (0, 835, 864, 875),                  # 本文テキスト（実測y=848-860）
            (0, 1115, 864, 1225),                # ボタン下URL（実測y=1136-1220）
        ],
        'hl':   [(50, 960, 815, 1082)],          # 青ボタン（実測y=971-1073）
    },
    {   # step02: ライセンスキー確認（実測: 青y=862-940）
        'src': 'c2d2c5bc-1000003450.png',
        'out': 'step02.png',
        'blur': [],
        'hl':   [(38, 852, 826, 948)],           # 確認して次へ（実測y=862-940）
    },
    {   # step03: チーム基本情報・空（実測: 入力欄y=748-876）
        'src': '5aa8e56c-1000003451.png',
        'out': 'step03.png',
        'blur': [],
        'hl':   [(28, 742, 836, 882)],           # 会社名入力欄（実測: border y=752, bottom y=876）
    },
    {   # step04: URL確認（チーム名y=644-655, URL y=695-703）
        'src': '4172d526-1000003452.png',
        'out': 'step04.png',
        'blur': [(0, 625, 840, 730)],            # チーム名（y=644-655）+ URL行（y=695-703）まとめてぼかし
        'hl':   [(28, 1255, 335, 1338),          # URLを入力するボタン
                 (340, 1255, 700, 1338)],        # このまま続けるボタン
    },
    {   # step05: Gemini APIページ → AI Studioボタンをタップ（実測: ボタンx=640-836, y=1632-1680）
        'src': '7b6ed001-1000003453.png',
        'out': 'step05.png',
        'blur': [(28, 1683, 720, 1812)],         # AlzaSy... APIキー値
        'hl':   [(640, 1632, 836, 1688)],        # Google AI Studioを開くボタン（実測y=1646-1669）
    },
    {   # step05b: APIキー貼り付け後→次へ（同じ画面、HL対象が異なる）
        'src': '7b6ed001-1000003453.png',
        'out': 'step05b.png',
        'blur': [(28, 1683, 720, 1812)],         # APIキー値（ぼかし済みとして表示）
        'hl':   [(28, 1808, 836, 1896)],         # 次へ（実測y=1813-1888）
    },
    {   # step06: AI Studio APIキー一覧
        'src': 'd120d9b8-1000003454.png',
        'out': 'step06.png',
        'blur': [
            (28, 340, 240, 402),                 # 1枚目 キー名 ...hr_g
            (260, 420, 720, 540),                # 1枚目 プロジェクトID・日付
            (28, 490, 240, 540),                 # 2枚目 キー名 ...5hzw
            (260, 618, 720, 750),                # 2枚目+3枚目 プロジェクト情報まとめ
            (28, 570, 240, 630),                 # 3枚目 キー名 ...WTUQ
        ],
        'hl':   [(510, 355, 830, 402)],          # APIキーを作成ボタン（実測: ページ内y=365-385）
    },
    {   # step07: 新しいキー作成ダイアログ（実測: ボタン行y=1151-1168）
        'src': '5be52da8-1000003455.png',
        'out': 'step07.png',
        'blur': [],
        'hl':   [(440, 1138, 820, 1178)],        # キーを作成ボタン（実測: 右ボタンy=1151-1168）
    },
    {   # step08: APIキー詳細（実測: API key行y=584-600, コピーアイコンx=754-770）
        'src': '8403d5ad-1000003456.png',
        'out': 'step08.png',
        'blur': [
            (28, 572, 748, 618),                 # APIキー文字列（実測y=584-600）
            (28, 695, 700, 775),                 # キー名・中間コンテンツ（実測y=705-760）
            (28, 778, 700, 825),                 # プロジェクト名（実測y=790-810）
            (28, 942, 700, 985),                 # プロジェクト番号（実測y=955-970）
        ],
        'hl':   [(748, 582, 836, 622)],          # コピーアイコン（実測x=754-770, y=585-600）
    },
    {   # step09: 電帳法対応（実測: 青「次へ」y=1504-1583）
        'src': '3463f07d-1000003457.png',
        'out': 'step09.png',
        'blur': [],
        'hl':   [(28, 1496, 836, 1590)],         # 次へボタン（電帳法推奨）
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
            (0, 600, 864, 712),                  # チームURL（実測y=620-648, 上端拡大）
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
    {   # step13: Chromeメニュー 1080x2424（実測: ホーム画面に追加 y=634-666）
        'src': 'ae7fb780-1000003461.png',
        'out': 'step13.png',
        'blur': [],
        'hl':   [(100, 618, 900, 678)],          # ホーム画面に追加（実測y=634-666, 幅縮小）
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
