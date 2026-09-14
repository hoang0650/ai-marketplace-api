/** Accept raw JSON or standard base64 of the JSON object. */
function parseJsonEnv(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

function pemFromEnv(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
}

module.exports = { parseJsonEnv, pemFromEnv };
