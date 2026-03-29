const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';
const SETTINGS_KEY = 'modrinthBulkDownloaderSettings_v1';

const dom = {
  minecraftVersion: document.getElementById('minecraftVersion'),
  loader: document.getElementById('loader'),
  featuredOnly: document.getElementById('featuredOnly'),
  autoDownload: document.getElementById('autoDownload'),
  projectList: document.getElementById('projectList'),
  runBtn: document.getElementById('runBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  retryFailedBtn: document.getElementById('retryFailedBtn'),
  copyFailedBtn: document.getElementById('copyFailedBtn'),
  resultsBody: document.getElementById('resultsBody'),
  feedback: document.getElementById('feedback'),
  totalCount: document.getElementById('totalCount'),
  completedCount: document.getElementById('completedCount'),
  successCount: document.getElementById('successCount'),
  failedCount: document.getElementById('failedCount'),
  currentProject: document.getElementById('currentProject'),
  dropZone: document.getElementById('dropZone'),
  matchBadge: document.getElementById('matchBadge')
};

const state = {
  results: [],
  zipBlob: null,
  failedInputs: [],
  matchedFiles: [],
  inProgress: false
};

init();

function init() {
  setSampleProjects();
  hydrateSettings();
  populateMinecraftVersions();
  bindEvents();
}

function setSampleProjects() {
  if (dom.projectList.value.trim()) return;
  dom.projectList.value = [
    'luckperms',
    'placeholder-api',
    'viaversion',
    'geyser',
    'floodgate'
  ].join('\n');
}

function bindEvents() {
  dom.runBtn.addEventListener('click', runWorkflow);
  dom.downloadBtn.addEventListener('click', () => {
    if (state.zipBlob) {
      const zipName = buildZipName();
      triggerBlobDownload(state.zipBlob, zipName);
    }
  });

  dom.retryFailedBtn.addEventListener('click', retryFailedEntries);
  dom.copyFailedBtn.addEventListener('click', copyFailedEntries);

  [dom.minecraftVersion, dom.loader, dom.featuredOnly, dom.autoDownload].forEach((el) => {
    el.addEventListener('change', persistSettings);
  });

  setupDragAndDrop();
}

function populateMinecraftVersions() {
  const versions = [
    '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1', '1.21',
    '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20'
  ];

  dom.minecraftVersion.innerHTML = '';
  versions.forEach((version) => {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    dom.minecraftVersion.appendChild(option);
  });

  if (!dom.minecraftVersion.value) {
    dom.minecraftVersion.value = versions[0];
  }
}

function persistSettings() {
  const settings = {
    minecraftVersion: dom.minecraftVersion.value,
    loader: dom.loader.value,
    featuredOnly: dom.featuredOnly.checked,
    autoDownload: dom.autoDownload.checked
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function hydrateSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);

    if (parsed.loader) dom.loader.value = parsed.loader;
    if (typeof parsed.featuredOnly === 'boolean') dom.featuredOnly.checked = parsed.featuredOnly;
    if (typeof parsed.autoDownload === 'boolean') dom.autoDownload.checked = parsed.autoDownload;

    window.requestAnimationFrame(() => {
      if (parsed.minecraftVersion) dom.minecraftVersion.value = parsed.minecraftVersion;
    });
  } catch {
    // ignore malformed localStorage
  }
}

function parseProjectList(rawText) {
  const seen = new Set();
  return rawText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((entry) => {
      if (seen.has(entry.toLowerCase())) {
        return false;
      }
      seen.add(entry.toLowerCase());
      return true;
    });
}

async function runWorkflow() {
  if (state.inProgress) return;

  const projects = parseProjectList(dom.projectList.value);
  if (!projects.length) {
    setFeedback('Please provide at least one project slug or ID.', true);
    return;
  }

  setRunningState(true);
  resetResults();

  const mcVersion = dom.minecraftVersion.value;
  const loader = dom.loader.value;
  const featuredOnly = dom.featuredOnly.checked;

  updateProgress({ total: projects.length, completed: 0, success: 0, failed: 0, current: 'Starting...' });

  const results = [];
  const filesForZip = [];
  const versionCache = new Map();

  let completed = 0;
  let success = 0;
  let failed = 0;

  for (const project of projects) {
    updateProgress({ total: projects.length, completed, success, failed, current: project });

    let result;
    if (versionCache.has(project.toLowerCase())) {
      result = structuredClone(versionCache.get(project.toLowerCase()));
      result.input = project;
    } else {
      result = await processProject(project, mcVersion, loader, featuredOnly);
      versionCache.set(project.toLowerCase(), result);
    }

    if (result.status === 'success') {
      success += 1;
      filesForZip.push({
        filename: result.filename,
        blob: result.blob,
        input: project
      });
    } else {
      failed += 1;
    }

    completed += 1;
    results.push(result);
    renderResults(results);
    updateProgress({ total: projects.length, completed, success, failed, current: project });
  }

  state.results = results;
  state.failedInputs = results.filter((r) => r.status !== 'success').map((r) => r.input);
  state.matchedFiles = filesForZip;
  dom.copyFailedBtn.disabled = state.failedInputs.length === 0;
  dom.retryFailedBtn.disabled = state.failedInputs.length === 0;

  if (filesForZip.length) {
    try {
      state.zipBlob = await buildZip(filesForZip);
      dom.downloadBtn.disabled = false;
      setFeedback(`Completed. ${success} matched, ${failed} failed. ZIP is ready.`, false);

      if (dom.autoDownload.checked) {
        triggerBlobDownload(state.zipBlob, buildZipName());
      }
    } catch (error) {
      dom.downloadBtn.disabled = true;
      state.zipBlob = null;
      setFeedback(`Finished lookups, but ZIP generation failed: ${error.message}`, true);
    }
  } else {
    state.zipBlob = null;
    dom.downloadBtn.disabled = true;
    setFeedback('No matching files found. Adjust loader/version and retry.', true);
  }

  updateBadge(success);
  updateProgress({ total: projects.length, completed, success, failed, current: 'Done' });
  setRunningState(false);
}

async function processProject(project, mcVersion, loader, featuredOnly) {
  const baseResult = {
    input: project,
    title: '',
    versionNumber: '',
    versionType: '',
    filename: '',
    status: 'failed',
    error: '',
    blob: null
  };

  try {
    const versions = await fetchAvailableVersions(project, mcVersion, loader, featuredOnly);

    if (!Array.isArray(versions)) {
      throw new Error('Malformed API response: expected an array of versions.');
    }

    if (!versions.length) {
      baseResult.error = 'No matching version for selected loader/version.';
      return baseResult;
    }

    const selected = chooseBestVersion(versions, featuredOnly);
    if (!selected) {
      baseResult.error = 'No suitable version could be selected from matches.';
      return baseResult;
    }

    const file = pickVersionFile(selected);
    if (!file?.url || !file?.filename) {
      baseResult.error = 'Matching version had no downloadable file.';
      return baseResult;
    }

    const blob = await fetchFileBlob(file.url);

    return {
      ...baseResult,
      title: selected.project_title || selected.name || '(title unavailable)',
      versionNumber: selected.version_number || '(unknown)',
      versionType: selected.version_type || '(unknown)',
      filename: file.filename,
      status: 'success',
      error: '',
      blob
    };
  } catch (error) {
    const normalized = normalizeError(error);
    baseResult.error = normalized;
    return baseResult;
  }
}

async function fetchAvailableVersions(project, mcVersion, loader, featuredOnly) {
  const params = new URLSearchParams({
    loaders: JSON.stringify([loader]),
    game_versions: JSON.stringify([mcVersion])
  });

  const response = await fetch(`${MODRINTH_API_BASE}/project/${encodeURIComponent(project)}/version?${params.toString()}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
      // Browsers block setting User-Agent directly. See README.
    }
  });

  if (response.status === 404) {
    throw new Error('Project not found. Check slug or project ID.');
  }

  if (!response.ok) {
    throw new Error(`Modrinth API request failed (${response.status}).`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error('Malformed API response from Modrinth.');
  }

  if (!featuredOnly) return data;
  return data.filter((version) => version.featured === true);
}

function chooseBestVersion(versions) {
  const clone = [...versions];

  clone.sort((a, b) => {
    const typeScoreA = a.version_type === 'release' ? 1 : 0;
    const typeScoreB = b.version_type === 'release' ? 1 : 0;
    if (typeScoreA !== typeScoreB) return typeScoreB - typeScoreA;

    const featuredA = a.featured ? 1 : 0;
    const featuredB = b.featured ? 1 : 0;
    if (featuredA !== featuredB) return featuredB - featuredA;

    const dateA = new Date(a.date_published || 0).getTime();
    const dateB = new Date(b.date_published || 0).getTime();
    return dateB - dateA;
  });

  return clone[0] || null;
}

function pickVersionFile(version) {
  if (!Array.isArray(version.files) || version.files.length === 0) {
    return null;
  }

  const primary = version.files.find((file) => file.primary);
  return primary || version.files[0];
}

async function fetchFileBlob(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`File download failed (${response.status}).`);
  }

  return response.blob();
}

async function buildZip(files) {
  const zip = new JSZip();
  const duplicateNameCount = new Map();

  for (const file of files) {
    let safeName = sanitizeFilename(file.filename);

    if (duplicateNameCount.has(safeName)) {
      const count = duplicateNameCount.get(safeName) + 1;
      duplicateNameCount.set(safeName, count);
      safeName = appendCounterToFilename(safeName, count);
    } else {
      duplicateNameCount.set(safeName, 0);
    }

    zip.file(safeName, file.blob);
  }

  return zip.generateAsync({ type: 'blob' });
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

function appendCounterToFilename(filename, counter) {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0) return `${filename}-${counter}`;
  return `${filename.slice(0, dotIndex)}-${counter}${filename.slice(dotIndex)}`;
}

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildZipName() {
  return `plugins-${dom.minecraftVersion.value}-${dom.loader.value}.zip`;
}

function renderResults(results) {
  dom.resultsBody.innerHTML = '';

  for (const row of results) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.input)}</td>
      <td>${escapeHtml(row.title || '—')}</td>
      <td>${escapeHtml(row.versionNumber || '—')}</td>
      <td>${escapeHtml(row.versionType || '—')}</td>
      <td>${escapeHtml(row.filename || '—')}</td>
      <td class="${row.status === 'success' ? 'status-ok' : 'status-fail'}">${escapeHtml(row.status)}</td>
      <td>${escapeHtml(row.error || '—')}</td>
    `;
    dom.resultsBody.appendChild(tr);
  }
}

function updateProgress({ total, completed, success, failed, current }) {
  dom.totalCount.textContent = String(total ?? 0);
  dom.completedCount.textContent = String(completed ?? 0);
  dom.successCount.textContent = String(success ?? 0);
  dom.failedCount.textContent = String(failed ?? 0);
  dom.currentProject.textContent = current || '—';
}

function updateBadge(successCount) {
  dom.matchBadge.textContent = `${successCount} matched`;
}

function resetResults() {
  state.results = [];
  state.zipBlob = null;
  state.failedInputs = [];
  state.matchedFiles = [];
  dom.resultsBody.innerHTML = '';
  dom.downloadBtn.disabled = true;
  dom.copyFailedBtn.disabled = true;
  dom.retryFailedBtn.disabled = true;
  updateBadge(0);
}

function setRunningState(running) {
  state.inProgress = running;
  dom.runBtn.disabled = running;
  dom.downloadBtn.disabled = running || !state.zipBlob;
  dom.retryFailedBtn.disabled = running || state.failedInputs.length === 0;
  dom.copyFailedBtn.disabled = running || state.failedInputs.length === 0;
}

function setFeedback(message, isError = false) {
  dom.feedback.textContent = message;
  dom.feedback.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function normalizeError(error) {
  if (error instanceof TypeError) {
    return 'Network failure or CORS issue while contacting Modrinth.';
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unknown error occurred.';
}

async function copyFailedEntries() {
  if (!state.failedInputs.length) return;

  const content = state.failedInputs.join('\n');
  try {
    await navigator.clipboard.writeText(content);
    setFeedback(`Copied ${state.failedInputs.length} failed entries to clipboard.`);
  } catch {
    setFeedback('Could not access clipboard. You can manually copy from the list.', true);
  }
}

function retryFailedEntries() {
  if (!state.failedInputs.length || state.inProgress) return;
  dom.projectList.value = state.failedInputs.join('\n');
  runWorkflow();
}

function setupDragAndDrop() {
  const zone = dom.dropZone;

  ['dragenter', 'dragover'].forEach((evt) => {
    zone.addEventListener(evt, (event) => {
      event.preventDefault();
      zone.classList.add('active');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    zone.addEventListener(evt, (event) => {
      event.preventDefault();
      zone.classList.remove('active');
    });
  });

  zone.addEventListener('drop', async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.txt')) {
      setFeedback('Please drop a .txt file containing one project per line.', true);
      return;
    }

    try {
      const text = await file.text();
      dom.projectList.value = text;
      setFeedback(`Imported ${file.name}.`);
    } catch {
      setFeedback('Failed to read the dropped file.', true);
    }
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
