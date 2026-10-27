// Stammdaten: Sportarten, Wettkampfdistanzen, Einheiten-Typen.

export const SPORTS = {
  run: { label: 'Laufen', icon: '🏃' },
  bike: { label: 'Radfahren', icon: '🚴' },
  swim: { label: 'Schwimmen', icon: '🏊' },
  strength: { label: 'Kraft', icon: '🏋️' },
};
export const ENDURANCE = ['swim', 'bike', 'run'];

// taper / recovery in Tagen (für Hauptziele, Priorität A)
// shares = typische Zeitanteile Schwimmen/Rad/Laufen (ohne Wechsel) beim Triathlon
export const RACES = {
  run: {
    label: 'Laufen', icon: '🏃',
    distances: {
      '5k': { label: '5 km', run: 5, taper: 7, recovery: 2 },
      '10k': { label: '10 km', run: 10, taper: 7, recovery: 3 },
      hm: { label: 'Halbmarathon', run: 21.0975, taper: 14, recovery: 7 },
      m: { label: 'Marathon', run: 42.195, taper: 21, recovery: 14 },
    },
  },
  bike: {
    label: 'Radfahren', icon: '🚴',
    distances: {
      ez20: { label: 'Zeitfahren 20 km', bike: 20, taper: 7, recovery: 2 },
      ez40: { label: 'Zeitfahren 40 km', bike: 40, taper: 7, recovery: 3 },
      rm100: { label: 'Radmarathon / Jedermann 100 km', bike: 100, taper: 10, recovery: 4 },
      lang200: { label: 'Langstrecke 200 km', bike: 200, taper: 14, recovery: 7 },
    },
  },
  tri: {
    label: 'Triathlon', icon: '🏊🚴🏃',
    distances: {
      sprint: { label: 'Sprint (0,75 / 20 / 5)', swim: 0.75, bike: 20, run: 5, taper: 7, recovery: 3, transition: 180, runFatigue: 1.04, shares: { swim: 0.19, bike: 0.49, run: 0.32 } },
      olympic: { label: 'Olympisch (1,5 / 40 / 10)', swim: 1.5, bike: 40, run: 10, taper: 10, recovery: 5, transition: 240, runFatigue: 1.06, shares: { swim: 0.19, bike: 0.48, run: 0.33 } },
      middle: { label: 'Mitteldistanz (1,9 / 90 / 21,1)', swim: 1.9, bike: 90, run: 21.0975, taper: 14, recovery: 10, transition: 360, runFatigue: 1.1, shares: { swim: 0.12, bike: 0.52, run: 0.36 } },
      long: { label: 'Langdistanz (3,8 / 180 / 42,2)', swim: 3.8, bike: 180, run: 42.195, taper: 21, recovery: 21, transition: 600, runFatigue: 1.18, shares: { swim: 0.11, bike: 0.52, run: 0.37 } },
    },
  },
};

export const PRIORITIES = {
  A: { label: 'Hauptziel', hint: 'volles Tapering' },
  B: { label: 'Zwischenziel', hint: 'verkürztes Tapering' },
  C: { label: 'Trainingswettkampf', hint: 'nur 2 Tage locker davor' },
};

export const LEVELS = {
  einsteiger: { label: 'Einsteiger', hint: 'unter 1 Jahr regelmäßig', rate: 0.006 },
  fortgeschritten: { label: 'Fortgeschritten', hint: '1–3 Jahre, erste Wettkämpfe', rate: 0.004 },
  ambitioniert: { label: 'Ambitioniert', hint: 'mehrjährig, strukturiert', rate: 0.0025 },
};

// Einheiten-Typen fürs Eintragen
export const TYPES = {
  run: { easy: 'Locker / Zone 2', long: 'Langer Lauf', tempo: 'Tempo / Schwelle', interval: 'Intervalle', race: 'Wettkampf' },
  bike: { easy: 'Grundlage / Zone 2', long: 'Lange Ausfahrt', tempo: 'Tempo / Sweetspot', interval: 'Intervalle', race: 'Wettkampf' },
  swim: { easy: 'Technik / locker', long: 'Ausdauer', tempo: 'Tempo', interval: 'Intervalle', race: 'Wettkampf' },
  strength: { strength: 'Krafttraining (Studio)' },
};
export const DEFAULT_RPE = { easy: 3, long: 5, tempo: 7, interval: 8, race: 9, strength: 6 };
export const RPE_LABELS = ['', 'sehr leicht', 'leicht', 'locker', 'moderat', 'etwas fordernd', 'fordernd', 'hart', 'sehr hart', 'extrem hart', 'Maximum'];

export const PAUSE_REASONS = { krank: 'Krank', verletzt: 'Verletzt', urlaub: 'Urlaub / keine Zeit' };
