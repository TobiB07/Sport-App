// Trainingslogik nach festen Regeln: Leistungsstand, Belastung, Prognose,
// Wochenempfehlungen und fixes Tapering.
import { RACES, LEVELS, DEFAULT_RPE, ENDURANCE } from './data.js';
import { today, addDays, diffDays, weekStart, clamp, round5, fmtPace, fmtSwim, fmtSpeed, fmtTime, fmtNum } from './util.js';

// ---------- Wettkämpfe ----------

export const raceDef = r => RACES[r.sport]?.distances[r.distance];
export const raceTitle = r => r.name?.trim() || raceDef(r)?.label || 'Wettkampf';
export const sortedRaces = state => [...state.races].sort((a, b) => a.date.localeCompare(b.date));
/** Ausdauersportarten aus dem Profil plus alle, die in Zielen vorkommen. */
export const activeSports = state =>
  ENDURANCE.filter(s => state.profile?.sports?.[s] || state.races.some(r => raceDef(r)?.[s]));

export function taperDays(r) {
  const d = raceDef(r);
  if (!d) return 0;
  if (r.priority === 'A') return d.taper;
  if (r.priority === 'B') return Math.min(d.taper, Math.max(4, Math.round(d.taper / 2)));
  return 2;
}
export function recoveryDays(r) {
  const d = raceDef(r);
  if (!d) return 0;
  return r.priority === 'C' ? Math.ceil(d.recovery / 2) : d.recovery;
}

// ---------- Profil & Leistungsfähigkeit ----------

const age = p => (p?.birthYear ? new Date().getFullYear() - p.birthYear : 35);
export const maxHr = p => Number(p?.maxHr) || Math.round(208 - 0.7 * age(p));
/** Pulsbereich: Karvonen wenn Ruhepuls bekannt, sonst % HFmax. */
export function hrRange(p, zone) {
  const max = maxHr(p), rest = Number(p?.restHr);
  const k = { z2: [0.6, 0.7], z3: [0.7, 0.8], z4: [0.8, 0.9], z5: [0.9, 1] }[zone];
  const m = { z2: [0.65, 0.75], z3: [0.75, 0.85], z4: [0.85, 0.92], z5: [0.92, 1] }[zone];
  if (rest) return k.map(f => Math.round(rest + f * (max - rest)));
  return m.map(f => Math.round(f * max));
}
export function weeklyMinutes(p) {
  const lo = Number(p?.hoursMin) || 3, hi = Number(p?.hoursMax) || lo + 2;
  return ((lo + hi) / 2) * 60;
}

// ---------- Leistungsfähigkeit ----------
// Intern je Disziplin als "Zeit, kleiner = besser":
//   Laufen: Sekunden für 10 km · Rad: Sekunden für 40 km Zeitfahren · Schwimmen: Schwellentempo Sek./100 m

const MONTH = 30.44;
const UNIT = { run: 10, bike: 40, swim: 0.1 }; // Bezugsstrecke in km
const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function lerp(arr, x) {
  x = clamp(x, 0, arr.length - 1);
  const i = Math.floor(x), f = x - i;
  return i >= arr.length - 1 ? arr[arr.length - 1] : arr[i] * (1 - f) + arr[i + 1] * f;
}

/** Monate seit dem Ergebnis (ohne Datum: 12). */
const ageMonths = date => (date ? Math.max(0, diffDays(date, today()) / MONTH) : 12);
/** Ältere Ergebnisse zählen schwächer: ab 12 Monaten +0,4 %/Monat langsamer, max. +8 %. */
const agePenalty = date => clamp((ageMonths(date) - 12) * 0.004, 0, 0.08);

// Tempo relativ zur Bezugsleistung je Anstrengung (Index = Gefühl 0–10)
const EFFORT_SPEED = {
  run: [0.66, 0.68, 0.71, 0.76, 0.8, 0.85, 0.89, 0.94, 0.99, 1.02, 1.05],
  bike: [0.7, 0.72, 0.74, 0.78, 0.82, 0.86, 0.9, 0.94, 0.98, 1.0, 1.03],
  swim: [0.84, 0.85, 0.86, 0.89, 0.92, 0.94, 0.96, 0.98, 1.0, 1.02, 1.04],
};
// Puls in % HFmax → Gefühl
const HR_RPE = [[0.55, 1], [0.65, 3], [0.75, 5], [0.85, 7], [0.92, 8.5], [0.97, 10]];
function hrToRpe(pct) {
  if (pct <= HR_RPE[0][0]) return 1;
  for (let i = 0; i < HR_RPE.length - 1; i++) {
    const [x0, y0] = HR_RPE[i], [x1, y1] = HR_RPE[i + 1];
    if (pct <= x1) return y0 + ((pct - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 10;
}
/** Anstrengung einer Einheit: Gefühl und Puls (falls vorhanden) gemittelt. */
function effort(s, p) {
  const v = [];
  if (Number(s.rpe)) v.push(Number(s.rpe));
  if (Number(s.avgHr)) v.push(hrToRpe(s.avgHr / maxHr(p)));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : DEFAULT_RPE[s.type] || 4;
}

/** Leistung aus den Trainingseinheiten der letzten 6 Wochen (Tempo bei gegebener Anstrengung). */
function trainingEstimate(state, sport) {
  const t = today(), from = addDays(t, -41);
  const pts = [];
  for (const s of state.sessions) {
    // Wettkämpfe stecken schon in den Ergebnissen (und Triathlon-Splits sind vorermüdet)
    if (s.sport !== sport || !s.distanceKm || s.fromRace || s.date < from || s.date > t) continue;
    if (s.durationMin < 15 || s.durationMin > 300) continue;
    // nur gleichmäßige Einheiten: bei Intervallen sagt das Ø-Tempo wenig aus
    if (!['easy', 'long', 'race'].includes(s.type)) continue;
    const ratio = lerp(EFFORT_SPEED[sport], effort(s, state.profile));
    pts.push({ v: (UNIT[sport] * s.durationMin * 60 * ratio) / s.distanceKm, age: diffDays(s.date, t) });
  }
  if (pts.length < 3) return { n: pts.length };
  // Ausreißer (Tippfehler, GPS-Aussetzer) verwerfen
  const med = median(pts.map(x => x.v));
  const ok = pts.filter(x => x.v > med * 0.75 && x.v < med * 1.33);
  const recent = ok.filter(x => x.age <= 20).map(x => x.v), older = ok.filter(x => x.age > 20).map(x => x.v);
  const all = median(ok.map(x => x.v));
  return {
    n: ok.length,
    value: recent.length >= 2 ? median(recent) * 0.7 + all * 0.3 : all,
    // > 0 = schneller geworden (letzte 3 Wochen vs. die 3 davor)
    trend: recent.length >= 2 && older.length >= 2 ? median(older) / median(recent) - 1 : null,
  };
}

/** Bestes (altersbereinigtes) Wettkampfergebnis je Disziplin + eigene Wechselzeiten. */
function resultBase(state) {
  const best = { run: null, bike: null, swim: null }, transRatios = [];
  const consider = (sport, raw, r, label, estimated = false) => {
    if (!(raw > 0)) return;
    // geschätzte Triathlon-Aufteilung: 2 % Sicherheitsabschlag
    const value = raw * (1 + agePenalty(r.date) + (estimated ? 0.02 : 0));
    if (!best[sport] || value < best[sport].value) best[sport] = { value, label, months: ageMonths(r.date), dated: !!r.date, estimated };
  };
  for (const r of state.results) {
    const d = RACES[r.sport]?.distances[r.distance];
    if (!d || !r.time) continue;
    if (r.sport === 'run') consider('run', r.time * Math.pow(10 / d.run, 1.06), r, `Lauf ${d.label}`);
    else if (r.sport === 'bike') consider('bike', r.time * Math.pow(40 / d.bike, 1.05), r, d.label);
    else {
      const known = r.splits || {};
      const missing = ENDURANCE.filter(k => !known[k]);
      const sp = { ...known };
      if (missing.length) {
        // fehlende Disziplinen über typische Zeitanteile schätzen
        const rest = r.time - d.transition - ENDURANCE.reduce((a, k) => a + (known[k] || 0), 0);
        const shareSum = missing.reduce((a, k) => a + d.shares[k], 0);
        if (rest <= 0) continue;
        for (const k of missing) sp[k] = (rest * d.shares[k]) / shareSum;
      } else {
        const tr = r.time - sp.swim - sp.bike - sp.run;
        if (tr >= 0) transRatios.push(clamp(tr / d.transition, 0.3, 3));
      }
      const label = `Triathlon ${d.label.split(' ')[0]}`;
      const est = k => missing.includes(k);
      // Laufsplit um Vorermüdung bereinigen, Rad ohne Zeitfahr-Bedingungen, Schwimmen im Freiwasser
      consider('run', (sp.run / d.runFatigue) * Math.pow(10 / d.run, 1.06), r, label, est('run'));
      consider('bike', (sp.bike / 1.02) * Math.pow(40 / d.bike, 1.05), r, label, est('bike'));
      consider('swim', sp.swim / (d.swim * 10) / 1.08, r, label, est('swim'));
    }
  }
  return { best, transFactor: transRatios.length ? transRatios.reduce((a, b) => a + b, 0) / transRatios.length : 1 };
}

/**
 * Fitness je Disziplin (42-Tage-Schnitt der Belastung). Andere Ausdauersportarten
 * zählen zu 20 % mit, Kraft zu 10 %. Ergebnis: Prognose-Bonus −4 % … +5 %.
 */
export function sportFitness(state) {
  const p = state.profile, chosen = ENDURANCE.filter(s => p?.sports?.[s]), n = chosen.length || 1;
  const seed = seedLoad(p), loads = {};
  let first = state.createdAt || today();
  for (const s of state.sessions) {
    if (s.date < first) first = s.date;
    const L = (loads[s.date] ||= { swim: 0, bike: 0, run: 0 });
    for (const e of ENDURANCE) L[e] += sessionLoad(s) * (s.sport === e ? 1 : s.sport === 'strength' ? 0.1 : 0.2);
  }
  const seeds = {}, ctl = {};
  for (const e of ENDURANCE) {
    const share = chosen.includes(e) ? 1 / n : 0;
    seeds[e] = ctl[e] = Math.max(seed * (share + 0.2 * (1 - share)), 1);
  }
  for (let d = first, t = today(); d <= t; d = addDays(d, 1)) {
    for (const e of ENDURANCE) ctl[e] += ((loads[d]?.[e] || 0) - ctl[e]) / 42;
  }
  return Object.fromEntries(ENDURANCE.map(e => [e, {
    ctl: ctl[e], seed: seeds[e], factor: clamp((ctl[e] / seeds[e] - 1) * 0.05, -0.04, 0.05),
  }]));
}

/** Wettkampfergebnis und Trainingstempo kombinieren. */
function combine(res, train, fallback) {
  if (res && train.value) {
    const wRes = 1 / (1 + Math.max(0, res.months - 6) / 12);
    const wTr = Math.min(train.n / 8, 1) * 0.6;
    // Training darf ein frisches Ergebnis um max. 6 % verschieben, ein altes um bis zu 15 %
    const span = Math.min(0.06 + (Math.max(0, res.months - 12) / 12) * 0.04, 0.15);
    const v = (res.value * wRes + train.value * wTr) / (wRes + wTr);
    return { value: clamp(v, res.value * (1 - span), res.value * (1 + span)), src: 'Wettkampf + Training' };
  }
  if (res) return { value: res.value, src: res.estimated ? 'Wettkampf, Aufteilung geschätzt' : 'Wettkampfergebnis' };
  if (train.value) return { value: train.value, src: 'Trainingstempo' };
  return fallback;
}

/**
 * Leistungsfähigkeit je Disziplin aus Wettkampfergebnissen, Trainingstempo, Profil und Fitness.
 * run10 = 10-km-Zeit, v40 = 40-km-Zeitfahrtempo, css = Schwellentempo /100 m.
 */
export function abilities(state) {
  const p = state.profile || {};
  const lvl = p.level || 'fortgeschritten';
  const { best, transFactor } = resultBase(state);
  const fit = sportFitness(state);
  const fallback = {
    run: p.runEasyPace ? { value: p.runEasyPace * 0.82 * 10, src: 'Wohlfühltempo' }
      : { value: { einsteiger: 3600, fortgeschritten: 3060, ambitioniert: 2580 }[lvl], src: 'Schätzung' },
    bike: p.bikeEasySpeed ? { value: (40 / (p.bikeEasySpeed * 1.22)) * 3600, src: 'Wohlfühltempo' }
      : { value: (40 / { einsteiger: 27, fortgeschritten: 32, ambitioniert: 37 }[lvl]) * 3600, src: 'Schätzung' },
    swim: p.swimEasyPace ? { value: p.swimEasyPace * 0.92, src: 'Wohlfühltempo' }
      : { value: { einsteiger: 150, fortgeschritten: 120, ambitioniert: 100 }[lvl], src: 'Schätzung' },
  };
  const detail = {};
  for (const s of ENDURANCE) {
    const train = trainingEstimate(state, s);
    const c = combine(best[s], train, fallback[s]);
    // Wenn das Trainingstempo schon einfließt, zählt der reine Umfang nur halb
    const fitFactor = fit[s].factor * (train.value ? 0.5 : 1);
    detail[s] = { value: c.value, src: c.src, result: best[s], train, fit: fit[s], fitFactor };
  }
  const run10 = detail.run.value, v40 = 40 / (detail.bike.value / 3600), css = detail.swim.value;
  // Lockeres Tempo (Gefühl ≈ 3,5): aus dem Training, sonst Profil, sonst abgeleitet
  const easy = s => lerp(EFFORT_SPEED[s], 3.5);
  return {
    run10, v40, css, detail, transFactor,
    runSrc: detail.run.src, bikeSrc: detail.bike.src, swimSrc: detail.swim.src,
    runEasy: detail.run.train.value ? run10 / 10 / easy('run') : p.runEasyPace || (run10 / 10) * 1.3,
    bikeEasy: detail.bike.train.value ? v40 * easy('bike') : p.bikeEasySpeed || v40 * 0.8,
    swimEasy: detail.swim.train.value ? css / easy('swim') : p.swimEasyPace || css * 1.1,
  };
}

/**
 * Beständigkeit der letzten 4 Wochen (Pausen ausgenommen): halb Umfang vs. Richtwert,
 * halb Anteil der Wochen mit mind. 2 Einheiten. null, solange weniger als 2 Wochen Daten.
 */
export function consistency(state) {
  const t = today();
  let start = state.createdAt || t;
  for (const s of state.sessions) if (s.date < start) start = s.date;
  const days = Math.min(28, diffDays(start, t) + 1);
  if (days < 14) return null;
  const from = addDays(t, -(days - 1));
  const inPause = d => state.pauses.some(x => d >= x.from && d <= x.to);
  let active = 0;
  for (let d = from; d <= t; d = addDays(d, 1)) if (!inPause(d)) active++;
  if (active < 7) return null;
  const ss = state.sessions.filter(s => s.date >= from && s.date <= t);
  const volRatio = Math.min(ss.reduce((a, s) => a + (s.durationMin || 0), 0) / (weeklyMinutes(state.profile) * (active / 7)), 1.2);
  let weeks = 0, regular = 0;
  for (let end = t; diffDays(from, end) >= 6; end = addDays(end, -7)) {
    const ws = addDays(end, -6);
    let pauseDays = 0;
    for (let d = ws; d <= end; d = addDays(d, 1)) if (inPause(d)) pauseDays++;
    if (pauseDays >= 4) continue;
    weeks++;
    if (ss.filter(s => s.date >= ws && s.date <= end).length >= 2) regular++;
  }
  const reg = weeks ? regular / weeks : 1;
  return { value: clamp(0.5 * volRatio + 0.5 * reg, 0.3, 1.2), volRatio, regular: reg };
}

// ---------- Belastung (Fitness / Ermüdung) ----------

export const sessionLoad = s => ((s.durationMin || 0) * (Number(s.rpe) || DEFAULT_RPE[s.type] || 5)) / 10;
const seedLoad = p => (weeklyMinutes(p) * 4.5) / 10 / 7;

/** Tägliche Reihe mit Fitness (42-Tage-Schnitt) und Ermüdung (7-Tage-Schnitt). */
export function fitnessSeries(state, end = today(), days = 120) {
  const loads = {};
  let first = state.createdAt || end;
  for (const s of state.sessions) {
    loads[s.date] = (loads[s.date] || 0) + sessionLoad(s);
    if (s.date < first) first = s.date;
  }
  const start = addDays(end, -days);
  let ctl = seedLoad(state.profile), atl = ctl;
  const out = [];
  for (let d = first; d <= end; d = addDays(d, 1)) {
    const L = loads[d] || 0;
    ctl += (L - ctl) / 42;
    atl += (L - atl) / 7;
    if (d >= start) out.push({ date: d, ctl, atl, load: L });
  }
  if (!out.length) out.push({ date: end, ctl, atl, load: 0 });
  return out;
}

export function loadStatus(state) {
  const s = fitnessSeries(state);
  const { ctl, atl } = s[s.length - 1];
  const ratio = atl / Math.max(ctl, 1);
  let label, tone;
  if (ratio > 1.5) { label = 'Überlastungsgefahr – Ruhe einplanen'; tone = 'bad'; }
  else if (ratio > 1.25) { label = 'Hohe Belastung – auf den Körper hören'; tone = 'warn'; }
  else if (ratio >= 0.8) { label = 'Im grünen Bereich'; tone = 'good'; }
  else { label = 'Erholt – Belastung darf steigen'; tone = 'info'; }
  return { ctl, atl, form: ctl - atl, ratio, label, tone };
}

// ---------- Prognose ----------

export function predict(state, race, ab = abilities(state)) {
  const d = raceDef(race);
  if (!d) return null;
  // Fitness wirkt je Disziplin
  const f = s => 1 - ab.detail[s].fitFactor;
  const runT = km => ab.run10 * Math.pow(km / 10, 1.06) * f('run');
  const bikeT = km => (40 / ab.v40) * 3600 * Math.pow(km / 40, 1.05) * f('bike');
  if (race.sport === 'run') return { total: runT(d.run) };
  if (race.sport === 'bike') return { total: bikeT(d.bike) };
  const splits = {
    swim: d.swim * 10 * ab.css * 1.08 * f('swim'),
    bike: bikeT(d.bike) * 1.02,
    run: runT(d.run) * d.runFatigue,
    trans: d.transition * ab.transFactor,
  };
  return { total: splits.swim + splits.bike + splits.run + splits.trans, splits };
}

/** Prognose heute, Potenzial bis zum Wettkampf und Einschätzung der Zielzeit. */
export function assessGoal(state, race) {
  const pred = predict(state, race);
  if (!pred) return null;
  const weeks = Math.max(0, diffDays(today(), race.date) / 7);
  const rate = LEVELS[state.profile?.level || 'fortgeschritten'].rate;
  // Wer regelmäßig trainiert, kann bis zum Wettkampf mehr aufholen
  const cons = consistency(state);
  const potential = pred.total * (1 - Math.min(weeks, 26) * rate * (cons?.value ?? 1));
  const res = { pred, potential, weeks, cons };
  if (!race.target) return res;
  const t = race.target;
  if (t >= pred.total) Object.assign(res, { rating: 'Auf Kurs', tone: 'good' });
  else if (t >= potential) Object.assign(res, { rating: 'Realistisch', tone: 'good' });
  else if (t >= potential * 0.97) Object.assign(res, { rating: 'Ambitioniert', tone: 'warn' });
  else Object.assign(res, { rating: 'Sehr ambitioniert', tone: 'bad' });
  return res;
}

/** Zieltempo je Disziplin für einen Wettkampf (Zielzeit, sonst Prognose). */
function racePace(state, race, sport, ab) {
  const d = race && raceDef(race);
  if (!d || !d[sport]) return null;
  const pred = predict(state, race, ab);
  const scale = race.target ? race.target / pred.total : 1;
  let sec;
  if (race.sport === 'tri') sec = race.targetSplits?.[sport] || pred.splits[sport] * scale;
  else if (race.sport === sport) sec = race.target || pred.total;
  else return null;
  if (sport === 'run') return sec / d.run;
  if (sport === 'bike') return d.bike / (sec / 3600);
  return sec / (d.swim * 10);
}

// ---------- Tageskontext: Pause, Tapering, Regeneration, Wiedereinstieg ----------

export function dayContext(state, date) {
  for (const p of state.pauses) if (date >= p.from && date <= p.to) return { mode: 'pause', pause: p };
  const races = sortedRaces(state);
  for (const r of races) {
    const dd = diffDays(date, r.date);
    if (dd >= 0 && dd <= taperDays(r)) return { mode: 'taper', race: r, offset: -dd };
  }
  for (const r of races) {
    const dd = diffDays(r.date, date);
    if (dd > 0 && dd <= recoveryDays(r)) return { mode: 'recovery', race: r, day: dd, until: addDays(r.date, recoveryDays(r)) };
  }
  for (const p of state.pauses) {
    const len = diffDays(p.from, p.to) + 1, since = diffDays(p.to, date), win = Math.min(14, len);
    // erster Tag danach 60 %, dann linear bis 100 %
    if (since > 0 && since <= win) return { mode: 'reentry', pause: p, factor: 0.6 + 0.4 * ((since - 1) / win), until: addDays(p.to, win) };
  }
  return { mode: 'build' };
}

// ---------- Intensitätsangaben ----------

export function intensity(state, sport, variant, race, ab = abilities(state)) {
  const p = state.profile;
  const z = zone => { const [a, b] = hrRange(p, zone); return `Puls ${a}–${b}`; };
  const rp = racePace(state, race, sport, ab);
  if (sport === 'run') {
    const t10 = ab.run10 / 10;
    return {
      easy: `Zone 2: ${fmtPace(ab.runEasy * 0.98)} – ${fmtPace(ab.runEasy * 1.06)} · ${z('z2')}`,
      long: `Ruhig in Zone 2: ${fmtPace(ab.runEasy)} – ${fmtPace(ab.runEasy * 1.08)} · ${z('z2')}`,
      fartlek: `Locker einlaufen, dann 8–10 × 1′ zügig (≈ ${fmtPace(t10)}) / 1′ locker`,
      tempo: `2 × 12–15′ an der Schwelle @ ${fmtPace(t10 * 1.05)} · ${z('z4')}`,
      interval: `5–6 × 1000 m @ ${fmtPace(t10 * 0.97)}, 2–3′ Trabpause`,
      racepace: rp ? `3 × 2–3 km im Wettkampftempo @ ${fmtPace(rp)}, 3′ Trabpause` : `3 × 2 km @ ${fmtPace(t10 * 1.03)}`,
      activation: `15–20′ locker + 3 kurze Steigerungen`,
    }[variant];
  }
  if (sport === 'bike') {
    return {
      easy: `Zone 2: ca. ${fmtSpeed(ab.bikeEasy * 0.95)} – ${fmtSpeed(ab.bikeEasy * 1.03)} (flach) · ${z('z2')}`,
      long: `Gleichmäßig Zone 2, ca. ${fmtSpeed(ab.bikeEasy * 0.95)} · regelmäßig essen & trinken`,
      fartlek: `Grundlage mit 6 × 2′ zügig, frei nach Gelände`,
      tempo: `3 × 12′ Sweetspot ≈ ${fmtSpeed(ab.v40 * 0.92)} · ${z('z3')}`,
      interval: `5 × 4′ hart ≈ ${fmtSpeed(ab.v40 * 1.02)}, 4′ locker · ${z('z5')}`,
      racepace: rp ? `3 × 15′ im Wettkampftempo ≈ ${fmtSpeed(rp)}` : `3 × 12′ ≈ ${fmtSpeed(ab.v40 * 0.95)}`,
      activation: `20–30′ locker mit 3 × 1′ zügig, Rad durchchecken`,
    }[variant];
  }
  if (sport === 'swim') {
    return {
      easy: `Technik-Drills + lockere 100er @ ${fmtSwim(ab.swimEasy)}`,
      long: `z. B. 4 × 400 m @ ${fmtSwim(ab.css * 1.06)}, 30″ Pause`,
      fartlek: `Pyramide 100-200-300-200-100 m @ ${fmtSwim(ab.css * 1.03)}`,
      tempo: `4 × 300 m @ ${fmtSwim(ab.css * 1.02)}, 30″ Pause`,
      interval: `10 × 100 m @ ${fmtSwim(ab.css * 0.98)}, 15″ Pause`,
      racepace: rp ? `6 × 200 m im Wettkampftempo @ ${fmtSwim(rp)}` : `6 × 200 m @ ${fmtSwim(ab.css)}`,
      activation: `15–20′ locker, ein paar Sprints, Neo testen`,
    }[variant];
  }
  return 'Ganzkörper: Kniebeuge, Kreuzheben, Ausfallschritte, Rudern, Rumpf · 3 × 8–12 Wdh.';
}

const TITLES = {
  run: { easy: 'Lockerer Lauf', long: 'Langer Lauf', fartlek: 'Fahrtspiel', tempo: 'Tempodauerlauf', interval: 'Intervalle', racepace: 'Wettkampftempo', activation: 'Aktivierung' },
  bike: { easy: 'Grundlagen-Ausfahrt', long: 'Lange Ausfahrt', fartlek: 'Tempowechsel', tempo: 'Sweetspot', interval: 'Intervalle', racepace: 'Wettkampftempo-Blöcke', activation: 'Aktivierung' },
  swim: { easy: 'Technik & locker', long: 'Ausdauerschwimmen', fartlek: 'Pyramide', tempo: '300er-Serie', interval: '100er-Serie', racepace: 'Wettkampftempo', activation: 'Aktivierung' },
  strength: { strength: 'Krafttraining (Studio)' },
};
const VARIANT_TYPE = { easy: 'easy', long: 'long', fartlek: 'tempo', tempo: 'tempo', interval: 'interval', racepace: 'tempo', activation: 'easy', strength: 'strength' };

function makeRec(state, sport, variant, durationMin, race, prio, ab) {
  return {
    sport, variant, type: VARIANT_TYPE[variant], durationMin: round5(durationMin), prio,
    cat: variant === 'long' ? 'long' : variant === 'easy' ? 'easy' : variant === 'strength' ? 'strength' : 'quality',
    title: TITLES[sport][variant],
    detail: intensity(state, sport, variant, race, ab),
  };
}

// ---------- Fixes Tapering ----------

// Letzte Woche vor dem Wettkampf: Offset → Einheiten (share = Anteil Wochenminuten, min = fixe Minuten)
const FINAL_WEEK = {
  run: {
    '-7': [['run', 'long', 0.2]], '-6': [['run', 'easy', 0.12]], '-5': [['run', 'racepace', 0.13]],
    '-4': [], '-3': [['run', 'easy', 0.09]], '-2': [], '-1': [['run', 'activation', null, 20]],
  },
  bike: {
    '-7': [['bike', 'long', 0.25]], '-6': [['bike', 'easy', 0.15]], '-5': [['bike', 'racepace', 0.15]],
    '-4': [], '-3': [['bike', 'easy', 0.1]], '-2': [], '-1': [['bike', 'activation', null, 30]],
  },
  tri: {
    '-7': [['bike', 'easy', 0.15]], '-6': [['swim', 'racepace', 0.07], ['run', 'easy', 0.07]],
    '-5': [['bike', 'racepace', 0.1]], '-4': [], '-3': [['swim', 'easy', 0.05], ['run', 'racepace', 0.06]],
    '-2': [['swim', 'activation', null, 20]], '-1': [['bike', 'activation', null, 20], ['run', 'activation', null, 10]],
  },
};
// Reduzierte Wochen davor (Muster über 7 Tage, Index = Tage vor Wettkampf % 7)
const REDUCED_WEEK = {
  run: [[['run', 'long', 0.28]], [['run', 'easy', 0.14]], [], [['run', 'racepace', 0.15]], [['run', 'easy', 0.14]], [], [['run', 'interval', 0.15]]],
  bike: [[['bike', 'long', 0.3]], [['bike', 'easy', 0.15]], [], [['bike', 'racepace', 0.17]], [['bike', 'easy', 0.15]], [], [['bike', 'interval', 0.15]]],
  tri: [[['bike', 'long', 0.28]], [['run', 'long', 0.14]], [['swim', 'interval', 0.08]], [['bike', 'racepace', 0.14], ['run', 'easy', 0.05]], [['swim', 'easy', 0.07], ['run', 'racepace', 0.08]], [], [['swim', 'long', 0.08], ['run', 'easy', 0.08]]],
};

export function taperPlan(state, race) {
  const n = taperDays(race), wm = weeklyMinutes(state.profile), ab = abilities(state);
  const rd = raceDef(race), cap = longCaps(rd.run || 0, rd.bike || 0);
  const done = state.sessions.filter(s => s.date >= addDays(race.date, -n) && s.date <= race.date);
  const days = [];
  for (let off = -n; off <= 0; off++) {
    const date = addDays(race.date, off);
    if (off === 0) {
      days.push({ date, off, race: true, items: [{ sport: race.sport, title: `Wettkampf: ${raceTitle(race)}`, detail: raceDayText(state, race), done: !!race.resultTime || done.some(s => s.date === date && s.type === 'race') }] });
      continue;
    }
    let tpl, factor = 1, weeksOut = 0;
    if (off >= -7) tpl = FINAL_WEEK[race.sport][String(off)];
    else {
      weeksOut = Math.ceil((-off - 7) / 7); // 1 = Woche vor der letzten Woche
      factor = weeksOut === 1 ? 0.7 : 0.82;
      tpl = REDUCED_WEEK[race.sport][-off % 7];
    }
    const items = tpl.map(([sport, variant, share, fixed]) => {
      let min = fixed ?? clamp(wm * share * factor, 20, cap[sport]);
      // lange Einheiten richten sich nach der Wettkampfdistanz (z. B. Marathon: 3 Wochen vorher ~2,5 h)
      if (variant === 'long' && weeksOut) min = Math.min(Math.max(min, cap[sport] * (weeksOut >= 2 ? 0.8 : 0.6)), cap[sport]);
      // in der letzten Woche höchstens halb so lang wie die längste Einheit
      if (variant === 'long' && !weeksOut) min = Math.min(min, cap[sport] * 0.5);
      const rec = makeRec(state, sport, variant, min, race, 3, ab);
      rec.done = done.some(s => s.date === date && s.sport === sport);
      return rec;
    });
    days.push({ date, off, items });
  }
  return days;
}

function raceDayText(state, race) {
  const g = assessGoal(state, race);
  const t = race.target || g?.pred.total;
  return race.target ? `Zielzeit ${fmtTime(t)} – viel Erfolg! Ruhig starten, Tempo halten.` : `Prognose ≈ ${fmtTime(t)} – viel Erfolg!`;
}

// ---------- Wochenempfehlungen ----------

const MIX = {
  run: { run: 1 }, bike: { bike: 1 },
  sprint: { swim: 0.22, bike: 0.4, run: 0.38 }, olympic: { swim: 0.2, bike: 0.45, run: 0.35 },
  middle: { swim: 0.17, bike: 0.5, run: 0.33 }, long: { swim: 0.15, bike: 0.55, run: 0.3 },
};
const PRIO_W = { A: 1, B: 0.6, C: 0.3 };
const PHASE_F = { Grundlage: 0.9, Aufbau: 1, Spezifisch: 1.05 };

/** Gewichtung der Disziplinen aus allen anstehenden Zielen (nähere zählen stärker). */
export function focus(state, date) {
  const up = sortedRaces(state).filter(r => r.date >= date && diffDays(date, r.date) <= 280);
  const mix = {};
  let best = null, bestW = -1;
  for (const r of up) {
    const w = PRIO_W[r.priority] / (1 + diffDays(date, r.date) / 28);
    const m = r.sport === 'tri' ? MIX[r.distance] : MIX[r.sport];
    for (const k in m) mix[k] = (mix[k] || 0) + w * m[k];
    if (w > bestW) { bestW = w; best = r; }
  }
  if (!best) {
    const sp = activeSports(state);
    (sp.length ? sp : ['run']).forEach(s => (mix[s] = 1));
  }
  const sum = Object.values(mix).reduce((a, b) => a + b, 0);
  for (const k in mix) mix[k] /= sum;
  const phaseOf = r => {
    const w = r ? diffDays(date, r.date) / 7 : 99;
    return w > 12 ? 'Grundlage' : w > 6 ? 'Aufbau' : 'Spezifisch';
  };
  // Je Disziplin zählt der nächste Wettkampf, in dem sie vorkommt
  const bySport = {};
  for (const s of ENDURANCE) {
    const r = up.find(x => raceDef(x)[s]);
    bySport[s] = { race: r || best, phase: phaseOf(r || best) };
  }
  return { mix, race: best, weeks: best ? diffDays(date, best.date) / 7 : null, phase: phaseOf(best), bySport };
}

/** Maximale Dauer einer langen Einheit (min) abhängig von der längsten Wettkampfstrecke. */
const longCaps = (run, bike) => ({
  run: run >= 40 ? 180 : run >= 21 ? 130 : run >= 10 ? 100 : 80,
  bike: bike >= 180 ? 330 : bike >= 90 ? 240 : bike >= 40 ? 150 : 120,
  swim: 75,
});

function caps(state, date) {
  let run = 0, bike = 0;
  for (const r of sortedRaces(state).filter(r => r.date >= date)) {
    const d = raceDef(r);
    run = Math.max(run, d.run || 0); bike = Math.max(bike, d.bike || 0);
  }
  return longCaps(run, bike);
}

function sportRecs(state, sport, m, f, quality, cap, ab) {
  const cfg = {
    run: { easy: [30, 60], minLong: 90, q: [40, 75] },
    bike: { easy: [45, 90], minLong: 150, q: [60, 90] },
    swim: { easy: [30, 50], minLong: 90, q: [35, 60] },
  }[sport];
  const { race, phase } = f.bySport[sport];
  const out = [];
  let rest = m;
  if (m < 20) return out;
  if (m >= cfg.minLong) {
    const L = clamp(m * 0.35, 45, cap);
    out.push(makeRec(state, sport, 'long', L, race, 3, ab));
    rest -= L;
  }
  if (quality && m >= 45) {
    const nq = phase === 'Grundlage' || m < 180 ? 1 : 2;
    const variants = { Grundlage: ['fartlek'], Aufbau: ['interval', 'tempo'], Spezifisch: ['racepace', 'interval'] }[phase];
    for (let i = 0; i < nq; i++) {
      const Q = clamp(m * 0.2, cfg.q[0], cfg.q[1]);
      out.push(makeRec(state, sport, variants[i], Q, race, i === 0 ? 3 : 2, ab));
      rest -= Q;
    }
  }
  let first = true;
  while (rest >= cfg.easy[0] * 0.8 || (!out.length && rest >= 20)) {
    const E = clamp(rest, cfg.easy[0], cfg.easy[1]);
    out.push(makeRec(state, sport, 'easy', E, race, first ? 2 : 1, ab));
    rest -= E; first = false;
  }
  return out;
}

function countPauseDays(state, from, to) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (state.pauses.some(x => d >= x.from && d <= x.to)) n++;
  return n;
}

/** Ø Trainingsminuten pro Woche in den 4 Wochen vor `ws` (Pausen herausgerechnet); null bei < 2 Wochen Daten. */
function recentWeeklyMinutes(state, ws) {
  let start = state.createdAt || ws;
  for (const s of state.sessions) if (s.date < start) start = s.date;
  const days = Math.min(28, diffDays(start, ws));
  if (days < 14) return null;
  const from = addDays(ws, -days), to = addDays(ws, -1);
  const active = days - countPauseDays(state, from, to);
  if (active < 7) return null;
  const sum = state.sessions.filter(s => s.date >= from && s.date <= to).reduce((a, s) => a + (s.durationMin || 0), 0);
  return sum / (active / 7);
}

const isHard = s => ['tempo', 'interval', 'race', 'long'].includes(s.type) || Number(s.rpe) >= 7;
const ORDER = { long: 0, quality: 1, easy: 2, strength: 3 };

export function weekPlan(state, date = today()) {
  const p = state.profile, ab = abilities(state);
  const ctx = dayContext(state, date);
  const ws = weekStart(date), we = addDays(ws, 6);
  const done = state.sessions.filter(s => s.date >= ws && s.date <= we);
  const res = { ctx, ws, we, done, recs: [], extras: [], notes: [], status: loadStatus(state) };

  if (ctx.mode === 'pause') return res;
  if (ctx.mode === 'taper') { res.taper = taperPlan(state, ctx.race); return res; }

  const f = (res.focus = focus(state, date));
  let minutes = Math.min(weeklyMinutes(p) * PHASE_F[f.phase], (Number(p.hoursMax) || 5) * 60);
  let quality = true;

  // Umfang nur schrittweise steigern: max. +20 % gegenüber dem Schnitt der letzten 4 Wochen
  // (mind. +1,5 h bzw. 40 % des Richtwerts, damit Neu-/Wiedereinsteiger nicht ausgebremst werden)
  const recent = recentWeeklyMinutes(state, ws);
  if (recent != null) {
    const ramp = Math.max(recent * 1.2, recent + 90, weeklyMinutes(p) * 0.4);
    if (minutes > ramp) {
      minutes = ramp;
      if (ctx.mode === 'build') res.notes.push({ tone: 'info', text: `Umfang wird schrittweise gesteigert (zuletzt Ø ${fmtNum(recent / 60)} h pro Woche).` });
    }
  }

  if (ctx.mode === 'recovery') {
    minutes *= 0.5; quality = false;
    res.notes.push({ tone: 'info', text: `Regeneration nach „${raceTitle(ctx.race)}“: bis ${ctx.until.split('-').reverse().slice(0, 2).join('.')}. nur locker.` });
  }
  if (ctx.mode === 'reentry') {
    minutes *= ctx.factor;
    if (ctx.factor < 0.8) quality = false;
    res.notes.push({ tone: 'info', text: `Wiedereinstieg nach der Pause – Umfang auf ${Math.round(ctx.factor * 100)} % reduziert.` });
  }
  // Pausentage dieser Woche (vergangen oder geplant) abziehen
  const pauseDays = countPauseDays(state, ws, we);
  if (pauseDays) {
    minutes *= (7 - pauseDays) / 7;
    res.notes.push({ tone: 'info', text: `${pauseDays} Pausentag${pauseDays > 1 ? 'e' : ''} diese Woche – Umfang entsprechend reduziert.` });
  }
  const next = sortedRaces(state).find(r => r.date > date);
  if (next) {
    const tStart = addDays(next.date, -taperDays(next));
    if (tStart <= we) {
      minutes *= Math.max(0, diffDays(ws, tStart)) / 7;
      res.notes.push({ tone: 'info', text: `Ab ${tStart.split('-').reverse().slice(0, 2).join('.')}. beginnt das Tapering für „${raceTitle(next)}“.` });
    }
  }
  if (res.status.ratio > 1.5) {
    quality = false;
    res.notes.push({ tone: 'bad', text: 'Deine Belastung ist zuletzt stark gestiegen – diese Woche keine harten Einheiten.' });
  }
  res.targetMin = minutes;

  const recs = [];
  if (p.sports?.strength && minutes >= 120) {
    const n = minutes >= 420 ? 2 : 1;
    for (let i = 0; i < n; i++) recs.push(makeRec(state, 'strength', 'strength', 45, f.race, i ? 1 : 2, ab));
    minutes -= 45 * n;
  }
  const cap = caps(state, date);
  for (const [sport, share] of Object.entries(f.mix)) recs.push(...sportRecs(state, sport, minutes * share, f, quality, cap[sport], ab));

  // ~80/20: höchstens 2 (unter 6 h) bzw. 3 harte Lauf-/Rad-Einheiten pro Woche
  const maxQ = minutes < 360 ? 2 : 3;
  recs.filter(r => r.cat === 'quality' && r.sport !== 'swim')
    .sort((a, b) => b.prio - a.prio || f.mix[b.sport] - f.mix[a.sport])
    .slice(maxQ)
    .forEach(r => Object.assign(r, makeRec(state, r.sport, 'easy', r.durationMin, f.bySport[r.sport].race, 1, ab)));

  // Erledigte Einheiten den Empfehlungen zuordnen
  const pool = [...done];
  const matchers = {
    long: (r, s) => s.type === 'long' || (!['tempo', 'interval'].includes(s.type) && s.durationMin >= r.durationMin * 0.75),
    quality: (r, s) => ['tempo', 'interval', 'race'].includes(s.type) || Number(s.rpe) >= 7,
    easy: () => true,
    strength: () => true,
  };
  for (const r of [...recs].sort((a, b) => ORDER[a.cat] - ORDER[b.cat])) {
    const i = pool.findIndex(s => s.sport === r.sport && matchers[r.cat](r, s));
    if (i >= 0) r.doneBy = pool.splice(i, 1)[0];
  }
  res.extras = pool;

  // Ermüdung: harte Einheiten nicht direkt hintereinander
  const lastHard = state.sessions.filter(s => s.date <= date && isHard(s)).sort((a, b) => b.date.localeCompare(a.date))[0];
  const sinceHard = lastHard ? diffDays(lastHard.date, date) : 99;
  for (const r of recs) if (r.cat === 'quality' && !r.doneBy && sinceHard <= 1) r.wait = sinceHard === 0 ? 'ideal ab übermorgen' : 'ideal ab morgen';

  recs.sort((a, b) => !!a.doneBy - !!b.doneBy || b.prio - a.prio || ORDER[a.cat] - ORDER[b.cat]);
  res.recs = recs;

  const open = recs.filter(r => !r.doneBy);
  const doneToday = state.sessions.some(s => s.date === date);
  if (doneToday) res.today = { text: 'Heute schon trainiert – stark! Jetzt gut erholen.' };
  else if (res.status.ratio > 1.5) res.today = { text: 'Heute Ruhetag oder ganz locker bewegen.' };
  else if (!open.length) res.today = { text: 'Wochenziel erreicht 🎉 – alles Weitere ist Bonus.' };
  else {
    const pick = sinceHard <= 1 ? open.find(r => r.cat === 'easy' || r.cat === 'strength') : open.find(r => !r.wait);
    res.today = pick ? { rec: pick, text: sinceHard <= 1 ? 'Nach der harten Einheit: heute eher locker.' : 'Heute ideal:' } : { text: 'Heute Ruhetag – die harten Einheiten passen ab morgen besser.' };
  }
  return res;
}
