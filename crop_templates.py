import os
import database
import json
from PIL import Image

def crop_all_templates():
    database.init_db()
    templates = database.get_all_templates()
    for t in templates:
        name = t['name']
        if 'template' in name.lower():
            prev_path = os.path.join(os.path.dirname(__file__), 'static', 'previews', t['preview_path'])
            over_path = os.path.join(os.path.dirname(__file__), 'static', 'previews', t['overlay_path'])
            
            if os.path.exists(prev_path):
                img_prev = Image.open(prev_path)
                if img_prev.mode == 'RGBA':
                    alpha = img_prev.split()[3]
                    bbox = alpha.getbbox()
                    if bbox:
                        x1, y1, x2, y2 = bbox
                        new_w = x2 - x1
                        new_h = y2 - y1
                        
                        if new_w < t['width'] or new_h < t['height']:
                            # Crop preview
                            cropped_prev = img_prev.crop(bbox)
                            cropped_prev.save(prev_path, 'PNG')
                            
                            # Crop overlay if exists
                            if os.path.exists(over_path):
                                img_over = Image.open(over_path)
                                cropped_over = img_over.crop(bbox)
                                cropped_over.save(over_path, 'PNG')
                            
                            # Adjust slots coordinates
                            new_slots = []
                            for s in t['slots']:
                                new_s = dict(s)
                                new_s['x'] = s['x'] - x1
                                new_s['y'] = s['y'] - y1
                                new_slots.append(new_s)
                            
                            # Update DB record
                            with database.get_db() as conn:
                                conn.cursor().execute('''
                                    UPDATE templates 
                                    SET width = ?, height = ?, slots_json = ? 
                                    WHERE id = ?
                                ''', (new_w, new_h, json.dumps(new_slots), t['id']))
                                conn.commit()
                            print(f"Successfully cropped {name}: New size {new_w}x{new_h}")

if __name__ == '__main__':
    crop_all_templates()
