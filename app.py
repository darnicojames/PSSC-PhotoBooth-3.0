import os
import sys
try:
    sys.stdout.reconfigure(encoding='utf-8', write_through=True)
    sys.stderr.reconfigure(encoding='utf-8', write_through=True)
except Exception:
    pass
import time
import uuid
import json
import base64
import shutil
import subprocess
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

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)
os.makedirs(SESSION_DIR, exist_ok=True)
os.makedirs(AUDIO_DIR, exist_ok=True)

# Initialize Database and default sample templates
database.init_db()
try:
    create_samples.create_sample_templates()
except Exception as e:
    print(f"Sample generation notice: {e}")

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

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
    if filter_type == 'bw':
        return ImageOps.grayscale(img).convert('RGBA')
    elif filter_type == 'sepia':
        bw = ImageOps.grayscale(img)
        sepia_img = Image.new('RGB', bw.size)
        pixels = sepia_img.load()
        bw_pixels = bw.load()
        for x in range(bw.width):
            for y in range(bw.height):
                p = bw_pixels[x, y]
                r = int(p * 1.05)
                g = int(p * 0.90)
                b = int(p * 0.70)
                pixels[x, y] = (min(r, 255), min(g, 255), min(b, 255))
        return sepia_img.convert('RGBA')
    elif filter_type == 'vintage':
        enhancer = ImageEnhance.Color(img)
        img = enhancer.enhance(0.7)
        enhancer = ImageEnhance.Contrast(img)
        img = enhancer.enhance(1.2)
        return img
    elif filter_type == 'cyberpunk':
        r, g, b, a = img.split()
        r = r.point(lambda i: min(255, int(i * 1.2)))
        b = b.point(lambda i: min(255, int(i * 1.3)))
        return Image.merge('RGBA', (r, g, b, a))
    elif filter_type == 'vivid':
        enhancer = ImageEnhance.Color(img)
        img = enhancer.enhance(1.4)
        enhancer = ImageEnhance.Contrast(img)
        return enhancer.enhance(1.1)
    elif filter_type == 'blur':
        return img.filter(ImageFilter.GaussianBlur(radius=2))
    return img

@app.route('/api/session/composite', methods=['POST'])
def composite_session():
    data = request.json or {}
    template_id = data.get('template_id')
    photos_b64 = data.get('photos', [])
    filter_name = data.get('filter', 'normal')
    guest_name_input = data.get('guest_name', 'Guest').strip() or 'Guest'
    layout_option = data.get('layout', 'single') # 'single' or 'double'

    t = database.get_template(template_id)
    if not t:
        return jsonify({'success': False, 'error': 'Template not found'}), 404

    slots = t['slots']
    width = t['width']
    height = t['height']

    # Enforce Crucial Requirement: Google Sheets Database URL
    sheets_url = database.get_config('google_sheets_url', '').strip()
    if not sheets_url:
        return jsonify({'success': False, 'error': 'Crucial Setup Missing: Google Sheets Database URL is empty in Settings. Please configure it before starting sessions.'}), 400

    # Queue Number Tracking (counts sequentially 1, 2, 3...)
    queue_number = database.get_next_queue_number()
    code = f"#{queue_number}"
    now = datetime.datetime.now()
    date_str_formatted = now.strftime('%d/%m/%Y %H:%M:%S')
    time_stamp_filename = now.strftime('%Y-%m-%d_%H-%M-%S')

    safe_guest_name = "".join([c for c in guest_name_input if c.isalnum() or c in (' ', '_', '-')]).strip() or 'Guest'
    output_filename = f"PSSCBooth_Q{queue_number}_{safe_guest_name}_{time_stamp_filename}.png"

    # Load top frame overlay
    overlay_full_path = os.path.join(PREVIEW_DIR, t['overlay_path'])
    if os.path.exists(overlay_full_path):
        overlay = Image.open(overlay_full_path).convert('RGBA')
    else:
        overlay = Image.new('RGBA', (width, height), (0, 0, 0, 0))

    # Base background image where photos will be composited (preserves full template artwork/strip design)
    preview_full_path = os.path.join(PREVIEW_DIR, t['preview_path'])
    if os.path.exists(preview_full_path):
        base_img = Image.open(preview_full_path).convert('RGBA')
    elif os.path.exists(overlay_full_path):
        base_img = Image.open(overlay_full_path).convert('RGBA')
    else:
        base_img = Image.new('RGBA', (width, height), (245, 245, 250, 255))

    # Fit photos into slots
    for idx, slot in enumerate(slots):
        if idx >= len(photos_b64):
            break
        
        b64_str = photos_b64[idx]
        if ',' in b64_str:
            b64_str = b64_str.split(',')[1]
        
        photo_bytes = base64.b64decode(b64_str)
        photo_img = Image.open(BytesIO(photo_bytes)).convert('RGBA')
        
        # Apply filter
        photo_img = apply_image_filter(photo_img, filter_name)

        # Expand target dimensions by +8px (+4px padding on each side) so photo completely fills the colored box frame with zero edge gap
        pad = 4
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

        is_t1 = 'template1' in t.get('name', '').lower() or t.get('id') == 3

        if is_t1:
            # Template 1 has sharp 90-degree rectangular boxes matching its design
            base_img.paste(photo_cropped, (paste_x, paste_y), photo_cropped)
        else:
            # Other templates use smooth rounded corner alpha masks (radius=28px)
            corner_radius = max(24, int(min(target_w, target_h) * 0.12))
            mask = Image.new('L', (target_w, target_h), 0)
            mask_draw = ImageDraw.Draw(mask)
            mask_draw.rounded_rectangle([0, 0, target_w, target_h], radius=corner_radius, fill=255)
            base_img.paste(photo_cropped, (paste_x, paste_y), mask)

    # Clear out slot cutout regions in top frame overlay so captured photos show through seamlessly!
    overlay_draw = ImageDraw.Draw(overlay)
    is_t1_template = 'template1' in t.get('name', '').lower() or t.get('id') == 3
    for slot in slots:
        if is_t1_template:
            overlay_draw.rectangle([slot['x'], slot['y'], slot['x'] + slot['w'], slot['y'] + slot['h']], fill=(0, 0, 0, 0))
        else:
            c_rad = max(20, int(min(slot['w'], slot['h']) * 0.11))
            overlay_draw.rounded_rectangle([slot['x'], slot['y'], slot['x'] + slot['w'], slot['y'] + slot['h']], radius=c_rad, fill=(0, 0, 0, 0))

    # Composite top frame overlay on top of background + photos
    final_output = Image.alpha_composite(base_img, overlay)

    # Double Booth Picture Option (Stitch 2 strips side-by-side gaplessly onto 1 canvas)
    if layout_option == 'double':
        double_canvas = Image.new('RGBA', (width * 2, height), (0, 0, 0, 0))
        double_canvas.paste(final_output, (0, 0), final_output)
        double_canvas.paste(final_output, (width, 0), final_output)
        final_output = double_canvas

    # Save output file to SESSION_DIR and static/sessions/ (Lossless Maximum PNG Quality!)
    output_filepath = os.path.join(SESSION_DIR, output_filename)
    final_output.save(output_filepath, 'PNG', optimize=False)
    
    static_session_dir = os.path.join(BASE_DIR, 'static', 'sessions')
    os.makedirs(static_session_dir, exist_ok=True)
    final_output.save(os.path.join(static_session_dir, output_filename), 'PNG', optimize=False)

    # Save session to SQLite database with queue_number
    session_id = database.save_session(
        template_id=t['id'],
        template_name=t['name'],
        output_path=output_filename,
        guest_name=safe_guest_name,
        code=code,
        queue_number=queue_number
    )

    # Asynchronous Google Apps Script Spreadsheet Row Logging
    def send_spreadsheet_log(date_fmt, name, q_num, photo_cnt, fname):
        import urllib.request, json, ssl
        try:
            payload = {
                'date': date_fmt,
                'name': name,
                'queue_number': q_num,
                'queue_display': f"Queue #{q_num}",
                'code': f"Queue #{q_num}",
                'photos': photo_cnt,
                'filename': fname,
                'paid': 'PAID'
            }
            
            default_sheets = 'https://script.google.com/macros/s/AKfycbzivVhvyQTPR58QDPubbUr-mmRrF8JMdMiov-RsmVQLjCaQ-ezhrGKXDyswl3IDG8eC/exec'
            target_url = database.get_config('google_sheets_url', default_sheets) or default_sheets
            data_bytes = json.dumps(payload).encode('utf-8')
            
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            
            req = urllib.request.Request(target_url, data=data_bytes, headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
                print("Google Spreadsheet Queue Log Response:", resp.read().decode('utf-8'))
        except Exception as err:
            print("Google Spreadsheet Log Notice:", err)

    import threading
    threading.Thread(target=send_spreadsheet_log, args=(date_str_formatted, safe_guest_name, queue_number, len(photos_b64), output_filename)).start()

    return jsonify({
        'success': True,
        'message': f"Photobooth ticket generated! Queue #{queue_number}",
        'session_id': session_id,
        'queue_number': queue_number,
        'queue_display': f"Queue #{queue_number}",
        'code': f"Queue #{queue_number}",
        'guest_name': safe_guest_name,
        'output_url': f"/sessions/{output_filename}",
        'filename': output_filename
    })

# --- CONFIGURATION & CLOUD APIS ---

@app.route('/api/config', methods=['GET'])
def get_system_config():
    default_sheets = 'https://script.google.com/macros/s/AKfycbzivVhvyQTPR58QDPubbUr-mmRrF8JMdMiov-RsmVQLjCaQ-ezhrGKXDyswl3IDG8eC/exec'
    sheets_url = database.get_config('google_sheets_url', default_sheets)
    drive_url = database.get_config('google_drive_url', '')
    next_queue = database.get_next_queue_number()
    return jsonify({
        'success': True,
        'google_sheets_url': sheets_url,
        'google_drive_url': drive_url,
        'next_queue_number': next_queue,
        'queue_display': f"Queue #{next_queue}"
    })

@app.route('/api/config', methods=['POST'])
def save_system_config():
    data = request.json or {}
    sheets_url = data.get('google_sheets_url', '').strip()
    drive_url = data.get('google_drive_url', '').strip()
    
    if sheets_url:
        database.set_config('google_sheets_url', sheets_url)
    if drive_url is not None:
        database.set_config('google_drive_url', drive_url)
        
    return jsonify({
        'success': True,
        'message': 'Google Sheets & Drive cloud database settings saved successfully!'
    })

@app.route('/api/queue/status', methods=['GET'])
def get_queue_status():
    next_num = database.get_next_queue_number()
    return jsonify({
        'success': True,
        'next_queue_number': next_num,
        'queue_display': f"Queue #{next_num}"
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

MUSIC_LIBRARY_DIR = os.path.join(AUDIO_DIR, 'music_library')
os.makedirs(MUSIC_LIBRARY_DIR, exist_ok=True)
database.clean_corrupted_tracks(MUSIC_LIBRARY_DIR)

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
        return True, track_title

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
            cmd = [sys.executable, "-m", "yt_dlp", "--dump-single-json", "--flat-playlist", "--no-warnings", "--no-check-certificates", url]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=35)
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
        except Exception as e:
            print("Playlist JSON extraction notice:", e)

    return playlist_title, entries

def run_playlist_download_thread(url, source='youtube'):
    global global_import_status
    playlist_title, entries = extract_playlist_info(url, source=source)
    
    if not entries:
        global_import_status['in_progress'] = False
        global_import_status['error'] = "No tracks found in playlist link."
        return

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

    print(f"\n\033[95m[PLAYLIST IMPORT STARTED]\033[0m 📜 Playlist: '{playlist_title}' ({total} tracks)")

    target_path = os.path.join(AUDIO_DIR, 'music.mp3')
    
    for idx, item in enumerate(entries, 1):
        t_url = item['url']
        t_title = item['title']

        global_import_status['current_index'] = idx
        global_import_status['current_track'] = t_title
        global_import_status['percentage'] = int(((idx - 1) / total) * 100)

        print(f"\033[96m[PLAYLIST IMPORT]\033[0m ({idx}/{total}) Downloading: '{t_title}'...")

        try:
            ok, final_title = download_youtube_audio(t_url, target_path, playlist_name=playlist_title, set_active=(idx == 1))
            used_title = final_title if ok and final_title != "YouTube Track" else t_title
            global_import_status['completed_tracks'].append(used_title)
            print(f"\033[92m[PLAYLIST IMPORT]\033[0m ({idx}/{total}) Completed: '{used_title}' ✓")
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
    
    raw_url = url_or_query.strip()
    clean_url = raw_url

    if "watch?v=" in raw_url:
        vid_id = raw_url.split("watch?v=")[1].split("&")[0]
        clean_url = f"https://www.youtube.com/watch?v={vid_id}"
    elif "youtu.be/" in raw_url:
        vid_id = raw_url.split("youtu.be/")[1].split("?")[0].split("&")[0]
        clean_url = f"https://www.youtube.com/watch?v={vid_id}"

    track_title = "YouTube Track"
    search_target = clean_url if ("youtube.com" in clean_url.lower() or "youtu.be" in clean_url.lower()) else f"ytsearch1:{clean_url}"

    try:
        title_cmd = [sys.executable, "-m", "yt_dlp", "--print", "%(title)s", "--no-warnings", "--no-check-certificates", search_target]
        res_t = subprocess.run(title_cmd, capture_output=True, text=True, timeout=15)
        if res_t.returncode == 0 and res_t.stdout.strip():
            extracted_title = res_t.stdout.strip().splitlines()[0]
            if extracted_title and not extracted_title.startswith('[') and not extracted_title.startswith('ERROR'):
                track_title = extracted_title
    except Exception as e:
        print("YouTube title extraction notice:", e)

    success = False

    try:
        cmd_ytdlp = [
            sys.executable, "-m", "yt_dlp",
            search_target,
            "-x", "--audio-format", "mp3",
            "--audio-quality", "0",
            "--no-check-certificates",
            "-o", temp_target,
            "--force-overwrites"
        ]
        if ffmpeg_dir:
            cmd_ytdlp.extend(["--ffmpeg-location", ffmpeg_dir])

        res_yt = subprocess.run(cmd_ytdlp, capture_output=True, text=True, timeout=120)

        if os.path.exists(temp_target) and os.path.getsize(temp_target) > 10000:
            success = True
    except Exception as e:
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
        return True, track_title

    return False, track_title

# --- USER ACTION LOGGING & CLEAN TERMINAL LOGS ---
import logging
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

@app.after_request
def log_requests(response):
    if request.path.startswith('/api/') and request.path not in ('/api/heartbeat', '/api/import-progress', '/api/log-action'):
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

        is_playlist = ("list=" in url.lower() or "playlist" in url.lower())

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
            ok, title = download_youtube_audio(url, target_path)

            if ok:
                return jsonify({
                    'success': True,
                    'is_playlist': False,
                    'message': f"Successfully imported '{title}' from YouTube Music!",
                    'track_title': title,
                    'music_url': '/audio/music.mp3',
                    'tracks': database.get_all_music_tracks()
                })
            else:
                return jsonify({
                    'success': False,
                    'error': "Failed to download YouTube audio track. Please check the URL or connection."
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
        print(f"\033[91m[PLAYLIST DELETED]\033[0m 🗑️ Playlist '{decoded_name}' & {len(deleted_tracks)} songs purged.")
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

@app.route('/viewfinder')
def serve_viewfinder_popout():
    return send_from_directory(app.static_folder, 'viewfinder.html')

@app.route('/visualizer')
def serve_visualizer():
    return send_from_directory(app.static_folder, 'visualizer.html')

if __name__ == '__main__':
    print("\n=======================================================")
    print(" PSSC PhotoBooth 3.0 RUNNING AT: http://localhost:5000")
    print(" [LIVE LOG STREAM ACTIVE] Ready for live updates!")
    print("=======================================================\n", flush=True)
    sys.stdout.flush()
    app.run(host='127.0.0.1', port=5000, debug=False)
