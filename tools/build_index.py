#!/usr/bin/env python3
"""Rebuild emojis/index.json from the files in emojis/static and emojis/gif.

Chrome extensions can't list their own folders at runtime, so the picker reads
this index. Run it after adding or removing emoji files, then click the reload
button on the extension in chrome://extensions.

    python3 tools/build_index.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMOJI_DIR = os.path.join(ROOT, "emojis")
FOLDERS = {
    "static": (".png", ".jpg", ".jpeg", ".webp"),
    "gif": (".gif",),
}


def main():
    index = {}
    for folder, exts in FOLDERS.items():
        path = os.path.join(EMOJI_DIR, folder)
        os.makedirs(path, exist_ok=True)
        files = sorted(
            (f for f in os.listdir(path) if f.lower().endswith(exts)),
            key=str.lower,
        )
        index[folder] = [
            {"name": os.path.splitext(f)[0], "file": f"emojis/{folder}/{f}"}
            for f in files
        ]
    out = os.path.join(EMOJI_DIR, "index.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=2)
    print(f"Wrote {out}: {len(index['static'])} static, {len(index['gif'])} gif")


if __name__ == "__main__":
    main()
