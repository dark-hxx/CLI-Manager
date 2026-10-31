"""Generate owned, offline preview fixtures, with no third-party PDF assets."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent / 'results' / 'preview-fixtures'
root.mkdir(parents=True, exist_ok=True)
stream = b'BT /F1 22 Tf 72 700 Td (CLI-Manager isolated PDF probe) Tj ET\n'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
           b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
           b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
           b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
           b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'endstream']
pdf = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
xref = len(pdf)
pdf.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
for offset in offsets[1:]:
    pdf.extend(f'{offset:010d} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
with (root / 'sample.pdf').open('xb') as handle:
    handle.write(pdf)
print(json.dumps({'file': str(root / 'sample.pdf'), 'bytes': len(pdf),
                  'sha256': hashlib.sha256(pdf).hexdigest()}))
