import sqlite3
import json
import os
import time

DB_PATH = os.path.join(os.path.dirname(__file__), 'database', 'photobooth.db')

def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                filename TEXT NOT NULL,
                psd_path TEXT,
                preview_path TEXT NOT NULL,
                overlay_path TEXT NOT NULL,
                width INTEGER NOT NULL,
                height INTEGER NOT NULL,
                slots_json TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                template_id INTEGER,
                template_name TEXT,
                output_path TEXT NOT NULL,
                guest_name TEXT,
                code TEXT,
                created_at REAL NOT NULL
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        ''')
        try:
            cursor.execute('ALTER TABLE sessions ADD COLUMN guest_name TEXT')
        except Exception: pass
        try:
            cursor.execute('ALTER TABLE sessions ADD COLUMN code TEXT')
        except Exception: pass
        try:
            cursor.execute('ALTER TABLE sessions ADD COLUMN queue_number INTEGER')
        except Exception: pass
        try:
            cursor.execute("ALTER TABLE sessions ADD COLUMN paid_status TEXT DEFAULT 'Paid'")
        except Exception: pass
        try:
            cursor.execute("ALTER TABLE sessions ADD COLUMN given_status TEXT DEFAULT 'Not Given'")
        except Exception: pass
        try:
            cursor.execute("ALTER TABLE sessions ADD COLUMN drive_url TEXT DEFAULT ''")
        except Exception: pass
        try:
            cursor.execute("ALTER TABLE sessions ADD COLUMN video_path TEXT DEFAULT ''")
        except Exception: pass
        try:
            cursor.execute("ALTER TABLE music_library ADD COLUMN source TEXT DEFAULT 'spotify'")
        except Exception: pass
        try:
            cursor.execute("ALTER TABLE music_library ADD COLUMN playlist_name TEXT DEFAULT NULL")
        except Exception: pass
        try:
            cursor.execute("UPDATE music_library SET title = 'Hiraya' WHERE (title = 'YouTube Track' OR title = 'YouTube Music Track') AND source_url LIKE '%ZzFP2UCR_64%'")
        except Exception: pass
        conn.commit()

def get_config(key, default_val=''):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT value FROM config WHERE key = ?', (key,))
        row = cursor.fetchone()
        return row['value'] if row else default_val

def set_config(key, value):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', (key, str(value)))
        conn.commit()

def get_next_queue_number():
    counter = get_config('queue_counter', None)
    if counter is not None:
        try:
            val = int(counter)
            if val > 0:
                return val
        except (ValueError, TypeError):
            pass
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT MAX(queue_number) as max_q, MAX(id) as max_id FROM sessions')
        row = cursor.fetchone()
        max_val = 0
        if row:
            if row['max_q'] is not None:
                max_val = row['max_q']
            elif row['max_id'] is not None:
                max_val = row['max_id']
        return max_val + 1

def reset_queue(start_number=1):
    try:
        val = int(start_number)
        if val < 1:
            val = 1
    except (ValueError, TypeError):
        val = 1
    set_config('queue_counter', val)
    return val

def clean_corrupted_tracks(music_library_dir):
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('SELECT id, filename FROM music_library')
            rows = cursor.fetchall()
            for r in rows:
                track_id = r['id']
                fn = r['filename']
                fp = os.path.join(music_library_dir, fn)
                if not os.path.exists(fp) or os.path.getsize(fp) < 10000:
                    cursor.execute('DELETE FROM music_library WHERE id = ?', (track_id,))
                    if os.path.exists(fp):
                        try: os.remove(fp)
                        except Exception: pass
            conn.commit()
    except Exception as e:
        print("Music cleanup notice:", e)

def save_template(name, filename, psd_path, preview_path, overlay_path, width, height, slots):
    slots_json = json.dumps(slots)
    created_at = time.time()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO templates (name, filename, psd_path, preview_path, overlay_path, width, height, slots_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (name, filename, psd_path, preview_path, overlay_path, width, height, slots_json, created_at))
        conn.commit()
        return cursor.lastrowid

def get_all_templates():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM templates ORDER BY id DESC')
        rows = cursor.fetchall()
        templates = []
        for r in rows:
            t = dict(r)
            t['slots'] = json.loads(t['slots_json'])
            templates.append(t)
        return templates

def get_template(template_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM templates WHERE id = ?', (template_id,))
        row = cursor.fetchone()
        if row:
            t = dict(row)
            t['slots'] = json.loads(t['slots_json'])
            return t
        return None

def delete_template(template_id):
    t = get_template(template_id)
    if t:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute('DELETE FROM templates WHERE id = ?', (template_id,))
            conn.commit()
        return t
    return None

def save_session(template_id, template_name, output_path, guest_name="Guest", code="", queue_number=None, paid_status="Paid", given_status="Not Given", drive_url=""):
    created_at = time.time()
    if queue_number is None:
        queue_number = get_next_queue_number()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO sessions (template_id, template_name, output_path, guest_name, code, queue_number, paid_status, given_status, drive_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (template_id, template_name, output_path, guest_name, code, queue_number, paid_status, given_status, drive_url, created_at))
        session_id = cursor.lastrowid
        conn.commit()
    try:
        set_config('queue_counter', int(queue_number) + 1)
    except Exception as e:
        print("Notice updating queue_counter:", e)
    return session_id

def get_session(session_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM sessions WHERE id = ?', (session_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def update_session_status(session_id, paid_status=None, given_status=None, drive_url=None):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM sessions WHERE id = ?', (session_id,))
        row = cursor.fetchone()
        if not row:
            return None
        current_paid = row['paid_status'] if 'paid_status' in row.keys() and row['paid_status'] else 'Paid'
        current_given = row['given_status'] if 'given_status' in row.keys() and row['given_status'] else 'Not Given'
        current_drive = row['drive_url'] if 'drive_url' in row.keys() and row['drive_url'] else ''
        
        new_paid = paid_status if paid_status is not None else current_paid
        new_given = given_status if given_status is not None else current_given
        new_drive = drive_url if drive_url is not None else current_drive
        
        cursor.execute('''
            UPDATE sessions SET paid_status = ?, given_status = ?, drive_url = ?
            WHERE id = ?
        ''', (new_paid, new_given, new_drive, session_id))
        conn.commit()
        cursor.execute('SELECT * FROM sessions WHERE id = ?', (session_id,))
        updated = cursor.fetchone()
        return dict(updated) if updated else None

def update_session_status_by_queue(queue_number, paid_status=None, given_status=None, drive_url=None):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM sessions WHERE queue_number = ?', (queue_number,))
        row = cursor.fetchone()
        if not row:
            return None
        current_paid = row['paid_status'] if 'paid_status' in row.keys() and row['paid_status'] else 'Paid'
        current_given = row['given_status'] if 'given_status' in row.keys() and row['given_status'] else 'Not Given'
        current_drive = row['drive_url'] if 'drive_url' in row.keys() and row['drive_url'] else ''
        
        new_paid = paid_status if paid_status is not None else current_paid
        new_given = given_status if given_status is not None else current_given
        new_drive = drive_url if drive_url is not None else current_drive
        
        cursor.execute('''
            UPDATE sessions SET paid_status = ?, given_status = ?, drive_url = ?
            WHERE queue_number = ?
        ''', (new_paid, new_given, new_drive, queue_number))
        conn.commit()
        cursor.execute('SELECT * FROM sessions WHERE queue_number = ?', (queue_number,))
        updated = cursor.fetchone()
        return dict(updated) if updated else None

def update_session_video_by_queue(queue_number, video_path):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('UPDATE sessions SET video_path = ? WHERE queue_number = ?', (video_path, queue_number))
        conn.commit()

def get_all_sessions():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM sessions ORDER BY id DESC')
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

def delete_session(session_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM sessions WHERE id = ?', (session_id,))
        row = cursor.fetchone()
        if row:
            cursor.execute('DELETE FROM sessions WHERE id = ?', (session_id,))
            conn.commit()
            return dict(row)
        return None

def add_music_track(title, filename, source_url=None, source="spotify", playlist_name=None, set_active=True):
    created_at = time.time()
    with get_db() as conn:
        cursor = conn.cursor()
        if set_active:
            cursor.execute('UPDATE music_library SET is_active = 0')
        cursor.execute('''
            INSERT INTO music_library (title, filename, source_url, source, playlist_name, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (title, filename, source_url, source, playlist_name, 1 if set_active else 0, created_at))
        conn.commit()
        return cursor.lastrowid

def get_all_music_tracks():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM music_library ORDER BY id DESC')
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

def set_active_music_track(track_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('UPDATE music_library SET is_active = 0')
        cursor.execute('UPDATE music_library SET is_active = 1 WHERE id = ?', (track_id,))
        cursor.execute('SELECT * FROM music_library WHERE id = ?', (track_id,))
        row = cursor.fetchone()
        conn.commit()
        return dict(row) if row else None

def delete_music_track(track_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM music_library WHERE id = ?', (track_id,))
        row = cursor.fetchone()
        if row:
            cursor.execute('DELETE FROM music_library WHERE id = ?', (track_id,))
            conn.commit()
            return dict(row)
        return None

def delete_playlist_and_tracks(playlist_name):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM music_library WHERE playlist_name = ?', (playlist_name,))
        rows = cursor.fetchall()
        tracks = [dict(r) for r in rows]
        if tracks:
            cursor.execute('DELETE FROM music_library WHERE playlist_name = ?', (playlist_name,))
            conn.commit()
            return tracks
        return []
