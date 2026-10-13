import os
import uuid
from PIL import Image, ImageDraw

def parse_psd_file(psd_path, upload_dir, preview_dir):
    """
    Parses a PSD file or image frame, extracts dimensions, crops transparent side margins,
    generates preview & overlay, and detects photo slot coordinates.
    """
    os.makedirs(upload_dir, exist_ok=True)
    os.makedirs(preview_dir, exist_ok=True)

    file_id = uuid.uuid4().hex[:8]
    ext = os.path.splitext(psd_path)[1].lower()
    
    slots = []
    
    if ext == '.psd':
        try:
            from psd_tools import PSDImage
            psd = PSDImage.open(psd_path)
            composite = psd.composite()
            if composite.mode != 'RGBA':
                composite = composite.convert('RGBA')

            layer_slots = []
            for layer in psd.descendants():
                if layer.kind == 'type':
                    continue  # Ignore text labels, slots must be graphic placeholder shapes/boxes
                name_lower = layer.name.lower() if layer.name else ""
                if any(kw in name_lower for kw in ['photo', 'slot', 'picture', 'camera', 'window', 'pic 1', 'pic 2', 'pic 3']):
                    bbox = layer.bbox
                    if bbox:
                        w = bbox[2] - bbox[0]
                        h = bbox[3] - bbox[1]
                        if w > 60 and h > 60:
                            layer_slots.append({
                                'x': int(bbox[0]),
                                'y': int(bbox[1]),
                                'w': int(w),
                                'h': int(h),
                                'order': len(layer_slots) + 1
                            })
            if layer_slots:
                slots = layer_slots
        except Exception as e:
            print(f"psd-tools parsing warning: {e}. Falling back to standard image processing.")
            composite = Image.open(psd_path).convert('RGBA')
    else:
        composite = Image.open(psd_path).convert('RGBA')

    # Detect color slots or transparent cutouts before cropping
    if not slots:
        slots = detect_colored_slots(composite)
    if not slots:
        slots = detect_transparent_slots(composite)

    # AUTO CROP TRANSPARENT MARGINS (removes blank side padding)
    crop_x, crop_y = 0, 0
    if composite.mode == 'RGBA':
        alpha = composite.split()[3]
        bbox = alpha.getbbox()
        if bbox:
            crop_x, crop_y, crop_x2, crop_y2 = bbox
            crop_w = crop_x2 - crop_x
            crop_h = crop_y2 - crop_y
            # Only crop if there are significant side margins (> 20px difference)
            if crop_w < composite.width - 20 or crop_h < composite.height - 20:
                composite = composite.crop(bbox)
                # Adjust slot coordinates relative to crop origin
                for s in slots:
                    s['x'] = max(0, s['x'] - crop_x)
                    s['y'] = max(0, s['y'] - crop_y)

    # AUTO CROP PRINT-SHEET WHITE PADDING (e.g. 1685x1191 canvas with vertical strip in center)
    if composite.width > composite.height and composite.width > 800:
        rgb_img = composite.convert('RGB')
        corners = [
            rgb_img.getpixel((0, 0)),
            rgb_img.getpixel((composite.width - 1, 0)),
            rgb_img.getpixel((0, composite.height - 1)),
            rgb_img.getpixel((composite.width - 1, composite.height - 1))
        ]
        if all(c[0] > 240 and c[1] > 240 and c[2] > 240 for c in corners):
            min_x, min_y = composite.width, composite.height
            max_x, max_y = 0, 0
            step = 4
            for y in range(0, composite.height, step):
                for x in range(0, composite.width, step):
                    r, g, b = rgb_img.getpixel((x, y))
                    if r < 240 or g < 240 or b < 240:
                        if x < min_x: min_x = x
                        if x > max_x: max_x = x
                        if y < min_y: min_y = y
                        if y > max_y: max_y = y
            if max_x > min_x + 100 and max_y > min_y + 300:
                strip_box = (min_x, min_y, max_x + 1, max_y + 1)
                composite = composite.crop(strip_box)
                # Re-detect slots on cropped strip
                slots = detect_colored_slots(composite)
                if not slots:
                    slots = detect_transparent_slots(composite)

    width, height = composite.size

    # Fallback layout if still no slots found
    if not slots:
        slots = generate_default_slots(width, height)

    # Save preview PNG
    preview_filename = f"prev_{file_id}.png"
    preview_path = os.path.join(preview_dir, preview_filename)
    composite.save(preview_path, 'PNG')

    # Save overlay PNG with placeholder colors cleared and decorative overlaps preserved
    overlay_filename = f"overlay_{file_id}.png"
    overlay_path = os.path.join(preview_dir, overlay_filename)
    overlay = composite.copy().convert('RGBA')

    def is_placeholder_color(r, g, b):
        if abs(r - 189) < 50 and abs(g - 105) < 50 and abs(b - 255) < 50: return True
        if abs(r - 23) < 50 and abs(g - 134) < 50 and abs(b - 255) < 50: return True
        if abs(r - 0) < 50 and abs(g - 191) < 50 and abs(b - 99) < 50: return True
        if r > 190 and 120 < g < 220 and b < 70: return True
        if r > 180 and g < 75 and b < 75: return True
        if r < 60 and 110 < g < 210 and b > 180: return True
        if r < 45 and g < 45 and b < 45: return True
        if b > 120 and r > 80 and g < 90: return True
        return False

    for s in slots:
        sx, sy, sw, sh = s['x'], s['y'], s['w'], s['h']
        margin = 6
        for y in range(sy + margin, min(height, sy + sh - margin)):
            for x in range(sx + margin, min(width, sx + sw - margin)):
                r, g, b, a = overlay.getpixel((x, y))
                if a > 0:
                    is_gold = (r > 140 and g > 100 and b < 110 and r >= g - 25)
                    if not is_gold or is_placeholder_color(r, g, b):
                        overlay.putpixel((x, y), (0, 0, 0, 0))

    overlay.save(overlay_path, 'PNG')

    return {
        'width': width,
        'height': height,
        'preview_filename': preview_filename,
        'overlay_filename': overlay_filename,
        'slots': slots
    }

def detect_colored_slots(composite_img):
    img = composite_img.convert('RGB')
    w, h = img.size
    
    purple_pts, blue_pts, green_pts = [], [], []
    orange_pts, red_pts, alt_blue_pts = [], [], []
    step = 4
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = img.getpixel((x, y))
            # WTM Palette: Purple, Blue, Green
            if abs(r - 189) < 40 and abs(g - 105) < 40 and abs(b - 255) < 40:
                purple_pts.append((x, y))
            elif abs(r - 23) < 40 and abs(g - 134) < 40 and abs(b - 255) < 40:
                blue_pts.append((x, y))
            elif abs(r - 0) < 40 and abs(g - 191) < 40 and abs(b - 99) < 40 and y > (h * 0.45):
                green_pts.append((x, y))
            # Legacy Palette: Orange, Red, Blue
            elif r > 180 and 90 < g < 230 and b < 100:
                orange_pts.append((x, y))
            elif r > 180 and g < 90 and b < 90:
                red_pts.append((x, y))
            elif r < 100 and g < 180 and b > 170:
                alt_blue_pts.append((x, y))

    def bbox_from_points(pts, order, label):
        if not pts or len(pts) < 15:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        bw = max_x - min_x + 1
        bh = max_y - min_y + 1
        if bw > 40 and bh > 40:
            return {
                'x': min_x,
                'y': min_y,
                'w': bw,
                'h': bh,
                'order': order,
                'label': label
            }
        return None

    slots = []
    # Check WTM Purple/Blue/Green palette first
    b1 = bbox_from_points(purple_pts, 1, 'PIC 1 (Purple)')
    b2 = bbox_from_points(blue_pts, 2, 'PIC 2 (Blue)')
    b3 = bbox_from_points(green_pts, 3, 'PIC 3 (Green)')
    if b1 and b2 and b3:
        slots = [b1, b2, b3]
    else:
        # Fall back to legacy Orange/Red/Blue
        o1 = bbox_from_points(orange_pts, 1, 'Pic 1 (Orange)')
        o2 = bbox_from_points(red_pts, 2, 'Pic 2 (Red)')
        o3 = bbox_from_points(alt_blue_pts, 3, 'Pic 3 (Blue)')
        for b in [o1, o2, o3]:
            if b: slots.append(b)

    return slots

def detect_transparent_slots(image):
    if image.mode != 'RGBA':
        return []
    
    alpha = image.split()[3]
    w, h = image.size
    
    step = 10
    transparent_mask = []
    for y in range(0, h, step):
        row = []
        for x in range(0, w, step):
            a = alpha.getpixel((x, y))
            row.append(1 if a < 50 else 0)
        transparent_mask.append(row)

    rows_cnt = len(transparent_mask)
    cols_cnt = len(transparent_mask[0]) if rows_cnt > 0 else 0
    
    visited = [[False]*cols_cnt for _ in range(rows_cnt)]
    clusters = []

    for r in range(rows_cnt):
        for c in range(cols_cnt):
            if transparent_mask[r][c] == 1 and not visited[r][c]:
                queue = [(r, c)]
                visited[r][c] = True
                min_r, max_r = r, r
                min_c, max_c = c, c
                count = 0
                while queue:
                    curr_r, curr_c = queue.pop(0)
                    count += 1
                    min_r = min(min_r, curr_r)
                    max_r = max(max_r, curr_r)
                    min_c = min(min_c, curr_c)
                    max_c = max(max_c, curr_c)

                    for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                        nr, nc = curr_r + dr, curr_c + dc
                        if 0 <= nr < rows_cnt and 0 <= nc < cols_cnt:
                            if transparent_mask[nr][nc] == 1 and not visited[nr][nc]:
                                visited[nr][nc] = True
                                queue.append((nr, nc))

                if count >= 30:
                    box_x = min_c * step
                    box_y = min_r * step
                    box_w = (max_c - min_c + 1) * step
                    box_h = (max_r - min_r + 1) * step

                    if box_w < w * 0.98 or box_h < h * 0.98:
                        clusters.append({
                            'x': box_x,
                            'y': box_y,
                            'w': box_w,
                            'h': box_h,
                            'order': len(clusters) + 1
                        })

    clusters.sort(key=lambda s: (s['y'], s['x']))
    for idx, s in enumerate(clusters):
        s['order'] = idx + 1
    return clusters

def generate_default_slots(width, height):
    aspect = width / height
    slots = []
    
    if aspect < 0.8:
        slot_h = int(height * 0.24)
        slot_w = int(width * 0.84)
        margin_x = int((width - slot_w) / 2)
        top_start = int(height * 0.08)
        spacing = int(height * 0.04)

        for i in range(3):
            slots.append({
                'x': margin_x,
                'y': top_start + i * (slot_h + spacing),
                'w': slot_w,
                'h': slot_h,
                'order': i + 1
            })
    else:
        grid_w = int(width * 0.42)
        grid_h = int(height * 0.38)
        left_margin = int(width * 0.06)
        top_margin = int(height * 0.08)
        gap_x = int(width * 0.04)
        gap_y = int(height * 0.06)

        for row in range(2):
            for col in range(2):
                slots.append({
                    'x': left_margin + col * (grid_w + gap_x),
                    'y': top_margin + row * (grid_h + gap_y),
                    'w': grid_w,
                    'h': grid_h,
                    'order': row * 2 + col + 1
                })
                
    return slots
