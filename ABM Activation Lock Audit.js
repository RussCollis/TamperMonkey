Replace *YourORG* with updfatyed field and delete this line



// ==UserScript==
// @name         *YourORG* ABM Activation Lock Audit - 2.0.1
// @namespace    *YourORG*.macos.abm.activationlockaudit
// @version      2.0.1
// @description  Overlay button on Apple Business Manager to scan all devices and export Activation Lock status to CSV
// @author       Gabriel Sroka
// @updated      Russ Collis
// @match        https://business.apple.com/*
// @match        https://school.apple.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* =============================================================================
 * *YourORG* ABM Activation Lock Audit - Tampermonkey Userscript
 * =============================================================================
 * Description:   Injects a floating control panel onto Apple Business
 *                Manager with Start/Stop/Resume/Download controls. Scans
 *                every device via ABM's internal (browser-session
 *                authenticated) GraphQL endpoint and records Activation
 *                Lock status, exporting to CSV.
 *
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
 *
 * IMPORTANT:     This script is specifically designed for *YourORG*'s macOS
 *                environment and should only be deployed within *YourORG*'s
 *                managed infrastructure. It contains organisation-specific
 *                configurations and should not be used outside of this
 *                intended environment.
 * =============================================================================
 * Changelog
 * =============================================================================
 *   21/08/2026 - v2.0.1 - Adds Device.searchInfo.deviceName to the CSV.
 *   21/08/2026 - v2.0.0 - Uses ABM's confirmed `Device.searchInfo.
 *                        productFamily` field from the device-list response.
 *                        Family filtering now happens before Activation Lock
 *                        detail requests, and the family is carried straight
 *                        into the CSV. No guessed field is sent to
 *                        GetDeviceDetails, avoiding its HTTP 400 response.
 *   21/08/2026 - v1.9.0 - Fixed family-filter scans. Rather than disabling
 *                        an unsupported GraphQL family field and silently
 *                        treating every device as "Unknown", the script
 *                        now tests productFamily, deviceFamily, deviceType,
 *                        and family on the first device. It uses the first
 *                        field ABM accepts for the whole scan. If none work,
 *                        the selected-family scan stops with a clear error
 *                        and does not create an empty filtered CSV.
 *   21/08/2026 - v1.8.1 - Changed DEVICE_FAMILY_FIELD guess from "deviceType"
 *                        to "productFamily", and switched the family
 *                        comparison to a normalised (lowercase, spaces/
 *                        hyphens stripped) match instead of an ALL-CAPS
 *                        enum match. Based on evidence from Warranty
 *                        Wrangler (*YourORG*'s ABM REST API script), which
 *                        confirms Apple's official, documented ABM REST
 *                        API exposes this exact attribute as
 *                        `.attributes.productFamily` with values such as
 *                        "Mac" / "iPhone" / "iPad". The internal GraphQL
 *                        endpoint this script uses is a different API, so
 *                        this remains an informed guess rather than a
 *                        confirmed field name - the automatic fallback
 *                        from v1.8 still applies if it's wrong.
 *   21/08/2026 - v1.8 - Added device family filtering and a "deviceFamily"
 *                        CSV column. Filtering is applied CLIENT-SIDE, after
 *                        each device's Activation Lock detail is fetched -
 *                        NOT as a server-side ABM query filter, since that
 *                        approach was already tried (v1.2) and caused
 *                        timeouts (v1.6). A filtered scan therefore still
 *                        checks every device; it narrows what is kept, not
 *                        how much is scanned. Device family is read from a
 *                        best-guess GraphQL field (now superseded by the
 *                        candidate-field discovery in v1.9,
 *                        currently "deviceType") added to the existing
 *                        batch/individual detail queries. If ABM rejects
 *                        that field for this tenant, the script detects the
 *                        schema error on the first batch, disables family
 *                        lookups for the rest of the run, and shows
 *                        "Unknown" - Activation Lock data is unaffected.
 *   21/08/2026 - v1.7 - Batched the Activation Lock detail lookup. Devices
 *                        were being fetched 350-at-a-time for the device
 *                        LIST, but the Activation Lock STATUS for each one
 *                        was still one GraphQL request per device. Detail
 *                        lookups are now grouped into DETAIL_BATCH_SIZE-
 *                        sized requests using aliased GraphQL fields (one
 *                        HTTP round trip covers many devices). If a batch
 *                        request fails outright (e.g. the undocumented
 *                        endpoint rejects the aliased query), the script
 *                        automatically falls back to querying that batch's
 *                        devices one at a time so the scan cannot stall.
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

  const LIMIT = 350;                    // Devices per device-LIST page request.
  const DETAIL_BATCH_SIZE = 25;         // Devices per Activation Lock DETAIL request.
  const THROTTLE_MS = 150;
  const KEEPALIVE_INTERVAL_MS = 90 * 1000;
  const CHECKPOINT_KEY = 'abmActivationLockAudit_checkpoint';
  const AUTO_DOWNLOAD_EVERY = 500;
  const MAX_ATTEMPTS = 6;
  const BASE_RETRY_DELAY_MS = 2000;
  const FETCH_TIMEOUT_MS = 30 * 1000;

  // GUESSED field name for a device's family/type on ABM's GraphQL device
  // object (e.g. device(serial: $s) { productFamily }). This is NOT from
  // public documentation for the internal GraphQL endpoint, but "Warranty
  // Wrangler" (*YourORG*'s ABM REST API script) confirms Apple's OFFICIAL,
  // documented ABM REST API (api-business.apple.com/v1/orgDevices) exposes
  // this exact attribute as `.attributes.productFamily`. The internal
  // GraphQL endpoint used here is a different API, so this is still a
  // guess - just a much better-informed one than a blind guess would be.
  // If family always comes back "Unknown" in the CSV, this is the field
  // name to correct: open DevTools -> Network on the ABM Devices page,
  // filter the built-in Devices list by type, and inspect the GraphQL
  // request body for the actual field name, then update this constant.
  // Apple's REST API returns productFamily values like "Mac" / "iPhone" /
  // "iPad" rather than an ALL-CAPS enum, so - matching Warranty Wrangler's
  // normalizeFamily() approach - comparisons here are done after lower-
  // casing and stripping spaces/hyphens from both sides, rather than
  // relying on exact casing.
  const PRODUCT_FAMILIES = {
    all: null,
    mac: 'mac',
    iphone: 'iphone',
    ipad: 'ipad'
  };

  // Lower-cases and strips spaces/hyphens so "Mac", "mac", "MAC" and
  // "Apple Watch" / "applewatch" all compare equal. Mirrors Warranty
  // Wrangler's normalizeFamily() shell function.
  function normalizeFamily(value) {
    return (value || '').toLowerCase().replace(/[\s-]/g, '');
  }

  // Some ABM schemas return a broad family ("iPhone"); others return a
  // more specific label ("iPhone 15"). Treat the latter as part of the
  // requested family as well.
  function familyMatches(value, requestedFamily) {
    const normalized = normalizeFamily(value);
    return normalized === requestedFamily || normalized.startsWith(requestedFamily);
  }

  let scanRunning = false;
  let abortRequested = false;
  let keepAliveHandle = null;

  // ---------------------------------------------------------------------
  // Overlay panel UI
  // ---------------------------------------------------------------------

  function injectPanel() {
    const panel = document.createElement('div');
    panel.id = '*YourORG*-abm-audit-panel';
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
      <div style="font-weight:600; margin-bottom:8px;">*YourORG* Activation Lock Audit</div>
      <div id="*YourORG*-abm-status" style="opacity:0.85; margin-bottom:10px; line-height:1.4;">Idle.</div>
      <div id="*YourORG*-abm-progress-text" style="font-size:11px; opacity:0.78; margin-bottom:4px;">Scan progress: not started</div>
      <div style="height:6px; overflow:hidden; border-radius:3px; background:#3a3a3c; margin-bottom:10px;">
        <div id="*YourORG*-abm-progress-bar" style="height:100%; width:0%; background:#30d158; transition:width 120ms linear;"></div>
      </div>
      <label style="display:block; margin-bottom:8px; font-size:12px;">
        Product family
        <select id="*YourORG*-abm-product-family" style="float:right; max-width:130px; border-radius:4px; border:1px solid #636366; background:#2c2c2e; color:#f5f5f7; padding:2px 4px;">
          <option value="all">All devices</option>
          <option value="mac">Mac</option>
          <option value="iphone">iPhone</option>
          <option value="ipad">iPad</option>
        </select>
      </label>
      <div style="margin:-4px 0 8px; font-size:11px; opacity:0.72; line-height:1.3;">Filter is applied per device as it's checked, so every device is still scanned regardless of family selected - only the saved/exported rows are narrowed.</div>
      <div style="display:flex; gap:6px;">
        <button id="*YourORG*-abm-start" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#0071e3; color:#fff; cursor:pointer;">Start Scan</button>
        <button id="*YourORG*-abm-stop" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#3a3a3c; color:#fff; cursor:pointer;" disabled>Stop</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <button id="*YourORG*-abm-download" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#3a3a3c; color:#fff; cursor:pointer;">Download current results</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <button id="*YourORG*-abm-import" type="button" style="flex:1; padding:6px 8px; border:none; border-radius:6px; background:#3a3a3c; color:#fff; cursor:pointer;">Load source CSV</button>
        <input id="*YourORG*-abm-source-file" type="file" accept=".csv,text/csv" style="display:none;">
      </div>
      <div style="margin-top:6px; font-size:11px; opacity:0.72; line-height:1.3;">Load a previous audit CSV to keep its rows. Existing device IDs will be skipped; new results are appended.</div>
      <div id="*YourORG*-abm-foreground-warning" style="margin-top:10px; font-size:11px; color:#ff9f0a; display:none;">
        Keep this tab in the foreground - backgrounding it can throttle or pause the scan.
      </div>
    `;

    document.body.appendChild(panel);

    document.getElementById('*YourORG*-abm-start').addEventListener('click', onStartClicked);
    document.getElementById('*YourORG*-abm-stop').addEventListener('click', onStopClicked);
    document.getElementById('*YourORG*-abm-download').addEventListener('click', () => {
      exportCsv(currentResults, 'manual');
    });
    document.getElementById('*YourORG*-abm-import').addEventListener('click', () => {
      document.getElementById('*YourORG*-abm-source-file').click();
    });
    document.getElementById('*YourORG*-abm-source-file').addEventListener('change', onSourceFileSelected);

    document.addEventListener('visibilitychange', () => {
      const warning = document.getElementById('*YourORG*-abm-foreground-warning');
      if (!warning) return;
      warning.style.display = (document.hidden && scanRunning) ? 'block' : 'none';
    });
  }

  function setStatus(text) {
    const el = document.getElementById('*YourORG*-abm-status');
    if (el) el.textContent = text;
  }

  function setRunningUiState(running) {
    scanRunning = running;
    const startBtn = document.getElementById('*YourORG*-abm-start');
    const stopBtn = document.getElementById('*YourORG*-abm-stop');
    const productFamily = document.getElementById('*YourORG*-abm-product-family');
    if (startBtn) startBtn.disabled = running;
    if (stopBtn) stopBtn.disabled = !running;
    if (productFamily) productFamily.disabled = running;
  }

  let currentResults = [];
  let sourceFileName = null;
  let totalDevicesInScope = null;

  function selectedProductFamily() {
    const value = document.getElementById('*YourORG*-abm-product-family')?.value || 'all';
    return PRODUCT_FAMILIES[value] ?? null;
  }

  function resetProgress() {
    totalDevicesInScope = null;
    updateProgress(0, currentResults.length, 'not started');
  }

  function updateProgress(scanned, saved, state = '') {
    const text = document.getElementById('*YourORG*-abm-progress-text');
    const bar = document.getElementById('*YourORG*-abm-progress-bar');
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
    setStatus('Stopping after current batch... partial results will be exported.');
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
    const familyColumn = findColumn('devicefamily', 'family', 'producttype', 'devicetype');
    const nameColumn = findColumn('devicename', 'name', 'marketingname');

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
        status: statusColumn === -1 ? 'Unknown' : (row[statusColumn] || 'Unknown').trim(),
        // Older CSVs (pre-v1.8) won't have a family column - default to
        // Unknown rather than dropping the row.
        family: familyColumn === -1 ? 'Unknown' : (row[familyColumn] || 'Unknown').trim(),
        name: nameColumn === -1 ? 'Unknown' : (row[nameColumn] || 'Unknown').trim()
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

    const header = 'deviceId,deviceName,deviceFamily,activationLockType,activationLockStatus\n';
    const rows = results.map(r => [r.id, r.name ?? 'Unknown', r.family ?? 'Unknown', r.lockType, r.status].map(csvEscape).join(',')).join('\n');
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
  //
  // Devices are read from getDevices() one at a time (it internally pages
  // the LIST 350-at-a-time via LIMIT), but are not looked up individually
  // any more. Instead each new (not-already-known) device is pushed into
  // pendingBatch and, once pendingBatch reaches DETAIL_BATCH_SIZE, the
  // whole batch's Activation Lock status is fetched in a single aliased
  // GraphQL request via flushBatch().

  async function runScan(resumeStart, results, productFamily) {
    let processed = results.length;
    let scanPosition = resumeStart;
    let lastAutoDownloadAt = processed;
    const knownDeviceIds = new Set(results.map(result => result.id));
    let pendingBatch = []; // Devices collected but not yet detail-fetched.

    // Fetches Activation Lock status (and device family) for every device
    // currently sitting in pendingBatch, applies the client-side family
    // filter, appends matches to results, then empties pendingBatch.
    async function flushBatch() {
      if (pendingBatch.length === 0) return;

      const batch = pendingBatch;
      pendingBatch = [];

      const detailsBySerial = await getDeviceDetailsBatchSafe(batch.map(device => device.id));

      for (const device of batch) {
        const details = detailsBySerial.get(device.id) || {};
        knownDeviceIds.add(device.id);

        // Client-side filter: every device still has to be fetched to know
        // its family (the server-side ABM filter caused timeouts - see the
        // v1.6 changelog), so this only narrows what gets kept, not scan time.
        results.push({
          id: device.id,
          name: device.name ?? 'Unknown',
          lockType: details.lockType ?? 'Unknown',
          status: details.status ?? 'Unknown',
          family: device.family ?? 'Unknown'
        });
        processed++;
      }

      const filterNote = productFamily ? ` matching ${productFamily}` : '';
      setStatus(`Saved ${processed} devices${filterNote} (scanned ${scanPosition}, batch of ${batch.length})...`);
      updateProgress(scanPosition, processed);
      saveCheckpoint(scanPosition, results, productFamily);

      if (processed - lastAutoDownloadAt >= AUTO_DOWNLOAD_EVERY) {
        exportCsv(results, 'checkpoint');
        lastAutoDownloadAt = processed;
      }
    }

    try {
      setStatus('Fetching the device list…');
      for await (const device of getDevices(resumeStart, productFamily)) {
        if (abortRequested) {
          // Flush whatever is already buffered so nothing already pulled
          // from the device list is lost, then stop.
          await flushBatch();
          saveCheckpoint(scanPosition, results, productFamily);
          setStatus(`Stopped by user at ${processed} saved devices. Exporting partial results.`);
          updateProgress(scanPosition, processed, 'stopped');
          if (results.length) exportCsv(results, 'stopped');
          return;
        }

        scanPosition++;

        // The family is returned by ABM's documented-in-practice device-list
        // shape: Device.searchInfo.productFamily. Filter before requesting
        // Activation Lock details, avoiding unnecessary detail calls.
        if (productFamily && !familyMatches(device.family, productFamily)) {
          updateProgress(scanPosition, processed, 'device family skipped');
          continue;
        }

        // A loaded source file is the baseline. Do not re-query a device
        // already present in it (or one restored from a checkpoint).
        if (knownDeviceIds.has(device.id)) {
          setStatus(`Skipped existing device ${scanPosition}; ${processed} rows retained...`);
          updateProgress(scanPosition, processed, 'existing device skipped');
          if (scanPosition % 50 === 0) saveCheckpoint(scanPosition, results, productFamily);
          continue;
        }

        pendingBatch.push(device);

        if (pendingBatch.length >= DETAIL_BATCH_SIZE) {
          await flushBatch();
          await sleep(THROTTLE_MS);
        }
      }

      // Flush any leftover devices that did not fill a complete batch.
      await flushBatch();

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

  // Batch-fetches Activation Lock status for many serials in one request.
  // for many serials in one aliased GraphQL request. Returns a Map of
  // serial -> { lockType, status, family }.
  //
  async function getDeviceDetailsBatchSafe(serials) {
    try {
      return await retry(() => getDeviceDetailsBatchRaw(serials));
    } catch (e) {
      console.warn(`[BATCH DETAILS] Batch of ${serials.length} failed, falling back to individual requests:`, e);
      const detailsBySerial = new Map();
      for (const serial of serials) {
        const device = await getDeviceDetailsSafe(serial);
        detailsBySerial.set(serial, {
          lockType: device?.activationLockStatus?.lockType ?? 'Unknown',
          status: device?.activationLockStatus?.status ?? 'Unknown',
          family: 'Unknown'
        });
        await sleep(THROTTLE_MS);
      }
      return detailsBySerial;
    }
  }

  // Builds and sends a single GraphQL request covering multiple serials,
  // using a distinct alias (d0, d1, d2 ...) and variable ($s0, $s1, $s2 ...)
  // per device, since GraphQL requires unique field/variable names within
  // one query. Returns a Map of serial -> { lockType, status, family }.
  async function getDeviceDetailsBatchRaw(serials) {
    const variableDefs = serials.map((_, i) => `$s${i}: String!`).join(', ');
    const aliasFields = serials
      .map((_, i) => `d${i}: device(serial: $s${i}) { activationLockStatus { lockType status } }`)
      .join('\n        ');
    const variables = {};
    serials.forEach((serial, i) => { variables[`s${i}`] = serial; });

    const data = await graphqlRaw({
      operationName: 'GetDeviceDetailsBatch',
      variables,
      query: `query GetDeviceDetailsBatch(${variableDefs}) {
        ${aliasFields}
      }`
    });

    const detailsBySerial = new Map();
    serials.forEach((serial, i) => {
      const node = data[`d${i}`];
      detailsBySerial.set(serial, {
        lockType: node?.activationLockStatus?.lockType ?? 'Unknown',
        status: node?.activationLockStatus?.status ?? 'Unknown',
        family: 'Unknown'
      });
    });
    return detailsBySerial;
  }

  // Single-device fallback lookup, used only when a batch request fails.
  async function getDeviceDetailsSafe(deviceId) {
    try {
      return await retry(() => getDeviceDetails(deviceId));
    } catch (e) {
      console.error(`Failed to retrieve ${deviceId} after retries`, e);
      return null;
    }
  }

  async function* getDevices(startAt = 0, productFamily = null) {
    // Native ABM responses confirm product family is nested under searchInfo.
    // Request it alongside the ID; no GetDeviceDetails schema guess is needed.
    for await (const device of getObjects(
      'PaginatedDevicesList',
      `query PaginatedDevicesList($limit: Int, $start: Int) {
        page: paginatedDeviceSearch(inputV2: {limit: $limit, start: $start}) {
          nodes { id searchInfo { deviceName productFamily } }
          totalCount
        }
      }`,
      startAt
    )) {
      yield {
        id: device.id,
        name: device.searchInfo?.deviceName ?? 'Unknown',
        family: device.searchInfo?.productFamily ?? 'Unknown'
      };
    }
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

  // Sends a GraphQL request and returns the FULL data object (used for
  // multi-alias batch queries where there is more than one top-level
  // field in the response).
  async function graphqlRaw(query) {
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

      // Apple frequently returns its useful GraphQL validation message in
      // the body of a 400 response. Read it before throwing so the status
      // panel and DevTools console identify the rejected field/query.
      const payload = await r.json().catch(() => null);
      if (!r.ok) {
        const detail = payload?.errors || payload?.message || payload;
        const error = new Error(`HTTP ${r.status}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
        // 400-series responses (apart from rate limiting) are request or
        // schema errors and repeating them cannot make them succeed.
        error.nonRetryable = r.status >= 400 && r.status < 500 && r.status !== 429;
        throw error;
      }

      const { data, errors } = payload || {};
      if (errors?.length) {
        const error = new Error(JSON.stringify(errors));
        error.nonRetryable = true;
        throw error;
      }
      return data;
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`${query.operationName} timed out after ${FETCH_TIMEOUT_MS / 1000} seconds`);
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Convenience wrapper for single-top-level-field queries (device list
  // paging, single-device lookup, keepalive) - returns just that one field.
  async function graphql(query) {
    const data = await graphqlRaw(query);
    return Object.values(data)[0];
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

