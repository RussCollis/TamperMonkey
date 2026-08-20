// ==UserScript==
// @name         ABM Activation Lock Audit
// @namespace    macos.abm.activationlockaudit
// @version      1.6
// @description  Overlay button on Apple Business Manager to scan all devices and export Activation Lock status to CSV
// @author       Gabriel Sroka
// @match        https://business.apple.com/*
// @match        https://school.apple.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* =============================================================================
 *  ABM Activation Lock Audit - Tampermonkey Userscript
 * =============================================================================
 * Description:   Injects a floating control panel onto Apple Business
 *                Manager with Start/Stop/Resume/Download controls. Scans
 *                every device via ABM's internal (browser-session
 *                authenticated) GraphQL endpoint and records Activation
 *                Lock status, exporting to CSV.
 *
  * Created:       20/08/2026
 * Version:       1.0
 *
 * Notes:         Converted from a manual DevTools console script (v2.0) to
 *                a Tampermonkey userscript so the scan is started from an
 *                on-page button rather than pasted into the console by
 *                hand. Functionally equivalent: same 90s keepalive,
 *                localStorage checkpointing, exponential-backoff retry,
 *                and CSV export - now driven from UI controls instead of
 *                auto-running.
 *
 *                Keeping the tab in the FOREGROUND while the scan runs is
 *                still required - Tampermonkey does not change how the
 *                browser throttles timers in a backgrounded/minimised tab.
 *                Pair with the ABM_Console_Session_Keeper.sh wrapper (or
 *                run `caffeinate -disu` manually) to stop the MAC sleeping;
 *                nothing can force the tab itself to stay foregrounded
 *                from outside the browser.
 *
 * Requirements:  Tampermonkey (or a compatible userscript manager)
 *                installed in Safari/Chrome, signed in to Apple Business
 *                Manager with at least read access to Devices.
 *
 * Output:        CSV download triggered by the browser (lands in the
 *                default Downloads folder), plus an on-page status panel.
 *                An existing audit CSV can be loaded as a baseline; devices
 *                already in it are skipped and new results are appended.
 *
 * IMPORTANT:     Uses Apple's internal, undocumented ABM web endpoint via
 *                your browser session. Not supported by Apple, may change
 *                without notice. Only use where the official ABM/Jamf
 *                APIs cannot supply the data (e.g. devices not yet
 *                enrolled in Jamf).

 * =============================================================================
 * Changelog
 * =============================================================================
 *   20/08/2026 - v1.6 - Disabled the unverified product-family GraphQL
 *                        filter after it caused ABM request timeouts.
 *   20/08/2026 - v1.5 - Added a request timeout so a stalled ABM request
 *                        reports an error and retries instead of leaving
 *                        the panel at "Starting scan…" indefinitely.
 *   20/08/2026 - v1.4 - Made Start Scan provide immediate feedback and show
 *                        any startup failure in the panel.
 *   20/08/2026 - v1.3 - Added a live progress bar and scanned/total count.
 *   20/08/2026 - v1.2 - Added an All/Mac/iPhone/iPad selector. The chosen
 *                        family is filtered by ABM before paging and is
 *                        retained in scan checkpoints.
 *   20/08/2026 - v1.1 - Added source CSV import. Imported devices form a
 *                        baseline and are not queried again; the exported
 *                        CSV contains the baseline plus newly scanned rows.
 *   20/08/2026 - v1.0 - Converted from the manual console script to a
 *                        Tampermonkey userscript with an on-page overlay
 *                        panel (Start/Stop/Resume/Download), replacing the
 *                        copy-to-clipboard-and-paste workflow.
 * =============================================================================
 */

(function () {
  'use strict';

  const LIMIT = 350;
  const THROTTLE_MS = 150;
  const KEEPALIVE_INTERVAL_MS = 90 * 1000;
  const CHECKPOINT_KEY = 'abmActivationLockAudit_checkpoint';
  const AUTO_DOWNLOAD_EVERY = 500;
  const MAX_ATTEMPTS = 6;
  const BASE_RETRY_DELAY_MS = 2000;
  const FETCH_TIMEOUT_MS = 30 * 1000;
  // Apple Business Manager's device-search enum values.
  const PRODUCT_FAMILIES = {
    all: null,
    mac: 'MAC',
    iphone: 'IPHONE',
    ipad: 'IPAD'
  };

  let scanRunning = false;
  let abortRequested = false;
  let keepAliveHandle = null;

  // ---------------------------------------------------------------------
  // Overlay panel UI
  // ---------------------------------------------------------------------

  function injectPanel() {
    const panel = document.createElement('div');
    panel.id = '-abm-audit-panel';
    panel.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      background: #1d1d1f;
      color: #f5f5f7;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 13px;
      border-radius: 10px;
      padding: 14px 16px;
      width: 260px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.35);
    `;

    panel.innerHTML = `
      <div style="font-weight:600; margin-bottom:8px;"> Activation Lock Audit</div>
      <div id="-abm-status" style="opacity:0.85; margin-bottom:10px; line-height:1.4;">Idle.</div>
      <div id="-abm-progress-text" style="font-size:11px; opacity:0.78; margin-bottom:4px;">Scan progress: not started</div>
      <div style="height:6px; overflow:hidden; border-radius:3px; background:#3a3a3c; margin-bottom:10px;">
        <div id="-abm-progress-bar" style="height:100%; width:0%; background:#30d158; transition:width 120ms linear;"></div>
      </div>
      <label style="display:block; margin-bottom:8px; font-size:12px;">
        Product family
        <select id="-abm-product-family" style="float:right; max-width:130px; border-radius:4px; border:1px solid #636366; background:#2c2c2e; color:#f5f5f7; padding:2px 4px;">
          <option value="all">All devices</option>
          <option value="mac">Mac</option>
          <option value="iphone">iPhone</option>
          <option value="ipad">iPad</option>
        </select>
      </label>
      <div style="display:flex; gap:6px;">
        <button id="-abm-start" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#0071e3; color:#fff; cursor:pointer;">Start Scan</button>
        <button id="-abm-stop" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#3a3a3c; color:#fff; cursor:pointer;" disabled>Stop</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <button id="-abm-download" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#3a3a3c; color:#fff; cursor:pointer;">Download current results</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <button id="-abm-import" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#3a3a3c; color:#fff; cursor:pointer;">Load source CSV</button>
        <input id="-abm-source-file" type="file" accept=".csv,text/csv" style="display:none;">
      </div>
      <div style="margin-top:6px; font-size:11px; opacity:0.72; line-height:1.3;">Load a previous audit CSV to keep its rows. Existing device IDs will be skipped; new results are appended.</div>
      <div id="-abm-foreground-warning" style="margin-top:10px; font-size:11px; color:#ff9f0a; display:none;">
        Keep this tab in the foreground - backgrounding it can throttle or pause the scan.
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('-abm-start').addEventListener('click', onStartClicked);
    document.getElementById('-abm-stop').addEventListener('click', onStopClicked);
    document.getElementById('-abm-download').addEventListener('click', () => {
      exportCsv(currentResults, 'manual');
    });
    document.getElementById('-abm-import').addEventListener('click', () => {
      document.getElementById('-abm-source-file').click();
    });
    document.getElementById('-abm-source-file').addEventListener('change', onSourceFileSelected);

    document.addEventListener('visibilitychange', () => {
      const warning = document.getElementById('-abm-foreground-warning');
      if (!warning) return;
      warning.style.display = (document.hidden && scanRunning) ? 'block' : 'none';
    });
  }

  function setStatus(text) {
    const el = document.getElementById('-abm-status');
    if (el) el.textContent = text;
  }

  function setRunningUiState(running) {
    scanRunning = running;
    const startBtn = document.getElementById('-abm-start');
    const stopBtn = document.getElementById('-abm-stop');
    const productFamily = document.getElementById('-abm-product-family');
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
    if (productFamily) productFamily.disabled = running;
  }

  let currentResults = [];
  let sourceFileName = null;
  let totalDevicesInScope = null;

  function selectedProductFamily() {
    const value = document.getElementById('-abm-product-family')?.value || 'all';
    return PRODUCT_FAMILIES[value] ?? null;
  }

  function resetProgress() {
    totalDevicesInScope = null;
    updateProgress(0, currentResults.length, 'not started');
  }

  function updateProgress(scanned, saved, state = '') {
    const text = document.getElementById('-abm-progress-text');
    const bar = document.getElementById('-abm-progress-bar');
    const percentage = totalDevicesInScope === null
      ? 0
      : Math.min(100, (scanned / Math.max(totalDevicesInScope, 1)) * 100);

    if (text) {
      const total = totalDevicesInScope === null ? '?' : totalDevicesInScope;
      text.textContent = `Scan progress: ${scanned} / ${total} (${Math.round(percentage)}%) — ${saved} rows saved${state ? `; ${state}` : ''}`;
    }
    if (bar) bar.style.width = `${percentage}%`;
  }

  async function onStartClicked() {
    if (scanRunning) return;

    let started = false;
    try {
      // Set this before any confirmation, network request, or file handling
      // so a click always gives visible feedback.
      setStatus('Starting scan…');
      let resumeStart = 0;
      const productFamily = selectedProductFamily();

      if (productFamily) {
        setStatus('Product-family filtering is temporarily unavailable. Select “All devices” to scan.');
        updateProgress(0, currentResults.length, 'select All devices to start');
        return;
      }

      const checkpoint = loadCheckpoint();
      if (checkpoint) {
        if ((checkpoint.productFamily || null) !== productFamily) {
          clearCheckpoint();
          setStatus('Previous checkpoint used a different product family and was cleared. Starting scan…');
        } else {
          const resume = confirm(
            `Found a checkpoint with ${checkpoint.results.length} devices already ` +
            `recorded (resuming from position ${checkpoint.start}). Resume? ` +
            `Cancel to start fresh.`
          );
          if (resume) {
            currentResults = checkpoint.results;
            resumeStart = checkpoint.start;
          } else {
            clearCheckpoint();
          }
        }
      }

      abortRequested = false;
      resetProgress();
      setRunningUiState(true);
      started = true;
      startKeepAlive();
      setStatus('Fetching the device list…');
      await runScan(resumeStart, currentResults, productFamily);
    } catch (e) {
      console.error('[START] Could not start scan:', e);
      setStatus(`Could not start scan: ${e.message || e}`);
      updateProgress(0, currentResults.length, 'unable to start');
    } finally {
      if (started) stopKeepAlive();
      setRunningUiState(false);
    }
  }

  function onStopClicked() {
    abortRequested = true;
    setStatus('Stopping after current device... partial results will be exported.');
  }

  async function onSourceFileSelected(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (scanRunning) {
      setStatus('Stop the current scan before loading a source file.');
      return;
    }

    try {
      const imported = parseSourceCsv(await file.text());
      if (currentResults.length && !confirm('Loading a source CSV replaces the current in-memory results. Continue?')) return;

      currentResults = imported;
      sourceFileName = file.name;
      clearCheckpoint();
      updateProgress(0, imported.length, 'source file loaded');
      setStatus(`Loaded ${imported.length} unique devices from ${file.name}. New devices will be appended.`);
    } catch (e) {
      console.error('[SOURCE CSV] Could not load file:', e);
      setStatus(`Could not load source CSV: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------
  // Checkpoint handling
  // ---------------------------------------------------------------------

  function loadCheckpoint() {
    try {
      const raw = localStorage.getItem(CHECKPOINT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('[CHECKPOINT] Could not read checkpoint, starting fresh.', e);
      return null;
    }
  }

  function saveCheckpoint(start, results, productFamily = null) {
    try {
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ start, results, productFamily }));
    } catch (e) {
      console.warn('[CHECKPOINT] Could not save checkpoint (quota?).', e);
    }
  }

  function clearCheckpoint() {
    localStorage.removeItem(CHECKPOINT_KEY);
  }

  // ---------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------

  function parseSourceCsv(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('the file has no data rows');

    const headers = rows[0].map(value => value.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
    const findColumn = (...names) => headers.findIndex(header => names.includes(header));
    const idColumn = findColumn('deviceid', 'id', 'serial', 'serialnumber');
    const lockTypeColumn = findColumn('activationlocktype', 'locktype');
    const statusColumn = findColumn('activationlockstatus', 'status');

    if (idColumn === -1) {
      throw new Error('expected a deviceId column (or id, serial, or serialNumber)');
    }

    const byDeviceId = new Map();
    for (const row of rows.slice(1)) {
      const id = (row[idColumn] || '').trim();
      if (!id) continue;
      byDeviceId.set(id, {
        id,
        lockType: lockTypeColumn === -1 ? 'Unknown' : (row[lockTypeColumn] || 'Unknown').trim(),
        status: statusColumn === -1 ? 'Unknown' : (row[statusColumn] || 'Unknown').trim()
      });
    }

    if (byDeviceId.size === 0) throw new Error('no device IDs were found');
    return [...byDeviceId.values()];
  }

  // Handles quoted fields so a source CSV can safely contain commas or quotes.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (char === '"') {
          quoted = false;
        } else {
          field += char;
        }
      } else if (char === '"') {
        quoted = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        if (row.some(value => value.length > 0)) rows.push(row);
        row = [];
        field = '';
      } else {
        field += char;
      }
    }
    row.push(field);
    if (row.some(value => value.length > 0)) rows.push(row);
    return rows;
  }

  function csvEscape(value) {
    const stringValue = String(value ?? '');
    return /[",\n\r]/.test(stringValue) ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
  }

  function exportCsv(results, label = 'partial') {
    if (!results || results.length === 0) {
      setStatus('Nothing to export yet.');
      return;
    }

    const header = 'deviceId,activationLockType,activationLockStatus\n';
    const rows = results.map(r => [r.id, r.lockType, r.status].map(csvEscape).join(',')).join('\n');
    const csv = header + rows;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `abm_activation_lock_audit_${label}_${timestamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus(`Exported ${results.length} rows (${label})${sourceFileName ? `; baseline: ${sourceFileName}` : ''}.`);
  }

  // ---------------------------------------------------------------------
  // Keepalive
  // ---------------------------------------------------------------------

  function startKeepAlive() {
    keepAliveHandle = setInterval(async () => {
      try {
        await fetch(
          'https://ws.business.apple.com/mdm/api/graphql/v2?operation=PaginatedDevicesList',
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              operationName: 'PaginatedDevicesList',
              variables: { start: 0, limit: 1 },
              query: `query PaginatedDevicesList($limit: Int, $start: Int) {
                page: paginatedDeviceSearch(inputV2: {limit: $limit, start: $start}) {
                  totalCount
                }
              }`
            })
          }
        );
      } catch (e) {
        console.error('[KEEPALIVE FAILED]', e);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  function stopKeepAlive() {
    if (keepAliveHandle) {
      clearInterval(keepAliveHandle);
      keepAliveHandle = null;
    }
  }

  // ---------------------------------------------------------------------
  // Main scan
  // ---------------------------------------------------------------------

  async function runScan(resumeStart, results, productFamily) {
    let processed = results.length;
    let scanPosition = resumeStart;
    const knownDeviceIds = new Set(results.map(result => result.id));

    try {
      setStatus('Fetching the device list…');
      for await (const device of getDevices(resumeStart, productFamily)) {
        if (abortRequested) {
          saveCheckpoint(scanPosition, results, productFamily);
          setStatus(`Stopped by user at ${processed} saved devices. Exporting partial results.`);
          updateProgress(scanPosition, processed, 'stopped');
          if (results.length) exportCsv(results, 'stopped');
          return;
        }

        scanPosition++;

        // A loaded source file is the baseline. Do not re-query a device
        // already present in it (or one restored from a checkpoint).
        if (knownDeviceIds.has(device.id)) {
          setStatus(`Skipped existing device ${scanPosition}; ${processed} rows retained...`);
          updateProgress(scanPosition, processed, 'existing device skipped');
          if (scanPosition % 50 === 0) saveCheckpoint(scanPosition, results, productFamily);
          continue;
        }

        const detail = await getDeviceDetailsSafe(device.id);

        results.push({
          id: device.id,
          lockType: detail?.activationLockStatus?.lockType ?? 'Unknown',
          status: detail?.activationLockStatus?.status ?? 'Unknown'
        });
        knownDeviceIds.add(device.id);

        processed++;
        setStatus(`Saved ${processed} devices (scanned ${scanPosition})...`);
        updateProgress(scanPosition, processed);

        if (scanPosition % 50 === 0) {
          saveCheckpoint(scanPosition, results, productFamily);
        }

        if (processed % AUTO_DOWNLOAD_EVERY === 0) {
          exportCsv(results, 'checkpoint');
        }

        await sleep(THROTTLE_MS);
      }

      setStatus(`Completed. Processed ${processed} devices.`);
      updateProgress(scanPosition, processed, 'complete');
      exportCsv(results, 'final');
      clearCheckpoint();
    } catch (e) {
      console.error('[FATAL] Scan stopped early:', e);
      const errorMessage = `Stopped early: ${e.message || e}`;
      setStatus(errorMessage);
      updateProgress(scanPosition, processed, 'stopped due to an error');
      if (results.length) {
        exportCsv(results, 'partial-error');
        setStatus(errorMessage);
      }
    }
  }

  async function getDeviceDetailsSafe(deviceId) {
    try {
      return await retry(() => getDeviceDetails(deviceId));
    } catch (e) {
      console.error(`Failed to retrieve ${deviceId} after retries`, e);
      return null;
    }
  }

  async function* getDevices(startAt = 0, productFamily = null) {
    // Product-family filtering is intentionally omitted here. The ABM field
    // name is not public, and the prior guessed deviceType field timed out.
    // onStartClicked prevents a filtered scan from being started.
    yield* getObjects(
      'PaginatedDevicesList',
      `query PaginatedDevicesList($limit: Int, $start: Int) {
        page: paginatedDeviceSearch(inputV2: {limit: $limit, start: $start}) {
          nodes { id }
          totalCount
        }
      }`,
      startAt
    );
  }

  async function getDeviceDetails(serial) {
    return graphql({
      operationName: 'GetDeviceDetails',
      variables: { serial },
      query: `query GetDeviceDetails($serial: String!) {
        device(serial: $serial) {
          activationLockStatus { lockType status }
        }
      }`
    });
  }

  async function* getObjects(operationName, query, startAt = 0) {
    let start = startAt;

    while (true) {
      const page = await retry(() =>
        graphql({ operationName, variables: { start, limit: LIMIT }, query })
      );

      totalDevicesInScope = page.totalCount;
      yield* page.nodes;

      start += LIMIT;

      if (start >= page.totalCount) break;

      await sleep(THROTTLE_MS);
    }
  }

  async function graphql(query) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const r = await fetch(
        `https://ws.business.apple.com/mdm/api/graphql/v2?operation=${query.operationName}`,
        {
          method: 'POST',
          body: JSON.stringify(query),
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        }
      );

      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const { data, errors } = await r.json();
      if (errors?.length) {
        const error = new Error(JSON.stringify(errors));
        error.nonRetryable = true;
        throw error;
      }
      return Object.values(data)[0];
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`${query.operationName} timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function retry(fn, attempts = MAX_ATTEMPTS, baseDelay = BASE_RETRY_DELAY_MS) {
    let lastError;

    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;

        // GraphQL validation/permission errors cannot succeed on retry. Show
        // the ABM response immediately so the filter can be corrected.
        if (e.nonRetryable) throw e;

        if (i < attempts) {
          const delay = baseDelay * (2 ** (i - 1));
          setStatus(`Request failed; retrying ${i}/${attempts} in ${Math.round(delay / 1000)} seconds…`);
          console.warn(`Retry ${i}/${attempts} after error (waiting ${delay}ms):`, e);
          await sleep(delay);
        }
      }
    }

    throw lastError;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  injectPanel();

  const existingCheckpoint = loadCheckpoint();
  if (existingCheckpoint) {
    setStatus(`Checkpoint found: ${existingCheckpoint.results.length} devices recorded. Click Start to resume.`);
  }
})();
