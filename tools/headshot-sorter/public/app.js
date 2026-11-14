const $ = (selector) => document.querySelector(selector);
const reviewName = new URLSearchParams(location.search).get('review');
const reviewMode = reviewName !== null;
const images = [...document.querySelectorAll('.crop-photo img')];
const photoAreas = [...document.querySelectorAll('.crop-photo')];
let session;
let token;
let current;
let natural = { width: 1200, height: 1200 };
let crop = { zoom: 1, x: 0.5, y: 0.5, flip: false };
let busy = false;
let ready = false;
let loadVersion = 0;
let toastTimeout;
let drag;

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function showError(error) {
  $('#error span').textContent = error.message || String(error);
  $('#error').hidden = false;
}
function updateControls() {
  document.body.classList.toggle('busy', busy);
  document.body.classList.toggle('loading', !ready && Boolean(current));
  document.querySelectorAll('.rating-button').forEach(b => { b.disabled = busy || !ready || !current; });
  $('#skip-button').disabled = busy || !current;
  $('#undo-button').disabled = busy || !session?.canUndo;
  $('#empty-undo').disabled = busy || !session?.canUndo;
  $('#original-button').disabled = busy || !ready || !current;
  $('#refresh-button').disabled = busy;
  $('#save-review-crop').disabled = busy || !ready || !current;
  for (const id of ['crop-zoom', 'crop-x', 'crop-y', 'flip-crop', 'reset-crop', 'save-crop']) $( `#${id}`).disabled = busy || !current;
}
async function request(route, body) {
  const result = await fetch(`/api/${route}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sorter-Token': token }, body: JSON.stringify(body),
  });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
function cropBox() {
  const size = Math.max(1, Math.floor(Math.min(natural.width, natural.height) / crop.zoom));
  return { size, left: Math.round((natural.width - size) * crop.x), top: Math.round((natural.height - size) * crop.y) };
}
function drawCrop() {
  const { size, left, top } = cropBox();
  const style = document.documentElement.style;
  style.setProperty('--crop-width', `${natural.width / size * 100}%`);
  style.setProperty('--crop-height', `${natural.height / size * 100}%`);
  style.setProperty('--crop-left', `${-left / size * 100}%`);
  style.setProperty('--crop-top', `${-top / size * 100}%`);
  style.setProperty('--crop-flip', crop.flip ? '-1' : '1');
  $('#flip-crop').setAttribute('aria-pressed', String(crop.flip));
  $('#crop-zoom').value = crop.zoom;
  $('#crop-x').value = crop.x * 100;
  $('#crop-y').value = crop.y * 100;
  $('#zoom-value').textContent = `${crop.zoom.toFixed(2)}×`;
  $('#crop-message').textContent = reviewMode
    ? `Save a ${size} × ${size}${crop.flip ? ' flipped' : ''} cropped JPEG beside this photo. The original stays unchanged.`
    : $('#save-crop').checked
    ? `Rating saves the original + a ${size} × ${size}${crop.flip ? ' flipped' : ''} cropped JPEG in the same folder.`
    : 'Preview crop only. Check “Save crop too” to keep a cropped JPEG alongside the original.';
}
function fitBoard() {
  const viewport = $('#comparison-viewport');
  const board = $('#comparison-board');
  if (board.hidden) return;
  const padding = parseFloat(getComputedStyle(viewport).paddingLeft) * 2;
  const selection = $('#view-scale').value;
  const available = viewport.clientWidth - padding;
  const fit = Math.min(1, available / board.scrollWidth);
  const scale = selection === 'fit' ? fit : Number(selection);
  // CSS zoom scales layout as well as paint, so Fit all has no phantom scrollbar.
  board.style.zoom = scale;
  viewport.style.height = `${Math.ceil(board.offsetHeight * scale + padding)}px`;
  $('#scale-readout').textContent = `${Math.round(scale * 100)}%`;
}
function renderRatings() {
  if (!$('#rating-buttons').children.length) {
    for (const rating of session.ratings) {
      const button = document.createElement('button');
      button.className = 'rating-button';
      button.dataset.rating = rating.key;
      button.innerHTML = `<span class="rating-key">${rating.key}</span><span class="rating-text"><span>${rating.label}</span><small><span class="folder-count">0</span> photos</small></span>`;
      button.setAttribute('aria-label', `${rating.key} — ${rating.label}`);
      button.title = `Move to ${rating.folder}`;
      button.addEventListener('click', () => rate(rating.key));
      $('#rating-buttons').append(button);
    }
  }
  session.ratings.forEach(r => { $(`[data-rating="${r.key}"] .folder-count`).textContent = r.count; });
}
async function render(data) {
  session = data;
  token = data.token || token;
  current = data.current;
  ready = false;
  const version = ++loadVersion;
  $('#remaining-count').textContent = data.remaining;
  $('#sorted-count').textContent = data.sorted;
  $('#total-count').textContent = data.remaining + data.sorted;
  $('#progress-fill').style.width = `${data.sorted / Math.max(1, data.remaining + data.sorted) * 100}%`;
  $('#source-path').textContent = data.source;
  $('#destination-path').textContent = data.destination;
  $('#filename').textContent = current?.name || 'Queue complete';
  $('#batch').textContent = current?.batch || '';
  $('#dimensions').textContent = '';
  $('#comparison-board').hidden = !current;
  $('#empty-state').hidden = Boolean(current);
  $('#comparison-viewport').style.height = current ? '' : '300px';
  $('#error').hidden = true;
  renderRatings();
  crop = { zoom: 1, x: 0.5, y: 0.5, flip: false };
  // The save preference persists, while each new headshot starts with an uncropped preview.
  drawCrop();
  updateControls();
  fitBoard();
  if (!current) return;
  const photo = new Image();
  photo.src = current.url;
  try { await photo.decode(); }
  catch { if (version === loadVersion) showError(new Error('This image could not be previewed. Skip it or refresh the queue.')); return; }
  if (version !== loadVersion) return;
  natural = { width: photo.naturalWidth, height: photo.naturalHeight };
  images.forEach(image => { image.src = current.url; });
  $('#original-image').src = current.url;
  $('#original-title').textContent = `${current.batch} / ${current.name}`;
  $('#dimensions').textContent = `${natural.width} × ${natural.height}`;
  drawCrop();
  ready = true;
  updateControls();
}
async function operation(action) {
  if (busy) return;
  busy = true;
  updateControls();
  try { await action(); }
  catch (error) { showError(error); }
  finally { busy = false; updateControls(); }
}
function rate(rating) {
  if (reviewMode || !ready || !current) return;
  const selectedCrop = $('#save-crop').checked ? { ...crop } : null;
  return operation(async () => {
    const result = await request('rate', { id: current.id, rating, crop: selectedCrop });
    await render(result);
    notify(`Moved to ${result.moved.folder}${result.moved.crop ? ' · original + cropped JPEG' : ''}. Press Z to undo.`);
  });
}
function undo() {
  if (reviewMode || !session?.canUndo) return;
  return operation(async () => { const result = await request('undo', {}); await render(result); notify(`Restored ${result.restored} to the unsorted queue.`); });
}
function skip() {
  if (reviewMode || !current) return;
  return operation(async () => { await render(await request('skip', { id: current.id })); notify('Skipped. This photo stays in the unsorted queue.'); });
}
function resetCrop() { crop = { zoom: 1, x: 0.5, y: 0.5, flip: false }; drawCrop(); }
$('#crop-zoom').addEventListener('input', event => { crop.zoom = Number(event.target.value); drawCrop(); });
$('#crop-x').addEventListener('input', event => { crop.x = Number(event.target.value) / 100; drawCrop(); });
$('#crop-y').addEventListener('input', event => { crop.y = Number(event.target.value) / 100; drawCrop(); });
$('#save-crop').checked = localStorage.getItem('headshot-save-crop') === 'true';
$('#save-crop').addEventListener('change', () => { localStorage.setItem('headshot-save-crop', $('#save-crop').checked); drawCrop(); });
$('#reset-crop').addEventListener('click', resetCrop);
$('#flip-crop').addEventListener('click', () => { crop.flip = !crop.flip; drawCrop(); });
$('#undo-button').addEventListener('click', undo);
$('#empty-undo').addEventListener('click', undo);
$('#skip-button').addEventListener('click', skip);
$('#refresh-button').addEventListener('click', () => operation(async () => {
  if (reviewMode) await loadReviewEditor();
  else { await render(await request('refresh', {})); notify('Queue refreshed.'); }
}));
$('#save-review-crop').addEventListener('click', () => operation(async () => {
  if (!reviewMode || !ready || !current) return;
  const result = await request('review/crop', { id: current.id, crop: { ...crop } });
  $('#saved-review-crop').textContent = `Saved ${result.saved.name} · ${result.saved.width} × ${result.saved.height}`;
  notify(`Saved ${result.saved.name}. Your original is unchanged.`);
}));
$('#size-shape').addEventListener('change', event => $('#review-size-previews').classList.toggle('size-circle', event.target.value === 'circle'));
$('#dismiss-error').addEventListener('click', () => { $('#error').hidden = true; });
$('#original-button').addEventListener('click', () => $('#original-dialog').showModal());
$('#close-original').addEventListener('click', () => $('#original-dialog').close());
$('#view-scale').addEventListener('change', fitBoard);
new ResizeObserver(fitBoard).observe($('#comparison-viewport'));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
photoAreas.forEach(area => {
  area.addEventListener('pointerdown', event => {
    if (!ready || busy || event.button !== 0) return;
    event.preventDefault();
    area.setPointerCapture(event.pointerId);
    drag = { area, startX: event.clientX, startY: event.clientY, crop: { ...crop }, bounds: area.getBoundingClientRect() };
  });
  area.addEventListener('pointermove', event => {
    if (!drag || drag.area !== area) return;
    const { size } = cropBox();
    const dx = (event.clientX - drag.startX) / drag.bounds.width * size;
    const dy = (event.clientY - drag.startY) / drag.bounds.height * size;
    crop.x = natural.width === size ? 0.5 : clamp(drag.crop.x - dx / (natural.width - size) * (crop.flip ? -1 : 1), 0, 1);
    crop.y = natural.height === size ? 0.5 : clamp(drag.crop.y - dy / (natural.height - size), 0, 1);
    drawCrop();
  });
  area.addEventListener('pointerup', () => { drag = null; });
  area.addEventListener('pointercancel', () => { drag = null; });
  area.addEventListener('wheel', event => {
    if (!ready || busy || !event.altKey) return;
    event.preventDefault();
    crop.zoom = clamp(crop.zoom - event.deltaY * 0.002, 1, 4);
    drawCrop();
  }, { passive: false });
});
document.addEventListener('keydown', event => {
  if (event.repeat || busy || event.altKey || $('#original-dialog').open) return;
  if (event.target.closest('select, textarea, input:not([type="range"]):not([type="checkbox"]), [contenteditable="true"]')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() !== 'z') return;
  if (/^[1-5]$/.test(event.key)) { event.preventDefault(); rate(Number(event.key)); }
  else if (event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
  else if (event.code === 'Space' || event.key.toLowerCase() === 's') {
    if (event.code === 'Space' && event.target.closest('button, input')) return;
    event.preventDefault(); skip();
  }
  else if (event.key.toLowerCase() === 'o' && ready) { event.preventDefault(); $('#original-dialog').showModal(); }
  else if (event.key === 'Escape') { resetCrop(); }
});
async function loadReviewEditor() {
  const review = await request('review');
  const photo = review.photos.find(photo => photo.name === reviewName);
  if (!photo) throw new Error(`Could not find ${reviewName} in folder 4. Open the gallery and choose a photo.`);
  await render({ token: review.token, current: { ...photo, batch: 'Folder 4' }, remaining: review.photos.length,
    sorted: 0, source: review.folder, destination: review.folder, ratings: [], canUndo: false });
}
if (reviewMode) {
  $('.rating-section').hidden = true;
  $('.progress-wrap').hidden = true;
  $('.queue-info').hidden = true;
  $('.save-crop').hidden = true;
  $('#review-editor-actions').hidden = false;
  $('#review-size-previews').hidden = false;
  $('.workspace-heading .eyebrow').textContent = 'FOLDER 4 / CROP & SIZE PREVIEWS';
  $('h1').textContent = 'Crop & compare.';
  $('#refresh-button').textContent = '↻ Reload photo';
  loadReviewEditor().catch(showError);
} else request('state').then(render).catch(showError);
