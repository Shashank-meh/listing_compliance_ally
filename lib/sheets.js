// Reads a Google Sheet tab as CSV using Google's export URL. Works for sheets
// shared as "Anyone with the link can view"; no Google credentials needed.
// Only docs.google.com spreadsheet links are accepted, and the export URL is
// built here, so this can't be used to fetch arbitrary addresses.
const SHEET_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/;
const MAX_BYTES = 5_000_000;

export async function readSheetCsv(link) {
  const m = String(link || '').match(SHEET_RE);
  if (!m) return { status: 400, body: { error: 'Not a Google Sheets link' } };
  const gid = (String(link).match(/[#&?]gid=(\d+)/) || [])[1];
  const url = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'ListingComplianceAlly/1.0' } });
  } catch (err) {
    return { status: 502, body: { error: `Couldn't reach Google Sheets: ${err.message}` } };
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok || type.includes('text/html')) {
    return { status: 403, body: { error: 'This sheet isn’t shared publicly. In Google Sheets choose Share → General access → "Anyone with the link" (Viewer), or download it as CSV and drop the file here.', private: true } };
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) return { status: 413, body: { error: 'The sheet is larger than 5 MB' } };
  return { status: 200, body: { csv: text, sheetId: m[1], gid: gid || null } };
}
