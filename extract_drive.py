import urllib.request, ssl, re, json, os, sqlite3, shutil, csv, io
from datetime import datetime

SESSION_DIR = os.path.join(os.path.dirname(__file__), 'static', 'sessions')
DB_PATH = os.path.join(os.path.dirname(__file__), 'database', 'photobooth.db')
PREV_DIR = os.path.join(os.path.dirname(__file__), 'static', 'previews')
os.makedirs(SESSION_DIR, exist_ok=True)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# ── STEP 1: Fetch Google Drive folder page ─────────────────────────────────
folder_id = '1UuOhFrn1KP9TGjsh-r-yWwbFWyDv18QC'
drive_url = f'https://drive.google.com/drive/folders/{folder_id}'
print('Fetching Google Drive folder page...')
req = urllib.request.Request(drive_url, headers={
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0'
})
with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
    drive_html = resp.read().decode('utf-8', errors='ignore')
print(f'Drive page fetched ({len(drive_html)} bytes)')

# ── STEP 2: Extract file ID -> filename mappings from Drive JS data ────────
# Google Drive embeds file data as: ["FILE_ID","FILENAME","mime",...]
file_map = {}  # filename -> file_id

# Primary pattern: Drive metadata JSON arrays
pattern1 = re.findall(r'"(1[A-Za-z0-9_-]{19,})"[,\s]+"(PSSCBooth_[^"]+\.png)"', drive_html)
pattern2 = re.findall(r'"(PSSCBooth_[^"]+\.png)"[^"]*"(1[A-Za-z0-9_-]{19,})"', drive_html)

for fid, fname in pattern1:
    file_map[fname] = fid
for fname, fid in pattern2:
    if fname not in file_map:
        file_map[fname] = fid

print(f'Extracted {len(file_map)} file ID mappings from Drive page.')

# All unique filenames visible (including those without an extractable ID)
all_drive_fnames = list(set(re.findall(r'PSSCBooth_[A-Za-z0-9_ .%-]+\.png', drive_html)))
all_drive_fnames_decoded = []
for f in all_drive_fnames:
    try:
        from urllib.parse import unquote
        all_drive_fnames_decoded.append(unquote(f))
    except Exception:
        all_drive_fnames_decoded.append(f)
all_drive_fnames_decoded = list(set(all_drive_fnames_decoded))
print(f'Total unique filenames found in Drive HTML: {len(all_drive_fnames_decoded)}')

# ── STEP 3: Fetch Google Sheets CSV ───────────────────────────────────────
sheet_id = '1NOaU4HQWSWDClCIGoxks2jkypTddojdt0rmHlw1sEKM'
csv_url = f'https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid=0'
print('Fetching Google Sheets CSV...')
req2 = urllib.request.Request(csv_url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req2, context=ctx, timeout=15) as resp:
    sheet_csv = resp.read().decode('utf-8', errors='ignore')

rows = list(csv.reader(io.StringIO(sheet_csv)))
header = rows[0]
data_rows = rows[1:]
print(f'Sheets has {len(data_rows)} session rows (excluding header)')

# Parse columns: DATE, QUEUE NUM, CODE, _, FILENAME
# Col indices: 0=datetime, 1=queue, 2=code, 3=?, 4=filename
sheet_sessions = []
for r in data_rows:
    if len(r) < 5:
        continue
    dt_str = r[0].strip()
    queue = r[1].strip()
    code = r[2].strip()
    fname = r[4].strip()
    if not fname or fname == 'FILE NAME':
        continue

    # Parse timestamp
    ts = 0.0
    for fmt in ['%d/%m/%Y %H:%M:%S', '%m/%d/%Y %H:%M:%S', '%Y-%m-%d %H:%M:%S']:
        try:
            ts = datetime.strptime(dt_str, fmt).timestamp()
            break
        except Exception:
            pass

    sheet_sessions.append({
        'datetime': dt_str,
        'queue': queue,
        'code': code,
        'filename': fname,
        'ts': ts
    })

print(f'Parsed {len(sheet_sessions)} sessions from Google Sheets.')

# ── STEP 4: Merge all sources ─────────────────────────────────────────────
# Build master set: sheets as canonical + drive extras
all_filenames = {}  # fname -> {queue, code, ts, drive_id}

for s in sheet_sessions:
    fn = s['filename']
    all_filenames[fn] = {
        'queue': s['queue'],
        'code': s['code'],
        'ts': s['ts'],
        'drive_id': file_map.get(fn, None),
        'datetime': s['datetime']
    }

# Add Drive-only entries not in Sheets
for fn in all_drive_fnames_decoded:
    if fn not in all_filenames:
        all_filenames[fn] = {
            'queue': '',
            'code': '',
            'ts': 0.0,
            'drive_id': file_map.get(fn, None),
            'datetime': ''
        }

print(f'Total unique sessions (Sheets + Drive combined): {len(all_filenames)}')

# ── STEP 5: Download PNG files from Google Drive where we have IDs ─────────
download_count = 0
skip_count = 0
fail_count = 0

for fn, meta in all_filenames.items():
    dest = os.path.join(SESSION_DIR, fn)
    if os.path.exists(dest) and os.path.getsize(dest) > 5000:
        skip_count += 1
        continue

    fid = meta.get('drive_id')
    if not fid:
        fail_count += 1
        continue

    # Try direct download via Google Drive export link
    dl_url = f'https://drive.google.com/uc?export=download&id={fid}'
    try:
        dl_req = urllib.request.Request(dl_url, headers={
            'User-Agent': 'Mozilla/5.0',
        })
        with urllib.request.urlopen(dl_req, context=ctx, timeout=15) as dl_resp:
            data = dl_resp.read()
        if len(data) > 5000:  # Valid PNG
            with open(dest, 'wb') as f:
                f.write(data)
            download_count += 1
            print(f'  Downloaded ({len(data)//1024}KB): {fn}')
        else:
            fail_count += 1
    except Exception as e:
        fail_count += 1
        print(f'  Failed: {fn}: {e}')

print(f'Downloads: {download_count} OK, {skip_count} already existed, {fail_count} no ID or failed')

# ── STEP 6: Restore database ──────────────────────────────────────────────
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()
cur.execute('DELETE FROM sessions')

# Get local files too (Downloads, Desktop)
import glob
local_search = [
    r'C:\Users\Niko\Downloads',
    r'C:\Users\Niko\Downloads\PSSC',
    r'C:\Users\Niko\Downloads\PHOTOBOOTH',
    r'C:\Users\Niko\Desktop'
]
for d in local_search:
    if os.path.exists(d):
        for fp in glob.glob(os.path.join(d, 'PSSCBooth_*.png')):
            fn = os.path.basename(fp)
            dest = os.path.join(SESSION_DIR, fn)
            if not os.path.exists(dest):
                try:
                    shutil.copy2(fp, dest)
                except Exception:
                    pass
            if fn not in all_filenames:
                all_filenames[fn] = {'queue': '', 'code': '', 'ts': os.path.getmtime(fp), 'drive_id': None, 'datetime': ''}

# Sort by timestamp
sorted_sessions = sorted(all_filenames.items(), key=lambda x: x[1]['ts'] or 0)

# Use sample image as fallback for missing PNGs
sample_img = os.path.join(PREV_DIR, 'sample_vintage_strip.png')

restored = 0
for idx, (fn, meta) in enumerate(sorted_sessions, 1):
    dest = os.path.join(SESSION_DIR, fn)
    if not os.path.exists(dest) or os.path.getsize(dest) < 1000:
        if os.path.exists(sample_img):
            try:
                shutil.copy2(sample_img, dest)
            except Exception:
                pass

    # Parse guest name from filename
    parts = fn.replace('.png','').split('_')
    guest = 'Guest'
    if len(parts) >= 2 and parts[1] not in ('Strip', '2x6', '4x6', 'PSSC'):
        guest = parts[1]

    queue_num = meta['queue'] or f'#{idx}'
    code = meta['code'] or ''

    cur.execute('''
        INSERT INTO sessions (template_id, template_name, output_path, guest_name, code, queue_number, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (3, 'Photobooth', fn, guest, code, idx, meta['ts'] or 0))
    restored += 1

# Restore Google Sheets URL
cur.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('google_sheets_url', ?)",
    ('https://script.google.com/macros/s/AKfycbzivVhvyQTPR58QDPubbUr-mmRrF8JMdMiov-RsmVQLjCaQ-ezhrGKXDyswl3IDG8eC/exec',))
cur.execute("INSERT OR REPLACE INTO config (key, value) VALUES ('google_drive_url', ?)",
    ('https://drive.google.com/drive/folders/1UuOhFrn1KP9TGjsh-r-yWwbFWyDv18QC',))

conn.commit()
conn.close()

print(f'\n=== RESTORE COMPLETE ===')
print(f'Total sessions restored to database: {restored}')
print(f'PNGs downloaded from Drive: {download_count}')
print(f'PNGs already on disk (skipped re-download): {skip_count}')
print(f'Sessions with no available image: {fail_count}')
