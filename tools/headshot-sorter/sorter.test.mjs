import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createSorter, cropRegion, RATINGS } from './sorter.mjs';
import { createApp } from './server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'headshot-sorter-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'ratings');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(destination);
  const bytes = Buffer.alloc(120 * 120 * 3);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
    const index = (y * 120 + x) * 3;
    bytes[index] = x * 2;
    bytes[index + 1] = y * 2;
    bytes[index + 2] = 70;
  }
  const original = await sharp(bytes, { raw: { width: 120, height: 120, channels: 3 } }).jpeg({ quality: 98 }).toBuffer();
  for (const batch of ['bluetone', 'colour']) {
    await fs.mkdir(path.join(source, batch), { recursive: true });
    await fs.writeFile(path.join(source, batch, 'LEX001.JPG'), original);
  }
  await fs.writeFile(path.join(source, 'notes.txt'), 'not an image');
  const options = { source, destination, stateDir };
  return { ...options, original, sorter: await createSorter(options), options };
}

test('finds nested images and skip excludes the displayed photo', async t => {
  const { sorter } = await fixture(t);
  const state = await sorter.state();
  assert.equal(state.remaining, 2);
  assert.notEqual((await sorter.state({ exclude: state.current.id })).current.id, state.current.id);
  assert.equal((await sorter.state()).sorted, 0);
});

test('all five ratings move exact originals and Undo restores them', async t => {
  const { sorter, source, destination, original } = await fixture(t);
  for (const rating of RATINGS) {
    const state = await sorter.state();
    const selected = state.current;
    const result = await sorter.rate(selected.id, rating.key, null);
    const movedFile = path.join(destination, rating.folder, result.moved.name);
    assert.deepEqual(await fs.readFile(movedFile), original);
    await assert.rejects(fs.access(path.join(source, selected.relative)));
    assert.equal(result.remaining, 1);
    assert.equal(result.sorted, 1);
    await assert.rejects(sorter.rate(selected.id, rating.key, null), /already been sorted/);
    const undone = await sorter.undo();
    assert.equal(undone.current.id, selected.id);
    assert.deepEqual(await fs.readFile(path.join(source, selected.relative)), original);
    assert.equal(undone.remaining, 2);
    assert.equal(undone.sorted, 0);
    assert.equal(undone.canUndo, false);
  }
});

test('crop export matches requested pixels, preserves original, and Undo removes both output files', async t => {
  const { sorter, destination, original } = await fixture(t);
  const selected = (await sorter.state()).current;
  const crop = { zoom: 2, x: 0.8, y: 0.2 };
  const result = await sorter.rate(selected.id, 5, crop);
  const folder = path.join(destination, '5 - perfect');
  assert.equal((await fs.readdir(folder)).length, 2);
  assert.deepEqual(await fs.readFile(path.join(folder, result.moved.name)), original);
  const cropped = await fs.readFile(path.join(folder, result.moved.crop));
  const metadata = await sharp(cropped).metadata();
  assert.equal(metadata.width, 60);
  assert.equal(metadata.height, 60);
  const actual = await sharp(cropped).raw().toBuffer();
  const expected = await sharp(original).extract(cropRegion(120, 120, crop)).raw().toBuffer();
  const difference = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
  assert.ok(difference < 2, `Crop differs from expected region: ${difference}`);
  assert.equal(result.sorted, 1, 'Companion crop is not counted as a second headshot');
  await sorter.undo();
  assert.deepEqual(await fs.readdir(folder), []);
});

test('same names from different batches remain distinct and existing outputs are never overwritten', async t => {
  const { sorter, destination } = await fixture(t);
  await fs.mkdir(path.join(destination, '4 - like enough to edit'));
  const selected = (await sorter.state()).current;
  const existingName = `${selected.batch}--LEX001.JPG`;
  const existing = path.join(destination, '4 - like enough to edit', existingName);
  await fs.writeFile(existing, 'pre-existing photo');
  const a = await sorter.rate(selected.id, 4, { zoom: 1, x: .5, y: .5 });
  assert.notEqual(a.moved.name, existingName);
  assert.equal(await fs.readFile(existing, 'utf8'), 'pre-existing photo');
  const b = await sorter.rate(a.current.id, 4, null);
  assert.notEqual(a.moved.name, b.moved.name);
  assert.equal(b.remaining, 0);
  assert.equal(b.current, null);
});

test('horizontal flip mirrors the selected crop and leaves the original unchanged', async t => {
  const { sorter, destination, original } = await fixture(t);
  const selected = (await sorter.state()).current;
  const crop = { zoom: 2, x: .8, y: .2, flip: true };
  const result = await sorter.rate(selected.id, 4, crop);
  const folder = path.join(destination, '4 - like enough to edit');
  assert.deepEqual(await fs.readFile(path.join(folder, result.moved.name)), original);
  const actual = await sharp(path.join(folder, result.moved.crop)).raw().toBuffer();
  // Build the reference by reversing decoded pixel columns, independently of Sharp's flop ordering.
  const unflipped = await sharp(original).extract(cropRegion(120, 120, crop)).raw().toBuffer({ resolveWithObject: true });
  const expected = Buffer.alloc(unflipped.data.length);
  const { width, height, channels } = unflipped.info;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sourceIndex = (y * width + (width - 1 - x)) * channels;
    unflipped.data.copy(expected, (y * width + x) * channels, sourceIndex, sourceIndex + channels);
  }
  const difference = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
  assert.ok(difference < 2, `Flipped crop differs from expected pixels: ${difference}`);
  await sorter.undo();
  assert.deepEqual(await fs.readdir(folder), []);
});

test('Undo survives a server restart', async t => {
  const { sorter, options, original, source } = await fixture(t);
  const selected = (await sorter.state()).current;
  await sorter.rate(selected.id, 2, { zoom: 1.5, x: .25, y: .75 });
  const restarted = await createSorter(options);
  assert.equal((await restarted.state()).canUndo, true);
  const result = await restarted.undo();
  assert.equal(result.remaining, 2);
  assert.deepEqual(await fs.readFile(path.join(source, selected.relative)), original);
});

test('invalid requests never remove photos and occupied restore paths are preserved', async t => {
  const { sorter, source } = await fixture(t);
  const selected = (await sorter.state()).current;
  await assert.rejects(sorter.rate('../elsewhere', 1, null));
  await assert.rejects(sorter.image('../notes.txt'));
  await assert.rejects(sorter.rate(selected.id, 7, null));
  for (const crop of [{ zoom: 0, x: .5, y: .5 }, { zoom: 2, x: -1, y: .5 }, { zoom: 2, x: .5, y: 2 }, { zoom: 2, x: .5, y: .5, flip: 'yes' }]) {
    await assert.rejects(sorter.rate(selected.id, 1, crop), /Invalid crop/);
  }
  assert.equal((await sorter.state()).remaining, 2);
  await sorter.rate(selected.id, 3, null);
  await fs.writeFile(path.join(source, selected.relative), 'new original');
  await assert.rejects(sorter.undo(), /occupied/);
  assert.equal(await fs.readFile(path.join(source, selected.relative), 'utf8'), 'new original');
});

test('HTTP app serves previews and requires a same-origin token for file operations', async t => {
  const { sorter } = await fixture(t);
  const app = createApp(sorter);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = `http://127.0.0.1:${app.address().port}`;
  const state = await fetch(`${url}/api/state`).then(r => r.json());
  assert.ok(state.token);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Save crop too/);
  const image = await fetch(`${url}${state.current.url}`);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal(image.status, 200);
  const rejected = await fetch(`${url}/api/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other-site.example' }, body: JSON.stringify({ id: state.current.id, rating: 1 }) });
  assert.equal(rejected.status, 403);
  assert.equal((await sorter.state()).remaining, 2);
  const accepted = await fetch(`${url}/api/rate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'X-Sorter-Token': state.token }, body: JSON.stringify({ id: state.current.id, rating: 4, crop: { zoom: 2, x: .5, y: .5 } }) });
  assert.equal(accepted.status, 200);
  assert.ok((await accepted.json()).moved.crop);
});
