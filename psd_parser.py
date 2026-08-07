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
                name_lower = layer.name.lower() if layer.name else ""
                if any(kw in name_lower for kw in ['photo', 'slot', 'picture', 'camera', 'window', 'pic 1', 'pic 2', 'pic 3']):
                    bbox = layer.bbox
                    if bbox:
                        w = bbox[2] - bbox[0]
                        h = bbox[3] - bbox[1]
                        if w > 20 and h > 20:
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

    width, height = composite.size

    # Fallback layout if still no slots found
    if not slots:
        slots = generate_default_slots(width, height)

    # Save preview PNG
    preview_filename = f"prev_{file_id}.png"
    preview_path = os.path.join(preview_dir, preview_filename)
    composite.save(preview_path, 'PNG')

    # Save overlay PNG
    overlay_filename = f"overlay_{file_id}.png"
    overlay_path = os.path.join(preview_dir, overlay_filename)
    composite.save(overlay_path, 'PNG')

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
    
    orange_pts, red_pts, blue_pts = [], [], []
    step = 5
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = img.getpixel((x, y))
            if r > 180 and 90 < g < 230 and b < 100:
                orange_pts.append((x, y))
            elif r > 180 and g < 90 and b < 90:
                red_pts.append((x, y))
            elif r < 100 and g < 180 and b > 170:
                blue_pts.append((x, y))

    def bbox_from_points(pts, order, label):
        if not pts or len(pts) < 15:
            return None
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        bw = max_x - min_x
        bh = max_y - min_y
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
    b1 = bbox_from_points(orange_pts, 1, 'Pic 1 (Orange)')
    b2 = bbox_from_points(red_pts, 2, 'Pic 2 (Red)')
    b3 = bbox_from_points(blue_pts, 3, 'Pic 3 (Blue)')

    for b in [b1, b2, b3]:
        if b:
            slots.append(b)

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
