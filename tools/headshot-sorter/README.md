# Headshot Select

A local headshot sorter for Lex Parker. Double-click **Start Headshot Sorter.cmd** to open it, or run:

```powershell
node tools/headshot-sorter/server.mjs --open
```

The app runs at http://127.0.0.1:4317 and uses the existing Node.js and Sharp installation in this repository. It reads `C:\Users\User\Downloads\headshots` recursively and moves rated originals into the five folders under `C:\Users\User\Desktop\headshots`.

| Key | Action |
| --- | --- |
| 1 | Hate |
| 2 | Eh |
| 3 | Mid |
| 4 | Like enough to edit |
| 5 | Perfect |
| Z or Ctrl+Z | Undo the last rating, including after restarting |
| Space or S | Skip without moving |
| O | Inspect the original |

Use **Zoom**, **X**, and **Y**, or drag any preview, to adjust the shared square crop in real time. **Flip** mirrors the crop horizontally in every preview and in the exported crop; **Reset** clears the crop and flip. Alt+scroll over a photo also zooms. All placements use the exact same crop. Check **Save crop too** before rating to save a cropped JPEG beside the untouched original. Without the checkbox, rating moves only the original. The checkbox preference persists; the crop resets for each new image. Undo restores the original to its batch and removes the companion crop.

Filenames include their source batch, e.g. `colour--LEX001.JPG` and `colour--LEX001--crop.jpg`. Existing files are never overwritten. Original files are copied byte for byte, verified with SHA-256, then removed from the unsorted folder. Crop exports keep the selected source resolution and use JPEG quality 96. Local undo history is stored in the ignored `.local` folder.

The four mockups use one common CSS-pixel scale, selectable with **View**. **Fit all** fits all four horizontally. **100%** shows their native sizes with horizontal scrolling. Comedy.co.nz placements are based on the referenced pages: 124 px banner, 170 px profile, 42 px calendar row, and 70 px expanded lineup. The surrounding site layout is condensed to keep the comparison useful. Instagram uses a square feed post and circular profile image; engagement counts and the guide event are illustrative. Everything runs locally.

To use other folders, pass `--source`, `--destination`, `--state-dir`, and optionally `--port`. The destination root must exist. Tests use temporary images and folders:

```powershell
node --test tools/headshot-sorter/sorter.test.mjs
```

## Review folder 4

Open http://127.0.0.1:4317/review, or click **Review folder 4** in the sorter. The gallery includes every supported image directly in `4 - like enough to edit`, including original files and saved crop copies. Each image can be marked **Favorite**, **Bad**, or **Blank** independently. Filters show each group and its count.

Click a thumbnail for a full image preview. Use Left/Right to navigate, **F** for Favorite, **B** for Bad, and **U** or **0** to clear the mark. Marks save automatically in `.local/folder-4-review.json` and survive app restarts. No image is moved, edited, or deleted by marking it. Use **Refresh folder** to discover newly sorted photos.

Run `node tools/headshot-sorter/review.test.mjs` to check review persistence, file preservation, filters/counts, and protected HTTP endpoints.

### Crop and compare a saved photo

In a gallery photo's large preview, click **Crop & size previews**. You can also open `http://127.0.0.1:4317/?review=colour--LEX072.JPG` directly. This selects that exact file in folder 4 and previews its live crop in the existing Instagram/comedy mockups and at 32, 48, 70, 124, 170, and 320 CSS pixels, with square/circle checks. Zoom, drag, X/Y and Flip update every preview together. **Save cropped copy** writes a new JPEG into folder 4; it preserves the selected image and its Favorite/Bad/Blank mark. Existing crops are never overwritten. Sorting shortcuts are disabled in this editing view.
