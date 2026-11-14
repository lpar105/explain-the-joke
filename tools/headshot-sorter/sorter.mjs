import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import sharp from 'sharp';

export const RATINGS = [
  { key: 1, label: 'Hate', folder: '1 - hate' },
  { key: 2, label: 'Eh', folder: '2 - eh' },
  { key: 3, label: 'Mid', folder: '3 - mid' },
  { key: 4, label: 'Like enough to edit', folder: '4 - like enough to edit' },
  { key: 5, label: 'Perfect', folder: '5 - perfect' },
];
const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);
const idFor = (relative) => createHash('sha256').update(relative).digest('hex').slice(0, 24);
const exists = async (file) => fs.access(file).then(() => true, () => false);
const digest = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

export function cropRegion(width, height, crop) {
  if (!crop || !Number.isFinite(crop.zoom) || crop.zoom < 1 || crop.zoom > 4 ||
    !Number.isFinite(crop.x) || crop.x < 0 || crop.x > 1 ||
    !Number.isFinite(crop.y) || crop.y < 0 || crop.y > 1 ||
    (crop.flip !== undefined && typeof crop.flip !== 'boolean')) throw new Error('Invalid crop settings.');
  const side = Math.max(1, Math.floor(Math.min(width, height) / crop.zoom));
  return { left: Math.round((width - side) * crop.x), top: Math.round((height - side) * crop.y), width: side, height: side };
}

export async function createSorter({ source, destination, stateDir }) {
  source = await fs.realpath(source);
  destination = await fs.realpath(destination);
  if (source === destination || inside(source, destination) || inside(destination, source)) {
    throw new Error('Source and destination must be separate folders.');
  }
  await fs.mkdir(stateDir, { recursive: true });
  const journal = path.join(stateDir, 'history.jsonl');
  let files = new Map();
  let history = [];
  let busy = false;

  async function exclusive(action) {
    if (busy) throw new Error('A file operation is already in progress.');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function checkedFile(root, relative) {
    if (typeof relative !== 'string') throw new Error('Invalid file.');
    const file = path.resolve(root, relative);
    if (!inside(root, file)) throw new Error('Invalid file path.');
    const resolved = await fs.realpath(file);
    if (!inside(root, resolved) || resolved !== file) throw new Error('Linked files are not supported.');
    if (!(await fs.stat(file)).isFile()) throw new Error('The selected image is not a file.');
    return file;
  }
  async function ratingFolder(key) {
    const rating = RATINGS.find(r => r.key === key);
    if (!rating) throw new Error('Choose a rating from 1 to 5.');
    const folder = path.join(destination, rating.folder);
    await fs.mkdir(folder, { recursive: true });
    if (await fs.realpath(folder) !== folder) throw new Error('Linked rating folders are not supported.');
    return { rating, folder };
  }
  async function scan() {
    const found = new Map();
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
          const relative = path.relative(source, full);
          const id = idFor(relative);
          found.set(id, { id, name: entry.name, relative, batch: path.dirname(relative) === '.' ? 'Headshots' : path.dirname(relative) });
        }
      }
    }
    await walk(source);
    files = found;
  }
  async function append(event) {
    // Flush the recovery record before removing either original or sorted file.
    const handle = await fs.open(journal, 'a');
    try { await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync(); }
    finally { await handle.close(); }
  }
  async function restoreHistory() {
    const events = (await fs.readFile(journal, 'utf8').catch(e => {
      if (e.code === 'ENOENT') return '';
      throw e;
    })).split('\n').filter(Boolean);
    const pending = new Map();
    for (const line of events) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'move') pending.set(event.operation, event);
      else if (event.type === 'undo') pending.delete(event.operation);
    }
    for (const event of pending.values()) {
      if (event.sourceRoot !== source || event.destinationRoot !== destination) continue;
      const original = path.resolve(source, event.relative);
      const sorted = path.resolve(destination, event.sorted);
      if (inside(source, original) && inside(destination, sorted) && !await exists(original) && await exists(sorted)) {
        history.push(event);
      }
    }
  }
  await scan();
  await restoreHistory();

  function publicFile(file) {
    if (!file) return null;
    return { ...file, url: `/api/image/${file.id}` };
  }
  function choose(exclude) {
    const candidates = [...files.values()].filter(f => f.id !== exclude);
    const pool = candidates.length ? candidates : [...files.values()];
    return publicFile(pool.length ? pool[randomInt(pool.length)] : null);
  }
  async function state({ exclude, preferred } = {}) {
    const counts = await Promise.all(RATINGS.map(async rating => {
      const dir = path.join(destination, rating.folder);
      // Crops are companion files, and should not inflate photo counts.
      const names = await fs.readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      return { ...rating, count: names.filter(n => extensions.has(path.extname(n).toLowerCase()) && !/--crop\.jpg$/i.test(n)).length };
    }));
    return {
      source, destination, remaining: files.size, sorted: counts.reduce((sum, r) => sum + r.count, 0), ratings: counts,
      current: preferred && files.has(preferred) ? publicFile(files.get(preferred)) : choose(exclude),
      canUndo: history.length > 0,
      lastMove: history.length ? { name: history.at(-1).name, rating: history.at(-1).rating } : null,
    };
  }
  async function copyVerified(from, to) {
    await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    try {
      if (await digest(from) !== await digest(to)) throw new Error('Copy verification failed. The original was kept.');
      const stat = await fs.stat(from);
      await fs.utimes(to, stat.atime, stat.mtime);
    } catch (error) { await fs.unlink(to).catch(() => {}); throw error; }
  }

  return {
    state,
    refresh: () => exclusive(async () => { await scan(); return state(); }),
    image: async id => {
      const file = files.get(id);
      if (!file) throw new Error('This photo is no longer unsorted.');
      return checkedFile(source, file.relative);
    },
    rate: (id, key, crop) => exclusive(async () => {
      const file = files.get(id);
      if (!file) throw new Error('This photo has already been sorted. Refresh to continue.');
      const from = await checkedFile(source, file.relative);
      const { rating, folder } = await ratingFolder(key);
      const stem = file.relative.split(path.sep).join('--').replace(/\.[^.]+$/, '');
      const extension = path.extname(file.name);
      let to, cropped, suffix = 0;
      do {
        const basename = `${stem}${suffix ? ` (${suffix})` : ''}`;
        to = path.join(folder, `${basename}${extension}`);
        cropped = path.join(folder, `${basename}--crop.jpg`);
        suffix++;
      } while (await exists(to) || await exists(cropped));
      let croppedBytes;
      if (crop) {
        const oriented = await sharp(from).rotate().toBuffer({ resolveWithObject: true });
        const region = cropRegion(oriented.info.width, oriented.info.height, crop);
        // Extract first, then mirror the selected region exactly as in the previews.
        const croppedImage = sharp(oriented.data).extract(region);
        if (crop.flip) croppedImage.flop();
        croppedBytes = await croppedImage.jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
      }
      let copied = false;
      let wroteCrop = false;
      const operation = {
        type: 'move', operation: randomUUID(), time: new Date().toISOString(), sourceRoot: source, destinationRoot: destination,
        id, name: file.name, relative: file.relative, sorted: path.relative(destination, to),
        crop: croppedBytes ? path.relative(destination, cropped) : null, rating: rating.key,
      };
      try {
        await copyVerified(from, to);
        copied = true;
        if (croppedBytes) { await fs.writeFile(cropped, croppedBytes, { flag: 'wx' }); wroteCrop = true; }
        await append(operation);
        await fs.unlink(from);
      } catch (error) {
        if (await exists(from)) {
          if (wroteCrop) await fs.unlink(cropped).catch(() => {});
          if (copied) await fs.unlink(to).catch(() => {});
        }
        throw error;
      }
      history.push(operation);
      files.delete(id);
      return { ...await state(), moved: { name: path.basename(to), folder: rating.folder, crop: operation.crop ? path.basename(cropped) : null } };
    }),
    undo: () => exclusive(async () => {
      const operation = history.at(-1);
      if (!operation) throw new Error('There is no move to undo.');
      const from = await checkedFile(destination, operation.sorted);
      const to = path.resolve(source, operation.relative);
      if (!inside(source, to)) throw new Error('Invalid restore path.');
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (await fs.realpath(path.dirname(to)) !== path.dirname(to)) throw new Error('Cannot restore to a linked folder.');
      if (await exists(to)) throw new Error('The original location is occupied. No files were changed.');
      // Undo is journaled before removing the sorted copy. A crash can leave a harmless duplicate.
      await copyVerified(from, to);
      try { await append({ type: 'undo', operation: operation.operation, time: new Date().toISOString() }); }
      catch (error) { await fs.unlink(to); throw error; }
      await fs.unlink(from);
      if (operation.crop) {
        const cropFile = await checkedFile(destination, operation.crop).catch(() => null);
        if (cropFile) await fs.unlink(cropFile);
      }
      history.pop();
      await scan();
      return { ...await state({ preferred: operation.id }), restored: operation.name };
    }),
  };
}
