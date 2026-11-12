"""Install an explicit, preconditioned public source delta, without Git resets."""
import hashlib
import json
import os
import shutil
import sys
import tarfile
from pathlib import Path

archive, manifest_path, target_path, backup_path = map(Path, sys.argv[1:])
manifest = json.loads(manifest_path.read_text())
backup_path.mkdir(parents=True, exist_ok=False)
allowed = ('content/', 'ops/')
digest = lambda data: hashlib.sha256(data).hexdigest()
files = {}
with tarfile.open(archive) as bundle:
    for member in bundle.getmembers():
        if member.isdir(): continue
        name = member.name.removeprefix('./')
        assert member.isfile() and name.startswith(allowed) and '..' not in Path(name).parts
        assert name in manifest and name not in files
        data = bundle.extractfile(member).read()
        assert digest(data) == manifest[name]['new'], name
        files[name] = data
assert set(files) == set(manifest)
# Validate the entire delta before installing any source file.
for name in files:
    dest = target_path / name
    old = manifest[name]['old']
    assert (dest.is_file() and digest(dest.read_bytes()) == old) if old else not dest.exists(), 'source drift: ' + name
    if old:
        saved = backup_path / name
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dest, saved)
owner = target_path.stat()
for name, data in files.items():
    dest = target_path / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_name('.nav-localization-' + dest.name)
    temporary.write_bytes(data)
    os.chown(temporary, owner.st_uid, owner.st_gid)
    os.replace(temporary, dest)
(backup_path / 'source-delta.json').write_text(json.dumps(manifest, indent=2))
print(f'Installed {len(files)} verified public source files; unrelated files unchanged.')
