import re, os

base_dir = os.path.dirname(os.path.abspath(__file__))
js_path = os.path.join(base_dir, 'static', 'js', 'app.js')
html_path = os.path.join(base_dir, 'static', 'index.html')

with open(js_path, 'r', encoding='utf-8') as f:
    js = f.read()

with open(html_path, 'r', encoding='utf-8') as f:
    html = f.read()

js_ids = re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", js)
html_ids = set(re.findall(r"id=['\"]([^'\"]+)['\"]", html))

print("Total getElementById calls in app.js:", len(js_ids))
missing = [i for i in js_ids if i not in html_ids]
print("MISSING DOM IDs IN HTML:", set(missing))
