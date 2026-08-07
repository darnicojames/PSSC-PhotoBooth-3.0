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
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT MAX(id) as max_id FROM sessions')
        row = cursor.fetchone()
        max_id = row['max_id'] if row and row['max_id'] else 0
        return max_id + 1

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

def save_session(template_id, template_name, output_path, guest_name="Guest", code="", queue_number=None):
    created_at = time.time()
    if queue_number is None:
        queue_number = get_next_queue_number()
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO sessions (template_id, template_name, output_path, guest_name, code, queue_number, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (template_id, template_name, output_path, guest_name, code, queue_number, created_at))
        conn.commit()
        return cursor.lastrowid

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
