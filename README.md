# Pepe Emojis for Reddit

Adds a Pepe button next to the **Aa** (formatting options) button in Reddit's comment box. Click it to open a picker, choose a static or animated Pepe, and it's attached to your comment.

## Install (Chrome / Edge / Brave)
1. Unzip this folder somewhere permanent.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `pepe-emoji-extension` folder.
4. Open or refresh any reddit.com post and click into the comment box.

## Folders
- `emojis/static/` — static PNG emojis
- `emojis/gif/` — animated GIF emojis
- `icons/` — the Pepe toolbar button and extension icons

## Adding or removing emojis
1. Drop files into `emojis/static/` (png/jpg/webp) or `emojis/gif/` (gif). The file name becomes the emoji's name and search term.
2. Run `python3 tools/build_index.py` to rebuild `emojis/index.json`. Chrome can't list an extension's folders by itself, so the picker reads this index.
3. Click the reload ↻ icon on the extension in `chrome://extensions`, then refresh Reddit.

## How it works
- The emoji is attached through Reddit's own image upload, the same as pasting an image. If the paste doesn't work, it falls back to drag-and-drop and then to the hidden file input.
- Images only post in communities that allow images or GIFs in comments. If a community doesn't allow them, you'll see a notice. For static emojis, the image is also copied to your clipboard.
- Works on new Reddit (www.reddit.com). Old Reddit doesn't support images in comments.
- The picker matches Reddit's light or dark theme. Use the search box to filter, or the All / Static / GIFs tabs. Recently used emojis appear at the top. Press Enter to pick the first result and Esc to close.
