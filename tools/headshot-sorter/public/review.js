const $ = selector => document.querySelector(selector);
const statuses = { favorite: { label: 'Favorite', symbol: '♡' }, bad: { label: 'Bad', symbol: '×' }, blank: { label: 'Blank', symbol: '○' } };
let data;
let token;
let filter = 'all';
let pending = false;
let viewerId;
let viewerList = [];
let imageVersion = 0;
const cards = new Map();

function errorMessage(error) { $('#review-error span').textContent = error.message; $('#review-error').hidden = false; }
async function request(route = 'review', body) {
  const response = await fetch(`/api/${route}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sorter-Token': token }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save this mark. Try again.');
  return result;
}
function visiblePhotos() { return data.photos.filter(photo => filter === 'all' || photo.status === filter); }
function makeCard(photo) {
  const card = document.createElement('article');
  card.className = 'photo-card';
  card.dataset.id = photo.id;
  const preview = document.createElement('button');
  preview.className = 'card-preview';
  preview.setAttribute('aria-label', `Preview ${photo.name}`);
  preview.addEventListener('click', () => openViewer(photo.id));
  const image = document.createElement('img');
  image.src = photo.thumbnail;
  image.alt = photo.name;
  image.loading = 'lazy';
  image.decoding = 'async';
  const badge = document.createElement('span');
  badge.className = 'card-status';
  preview.append(image, badge);
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const name = document.createElement('b');
  name.className = 'card-name';
  name.textContent = photo.name;
  const kind = document.createElement('span');
  kind.className = 'file-kind';
  kind.dataset.kind = photo.kind;
  kind.textContent = photo.kind === 'crop' ? 'Saved crop' : 'Original';
  meta.append(name, kind);
  const marks = document.createElement('div');
  marks.className = 'card-marks';
  marks.setAttribute('role', 'group');
  marks.setAttribute('aria-label', `Mark ${photo.name}`);
  for (const [status, info] of Object.entries(statuses)) {
    const button = document.createElement('button');
    button.dataset.mark = status;
    button.textContent = `${info.symbol} ${info.label}`;
    button.setAttribute('aria-label', `${info.label}: ${photo.name}`);
    button.addEventListener('click', () => mark(photo.id, status));
    marks.append(button);
  }
  card.append(preview, meta, marks);
  return card;
}
function render(next) {
  data = next;
  token = next.token || token;
  $('#review-total').textContent = data.counts.all;
  $('#review-folder').textContent = data.folder;
  document.querySelectorAll('[data-filter]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    button.querySelector('span').textContent = data.counts[button.dataset.filter];
  });
  const knownIds = new Set(data.photos.map(photo => photo.id));
  for (const [id, card] of cards) if (!knownIds.has(id)) { card.remove(); cards.delete(id); }
  for (const photo of data.photos) {
    let card = cards.get(photo.id);
    if (!card) { card = makeCard(photo); cards.set(photo.id, card); $('#gallery').append(card); }
    card.hidden = filter !== 'all' && photo.status !== filter;
    card.dataset.status = photo.status;
    card.querySelector('.card-status').textContent = `${statuses[photo.status].symbol} ${statuses[photo.status].label}`;
    const image = card.querySelector('img');
    if (image.getAttribute('src') !== photo.thumbnail) image.src = photo.thumbnail;
    card.querySelectorAll('[data-mark]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.mark === photo.status));
      button.disabled = pending;
    });
  }
  $('#gallery-empty').hidden = visiblePhotos().length > 0;
  $('#gallery-empty h2').textContent = data.counts.all ? 'Nothing in this view yet.' : 'No photos here yet.';
  $('#empty-description').textContent = data.counts.all ? 'Try another filter, or mark a photo to add it here.' : 'Photos you sort into folder 4 will appear here.';
  $('#show-all').hidden = filter === 'all';
  if (viewerId && !knownIds.has(viewerId)) $('#review-viewer').close();
  if ($('#review-viewer').open) updateViewer();
}
async function mark(id, status) {
  if (pending) return;
  pending = true;
  $('#save-status').textContent = 'Saving…';
  document.querySelectorAll('[data-mark]').forEach(button => { button.disabled = true; });
  try {
    const next = await request('review/mark', { id, status });
    pending = false;
    render(next);
    $('#save-status').textContent = 'Saved · marks keep automatically';
    $('#review-error').hidden = true;
  } catch (error) { $('#save-status').textContent = 'Not saved — please try again'; errorMessage(error); }
  finally { pending = false; document.querySelectorAll('[data-mark]').forEach(button => { button.disabled = false; }); }
}
function openViewer(id) {
  viewerId = id;
  viewerList = visiblePhotos().map(photo => photo.id);
  updateViewer();
  $('#review-viewer').showModal();
}
function updateViewer() {
  const photo = data.photos.find(photo => photo.id === viewerId);
  if (!photo) return;
  const index = viewerList.indexOf(viewerId);
  $('#viewer-name').textContent = photo.name;
  $('#edit-review-photo').href = `/?review=${encodeURIComponent(photo.name)}`;
  $('#viewer-kind').textContent = photo.kind === 'crop' ? 'Saved crop' : 'Original';
  $('#viewer-kind').dataset.kind = photo.kind;
  $('#viewer-position').textContent = `${index + 1} / ${viewerList.length}`;
  $('#previous-photo').disabled = index <= 0;
  $('#next-photo').disabled = index >= viewerList.length - 1;
  $('#viewer-status').textContent = photo.status === 'blank' ? '○ Blank · no mark yet' : `${statuses[photo.status].symbol} ${statuses[photo.status].label}`;
  $('#viewer-status').dataset.status = photo.status;
  $('#viewer-marks').querySelectorAll('[data-mark]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.mark === photo.status)); button.disabled = pending; });
  if ($('#viewer-image').getAttribute('src') !== photo.url) {
    $('#viewer-image-loading').hidden = false;
    $('#viewer-image-loading').textContent = 'Loading full image…';
    $('#viewer-dimensions').textContent = '';
    const version = ++imageVersion;
    const image = new Image();
    image.src = photo.url;
    image.decode().then(() => {
      if (version !== imageVersion) return;
      $('#viewer-image').src = photo.url;
      $('#viewer-image').alt = photo.name;
      $('#viewer-dimensions').textContent = `${image.naturalWidth} × ${image.naturalHeight} · full image`;
      $('#viewer-image-loading').hidden = true;
    }).catch(() => {
      if (version !== imageVersion) return;
      $('#viewer-image-loading').textContent = 'Could not load this photo. Refresh the folder to try again.';
    });
  }
}
function navigate(direction) {
  const index = viewerList.indexOf(viewerId) + direction;
  if (index < 0 || index >= viewerList.length) return;
  viewerId = viewerList[index];
  updateViewer();
}
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { if (!data) return; filter = button.dataset.filter; render(data); }));
$('#show-all').addEventListener('click', () => { filter = 'all'; render(data); });
$('#reload-gallery').addEventListener('click', async () => {
  if (pending) return;
  $('#reload-gallery').disabled = true;
  try { render(await request()); $('#review-error').hidden = true; }
  catch (error) { errorMessage(error); }
  finally { $('#reload-gallery').disabled = false; }
});
$('#viewer-marks').querySelectorAll('[data-mark]').forEach(button => button.addEventListener('click', () => mark(viewerId, button.dataset.mark)));
$('#previous-photo').addEventListener('click', () => navigate(-1));
$('#next-photo').addEventListener('click', () => navigate(1));
$('#close-viewer').addEventListener('click', () => $('#review-viewer').close());
$('#review-viewer').addEventListener('close', () => { viewerId = undefined; });
$('#dismiss-review-error').addEventListener('click', () => { $('#review-error').hidden = true; });
$('#viewer-marks').before($('#edit-review-photo'));
$('#edit-review-photo').hidden = false;
$('#edit-review-photo').className = 'review-nav-link editor-link';
document.addEventListener('keydown', event => {
  if (!$('#review-viewer').open || event.repeat || event.ctrlKey || event.metaKey || event.altKey || pending) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
  const status = { f: 'favorite', b: 'bad', u: 'blank', '0': 'blank' }[event.key.toLowerCase()];
  if (status) { event.preventDefault(); mark(viewerId, status); }
});
request().then(render).catch(errorMessage);
