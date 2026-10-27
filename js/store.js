// Datenhaltung lokal auf dem Gerät (jede Person nutzt ihr eigenes Handy).
import { today, addDays, uid } from './util.js';

const KEY = 'sportapp.v1';
const empty = () => ({ profile: null, races: [], results: [], sessions: [], pauses: [], onboarded: false, createdAt: today() });

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) return { ...empty(), ...s };
  } catch { /* leer starten */ }
  return empty();
}

export let state = load();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* Speicher nicht verfügbar */ }
}
export function replaceState(next) { state = { ...empty(), ...next }; save(); }
export function resetState() { state = empty(); save(); }

export function upsert(list, item) {
  if (!item.id) item.id = uid();
  const arr = state[list], i = arr.findIndex(x => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
  save();
}
export function remove(list, id) {
  state[list] = state[list].filter(x => x.id !== id);
  save();
}

/** Beispieldaten zum Ausprobieren. */
export function demoState() {
  const t = today();
  const s = (d, sport, type, durationMin, distanceKm, rpe, avgHr = null) => ({ id: uid(), date: addDays(t, d), sport, type, durationMin, distanceKm, rpe, avgHr });
  return {
    ...empty(),
    createdAt: addDays(t, -28),
    onboarded: true,
    profile: {
      name: 'Demo', sex: 'm', birthYear: 1992, heightCm: 182, weightKg: 76, restHr: 52, maxHr: 188,
      level: 'fortgeschritten', hoursMin: 6, hoursMax: 9,
      sports: { run: true, bike: true, swim: true, strength: true },
      runEasyPace: 340, bikeEasySpeed: 27, swimEasyPace: 130,
    },
    races: [
      { id: uid(), name: 'Stadtlauf Halbmarathon', date: addDays(t, 38), sport: 'run', distance: 'hm', priority: 'B', target: 6300 },
      { id: uid(), name: 'Triathlon Mitteldistanz', date: addDays(t, 130), sport: 'tri', distance: 'middle', priority: 'A', target: 19800, targetSplits: { swim: 2280, bike: 10200, run: 6900 } },
    ],
    results: [
      { id: uid(), sport: 'run', distance: '10k', time: 2880, date: addDays(t, -200) },
      { id: uid(), sport: 'tri', distance: 'olympic', time: 9600, splits: { swim: 1800, bike: 4500, run: 3000 }, date: addDays(t, -400) },
    ],
    sessions: [
      s(-36, 'bike', 'easy', 70, 29.5, 3), s(-33, 'swim', 'easy', 40, 1.7, 4),
      s(-27, 'run', 'easy', 45, 7.1, 3, 138), s(-25, 'bike', 'long', 120, 51, 4), s(-23, 'swim', 'easy', 40, 1.7, 4),
      s(-21, 'run', 'long', 85, 13.2, 4, 142), s(-20, 'strength', 'strength', 45, null, 6), s(-18, 'run', 'interval', 55, 10, 8),
      s(-16, 'bike', 'easy', 75, 32, 3), s(-14, 'run', 'long', 95, 15.3, 4, 141), s(-12, 'swim', 'interval', 45, 2.2, 7),
      s(-11, 'run', 'easy', 40, 6.6, 3, 136), s(-9, 'bike', 'long', 150, 65, 4), s(-8, 'swim', 'long', 50, 2.3, 4),
      s(-7, 'run', 'tempo', 50, 10, 7), s(-6, 'strength', 'strength', 45, null, 6), s(-4, 'run', 'long', 100, 16.6, 5, 145),
      s(-3, 'swim', 'easy', 40, 1.8, 3), s(-2, 'bike', 'easy', 60, 27, 3), s(-1, 'run', 'interval', 55, 10, 8),
    ],
    pauses: [],
  };
}
