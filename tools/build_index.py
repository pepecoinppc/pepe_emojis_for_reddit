#!/usr/bin/env python3
"""Rebuild emojis/index.json from the files in emojis/static and emojis/gif.

Both folders are searched recursively, so you can organise Pepes into
subfolders (e.g. emojis/static/sad/Sadge.png). Hidden files and folders
(names starting with "." such as .DS_Store) and macOS "__MACOSX" folders
are skipped.

Chrome extensions can't list their own folders at runtime, so the picker reads
this index. Run it after adding or removing emoji files, then click the reload
button on the extension in chrome://extensions.

    python3 tools/build_index.py
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EMOJI_DIR = ROOT / "emojis"
FOLDERS = {
    "static": (".png", ".jpg", ".jpeg", ".webp"),
    "gif": (".gif",),
}
SKIP_DIRS = {"__MACOSX"}


def find_images(folder: Path, exts):
    """Yield image files under `folder`, searching all subfolders."""
    for dirpath, dirnames, filenames in os.walk(folder):
        # Prune hidden/junk folders in place so os.walk doesn't descend into them.
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS)
        for name in filenames:
            if name.startswith(".") or not name.lower().endswith(exts):
                continue
            yield Path(dirpath) / name


def main():
    index = {}
    for folder, exts in FOLDERS.items():
        base = EMOJI_DIR / folder
        base.mkdir(parents=True, exist_ok=True)
        files = sorted(find_images(base, exts), key=lambda p: p.relative_to(base).as_posix().lower())
        index[folder] = [
            {
                "name": path.stem,
                # Always forward slashes, so the index works when built on Windows too.
                "file": path.relative_to(ROOT).as_posix(),
            }
            for path in files
        ]
    out = EMOJI_DIR / "index.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=2)
        fh.write("\n")
    print(f"Wrote {out}: {len(index['static'])} static, {len(index['gif'])} gif")


if __name__ == "__main__":
    main()
