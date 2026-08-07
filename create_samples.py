import os
from PIL import Image, ImageDraw, ImageFont
import database
import json

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), 'static', 'uploads')
PREVIEW_DIR = os.path.join(os.path.dirname(__file__), 'static', 'previews')

def create_sample_templates():
    database.init_db()
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    # 1. CLASSIC 3-STRIP VINTAGE TEMPLATE (600 x 1500)
    w1, h1 = 600, 1500
    img1 = Image.new('RGBA', (w1, h1), (20, 20, 25, 255))
    draw1 = ImageDraw.Draw(img1)
    
    # Outer vintage frame
    draw1.rectangle([15, 15, w1-15, h1-15], outline=(230, 180, 80, 255), width=6)
    draw1.rectangle([25, 25, w1-25, h1-25], outline=(150, 100, 40, 255), width=2)
    
    # 3 photo slots (transparent cutouts in overlay)
    slot_w1 = 500
    slot_h1 = 360
    slot_x1 = 50
    slots1 = []
    
    start_y1 = 60
    gap1 = 40
    
    for i in range(3):
        sy = start_y1 + i * (slot_h1 + gap1)
        slots1.append({'x': slot_x1, 'y': sy, 'w': slot_w1, 'h': slot_h1, 'order': i + 1})
        # Clear out transparent cutout area in overlay
        draw1.rectangle([slot_x1, sy, slot_x1 + slot_w1, sy + slot_h1], fill=(0, 0, 0, 0))
        # Draw frame border around slot
        draw1.rectangle([slot_x1-4, sy-4, slot_x1 + slot_w1 + 4, sy + slot_h1 + 4], outline=(230, 180, 80, 255), width=4)

    # Bottom branding area
    draw1.rectangle([50, 1280, 550, 1440], fill=(35, 35, 45, 255), outline=(230, 180, 80, 255), width=2)
    draw1.text((300, 1340), "★ CLASSIC PHOTOBOOTH ★", fill=(240, 210, 140, 255), anchor="mm")
    draw1.text((300, 1380), "MEMORIES FOREVER", fill=(180, 180, 190, 255), anchor="mm")

    prev_path1 = os.path.join(PREVIEW_DIR, "sample_vintage_strip.png")
    over_path1 = os.path.join(PREVIEW_DIR, "sample_vintage_strip.png")
    img1.save(prev_path1, 'PNG')

    # Check if already exists in DB
    existing = [t for t in database.get_all_templates() if t['name'] == 'Classic Vintage 3-Strip']
    if not existing:
        database.save_template(
            name='Classic Vintage 3-Strip',
            filename='sample_vintage_strip.png',
            psd_path=None,
            preview_path='sample_vintage_strip.png',
            overlay_path='sample_vintage_strip.png',
            width=w1,
            height=h1,
            slots=slots1
        )
        print("Created template: Classic Vintage 3-Strip")

    # 2. NEON CYBERPUNK 2x2 GRID TEMPLATE (1200 x 1000)
    w2, h2 = 1200, 1000
    img2 = Image.new('RGBA', (w2, h2), (12, 14, 28, 255))
    draw2 = ImageDraw.Draw(img2)
    
    # Modern neon border grid
    draw2.rectangle([20, 20, w2-20, h2-20], outline=(0, 240, 255, 255), width=4)
    draw2.rectangle([28, 28, w2-28, h2-28], outline=(255, 0, 150, 255), width=2)
    
    # Header title
    draw2.rectangle([40, 40, w2-40, 110], fill=(22, 26, 48, 255), outline=(0, 240, 255, 255), width=2)
    draw2.text((w2 // 2, 75), "⚡ CYBER PHOTOSTUDIO ⚡", fill=(0, 240, 255, 255), anchor="mm")

    # 2x2 Grid slots
    grid_w = 510
    grid_h = 360
    left_m = 60
    top_m = 140
    gap_x = 60
    gap_y = 40
    slots2 = []

    for row in range(2):
        for col in range(2):
            sx = left_m + col * (grid_w + gap_x)
            sy = top_m + row * (grid_h + gap_y)
            slots2.append({'x': sx, 'y': sy, 'w': grid_w, 'h': grid_h, 'order': row * 2 + col + 1})
            # Transparent cutout area
            draw2.rectangle([sx, sy, sx + grid_w, sy + grid_h], fill=(0, 0, 0, 0))
            # Glowing double neon border
            draw2.rectangle([sx-4, sy-4, sx + grid_w + 4, sy + grid_h + 4], outline=(255, 0, 150, 255), width=3)
            draw2.rectangle([sx-8, sy-8, sx + grid_w + 8, sy + grid_h + 8], outline=(0, 240, 255, 255), width=2)

    # Footer
    draw2.text((w2 // 2, 955), "SELF-HOSTED PYTHON PHOTOBOOTH STUDIO", fill=(140, 160, 200, 255), anchor="mm")

    prev_path2 = os.path.join(PREVIEW_DIR, "sample_cyber_grid.png")
    img2.save(prev_path2, 'PNG')

    existing2 = [t for t in database.get_all_templates() if t['name'] == 'Neon Cyberpunk 2x2']
    if not existing2:
        database.save_template(
            name='Neon Cyberpunk 2x2',
            filename='sample_cyber_grid.png',
            psd_path=None,
            preview_path='sample_cyber_grid.png',
            overlay_path='sample_cyber_grid.png',
            width=w2,
            height=h2,
            slots=slots2
        )
        print("Created template: Neon Cyberpunk 2x2")

if __name__ == '__main__':
    create_sample_templates()
