// @ts-check
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE_URL = 'https://falabella.sandbox.ytem.io';
const LOGIN_URL = `${BASE_URL}/console/#/login`;
const REPORT_URL = `${BASE_URL}/console/#/app/analytics/report/execution/14599`;

// Today's date in YYYY-MM-DD format (used for file names) and MM/DD/YYYY (used for date picker input)
const _now = new Date();
const TODAY = [
  _now.getFullYear(),
  String(_now.getMonth() + 1).padStart(2, '0'),
  String(_now.getDate()).padStart(2, '0'),
].join('-');
// MM/DD/YYYY format expected by the report date picker
const TODAY_MDY = [
  String(_now.getMonth() + 1).padStart(2, '0'),
  String(_now.getDate()).padStart(2, '0'),
  _now.getFullYear(),
].join('/');

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
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/**
 * Converts a 24-hour time string (HH:MM:SS) to 12-hour AM/PM format.
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

test.describe('Falabella [Sandbox] DailyMetrics Report', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    // Arrange: load credentials from environment variables
    const username = process.env.FALABELLA_SAND_USER ?? '';
    const password = process.env.FALABELLA_SAND_PASS ?? '';

    if (!username || !password) {
      throw new Error('FALABELLA_SAND_USER and FALABELLA_SAND_PASS must be set in .env');
    }

    // Create a single browser context and page reused across all range tests
    const context = await browser.newContext();
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
      throw new Error(`Sand authentication did not complete. Still on login page: ${sharedPage.url()}`);
    }
  });

  test.afterAll(async () => {
    await sharedPage?.context().close();
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

    // Sand date picker expects MM/DD/YYYY HH:MM:SS AM/PM (e.g. 06/01/2026 04:45:00 AM)
    const fmtPickerTime = (/** @type {string} */ t) => {
      const [hStr, mStr, sStr] = t.split(':');
      let h = parseInt(hStr, 10);
      const suffix = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${String(h).padStart(2, '0')}:${mStr}:${sStr} ${suffix}`;
    };
    const START_DATE = `${TODAY_MDY} ${fmtPickerTime(startTime)}`;
    const END_DATE   = `${TODAY_MDY} ${fmtPickerTime(endTime)}`;

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
     * @param {{ preferStableTopValue?: boolean, timeRange?: { start: string, end: string }, pick?: 'first' | 'min' | 'max' }} [options]
     */
    const extractFirstRowValue = async (columnName, options = {}) => {
      return frame.locator('body').evaluate((body, { targetColumnName, timeRange }) => {
        const tables = [...body.ownerDocument.querySelectorAll('table')];
        const table = tables.find((candidate) => {
          const headerRows = [...candidate.querySelectorAll('tr')].filter((row) =>
            [...row.querySelectorAll('th')].some((th) => th.textContent?.trim() === targetColumnName)
          );

          if (!headerRows.length) {
            return false;
          }

          return [...candidate.querySelectorAll('tbody tr')].some(
            (row) => row.querySelectorAll('td').length >= 10
          );
        });

        if (!table) {
          throw new Error(`Could not locate the results table containing ${targetColumnName}`);
        }

        const headerRows = [...table.querySelectorAll('tr')].filter((row) =>
          [...row.querySelectorAll('th')].some((th) => th.textContent?.trim() === targetColumnName)
        );
        const headerRow = headerRows[headerRows.length - 1];
        const headers = [...headerRow.querySelectorAll('th')].map((th) => th.textContent?.trim() ?? '');
        const targetColumnIndex = headers.indexOf(targetColumnName);

        if (targetColumnIndex < 0) {
          throw new Error(`Could not determine ${targetColumnName} column index`);
        }

        const allDataRows = [...table.querySelectorAll('tbody tr')].filter(
          (row) => row.querySelectorAll('td').length >= headers.length
        );

        // If a time range is provided, keep only rows whose target-column timestamp
        // falls within [start, end) so out-of-range values sorted to the top are skipped.
        const parseHMS = (/** @type {string} */ hms) => {
          const [h, m, s] = hms.split(':').map(Number);
          return h * 3600 + m * 60 + s;
        };
        const toSecondsOfDay = (/** @type {string} */ val) => {
          // Parse HH:MM:SS directly to avoid timezone shifts from Date parsing.
          const match = val.match(/(\d{1,2}):(\d{2}):(\d{2})/);
          if (!match) return -1;
          const hh = Number(match[1]);
          const mm = Number(match[2]);
          const ss = Number(match[3]);
          return hh * 3600 + mm * 60 + ss;
        };

        let dataRows = allDataRows;
        if (timeRange) {
          const startSecs = parseHMS(timeRange.start);
          const endSecs   = parseHMS(timeRange.end);
          const inRange = allDataRows.filter((row) => {
            const cells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
            const normalized = cells.slice(-headers.length);
            const secs = toSecondsOfDay(normalized[targetColumnIndex] ?? '');
            return secs >= startSecs && secs < endSecs;
          });
          if (inRange.length > 0) dataRows = inRange;
        }

        const firstDataRow = dataRows[0];

        const topValues = dataRows.slice(0, 5).map((row) => {
          const rowCells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
          const normalizedRowCells = rowCells.slice(-headers.length);
          return normalizedRowCells[targetColumnIndex] ?? '';
        });
        const topRows = dataRows.slice(0, 5).map((row) => {
          const rowCells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
          const normalizedRowCells = rowCells.slice(-headers.length);
          return Object.fromEntries(headers.map((h, idx) => [h, normalizedRowCells[idx] ?? '']));
        });
        const columnValues = dataRows.map((row) => {
          const rowCells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
          const normalizedRowCells = rowCells.slice(-headers.length);
          return normalizedRowCells[targetColumnIndex] ?? '';
        });
        const allRows = dataRows.map((row) => {
          const rowCells = [...row.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
          const normalizedRowCells = rowCells.slice(-headers.length);
          return Object.fromEntries(headers.map((h, idx) => [h, normalizedRowCells[idx] ?? '']));
        });

        if (!firstDataRow) {
          throw new Error('Could not locate the first results row');
        }

        const cells = [...firstDataRow.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? '');
        const normalizedCells = cells.slice(-headers.length);

        return {
          firstRowValue: normalizedCells[targetColumnIndex] ?? '',
          resultsRowCount: allDataRows.length,
          topValues,
          topRows,
          allRows,
          columnValues,
        };
      }, { targetColumnName: columnName, timeRange: options.timeRange ?? null }).then((result) => {
        const { preferStableTopValue = false, pick = 'first' } = options;

        if (pick !== 'first') {
          const parseValueMs = (/** @type {string} */ value) => {
            const match = value.match(/(\d{1,2}):(\d{2}):(\d{2})/);
            if (!match) return NaN;
            const hh = Number(match[1]);
            const mm = Number(match[2]);
            const ss = Number(match[3]);
            return (hh * 3600 + mm * 60 + ss) * 1000;
          };

          const sourceValues = result.columnValues ?? result.topValues;
          const candidates = sourceValues
            .filter(Boolean)
            .map((value) => ({ value, ms: parseValueMs(value) }))
            .filter((v) => !isNaN(v.ms));
          if (candidates.length > 0) {
            let selected = candidates[0];
            for (const c of candidates.slice(1)) {
              if (pick === 'min' && c.ms < selected.ms) selected = c;
              if (pick === 'max' && c.ms > selected.ms) selected = c;
            }
            const selectedIndex = sourceValues.findIndex((v) => v === selected.value);
            return {
              ...result,
              firstRowValue: selected.value,
              selectedRow: selectedIndex >= 0 ? (result.allRows?.[selectedIndex] ?? null) : null,
            };
          }
        }

        if (
          preferStableTopValue &&
          result.topValues.length >= 3 &&
          result.topValues[0] !== result.topValues[1] &&
          result.topValues[1] === result.topValues[2]
        ) {
          return {
            ...result,
            firstRowValue: result.topValues[1],
          };
        }

        return result;
      });
    };

    /**
     * Waits until the "Loading report..." indicator inside the iframe is gone.
     * The indicator is controlled by ng-if so it is added/removed from the DOM.
     */
    const waitForReportReady = async () => {
      const loadingIndicator = frame.locator('[translate="@REPORT_LOADING_MESSAGE"]');
      // Give the click a moment to trigger the loading state
      await page.waitForTimeout(500);
      // Wait for the loading indicator to appear (it may take a few seconds after the click).
      // This try/catch is intentionally separate from the "wait for hidden" block below so
      // that a slow-appearing indicator (> 3 s) does not cause us to skip the hidden wait.
      try {
        await loadingIndicator.waitFor({ state: 'visible', timeout: 3_000 });
      } catch {
        // Indicator didn't appear within 3 s — may have appeared and gone already, or never shown
      }
      // Always wait for the indicator to be gone before proceeding.
      // If it was never in the DOM this resolves immediately; if it appeared late we still catch it.
      try {
        await loadingIndicator.waitFor({ state: 'hidden', timeout: 120_000 });
      } catch {
        // Ignore — indicator already detached or hidden
      }
      try {
        await page.waitForLoadState('networkidle', { timeout: 30_000 });
      } catch {
        // networkidle not reached within 30s — loading indicator is already gone, proceed
      }
    };

    /**
     * Returns the current sort direction for a column header by inspecting the
     * element's aria-sort attribute, CSS classes, child icon classes, text content,
     * and CSS pseudo-element content (which covers CSS-rendered ▲/▼ arrows).
     * @param {import('@playwright/test').Locator} headerLocator
     * @returns {Promise<'asc' | 'desc' | 'unknown'>}
     */
    const getSortDirection = async (headerLocator) => {
      return headerLocator.evaluate((th) => {
        // 1. aria-sort attribute (most standards-compliant)
        const ariaSort = (th.getAttribute('aria-sort') || '').toLowerCase();
        if (ariaSort === 'ascending')  return 'asc';
        if (ariaSort === 'descending') return 'desc';

        // 2. CSS classes on the th element itself
        const thClass = (th.className || '').toLowerCase();
        if (thClass.includes('sort-asc')  || thClass.includes('-asc')  || /\basc\b/.test(thClass))  return 'asc';
        if (thClass.includes('sort-desc') || thClass.includes('-desc') || /\bdesc\b/.test(thClass)) return 'desc';

        // 3. Child icon/span element classes
        for (const el of th.querySelectorAll('i, span, em, button, a')) {
          const cls = (el.className || '').toLowerCase();
          if (cls.includes('sort-asc')  || cls.includes('fa-sort-up')   || cls.includes('fa-sort-asc')  || /\basc\b/.test(cls))  return 'asc';
          if (cls.includes('sort-desc') || cls.includes('fa-sort-down') || cls.includes('fa-sort-desc') || /\bdesc\b/.test(cls)) return 'desc';
        }

        // 4. Unicode sort arrow characters in visible text content
        const text = th.textContent || '';
        if (text.includes('\u25B2') || text.includes('\u2191')) return 'asc';   // ▲ ↑
        if (text.includes('\u25BC') || text.includes('\u2193')) return 'desc';  // ▼ ↓

        // 5. CSS pseudo-element content (handles CSS-rendered arrows)
        try {
          const before = window.getComputedStyle(th, '::before').content;
          const after  = window.getComputedStyle(th, '::after').content;
          const pseudo = (before + after).replace(/['"]/g, '');
          if (pseudo.includes('\u25B2') || pseudo.includes('\u2191')) return 'asc';
          if (pseudo.includes('\u25BC') || pseudo.includes('\u2193')) return 'desc';
        } catch { /* ignore */ }

        return 'unknown';
      });
    };

    /**
     * After a header click, verifies the sort direction matches the desired direction.
     * If the detected direction differs, clicks the header once more to flip it.
     * @param {import('@playwright/test').Locator} headerLocator
     * @param {'asc' | 'desc'} desired
     */
    const ensureSortDirection = async (headerLocator, desired) => {
      const current = await getSortDirection(headerLocator);
      if (current !== 'unknown' && current !== desired) {
        await headerLocator.click({ force: true });
        await waitForReportReady();
      }
    };

    // Wait for the Date dropdown (first <select> in the filter table)
    const dateSelect = frame.locator('select').first();
    try {
      await dateSelect.waitFor({ state: 'visible', timeout: 120_000 });
    } catch {
      throw new Error(`Report controls did not load inside iframe. URL: ${page.url()} | Title: ${await page.title()} | Iframes: ${await page.locator('iframe').count()}`);
    }

    // Ensure "Custom" is selected so the date textboxes are active
    await dateSelect.selectOption({ label: 'Custom' });

    // The date row has many unrelated hidden inputs elsewhere in the page.
    // Restrict to the two visible text inputs rendered for Start Date / End Date.
    const dateInputs = frame.locator('tr:has-text("Start Date") input[type="text"]:visible');
    const startInput = dateInputs.first();
    const endInput = dateInputs.nth(1);

    await startInput.waitFor({ state: 'visible', timeout: 30_000 });
    await endInput.waitFor({ state: 'visible', timeout: 10_000 });

    // Clear end date first so the UI's start-before-end validation does not
    // fire while an intermediate start value exceeds the previous end value.
    // Do NOT press Tab after clearing end — Angular's blur handler would
    // auto-fill it with a next-day default, corrupting the subsequent fill.
    await endInput.click();
    await endInput.press('Control+A');
    await endInput.press('Backspace');

    await startInput.click();
    await startInput.press('Control+A');
    await startInput.press('Backspace');
    await startInput.pressSequentially(START_DATE, { delay: 40 });
    await startInput.press('Tab');

    await endInput.click();
    await endInput.press('Control+A');
    await endInput.press('Backspace');
    await endInput.pressSequentially(END_DATE, { delay: 40 });
    await endInput.press('Tab');

    // Click the Run button to execute the report with the custom date range
    progress(2, 'Setting date range and running report...');
    await frame.getByRole('button', { name: 'Run' }).click();

    // Determine quickly whether we have data or a "No records" state.
    // This avoids waiting for header timeouts when the no-records banner appears first.
    const tsEdgeInHeader = frame.locator('th', { hasText: 'tsEdgeIn' }).last();
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
    await tsEdgeInHeader.click({ force: true });
    await waitForReportReady();
    // Verify arrow is pointing up (ascending); if the column was already sorted asc
    // the first click flips it to desc — correct that now.
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

    const tsEdgeInData = await extractFirstRowValue('tsEdgeIn', { timeRange: { start: startTime, end: endTime }, pick: 'min' });

    // Retrieve and log result rows from the report table
    console.log(`Report rows returned for ${START_DATE} → ${END_DATE}: ${tsEdgeInData.resultsRowCount}`);
    console.log(`First row tsEdgeIn value: ${tsEdgeInData.firstRowValue}`);

    const tsCoreInHeader = frame.locator('th', { hasText: 'tsCoreIn' }).last();
    await tsCoreInHeader.waitFor({ state: 'visible', timeout: 30_000 });
    progress(4, 'Sorting by tsCoreIn ascending (▲), waiting for report...');
    await tsCoreInHeader.click({ force: true });

    // Wait for tsCoreIn click report to load
    await waitForReportReady();
    // Verify arrow is pointing up (ascending) for tsCoreIn - ensure it's correct
    await ensureSortDirection(tsCoreInHeader, 'asc');

    // Take the first row value after ascending sort (no pick min/max)
    const tsCoreInData = await extractFirstRowValue('tsCoreIn', { timeRange: { start: startTime, end: endTime }, pick: 'min' });
    console.log(`First row tsCoreIn value: ${tsCoreInData.firstRowValue}`);

    // Click on tsMongoIn header and ensure descending sort
    const tsMongoInHeader = frame.locator('th', { hasText: 'tsMongoIn' }).last();
    await tsMongoInHeader.waitFor({ state: 'visible', timeout: 30_000 });
    progress(5, 'Sorting by tsMongoIn descending (▼), waiting for report...');
    // Requirement: tsMongoIn is clicked twice, waiting for the report between clicks.
    await tsMongoInHeader.click({ force: true });

    // Wait for tsMongoIn click report to load
    await waitForReportReady();

    progress(6, 'Applying second tsMongoIn click and verifying descending (▼)...');
    await tsMongoInHeader.click({ force: true });
    await waitForReportReady();

    let mongoDirection = await getSortDirection(tsMongoInHeader);
    console.log(`tsMongoIn sort direction after two clicks: ${mongoDirection}`);
    if (mongoDirection === 'asc') {
      await tsMongoInHeader.click({ force: true });
      await waitForReportReady();
      mongoDirection = await getSortDirection(tsMongoInHeader);
      console.log(`tsMongoIn sort direction after correction click: ${mongoDirection}`);
    }

    // Use max-in-range for tsMongoIn as a fallback when UI sort metadata is inconsistent.
    const tsMongoInData = await extractFirstRowValue('tsMongoIn', { timeRange: { start: startTime, end: endTime }, pick: 'max' });

    console.log(`First row tsMongoIn value: ${tsMongoInData.firstRowValue}`);

    // Calculate time difference between tsMongoIn and tsEdgeIn
    /** @param {string} dateString */
    const parseTime = (dateString) => new Date(dateString).getTime();
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
    if (tsCoreInMs < tsEdgeInMs) {
      console.warn(`tsCoreIn (${tsCoreInData.firstRowValue}) is earlier than tsEdgeIn (${tsEdgeInData.firstRowValue}) for ${startTime} → ${endTime}`);
    }
    const rowData = {
      rangeLabel: `${toAmPm(startTime)} - ${toAmPm(endTime)}`,
      startSend: tsEdgeInData.firstRowValue.slice(11, 19),
      endVizix:  tsMongoInData.firstRowValue.slice(11, 19),
      endCubes:  tsCoreInData.firstRowValue.slice(11, 19),
      vizixTime: formatDuration(timeDifferenceMs),
      cubesTime: formatDuration(cubesDiffMs),
    };
    if (section === 'Receiving') receivingResults.push(rowData);
    else inventoryResults.push(rowData);
  });
  } // end for ALL_RANGES

  test.afterAll(() => {
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
        console.log(`\n=== Benchmark Summary: YTS1 (Sandbox) - ${sectionName} - Today ${r.rangeLabel} ===`);
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
  <title>YTS1 (Sandbox) Benchmark Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; background: #f4f4f4; color: #222; }
    h1 { color: #1a1a2e; }
    h2 { color: #16213e; margin-top: 40px; }
    .section { margin-bottom: 56px; }
    .section-title { font-size: 1.3em; font-weight: bold; background: #1a1a2e; color: #fff; padding: 10px 16px; border-radius: 4px 4px 0 0; margin-bottom: 0; }
    .section-meta { color: #555; font-size: 0.9em; background: #e8eaf6; padding: 7px 16px; margin: 0 0 16px 0; border-radius: 0 0 4px 4px; }
    table { border-collapse: collapse; width: 100%; max-width: 860px; background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    th { background: #2e7d32; color: #fff; padding: 10px 14px; text-align: left; }
    th.sub { background: #388e3c; font-size: 0.85em; }
    td { padding: 9px 14px; border-bottom: 1px solid #ddd; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f1f8e9; }
    .highlight { font-weight: bold; color: #d62828; }
    .no-data { color: #888; font-style: italic; }
    .meta { color: #555; font-size: 0.95em; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>YTS1 (Sandbox) &mdash; Benchmark Results</h1>
  <p class="meta">Date: ${TODAY}</p>
${buildHtmlSection('Receiving', '&#128230;', RECEIVING_RANGES, receivingResults)}
${buildHtmlSection('Inventory', '&#128218;', INVENTORY_RANGES, inventoryResults)}
</body>
</html>`;

    const outDir = join(process.cwd(), 'benchmark-results');
    mkdirSync(outDir, { recursive: true });
    const reportPath = join(outDir, `benchmark-results-Sand-${TODAY}.html`);
    writeFileSync(reportPath, html, 'utf-8');
    console.log(`\nHTML report saved to: ${reportPath}`);
  });
});
