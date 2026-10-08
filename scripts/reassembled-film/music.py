"""Read-only library index and selective project import. No bulk audio copying."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import sys
from datetime import datetime, timezone

EXTENSIONS = {'.mp3', '.wav', '.flac', '.aif', '.aiff', '.m4a', '.ogg', '.aac'}


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def index(root, output):
    root = root.resolve(strict=True)
    tracks, errors = [], []
    def onerror(error):
        errors.append(str(error))
    for folder, dirs, files in os.walk(root, followlinks=False, onerror=onerror):
        dirs[:] = [d for d in dirs if not (Path(folder)/d).is_symlink() and not os.path.isjunction(Path(folder)/d)]
        for name in files:
            file = Path(folder)/name
            if file.suffix.lower() not in EXTENSIONS:
                continue
            try:
                if file.is_symlink() or not file.resolve().is_relative_to(root):
                    continue
                stat = file.stat()
                relative = file.relative_to(root).as_posix()
                tracks.append(dict(id=hashlib.sha256(relative.encode()).hexdigest()[:16], path=relative,
                                   title=file.stem, categories=list(file.relative_to(root).parts[:-1]),
                                   bytes=stat.st_size, modifiedNs=stat.st_mtime_ns))
            except OSError as error:
                errors.append(str(error))
    tracks.sort(key=lambda item: item['path'].casefold())
    result = dict(root=str(root), indexedAt=datetime.now(timezone.utc).isoformat(),
                  licenseBasis='用户于2026-10-08确认：该公司内网目录中的音乐均有授权，可用于本流程。',
                  tracks=tracks, errors=errors)
    save(output, result)
    print(json.dumps(dict(tracks=len(tracks), errors=len(errors), output=str(output)), ensure_ascii=False))
    if errors:
        raise RuntimeError('Index incomplete; see recorded scan errors')


def select(catalog, track_id, project):
    item = next(t for t in catalog['tracks'] if t['id'] == track_id)
    root = Path(catalog['root']).resolve(strict=True)
    source = (root/item['path']).resolve(strict=True)
    if not source.is_relative_to(root):
        raise ValueError('Music path outside configured library')
    if source.stat().st_size != item['bytes'] or source.stat().st_mtime_ns != item['modifiedNs']:
        raise ValueError('Library file changed; refresh index before selecting')
    project = project.resolve(strict=True)
    target = project/'music'/f'{track_id}{source.suffix.lower()}'
    target.parent.mkdir(exist_ok=True)
    if not target.resolve().is_relative_to(project):
        raise ValueError('Linked music directory outside project')
    source_hash = digest(source)
    if target.exists():
        if digest(target) != source_hash:
            raise ValueError('Existing project music differs; refusing overwrite')
    else:
        fd, tmp = tempfile.mkstemp(dir=target.parent, suffix='.tmp')
        os.close(fd)
        try:
            shutil.copyfile(source, tmp)
            if digest(Path(tmp)) != source_hash:
                raise ValueError('Music changed during copy')
            os.link(tmp, target)  # No overwrite, including concurrent imports.
        finally:
            os.unlink(tmp)
    receipt = dict(track=item, source=str(source), localFile=str(target.relative_to(project)),
                   sha256=source_hash, licenseBasis=catalog['licenseBasis'], importedAt=datetime.now(timezone.utc).isoformat())
    save(target.with_suffix(target.suffix+'.license.json'), receipt)
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf8')
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    scan = sub.add_parser('index'); scan.add_argument('root', type=Path); scan.add_argument('output', type=Path)
    search = sub.add_parser('search'); search.add_argument('index', type=Path); search.add_argument('keywords', nargs='*')
    copy = sub.add_parser('select'); copy.add_argument('index', type=Path); copy.add_argument('id'); copy.add_argument('project', type=Path)
    args = parser.parse_args()
    if args.command == 'index':
        index(args.root, args.output)
    else:
        catalog = json.loads(args.index.read_text(encoding='utf8'))
        if args.command == 'select':
            select(catalog, args.id, args.project)
        else:
            matches = [t for t in catalog['tracks'] if all(w.casefold() in t['path'].casefold() for w in args.keywords)]
            print(json.dumps(dict(matches=len(matches), tracks=matches[:50]), ensure_ascii=False, indent=2))
