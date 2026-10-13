import os
import sys
try:
    sys.stdout.reconfigure(encoding='utf-8', write_through=True)
    sys.stderr.reconfigure(encoding='utf-8', write_through=True)
except Exception:
    pass
import time
import datetime
import uuid
import json
import base64
import shutil
import subprocess
import ssl
import urllib.request
from io import BytesIO
from flask import Flask, request, jsonify, send_from_directory
from PIL import Image, ImageDraw, ImageEnhance, ImageOps, ImageFilter
import database
import psd_parser
import create_samples

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(BASE_DIR, 'static'), static_url_path='/static')
UPLOAD_DIR = os.path.join(BASE_DIR, 'static', 'uploads')
PREVIEW_DIR = os.path.join(BASE_DIR, 'static', 'previews')
SESSION_DIR = os.path.join(BASE_DIR, 'static', 'sessions')
AUDIO_DIR = os.path.join(BASE_DIR, 'audio')
def get_default_raw_dir():
    if os.path.exists("D:\\"):
        return r"D:\PSSC-WTM-PHOTOBOOTH-EVENT"
    return os.path.join(os.path.expanduser("~"), "Downloads", "PSSC-WTM-PHOTOBOOTH-EVENT")

RAW_CLIPS_DIR = os.environ.get("RAW_CLIPS_DIR", get_default_raw_dir())
FFMPEG_BIN = os.path.join(BASE_DIR, 'bin', 'ffmpeg.exe')

def get_session_raw_dir(queue_number, guest_name, session_time=None):
    clean_guest = "".join([c if (c.isalnum() or c in (' ', '_', '-')) else '_' for c in (guest_name or 'Guest')]).strip()
    safe_name = " ".join(clean_guest.split()) or 'Guest'
    if not session_time:
        session_time = datetime.datetime.now()
    date_time_str = session_time.strftime('%Y-%m-%d %H-%M-%S')
    folder_name = f"Queue #{queue_number} - {safe_name} - {date_time_str}"
    target_dir = os.path.join(RAW_CLIPS_DIR, folder_name)
    os.makedirs(target_dir, exist_ok=True)
    return target_dir, folder_name, safe_name

def find_or_create_session_raw_dir(queue_number, guest_name=None, session_folder_name=None):
    if session_folder_name:
        target_dir = os.path.join(RAW_CLIPS_DIR, session_folder_name)
        if os.path.exists(target_dir):
            clean_guest = "".join([c if (c.isalnum() or c in (' ', '_', '-')) else '_' for c in (guest_name or 'Guest')]).strip()
            safe_name = " ".join(clean_guest.split()) or 'Guest'
            return target_dir, session_folder_name, safe_name

    clean_guest = "".join([c if (c.isalnum() or c in (' ', '_', '-')) else '_' for c in (guest_name or 'Guest')]).strip()
    safe_name = " ".join(clean_guest.split()) or 'Guest'
    q_str = str(queue_number)

    if os.path.exists(RAW_CLIPS_DIR):
        candidates = []
        for d in os.listdir(RAW_CLIPS_DIR):
            if (d.startswith(f"Queue #{q_str} -") or d.startswith(f"Queue_{q_str}_") or
                d.startswith(f"Queue #{q_str}_") or d.startswith(f"Queue_{q_str} -")):
                full_p = os.path.join(RAW_CLIPS_DIR, d)
                if os.path.isdir(full_p):
                    candidates.append((os.path.getmtime(full_p), d, full_p))
        if candidates:
            candidates.sort(reverse=True)
            chosen = candidates[0]
            return chosen[2], chosen[1], safe_name

    return get_session_raw_dir(queue_number, safe_name)

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)
os.makedirs(SESSION_DIR, exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)
os.makedirs(RAW_CLIPS_DIR, exist_ok=True)

# Initialize Database and default sample templates
database.init_db()
try:
    create_samples.create_sample_templates()
except Exception as e:
    print(f"Sample generation notice: {e}")

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join('static', 'img'), 'pssc_logo.png')

@app.route('/css/<path:filename>')
def serve_css(filename):
    return send_from_directory(os.path.join('static', 'css'), filename)

@app.route('/js/<path:filename>')
def serve_js(filename):
    return send_from_directory(os.path.join('static', 'js'), filename)

@app.route('/previews/<path:filename>')
def serve_previews(filename):
    return send_from_directory(PREVIEW_DIR, filename)

@app.route('/uploads/<path:filename>')
def serve_uploads(filename):
    return send_from_directory(UPLOAD_DIR, filename)

@app.route('/sessions/<path:filename>')
def serve_sessions(filename):
    return send_from_directory(SESSION_DIR, filename)

@app.route('/audio/<path:filename>')
def serve_audio(filename):
    return send_from_directory(AUDIO_DIR, filename)

# --- TEMPLATE APIS ---

@app.route('/api/templates', methods=['GET'])
def get_templates():
    templates = database.get_all_templates()
    for t in templates:
        t['preview_url'] = f"/previews/{t['preview_path']}"
        t['overlay_url'] = f"/previews/{t['overlay_path']}"
    return jsonify({'success': True, 'templates': templates})

@app.route('/api/templates/<int:template_id>', methods=['GET'])
def get_template(template_id):
    t = database.get_template(template_id)
    if not t:
        return jsonify({'success': False, 'error': 'Template not found'}), 404
    t['preview_url'] = f"/previews/{t['preview_path']}"
    t['overlay_url'] = f"/previews/{t['overlay_path']}"
    return jsonify({'success': True, 'template': t})

@app.route('/api/templates/import', methods=['POST'])
def import_template():
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No file uploaded'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'error': 'Empty filename'}), 400

    title = request.form.get('title', '').strip() or os.path.splitext(file.filename)[0]
    
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ['.psd', '.png', '.jpg', '.jpeg', '.webp']:
        return jsonify({'success': False, 'error': 'Unsupported file format. Please upload PSD, PNG, or JPG files.'}), 400

    filename = f"{uuid.uuid4().hex[:8]}_{file.filename}"
    saved_path = os.path.join(UPLOAD_DIR, filename)
    file.save(saved_path)

    try:
        parsed = psd_parser.parse_psd_file(saved_path, UPLOAD_DIR, PREVIEW_DIR)
        
        template_id = database.save_template(
            name=title,
            filename=filename,
            psd_path=filename if ext == '.psd' else None,
            preview_path=parsed['preview_filename'],
            overlay_path=parsed['overlay_filename'],
            width=parsed['width'],
            height=parsed['height'],
            slots=parsed['slots']
        )
        
        saved_t = database.get_template(template_id)
        saved_t['preview_url'] = f"/previews/{saved_t['preview_path']}"
        saved_t['overlay_url'] = f"/previews/{saved_t['overlay_path']}"
        
        return jsonify({
            'success': True,
            'message': 'Template imported and saved to database successfully!',
            'template': saved_t
        })
    except Exception as e:
        return jsonify({'success': False, 'error': f"Failed to parse PSD/Image template: {str(e)}"}), 500

@app.route('/api/templates/<int:template_id>/slots', methods=['PUT'])
def update_template_slots(template_id):
    data = request.json
    slots = data.get('slots', [])
    t = database.get_template(template_id)
    if not t:
        return jsonify({'success': False, 'error': 'Template not found'}), 404
    
    with database.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('UPDATE templates SET slots_json = ? WHERE id = ?', (json.dumps(slots), template_id))
        conn.commit()
        
    return jsonify({'success': True, 'message': 'Template slots updated in database.'})

@app.route('/api/templates/<int:template_id>', methods=['DELETE'])
def delete_template(template_id):
    t = database.delete_template(template_id)
    if t:
        return jsonify({'success': True, 'message': 'Template deleted from database.'})
    return jsonify({'success': False, 'error': 'Template not found'}), 404

# --- PHOTOBOOTH COMPOSITING & SESSION APIS ---

def apply_image_filter(img, filter_type):
    """Applies color/artistic filters to a photo using Pillow."""
    if not filter_type or filter_type == 'normal':
        return img

    alpha = img.split()[3] if img.mode == 'RGBA' else None
    
    if filter_type == 'k_glow':
        rgb = img.convert('RGB')
        rgb = ImageEnhance.Brightness(rgb).enhance(1.08)
        rgb = ImageEnhance.Contrast(rgb).enhance(1.04)
        rgb = ImageEnhance.Color(rgb).enhance(1.06)
        blurred = rgb.filter(ImageFilter.GaussianBlur(radius=4))
        res = Image.blend(rgb, blurred, alpha=0.15)
        if alpha:
            res.putalpha(alpha)
            return res
        return res.convert('RGBA')

    elif filter_type == 'haru_blue':
        rgb = img.convert('RGB')
        r, g, b = rgb.split()
        r = r.point(lambda i: max(0, min(255, int(i * 0.96))))
        b = b.point(lambda i: max(0, min(255, int(i * 1.06 + 8))))
        rgb = Image.merge('RGB', (r, g, b))
        rgb = ImageEnhance.Contrast(rgb).enhance(1.06)
        rgb = ImageEnhance.Brightness(rgb).enhance(1.04)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'portra':
        rgb = img.convert('RGB')
        r, g, b = rgb.split()
        r = r.point(lambda i: min(255, int(i * 1.08 + 6)))
        g = g.point(lambda i: min(255, int(i * 1.02 + 2)))
        b = b.point(lambda i: max(0, int(i * 0.90)))
        rgb = Image.merge('RGB', (r, g, b))
        rgb = ImageEnhance.Contrast(rgb).enhance(1.08)
        rgb = ImageEnhance.Color(rgb).enhance(1.15)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'fuji_provia':
        rgb = img.convert('RGB')
        r, g, b = rgb.split()
        g = g.point(lambda i: min(255, int(i * 1.04)))
        b = b.point(lambda i: min(255, int(i * 1.06)))
        rgb = Image.merge('RGB', (r, g, b))
        rgb = ImageEnhance.Contrast(rgb).enhance(1.15)
        rgb = ImageEnhance.Color(rgb).enhance(1.25)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'bw':
        gray = ImageOps.grayscale(img)
        gray = ImageEnhance.Contrast(gray).enhance(1.25)
        gray = ImageEnhance.Brightness(gray).enhance(1.02)
        res = gray.convert('RGBA')
        if alpha:
            res.putalpha(alpha)
        return res

    elif filter_type == 'golden':
        rgb = img.convert('RGB')
        r, g, b = rgb.split()
        r = r.point(lambda i: min(255, int(i * 1.15 + 10)))
        g = g.point(lambda i: min(255, int(i * 1.03 + 2)))
        b = b.point(lambda i: max(0, int(i * 0.80)))
        rgb = Image.merge('RGB', (r, g, b))
        rgb = ImageEnhance.Contrast(rgb).enhance(1.08)
        rgb = ImageEnhance.Color(rgb).enhance(1.30)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'vintage':
        rgb = img.convert('RGB')
        rgb = ImageEnhance.Color(rgb).enhance(0.85)
        rgb = ImageEnhance.Contrast(rgb).enhance(1.12)
        r, g, b = rgb.split()
        r = r.point(lambda i: min(255, int(i * 1.06 + 8)))
        b = b.point(lambda i: max(0, int(i * 0.88)))
        rgb = Image.merge('RGB', (r, g, b))
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'cinematic':
        rgb = img.convert('RGB')
        r, g, b = rgb.split()
        r = r.point(lambda i: min(255, int(i * 1.08)) if i > 128 else max(0, int(i * 0.90)))
        b = b.point(lambda i: min(255, int(i * 1.12)) if i < 128 else max(0, int(i * 0.94)))
        rgb = Image.merge('RGB', (r, g, b))
        rgb = ImageEnhance.Contrast(rgb).enhance(1.20)
        rgb = ImageEnhance.Color(rgb).enhance(1.10)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'indie':
        rgb = img.convert('RGB')
        r, g, b = rgb.split()
        r = r.point(lambda i: int(22 + i * (233 / 255.0)))
        g = g.point(lambda i: int(20 + i * (235 / 255.0)))
        b = b.point(lambda i: int(24 + i * (231 / 255.0)))
        rgb = Image.merge('RGB', (r, g, b))
        rgb = ImageEnhance.Contrast(rgb).enhance(0.92)
        rgb = ImageEnhance.Color(rgb).enhance(0.88)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'cyberpunk':
        rgb = img.convert('RGB')
        r, g, b = rgb.split()
        r = r.point(lambda i: min(255, int(i * 1.22)))
        b = b.point(lambda i: min(255, int(i * 1.35)))
        rgb = Image.merge('RGB', (r, g, b))
        rgb = ImageEnhance.Color(rgb).enhance(1.45)
        rgb = ImageEnhance.Contrast(rgb).enhance(1.15)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'vivid':
        rgb = img.convert('RGB')
        rgb = ImageEnhance.Color(rgb).enhance(1.65)
        rgb = ImageEnhance.Contrast(rgb).enhance(1.15)
        rgb = ImageEnhance.Brightness(rgb).enhance(1.03)
        if alpha:
            rgb.putalpha(alpha)
            return rgb
        return rgb.convert('RGBA')

    elif filter_type == 'sepia':
        bw = ImageOps.grayscale(img)
        sepia_img = Image.new('RGB', bw.size)
        pixels = sepia_img.load()
        bw_pixels = bw.load()
        for x in range(bw.width):
            for y in range(bw.height):
                p = bw_pixels[x, y]
                r = min(255, int(p * 1.08))
                g = min(255, int(p * 0.90))
                b = min(255, int(p * 0.68))
                pixels[x, y] = (r, g, b)
        res = sepia_img.convert('RGBA')
        if alpha:
            res.putalpha(alpha)
        return res

    elif filter_type == 'blur':
        return img.filter(ImageFilter.GaussianBlur(radius=2))

    return img

@app.route('/api/session/composite', methods=['POST'])
def composite_session():
    data = request.json or {}
    template_id = data.get('template_id')
    photos_b64 = data.get('photos', [])
    raw_photos_b64 = data.get('raw_photos', [])
    filter_name = data.get('filter', 'normal')
    guest_name_input = data.get('guest_name', 'Guest').strip() or 'Guest'
    layout_option = data.get('layout', 'single') # 'single' or 'double'
    corners_style = (data.get('corners') or 'sharp').lower() # 'sharp' or 'curved'
    paid_status = (data.get('paid') or 'Paid').strip()
    given_status = (data.get('given') or 'Not Given').strip()

    t = database.get_template(template_id)
    if not t:
        return jsonify({'success': False, 'error': 'Template not found'}), 404

    orig_width = t['width']
    orig_height = t['height']
    slots = t['slots']

    # ── HIGH-RESOLUTION MASTERING ENGINE (Retina 300+ DPI Print & Download Quality) ──
    # If the imported template resolution is below master print size (e.g. 377x1076),
    # dynamically upscale the canvas and slots so that:
    # 1. Camera photos are placed into slots at their full native resolution (~1080p / 720p)
    # 2. Downloaded PNGs are ultra-sharp (>3000px high), crystal-clear on any screen or printout!
    max_dim = max(orig_width, orig_height)
    if max_dim <= 800:
        scale_factor = 4.0
    elif max_dim <= 1200:
        scale_factor = 3.0
    elif max_dim <= 1800:
        scale_factor = 2.0
    else:
        scale_factor = 1.0

    width = int(round(orig_width * scale_factor))
    height = int(round(orig_height * scale_factor))

    scaled_slots = []
    for s in slots:
        scaled_slots.append({
            'x': int(round(s['x'] * scale_factor)),
            'y': int(round(s['y'] * scale_factor)),
            'w': int(round(s['w'] * scale_factor)),
            'h': int(round(s['h'] * scale_factor))
        })

    # Optional Google Sheets Database URL
    sheets_url = database.get_config('google_sheets_url', '').strip()

    # Queue Number Tracking (counts sequentially 1, 2, 3...)
    queue_number = database.get_next_queue_number()
    code = f"#{queue_number}"
    now = datetime.datetime.now()
    date_str_formatted = now.strftime('%d/%m/%Y %H:%M:%S')
    time_stamp_filename = now.strftime('%Y-%m-%d_%H-%M-%S')

    safe_guest_name = "".join([c for c in guest_name_input if c.isalnum() or c in (' ', '_', '-')]).strip() or 'Guest'
    output_filename = f"PSSCBooth_Q{queue_number}_{safe_guest_name}_{time_stamp_filename}.png"

    # Load top frame overlay and upscale to master resolution
    overlay_full_path = os.path.join(PREVIEW_DIR, t['overlay_path'])
    if os.path.exists(overlay_full_path):
        overlay = Image.open(overlay_full_path).convert('RGBA')
        if scale_factor > 1.0:
            overlay = overlay.resize((width, height), Image.Resampling.LANCZOS)
    else:
        overlay = Image.new('RGBA', (width, height), (0, 0, 0, 0))

    # Base background image where photos will be composited (preserves full template artwork/strip design)
    preview_full_path = os.path.join(PREVIEW_DIR, t['preview_path'])
    if os.path.exists(preview_full_path):
        base_img = Image.open(preview_full_path).convert('RGBA')
        if scale_factor > 1.0:
            base_img = base_img.resize((width, height), Image.Resampling.LANCZOS)
    elif os.path.exists(overlay_full_path):
        base_img = overlay.copy()
    else:
        base_img = Image.new('RGBA', (width, height), (245, 245, 250, 255))

    # Fit photos into slots with full sensor detail
    source_photos = raw_photos_b64 if (raw_photos_b64 and len(raw_photos_b64) >= len(scaled_slots)) else photos_b64

    for idx, slot in enumerate(scaled_slots):
        if idx >= len(source_photos):
            break
        
        b64_str = source_photos[idx]
        if ',' in b64_str:
            b64_str = b64_str.split(',')[1]
        
        photo_bytes = base64.b64decode(b64_str)
        photo_img = Image.open(BytesIO(photo_bytes)).convert('RGBA')
        
        # Apply filter cleanly
        if source_photos is raw_photos_b64:
            photo_img = apply_image_filter(photo_img, filter_name)

        # Expand target dimensions by scaled padding so photo completely fills the colored box frame with zero edge gap
        pad = int(round(4 * scale_factor))
        target_w, target_h = slot['w'] + (pad * 2), slot['h'] + (pad * 2)
        paste_x, paste_y = max(0, slot['x'] - pad), max(0, slot['y'] - pad)

        photo_aspect = photo_img.width / photo_img.height
        target_aspect = target_w / target_h

        if photo_aspect > target_aspect:
            new_h = target_h
            new_w = int(target_h * photo_aspect)
        else:
            new_w = target_w
            new_h = int(target_w / photo_aspect)

        photo_resized = photo_img.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # Center crop to target slot dimensions
        left = (new_w - target_w) // 2
        top = (new_h - target_h) // 2
        photo_cropped = photo_resized.crop((left, top, left + target_w, top + target_h))

        # Gentle studio unsharp mask to bring out crisp eye/smile details in high resolution
        try:
            photo_cropped = photo_cropped.filter(ImageFilter.UnsharpMask(radius=1.1, percent=108, threshold=2))
        except Exception:
            pass

        use_curves = (corners_style == 'curved')

        if not use_curves:
            # Sharp 90-degree rectangular cutouts matching sharp template slots without showing colored corner borders
            base_img.paste(photo_cropped, (paste_x, paste_y), photo_cropped)
        else:
            # Smooth rounded corner alpha masks
            corner_radius = max(int(round(24 * scale_factor)), int(min(target_w, target_h) * 0.12))
            mask = Image.new('L', (target_w, target_h), 0)
            mask_draw = ImageDraw.Draw(mask)
            mask_draw.rounded_rectangle([0, 0, target_w, target_h], radius=corner_radius, fill=255)
            base_img.paste(photo_cropped, (paste_x, paste_y), mask)

    # Check if the overlay already has transparent cutouts (preserving decorative ribbons, frames, and sparkles!)
    has_transparent_slots = True
    for slot in scaled_slots:
        cx = slot['x'] + slot['w'] // 2
        cy = slot['y'] + slot['h'] // 2
        if 0 <= cx < overlay.width and 0 <= cy < overlay.height:
            if overlay.getpixel((cx, cy))[3] > 50:
                has_transparent_slots = False
                break

    # If the overlay is an opaque legacy sheet, clear out slot cutouts so photos can show through.
    # Otherwise, preserve all decorative overlapping frames, ribbons, and flourishes!
    if not has_transparent_slots:
        overlay_draw = ImageDraw.Draw(overlay)
        for slot in scaled_slots:
            if not use_curves:
                overlay_draw.rectangle([slot['x'], slot['y'], slot['x'] + slot['w'], slot['y'] + slot['h']], fill=(0, 0, 0, 0))
            else:
                c_rad = max(int(round(20 * scale_factor)), int(min(slot['w'], slot['h']) * 0.11))
                overlay_draw.rounded_rectangle([slot['x'], slot['y'], slot['x'] + slot['w'], slot['y'] + slot['h']], radius=c_rad, fill=(0, 0, 0, 0))

    # Composite top frame overlay on top of background + photos
    final_output = Image.alpha_composite(base_img, overlay)

    # Double Booth Picture Option (Stitch 2 strips side-by-side gaplessly onto 1 canvas)
    if layout_option == 'double':
        double_canvas = Image.new('RGBA', (width * 2, height), (0, 0, 0, 0))
        double_canvas.paste(final_output, (0, 0), final_output)
        double_canvas.paste(final_output, (width, 0), final_output)
        final_output = double_canvas

    # Save output file to SESSION_DIR and static/sessions/ (Lossless Maximum PNG Quality at 300 DPI!)
    output_filepath = os.path.join(SESSION_DIR, output_filename)
    final_output.save(output_filepath, 'PNG', optimize=False, dpi=(300, 300))
    
    static_session_dir = os.path.join(BASE_DIR, 'static', 'sessions')
    os.makedirs(static_session_dir, exist_ok=True)
    final_output.save(os.path.join(static_session_dir, output_filename), 'PNG', optimize=False, dpi=(300, 300))

    # ── RAW CLIPS & PICTURES FOLDER SAVING ────────────────────────────
    session_raw_dir, session_folder_name, safe_guest_name = get_session_raw_dir(queue_number, safe_guest_name, now)

    # 1. Save raw individual camera frames (unfiltered/uncropped full-quality)
    photos_to_save_raw = raw_photos_b64 if (raw_photos_b64 and len(raw_photos_b64) > 0) else photos_b64
    saved_raw_photo_names = []
    for r_idx, r_b64 in enumerate(photos_to_save_raw):
        try:
            if ',' in r_b64:
                r_clean = r_b64.split(',')[1]
            else:
                r_clean = r_b64
            r_bytes = base64.b64decode(r_clean)
            raw_img = Image.open(BytesIO(r_bytes)).convert('RGBA')

            # Save in dedicated session folder
            q_raw_name = f"Queue_{queue_number}_{safe_guest_name}_Photo_{r_idx + 1}_RAW.png"
            raw_img.save(os.path.join(session_raw_dir, q_raw_name), 'PNG', optimize=False)
            saved_raw_photo_names.append(q_raw_name)
        except Exception as r_err:
            print(f"Notice saving raw photo {r_idx + 1}:", r_err)

    # 2. Save final composited photobooth strip in dedicated session folder
    final_strip_in_raw = f"Queue_{queue_number}_{safe_guest_name}_Final_Strip.png"
    try:
        final_output.save(os.path.join(session_raw_dir, final_strip_in_raw), 'PNG', optimize=False, dpi=(300, 300))
    except Exception as s_err:
        print("Notice saving final strip to session directory:", s_err)

    # Save session to SQLite database with queue_number, paid_status, given_status
    session_id = database.save_session(
        template_id=t['id'],
        template_name=t['name'],
        output_path=output_filename,
        guest_name=safe_guest_name,
        code=code,
        queue_number=queue_number,
        paid_status=paid_status,
        given_status=given_status
    )

    # Asynchronous Google Apps Script Spreadsheet & Drive Sync
    def send_spreadsheet_log(date_fmt, name, q_num, photo_cnt, fname, paid_st, given_st, s_id, out_fp, sess_dir, sess_folder_nm, raw_filenames):
        import urllib.request, json, ssl, base64
        try:
            target_url = database.get_config('google_sheets_url', '').strip()
            if not target_url or not target_url.startswith('http') or 'docs.google.com/spreadsheets' in target_url:
                return

            # Read image bytes and encode to base64 for Google Drive upload
            img_b64 = ""
            if os.path.exists(out_fp):
                try:
                    with open(out_fp, 'rb') as f:
                        img_b64 = base64.b64encode(f.read()).decode('utf-8')
                except Exception as b64_err:
                    print("Error reading session photo for Drive upload:", b64_err)

            # Read RAW photos into base64 payload array
            raw_photos_payload = []
            for r_fn in raw_filenames:
                r_fp = os.path.join(sess_dir, r_fn)
                if os.path.exists(r_fp):
                    try:
                        with open(r_fp, 'rb') as rf:
                            raw_photos_payload.append({
                                'filename': r_fn,
                                'image_base64': base64.b64encode(rf.read()).decode('utf-8')
                            })
                    except Exception as r_read_err:
                        print(f"Notice reading {r_fn} for Drive payload:", r_read_err)

            drive_folder_id = "1RVezpDehiH95Be-shltRgJhUAZsuNcrk"
            raw_drive_url = database.get_config('google_drive_url', '').strip()
            if '/folders/' in raw_drive_url:
                parts = raw_drive_url.split('/folders/')[-1].split('?')[0].split('#')[0].strip('/')
                if parts:
                    drive_folder_id = parts

            payload = {
                'action': 'log_session',
                'date': date_fmt,
                'name': name,
                'queue_number': q_num,
                'queue_display': f"Queue #{q_num}",
                'code': f"Queue #{q_num}",
                'paid': paid_st,
                'given': given_st,
                'photos': photo_cnt,
                'filename': fname,
                'folder_id': drive_folder_id,
                'session_folder_name': sess_folder_nm,
                'image_base64': img_b64,
                'raw_photos': raw_photos_payload
            }

            data_bytes = json.dumps(payload).encode('utf-8')
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            req = urllib.request.Request(target_url, data=data_bytes, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
                resp_text = resp.read().decode('utf-8', errors='ignore')
                print("Google Spreadsheet & Drive Queue Log Response:", resp_text)
                try:
                    resp_data = json.loads(resp_text)
                    if resp_data.get('drive_url') and resp_data['drive_url'] != '-':
                        database.update_session_status(s_id, drive_url=resp_data['drive_url'])
                except Exception:
                    pass
        except Exception as err:
            print("Google Live Sync Notice:", err)

    import threading
    threading.Thread(
        target=send_spreadsheet_log,
        args=(
            date_str_formatted,
            safe_guest_name,
            queue_number,
            len(photos_b64),
            output_filename,
            paid_status,
            given_status,
            session_id,
            output_filepath,
            session_raw_dir,
            session_folder_name,
            saved_raw_photo_names
        )
    ).start()

    return jsonify({
        'success': True,
        'message': f"Photobooth ticket generated! Queue #{queue_number}",
        'session_id': session_id,
        'queue_number': queue_number,
        'queue_display': f"Queue #{queue_number}",
        'code': f"Queue #{queue_number}",
        'guest_name': safe_guest_name,
        'paid_status': paid_status,
        'given_status': given_status,
        'output_url': f"/sessions/{output_filename}",
        'filename': output_filename,
        'raw_folder': session_raw_dir,
        'session_folder_name': session_folder_name
    })

@app.route('/api/session/save-raw-video', methods=['POST'])
def save_raw_video():
    try:
        if 'video' not in request.files:
            return jsonify({'success': False, 'error': 'No video file provided'}), 400
        
        video_file = request.files['video']
        if not video_file.filename:
            return jsonify({'success': False, 'error': 'Empty video filename'}), 400

        queue_number_str = request.form.get('queue_number', '1').strip()
        guest_name = request.form.get('guest_name', 'Guest').strip() or 'Guest'
        session_folder_name_param = request.form.get('session_folder_name', '').strip()

        try:
            q_num_int = int(queue_number_str)
        except Exception:
            q_num_int = 1

        session_raw_dir, session_folder_name, safe_guest_name = find_or_create_session_raw_dir(
            q_num_int, guest_name, session_folder_name=session_folder_name_param
        )

        webm_filename = f"Queue_{q_num_int}_{safe_guest_name}_Live_Recording.webm"
        webm_path = os.path.join(session_raw_dir, webm_filename)

        video_file.save(webm_path)

        # Transcode/remux to universal MP4 with H.264 video + AAC audio using bin/ffmpeg.exe
        mp4_filename = f"Queue_{q_num_int}_{safe_guest_name}_Live_Recording.mp4"
        mp4_path = os.path.join(session_raw_dir, mp4_filename)

        final_video_path = webm_path

        if os.path.exists(FFMPEG_BIN):
            try:
                cmd = [
                    FFMPEG_BIN,
                    '-y',
                    '-i', webm_path,
                    '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p',
                    '-preset', 'veryfast',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-movflags', '+faststart',
                    mp4_path
                ]
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
                if os.path.exists(mp4_path) and os.path.getsize(mp4_path) > 0:
                    final_video_path = mp4_path
            except Exception as ffmpeg_err:
                print("FFmpeg transcoding notice:", ffmpeg_err)

        # Update database with video path
        try:
            database.update_session_video_by_queue(q_num_int, final_video_path)
        except Exception as db_err:
            print("DB update video notice:", db_err)

        # Asynchronously upload RAW video (preferred MP4) to the dedicated Google Drive session folder
        def upload_video_to_google_drive(v_path, sess_folder_name, q_num, g_name):
            try:
                target_url = database.get_config('google_sheets_url', '').strip()
                if not target_url or not target_url.startswith('http') or 'docs.google.com/spreadsheets' in target_url:
                    return

                # Always prefer the MP4 transcoded version if available
                target_v_path = v_path
                cand_mp4 = os.path.splitext(v_path)[0] + ".mp4"
                if os.path.exists(cand_mp4) and os.path.getsize(cand_mp4) > 0:
                    target_v_path = cand_mp4

                if not os.path.exists(target_v_path):
                    return

                if os.path.getsize(target_v_path) > 35 * 1024 * 1024:
                    print(f"Notice: Video for Queue #{q_num} is over 35MB, skipping Google Drive upload to avoid timeout.")
                    return

                with open(target_v_path, 'rb') as vf:
                    v_b64 = base64.b64encode(vf.read()).decode('utf-8')

                drive_folder_id = "1RVezpDehiH95Be-shltRgJhUAZsuNcrk"
                raw_drive_url = database.get_config('google_drive_url', '').strip()
                if '/folders/' in raw_drive_url:
                    parts = raw_drive_url.split('/folders/')[-1].split('?')[0].split('#')[0].strip('/')
                    if parts:
                        drive_folder_id = parts

                v_ext = os.path.splitext(target_v_path)[1].lower()
                mime = 'video/mp4' if v_ext == '.mp4' else 'video/webm'
                payload = {
                    'action': 'upload_session_file',
                    'folder_id': drive_folder_id,
                    'session_folder_name': sess_folder_name,
                    'filename': os.path.basename(target_v_path),
                    'file_base64': v_b64,
                    'mime_type': mime,
                    'queue_number': q_num,
                    'name': g_name
                }

                data_bytes = json.dumps(payload).encode('utf-8')
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                req = urllib.request.Request(target_url, data=data_bytes, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, context=ctx, timeout=120) as resp:
                    resp_text = resp.read().decode('utf-8', errors='ignore')
                    print(f"Google Drive Video Upload for Queue #{q_num} response:", resp_text)
            except Exception as v_up_err:
                print(f"Google Drive Video Upload for Queue #{q_num} notice:", v_up_err)

        import threading
        threading.Thread(target=upload_video_to_google_drive, args=(final_video_path, session_folder_name, q_num_int, safe_guest_name)).start()

        return jsonify({
            'success': True,
            'queue_number': q_num_int,
            'video_path': final_video_path,
            'folder': session_raw_dir,
            'session_folder_name': session_folder_name
        })
    except Exception as e:
        print("Error saving raw video:", e)
        return jsonify({'success': False, 'error': str(e)}), 500

def launch_windows_explorer(target_path):
    target = os.path.normpath(target_path)
    if not os.path.exists(target):
        os.makedirs(target, exist_ok=True)
    
    success = False
    
    # Method 1: Shell.Application COM object via PowerShell (talks directly to the active desktop Explorer shell)
    try:
        ps_cmd = f"(New-Object -ComObject Shell.Application).Open('{target}')"
        subprocess.Popen(['powershell', '-WindowStyle', 'Hidden', '-Command', ps_cmd], shell=False)
        success = True
    except Exception as e:
        print("[EXPLORER COM] PowerShell COM launch notice:", e)

    # Method 2: Direct explorer.exe execution (forces new top-level window)
    try:
        subprocess.Popen(['explorer.exe', target], shell=False)
        success = True
    except Exception as e:
        print("[EXPLORER EXE] Direct explorer.exe notice:", e)

    # Method 3: os.startfile fallback
    try:
        os.startfile(target)
        success = True
    except Exception:
        pass

    return success

@app.route('/api/open-raw-folder', methods=['POST'])
def open_raw_folder():
    target = os.path.normpath(RAW_CLIPS_DIR)
    data = request.json or {}
    q_num = data.get('queue_number')
    if q_num:
        try:
            q_clean = str(q_num).replace('#', '').strip()
            if os.path.exists(RAW_CLIPS_DIR):
                for item in sorted(os.listdir(RAW_CLIPS_DIR), reverse=True):
                    if (item.startswith(f"Queue #{q_clean} -") or item.startswith(f"Queue_{q_clean}_") or item.startswith(f"Queue #{q_clean}_")) and os.path.isdir(os.path.join(RAW_CLIPS_DIR, item)):
                        target = os.path.normpath(os.path.join(RAW_CLIPS_DIR, item))
                        break
        except Exception as e:
            print("Error finding queue folder:", e)
            
    if not os.path.exists(target):
        os.makedirs(target, exist_ok=True)

    print(f"[OPEN RAW FOLDER] Launching File Explorer for: {target}")
    opened = launch_windows_explorer(target)
    return jsonify({'success': opened, 'path': target})

@app.route('/api/raw-content/<path:subpath>')
def serve_raw_content(subpath):
    safe_path = os.path.normpath(os.path.join(RAW_CLIPS_DIR, subpath))
    if not safe_path.startswith(os.path.normpath(RAW_CLIPS_DIR)):
        return jsonify({'error': 'Access denied'}), 403
    dir_name = os.path.dirname(safe_path)
    file_name = os.path.basename(safe_path)
    return send_from_directory(dir_name, file_name)

@app.route('/api/raw-files/<int:q_num>', methods=['GET'])
def get_raw_files(q_num):
    folder_target = None
    folder_name = ""
    q_str = str(q_num)
    if os.path.exists(RAW_CLIPS_DIR):
        for item in sorted(os.listdir(RAW_CLIPS_DIR), reverse=True):
            if (item.startswith(f"Queue #{q_str} -") or item.startswith(f"Queue_{q_str}_") or item.startswith(f"Queue #{q_str}_")) and os.path.isdir(os.path.join(RAW_CLIPS_DIR, item)):
                folder_target = os.path.join(RAW_CLIPS_DIR, item)
                folder_name = item
                break
            
    files = []
    if folder_target and os.path.exists(folder_target):
        for f in sorted(os.listdir(folder_target)):
            fp = os.path.join(folder_target, f)
            if os.path.isfile(fp):
                ext = os.path.splitext(f)[1].lower()
                sz_bytes = os.path.getsize(fp)
                sz_str = f"{round(sz_bytes / (1024 * 1024), 1)} MB" if sz_bytes >= 1024 * 1024 else f"{round(sz_bytes / 1024)} KB"
                ftype = 'video' if ext in ['.mp4', '.webm', '.mov'] else ('image' if ext in ['.png', '.jpg', '.jpeg'] else 'file')
                files.append({
                    'name': f,
                    'type': ftype,
                    'size': sz_str,
                    'url': f"/api/raw-content/{folder_name}/{f}"
                })
    else:
        # Search root directory for matching files
        if os.path.exists(RAW_CLIPS_DIR):
            for f in sorted(os.listdir(RAW_CLIPS_DIR)):
                if f.startswith(f"Queue_{q_num}_") and os.path.isfile(os.path.join(RAW_CLIPS_DIR, f)):
                    fp = os.path.join(RAW_CLIPS_DIR, f)
                    ext = os.path.splitext(f)[1].lower()
                    sz_bytes = os.path.getsize(fp)
                    sz_str = f"{round(sz_bytes / (1024 * 1024), 1)} MB" if sz_bytes >= 1024 * 1024 else f"{round(sz_bytes / 1024)} KB"
                    ftype = 'video' if ext in ['.mp4', '.webm', '.mov'] else ('image' if ext in ['.png', '.jpg', '.jpeg'] else 'file')
                    files.append({
                        'name': f,
                        'type': ftype,
                        'size': sz_str,
                        'url': f"/api/raw-content/{f}"
                    })

    return jsonify({
        'success': True,
        'queue_number': q_num,
        'folder_path': folder_target or RAW_CLIPS_DIR,
        'files': files
    })

@app.route('/api/qrcode', methods=['GET'])
def generate_qr():
    url = request.args.get('data', '')
    if not url:
        return jsonify({'error': 'No data provided'}), 400
    try:
        import qrcode
        import io
        import base64
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=8,
            border=2
        )
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        buffered = io.BytesIO()
        img.save(buffered, format="PNG")
        img_str = base64.b64encode(buffered.getvalue()).decode('utf-8')
        return jsonify({'success': True, 'qr_data_url': f"data:image/png;base64,{img_str}"})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# --- CONFIGURATION & CLOUD APIS ---

@app.route('/api/config', methods=['GET'])
def get_system_config():
    sheets_url = database.get_config('google_sheets_url', '')
    drive_url = database.get_config('google_drive_url', '')
    next_queue = database.get_next_queue_number()

    try:
        vol_voice = float(database.get_config('volume_voice', '2.0'))
    except (ValueError, TypeError):
        vol_voice = 2.0

    try:
        vol_music = float(database.get_config('volume_music', '0'))
    except (ValueError, TypeError):
        vol_music = 0.0

    try:
        vol_sfx = float(database.get_config('volume_sfx', '2.0'))
    except (ValueError, TypeError):
        vol_sfx = 2.0

    sel_template = database.get_config('selected_template_id', '')
    try:
        selected_template_id = int(sel_template) if sel_template else None
    except (ValueError, TypeError):
        selected_template_id = None

    return jsonify({
        'success': True,
        'google_sheets_url': sheets_url,
        'google_drive_url': drive_url,
        'drive_qr_url': '/static/img/drive_qr.png',
        'next_queue_number': next_queue,
        'queue_display': f"Queue #{next_queue}",
        'volume_voice': vol_voice,
        'volume_music': vol_music,
        'volume_sfx': vol_sfx,
        'selected_template_id': selected_template_id,
        'raw_clips_dir': RAW_CLIPS_DIR
    })

@app.route('/api/config', methods=['POST'])
def save_system_config():
    data = request.json or {}
    if 'google_sheets_url' in data:
        database.set_config('google_sheets_url', data['google_sheets_url'].strip())
    if 'google_drive_url' in data:
        database.set_config('google_drive_url', data['google_drive_url'].strip())
    if 'selected_template_id' in data:
        try:
            database.set_config('selected_template_id', str(int(data['selected_template_id'])))
        except (ValueError, TypeError):
            pass
    if 'volume_voice' in data:
        try:
            database.set_config('volume_voice', str(float(data['volume_voice'])))
        except (ValueError, TypeError):
            pass
    if 'volume_music' in data:
        try:
            database.set_config('volume_music', str(float(data['volume_music'])))
        except (ValueError, TypeError):
            pass
    if 'volume_sfx' in data:
        try:
            database.set_config('volume_sfx', str(float(data['volume_sfx'])))
        except (ValueError, TypeError):
            pass
        
    return jsonify({
        'success': True,
        'message': 'System and audio volume settings saved successfully!'
    })

@app.route('/api/queue/status', methods=['GET'])
def get_queue_status():
    next_num = database.get_next_queue_number()
    return jsonify({
        'success': True,
        'next_queue_number': next_num,
        'queue_display': f"Queue #{next_num}"
    })

@app.route('/api/queue/reset', methods=['POST'])
def reset_queue_endpoint():
    data = request.json or {}
    start_number = data.get('start_number', 1)
    try:
        start_number = max(1, int(start_number))
    except (ValueError, TypeError):
        start_number = 1

    actual_num = database.reset_queue(start_number)

    sheets_url = database.get_config('google_sheets_url', '').strip()
    drive_url = database.get_config('google_drive_url', '').strip()

    sheets_synced = False
    sheets_message = "Skipped (no Google Sheets URL configured)"

    if sheets_url and sheets_url.startswith('http'):
        if 'script.google.com' in sheets_url:
            try:
                import urllib.request, json, ssl
                now = datetime.datetime.now()
                date_str = now.strftime('%d/%m/%Y %H:%M:%S')
                payload = {
                    'action': 'RESET_QUEUE',
                    'event': 'RESET_QUEUE',
                    'new_queue_number': actual_num,
                    'queue_display': f"Queue #{actual_num}",
                    'date': date_str,
                    'name': 'SYSTEM_RESET',
                    'message': f"Photobooth queue reset to #{actual_num}",
                    'paid': 'SYSTEM'
                }
                data_bytes = json.dumps(payload).encode('utf-8')
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                req = urllib.request.Request(sheets_url, data=data_bytes, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, context=ctx, timeout=4) as resp:
                    resp_text = resp.read().decode('utf-8', errors='ignore')
                    sheets_synced = True
                    sheets_message = f"Google Sheets webhook notified"
            except Exception as e:
                sheets_message = f"Google Sheets webhook notice: {str(e)[:60]}"
        elif 'docs.google.com/spreadsheets' in sheets_url:
            sheets_synced = True
            sheets_message = f"Google Spreadsheet linked; upcoming Queue #{actual_num} tickets will sync to sheet"
        else:
            sheets_synced = True
            sheets_message = "Google Sheets endpoint linked"

    drive_synced = False
    drive_message = "Skipped (no Google Drive URL configured)"
    if drive_url and drive_url.startswith('http'):
        if 'script.google.com' in drive_url:
            try:
                import urllib.request, json, ssl
                payload = {
                    'action': 'RESET_QUEUE',
                    'new_queue_number': actual_num,
                    'message': f"Photobooth queue reset to #{actual_num}"
                }
                data_bytes = json.dumps(payload).encode('utf-8')
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                req = urllib.request.Request(drive_url, data=data_bytes, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(req, context=ctx, timeout=4) as resp:
                    drive_synced = True
                    drive_message = "Google Drive webhook notified"
            except Exception as e:
                drive_message = f"Google Drive webhook notice: {str(e)[:60]}"
        else:
            drive_synced = True
            drive_message = f"Google Drive folder linked; QR Code ready for Queue #{actual_num}"

    return jsonify({
        'success': True,
        'next_queue_number': actual_num,
        'queue_display': f"Queue #{actual_num}",
        'message': f"Queue successfully reset to #{actual_num}!",
        'cloud_status': {
            'sheets_synced': sheets_synced,
            'sheets_message': sheets_message,
            'drive_synced': drive_synced,
            'drive_message': drive_message
        }
    })

# --- GALLERY APIS ---

@app.route('/api/gallery', methods=['GET'])
def get_gallery():
    sessions = database.get_all_sessions()
    for s in sessions:
        s['output_url'] = f"/sessions/{s['output_path']}"
    return jsonify({'success': True, 'sessions': sessions})

@app.route('/api/gallery/<int:session_id>', methods=['DELETE'])
def delete_gallery_session(session_id):
    s = database.delete_session(session_id)
    if s:
        # Remove file
        file_path = os.path.join(SESSION_DIR, s['output_path'])
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass
        return jsonify({'success': True, 'message': 'Session deleted.'})
    return jsonify({'success': False, 'error': 'Session not found'}), 404

@app.route('/api/session/<int:session_id>/status', methods=['POST'])
def update_session_status_api(session_id):
    data = request.json or {}
    paid = data.get('paid')
    given = data.get('given')

    updated = database.update_session_status(session_id, paid_status=paid, given_status=given)
    if not updated:
        return jsonify({'success': False, 'error': 'Session not found'}), 404

    # Asynchronously notify Google Sheets Web App of the status update
    def send_status_update(q_num, paid_val, given_val):
        target_url = database.get_config('google_sheets_url', '').strip()
        if not target_url or not target_url.startswith('http') or 'script.google.com' not in target_url:
            return
        try:
            import urllib.request, json, ssl
            payload = {
                'action': 'update_status',
                'queue_number': q_num,
                'paid': paid_val,
                'given': given_val
            }
            data_bytes = json.dumps(payload).encode('utf-8')
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            req = urllib.request.Request(target_url, data=data_bytes, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
                pass
        except Exception as err:
            print("Status update notice:", err)

    import threading
    threading.Thread(target=send_status_update, args=(updated['queue_number'], updated.get('paid_status'), updated.get('given_status'))).start()

    return jsonify({
        'success': True,
        'session': updated,
        'message': f"Queue #{updated['queue_number']} status updated (Paid: {updated.get('paid_status')}, Given: {updated.get('given_status')})"
    })

@app.route('/api/cloud/sync-from-sheets', methods=['GET', 'POST'])
def sync_from_sheets():
    target_url = database.get_config('google_sheets_url', '').strip()
    if not target_url or not target_url.startswith('http') or 'script.google.com' not in target_url:
        return jsonify({
            'success': False,
            'error': 'Google Sheets Web App URL not configured or invalid. Please check Settings.'
        }), 400

    try:
        import urllib.request, json, ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

        sync_url = target_url
        separator = '&' if '?' in target_url else '?'
        sync_url += f"{separator}action=get_all_statuses"

        req = urllib.request.Request(sync_url, headers={'User-Agent': 'PSSC-PhotoBooth/3.0'})
        with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
            body = resp.read().decode('utf-8', errors='ignore')

        data = json.loads(body)
        rows = data.get('rows', [])
        updated_count = 0

        for r in rows:
            q_num = r.get('queue_number')
            if q_num is not None:
                res = database.update_session_status_by_queue(
                    q_num,
                    paid_status=r.get('paid'),
                    given_status=r.get('given'),
                    drive_url=r.get('drive_url')
                )
                if res:
                    updated_count += 1

        return jsonify({
            'success': True,
            'message': f"Synchronized {updated_count} session(s) from Google Sheets.",
            'total_rows': len(rows),
            'updated_count': updated_count
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': f"Failed to sync with Google Sheets: {str(e)}"
        }), 500

@app.route('/api/cloud/test-sync', methods=['POST'])
def test_cloud_sync():
    data = request.json or {}
    sheets_url = (data.get('sheets_url') or database.get_config('google_sheets_url', '')).strip()
    drive_url = (data.get('drive_url') or database.get_config('google_drive_url', '')).strip()
    
    if not sheets_url:
        return jsonify({'success': False, 'error': 'No Google Sheets URL provided.'}), 400
        
    if 'docs.google.com/spreadsheets' in sheets_url:
        return jsonify({
            'success': False,
            'is_sheet_viewer': True,
            'error': 'You entered the Google Sheets spreadsheet viewer URL. To enable live row tracking and Google Drive photo uploads, deploy the Google Apps Script Web App (script.google.com) as detailed in the Setup Guide.'
        }), 400

    if 'script.google.com' not in sheets_url:
        return jsonify({
            'success': False,
            'error': 'Invalid URL. Google Sheets sync requires a Google Apps Script Web App URL ending with /exec (https://script.google.com/macros/s/.../exec).'
        }), 400

    try:
        import urllib.request, json, ssl, datetime
        now = datetime.datetime.now()
        date_fmt = now.strftime('%d/%m/%Y %H:%M:%S')
        next_q = database.get_next_queue_number()

        drive_folder_id = "1RVezpDehiH95Be-shltRgJhUAZsuNcrk"
        if '/folders/' in drive_url:
            parts = drive_url.split('/folders/')[-1].split('?')[0].split('#')[0].strip('/')
            if parts:
                drive_folder_id = parts

        # 1x1 transparent PNG to test real Google Drive upload & permission
        test_pixel_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

        payload = {
            'action': 'test_drive_permission',
            'date': date_fmt,
            'name': 'Test Auth Verification',
            'queue_number': next_q,
            'paid': 'Paid',
            'given': 'Not Given',
            'photos': 1,
            'filename': 'PSSC_Drive_Auth_Test.png',
            'folder_id': drive_folder_id,
            'image_base64': test_pixel_b64
        }

        data_bytes = json.dumps(payload).encode('utf-8')
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(sheets_url, data=data_bytes, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
            resp_body = resp.read().decode('utf-8', errors='ignore')
            try:
                resp_json = json.loads(resp_body)
                drive_res = str(resp_json.get('drive_url', ''))
                
                # Check for Drive authorization error
                if 'Drive Error' in drive_res or 'Tinanggihang' in drive_res or 'Access denied' in drive_res:
                    return jsonify({
                        'success': False,
                        'needs_drive_auth': True,
                        'drive_error': drive_res,
                        'error': f"⚠️ Google Sheets connected, but Google Drive access is DENIED ({drive_res}). In Apps Script, select 'authorizeAndTestDrive', click Run (Patakbuhin) to grant Drive permission, then Deploy a New version."
                    }), 400
                
                return jsonify({
                    'success': True,
                    'message': f"Google Sheets & Google Drive are 100% CONNECTED and AUTHORIZED! Live test upload succeeded.",
                    'details': resp_json,
                    'drive_url': drive_res
                })
            except Exception:
                return jsonify({
                    'success': True,
                    'message': f"Webhook responded successfully (HTTP {resp.status})",
                    'raw': resp_body[:200]
                })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': f"Failed to connect to Google Web App: {str(e)}. Make sure your Apps Script deployment is set to 'Execute as: Me' and 'Who has access: Anyone'."
        }), 500

is_repair_running = False
cancel_repair_flag = False

@app.route('/api/cloud/stop-drive-upload', methods=['POST'])
def stop_drive_upload():
    global cancel_repair_flag, is_repair_running
    cancel_repair_flag = True
    is_repair_running = False
    return jsonify({'success': True, 'message': 'Google Drive background upload stopped.'})

@app.route('/api/cloud/repair-drive-uploads', methods=['POST'])
def repair_drive_uploads():
    global cancel_repair_flag, is_repair_running
    cancel_repair_flag = False
    is_repair_running = True

    target_url = database.get_config('google_sheets_url', '').strip()
    if not target_url or not target_url.startswith('http') or 'script.google.com' not in target_url:
        is_repair_running = False
        return jsonify({'success': False, 'error': 'Google Sheets Web App URL is not configured.'}), 400

    drive_folder_id = "1RVezpDehiH95Be-shltRgJhUAZsuNcrk"
    raw_drive_url = database.get_config('google_drive_url', '').strip()
    if '/folders/' in raw_drive_url:
        parts = raw_drive_url.split('/folders/')[-1].split('?')[0].split('#')[0].strip('/')
        if parts:
            drive_folder_id = parts

    # Query ONLY recent sessions that encountered Drive Error (never old historical sessions)
    with database.get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT id, queue_number, guest_name, output_path, drive_url 
            FROM sessions 
            WHERE (drive_url LIKE '%Drive Error%' OR drive_url LIKE '%Tinanggihang%')
            ORDER BY id DESC
            LIMIT 10
        """)
        broken_sessions = [dict(r) for r in cursor.fetchall()]

    if not broken_sessions:
        is_repair_running = False
        return jsonify({'success': True, 'message': 'All saved sessions already have valid Google Drive links!', 'repaired': 0})

    repaired = 0
    errors = []
    import urllib.request, ssl, base64

    for s in broken_sessions:
        if cancel_repair_flag:
            print("Notice: Drive repair upload cancelled by operator.")
            break
        s_id = s['id']
        q_num = s.get('queue_number') or s_id
        fname = s.get('output_path') or f"PSSC_Q{q_num}.png"
        
        # Look for photo on disk in SESSION_DIR or static/sessions
        photo_path = os.path.join(SESSION_DIR, fname)
        if not os.path.exists(photo_path):
            photo_path = os.path.join(BASE_DIR, 'static', 'sessions', fname)
        if not os.path.exists(photo_path):
            continue

        try:
            with open(photo_path, 'rb') as f:
                img_b64 = base64.b64encode(f.read()).decode('utf-8')

            sess_raw_dir, sess_folder_nm, s_guest = find_or_create_session_raw_dir(q_num, s.get('guest_name'))

            payload = {
                'action': 'reupload_photo',
                'queue_number': q_num,
                'name': s_guest,
                'filename': fname,
                'folder_id': drive_folder_id,
                'session_folder_name': sess_folder_nm,
                'image_base64': img_b64
            }

            data_bytes = json.dumps(payload).encode('utf-8')
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            req = urllib.request.Request(target_url, data=data_bytes, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                resp_text = resp.read().decode('utf-8', errors='ignore')
                res_json = json.loads(resp_text)
                drive_res = res_json.get('drive_url', '')
                if drive_res and not drive_res.startswith('Drive Error') and not 'Tinanggihang' in drive_res and drive_res != '-':
                    database.update_session_status(s_id, drive_url=drive_res)
                    repaired += 1
                elif 'Drive Error' in drive_res or 'Tinanggihang' in drive_res:
                    errors.append(f"Q#{q_num}: {drive_res}")
                    break  # Stop early if permissions are denied
        except Exception as e:
            errors.append(f"Q#{q_num}: {str(e)}")

    if repaired > 0:
        return jsonify({
            'success': True,
            'repaired': repaired,
            'total_found': len(broken_sessions),
            'message': f"Successfully uploaded {repaired} photo(s) to Google Drive and synced to Google Sheets!"
        })
    else:
        err_msg = errors[0] if errors else "No photos could be uploaded."
        return jsonify({
            'success': False,
            'repaired': 0,
            'errors': errors,
            'error': f"Failed to upload to Drive: {err_msg}. Please verify DriveApp permission is granted in Apps Script first."
        }), 400

MUSIC_LIBRARY_DIR = os.path.join(AUDIO_DIR, 'music_library')
os.makedirs(MUSIC_LIBRARY_DIR, exist_ok=True)
database.clean_corrupted_tracks(MUSIC_LIBRARY_DIR)

def clean_orphaned_audio_temp(audio_dir):
    try:
        now = time.time()
        for f in os.listdir(audio_dir):
            if f.startswith('temp_'):
                fp = os.path.join(audio_dir, f)
                try:
                    if os.path.isfile(fp) and (now - os.path.getmtime(fp) > 3):
                        os.remove(fp)
                except Exception:
                    pass
    except Exception:
        pass

clean_orphaned_audio_temp(AUDIO_DIR)

def safe_remove_file(filepath, retries=8, delay=0.25):
    for _ in range(retries):
        try:
            if os.path.exists(filepath):
                os.remove(filepath)
            return
        except Exception:
            time.sleep(delay)
    clean_orphaned_audio_temp(AUDIO_DIR)

def find_ffmpeg_dir():
    """
    Ensures a valid bin directory exists with ffmpeg.exe for yt-dlp post-processing.
    """
    tools_dir = os.path.join(BASE_DIR, 'bin')
    os.makedirs(tools_dir, exist_ok=True)
    ffmpeg_target = os.path.join(tools_dir, 'ffmpeg.exe')

    if not os.path.exists(ffmpeg_target):
        try:
            import imageio_ffmpeg
            src = imageio_ffmpeg.get_ffmpeg_exe()
            shutil.copy2(src, ffmpeg_target)
        except Exception:
            pass

    if os.path.exists(ffmpeg_target):
        return tools_dir
    
    sys_ffmpeg = shutil.which('ffmpeg')
    if sys_ffmpeg:
        return os.path.dirname(sys_ffmpeg)
    return None

def download_spotify_audio(url_or_query, target_mp3_path, playlist_name=None, set_active=True):
    """
    Downloads audio for Spotify URL or track name in high quality MP3 format.
    """
    import sys, subprocess, urllib.parse, urllib.request, shutil, ssl
    ffmpeg_dir = find_ffmpeg_dir()

    track_title = "Spotify Track"
    
    # Try fetching title via Spotify oEmbed if Spotify URL
    if "spotify.com" in url_or_query:
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            oembed_api = f"https://open.spotify.com/oembed?url={urllib.parse.quote(url_or_query)}"
            req = urllib.request.Request(oembed_api, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, context=ctx, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                if 'title' in data:
                    track_title = data['title'].strip()
        except Exception as e:
            print("Spotify oEmbed notice:", e)
    else:
        track_title = url_or_query

    # Fallback title extraction via yt-dlp metadata
    if track_title == "Spotify Track" or "http" not in url_or_query:
        try:
            search_target = f"ytsearch1:{url_or_query}" if "http" not in url_or_query else url_or_query
            title_cmd = [sys.executable, "-m", "yt_dlp", "--print", "%(title)s", "--no-warnings", "--no-check-certificates", search_target]
            res_t = subprocess.run(title_cmd, capture_output=True, text=True, timeout=15)
            if res_t.returncode == 0 and res_t.stdout.strip():
                extracted_title = res_t.stdout.strip().splitlines()[0]
                if extracted_title and not extracted_title.startswith('[') and not extracted_title.startswith('ERROR'):
                    track_title = extracted_title
        except Exception as e:
            print("Title extraction notice:", e)

    os.makedirs(MUSIC_LIBRARY_DIR, exist_ok=True)
    temp_id = uuid.uuid4().hex[:8]
    temp_target = os.path.join(AUDIO_DIR, f"temp_{temp_id}.mp3")

    success = False

    # Attempt 1: Try spotdl
    try:
        cmd_spotdl = [
            sys.executable, "-m", "spotdl",
            "download", url_or_query,
            "--output", temp_target,
            "--format", "mp3",
            "--overwrite", "force"
        ]
        if ffmpeg_dir:
            cmd_spotdl.extend(["--ffmpeg-location", ffmpeg_dir])
        res = subprocess.run(cmd_spotdl, capture_output=True, text=True, timeout=90)
        if os.path.exists(temp_target) and os.path.getsize(temp_target) > 10000:
            success = True
    except Exception as e:
        print("spotdl attempt notice:", e)

    if success and os.path.exists(temp_target):
        lib_filename = f"track_{uuid.uuid4().hex[:8]}.mp3"
        lib_path = os.path.join(MUSIC_LIBRARY_DIR, lib_filename)
        shutil.copy2(temp_target, lib_path)
        
        database.add_music_track(track_title, lib_filename, url_or_query, source="spotify", playlist_name=playlist_name, set_active=set_active)

        if set_active:
            shutil.copy2(temp_target, target_mp3_path)
            static_audio_dir = os.path.join(BASE_DIR, 'static', 'audio')
            os.makedirs(static_audio_dir, exist_ok=True)
            shutil.copy2(temp_target, os.path.join(static_audio_dir, 'music.mp3'))

        safe_remove_file(temp_target)
        return True, track_title

    safe_remove_file(temp_target)
    return False, track_title

# --- GLOBAL PLAYLIST IMPORT STATUS ENGINE ---
global_import_status = {
    'in_progress': False,
    'source': 'youtube',
    'playlist_name': '',
    'current_track': '',
    'current_index': 0,
    'total_tracks': 0,
    'percentage': 0,
    'completed': False,
    'completed_tracks': [],
    'error': None
}

def extract_playlist_info(url, source='youtube'):
    entries = []
    playlist_title = "Imported Playlist"

    if source == 'youtube' or "youtube.com" in url or "youtu.be" in url:
        try:
            cmd = [
                sys.executable, "-m", "yt_dlp",
                "--dump-single-json", "--flat-playlist",
                "--no-warnings", "--no-check-certificates",
                url
            ]
            if shutil.which('node'):
                cmd.extend(["--js-runtimes", "node"])
            res = subprocess.run(cmd, capture_output=True, encoding='utf-8', errors='replace', timeout=60)
            if res.returncode == 0 and res.stdout.strip():
                data = json.loads(res.stdout)
                playlist_title = data.get('title', 'YouTube Playlist')
                raw_entries = data.get('entries', [])
                for item in raw_entries:
                    if item:
                        e_title = item.get('title', 'YouTube Track')
                        e_id = item.get('id')
                        e_url = f"https://www.youtube.com/watch?v={e_id}" if e_id else item.get('url', url)
                        entries.append({'title': e_title, 'url': e_url})
            else:
                if res.stderr:
                    print("yt-dlp playlist extraction notice:", res.stderr.strip()[:300])
        except Exception as e:
            print("Playlist JSON extraction notice:", e)

    return playlist_title, entries

def run_playlist_download_thread(url, source='youtube'):
    global global_import_status
    playlist_title, entries = extract_playlist_info(url, source=source)
    
    if not entries:
        global_import_status['in_progress'] = False
        global_import_status['completed'] = False
        global_import_status['error'] = "No tracks found in playlist link."
        return

    # Cap playlist at 60 tracks to maintain smooth performance
    if len(entries) > 60:
        entries = entries[:60]

    total = len(entries)
    global_import_status['in_progress'] = True
    global_import_status['source'] = source
    global_import_status['playlist_name'] = playlist_title
    global_import_status['total_tracks'] = total
    global_import_status['current_index'] = 0
    global_import_status['percentage'] = 0
    global_import_status['completed'] = False
    global_import_status['completed_tracks'] = []
    global_import_status['error'] = None

    print(f"\n\033[95m[PLAYLIST IMPORT STARTED]\033[0m Playlist: '{playlist_title}' ({total} tracks)")

    target_path = os.path.join(AUDIO_DIR, 'music.mp3')
    
    for idx, item in enumerate(entries, 1):
        t_url = item['url']
        t_title = item['title']

        global_import_status['current_index'] = idx
        global_import_status['current_track'] = t_title
        global_import_status['percentage'] = int(((idx - 1) / total) * 100)

        print(f"\033[96m[PLAYLIST IMPORT]\033[0m ({idx}/{total}) Downloading: '{t_title}'...")

        try:
            ok, final_title, _ = download_youtube_audio(t_url, target_path, playlist_name=playlist_title, set_active=(idx == 1))
            if ok:
                used_title = final_title if final_title and final_title != "YouTube Track" else t_title
                global_import_status['completed_tracks'].append(used_title)
                print(f"\033[92m[PLAYLIST IMPORT]\033[0m ({idx}/{total}) Completed: '{used_title}' [OK]")
            else:
                print(f"\033[93m[PLAYLIST IMPORT NOTICE]\033[0m ({idx}/{total}) Skipped unavailable track: {t_title}")
        except Exception as e:
            print(f"\033[91m[PLAYLIST IMPORT NOTICE]\033[0m ({idx}/{total}) Failed downloading track: {t_title}", e)

        global_import_status['percentage'] = int((idx / total) * 100)

    global_import_status['in_progress'] = False
    global_import_status['completed'] = True

def download_youtube_audio(url_or_query, target_mp3_path, playlist_name=None, set_active=True):
    os.makedirs(MUSIC_LIBRARY_DIR, exist_ok=True)
    temp_id = uuid.uuid4().hex[:8]
    temp_target = os.path.join(AUDIO_DIR, f"temp_yt_{temp_id}.mp3")
    ffmpeg_dir = find_ffmpeg_dir()
    node_bin = shutil.which('node')
    
    raw_url = url_or_query.strip()
    clean_url = raw_url

    if "watch?v=" in raw_url:
        vid_id = raw_url.split("watch?v=")[1].split("&")[0]
        clean_url = f"https://www.youtube.com/watch?v={vid_id}"
    elif "youtu.be/" in raw_url:
        vid_id = raw_url.split("youtu.be/")[1].split("?")[0].split("&")[0]
        clean_url = f"https://www.youtube.com/watch?v={vid_id}"
    elif "music.youtube.com/watch?v=" in raw_url:
        vid_id = raw_url.split("watch?v=")[1].split("&")[0]
        clean_url = f"https://www.youtube.com/watch?v={vid_id}"

    track_title = "YouTube Track"
    search_target = clean_url if ("youtube.com" in clean_url.lower() or "youtu.be" in clean_url.lower()) else f"ytsearch1:{clean_url}"

    try:
        title_cmd = [
            sys.executable, "-m", "yt_dlp",
            "--print", "%(title)s",
            "--no-warnings",
            "--no-check-certificates",
            "--no-playlist",
            search_target
        ]
        if node_bin:
            title_cmd.extend(["--js-runtimes", "node"])
        res_t = subprocess.run(title_cmd, capture_output=True, encoding='utf-8', errors='replace', timeout=15)
        if res_t.returncode == 0 and res_t.stdout.strip():
            extracted_title = res_t.stdout.strip().splitlines()[0]
            if extracted_title and not extracted_title.startswith('[') and not extracted_title.startswith('ERROR'):
                track_title = extracted_title
    except Exception as e:
        print("YouTube title extraction notice:", e)

    success = False
    error_msg = None

    try:
        cmd_ytdlp = [
            sys.executable, "-m", "yt_dlp",
            search_target,
            "-x", "--audio-format", "mp3",
            "--audio-quality", "0",
            "--no-check-certificates",
            "--no-playlist",
            "-o", temp_target,
            "--force-overwrites"
        ]
        if node_bin:
            cmd_ytdlp.extend(["--js-runtimes", "node"])
        if ffmpeg_dir:
            cmd_ytdlp.extend(["--ffmpeg-location", ffmpeg_dir])

        res_yt = subprocess.run(cmd_ytdlp, capture_output=True, encoding='utf-8', errors='replace', timeout=120)

        # Verify output file
        produced_file = None
        if os.path.exists(temp_target) and os.path.getsize(temp_target) > 1000:
            produced_file = temp_target
        else:
            for fn in os.listdir(AUDIO_DIR):
                if temp_id in fn and fn != f"temp_yt_{temp_id}.mp3":
                    candidate = os.path.join(AUDIO_DIR, fn)
                    if os.path.isfile(candidate) and os.path.getsize(candidate) > 1000:
                        produced_file = candidate
                        break

        if produced_file:
            success = True
            temp_target = produced_file
        else:
            if res_yt.returncode != 0:
                err_text = res_yt.stderr.strip() or res_yt.stdout.strip()
                error_msg = err_text.splitlines()[-1] if err_text else "Download failed."
                print("yt-dlp download notice:", err_text)
    except Exception as e:
        error_msg = str(e)
        print("YouTube download notice:", e)

    if success and os.path.exists(temp_target):
        lib_filename = f"yt_{uuid.uuid4().hex[:8]}.mp3"
        lib_path = os.path.join(MUSIC_LIBRARY_DIR, lib_filename)
        shutil.copy2(temp_target, lib_path)
        
        database.add_music_track(track_title, lib_filename, raw_url, source="youtube", playlist_name=playlist_name, set_active=set_active)

        if set_active:
            shutil.copy2(temp_target, target_mp3_path)
            static_audio_dir = os.path.join(BASE_DIR, 'static', 'audio')
            os.makedirs(static_audio_dir, exist_ok=True)
            shutil.copy2(temp_target, os.path.join(static_audio_dir, 'music.mp3'))

        safe_remove_file(temp_target)
        return True, track_title, None

    safe_remove_file(temp_target)
    return False, track_title, error_msg

# --- USER ACTION LOGGING & CLEAN TERMINAL LOGS ---
import logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

@app.after_request
def log_requests(response):
    if request.path.startswith('/api/') or request.path.startswith('/previews/'):
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate, max-age=0'
        response.headers['Pragma'] = 'no-cache'
        response.headers['Expires'] = '0'
        if request.path not in ('/api/heartbeat', '/api/import-progress', '/api/log-action'):
            now_str = time.strftime('%H:%M:%S')
            print(f"[{now_str}] [API CALL] {request.method} {request.path} » Status {response.status_code}", flush=True)
            sys.stdout.flush()
    return response

@app.route('/api/log-action', methods=['GET', 'POST'])
def log_user_action():
    data = request.json or {}
    action = data.get('action', 'User Move')
    details = data.get('details', '')
    now_str = time.strftime('%H:%M:%S')
    detail_str = f" » {details}" if details else ""
    print(f"[{now_str}] [LIVE MOVE] {action}{detail_str}", flush=True)
    sys.stdout.flush()
    return jsonify({'success': True})

@app.route('/api/heartbeat', methods=['GET', 'POST'])
def heartbeat():
    return jsonify({'status': 'alive'})

@app.route('/api/import-progress', methods=['GET'])
def get_import_progress():
    return jsonify(global_import_status)

@app.route('/api/youtube-import', methods=['POST'])
def import_youtube_music():
    try:
        data = request.json or {}
        url = data.get('url', '').strip()
        if not url:
            return jsonify({'success': False, 'error': 'YouTube URL or song name is required.'}), 400

        lower_url = url.lower()
        is_playlist = (
            "/playlist" in lower_url
            or "playlist?list=" in lower_url
            or ("list=" in lower_url and "watch?v=" not in lower_url and "youtu.be/" not in lower_url)
        )

        if is_playlist:
            import threading
            threading.Thread(target=run_playlist_download_thread, args=(url, 'youtube'), daemon=True).start()
            return jsonify({
                'success': True,
                'is_playlist': True,
                'message': 'Started importing YouTube playlist tracks in real-time!'
            })
        else:
            target_path = os.path.join(AUDIO_DIR, 'music.mp3')
            ok, title, err = download_youtube_audio(url, target_path)

            if ok:
                return jsonify({
                    'success': True,
                    'is_playlist': False,
                    'message': f"Successfully imported '{title}' from YouTube!",
                    'track_title': title,
                    'music_url': '/audio/music.mp3',
                    'tracks': database.get_all_music_tracks()
                })
            else:
                err_clean = err if err else "Failed to download YouTube audio track. Please check the URL or connection."
                if "HTTP Error 403" in err_clean:
                    err_clean = "YouTube temporarily blocked stream (HTTP 403). Please retry or verify URL."
                return jsonify({
                    'success': False,
                    'error': err_clean
                }), 400
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/spotify-import', methods=['GET', 'POST'])
def import_spotify_music():
    if request.method == 'GET':
        return jsonify({'success': True, 'message': 'Spotify Importer Endpoint Ready'})
    
    try:
        data = request.json or {}
        url = data.get('url', '').strip()
        if not url:
            return jsonify({'success': False, 'error': 'Spotify URL or track name is required.'}), 400

        is_playlist = ("/playlist/" in url.lower())
        if is_playlist:
            import threading
            threading.Thread(target=run_playlist_download_thread, args=(url, 'spotify'), daemon=True).start()
            return jsonify({
                'success': True,
                'is_playlist': True,
                'message': 'Started importing Spotify playlist tracks in real-time!'
            })
        else:
            target_path = os.path.join(AUDIO_DIR, 'music.mp3')
            ok, title = download_spotify_audio(url, target_path)

            if ok:
                return jsonify({
                    'success': True,
                    'is_playlist': False,
                    'message': f"Successfully imported '{title}' as background music!",
                    'track_title': title,
                    'music_url': '/audio/music.mp3',
                    'tracks': database.get_all_music_tracks()
                })
            else:
                return jsonify({
                    'success': False,
                    'error': "Failed to download Spotify audio track. Please check the URL or network connection."
                }), 400
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/music/upload', methods=['POST'])
def upload_custom_music():
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'error': 'No audio file provided'}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'success': False, 'error': 'No file selected'}), 400

        title = os.path.splitext(file.filename)[0].replace('_', ' ').replace('-', ' ').title()
        ext = os.path.splitext(file.filename)[1].lower()
        if ext not in ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']:
            return jsonify({'success': False, 'error': 'Unsupported audio format. Use MP3, M4A, WAV, or OGG.'}), 400

        lib_filename = f"custom_{uuid.uuid4().hex[:8]}.mp3"
        lib_path = os.path.join(MUSIC_LIBRARY_DIR, lib_filename)
        
        file.save(lib_path)

        database.add_music_track(title, lib_filename, source_url="Local Upload", source="custom", set_active=True)

        target_path = os.path.join(AUDIO_DIR, 'music.mp3')
        shutil.copy2(lib_path, target_path)
        static_audio_dir = os.path.join(BASE_DIR, 'static', 'audio')
        os.makedirs(static_audio_dir, exist_ok=True)
        shutil.copy2(lib_path, os.path.join(static_audio_dir, 'music.mp3'))

        return jsonify({
            'success': True,
            'message': f"Successfully uploaded '{title}' to Music Library!",
            'track_title': title,
            'tracks': database.get_all_music_tracks()
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/music/library', methods=['GET'])
def get_music_library():
    tracks = database.get_all_music_tracks()
    return jsonify({'success': True, 'tracks': tracks})

@app.route('/api/music/select-track/<int:track_id>', methods=['POST'])
def select_music_track(track_id):
    track = database.set_active_music_track(track_id)
    if track:
        source_lib_path = os.path.join(MUSIC_LIBRARY_DIR, track['filename'])
        if os.path.exists(source_lib_path):
            target_path = os.path.join(AUDIO_DIR, 'music.mp3')
            shutil.copy2(source_lib_path, target_path)
            static_audio_dir = os.path.join(BASE_DIR, 'static', 'audio')
            os.makedirs(static_audio_dir, exist_ok=True)
            shutil.copy2(source_lib_path, os.path.join(static_audio_dir, 'music.mp3'))
        return jsonify({'success': True, 'track': track, 'message': f"Set '{track['title']}' as background music!"})
    return jsonify({'success': False, 'error': 'Track not found'}), 404

@app.route('/api/music/library/<int:track_id>', methods=['DELETE'])
def delete_music_track_api(track_id):
    track = database.delete_music_track(track_id)
    if track:
        file_path = os.path.join(MUSIC_LIBRARY_DIR, track['filename'])
        if os.path.exists(file_path):
            try: os.remove(file_path)
            except Exception: pass
        return jsonify({'success': True, 'message': 'Track deleted from library.'})
    return jsonify({'success': False, 'error': 'Track not found'}), 404

@app.route('/api/music/playlist/<path:playlist_name>', methods=['DELETE'])
def delete_playlist_api(playlist_name):
    import urllib.parse
    decoded_name = urllib.parse.unquote(playlist_name)
    deleted_tracks = database.delete_playlist_and_tracks(decoded_name)
    if deleted_tracks:
        for t in deleted_tracks:
            file_path = os.path.join(MUSIC_LIBRARY_DIR, t['filename'])
            if os.path.exists(file_path):
                try: os.remove(file_path)
                except Exception: pass
        print(f"\033[91m[PLAYLIST DELETED]\033[0m Playlist '{decoded_name}' & {len(deleted_tracks)} tracks purged.")
        return jsonify({
            'success': True,
            'message': f"Deleted playlist '{decoded_name}' and purged {len(deleted_tracks)} tracks.",
            'deleted_count': len(deleted_tracks)
        })
    return jsonify({'success': False, 'error': 'Playlist not found or empty.'}), 404

# Static file serving routes
@app.route('/previews/<path:filename>')
def serve_preview(filename):
    return send_from_directory(PREVIEW_DIR, filename)

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)

@app.route('/sessions/<path:filename>')
def serve_session_file(filename):
    return send_from_directory(SESSION_DIR, filename)

@app.route('/audio/<path:filename>')
def serve_audio_file(filename):
    return send_from_directory(AUDIO_DIR, filename)

@app.route('/guest')
@app.route('/viewfinder')
def serve_viewfinder_popout():
    return send_from_directory(app.static_folder, 'viewfinder.html')

if __name__ == '__main__':
    print("\n=======================================================")
    print(" PSSC PhotoBooth 3.0 RUNNING AT: http://localhost:5000")
    print(" [LIVE LOG STREAM ACTIVE] Ready for live updates!")
    print("=======================================================\n", flush=True)
    sys.stdout.flush()
    app.run(host='127.0.0.1', port=5000, debug=False)
