import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createReview } from './review.mjs';
import { createApp } from './server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'headshot-review-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'ratings');
  const folder = path.join(destination, '4 - like enough to edit');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(folder, { recursive: true });
  const original = await sharp({ create: { width: 600, height: 500, channels: 3, background: '#9fbd89' } }).jpeg().toBuffer();
  for (const name of ['colour--LEX001.JPG', 'colour--LEX001--crop.jpg', 'bluetone--LEX002.JPG']) await fs.writeFile(path.join(folder, name), original);
  await fs.writeFile(path.join(folder, 'notes.txt'), 'keep this too');
  await fs.mkdir(path.join(folder, 'not-a-photo.jpg'));
  const options = { destination, stateDir };
  return { ...options, folder, original, options, review: await createReview(options) };
}

test('gallery includes originals and cropped copies, all initially blank', async t => {
  const { review } = await fixture(t);
  const state = await review.list();
  assert.deepEqual(state.counts, { all: 3, favorite: 0, bad: 0, blank: 3 });
  assert.equal(state.photos.filter(p => p.kind === 'crop').length, 1);
  assert.equal(state.photos.filter(p => p.kind === 'original').length, 2);
  assert.equal(new Set(state.photos.map(p => p.id)).size, 3);
  assert.ok(state.photos.every(p => p.thumbnail.includes('thumb=1')));
});

test('Favorite, Bad, and Blank persist independently per image without modifying any photo', async t => {
  const { review, options, folder, original } = await fixture(t);
  const beforeNames = await fs.readdir(folder);
  const state = await review.list();
  const photo = state.photos.find(p => p.name === 'colour--LEX001.JPG');
  const crop = state.photos.find(p => p.kind === 'crop');
  await review.mark(photo.id, 'favorite');
  await review.mark(crop.id, 'bad');
  const reopened = await createReview(options);
  let saved = await reopened.list();
  assert.equal(saved.photos.find(p => p.id === photo.id).status, 'favorite');
  assert.equal(saved.photos.find(p => p.id === crop.id).status, 'bad');
  assert.deepEqual(saved.counts, { all: 3, favorite: 1, bad: 1, blank: 1 });
  await reopened.mark(photo.id, 'bad');
  saved = await reopened.mark(crop.id, 'blank');
  assert.deepEqual(saved.counts, { all: 3, favorite: 0, bad: 1, blank: 2 });
  saved = await (await createReview(options)).list();
  assert.equal(saved.photos.find(p => p.id === crop.id).status, 'blank');
  assert.deepEqual(await fs.readdir(folder), beforeNames);
  for (const p of saved.photos) assert.deepEqual(await fs.readFile(path.join(folder, p.name)), original);
});

test('serialized saves retain multiple marks and reject unknown images or invalid states', async t => {
  const { review } = await fixture(t);
  const state = await review.list();
  await Promise.all(state.photos.map(p => review.mark(p.id, 'favorite')));
  assert.equal((await review.list()).counts.favorite, 3);
  await assert.rejects(review.mark('../outside.jpg', 'bad'));
  await assert.rejects(review.image('../outside.jpg'));
  await assert.rejects(review.mark(state.photos[0].id, 'delete'));
  assert.equal((await review.list()).counts.favorite, 3);
  await review.mark(state.photos[0].id, 'blank');
  assert.equal((await review.list()).counts.blank, 1, 'A rejected save must not block later saves');
});

test('refresh discovers new photos, drops removed photos from counts, and missing folder is empty', async t => {
  const { review, folder, original, destination, stateDir } = await fixture(t);
  const first = (await review.list()).photos[0];
  await review.mark(first.id, 'favorite');
  await fs.unlink(path.join(folder, first.name));
  await fs.writeFile(path.join(folder, 'new.JPG'), original);
  const next = await review.list();
  assert.deepEqual(next.counts, { all: 3, favorite: 0, bad: 0, blank: 3 });
  assert.ok(next.photos.some(p => p.name === 'new.JPG'));
  const otherDestination = path.join(destination, 'other');
  await fs.mkdir(otherDestination);
  assert.equal((await (await createReview({ destination: otherDestination, stateDir })).list()).counts.all, 0);
});

test('saved review crops preserve originals and marks, and never overwrite previous crops', async t => {
  const { review, folder, original } = await fixture(t);
  const photo = (await review.list()).photos.find(photo => photo.name === 'colour--LEX001.JPG');
  await review.mark(photo.id, 'favorite');
  const existingCrop = await fs.readFile(path.join(folder, 'colour--LEX001--crop.jpg'));
  const result = await review.saveCrop(photo.id, { zoom: 2, x: .8, y: .2, flip: true });
  assert.equal(result.saved.name, 'colour--LEX001 (2)--crop.jpg');
  assert.equal(result.saved.width, 250);
  assert.equal(result.saved.height, 250);
  assert.deepEqual(await fs.readFile(path.join(folder, photo.name)), original);
  assert.deepEqual(await fs.readFile(path.join(folder, 'colour--LEX001--crop.jpg')), existingCrop);
  const metadata = await sharp(path.join(folder, result.saved.name)).metadata();
  assert.equal(metadata.width, 250);
  assert.equal(metadata.height, 250);
  assert.equal(result.photos.find(p => p.id === photo.id).status, 'favorite');
  assert.equal(result.photos.find(p => p.name === result.saved.name).status, 'blank');
  await assert.rejects(review.saveCrop(photo.id, { zoom: 0, x: .5, y: .5 }));
  await assert.rejects(review.saveCrop('../outside.jpg', { zoom: 2, x: .5, y: .5 }));
  const second = await review.saveCrop(photo.id, { zoom: 1, x: .5, y: .5 });
  assert.equal(second.saved.name, 'colour--LEX001 (3)--crop.jpg');
});

test('review HTTP routes serve thumbnails and require origin/token for saved marks', async t => {
  const { review } = await fixture(t);
  const app = createApp({}, review);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const url = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(`${url}/review`)).status, 200);
  const state = await fetch(`${url}/api/review`).then(r => r.json());
  const thumbnailResponse = await fetch(`${url}${state.photos[0].thumbnail}`);
  assert.equal(thumbnailResponse.headers.get('content-type'), 'image/jpeg');
  const thumbnail = await sharp(Buffer.from(await thumbnailResponse.arrayBuffer())).metadata();
  assert.equal(thumbnail.width, 420);
  assert.equal(thumbnail.height, 350);
  const body = JSON.stringify({ id: state.photos[0].id, status: 'favorite' });
  const rejected = await fetch(`${url}/api/review/mark`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(rejected.status, 403);
  const accepted = await fetch(`${url}/api/review/mark`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'X-Sorter-Token': state.token }, body });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).counts.favorite, 1);
  const cropResponse = await fetch(`${url}/api/review/crop`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'X-Sorter-Token': state.token }, body: JSON.stringify({ id: state.photos[0].id, crop: { zoom: 2, x: .5, y: .5, flip: true } }) });
  assert.equal(cropResponse.status, 200);
  assert.equal((await cropResponse.json()).saved.width, 250);
});
