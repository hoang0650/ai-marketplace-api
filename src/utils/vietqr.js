/**
 * NAPAS VietQR (EMVCo merchant-presented QR) payload builder.
 * Spec: NAPAS "QR Code chuyển nhanh 24/7" / EMV QRCPS. Tag 38 carries the
 * beneficiary (GUID A000000727, BIN + account, service QRIBFTTA = transfer to account).
 */

function tlv(id, value) {
  const v = String(value);
  return `${id}${String(v.length).padStart(2, '0')}${v}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) as 4 uppercase hex chars. */
function crc16(str) {
  let crc = 0xffff;
  const buf = Buffer.from(str, 'utf8');
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Memo must be plain ASCII for bank apps; strip diacritics and unsafe chars. */
function asciiMemo(s, max = 50) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function buildVietQrPayload({ bin, accountNumber, amountVnd, content }) {
  if (!/^\d{6}$/.test(String(bin))) throw new Error('Invalid bank BIN');
  if (!/^[0-9A-Za-z]{1,19}$/.test(String(accountNumber))) throw new Error('Invalid account number');
  const beneficiary = tlv('00', bin) + tlv('01', accountNumber);
  const merchantInfo = tlv('00', 'A000000727') + tlv('01', beneficiary) + tlv('02', 'QRIBFTTA');
  const amount = Math.round(Number(amountVnd) || 0);
  const memo = asciiMemo(content);
  let p = '';
  p += tlv('00', '01');
  p += tlv('01', amount > 0 ? '12' : '11'); // 12 = dynamic (one-off amount)
  p += tlv('38', merchantInfo);
  p += tlv('53', '704'); // VND
  if (amount > 0) p += tlv('54', String(amount));
  p += tlv('58', 'VN');
  if (memo) p += tlv('62', tlv('08', memo));
  p += '6304';
  return p + crc16(p);
}

module.exports = { buildVietQrPayload, crc16, tlv, asciiMemo };
