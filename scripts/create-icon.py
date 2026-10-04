from pathlib import Path
from PIL import Image, ImageDraw

# 与应用内叠层标志一致的本地图标，不依赖外部图片。
root = Path(__file__).resolve().parents[1]
assets = root / 'assets'
assets.mkdir(exist_ok=True)
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((12, 12, 500, 500), radius=112, fill='#f3f5ef')
orange = '#df7752'
for y in (316, 250, 184):
    draw.line([(113, y), (256, y + 74), (399, y)], fill=orange, width=22, joint='curve')
draw.line([(113, 184), (256, 110), (399, 184)], fill=orange, width=22, joint='curve')
image.save(assets / 'icon.png')
image.save(assets / 'icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
