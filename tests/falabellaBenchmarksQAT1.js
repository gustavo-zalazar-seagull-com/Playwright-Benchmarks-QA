// @ts-check
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { extractFirstRowValueInRange } from './helpers/reportRows';

const BASE_URL = 'https://fala.vizix.cloud';
const LOGIN_URL = `${BASE_URL}/console/#/login`;
const REPORT_URL = `${BASE_URL}/console/#/app/analytics/report/execution/14599`;

// Today's date in YYYY-MM-DD format (used for file names) and MM/DD/YYYY (used for date picker input)
const _now = new Date();
const TODAY = [
  _now.getFullYear(),
  String(_now.getMonth() + 1).padStart(2, '0'),
  String(_now.getDate()).padStart(2, '0'),
].join('-');

/**
 * Converts a 24-hour HH:MM:SS time string to the picker format: MM/DD/YYYY HH:MM:SS AM/PM
 * e.g. '03:45:00' → '05/31/2026 03:45:00 AM'
 * @param {string} t  HH:MM:SS (24-hour)
 */
const toPickerDateTime = (t) => {
  const mm = String(_now.getMonth() + 1).padStart(2, '0');
  const dd = String(_now.getDate()).padStart(2, '0');
  const yyyy = _now.getFullYear();
  const [hStr, mStr, sStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${mm}/${dd}/${yyyy} ${String(h).padStart(2, '0')}:${mStr}:${sStr} ${suffix}`;
};

// Time ranges per section — add or adjust entries here
const RECEIVING_RANGES = [
  { startTime: '03:45:00', endTime: '04:00:00' },
  { startTime: '04:00:00', endTime: '04:15:00' },
  { startTime: '04:15:00', endTime: '04:30:00' },
];

const INVENTORY_RANGES = [
  { startTime: '04:45:00', endTime: '05:00:00' },
  { startTime: '05:00:00', endTime: '05:15:00' },
  { startTime: '05:15:00', endTime: '05:30:00' },
];

// Combined list with section label and per-section index/total
const ALL_RANGES = [
  ...RECEIVING_RANGES.map((r, i) => ({ ...r, section: 'Receiving', rangeIndex: i, rangeTotal: RECEIVING_RANGES.length })),
  ...INVENTORY_RANGES.map((r, i) => ({ ...r, section: 'Inventory', rangeIndex: i, rangeTotal: INVENTORY_RANGES.length })),
];

/** @type {{ rangeLabel: string, noData?: boolean, startSend: string, endVizix: string, endCubes: string, vizixTime: string, cubesTime: string }[]} */
const receivingResults = [];

/** @type {{ rangeLabel: string, noData?: boolean, startSend: string, endVizix: string, endCubes: string, vizixTime: string, cubesTime: string }[]} */
const inventoryResults = [];

/**
 * Formats a millisecond duration as H:MM:SS.
 * @param {number} ms
 */
const formatDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid benchmark duration: ${ms}`);
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * Converts a 24-hour time string (HH:MM:SS) to 12-hour AM/PM format (for labels).
 * @param {string} t
 */
const toAmPm = (t) => {
  const [hStr, mStr, sStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${mStr}:${sStr} ${suffix}`;
};

/** @type {import('@playwright/test').Page} */
let sharedPage;

test.describe('Falabella [QAT1] DailyMetrics Report', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    // Arrange: load credentials from environment variables
    const username = process.env.FALABELLA_QAT1_USER ?? '';
    const password = process.env.FALABELLA_QAT1_PASS ?? '';

    if (!username || !password) {
      throw new Error('FALABELLA_QAT1_USER and FALABELLA_QAT1_PASS must be set in .env');
    }

    // Create a single browser context and page reused across all range tests
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    sharedPage = await context.newPage();

    // Act: navigate to login page and authenticate once
    await sharedPage.goto(LOGIN_URL);
    await sharedPage.waitForLoadState('networkidle');

    await sharedPage.getByRole('textbox', { name: /username/i }).fill(username);
    await sharedPage.getByRole('textbox', { name: /password/i }).fill(password);
    await sharedPage.getByRole('button', { name: /login/i }).click();

    // Wait for login to complete — try URL change first, fall back to networkidle
    try {
      await sharedPage.waitForURL((url) => !url.hash.includes('/login'), { timeout: 60_000 });
    } catch {
      await sharedPage.waitForLoadState('networkidle', { timeout: 60_000 });
    }
    if (sharedPage.url().includes('/login')) {
      throw new Error(`QAT1 authentication did not complete. Still on login page: ${sharedPage.url()}`);
    }
  });

  for (const { startTime, endTime, section, rangeIndex, rangeTotal } of ALL_RANGES) {
  test(`[${section}] ${startTime} → ${endTime}`, async () => {
    const page = sharedPage;
    test.setTimeout(300_000);

    const TOTAL_STEPS = 6;
    const rangeNum = rangeIndex + 1;
    const rangeTag = `[${section} ${rangeNum}/${rangeTotal}: ${startTime} → ${endTime}]`;

    /**
     * Overwrites the current terminal line with an updated progress bar.
     * Prints a newline only when the last step is reached.
     * @param {number} step
     * @param {string} label
     */
    const progress = (step, label) => {
      const filled = Math.round((step / TOTAL_STEPS) * 20);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      const pct = Math.round((step / TOTAL_STEPS) * 100);
      const line = `${rangeTag} [${bar}] ${pct}% — ${label}`;
      // Pad to 120 chars to overwrite any leftover characters from a longer previous line
      process.stdout.write(`\r${line.padEnd(120)}`);
      if (step === TOTAL_STEPS) process.stdout.write('\n');
    };

    // QAT1 date picker expects MM/DD/YYYY HH:MM:SS AM/PM (e.g. 05/31/2026 03:45:00 AM)
    const START_DATE = toPickerDateTime(startTime);
    const END_DATE   = toPickerDateTime(endTime);

    // Act: navigate to the report execution page
    progress(1, 'Navigating to report page...');
    await page.goto(REPORT_URL);
    await page.waitForLoadState('networkidle');

    // The report UI is rendered inside an iframe — all selectors must go through frameLocator
    const reportIframe = page.locator('iframe').first();
    try {
      await reportIframe.waitFor({ state: 'visible', timeout: 120_000 });
    } catch {
      throw new Error(`Report iframe did not become visible. URL: ${page.url()} | Title: ${await page.title()} | Iframes: ${await page.locator('iframe').count()}`);
    }
    const frame = page.frameLocator('iframe');

    /**
     * @param {string} columnName
     */
    const extractFirstRowValue = async (columnName) => {
      return extractFirstRowValueInRange(frame, columnName, START_DATE, END_DATE);
    };

    /**
     * Dismisses the "Please take time to send us your feedback" overlay.
     * The overlay may be rendered in the iframe OR the main page — checks both.
     */
    const dismissFeedbackOverlay = async () => {
      for (const ctx of [page, frame]) {
        const closeButton = ctx.locator('.overlay-container .close-toast').first();
        if (!(await closeButton.isVisible())) continue;
        await closeButton.click();
        await expect(closeButton).toBeHidden();
      }
    };

    /** @param {() => Promise<void>} action */
    const waitForReportReady = async (action) => {
      const loadingIndicator = frame.locator('[translate="@REPORT_LOADING_MESSAGE"]');
      const [response] = await Promise.all([
        page.waitForResponse(response =>
          new URL(response.url()).pathname === '/riot-core-services/api/reportExecution/14599' &&
          response.request().method() === 'POST', { timeout: 120_000 }),
        action(),
      ]);
      expect(response.ok(), 'Report execution request failed').toBe(true);
      expect(await response.finished(), 'Report response did not finish').toBeNull();
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 120_000 });
      await expect(frame.getByRole('button', { name: 'Run', exact: true })).not.toHaveClass(/\bdisabled\b/, { timeout: 120_000 });
    };

    /**
     * @param {import('@playwright/test').Locator} headerLocator
     * @param {'asc' | 'desc'} desired
     */
    const ensureSortDirection = async (headerLocator, desired) => {
      const icon = desired === 'asc' ? '.icon-table-sortingup' : '.icon-table-sortingdown';
      await expect(headerLocator).toHaveClass(/\bactive\b/);
      await expect(headerLocator.locator(icon)).toBeVisible();
    };

    // Wait for the Date dropdown (first <select> in the filter table)
    const dateSelect = frame.locator('select').first();
    try {
      await dateSelect.waitFor({ state: 'visible', timeout: 120_000 });
    } catch {
      throw new Error(`Report controls did not load inside iframe. URL: ${page.url()} | Title: ${await page.title()} | Iframes: ${await page.locator('iframe').count()}`);
    }
    await dismissFeedbackOverlay();

    // Ensure "Custom" is selected so the date textboxes are active
    await dateSelect.selectOption({ label: 'Custom' });

    // The date row has many unrelated hidden inputs elsewhere in the page.
    // Restrict to the two visible text inputs rendered for Start Date / End Date.
    const dateInputs = frame.locator('tr:has-text("Start Date") input[type="text"]:visible');
    const startInput = dateInputs.first();
    const endInput = dateInputs.nth(1);

    await startInput.waitFor({ state: 'visible', timeout: 30_000 });
    await endInput.waitFor({ state: 'visible', timeout: 10_000 });
    expect(new Date(`${TODAY}T${startTime}`).getTime(), 'Start Date must precede End Date').toBeLessThan(new Date(`${TODAY}T${endTime}`).getTime());

    // Clear end date first so the UI's start-before-end validation does not
    // fire while an intermediate start value exceeds the previous end value.
    // Do NOT press Tab after clearing end — Angular's blur handler would
    // auto-fill it with a next-day default, corrupting the subsequent fill.
    await endInput.click({ force: true });
    await endInput.press('Control+A');
    await endInput.press('Backspace');

    await startInput.click({ force: true });
    await startInput.press('Control+A');
    await startInput.press('Backspace');
    await startInput.pressSequentially(START_DATE, { delay: 40 });
    await startInput.press('Tab');

    await endInput.click({ force: true });
    await endInput.press('Control+A');
    await endInput.press('Backspace');
    await endInput.pressSequentially(END_DATE, { delay: 40 });
    await endInput.press('Tab');
    await expect(startInput).toHaveValue(START_DATE);
    await expect(endInput).toHaveValue(END_DATE);

    // Dismiss overlay again before clicking Run — it can reappear after date entry
    await dismissFeedbackOverlay();

    progress(2, 'Setting date range and running report...');
    await waitForReportReady(() => frame.getByRole('button', { name: 'Run', exact: true }).click());

    // Determine quickly whether we have data or a "No records" state.
    // This avoids waiting for header timeouts when the no-records banner appears first.
    const tsEdgeInHeader = frame.locator('table.fixed-report-header th', { hasText: 'tsEdgeIn' });
    const noRecordsMessage = frame.locator('text=No records to display').first();
    const runOutcome = await Promise.any([
      tsEdgeInHeader.waitFor({ state: 'visible', timeout: 120_000 }).then(() => 'hasData'),
      noRecordsMessage.waitFor({ state: 'visible', timeout: 120_000 }).then(() => 'noData'),
    ]).catch(() => 'timeout');

    if (runOutcome === 'timeout') {
      throw new Error('Timed out waiting for report results grid or "No records to display" message.');
    }

    if (runOutcome === 'noData') {
      const rangeLabel = `${toAmPm(startTime)} - ${toAmPm(endTime)}`;
      const sentinel = { rangeLabel, noData: true, startSend: '-', endVizix: '-', endCubes: '-', vizixTime: '-', cubesTime: '-' };
      if (section === 'Receiving') receivingResults.push(sentinel);
      else inventoryResults.push(sentinel);
      progress(TOTAL_STEPS, 'No records to display — skipping range.');
      return;
    }
    progress(3, 'Sorting by tsEdgeIn ascending (▲), waiting for report...');
    await waitForReportReady(() => tsEdgeInHeader.click());
    await ensureSortDirection(tsEdgeInHeader, 'asc');

    // Re-check for no-records: the tsEdgeIn header may appear briefly before the
    // empty-table state settles, causing the hasData branch to be taken incorrectly.
    if (await noRecordsMessage.isVisible()) {
      const rangeLabel = `${toAmPm(startTime)} - ${toAmPm(endTime)}`;
      const sentinel = { rangeLabel, noData: true, startSend: '-', endVizix: '-', endCubes: '-', vizixTime: '-', cubesTime: '-' };
      if (section === 'Receiving') receivingResults.push(sentinel);
      else inventoryResults.push(sentinel);
      progress(TOTAL_STEPS, 'No records to display — skipping range.');
      return;
    }

    const tsEdgeInData = await extractFirstRowValue('tsEdgeIn');

    // Retrieve and log result rows from the report table
    console.log(`Report rows returned for ${START_DATE} → ${END_DATE}: ${tsEdgeInData.resultsRowCount}`);
    console.log(`First row tsEdgeIn value: ${tsEdgeInData.firstRowValue}`);

    const tsCoreInHeader = frame.locator('table.fixed-report-header th', { hasText: 'tsCoreIn' });
    await tsCoreInHeader.waitFor({ state: 'visible', timeout: 30_000 });
    progress(4, 'Sorting by tsCoreIn ascending (▲), waiting for report...');
    await waitForReportReady(() => tsCoreInHeader.click());
    // Verify arrow is pointing up (ascending) for tsCoreIn - ensure it's correct
    await ensureSortDirection(tsCoreInHeader, 'asc');

    // Take the first row value after ascending sort (no pick min/max)
    const tsCoreInData = await extractFirstRowValue('tsCoreIn');
    console.log(`First row tsCoreIn value: ${tsCoreInData.firstRowValue}`);

    // Click on tsMongoIn header and ensure descending sort
    const tsMongoInHeader = frame.locator('table.fixed-report-header th', { hasText: 'tsMongoIn' });
    await tsMongoInHeader.waitFor({ state: 'visible', timeout: 30_000 });
    progress(5, 'Sorting by tsMongoIn descending (▼), waiting for report...');
    // Requirement: tsMongoIn is clicked twice, waiting for the report between clicks.
    await waitForReportReady(() => tsMongoInHeader.click());
    await ensureSortDirection(tsMongoInHeader, 'asc');

    progress(6, 'Applying second tsMongoIn click and verifying descending (▼)...');
    await waitForReportReady(() => tsMongoInHeader.click());
    await ensureSortDirection(tsMongoInHeader, 'desc');

    const tsMongoInData = await extractFirstRowValue('tsMongoIn');

    console.log(`First row tsMongoIn value: ${tsMongoInData.firstRowValue}`);

    // Calculate time difference between tsMongoIn and tsEdgeIn
    /** @param {string} dateString */
    const parseTime = (dateString) => {
      expect(dateString, 'Unexpected report timestamp format').toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2} (AM|PM)$/);
      const timestamp = new Date(dateString).getTime();
      expect(Number.isFinite(timestamp), 'Invalid report timestamp').toBe(true);
      return timestamp;
    };
    const tsEdgeInMs = parseTime(tsEdgeInData.firstRowValue);
    const tsMongoInMs = parseTime(tsMongoInData.firstRowValue);
    const timeDifferenceMs = tsMongoInMs - tsEdgeInMs;
    const timeDifferenceSeconds = timeDifferenceMs / 1000;

    console.log(`Time difference (tsMongoIn - tsEdgeIn): ${timeDifferenceSeconds}s (${timeDifferenceMs}ms)`);

    // Zero or more rows is valid depending on data availability
    expect(tsEdgeInData.firstRowValue).not.toBe('');
    expect(tsCoreInData.firstRowValue).not.toBe('');
    expect(tsMongoInData.firstRowValue).not.toBe('');

    // Accumulate for summary table
    const tsCoreInMs = parseTime(tsCoreInData.firstRowValue);
    const cubesDiffMs = tsCoreInMs - tsEdgeInMs;
    expect(tsCoreInMs, 'tsCoreIn must be greater than or equal to tsEdgeIn').toBeGreaterThanOrEqual(tsEdgeInMs);
    expect(tsMongoInMs, 'tsMongoIn must be greater than or equal to tsEdgeIn').toBeGreaterThanOrEqual(tsEdgeInMs);
    const rowData = {
      rangeLabel: `${toAmPm(startTime)} - ${toAmPm(endTime)}`,
      startSend: new Date(tsEdgeInMs).toTimeString().slice(0, 8),
      endVizix:  new Date(tsMongoInMs).toTimeString().slice(0, 8),
      endCubes:  new Date(tsCoreInMs).toTimeString().slice(0, 8),
      vizixTime: formatDuration(timeDifferenceMs),
      cubesTime: formatDuration(cubesDiffMs),
    };
    if (section === 'Receiving') receivingResults.push(rowData);
    else inventoryResults.push(rowData);
  });
  } // end for ALL_RANGES

  test.afterAll(async () => {
    // Close the shared browser context created in beforeAll
    await sharedPage?.context().close();

    const COL = { startSend: 10, endVizix: 10, endCubes: 10, vizixTime: 10, cubesTime: 10 };
    const pad = (/** @type {string} */ s, /** @type {number} */ w) => s.padEnd(w);
    const colLine = '+' + [COL.startSend, COL.endVizix, COL.endCubes, COL.vizixTime, COL.cubesTime]
      .map((w) => '-'.repeat(w + 2)).join('+') + '+';
    const vizixCol = { range: 28, vizixTime: 12 };
    const vizixPad = (/** @type {string} */ s, /** @type {number} */ w) => s.padEnd(w);
    const vizixLine = '+' + [vizixCol.range, vizixCol.vizixTime].map((w) => '-'.repeat(w + 2)).join('+') + '+';

    /**
     * Prints full benchmark table + Vizix summary for one section.
     * @param {string} sectionName
     * @param {typeof receivingResults} data
     */
    const printSection = (sectionName, data) => {
      for (const r of data) {
        console.log(`\n=== Benchmark Summary: QAT1 - ${sectionName} - Today ${r.rangeLabel} ===`);
        console.log(colLine);
        console.log('| ' + [pad('tsEdgeIn', COL.startSend), pad('tsMongoin', COL.endVizix), pad('tsCoreIn', COL.endCubes), pad('Vizix time', COL.vizixTime), pad('Cubes time', COL.cubesTime)].join(' | ') + ' |');
        console.log('| ' + [pad('start send', COL.startSend), pad('end Vizix', COL.endVizix), pad('end Cubes', COL.endCubes), pad('', COL.vizixTime), pad('', COL.cubesTime)].join(' | ') + ' |');
        console.log(colLine);
        if (r.noData) {
          const totalWidth = Object.values(COL).reduce((s, w) => s + w + 3, 0) - 1;
          console.log('| ' + 'No records to display'.padEnd(totalWidth) + ' |');
        } else {
          console.log('| ' + [pad(r.startSend, COL.startSend), pad(r.endVizix, COL.endVizix), pad(r.endCubes, COL.endCubes), pad(r.vizixTime, COL.vizixTime), pad(r.cubesTime, COL.cubesTime)].join(' | ') + ' |');
        }
        console.log(colLine);
      }
      console.log(`\n=== Vizix Time Summary ${sectionName} (tsMongoIn - tsEdgeIn) ===`);
      console.log(vizixLine);
      console.log('| ' + [vizixPad('Time Range', vizixCol.range), vizixPad('Vizix Time', vizixCol.vizixTime)].join(' | ') + ' |');
      console.log(vizixLine);
      for (const r of data) {
        console.log('| ' + [vizixPad(r.rangeLabel, vizixCol.range), vizixPad(r.vizixTime, vizixCol.vizixTime)].join(' | ') + ' |');
      }
      console.log(vizixLine);
    };

    printSection('Receiving', receivingResults);
    printSection('Inventory', inventoryResults);

    // --- HTML Report ---
    /**
     * Builds an HTML section block for one process group.
     * @param {string} sectionName
     * @param {string} emoji
     * @param {typeof RECEIVING_RANGES} ranges
     * @param {typeof receivingResults} data
     */
    const buildHtmlSection = (sectionName, emoji, ranges, data) => {
      const tableRows = data.map((r) => r.noData ? `
        <tr>
          <td>${r.rangeLabel}</td>
          <td colspan="5" class="no-data">No records to display</td>
        </tr>` : `
        <tr>
          <td>${r.rangeLabel}</td>
          <td>${r.startSend}</td>
          <td>${r.endVizix}</td>
          <td>${r.endCubes}</td>
          <td class="highlight">${r.vizixTime}</td>
          <td>${r.cubesTime}</td>
        </tr>`).join('');
      const vizixRows = data.map((r) => r.noData ? `
        <tr>
          <td>${r.rangeLabel}</td>
          <td class="no-data">No records to display</td>
        </tr>` : `
        <tr>
          <td>${r.rangeLabel}</td>
          <td class="highlight">${r.vizixTime}</td>
        </tr>`).join('');
      return `
  <div class="section">
    <div class="section-title">${emoji} ${sectionName}</div>
    <div class="section-meta">Ranges: ${ranges.map((r) => `${toAmPm(r.startTime)} &ndash; ${toAmPm(r.endTime)}`).join(', ')}</div>
    <h2>Full Results</h2>
    <table>
      <thead>
        <tr>
          <th rowspan="2">Time Range</th>
          <th>tsEdgeIn</th>
          <th>tsMongoin</th>
          <th>tsCoreIn</th>
          <th>Vizix Time</th>
          <th>Cubes Time</th>
        </tr>
        <tr>
          <th class="sub">start send</th>
          <th class="sub">end Vizix</th>
          <th class="sub">end Cubes</th>
          <th class="sub"></th>
          <th class="sub"></th>
        </tr>
      </thead>
      <tbody>${tableRows}
      </tbody>
    </table>
    <h2>Vizix Time Summary &mdash; ${sectionName} (tsMongoIn &minus; tsEdgeIn)</h2>
    <table>
      <thead>
        <tr><th>Time Range</th><th>Vizix Time</th></tr>
      </thead>
      <tbody>${vizixRows}
      </tbody>
    </table>
  </div>`;
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QAT1 Benchmark Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; background: #f4f4f4; color: #222; }
    h1 { color: #1a1a2e; }
    h2 { color: #16213e; margin-top: 40px; }
    .section { margin-bottom: 56px; }
    .section-title { font-size: 1.3em; font-weight: bold; background: #1a1a2e; color: #fff; padding: 10px 16px; border-radius: 4px 4px 0 0; margin-bottom: 0; }
    .section-meta { color: #555; font-size: 0.9em; background: #fff3e0; padding: 7px 16px; margin: 0 0 16px 0; border-radius: 0 0 4px 4px; }
    table { border-collapse: collapse; width: 100%; max-width: 860px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    th { background: #e65100; color: #fff; padding: 10px 14px; text-align: left; }
    th.sub { background: #bf360c; font-size: 0.85em; }
    td { padding: 9px 14px; border-bottom: 1px solid #ddd; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fff3e0; }
    .highlight { font-weight: bold; color: #d62828; }
    .no-data { color: #888; font-style: italic; }
    .meta { color: #555; font-size: 0.95em; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>QAT1 &mdash; Benchmark Results</h1>
  <p class="meta">Date: ${TODAY}</p>
${buildHtmlSection('Receiving', '&#128230;', RECEIVING_RANGES, receivingResults)}
${buildHtmlSection('Inventory', '&#128218;', INVENTORY_RANGES, inventoryResults)}
</body>
</html>`;

    const outDir = join(process.cwd(), 'benchmark-results');
    mkdirSync(outDir, { recursive: true });
    const reportPath = join(outDir, `benchmark-results-QAT1-${TODAY}.html`);
    writeFileSync(reportPath, html, 'utf-8');
    console.log(`\nHTML report saved to: ${reportPath}`);
  });
});
