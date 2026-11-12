"""Extract public rendered copy only; no runtime configuration or financial files."""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

strings = set()
def add(text):
    text = re.sub(r'\s+', ' ', text).strip()
    if re.search(r'[\u4e00-\u9fff\u0600-\u06ff\u0900-\u097f]', text): return
    if text.startswith(('#', '.', '@', '(', '-apple-', '/')): return
    text = re.sub(r'\{\{\d+\}\}', '987654321', text)
    if not re.search(r'[A-Za-z]{2}', text) or text.startswith(('http:', 'https:', '/api/')):
        return
    values = []
    def number(match):
        values.append(match[0]); return '{{' + str(len(values)-1) + '}}'
    strings.add(re.sub(r'\d+(?:[.,:/-]\d+)*(?:%|[KMB])?', number, text))

class Copy(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'svg', 'code', 'pre'): self.skip += 1
        if not self.skip:
            for key, value in attrs:
                if key in ('title', 'aria-label', 'placeholder', 'alt') and value: add(value)
    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'svg', 'code', 'pre') and self.skip: self.skip -= 1
    def handle_data(self, text):
        if not self.skip: add(text)

for root in sys.argv[1:-1]:
    path = Path(root)
    if path.suffix == '.json':
        for text in json.loads(path.read_text()): Copy().feed(text)
    else:
        for html in path.rglob('*.html'): Copy().feed(html.read_text())
Path(sys.argv[-1]).write_text(json.dumps(sorted(strings), ensure_ascii=False, indent=2))
print(f'Extracted {len(strings)} public copy templates.')
