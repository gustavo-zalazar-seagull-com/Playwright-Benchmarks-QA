// @ts-check

/** @param {string} value */
const parseReportTimestamp = (value) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(normalized);
  const mdy = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(normalized);
  if (!iso && !mdy) return NaN;

  const parts = iso || mdy;
  if (!parts) return NaN;
  const year = Number(iso ? parts[1] : parts[3]);
  const month = Number(iso ? parts[2] : parts[1]);
  const day = Number(iso ? parts[3] : parts[2]);
  let hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  if (mdy) {
    if (hour < 1 || hour > 12) return NaN;
    hour = hour % 12 + (mdy[7] === 'PM' ? 12 : 0);
  }
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 ||
      date.getDate() !== day || date.getHours() !== hour ||
      date.getMinutes() !== minute || date.getSeconds() !== second) return NaN;
  return date.getTime();
};

/**
 * @param {import('@playwright/test').FrameLocator | import('@playwright/test').Page} frame
 * @param {string} columnName
 * @param {string} startDate
 * @param {string} endDate
 */
const extractFirstRowValueInRange = async (frame, columnName, startDate, endDate) => {
  const startMs = parseReportTimestamp(startDate);
  const endMs = parseReportTimestamp(endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error(`Invalid custom date range: ${startDate} - ${endDate}`);
  }

  const values = await frame.locator('table.vzx-static-table').evaluate((table, targetColumnName) => {
    const headers = [...table.querySelectorAll('thead th')].map(header => header.textContent?.trim() ?? '');
    const columnIndex = headers.indexOf(targetColumnName);
    if (columnIndex < 0) throw new Error(`Missing column: ${targetColumnName}`);
    return [...table.querySelectorAll(':scope > tbody > tr')]
      .filter(row => row.querySelectorAll(':scope > td').length === headers.length)
      .map(row => (row.querySelectorAll(':scope > td')[columnIndex].textContent ?? '').replace(/\s+/g, ' ').trim());
  }, columnName);

  const matchingIndex = values.findIndex(value => {
    const timestamp = parseReportTimestamp(value);
    return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs;
  });
  if (matchingIndex < 0) {
    throw new Error(`No valid ${columnName} timestamp within custom range ${startDate} - ${endDate} among ${values.length} displayed rows. Refusing to report out-of-range data.`);
  }
  if (matchingIndex > 0) {
    console.log(`${columnName}: skipped ${matchingIndex} blank, invalid or out-of-range rows; selected displayed row ${matchingIndex + 1}.`);
  }
  return { firstRowValue: values[matchingIndex], resultsRowCount: values.length };
};

module.exports = { extractFirstRowValueInRange, parseReportTimestamp };