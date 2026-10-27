// Kleine Helfer für Datum, Zeiten und HTML.

export const DAY_MS = 86400000;
const pad = n => String(n).padStart(2, '0');

export function iso(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const today = () => iso(new Date());
export function pd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = pd(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}
/** Tage von a nach b (b - a). */
export const diffDays = (a, b) => Math.round((pd(b) - pd(a)) / DAY_MS);
export function weekStart(s) {
  const d = pd(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
}
export const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const fmtDate = (s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  pd(s).toLocaleDateString('de-DE', opts);

/** "1:45:30" → Sek., "45:30" → Sek. (m:ss), "45" → 45 Minuten. */
export function parseTime(str) {
  if (str == null || String(str).trim() === '') return null;
  const parts = String(str).trim().replace(',', '.').split(':');
  if (parts.some(p => p.trim() === '' || isNaN(p))) return null;
  const n = parts.map(Number);
  if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
  if (n.length === 2) return n[0] * 60 + n[1];
  if (n.length === 1) return n[0] * 60;
  return null;
}
export function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
export const fmtPace = sec => `${fmtTime(sec)} /km`;
export const fmtSwim = sec => `${fmtTime(sec)} /100 m`;
export const fmtSpeed = kmh => `${kmh.toFixed(1).replace('.', ',')} km/h`;
export function fmtDur(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}
export const fmtNum = (x, d = 1) => x.toFixed(d).replace('.', ',');

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const round5 = m => Math.max(5, Math.round(m / 5) * 5);
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
