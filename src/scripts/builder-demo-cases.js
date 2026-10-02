/**
 * Demo data for the AI App Builder: two scripted conversations (web + app) whose assistant
 * replies use the same <file>/<delete> protocol a real provider returns. Used by
 * `npm run seed:builder` and by test/builder/demo-cases.test.js — no provider key needed.
 */

function reply(summary, files = [], deletes = []) {
  const blocks = files.map((f) => `<file path="${f.path}">\n${f.content}</file>`);
  const dels = deletes.map((p) => `<delete path="${p}" />`);
  return [summary, ...blocks, ...dels].join('\n\n');
}

/* ---------------------------------------------------------------- web case */

const WEB_INDEX = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PH Hotel Đà Lạt</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <header class="nav">
    <a class="brand" href="#">🌲 PH Hotel</a>
    <nav id="nav-links"><a href="#rooms">Phòng</a><a href="#booking">Đặt phòng</a></nav>
  </header>

  <section class="hero">
    <h1>Nghỉ dưỡng giữa rừng thông Đà Lạt</h1>
    <p>View đồi thông, bữa sáng miễn phí, cách chợ Đà Lạt 5 phút đi bộ.</p>
    <a class="btn" href="#booking">Đặt phòng ngay</a>
  </section>

  <section id="rooms" class="section">
    <h2>Hạng phòng</h2>
    <div id="room-list" class="grid"></div>
  </section>

  <section id="booking" class="section">
    <h2>Đặt phòng</h2>
    <form id="booking-form" class="form">
      <label>Họ tên <input name="name" placeholder="Nguyễn Văn A" required /></label>
      <label>Nhận phòng <input type="date" name="checkin" required /></label>
      <label>Số đêm <input type="number" name="nights" min="1" max="30" value="2" required /></label>
      <label>Hạng phòng <select name="room" id="room-select"></select></label>
      <p id="total" class="total"></p>
      <button class="btn" type="submit">Gửi yêu cầu</button>
    </form>
    <p id="result" class="result" hidden></p>
  </section>

  <footer class="footer">© 2026 PH Hotel · 12 Trần Hưng Đạo, Đà Lạt</footer>
  <script type="module" src="js/app.js"></script>
</body>
</html>
`;

const WEB_STYLES = `:root {
  --bg: #0b1020;
  --card: #131a2e;
  --text: #e5e7eb;
  --muted: #94a3b8;
  --accent: #22c55e;
}
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); transition: background .2s, color .2s; }
a { color: inherit; text-decoration: none; }
.nav { position: sticky; top: 0; display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; background: var(--card); z-index: 10; }
.nav nav { display: flex; gap: 18px; align-items: center; color: var(--muted); }
.brand { font-weight: 700; font-size: 1.1rem; }
.hero { min-height: 70vh; display: grid; place-content: center; text-align: center; padding: 48px 24px;
  background: linear-gradient(rgba(0,0,0,.45), rgba(0,0,0,.6)), url('https://picsum.photos/seed/dalat/1600/900') center/cover; color: #fff; }
.hero h1 { font-size: clamp(2rem, 5vw, 3.2rem); margin: 0 0 12px; }
.hero p { margin: 0 auto 24px; max-width: 34rem; color: #d1d5db; }
.btn { display: inline-block; border: 0; cursor: pointer; background: var(--accent); color: #052e16; font-weight: 700; padding: 12px 22px; border-radius: 999px; }
.section { max-width: 1000px; margin: 0 auto; padding: 56px 24px; }
.section h2 { margin-top: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; }
.room { background: var(--card); border-radius: 16px; overflow: hidden; }
.room img { width: 100%; height: 160px; object-fit: cover; display: block; }
.room .body { padding: 16px; }
.room h3 { margin: 0 0 6px; }
.room .meta { color: var(--muted); font-size: .9rem; margin: 0 0 12px; }
.room .price { font-weight: 700; color: var(--accent); }
.form { display: grid; gap: 14px; max-width: 420px; }
.form label { display: grid; gap: 6px; color: var(--muted); font-size: .9rem; }
.form input, .form select { padding: 10px 12px; border-radius: 10px; border: 1px solid #334155; background: var(--card); color: var(--text); font: inherit; }
.total { margin: 0; font-weight: 700; }
.result { margin-top: 18px; padding: 14px 16px; border-radius: 12px; background: rgba(34,197,94,.12); color: var(--accent); }
.footer { text-align: center; padding: 32px; color: var(--muted); font-size: .85rem; }
.theme-toggle { border: 1px solid #334155; background: transparent; color: var(--text); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
`;

const WEB_ROOMS = `export const ROOMS = [
  { id: 'standard', name: 'Standard Đồi Thông', price: 650000, size: 22, guests: 2, image: 'https://picsum.photos/seed/ph-standard/600/400' },
  { id: 'deluxe', name: 'Deluxe Ban Công', price: 950000, size: 30, guests: 2, image: 'https://picsum.photos/seed/ph-deluxe/600/400' },
  { id: 'family', name: 'Family Suite', price: 1450000, size: 45, guests: 4, image: 'https://picsum.photos/seed/ph-family/600/400' },
];

export function formatVnd(n) {
  return n.toLocaleString('vi-VN') + ' ₫';
}
`;

const WEB_APP_V1 = `import { ROOMS, formatVnd } from './rooms.js';

const list = document.getElementById('room-list');
const select = document.getElementById('room-select');
const form = document.getElementById('booking-form');
const total = document.getElementById('total');
const result = document.getElementById('result');

for (const room of ROOMS) {
  const card = document.createElement('article');
  card.className = 'room';
  card.innerHTML =
    '<img alt="" src="' + room.image + '" />' +
    '<div class="body"><h3>' + room.name + '</h3>' +
    '<p class="meta">' + room.size + ' m² · tối đa ' + room.guests + ' khách</p>' +
    '<span class="price">' + formatVnd(room.price) + '</span> / đêm</div>';
  list.appendChild(card);

  const option = document.createElement('option');
  option.value = room.id;
  option.textContent = room.name + ' — ' + formatVnd(room.price);
  select.appendChild(option);
}

function updateTotal() {
  const room = ROOMS.find((r) => r.id === select.value);
  const nights = Math.max(1, Number(form.nights.value) || 1);
  total.textContent = 'Tạm tính: ' + formatVnd(room.price * nights);
}

form.addEventListener('input', updateTotal);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const room = ROOMS.find((r) => r.id === select.value);
  result.hidden = false;
  result.textContent =
    'Cảm ơn ' + form.name.value + '! Đã ghi nhận ' + room.name + ' từ ' + form.checkin.value +
    ' (' + form.nights.value + ' đêm). Lễ tân sẽ gọi xác nhận trong 15 phút.';
  form.reset();
  updateTotal();
});

updateTotal();
`;

const WEB_THEME = `const THEMES = {
  dark: { '--bg': '#0b1020', '--card': '#131a2e', '--text': '#e5e7eb', '--muted': '#94a3b8' },
  light: { '--bg': '#f8fafc', '--card': '#ffffff', '--text': '#0f172a', '--muted': '#475569' },
};

let current = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

function apply(name) {
  current = name;
  for (const [key, value] of Object.entries(THEMES[name])) {
    document.documentElement.style.setProperty(key, value);
  }
  button.textContent = name === 'dark' ? '☀️ Sáng' : '🌙 Tối';
}

const button = document.createElement('button');
button.type = 'button';
button.className = 'theme-toggle';
button.addEventListener('click', () => apply(current === 'dark' ? 'light' : 'dark'));
document.getElementById('nav-links').appendChild(button);

apply(current);
`;

const WEB_APP_V2 = `import './theme.js';\n${WEB_APP_V1}`;

const WEB_CASE = {
  name: '[Demo] Landing page PH Hotel',
  kind: 'web',
  turns: [
    {
      prompt:
        'Làm landing page cho khách sạn PH Hotel ở Đà Lạt: hero có ảnh rừng thông, danh sách 3 hạng phòng kèm giá, form đặt phòng tự tính tiền theo số đêm.',
      provider: 'openai',
      model: 'gpt-4.1',
      reply: reply(
        'Đã tạo landing page PH Hotel:\n- Hero ảnh nền + nút đặt phòng\n- 3 hạng phòng render từ `js/rooms.js`\n- Form đặt phòng tự tính tạm tính theo số đêm\n- Bỏ file `app.js` mẫu, chuyển logic sang ES module `js/app.js`',
        [
          { path: 'index.html', content: WEB_INDEX },
          { path: 'styles.css', content: WEB_STYLES },
          { path: 'js/rooms.js', content: WEB_ROOMS },
          { path: 'js/app.js', content: WEB_APP_V1 },
        ],
        ['app.js']
      ),
    },
    {
      prompt: 'Thêm nút chuyển giao diện sáng / tối trên thanh menu.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      reply: reply(
        'Đã thêm nút ☀️/🌙 trên menu: đổi biến màu CSS, mặc định theo cài đặt hệ thống.',
        [
          { path: 'js/theme.js', content: WEB_THEME },
          { path: 'js/app.js', content: WEB_APP_V2 },
        ]
      ),
    },
  ],
};

/* ---------------------------------------------------------------- app case */

const APP_ROOMS = `export type Room = {
  id: string;
  name: string;
  price: number;
  size: number;
  guests: number;
  image: string;
};

export const ROOMS: Room[] = [
  { id: 'standard', name: 'Standard Đồi Thông', price: 650000, size: 22, guests: 2, image: 'https://picsum.photos/seed/ph-standard/600/400' },
  { id: 'deluxe', name: 'Deluxe Ban Công', price: 950000, size: 30, guests: 2, image: 'https://picsum.photos/seed/ph-deluxe/600/400' },
  { id: 'family', name: 'Family Suite', price: 1450000, size: 45, guests: 4, image: 'https://picsum.photos/seed/ph-family/600/400' },
];

export function formatVnd(n: number) {
  return n.toLocaleString('vi-VN') + ' ₫';
}
`;

function roomCard(rnImports) {
  return `import React from 'react';
import { ${rnImports} } from 'react-native';
import { Room, formatVnd } from '../data/rooms';

type Props = { room: Room; onBook: () => void };

export default function RoomCard({ room, onBook }: Props) {
  return (
    <View style={styles.card}>
      <Image source={{ uri: room.image }} style={styles.image} />
      <View style={styles.body}>
        <Text style={styles.name}>{room.name}</Text>
        <Text style={styles.meta}>{room.size} m² · tối đa {room.guests} khách</Text>
        <View style={styles.row}>
          <Text style={styles.price}>
            {formatVnd(room.price)}
            <Text style={styles.night}> /đêm</Text>
          </Text>
          <Pressable style={styles.button} onPress={onBook}>
            <Text style={styles.buttonText}>Đặt</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#131a2e', borderRadius: 18, overflow: 'hidden', marginBottom: 16 },
  image: { width: '100%', height: 160 },
  body: { padding: 14 },
  name: { color: '#fff', fontSize: 17, fontWeight: '700' },
  meta: { color: '#94a3b8', marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  price: { color: '#22c55e', fontSize: 16, fontWeight: '700' },
  night: { color: '#94a3b8', fontSize: 13, fontWeight: '400' },
  button: { backgroundColor: '#22c55e', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 },
  buttonText: { color: '#052e16', fontWeight: '700' },
});
`;
}

const APP_ENTRY = `import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import RoomCard from './components/RoomCard';
import { ROOMS, Room, formatVnd } from './data/rooms';

type Booking = { id: string; room: Room; nights: number };
type Tab = 'rooms' | 'bookings';

export default function App() {
  const [tab, setTab] = useState<Tab>('rooms');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const total = useMemo(() => bookings.reduce((sum, b) => sum + b.room.price * b.nights, 0), [bookings]);

  const book = (room: Room) => {
    setBookings((list) => [...list, { id: String(Date.now()), room, nights: 1 }]);
    setTab('bookings');
  };
  const changeNights = (id: string, delta: number) =>
    setBookings((list) => list.map((b) => (b.id === id ? { ...b, nights: Math.max(1, b.nights + delta) } : b)));
  const cancel = (id: string) => setBookings((list) => list.filter((b) => b.id !== id));

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>PH Hotel</Text>
        <Text style={styles.subtitle}>Đặt phòng Đà Lạt trong 30 giây</Text>
      </View>

      {tab === 'rooms' ? (
        <FlatList
          data={ROOMS}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <RoomCard room={item} onBook={() => book(item)} />}
        />
      ) : (
        <FlatList
          data={bookings}
          keyExtractor={(b) => b.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={<Text style={styles.empty}>Chưa có đặt phòng nào. Chọn phòng ở tab Phòng nhé.</Text>}
          ListFooterComponent={bookings.length ? <Text style={styles.total}>Tổng cộng: {formatVnd(total)}</Text> : null}
          renderItem={({ item }) => (
            <View style={styles.booking}>
              <View style={{ flex: 1 }}>
                <Text style={styles.bookingName}>{item.room.name}</Text>
                <Text style={styles.bookingMeta}>{formatVnd(item.room.price * item.nights)}</Text>
              </View>
              <View style={styles.stepper}>
                <Pressable onPress={() => changeNights(item.id, -1)} style={styles.step}><Text style={styles.stepText}>−</Text></Pressable>
                <Text style={styles.nights}>{item.nights} đêm</Text>
                <Pressable onPress={() => changeNights(item.id, 1)} style={styles.step}><Text style={styles.stepText}>+</Text></Pressable>
              </View>
              <Pressable onPress={() => cancel(item.id)} style={styles.cancel}>
                <Text style={styles.cancelText}>Huỷ</Text>
              </Pressable>
            </View>
          )}
        />
      )}

      <View style={styles.tabs}>
        {(['rooms', 'bookings'] as Tab[]).map((key) => (
          <Pressable key={key} onPress={() => setTab(key)} style={styles.tab}>
            <Text style={[styles.tabText, tab === key && styles.tabActive]}>
              {key === 'rooms' ? '🏨 Phòng' : '🧾 Đã đặt (' + bookings.length + ')'}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0b1020' },
  header: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 12 },
  title: { color: '#fff', fontSize: 28, fontWeight: '800' },
  subtitle: { color: '#94a3b8', marginTop: 4 },
  list: { padding: 20, paddingBottom: 32 },
  empty: { color: '#94a3b8', textAlign: 'center', marginTop: 48 },
  total: { color: '#22c55e', fontSize: 18, fontWeight: '700', textAlign: 'right', marginTop: 8 },
  booking: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#131a2e', borderRadius: 16, padding: 14, marginBottom: 12, gap: 10 },
  bookingName: { color: '#fff', fontWeight: '700' },
  bookingMeta: { color: '#94a3b8', marginTop: 4 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  step: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#1e293b', alignItems: 'center', justifyContent: 'center' },
  stepText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  nights: { color: '#e5e7eb', minWidth: 48, textAlign: 'center' },
  cancel: { paddingHorizontal: 10, paddingVertical: 6 },
  cancelText: { color: '#f87171', fontWeight: '600' },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#1e293b', backgroundColor: '#0f172a' },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabText: { color: '#64748b', fontWeight: '600' },
  tabActive: { color: '#22c55e' },
});
`;

const APP_PREVIEW_ERROR = 'ReferenceError: Pressable is not defined\n    at RoomCard (components/RoomCard.tsx:14:3)';

const APP_CASE = {
  name: '[Demo] App đặt phòng PH Hotel',
  kind: 'app',
  turns: [
    {
      prompt:
        'Làm app đặt phòng khách sạn PH Hotel: tab Phòng hiển thị 3 hạng phòng có ảnh và giá, bấm Đặt thì chuyển sang tab Đã đặt, chỉnh số đêm, huỷ, hiện tổng tiền.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      reply: reply(
        'Đã tạo app đặt phòng:\n- Tab 🏨 Phòng với thẻ phòng (ảnh, diện tích, giá)\n- Tab 🧾 Đã đặt: chỉnh số đêm, huỷ, tổng tiền\n- Dữ liệu mẫu trong `data/rooms.ts`',
        [
          { path: 'App.tsx', content: APP_ENTRY },
          { path: 'components/RoomCard.tsx', content: roomCard('Image, StyleSheet, Text, View') },
          { path: 'data/rooms.ts', content: APP_ROOMS },
        ]
      ),
    },
    {
      prompt: '',
      previewError: APP_PREVIEW_ERROR,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      reply: reply('Đã sửa: `RoomCard` dùng `Pressable` nhưng thiếu import từ react-native.', [
        { path: 'components/RoomCard.tsx', content: roomCard('Image, Pressable, StyleSheet, Text, View') },
      ]),
    },
  ],
};

const DEMO_CASES = [WEB_CASE, APP_CASE];

/**
 * Replays a case on a BuilderProject document (starter files expected) exactly like
 * POST /projects/:id/generate would, without calling a provider.
 */
function replayCase(doc, demo, applyGeneration, { turns = demo.turns.length } = {}) {
  return demo.turns.slice(0, turns).map((turn) =>
    applyGeneration(doc, {
      prompt: turn.prompt,
      previewError: turn.previewError,
      text: turn.reply,
      provider: turn.provider,
      model: turn.model,
    })
  );
}

module.exports = { DEMO_CASES, WEB_CASE, APP_CASE, APP_PREVIEW_ERROR, replayCase, reply };
