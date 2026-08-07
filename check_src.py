import re, os

base_dir = os.path.dirname(os.path.abspath(__file__))
html_path = os.path.join(base_dir, 'static', 'index.html')
js_path = os.path.join(base_dir, 'static', 'js', 'app.js')

with open(html_path, 'r', encoding='utf-8') as f:
    html = f.read()

with open(js_path, 'r', encoding='utf-8') as f:
    js = f.read()

print("Checking index.html for src='' or src='#'...")
empty_src = re.findall(r'src=["\']\s*["\']', html) + re.findall(r'src=["\']#["\']', html)
print("Empty srcs found:", empty_src)

# Check all img tags in index.html
img_tags = re.findall(r'<img[^>]+>', html)
for img in img_tags:
    print(" IMG TAG:", img)
