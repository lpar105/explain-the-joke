// Throwaway prototype for testing calibration gestures alongside inline text edits.
(() => {
  const dialog = $("edit-dialog");
  const strip = $("edit-timeline");
  const preview = $("edit-video");
  const positionInput = $("edit-seek");
  const markEnd = $("edit-mark-end");
  const feedback = $("edit-feedback");
  const windowLength = 20;
  const setLength = 120;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const rounded = value => Math.round(value * 100) / 100;
  const stamp = value => `${formatTime(rounded(value))}.${String(Math.round(value * 100) % 100).padStart(2, "0")}`;
  let draftLines;
  let draftLaughs;
  let nextId;
  let selected;
  let windowStart;
  let position;
  let mark;
  let drag;
  let simulating = false;
  let simulatedTime;
  let previousFrame;
  let frame;
  let scrollFrame;

  function openEditor() {
    playing = false;
    syncVideo();
    $("play").textContent = "Play";
    draftLines = view.hasLines ? structuredClone(lines) : [];
    draftLaughs = view.hasLaughs ? regions.map((region, id) => ({
      id, start: region.start, end: region.start + region.length, intensity: region.intensity,
    })) : [];
    nextId = draftLaughs.length;
    selected = null;
    mark = null;
    drag = null;
    windowStart = null;
    feedback.textContent = draftLines.length ? "" : "This Set has no transcript Lines to edit.";
    strip.setAttribute("aria-disabled", String(!draftLines.length));
    $("edit-mark-start").disabled = !draftLines.length;
    syncPreview();
    renderTranscript();
    dialog.showModal();
    seekEditor(time, true, true);
    updateMark();
    $("edit-play").focus();
  }

  function syncPreview() {
    preview.hidden = !objectUrl;
    $("edit-video-placeholder").hidden = Boolean(objectUrl);
    if (objectUrl && preview.src !== objectUrl) preview.src = objectUrl;
  }

  function renderTranscript() {
    const pane = $("edit-lines");
    pane.replaceChildren();
    pane.scrollTop = 0;
    if (!draftLines.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No spoken words found.";
      pane.append(empty);
    }
    for (const line of draftLines) {
      const row = document.createElement("div");
      row.className = "editor-line";
      row.dataset.line = line.index;
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "editor-time";
      jump.textContent = formatTime(line.start);
      jump.setAttribute("aria-label", `Jump to Line ${line.index + 1} at ${jump.textContent}`);
      jump.onclick = () => seekEditor(line.start, true, true);
      const words = document.createElement("textarea");
      words.rows = line.text.length > 115 ? 4 : 2;
      words.value = line.text;
      words.setAttribute("aria-label", `Line ${line.index + 1} at ${jump.textContent}`);
      words.oninput = () => { line.text = words.value; };
      row.append(jump, words);
      pane.append(row);
    }
  }

  function updatePlayhead(followLine = false) {
    const pane = $("edit-lines");
    const line = draftLines.findLast(item => item.start <= position);
    const row = line && pane.querySelector(`[data-line="${line.index}"]`);
    const previous = pane.querySelector("[data-current]");
    if (row !== previous) {
      previous?.removeAttribute("data-current");
      if (row) row.dataset.current = "true";
    }
    if (row && (row !== previous || followLine) && !pane.querySelector("textarea:focus")) {
      scrollToLine(pane, row);
    }
    positionInput.value = position;
    $("edit-position").value = stamp(position);
    $("edit-playhead").style.left = `${clamp(percentage(position), 0, 100)}%`;
    $("edit-playhead").hidden = position < windowStart || position > windowStart + windowLength;
    $("edit-laugh-seek").disabled = draftLaughs.length === 0;
  }

  function scrollToLine(pane, row) {
    cancelAnimationFrame(scrollFrame);
    const start = pane.scrollTop;
    const top = start + row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    const distance = clamp(top, 0, pane.scrollHeight - pane.clientHeight) - start;
    if (Math.abs(distance) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pane.scrollTop = start + distance;
      return;
    }
    const startedAt = performance.now();
    function animate(now) {
      const progress = Math.min(1, (now - startedAt) / 220);
      pane.scrollTop = start + distance * (1 - (1 - progress) ** 3);
      if (progress < 1) scrollFrame = requestAnimationFrame(animate);
    }
    scrollFrame = requestAnimationFrame(animate);
  }

  function updatePosition(seconds, followWindow, followLine = false) {
    position = rounded(clamp(seconds, 0, setLength));
    const nextWindow = Math.min(setLength - windowLength, Math.floor(position / windowLength) * windowLength);
    if (followWindow && nextWindow !== windowStart) setWindow(nextWindow);
    updatePlayhead(followLine);
  }

  function seekEditor(seconds, followWindow = true, followLine = false) {
    updatePosition(seconds, followWindow, followLine);
    simulatedTime = position;
    if (objectUrl && Number.isFinite(preview.duration)) preview.currentTime = position / setLength * preview.duration;
  }

  function tick(now) {
    if (!simulating) return;
    simulatedTime += (now - previousFrame) / 1000;
    updatePosition(simulatedTime, !drag);
    previousFrame = now;
    if (position >= setLength) stopPlayback();
    else frame = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    simulating = false;
    cancelAnimationFrame(frame);
    preview.pause();
    $("edit-play").textContent = "Play";
  }

  function togglePlayback() {
    if (simulating || !preview.paused) return stopPlayback();
    if (position >= setLength) seekEditor(0, true, true);
    if (objectUrl) {
      preview.play().catch(() => { feedback.textContent = "This footage couldn’t play."; });
    } else {
      simulating = true;
      simulatedTime = position;
      previousFrame = performance.now();
      $("edit-play").textContent = "Pause";
      frame = requestAnimationFrame(tick);
    }
  }

  function percentage(seconds) {
    return 100 * (seconds - windowStart) / windowLength;
  }

  function setWindow(start) {
    windowStart = clamp(start, 0, setLength - windowLength);
    $("edit-window").value = `${formatTime(windowStart)}–${formatTime(windowStart + windowLength)}`;
    $("edit-prev-window").disabled = windowStart === 0;
    $("edit-next-window").disabled = windowStart + windowLength === setLength;
    drawStrip();
  }

  function drawStrip() {
    strip.querySelectorAll(".editor-region, .editor-draft").forEach(node => node.remove());
    for (const [index, laugh] of draftLaughs.entries()) {
      if (laugh.end <= windowStart || laugh.start >= windowStart + windowLength) continue;
      const region = document.createElement("div");
      region.className = "editor-region";
      region.dataset.id = laugh.id;
      region.dataset.selected = String(laugh.id === selected);
      place(region, laugh.start, laugh.end);
      const trash = document.createElement("button");
      trash.type = "button";
      trash.className = "editor-trash";
      trash.setAttribute("aria-label", `Remove laugh ${index + 1} at ${stamp(laugh.start)}`);
      trash.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"/></svg>';
      trash.onclick = () => {
        draftLaughs = draftLaughs.filter(item => item.id !== laugh.id);
        selectLaugh(selected === laugh.id ? null : selected);
        feedback.textContent = "Laugh removed.";
        $("edit-mark-start").focus();
      };
      region.append(trash);
      for (const edge of ["start", "end"]) {
        if (laugh[edge] < windowStart || laugh[edge] > windowStart + windowLength) continue;
        const grip = document.createElement("button");
        grip.type = "button";
        grip.className = "editor-grip";
        grip.dataset.edge = edge;
        grip.setAttribute("aria-label", `Resize laugh ${index + 1} ${edge}`);
        grip.onkeydown = event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          selected = laugh.id;
          resizeLaugh(edge, laugh[edge] + (event.key === "ArrowLeft" ? -.05 : .05));
          strip.querySelector(`[data-id="${laugh.id}"] [data-edge="${edge}"]`)?.focus();
        };
        region.append(grip);
      }
      strip.append(region);
    }
    if (drag?.preview) {
      const highlight = document.createElement("div");
      highlight.className = "editor-draft";
      place(highlight, drag.preview.start, drag.preview.end);
      strip.append(highlight);
    }
  }

  function place(node, start, end) {
    const left = clamp(percentage(start), 0, 100);
    node.style.left = `${left}%`;
    node.style.width = `${clamp(percentage(end), 0, 100) - left}%`;
  }

  function selectLaugh(id) {
    selected = id;
    drawStrip();
    $("edit-laugh-seek").disabled = draftLaughs.length === 0;
  }

  function availableRange(origin, to) {
    if (draftLaughs.some(item => item.start < origin && origin < item.end)) return null;
    const previous = draftLaughs.findLast(item => item.end <= origin);
    const next = draftLaughs.find(item => item.start >= origin);
    const start = Math.max(Math.min(origin, to), previous?.end ?? 0);
    const end = Math.min(Math.max(origin, to), next?.start ?? setLength);
    return end - start >= .049 ? { start, end } : null;
  }

  function addLaugh(region) {
    if (!region) {
      feedback.textContent = "Choose a range outside the existing laughs.";
      return;
    }
    const id = nextId++;
    draftLaughs.push({ ...region, id, intensity: .5 });
    draftLaughs.sort((a, b) => a.start - b.start);
    selectLaugh(id);
    feedback.textContent = "Laugh added.";
  }

  function resizeLaugh(edge, desired) {
    const index = draftLaughs.findIndex(item => item.id === selected);
    const laugh = draftLaughs[index];
    const min = edge === "start" ? draftLaughs[index - 1]?.end ?? 0 : rounded(laugh.start + .05);
    const max = edge === "start" ? rounded(laugh.end - .05) : draftLaughs[index + 1]?.start ?? setLength;
    laugh[edge] = rounded(clamp(desired, min, max));
    drawStrip();
  }

  function pointerTime(clientX) {
    const bounds = strip.getBoundingClientRect();
    return rounded(windowStart + clamp((clientX - bounds.left) / bounds.width, 0, 1) * windowLength);
  }

  strip.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || !draftLines.length || event.target.closest(".editor-trash")) return;
    const node = event.target.closest(".editor-region");
    const id = node ? Number(node.dataset.id) : null;
    const edge = event.target.dataset.edge;
    const origin = pointerTime(event.clientX);
    const laugh = draftLaughs.find(item => item.id === id);
    drag = { origin, id, edge, originalBoundary: edge && laugh[edge], preview: null };
    strip.setPointerCapture(event.pointerId);
    if (laugh) selectLaugh(id);
  };

  strip.onpointermove = event => {
    if (!drag || !strip.hasPointerCapture(event.pointerId)) return;
    const to = pointerTime(event.clientX);
    if (drag.edge) resizeLaugh(drag.edge, drag.originalBoundary + to - drag.origin);
    else if (drag.id === null) {
      drag.preview = availableRange(drag.origin, to);
      drawStrip();
    }
  };

  strip.onpointerup = event => {
    if (!drag || !strip.hasPointerCapture(event.pointerId)) return;
    const action = drag;
    const to = pointerTime(event.clientX);
    drag = null;
    if (action.edge) resizeLaugh(action.edge, action.originalBoundary + to - action.origin);
    else if (action.id !== null || Math.abs(to - action.origin) < .05) seekEditor(to, false);
    else addLaugh(availableRange(action.origin, to));
    drawStrip();
  };

  strip.onlostpointercapture = () => {
    if (!drag) return;
    if (drag.edge) resizeLaugh(drag.edge, drag.originalBoundary);
    drag = null;
    drawStrip();
  };

  function updateMark() {
    markEnd.disabled = mark === null;
    $("edit-clear-mark").hidden = mark === null;
    $("edit-save").disabled = mark !== null;
  }

  function startMark() {
    if (!draftLines.length) return;
    mark = position;
    feedback.textContent = `Start marked at ${stamp(mark)}. Set an end or clear the start.`;
    updateMark();
  }

  function endMark() {
    if (mark === null) return;
    addLaugh(availableRange(mark, position));
    mark = null;
    updateMark();
  }

  $("edit").onclick = openEditor;
  $("edit-lines").addEventListener("focusin", event => {
    if (event.target.matches("textarea")) cancelAnimationFrame(scrollFrame);
  });
  $("edit-lines").addEventListener("focusout", event => {
    if (event.target.matches("textarea")) queueMicrotask(() => { if (dialog.open) updatePlayhead(true); });
  });
  $("edit-play").onclick = togglePlayback;
  $("edit-close").onclick = $("edit-cancel").onclick = () => dialog.close();
  $("edit-mark-start").onclick = startMark;
  markEnd.onclick = endMark;
  $("edit-clear-mark").onclick = () => {
    mark = null;
    feedback.textContent = "Start cleared.";
    updateMark();
  };
  positionInput.oninput = () => seekEditor(positionInput.valueAsNumber, true, true);
  $("edit-prev-window").onclick = () => seekEditor(windowStart - windowLength, true, true);
  $("edit-next-window").onclick = () => seekEditor(windowStart + windowLength, true, true);
  $("edit-laugh-seek").onclick = () => {
    const target = draftLaughs.find(item => item.id === selected) ??
      draftLaughs.find(item => item.end > position) ?? draftLaughs.at(-1);
    if (target) {
      seekEditor(target.start, true, true);
      selectLaugh(target.id);
    }
  };
  $("edit-footage").onchange = event => {
    if (!event.target.files[0]) return;
    stopPlayback();
    loadFootage(event.target.files[0]);
    syncPreview();
  };
  preview.onloadedmetadata = () => seekEditor(position);
  preview.onplay = () => { $("edit-play").textContent = "Pause"; };
  preview.onpause = preview.onended = () => { $("edit-play").textContent = "Play"; };
  preview.ontimeupdate = () => {
    if (!preview.paused && Number.isFinite(preview.duration)) {
      updatePosition(preview.currentTime / preview.duration * setLength, !drag);
    }
  };
  dialog.onclose = () => {
    stopPlayback();
    cancelAnimationFrame(scrollFrame);
  };
  dialog.onkeydown = event => {
    if (event.target.closest("input,textarea,select,button,[contenteditable]") && event.key === " ") return;
    if (event.target.closest("input,textarea,select,[contenteditable]") ||
        event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const action = { " ": togglePlayback, i: startMark, o: endMark }[event.key.toLowerCase()];
    if (action) {
      event.preventDefault();
      action();
    }
  };
  $("edit-save").onclick = () => {
    if (draftLines.length) {
      lines = draftLines;
      regions = draftLaughs.map(laugh => ({
        owner: lines.findLast(line => line.start <= laugh.start)?.index ?? lines[0].index,
        start: laugh.start,
        length: rounded(laugh.end - laugh.start),
        intensity: laugh.intensity,
      }));
      manuallyEditedLaughs = true;
    }
    dialog.close();
    seek(position);
    render();
  };

  // Start at the editable state while preserving the available readiness walkthroughs.
  step = currentScenario().steps.length - 1;
  render();
})();
