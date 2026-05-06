const MODRINTH_API_BASE = 'https://api.modrinth.com/v2';
const SETTINGS_KEY = 'modrinthBulkDownloaderSettings_v1';
const FALLBACK_MINECRAFT_VERSIONS = ['26.1', '1.21.5', '1.21.4', '1.21.3', '1.21.2', '1.21.1'];

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
  warningCount: document.getElementById('warningCount'),
  currentProject: document.getElementById('currentProject'),
  dropZone: document.getElementById('dropZone'),
  matchBadge: document.getElementById('matchBadge')
};

const state = {
  results: [],
  zipBlob: null,
  failedInputs: [],
  matchedFiles: [],
  inProgress: false,
  availableMinecraftVersions: [],
  hydratedSettings: null,
  jsZipPromise: null
};

init();

async function init() {
  setSampleProjects();
  hydrateSettings();
  await populateMinecraftVersions();
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

async function populateMinecraftVersions() {
  const versions = await fetchMinecraftVersions();
  state.availableMinecraftVersions = versions;

  dom.minecraftVersion.innerHTML = '';
  versions.forEach((version) => {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    dom.minecraftVersion.appendChild(option);
  });

  const preferredVersion = state.hydratedSettings?.minecraftVersion;
  if (preferredVersion && versions.includes(preferredVersion)) {
    dom.minecraftVersion.value = preferredVersion;
    return;
  }

  dom.minecraftVersion.value = versions[0];
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
    state.hydratedSettings = parsed;

    if (parsed.loader) dom.loader.value = parsed.loader;
    if (typeof parsed.featuredOnly === 'boolean') dom.featuredOnly.checked = parsed.featuredOnly;
    if (typeof parsed.autoDownload === 'boolean') dom.autoDownload.checked = parsed.autoDownload;
  } catch {
    // ignore malformed localStorage
  }
}

async function fetchMinecraftVersions() {
  try {
    const response = await fetch(`${MODRINTH_API_BASE}/tag/game_version`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Modrinth tag request failed (${response.status}).`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error('Malformed game versions response from Modrinth.');
    }

    const releaseVersions = data
      .filter((entry) => entry?.version_type === 'release' && typeof entry?.version === 'string')
      .map((entry) => entry.version.trim())
      .filter(Boolean);

    if (releaseVersions.length) {
      return releaseVersions;
    }

    throw new Error('No release versions returned by Modrinth.');
  } catch (error) {
    const message = normalizeError(error);
    setFeedback(`Could not load latest versions from Modrinth. Falling back to built-in list. ${message}`, true);
    return FALLBACK_MINECRAFT_VERSIONS;
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

  updateProgress({ total: projects.length, completed: 0, success: 0, failed: 0, warnings: 0, current: 'Starting...' });

  const results = [];
  const filesForZip = [];
  const versionCache = new Map();

  let completed = 0;
  let success = 0;
  let failed = 0;
  let warnings = 0;

  for (const project of projects) {
    updateProgress({ total: projects.length, completed, success, failed, warnings, current: project });

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

    if (result.warning) {
      warnings += 1;
    }

    completed += 1;
    results.push(result);
    renderResults(results);
    updateProgress({ total: projects.length, completed, success, failed, warnings, current: project });
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
      setFeedback(`Completed. ${success} matched, ${failed} failed, ${warnings} warnings. ZIP is ready.`, false);

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
  updateProgress({ total: projects.length, completed, success, failed, warnings, current: 'Done' });
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
    blob: null,
    warning: '',
    selectedVersionId: '',
    selectableVersions: []
  };

  try {
    let versions = await fetchAvailableVersions(project, mcVersion, loader, featuredOnly, true);
    let warning = '';

    if (!versions.length) {
      versions = await fetchAvailableVersions(project, null, loader, featuredOnly, false);
      if (!versions.length) {
        baseResult.error = 'No versions found for this project with the selected loader.';
        return baseResult;
      }
      warning = `No exact ${loader} + Minecraft ${mcVersion} match. Using closest available version.`;
    }

    const selected = chooseBestVersion(versions, mcVersion);
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
    const selectableVersions = buildSelectableVersions(versions);

    return {
      ...baseResult,
      title: selected.project_title || selected.name || '(title unavailable)',
      versionNumber: selected.version_number || '(unknown)',
      versionType: selected.version_type || '(unknown)',
      filename: file.filename,
      status: 'success',
      error: warning ? warning : '',
      warning,
      blob,
      selectedVersionId: selected.id,
      selectableVersions
    };
  } catch (error) {
    const normalized = normalizeError(error);
    baseResult.error = normalized;
    return baseResult;
  }
}

async function fetchAvailableVersions(project, mcVersion, loader, featuredOnly, strictMcVersion) {
  const params = new URLSearchParams({ loaders: JSON.stringify([loader]) });
  if (strictMcVersion && mcVersion) {
    params.set('game_versions', JSON.stringify([mcVersion]));
  }

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

  const withFiles = data.filter((version) => pickVersionFile(version));
  if (!withFiles.length) return [];

  if (strictMcVersion && mcVersion) {
    const exact = withFiles.filter((version) => Array.isArray(version.game_versions) && version.game_versions.includes(mcVersion));
    if (!featuredOnly) return exact;
    return exact.filter((version) => version.featured === true);
  }

  if (!featuredOnly) return withFiles;
  return withFiles.filter((version) => version.featured === true);
}

function chooseBestVersion(versions, targetMcVersion) {
  const clone = [...versions];

  clone.sort((a, b) => {
    const versionDistanceA = getNearestMinecraftDistance(a.game_versions, targetMcVersion);
    const versionDistanceB = getNearestMinecraftDistance(b.game_versions, targetMcVersion);
    if (versionDistanceA !== versionDistanceB) return versionDistanceA - versionDistanceB;

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

function buildSelectableVersions(versions) {
  return [...versions]
    .sort((a, b) => {
      const dateA = new Date(a.date_published || 0).getTime();
      const dateB = new Date(b.date_published || 0).getTime();
      return dateB - dateA;
    })
    .map((version) => {
      const file = pickVersionFile(version);
      const gameVersions = Array.isArray(version.game_versions) && version.game_versions.length
        ? version.game_versions.join(', ')
        : 'unknown MC versions';
      const versionType = version.version_type || 'unknown';
      return {
        id: version.id,
        versionNumber: version.version_number || '(unknown)',
        versionType,
        gameVersions,
        filename: file.filename,
        fileUrl: file.url,
        label: `${version.version_number || '(unknown)'} • ${gameVersions} • ${versionType}`
      };
    });
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
  const JSZipCtor = await getJSZipConstructor();
  const zip = new JSZipCtor();
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

async function getJSZipConstructor() {
  if (typeof window.JSZip === 'function') {
    return window.JSZip;
  }

  if (!state.jsZipPromise) {
    state.jsZipPromise = loadJSZipFromFallbackCdn().then(() => {
      if (typeof window.JSZip !== 'function') {
        throw new Error('JSZip loaded, but the global constructor is unavailable.');
      }
      return window.JSZip;
    });
  }

  return state.jsZipPromise;
}

function loadJSZipFromFallbackCdn() {
  const fallbackSrc = 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';

  return new Promise((resolve, reject) => {
    const existingTag = document.querySelector(`script[data-jszip-fallback="true"][src="${fallbackSrc}"]`);
    if (existingTag) {
      if (typeof window.JSZip === 'function') {
        resolve();
        return;
      }
      existingTag.addEventListener('load', () => resolve(), { once: true });
      existingTag.addEventListener('error', () => reject(new Error('Could not load JSZip from fallback CDN.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = fallbackSrc;
    script.async = true;
    script.dataset.jszipFallback = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load JSZip from fallback CDN.'));
    document.head.appendChild(script);
  });
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
    const hasPicker = row.status === 'success' && Array.isArray(row.selectableVersions) && row.selectableVersions.length > 1;
    const versionPicker = hasPicker
      ? `<select class="result-version-select" data-project="${escapeHtml(row.input)}">${row.selectableVersions.map((option) => (
        `<option value="${escapeHtml(option.id)}" ${option.id === row.selectedVersionId ? 'selected' : ''}>${escapeHtml(option.label)}</option>`
      )).join('')}</select>`
      : '—';
    const statusClass = row.status === 'success' && row.warning ? 'status-warn' : row.status === 'success' ? 'status-ok' : 'status-fail';
    const statusLabel = row.status === 'success' && row.warning ? 'warning' : row.status;
    tr.innerHTML = `
      <td>${escapeHtml(row.input)}</td>
      <td>${escapeHtml(row.title || '—')}</td>
      <td>${escapeHtml(row.versionNumber || '—')}</td>
      <td>${escapeHtml(row.versionType || '—')}</td>
      <td>${escapeHtml(row.filename || '—')}</td>
      <td>${versionPicker}</td>
      <td class="${statusClass}">${escapeHtml(statusLabel)}</td>
      <td>${escapeHtml(row.error || '—')}</td>
    `;
    dom.resultsBody.appendChild(tr);
  }
}

function updateProgress({ total, completed, success, failed, warnings, current }) {
  dom.totalCount.textContent = String(total ?? 0);
  dom.completedCount.textContent = String(completed ?? 0);
  dom.successCount.textContent = String(success ?? 0);
  dom.failedCount.textContent = String(failed ?? 0);
  dom.warningCount.textContent = String(warnings ?? 0);
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

dom.resultsBody.addEventListener('change', async (event) => {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement) || !select.classList.contains('result-version-select')) return;

  const project = select.dataset.project;
  const selectedVersionId = select.value;
  const row = state.results.find((entry) => entry.input === project);
  if (!row || row.status !== 'success') return;

  const option = row.selectableVersions.find((entry) => entry.id === selectedVersionId);
  if (!option) return;

  setFeedback(`Switching ${project} to ${option.versionNumber}...`);
  select.disabled = true;

  try {
    const blob = await fetchFileBlob(option.fileUrl);
    row.versionNumber = option.versionNumber;
    row.versionType = option.versionType;
    row.filename = option.filename;
    row.selectedVersionId = option.id;
    row.blob = blob;
    row.warning = '';
    row.error = '';
    await refreshZipFromResults();
    renderResults(state.results);
    setFeedback(`Updated ${project} to ${option.versionNumber}. ZIP has been rebuilt.`);
  } catch (error) {
    row.error = `Failed to switch version: ${normalizeError(error)}`;
    renderResults(state.results);
    setFeedback(row.error, true);
  }
});

async function refreshZipFromResults() {
  const filesForZip = state.results
    .filter((row) => row.status === 'success' && row.blob && row.filename)
    .map((row) => ({ filename: row.filename, blob: row.blob, input: row.input }));
  state.matchedFiles = filesForZip;

  if (!filesForZip.length) {
    state.zipBlob = null;
    dom.downloadBtn.disabled = true;
    updateBadge(0);
    return;
  }

  state.zipBlob = await buildZip(filesForZip);
  dom.downloadBtn.disabled = false;
  updateBadge(filesForZip.length);
}

function getNearestMinecraftDistance(gameVersions, targetVersion) {
  if (!targetVersion || !Array.isArray(gameVersions) || !gameVersions.length) {
    return Number.MAX_SAFE_INTEGER;
  }

  const target = parseVersionNumber(targetVersion);
  if (target === null) return Number.MAX_SAFE_INTEGER;

  let best = Number.MAX_SAFE_INTEGER;
  for (const entry of gameVersions) {
    const parsed = parseVersionNumber(entry);
    if (parsed === null) continue;
    const distance = Math.abs(target - parsed);
    if (distance < best) best = distance;
  }

  return best;
}

function parseVersionNumber(version) {
  const parts = String(version)
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((value) => Number.isFinite(value));

  if (!parts.length) return null;

  const [major = 0, minor = 0, patch = 0] = parts;
  return major * 1_000_000 + minor * 1_000 + patch;
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
