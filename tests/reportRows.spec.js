// @ts-check
import { test, expect } from '@playwright/test';
import { extractFirstRowValueInRange, parseReportTimestamp } from './helpers/reportRows';

test('Sandbox skips unrelated first rows for each sorted column', async ({ page }) => {
  const start = '10/27/2026 04:00:00 AM';
  const end = '10/27/2026 04:15:00 AM';
  for (const [column, values, expected] of [
    ['tsEdgeIn', ['', '10/27/2026 12:01:30 AM', '10/27/2026 04:01:46 AM', '10/27/2026 04:02:00 AM'], '10/27/2026 04:01:46 AM'],
    ['tsCoreIn', ['-', '10/27/2026 12:01:32 AM', '10/27/2026 04:02:16 AM'], '10/27/2026 04:02:16 AM'],
    ['tsMongoIn', ['10/27/2026 04:20:00 AM', '10/27/2026 04:06:02 AM', '10/27/2026 04:05:00 AM'], '10/27/2026 04:06:02 AM'],
  ]) {
    await page.setContent(`<table class="vzx-static-table"><thead><tr><th>${column}</th></tr></thead>
      <tbody>${/** @type {string[]} */ (values).map(value => `<tr><td>${value}</td></tr>`).join('')}</tbody></table>`);
    const result = await extractFirstRowValueInRange(page, /** @type {string} */ (column), start, end);
    expect(result.firstRowValue).toBe(expected);
  }
});

test('Prod preserves displayed order, rejects other dates and includes boundaries', async ({ page }) => {
  await page.setContent(`<table class="vzx-static-table"><thead><tr><th>tsEdgeIn</th><th>tsMongoIn</th></tr></thead><tbody>
    <tr><td>2026-10-26 04:05:00</td><td>2026-10-28 04:05:00</td></tr>
    <tr><td>2026-02-30 04:05:00</td><td>2026-10-27 04:15:01</td></tr>
    <tr><td>2026-10-27 04:00:00</td><td>2026-10-27 04:15:00</td></tr>
    <tr><td>2026-10-27 04:01:00</td><td>2026-10-27 04:14:00</td></tr>
    </tbody></table>`);
  const start = '2026-10-27 04:00:00';
  const end = '2026-10-27 04:15:00';
  expect((await extractFirstRowValueInRange(page, 'tsEdgeIn', start, end)).firstRowValue).toBe(start);
  expect((await extractFirstRowValueInRange(page, 'tsMongoIn', start, end)).firstRowValue).toBe(end);
});

test('fails explicitly when no displayed timestamp qualifies', async ({ page }) => {
  await page.setContent(`<table class="vzx-static-table"><thead><tr><th>tsEdgeIn</th></tr></thead><tbody>
    <tr><td></td></tr><tr><td>10/27/2026 12:01:30 AM</td></tr></tbody></table>`);
  await expect(extractFirstRowValueInRange(page, 'tsEdgeIn', '10/27/2026 04:00:00 AM', '10/27/2026 04:15:00 AM'))
    .rejects.toThrow('No valid tsEdgeIn timestamp within custom range');
});

test('normalizes timestamp whitespace without selecting nested table rows', async ({ page }) => {
  await page.setContent(`<table class="vzx-static-table"><thead><tr><th>tsCoreIn</th><th>Other</th></tr></thead><tbody>
    <tr><td>10/27/2026\n 04:02:16\n AM</td><td><table><tbody><tr><td>nested</td></tr></tbody></table></td></tr>
    </tbody></table>`);
  expect(await extractFirstRowValueInRange(page, 'tsCoreIn', '10/27/2026 04:00:00 AM', '10/27/2026 04:15:00 AM'))
    .toEqual({ firstRowValue: '10/27/2026 04:02:16 AM', resultsRowCount: 1 });
});

test('parses AM/PM and rejects malformed or impossible timestamps', () => {
  expect(parseReportTimestamp('10/27/2026 12:00:00 AM')).toBe(parseReportTimestamp('2026-10-27 00:00:00'));
  expect(parseReportTimestamp('10/27/2026 12:00:00 PM')).toBe(parseReportTimestamp('2026-10-27 12:00:00'));
  expect(parseReportTimestamp('10/27/2026 04:15:00 PM')).toBe(parseReportTimestamp('2026-10-27 16:15:00'));
  for (const value of ['', '-', '04:01:46', '2026-02-30 04:00:00', '10/27/2026 00:15:00 AM', '2026-10-27 24:00:00', '2026-10-27 04:60:00']) {
    expect(parseReportTimestamp(value)).toBeNaN();
  }
});

test('rejects invalid range bounds before reading the grid', async ({ page }) => {
  for (const [start, end] of [
    ['', '2026-10-27 04:15:00'],
    ['2026-10-27 04:15:00', '2026-10-27 04:00:00'],
    ['2026-10-27 04:00:00', '2026-10-27 04:00:00'],
  ]) {
    await expect(extractFirstRowValueInRange(page, 'tsEdgeIn', start, end)).rejects.toThrow('Invalid custom date range');
  }
});