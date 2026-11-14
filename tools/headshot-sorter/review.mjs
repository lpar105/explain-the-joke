import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { cropRegion } from './sorter.mjs';

const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);
const validStatuses = new Set(['blank', 'favorite', 'bad']);

export async function createReview({ destination, stateDir }) {
  const destinationRoot = await fs.realpath(destination);
  const folder = path.join(destinationRoot, '4 - like enough to edit');
  await fs.mkdir(stateDir, { recursive: true });
  const marksFile = path.join(stateDir, 'folder-4-review.json');
  let document;
  try { document = JSON.parse(await fs.readFile(marksFile, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read folder 4 review marks: ${error.message}`);
    document = { version: 1, folders: {} };
  }
  if (document.version !== 1 || !document.folders || typeof document.folders !== 'object' || Array.isArray(document.folders)) {
    throw new Error('The saved folder 4 review file has an unsupported format.');
  }
  let files = new Map();
  let queue = Promise.resolve();

  async function scan() {
    let entries;
    try {
      if (await fs.realpath(folder) !== folder) throw new Error('Linked review folders are not supported.');
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
    const found = await Promise.all(entries.filter(entry => entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())).map(async entry => {
      const filename = path.join(folder, entry.name);
      const stat = await fs.stat(filename);
      const id = createHash('sha256').update(`${folder}\0${entry.name}`).digest('hex').slice(0, 24);
      return { id, name: entry.name, kind: /--crop\.jpg$/i.test(entry.name) ? 'crop' : 'original', modified: stat.mtimeMs };
    }));
    files = new Map(found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(file => [file.id, file]));
  }
  async function checkedImage(id) {
    const file = files.get(id);
    if (!file) throw new Error('This image is no longer in folder 4. Refresh the gallery.');
    const fullPath = path.join(folder, file.name);
    if (await fs.realpath(folder) !== folder || await fs.realpath(fullPath) !== fullPath || !(await fs.lstat(fullPath)).isFile()) {
      throw new Error('Linked images are not supported.');
    }
    return fullPath;
  }
  function snapshot() {
    const marks = document.folders[folder] || {};
    const counts = { all: files.size, favorite: 0, bad: 0, blank: 0 };
    const photos = [...files.values()].map(file => {
      const status = validStatuses.has(marks[file.name]) ? marks[file.name] : 'blank';
      counts[status]++;
      return { ...file, status, url: `/api/review/image/${file.id}?v=${file.modified}`, thumbnail: `/api/review/image/${file.id}?thumb=1&v=${file.modified}` };
    });
    return { folder, photos, counts };
  }
  await scan();
  return {
    list: async () => { await scan(); return snapshot(); },
    image: checkedImage,
    saveCrop: (id, crop) => {
      const work = queue.then(async () => {
        const from = await checkedImage(id);
        const source = files.get(id);
        const oriented = await sharp(from).rotate().raw().toBuffer({ resolveWithObject: true });
        const { width, height, channels } = oriented.info;
        const region = cropRegion(width, height, crop);
        const image = sharp(oriented.data, { raw: { width, height, channels } }).extract(region);
        if (crop.flip) image.flop();
        const bytes = await image.jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
        const stem = path.parse(source.name).name.replace(/--crop$/i, '');
        let name;
        for (let number = 1; ; number++) {
          name = `${stem}${number === 1 ? '' : ` (${number})`}--crop.jpg`;
          try { await fs.writeFile(path.join(folder, name), bytes, { flag: 'wx' }); break; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        await scan();
        return { ...snapshot(), saved: { name, width: region.width, height: region.height } };
      });
      queue = work.catch(() => {});
      return work;
    },
    mark: (id, status) => {
      const work = queue.then(async () => {
        if (!validStatuses.has(status)) throw new Error('Choose Favorite, Bad, or Blank.');
        await checkedImage(id);
        const file = files.get(id);
        const next = { ...document, folders: { ...document.folders, [folder]: { ...document.folders[folder] } } };
        if (status === 'blank') delete next.folders[folder][file.name];
        else next.folders[folder][file.name] = status;
        const temporary = `${marksFile}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
          await fs.rename(temporary, marksFile);
        } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
        document = next;
        return snapshot();
      });
      queue = work.catch(() => {});
      return work;
    },
  };
}
