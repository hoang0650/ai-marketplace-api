/** Turn a raw GPU worker error into a short, user-facing Vietnamese message (no URLs or stack text). */
const LABEL = { tts: 'Tạo giọng nói thất bại', fast: 'Tạo video thất bại', talking: 'Tạo video avatar thất bại', film: 'Tạo phim AI thất bại' };

function transient(raw) {
  return /\b(50[0234])\b|Internal Server Error|Connection (refused|reset)|ECONNRE|timed? ?out|CUDA out of memory|lost/i.test(String(raw || ''));
}

function reason(raw) {
  const s = String(raw || '');
  if (!s) return '';
  if (/No face detected/i.test(s)) return 'Không tìm thấy khuôn mặt người trong ảnh. Hãy dùng ảnh chân dung rõ mặt.';
  if (/out of memory/i.test(s)) return 'GPU đang quá tải, vui lòng thử lại sau ít phút.';
  if (/time ?limit|timed? ?out/i.test(s)) return 'Quá thời gian xử lý, vui lòng thử lại với nội dung ngắn hơn.';
  if (/voice|speaker/i.test(s) && /not found|unknown|invalid/i.test(s)) return 'Giọng đã chọn không còn khả dụng, vui lòng chọn giọng khác.';
  if (/audio|sample|decode/i.test(s) && /invalid|decode|short|empty/i.test(s)) return 'File giọng mẫu không đọc được hoặc quá ngắn (cần 6–15 giây).';
  if (s === 'lost' || transient(s)) return 'Máy GPU gặp lỗi tạm thời, vui lòng thử lại.';
  const clean = s.split('\n')[0].replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return clean || 'Lỗi không xác định.';
}

function failMessage(kind, raw, refunded) {
  const base = LABEL[kind] || 'Tác vụ thất bại';
  const why = reason(raw);
  return `${base}${why ? `: ${why}` : ''}${refunded ? ' (đã hoàn phí)' : ''}`;
}

module.exports = { failMessage, reason, transient, LABEL };
