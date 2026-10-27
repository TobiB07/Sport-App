import { state, save, upsert, remove, replaceState, resetState, demoState } from './store.js';
import { SPORTS, RACES, PRIORITIES, LEVELS, TYPES, DEFAULT_RPE, RPE_LABELS, PAUSE_REASONS, ENDURANCE } from './data.js';
import {
  weekPlan, dayContext, taperPlan, taperDays, recoveryDays, raceDef, raceTitle, sortedRaces, assessGoal,
  abilities, hrRange, maxHr, fitnessSeries, loadStatus, consistency, predict, activeSports,
} from './engine.js';
import {
  today, addDays, diffDays, weekStart, pd, iso, WD, fmtDate, parseTime, fmtTime, fmtPace, fmtSwim, fmtSpeed,
  fmtDur, fmtNum, esc, uid,
} from './util.js';

const $ = sel => document.querySelector(sel);
const app = $('#app'), modalEl = $('#modal');
let calMonth = today().slice(0, 7);

// ---------- Helfer ----------

const sportIcon = s => (s === 'tri' ? '🏊🚴🏃' : SPORTS[s]?.icon || '🏁');
const shortDate = s => fmtDate(s, { day: 'numeric', month: 'numeric' });
const longDate = s => fmtDate(s, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
const stars = n => '★'.repeat(n) + '☆'.repeat(3 - n);
function sessionSummary(s) {
  // sekundengenau, falls so eingetragen (52:30 statt „53 min“)
  const sec = Math.round(s.durationMin * 60);
  const parts = [sec % 60 ? `${fmtTime(sec)} ${sec >= 3600 ? 'h' : 'min'}` : fmtDur(s.durationMin)];
  if (s.distanceKm) {
    if (s.sport === 'swim') parts.push(`${Math.round(s.distanceKm * 1000)} m`, fmtSwim((s.durationMin * 60) / (s.distanceKm * 10)));
    else if (s.sport === 'bike') parts.push(`${fmtNum(s.distanceKm)} km`, fmtSpeed(s.distanceKm / (s.durationMin / 60)));
    else parts.push(`${fmtNum(s.distanceKm)} km`, fmtPace((s.durationMin * 60) / s.distanceKm));
  }
  if (s.rpe) parts.push(`Gefühl ${s.rpe}/10`);
  return parts.join(' · ');
}
const typeLabel = s => TYPES[s.sport]?.[s.type] || '';

// ---------- Zeitfelder ----------
// Getrennte Kästchen für Std/Min/Sek: Die Zifferntastatur am Handy hat keinen Doppelpunkt.
// Der Wert landet als "h:mm:ss" in einem versteckten Feld mit dem eigentlichen Namen.

const pad2 = n => String(n).padStart(2, '0');
const toHms = sec => `${Math.floor(sec / 3600)}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;

function timeField(name, sec, { hours = true, label = '', live = '' } = {}) {
  const has = Number(sec) > 0;
  sec = has ? Math.round(sec) : 0;
  const h = Math.floor(sec / 3600), m = hours ? Math.floor((sec % 3600) / 60) : Math.floor(sec / 60), s = sec % 60;
  const part = (p, v, ph) => `<input type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="2"
      data-part="${p}" value="${!has || (p === 'h' && !v) ? '' : p === 'h' ? v : pad2(v)}" placeholder="${ph}"
      aria-label="${label ? `${label} – ` : ''}${{ h: 'Stunden', m: 'Minuten', s: 'Sekunden' }[p]}">`;
  return `<div class="tfield">${label ? `<span class="tlabel">${label}</span>` : ''}
    <div class="tparts">${hours ? `${part('h', h, 'Std')}<span>:</span>` : ''}${part('m', m, 'Min')}<span>:</span>${part('s', s, 'Sek')}</div>
    <input type="hidden" name="${name}" value="${has ? toHms(sec) : ''}"${live ? ` data-live="${live}"` : ''}>
  </div>`;
}
/** Kästchen → verstecktes Feld; gibt das versteckte Feld zurück. */
function syncTimeField(part) {
  const wrap = part.closest('.tfield'), hidden = wrap.querySelector('input[type=hidden]');
  const v = p => Number(wrap.querySelector(`[data-part="${p}"]`)?.value.replace(/\D/g, '') || 0);
  const sec = v('h') * 3600 + v('m') * 60 + v('s');
  hidden.value = sec ? toHms(sec) : '';
  return hidden;
}
/** Kommazahl lesen ("12,5" oder "12.5"); leer/ungültig → null. */
const readNum = v => {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return isFinite(n) ? n : null;
};
const decimalInput = (name, value, attrs = '') =>
  `<input type="text" inputmode="decimal" name="${name}" value="${value == null ? '' : String(value).replace('.', ',')}" autocomplete="off" ${attrs}>`;

// ---------- Triathlon: Zeiten je Disziplin ----------

const TRI = ['swim', 'bike', 'run'];
/** Eingabefelder Schwimmen/Rad/Laufen; `total` = Name des Gesamtzeit-Feldes im selben Formular. */
function splitFields(prefix, total, splits = {}, show = true) {
  return `<div class="splits" data-prefix="${prefix}" data-total="${total}" ${show ? '' : 'hidden'}>
    <div class="grid3">${TRI.map(k => timeField(`${prefix}_${k}`, splits?.[k], { label: `${SPORTS[k].icon} ${k === 'bike' ? 'Rad' : SPORTS[k].label}` })).join('')}
    </div>
    <p class="small muted trans"></p>
  </div>`;
}

/** Erwartete Zeit für ein Zeitfeld (Prognose der gewählten Distanz bzw. Disziplin). */
function expectedTime(input) {
  const rid = input.closest('[data-race]')?.dataset.race;
  const r = rid ? state.races.find(x => x.id === rid) : { sport: input.form?.elements.sport?.value, distance: input.form?.elements.distance?.value };
  if (!r || !RACES[r.sport]?.distances[r.distance]) return null;
  const pred = predict(state, r);
  const k = TRI.find(x => input.name.endsWith(`_${x}`));
  return k ? pred.splits?.[k] : pred.total;
}
/**
 * Wettkampfzeit lesen. "1:45" ist mehrdeutig (1 h 45 oder 1 min 45 s) –
 * es gilt die Deutung, die näher an der Prognose liegt.
 */
function readTime(input) {
  const t = parseTime(input?.value);
  const expected = input && expectedTime(input);
  if (t == null || input.value.trim().split(':').length !== 2 || !expected) return t;
  const alt = t * 60;
  return Math.abs(Math.log(alt / expected)) < Math.abs(Math.log(t / expected)) ? alt : t;
}
function readSplits(form, prefix) {
  const sp = Object.fromEntries(TRI.map(k => [k, readTime(form.elements[`${prefix}_${k}`])]));
  return TRI.some(k => sp[k]) ? sp : null;
}
const splitSum = sp => TRI.reduce((a, k) => a + (sp[k] || 0), 0);
/** Fehlermeldung, falls die Disziplinen zusammen länger als die Gesamtzeit sind. */
const splitError = (total, sp) => (total && sp && splitSum(sp) > total ? 'Schwimmen + Rad + Laufen ist länger als die Gesamtzeit' : null);
const splitsText = sp => (sp ? TRI.filter(k => sp[k]).map(k => `${SPORTS[k].icon} ${fmtTime(sp[k])}`).join(' · ') : '');

function updateTransitions(root) {
  root.querySelectorAll('.splits').forEach(el => {
    const form = el.closest('form'), out = el.querySelector('.trans');
    const tt = readTime(form.elements[el.dataset.total]);
    const sp = TRI.map(k => readTime(form.elements[`${el.dataset.prefix}_${k}`]));
    if (sp.every(x => x == null)) { out.innerHTML = 'Optional – die Gesamtzeit enthält zusätzlich die Wechsel (T1 + T2).'; return; }
    if (!tt || sp.some(x => x == null)) { out.innerHTML = 'Wechselzeit wird berechnet, sobald alle Zeiten eingetragen sind.'; return; }
    const tr = tt - sp.reduce((a, b) => a + b, 0);
    out.innerHTML = tr < 0 ? '<span class="warn-text">⚠️ Schwimmen + Rad + Laufen ist länger als die Gesamtzeit.</span>' : `Wechselzeit (T1 + T2): <b>${fmtTime(tr)}</b>`;
  });
}

// ---------- Router ----------

function render() {
  const route = location.hash.replace(/^#\/?/, '') || (state.onboarded ? 'woche' : 'start');
  const [page, arg] = route.split('/');
  if (!state.onboarded && page !== 'setup') {
    app.innerHTML = viewWelcome();
    document.body.classList.remove('has-nav');
    return;
  }
  const views = { woche: viewWeek, kalender: viewCalendar, ziele: viewGoals, stand: viewProgress, profil: viewProfile, setup: viewSetup };
  const view = views[page] || viewWeek;
  const body = view(arg);
  const nav = state.onboarded && page !== 'setup';
  app.innerHTML = body + (nav ? navBar(page in views ? page : 'woche') : '');
  document.body.classList.toggle('has-nav', nav);
  updateTransitions(app);
}

function navBar(active) {
  const items = [['woche', '📅', 'Woche'], ['kalender', '🗓️', 'Kalender'], ['ziele', '🏁', 'Ziele'], ['stand', '📈', 'Stand'], ['profil', '👤', 'Profil']];
  return `
    <button class="fab" data-action="log" aria-label="Einheit eintragen">＋</button>
    <nav class="nav">${items.map(([k, i, l]) => `<a href="#/${k}" class="${k === active ? 'active' : ''}"><span>${i}</span>${l}</a>`).join('')}</nav>`;
}

// ---------- Start & Einrichtung ----------

function viewWelcome() {
  return `
  <section class="welcome">
    <div class="logo">🏊🚴🏃</div>
    <h1>Freies Training</h1>
    <p class="lead">Kein starrer Plan. Du trainierst, wann es passt – die App sagt dir, was als Nächstes am meisten bringt.</p>
    <a class="btn primary big" href="#/setup/1">Profil anlegen</a>
    <button class="btn ghost" data-action="demo">Mit Demo-Daten ausprobieren</button>
  </section>`;
}

const STEPS = ['Über dich', 'Trainingsstand', 'Ziele', 'Bisherige Wettkämpfe', 'Zielzeiten'];
function stepHeader(n) {
  return `
  <header class="setup-head">
    <div class="steps">${STEPS.map((s, i) => `<span class="${i + 1 <= n ? 'on' : ''}"></span>`).join('')}</div>
    <p class="muted">Schritt ${n} von ${STEPS.length}</p>
    <h1>${STEPS[n - 1]}</h1>
  </header>`;
}
const backBtn = n => (n > 1 ? `<a class="btn ghost" href="#/setup/${n - 1}">Zurück</a>` : '<span></span>');

function viewSetup(arg) {
  const n = Number(arg) || 1;
  const p = state.profile || {};
  let body = '';
  if (n === 1) {
    body = `<form data-form="profile1" data-next="2" class="card">${profileFieldsA(p)}
      <div class="row-between">${backBtn(n)}<button class="btn primary">Weiter</button></div></form>`;
  } else if (n === 2) {
    body = `<form data-form="profile2" data-next="3" class="card">${profileFieldsB(p)}
      <div class="row-between">${backBtn(n)}<button class="btn primary">Weiter</button></div></form>`;
  } else if (n === 3) {
    body = `
      <p class="muted">Lege dein Hauptziel und mögliche Zwischenziele an. Alles lässt sich später ändern.</p>
      ${racesList(true)}
      <button class="btn block" data-action="race">＋ Wettkampf hinzufügen</button>
      <div class="row-between">${backBtn(n)}${state.races.length ? `<a class="btn primary" href="#/setup/4">Weiter</a>` : `<button class="btn primary" disabled>Weiter</button>`}</div>`;
  } else if (n === 4) {
    body = `
      <p class="muted">Hast du schon Wettkämpfe in diesen oder ähnlichen Disziplinen bestritten? Die Zeiten helfen, deinen Stand einzuschätzen.</p>
      ${resultsList()}
      <button class="btn block" data-action="result">＋ Ergebnis hinzufügen</button>
      <div class="row-between">${backBtn(n)}<a class="btn primary" href="#/setup/5">${state.results.length ? 'Weiter' : 'Noch keine – weiter'}</a></div>`;
  } else {
    body = `
      <p class="muted">Welche Zeit möchtest du jeweils erreichen? Die Prognose zeigt, wo du aktuell stehst.</p>
      <form data-form="targets">
        ${sortedRaces(state).map(r => {
          const g = assessGoal(state, r);
          return `<div class="card" data-race="${r.id}">
            <div class="row-between"><strong>${sportIcon(r.sport)} ${esc(raceTitle(r))}</strong>${badge(PRIORITIES[r.priority].label)}</div>
            <p class="muted small">${longDate(r.date)} · ${esc(raceDef(r).label)}</p>
            <p class="small">Prognose heute: <strong>${fmtTime(g.pred.total)}</strong> · bis zum Wettkampf möglich: ≈ <strong>${fmtTime(g.potential)}</strong></p>
            ${g.pred.splits ? `<p class="small muted">Prognose je Disziplin: ${splitsText(g.pred.splits)} · Wechsel ${fmtTime(g.pred.splits.trans)}</p>` : ''}
            ${timeField(`t_${r.id}`, r.target, { label: r.sport === 'tri' ? 'Gesamtzeit' : 'Zielzeit', live: 'target' })}
            <div class="live" id="live_${r.id}">${goalRatingHtml(g)}</div>
            ${r.sport === 'tri' ? splitFields(`t_${r.id}`, `t_${r.id}`, r.targetSplits) : ''}
          </div>`;
        }).join('')}
        <div class="row-between">${backBtn(n)}<button class="btn primary">Fertig – los geht's!</button></div>
      </form>`;
  }
  return `<main class="page">${stepHeader(n)}${body}</main>`;
}

function profileFieldsA(p) {
  return `
    <label>Name<input name="name" value="${esc(p.name)}" required></label>
    <div class="grid2">
      <label>Geschlecht<select name="sex">${[['w', 'weiblich'], ['m', 'männlich'], ['d', 'divers']].map(([v, l]) => `<option value="${v}" ${p.sex === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Geburtsjahr<input name="birthYear" type="number" min="1930" max="2020" value="${esc(p.birthYear)}" required></label>
      <label>Größe (cm)<input name="heightCm" type="number" min="120" max="230" value="${esc(p.heightCm)}"></label>
      <label>Gewicht (kg)${decimalInput('weightKg', p.weightKg)}</label>
      <label>Ruhepuls <span class="opt">optional</span><input name="restHr" type="number" min="30" max="110" value="${esc(p.restHr)}"></label>
      <label>Max. Puls <span class="opt">optional</span><input name="maxHr" type="number" min="120" max="230" value="${esc(p.maxHr)}"></label>
    </div>
    <p class="hint">Ohne Max-Puls wird er geschätzt (208 − 0,7 × Alter). Mit Ruhepuls werden die Zonen genauer.</p>`;
}

function profileFieldsB(p) {
  const sp = p.sports || { run: true, bike: true, swim: true, strength: true };
  return `
    <fieldset><legend>Trainingserfahrung</legend>
      ${Object.entries(LEVELS).map(([k, l]) => `<label class="choice"><input type="radio" name="level" value="${k}" ${(p.level || 'fortgeschritten') === k ? 'checked' : ''}><span><strong>${l.label}</strong><small>${l.hint}</small></span></label>`).join('')}
    </fieldset>
    <fieldset><legend>Realistische Trainingszeit pro Woche</legend>
      <div class="grid2">
        <label>von (Std.)${decimalInput('hoursMin', p.hoursMin ?? 4, 'required')}</label>
        <label>bis (Std.)${decimalInput('hoursMax', p.hoursMax ?? 6, 'required')}</label>
      </div>
      <p class="hint">Kein Plan – nur ein Richtwert, damit die Empfehlungen zu deinem Alltag passen.</p>
    </fieldset>
    <fieldset><legend>Was trainierst du?</legend>
      <div class="chips">${Object.entries(SPORTS).map(([k, s]) => `<label class="chip"><input type="checkbox" name="sp_${k}" ${sp[k] ? 'checked' : ''}><span>${s.icon} ${s.label}</span></label>`).join('')}</div>
    </fieldset>
    <fieldset><legend>Dein lockeres Wohlfühltempo <span class="opt">optional</span></legend>
      <div class="grid3">
        ${timeField('runEasyPace', p.runEasyPace, { hours: false, label: '🏃 Laufen – Zeit pro km' })}
        <label>🚴 Rad – km/h${decimalInput('bikeEasySpeed', p.bikeEasySpeed, 'placeholder="26"')}</label>
        ${timeField('swimEasyPace', p.swimEasyPace, { hours: false, label: '🏊 Schwimmen – Zeit pro 100 m' })}
      </div>
      <p class="hint">Das Tempo, bei dem du dich noch gut unterhalten kannst.</p>
    </fieldset>`;
}

function readProfile(fd, base = {}) {
  const p = { ...base };
  const num = k => readNum(fd.get(k));
  if (fd.has('name')) Object.assign(p, {
    name: fd.get('name').trim(), sex: fd.get('sex'), birthYear: num('birthYear'), heightCm: num('heightCm'),
    weightKg: num('weightKg'), restHr: num('restHr'), maxHr: num('maxHr'),
  });
  if (fd.has('hoursMin')) {
    const lo = num('hoursMin') ?? 4, hi = num('hoursMax') ?? lo + 2;
    Object.assign(p, {
      level: fd.get('level') || 'fortgeschritten', hoursMin: Math.min(lo, hi), hoursMax: Math.max(lo, hi),
      sports: Object.fromEntries(Object.keys(SPORTS).map(k => [k, fd.get(`sp_${k}`) === 'on'])),
      runEasyPace: parseTime(fd.get('runEasyPace')), bikeEasySpeed: num('bikeEasySpeed'), swimEasyPace: parseTime(fd.get('swimEasyPace')),
    });
  }
  return p;
}

function goalRatingHtml(g) {
  if (!g?.rating) return '';
  return `${badge(g.rating, g.tone)} <span class="small muted">${g.rating === 'Sehr ambitioniert' ? 'Mehr als bis zum Wettkampf realistisch aufholbar.' : g.rating === 'Ambitioniert' ? 'Machbar mit konsequentem Training.' : 'Passt zu deinem Stand.'}</span>`;
}

// ---------- Woche ----------

function viewWeek() {
  const t = today();
  const plan = weekPlan(state, t);
  const next = sortedRaces(state).find(r => r.date >= t);
  const { ctx } = plan;
  let html = `<main class="page"><header class="top"><div><p class="muted small">${longDate(t)}</p><h1>Hallo ${esc(state.profile.name)} 👋</h1></div></header>`;

  if (next) {
    const dd = diffDays(t, next.date);
    html += `<a class="card race-banner" href="#/ziele">
      <div><p class="muted small">Nächstes Ziel · ${PRIORITIES[next.priority].label}</p>
      <strong>${sportIcon(next.sport)} ${esc(raceTitle(next))}</strong></div>
      <div class="count">${dd === 0 ? '<b>Heute!</b>' : `<b>${dd}</b><small>${dd === 1 ? 'Tag' : 'Tage'}</small>`}</div></a>`;
  }
  const chips = [];
  if (plan.focus) chips.push(badge(`Phase: ${plan.focus.phase}`));
  if (ctx.mode === 'taper') chips.push(badge('Tapering', 'warn'));
  if (ctx.mode === 'recovery') chips.push(badge('Regeneration', 'info'));
  chips.push(badge(plan.status.label, plan.status.tone));
  html += `<div class="chips-row">${chips.join('')}</div>`;
  html += plan.notes.map(n => `<div class="note ${n.tone}">${esc(n.text)}</div>`).join('');

  html += weekStrip(plan);

  if (ctx.mode === 'pause') {
    html += `<div class="card center"><div class="big-emoji">${ctx.pause.reason === 'krank' ? '🤒' : ctx.pause.reason === 'verletzt' ? '🩹' : '🏖️'}</div>
      <h2>${PAUSE_REASONS[ctx.pause.reason]} – Pause bis ${shortDate(ctx.pause.to)}</h2>
      <p class="muted">Keine Empfehlungen in dieser Zeit. Danach steigst du behutsam wieder ein.</p>
      <button class="btn" data-action="end-pause" data-id="${ctx.pause.id}">Pause heute beenden</button></div>`;
  } else if (ctx.mode === 'taper') {
    html += taperBlock(ctx.race, plan.taper, t);
  } else {
    if (plan.today) {
      html += `<section class="card today"><p class="label">Heute</p><p>${esc(plan.today.text)}</p>${plan.today.rec ? recCard(plan.today.rec, true) : ''}</section>`;
    }
    const doneMin = plan.done.reduce((a, s) => a + (s.durationMin || 0), 0);
    const pct = plan.targetMin ? Math.min(100, Math.round((doneMin / plan.targetMin) * 100)) : 0;
    html += `<section class="card">
      <div class="row-between"><h2>Diese Woche</h2><span class="muted small">${fmtDur(doneMin)} von ≈ ${fmtDur(plan.targetMin)}</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <p class="hint">Keine festen Tage – such dir aus, was gerade passt. Sterne = wie wichtig die Einheit für dein Ziel ist.</p>
      <div class="recs">${plan.recs.map(r => recCard(r)).join('') || '<p class="muted">Diese Woche keine Empfehlungen.</p>'}</div>
      ${plan.extras.length ? `<h3>Zusätzlich trainiert</h3>${plan.extras.map(sessionRow).join('')}` : ''}
    </section>`;
  }
  return html + '</main>';
}

function weekStrip(plan) {
  const t = today();
  let cells = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(plan.ws, i);
    const ss = state.sessions.filter(s => s.date === d);
    const c = dayContext(state, d);
    const race = state.races.find(r => r.date === d);
    cells += `<button class="day ${d === t ? 'today' : ''} ${c.mode}" data-action="day" data-date="${d}">
      <small>${WD[i]}</small><b>${pd(d).getDate()}</b>
      <span class="icons">${race ? '🏁' : ss.map(s => SPORTS[s.sport].icon).join('') || (d < t ? '·' : '')}</span></button>`;
  }
  return `<div class="week-strip">${cells}</div>`;
}

function recCard(r, compact = false) {
  const done = r.doneBy;
  return `<div class="rec ${done ? 'done' : ''} ${compact ? 'compact' : ''}">
    <div class="rec-icon">${SPORTS[r.sport].icon}</div>
    <div class="rec-main">
      <div class="row-between"><strong>${esc(r.title)}</strong>${compact ? '' : `<span class="stars" title="Wichtigkeit">${stars(r.prio)}</span>`}</div>
      <p class="small"><b>${fmtDur(r.durationMin)}</b> · ${esc(r.detail)}</p>
      ${r.wait && !done ? `<p class="small warn-text">⏳ ${esc(r.wait)} (nach harter Einheit)</p>` : ''}
      ${done ? `<p class="small ok-text">✓ erledigt ${fmtDate(done.date, { weekday: 'long' })}</p>`
        : `<button class="btn small" data-action="log" data-sport="${r.sport}" data-type="${r.type}" data-dur="${r.durationMin}">✓ Erledigt eintragen</button>`}
    </div></div>`;
}

function taperBlock(race, days, t) {
  return `<section class="card taper">
    <div class="row-between"><h2>🔒 Tapering</h2>${badge('fester Plan', 'warn')}</div>
    <p class="small muted">Für „${esc(raceTitle(race))}“ am ${longDate(race.date)}. Umfang runter, Spritzigkeit halten – hier wird nicht mehr gerüttelt.</p>
    <ol class="taper-days">${days.map(d => `
      <li class="${d.date === t ? 'today' : ''} ${d.date < t ? 'past' : ''}">
        <div class="tday"><small>${fmtDate(d.date, { weekday: 'short' })}</small><b>${pd(d.date).getDate()}.</b></div>
        <div class="titems">${d.items.length ? d.items.map(it => `
          <div class="titem ${it.done ? 'done' : ''}">
            <strong>${it.done ? '✓ ' : ''}${sportIcon(it.sport)} ${esc(it.title)}${it.durationMin ? ` · ${fmtDur(it.durationMin)}` : ''}</strong>
            <p class="small">${esc(it.detail)}</p>
            ${!it.done && d.date <= t ? (d.race
              ? `<button class="btn small primary" data-action="race" data-id="${race.id}">🏁 Ergebnis eintragen</button>`
              : `<button class="btn small" data-action="log" data-date="${d.date}" data-sport="${it.sport}" data-type="${it.type}" data-dur="${it.durationMin}">✓ Erledigt</button>`) : ''}
          </div>`).join('') : '<p class="muted">Ruhetag 😴</p>'}</div>
      </li>`).join('')}</ol></section>`;
}

function sessionRow(s) {
  return `<button class="session-row" data-action="log" data-id="${s.id}">
    <span class="rec-icon">${SPORTS[s.sport].icon}</span>
    <span><strong>${esc(typeLabel(s))}</strong><small>${fmtDate(s.date)} · ${esc(sessionSummary(s))}</small></span></button>`;
}

// ---------- Kalender ----------

function viewCalendar() {
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = weekStart(iso(first));
  const t = today();
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const inMonth = pd(d).getMonth() === m - 1;
    if (i >= 35 && !inMonth) break;
    const ss = state.sessions.filter(s => s.date === d);
    const race = state.races.find(r => r.date === d);
    const c = dayContext(state, d);
    cells += `<button class="cday ${inMonth ? '' : 'out'} ${d === t ? 'today' : ''} ${c.mode} ${race ? 'race' : ''}" data-action="day" data-date="${d}">
      <b>${pd(d).getDate()}</b><span>${race ? '🏁' : ''}${ss.map(s => SPORTS[s.sport].icon).join('')}</span></button>`;
  }
  return `<main class="page">
    <header class="top row-between">
      <button class="btn ghost" data-action="cal" data-dir="-1">‹</button>
      <h1>${first.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}</h1>
      <button class="btn ghost" data-action="cal" data-dir="1">›</button>
    </header>
    <div class="cal">${WD.map(w => `<div class="wd">${w}</div>`).join('')}${cells}</div>
    <div class="legend"><span class="lg taper"></span>Tapering <span class="lg recovery"></span>Regeneration <span class="lg pause"></span>Pause <span>🏁 Wettkampf</span></div>
    ${calMonth !== t.slice(0, 7) ? `<button class="btn ghost block" data-action="cal" data-dir="0">Zu heute</button>` : ''}
  </main>`;
}

function dayModal(date) {
  const ss = state.sessions.filter(s => s.date === date);
  const races = state.races.filter(r => r.date === date);
  const c = dayContext(state, date);
  let ctxText = '';
  if (c.mode === 'pause') ctxText = `${PAUSE_REASONS[c.pause.reason]} (Pause)`;
  if (c.mode === 'recovery') ctxText = `Regeneration nach „${raceTitle(c.race)}“ – nur locker.`;
  if (c.mode === 'reentry') ctxText = 'Wiedereinstieg nach Pause – behutsam.';
  let taperItems = '';
  if (c.mode === 'taper') {
    const day = taperPlan(state, c.race).find(d => d.date === date);
    taperItems = `<div class="note warn"><strong>🔒 Tapering-Vorgabe:</strong> ${day.items.length ? day.items.map(it => `${sportIcon(it.sport)} ${esc(it.title)}${it.durationMin ? ` (${fmtDur(it.durationMin)})` : ''}`).join(', ') : 'Ruhetag'}</div>`;
  }
  openModal(`
    <h2>${longDate(date)}</h2>
    ${ctxText ? `<div class="note info">${esc(ctxText)}</div>` : ''}${taperItems}
    ${races.map(r => `<button class="session-row" data-action="race" data-id="${r.id}"><span class="rec-icon">🏁</span><span><strong>${esc(raceTitle(r))}</strong><small>${esc(raceDef(r).label)} · ${PRIORITIES[r.priority].label}</small></span></button>`).join('')}
    ${ss.length ? ss.map(sessionRow).join('') : '<p class="muted">Keine Einheit eingetragen.</p>'}
    <div class="row-between">
      <button class="btn ghost" data-action="pause" data-date="${date}">Pause eintragen</button>
      ${date <= today() ? `<button class="btn primary" data-action="log" data-date="${date}">＋ Einheit</button>` : '<span class="small muted">Einheiten erst im Nachhinein eintragen</span>'}
    </div>`);
}

// ---------- Ziele ----------

function racesList(setup = false) {
  const rs = sortedRaces(state);
  if (!rs.length) return '<p class="muted center">Noch keine Ziele angelegt.</p>';
  const t = today();
  return rs.map(r => {
    const past = r.date < t;
    const g = assessGoal(state, r);
    return `<button class="card race-card ${past ? 'past' : ''}" data-action="race" data-id="${r.id}">
      <div class="row-between"><strong>${sportIcon(r.sport)} ${esc(raceTitle(r))}</strong>${badge(PRIORITIES[r.priority].label, r.priority === 'A' ? 'primary' : '')}</div>
      <p class="small muted">${longDate(r.date)} · ${esc(raceDef(r).label)}${past ? '' : r.date === t ? ' · <b>heute</b>' : ` · in ${diffDays(t, r.date)} Tagen`}</p>
      ${setup ? '' : past
        ? `<p class="small">${r.resultTime ? `Erreicht: <strong>${fmtTime(r.resultTime)}</strong>${r.target ? ` (Ziel ${fmtTime(r.target)})` : ''}` : 'Ergebnis eintragen ›'}</p>
           ${r.resultSplits ? `<p class="small muted">${splitsText(r.resultSplits)}</p>` : ''}`
        : `<p class="small">Ziel: <strong>${r.target ? fmtTime(r.target) : '–'}</strong> · Prognose heute: <strong>${fmtTime(g.pred.total)}</strong></p>
           ${r.targetSplits ? `<p class="small muted">Ziel je Disziplin: ${splitsText(r.targetSplits)}</p>` : ''}
           <p class="small">${goalRatingHtml(g)}</p>
           <p class="small muted">Tapering ab ${shortDate(addDays(r.date, -taperDays(r)))} (${taperDays(r)} Tage) · danach ${recoveryDays(r)} Tage Regeneration</p>`}
    </button>`;
  }).join('');
}

function resultsList() {
  // Ergebnisse absolvierter Ziele werden direkt am Ziel gepflegt (id "r-…")
  const list = state.results.filter(r => !String(r.id).startsWith('r-'));
  if (!list.length) return '';
  return list.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(r => `
    <button class="session-row" data-action="result" data-id="${r.id}">
      <span class="rec-icon">${sportIcon(r.sport)}</span>
      <span><strong>${esc(RACES[r.sport].distances[r.distance].label)} – ${fmtTime(r.time)}</strong><small>${[splitsText(r.splits), r.date ? fmtDate(r.date, { month: 'long', year: 'numeric' }) : ''].filter(Boolean).join(' · ')}</small></span>
    </button>`).join('');
}

function viewGoals() {
  return `<main class="page">
    <header class="top"><h1>Ziele</h1></header>
    ${racesList()}
    <button class="btn block" data-action="race">＋ Wettkampf hinzufügen</button>
    <h2 class="section">Bisherige Wettkämpfe</h2>
    <p class="hint">Grundlage für die Einschätzung deines Leistungsstands.</p>
    ${resultsList() || '<p class="muted">Noch keine Ergebnisse.</p>'}
    <button class="btn ghost block" data-action="result">＋ Ergebnis hinzufügen</button>
  </main>`;
}

function distanceOptions(sport, sel) {
  return Object.entries(RACES[sport].distances).map(([k, d]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${d.label}</option>`).join('');
}

function raceModal(id, setup = !state.onboarded) {
  const r = state.races.find(x => x.id === id) || { sport: 'run', distance: 'hm', priority: state.races.some(x => x.priority === 'A') ? 'B' : 'A', date: addDays(today(), 84) };
  const past = r.id && r.date <= today();
  openModal(`
    <h2>${r.id ? 'Wettkampf bearbeiten' : 'Neuer Wettkampf'}</h2>
    <form data-form="race">
      <input type="hidden" name="id" value="${esc(r.id)}">
      <label>Name <span class="opt">optional</span><input name="name" value="${esc(r.name)}" placeholder="z. B. Stadtlauf"></label>
      <label>Datum<input type="date" name="date" value="${r.date}" ${r.id ? '' : `min="${today()}"`} required></label>
      ${r.id ? '' : '<p class="hint">Vergangene Wettkämpfe bitte unter „Bisherige Wettkämpfe“ eintragen.</p>'}
      <label>Sportart<select name="sport" data-rerender="distance">${Object.entries(RACES).map(([k, s]) => `<option value="${k}" ${k === r.sport ? 'selected' : ''}>${s.icon} ${s.label}</option>`).join('')}</select></label>
      <label>Distanz<select name="distance" id="distance">${distanceOptions(r.sport, r.distance)}</select></label>
      <fieldset><legend>Priorität</legend>${Object.entries(PRIORITIES).map(([k, p]) => `
        <label class="choice"><input type="radio" name="priority" value="${k}" ${r.priority === k ? 'checked' : ''}><span><strong>${p.label}</strong><small>${p.hint}</small></span></label>`).join('')}</fieldset>
      ${setup ? '' : `<fieldset><legend>Ziel <span class="opt">optional</span></legend>
        ${timeField('target', r.target, { label: 'Gesamtzeit' })}
        ${splitFields('target', 'target', r.targetSplits, r.sport === 'tri')}</fieldset>`}
      ${past ? `<fieldset><legend>Ergebnis</legend>
        ${timeField('resultTime', r.resultTime, { label: 'Gesamtzeit' })}
        ${splitFields('result', 'resultTime', r.resultSplits, r.sport === 'tri')}</fieldset>` : ''}
      <div class="row-between">
        ${r.id ? `<button type="button" class="btn danger" data-action="delete" data-list="races" data-id="${r.id}">Löschen</button>` : '<span></span>'}
        <button class="btn primary">Speichern</button>
      </div>
    </form>`);
}

function resultModal(id) {
  const r = state.results.find(x => x.id === id) || { sport: 'run', distance: '10k' };
  openModal(`
    <h2>${r.id ? 'Ergebnis bearbeiten' : 'Bisheriges Ergebnis'}</h2>
    <form data-form="result">
      <input type="hidden" name="id" value="${esc(r.id)}">
      <label>Sportart<select name="sport" data-rerender="distance">${Object.entries(RACES).map(([k, s]) => `<option value="${k}" ${k === r.sport ? 'selected' : ''}>${s.icon} ${s.label}</option>`).join('')}</select></label>
      <label>Distanz<select name="distance" id="distance">${distanceOptions(r.sport, r.distance)}</select></label>
      ${timeField('time', r.time, { label: 'Gesamtzeit' })}
      ${splitFields('res', 'time', r.splits, r.sport === 'tri')}
      <label>Wann? <span class="opt">ungefähr reicht</span><input type="date" name="date" value="${esc(r.date)}" max="${today()}"></label>
      <div class="row-between">
        ${r.id ? `<button type="button" class="btn danger" data-action="delete" data-list="results" data-id="${r.id}">Löschen</button>` : '<span></span>'}
        <button class="btn primary">Speichern</button>
      </div>
    </form>`);
}

// ---------- Einheit eintragen ----------

function typeOptions(sport, sel) {
  return Object.entries(TYPES[sport]).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');
}

function logModal(ds) {
  const s = state.sessions.find(x => x.id === ds.id) || {
    date: ds.date || today(), sport: ds.sport || 'run', type: ds.type || 'easy', durationMin: ds.dur ? Number(ds.dur) : '',
  };
  const rpe = s.rpe || DEFAULT_RPE[s.type] || 5;
  const act = activeSports(state);
  const enabled = Object.keys(SPORTS).filter(k => act.includes(k) || state.profile?.sports?.[k] || k === s.sport);
  openModal(`
    <h2>${s.id ? 'Einheit bearbeiten' : 'Einheit eintragen'}</h2>
    <form data-form="session">
      <input type="hidden" name="id" value="${esc(s.id)}">
      <div class="seg">${enabled.map(k => `<label><input type="radio" name="sport" value="${k}" ${k === s.sport ? 'checked' : ''} data-rerender="type"><span>${SPORTS[k].icon}<small>${SPORTS[k].label}</small></span></label>`).join('')}</div>
      <div class="grid2">
        <label>Datum<input type="date" name="date" value="${s.date}" max="${today()}" required></label>
        <label>Art<select name="type" id="type">${typeOptions(s.sport, s.type)}</select></label>
        ${timeField('duration', s.durationMin ? s.durationMin * 60 : null, { label: 'Dauer' })}
        <label id="distLabel" ${s.sport === 'strength' ? 'hidden' : ''}><span>${s.sport === 'swim' ? 'Distanz (m)' : 'Distanz (km)'}</span>${decimalInput('distance', s.distanceKm ? (s.sport === 'swim' ? Math.round(s.distanceKm * 1000) : s.distanceKm) : null)}</label>
        <label>Ø Puls <span class="opt">optional</span><input type="number" name="avgHr" min="60" max="220" value="${esc(s.avgHr)}"></label>
      </div>
      <label>Gefühl: <b id="rpeOut">${rpe} – ${RPE_LABELS[rpe]}</b><input type="range" name="rpe" min="1" max="10" value="${rpe}" data-live="rpe"></label>
      <label>Notiz <span class="opt">optional</span><input name="notes" value="${esc(s.notes)}"></label>
      <div class="row-between">
        ${s.id ? `<button type="button" class="btn danger" data-action="delete" data-list="sessions" data-id="${s.id}">Löschen</button>` : '<span></span>'}
        <button class="btn primary">Speichern</button>
      </div>
    </form>`);
}

// ---------- Pausen ----------

function pauseModal(id, date) {
  const p = state.pauses.find(x => x.id === id) || { from: date || today(), to: addDays(date || today(), 3), reason: 'krank' };
  openModal(`
    <h2>${p.id ? 'Pause bearbeiten' : 'Pause eintragen'}</h2>
    <p class="muted small">Während der Pause gibt es keine Empfehlungen, danach einen sanften Wiedereinstieg.</p>
    <form data-form="pause">
      <input type="hidden" name="id" value="${esc(p.id)}">
      <label>Grund<select name="reason">${Object.entries(PAUSE_REASONS).map(([k, l]) => `<option value="${k}" ${k === p.reason ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <div class="grid2"><label>Von<input type="date" name="from" value="${p.from}" required></label><label>Bis<input type="date" name="to" value="${p.to}" required></label></div>
      <div class="row-between">
        ${p.id ? `<button type="button" class="btn danger" data-action="delete" data-list="pauses" data-id="${p.id}">Löschen</button>` : '<span></span>'}
        <button class="btn primary">Speichern</button>
      </div>
    </form>`);
}

// ---------- Trainingsstand ----------

function viewProgress() {
  const ab = abilities(state), p = state.profile, st = loadStatus(state);
  const t10 = ab.run10 / 10;
  const z = k => hrRange(p, k).join('–');
  const up = sortedRaces(state).filter(r => r.date >= today());
  return `<main class="page">
    <header class="top"><h1>Trainingsstand</h1></header>

    <section class="card"><h2>Prognosen</h2>
      ${up.length ? up.map(r => {
        const g = assessGoal(state, r);
        const sp = g.pred.splits;
        return `<div class="prog">
          <div class="row-between"><strong>${sportIcon(r.sport)} ${esc(raceTitle(r))}</strong>${g.rating ? badge(g.rating, g.tone) : ''}</div>
          <div class="prog-nums">
            <div><small>Heute</small><b>${fmtTime(g.pred.total)}</b></div>
            <div><small>Möglich bis ${shortDate(r.date)}</small><b>≈ ${fmtTime(g.potential)}</b></div>
            <div><small>Dein Ziel</small><b>${r.target ? fmtTime(r.target) : '–'}</b></div>
          </div>
          ${sp ? `<table class="zones splits-table">
            <tr><th></th><th>Prognose</th><th>Ziel</th></tr>
            ${[...TRI, 'trans'].map(k => `<tr><td>${k === 'trans' ? '🔄 Wechsel' : `${SPORTS[k].icon} ${k === 'bike' ? 'Rad' : SPORTS[k].label}`}</td>
              <td>${fmtTime(sp[k])}</td>
              <td>${k === 'trans'
                ? (r.target && r.targetSplits && TRI.every(x => r.targetSplits[x]) ? fmtTime(r.target - splitSum(r.targetSplits)) : '–')
                : (r.targetSplits?.[k] ? fmtTime(r.targetSplits[k]) : '–')}</td></tr>`).join('')}
          </table>` : ''}
        </div>`;
      }).join('') : '<p class="muted">Keine anstehenden Ziele.</p>'}
      <p class="hint">Modell nach festen Regeln (Riegel-Formel, Trainingsbelastung). Je mehr Ergebnisse und Einheiten du einträgst, desto genauer.</p>
    </section>

    ${basisCard(ab)}

    <section class="card"><h2>Belastung</h2>
      <div class="prog-nums">
        <div><small>Fitness</small><b>${Math.round(st.ctl)}</b></div>
        <div><small>Ermüdung</small><b>${Math.round(st.atl)}</b></div>
        <div><small>Form</small><b>${st.form > 0 ? '+' : ''}${Math.round(st.form)}</b></div>
      </div>
      <p>${badge(st.label, st.tone)}</p>
      ${loadChart()}
      <p class="hint">Fitness = Ø Belastung der letzten 6 Wochen, Ermüdung = letzte 7 Tage. Belastung = Dauer × Gefühl.</p>
    </section>

    <section class="card"><h2>Wochenumfang</h2>${volumeChart()}</section>

    <section class="card"><h2>Deine Tempobereiche</h2>
      <table class="zones">
        <tr><th colspan="2">🏃 Laufen <small>(${ab.runSrc})</small></th></tr>
        <tr><td>Zone 2 / locker</td><td>${fmtPace(ab.runEasy * 0.98)} – ${fmtPace(ab.runEasy * 1.06)}</td></tr>
        <tr><td>Schwelle</td><td>${fmtPace(t10 * 1.05)}</td></tr>
        <tr><td>Intervalle</td><td>${fmtPace(t10 * 0.97)}</td></tr>
        <tr><th colspan="2">🚴 Rad <small>(${ab.bikeSrc})</small></th></tr>
        <tr><td>Zone 2 / locker</td><td>${fmtSpeed(ab.bikeEasy * 0.95)} – ${fmtSpeed(ab.bikeEasy * 1.03)}</td></tr>
        <tr><td>Sweetspot</td><td>${fmtSpeed(ab.v40 * 0.92)}</td></tr>
        <tr><th colspan="2">🏊 Schwimmen <small>(${ab.swimSrc})</small></th></tr>
        <tr><td>Locker</td><td>${fmtSwim(ab.swimEasy)}</td></tr>
        <tr><td>Schwelle</td><td>${fmtSwim(ab.css)}</td></tr>
        <tr><th colspan="2">❤️ Puls <small>(max. ${maxHr(p)}${p.restHr ? `, Ruhe ${p.restHr}` : ''})</small></th></tr>
        <tr><td>Zone 2</td><td>${z('z2')}</td></tr><tr><td>Zone 3</td><td>${z('z3')}</td></tr>
        <tr><td>Zone 4</td><td>${z('z4')}</td></tr><tr><td>Zone 5</td><td>${z('z5')}</td></tr>
      </table>
    </section>
  </main>`;
}

const pct = (x, d = 1) => `${x > 0 ? '+' : ''}${fmtNum(x * 100, d)} %`;
const ageText = m => (m < 1.5 ? 'diesen Monat' : m < 18 ? `vor ${Math.round(m)} Monaten` : `vor ${fmtNum(m / 12)} Jahren`);

/** Woraus sich der Leistungsstand je Disziplin zusammensetzt. */
function basisCard(ab) {
  const cons = consistency(state);
  const rows = TRI.filter(s => activeSports(state).includes(s) || ab.detail[s].result).map(s => {
    const d = ab.detail[s], r = d.result, tr = d.train;
    const lines = [];
    if (r) {
      const pen = Math.min(Math.max((r.months - 12) * 0.4, 0), 8);
      lines.push(`🏁 ${esc(r.label)}${r.dated ? `, ${ageText(r.months)}` : ''}${pen >= 0.5 ? ` · zählt ${fmtNum(pen)} % schwächer (Alter)` : ''}${r.estimated ? ' · Aufteilung geschätzt' : ''}`);
    }
    lines.push(tr.value
      ? `📊 ${tr.n} gleichmäßige Einheiten (6 Wochen)${tr.trend != null ? ` · Trend ${tr.trend > 0.005 ? '↗' : tr.trend < -0.005 ? '↘' : '→'} ${pct(tr.trend)}` : ''}`
      : `📊 Trainingstempo: ${tr.n}/3 gleichmäßige Einheiten mit Distanz – noch zu wenig`);
    lines.push(`💪 Fitness-Effekt ${pct(d.fitFactor)}${tr.value ? ' (halb gewichtet, da Tempo schon einfließt)' : ''}`);
    return `<div class="basis"><div class="row-between"><strong>${SPORTS[s].icon} ${SPORTS[s].label}</strong>${badge(d.src, d.src === 'Schätzung' ? 'warn' : d.src.includes('Training') ? 'good' : '')}</div>
      ${lines.map(l => `<p class="small">${l}</p>`).join('')}</div>`;
  }).join('');
  return `<section class="card"><h2>Datengrundlage</h2>${rows}
    <div class="basis"><div class="row-between"><strong>📅 Beständigkeit</strong>${cons ? badge(`${Math.round(cons.value * 100)} %`, cons.value >= 0.85 ? 'good' : cons.value >= 0.6 ? 'warn' : 'bad') : badge('ab 2 Wochen')}</div>
      <p class="small">${cons ? `Umfang ${Math.round(cons.volRatio * 100)} % deines Richtwerts · ${Math.round(cons.regular * 100)} % der Wochen mit mind. 2 Einheiten (letzte 4 Wochen, ohne Pausen)` : 'Wird berechnet, sobald 2 Wochen Daten vorliegen.'}</p>
      <p class="hint">Beeinflusst, wie viel bis zum Wettkampf „möglich“ ist.</p></div>
    <p class="hint">Trainingstempo: lockere/lange Einheiten mit Distanz, bewertet nach Gefühl und Puls. Bei Intervallen sagt das Ø-Tempo zu wenig aus.</p>
  </section>`;
}

function loadChart() {
  const s = fitnessSeries(state, today(), 90);
  if (s.length < 2) return '';
  const W = 320, H = 110, max = Math.max(...s.map(x => Math.max(x.ctl, x.atl)), 10) * 1.1;
  const pts = k => s.map((x, i) => `${((i / (s.length - 1)) * W).toFixed(1)},${(H - (x[k] / max) * H).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Verlauf Fitness und Ermüdung">
      <polyline points="${pts('atl')}" class="l-atl"/><polyline points="${pts('ctl')}" class="l-ctl"/></svg>
    <div class="legend"><span class="lg ctl"></span>Fitness <span class="lg atl"></span>Ermüdung <span class="muted small">· letzte ${s.length} Tage</span></div>`;
}

function volumeChart() {
  const ws0 = weekStart(today());
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(ws0, (i - 7) * 7));
  const data = weeks.map(ws => {
    const we = addDays(ws, 6), by = {};
    for (const s of state.sessions) if (s.date >= ws && s.date <= we) by[s.sport] = (by[s.sport] || 0) + s.durationMin;
    return { ws, by, total: Object.values(by).reduce((a, b) => a + b, 0) };
  });
  const max = Math.max(...data.map(d => d.total), 60);
  return `<div class="vol">${data.map(d => `
    <div class="vcol" title="${fmtDur(d.total)}">
      <div class="vbar">${Object.keys(SPORTS).filter(k => d.by[k]).map(k => `<span class="s-${k}" style="height:${(d.by[k] / max) * 100}%"></span>`).join('')}</div>
      <small>${(d.total / 60).toFixed(1).replace('.', ',')}h</small><small class="muted">${shortDate(d.ws)}</small>
    </div>`).join('')}</div>
    <div class="legend">${Object.entries(SPORTS).map(([k, s]) => `<span class="lg s-${k}"></span>${s.label}`).join(' ')}</div>`;
}

// ---------- Profil ----------

function viewProfile() {
  const p = state.profile;
  const t = today();
  return `<main class="page">
    <header class="top"><h1>Profil</h1></header>
    <form data-form="profile" class="card">${profileFieldsA(p)}${profileFieldsB(p)}<button class="btn primary block">Speichern</button></form>

    <section class="card"><h2>Pausen</h2>
      <p class="hint">Krank, verletzt oder im Urlaub? Trag es ein – die App plant den Wiedereinstieg.</p>
      ${[...state.pauses].sort((a, b) => b.from.localeCompare(a.from)).map(x => `
        <button class="session-row" data-action="pause" data-id="${x.id}"><span class="rec-icon">${x.reason === 'krank' ? '🤒' : x.reason === 'verletzt' ? '🩹' : '🏖️'}</span>
        <span><strong>${PAUSE_REASONS[x.reason]}</strong><small>${shortDate(x.from)} – ${shortDate(x.to)}${x.to < t ? '' : ' · aktuell/geplant'}</small></span></button>`).join('')}
      <button class="btn ghost block" data-action="pause">＋ Pause eintragen</button>
    </section>

    <section class="card"><h2>Daten</h2>
      <p class="hint">Deine Daten liegen nur auf diesem Gerät. Sichere sie ab und zu.</p>
      <div class="btn-col">
        <button class="btn" data-action="export">⬇️ Sicherung herunterladen</button>
        <label class="btn">⬆️ Sicherung einspielen<input type="file" accept="application/json" id="importFile" hidden></label>
        <button class="btn danger" data-action="reset">Alles löschen</button>
      </div>
    </section>
  </main>`;
}

// ---------- Modal ----------

function openModal(html) {
  modalEl.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><button class="close" data-action="close" aria-label="Schließen">✕</button>${html}</div>`;
  modalEl.hidden = false;
  document.body.classList.add('modal-open');
  updateTransitions(modalEl);
}
function closeModal() {
  modalEl.hidden = true;
  modalEl.innerHTML = '';
  document.body.classList.remove('modal-open');
}

// ---------- Events ----------

const actions = {
  log: ds => logModal(ds),
  race: ds => raceModal(ds.id),
  result: ds => resultModal(ds.id),
  pause: ds => pauseModal(ds.id, ds.date),
  day: ds => dayModal(ds.date),
  close: () => closeModal(),
  cal: ds => {
    if (ds.dir === '0') calMonth = today().slice(0, 7);
    else {
      const [y, m] = calMonth.split('-').map(Number);
      calMonth = iso(new Date(y, m - 1 + Number(ds.dir), 1)).slice(0, 7);
    }
    render();
  },
  delete: ds => {
    if (!confirm('Wirklich löschen?')) return;
    remove(ds.list, ds.id);
    if (ds.list === 'races') {
      remove('results', `r-${ds.id}`);
      syncRaceSessions({ id: ds.id });
    }
    closeModal(); render();
  },
  'end-pause': ds => {
    const p = state.pauses.find(x => x.id === ds.id);
    const y = addDays(today(), -1);
    if (p.from > y) remove('pauses', p.id); else upsert('pauses', { ...p, to: y });
    render();
  },
  demo: () => { replaceState(demoState()); location.hash = '#/woche'; render(); },
  export: () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `sport-app-${today()}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  },
  reset: () => {
    if (!confirm('Alle Daten auf diesem Gerät löschen?')) return;
    resetState(); location.hash = '#/start'; render();
  },
};

/** Wettkampfergebnis als Einheit(en) vom Typ „Wettkampf“ führen (Triathlon: je Disziplin). */
function syncRaceSessions(r) {
  state.sessions = state.sessions.filter(s => s.fromRace !== r.id);
  const d = r.resultTime && r.date <= today() && raceDef(r);
  if (d) {
    const parts = r.sport === 'tri'
      ? TRI.map(k => [k, r.resultSplits?.[k] || Math.max(r.resultTime - d.transition, 0) * d.shares[k]])
      : [[r.sport, r.resultTime]];
    for (const [sport, sec] of parts) {
      state.sessions.push({ id: uid(), date: r.date, sport, type: 'race', durationMin: Math.max(1, Math.round(sec / 60)), distanceKm: d[sport], rpe: 9, fromRace: r.id, notes: raceTitle(r) });
    }
  }
  save();
}

const forms = {
  profile1: fd => { state.profile = readProfile(fd, state.profile || {}); save(); },
  profile2: fd => { state.profile = readProfile(fd, state.profile || {}); save(); },
  profile: fd => { state.profile = readProfile(fd, state.profile); save(); toast('Profil gespeichert'); },
  race: (fd, form) => {
    const id = fd.get('id') || uid();
    const old = state.races.find(r => r.id === id) || {};
    const r = {
      ...old, id, name: fd.get('name').trim(), date: fd.get('date'), sport: fd.get('sport'), distance: fd.get('distance'),
      priority: fd.get('priority') || 'B',
    };
    const tri = r.sport === 'tri';
    if (fd.has('target')) {
      r.target = readTime(form.elements.target);
      r.targetSplits = tri ? readSplits(form, 'target') : null;
    }
    if (fd.has('resultTime')) {
      r.resultTime = readTime(form.elements.resultTime);
      r.resultSplits = tri ? readSplits(form, 'result') : null;
    }
    if (r.date > today()) { r.resultTime = null; r.resultSplits = null; }
    const err = splitError(r.target, r.targetSplits) || splitError(r.resultTime, r.resultSplits);
    if (err) return toast(err), false;
    upsert('races', r);
    // Erreichte Zeit fließt in die Leistungseinschätzung ein …
    if (r.resultTime) upsert('results', { id: `r-${id}`, sport: r.sport, distance: r.distance, time: r.resultTime, splits: r.resultSplits, date: r.date });
    else remove('results', `r-${id}`);
    // … und zählt als (harte) Trainingseinheit in die Belastung
    syncRaceSessions(r);
    closeModal();
  },
  result: (fd, form) => {
    const time = readTime(form.elements.time);
    if (!time) return toast('Bitte die Zeit eintragen'), false;
    const splits = fd.get('sport') === 'tri' ? readSplits(form, 'res') : null;
    const err = splitError(time, splits);
    if (err) return toast(err), false;
    upsert('results', { id: fd.get('id') || undefined, sport: fd.get('sport'), distance: fd.get('distance'), time, splits, date: fd.get('date') || null });
    closeModal();
  },
  session: fd => {
    const sport = fd.get('sport'), dist = readNum(fd.get('distance')) || null;
    const dur = parseTime(fd.get('duration'));
    if (!dur) return toast('Bitte die Dauer eintragen'), false;
    const old = state.sessions.find(s => s.id === fd.get('id')) || {};
    upsert('sessions', {
      ...old, id: fd.get('id') || undefined, date: fd.get('date'), sport, type: fd.get('type'),
      durationMin: Math.round((dur / 60) * 100) / 100, distanceKm: dist && sport === 'swim' ? dist / 1000 : sport === 'strength' ? null : dist,
      rpe: Number(fd.get('rpe')), avgHr: Number(fd.get('avgHr')) || null, notes: fd.get('notes').trim(),
    });
    closeModal(); toast('Eingetragen 💪');
  },
  pause: fd => {
    let from = fd.get('from'), to = fd.get('to');
    if (to < from) [from, to] = [to, from];
    upsert('pauses', { id: fd.get('id') || undefined, reason: fd.get('reason'), from, to });
    closeModal();
  },
  targets: (fd, form) => {
    const read = r => ({ target: readTime(form.elements[`t_${r.id}`]), sp: r.sport === 'tri' ? readSplits(form, `t_${r.id}`) : null });
    for (const r of state.races) {
      const { target, sp } = read(r);
      const err = splitError(target, sp);
      if (err) return toast(`${raceTitle(r)}: ${err}`), false;
    }
    for (const r of state.races) {
      const { target, sp } = read(r);
      r.target = target;
      r.targetSplits = sp;
    }
    state.onboarded = true;
    state.createdAt = today();
    save();
    location.hash = '#/woche';
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) { e.preventDefault(); actions[el.dataset.action]?.({ ...el.dataset }); return; }
  if (e.target === modalEl) closeModal();
});

document.addEventListener('submit', e => {
  const form = e.target;
  const handler = forms[form.dataset.form];
  if (!handler) return;
  e.preventDefault();
  if (handler(new FormData(form), form) === false) return;
  if (form.dataset.next) location.hash = `#/setup/${form.dataset.next}`;
  else render();
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.rerender === 'distance') {
    $('#distance').innerHTML = distanceOptions(t.value);
    t.form.querySelectorAll('.splits').forEach(el => (el.hidden = t.value !== 'tri'));
  }
  if (t.dataset.rerender === 'type') {
    $('#type').innerHTML = typeOptions(t.value);
    const lbl = $('#distLabel');
    lbl.hidden = t.value === 'strength';
    lbl.querySelector('span').textContent = t.value === 'swim' ? 'Distanz (m)' : 'Distanz (km)';
  }
  if (t.id === 'importFile' && t.files[0]) {
    t.files[0].text().then(txt => {
      try {
        const data = JSON.parse(txt);
        if (!data.profile || !Array.isArray(data.sessions)) throw new Error();
        replaceState(data); toast('Sicherung eingespielt'); render();
      } catch { toast('Datei konnte nicht gelesen werden'); }
    });
  }
});

document.addEventListener('input', e => {
  let t = e.target;
  if (t.dataset.part) {
    const digits = t.value.replace(/\D/g, '');
    if (digits !== t.value) t.value = digits;
    // nach 2 Ziffern ins nächste Kästchen springen
    if (digits.length >= 2) {
      const parts = [...t.closest('.tparts').querySelectorAll('[data-part]')];
      parts[parts.indexOf(t) + 1]?.focus();
    }
    t = syncTimeField(t);
  }
  if (t.form?.querySelector('.splits')) updateTransitions(t.form);
  if (t.dataset.live === 'rpe') $('#rpeOut').textContent = `${t.value} – ${RPE_LABELS[t.value]}`;
  if (t.dataset.live === 'target') {
    const r = state.races.find(x => x.id === t.closest('[data-race]').dataset.race);
    const g = assessGoal(state, { ...r, target: readTime(t) });
    $(`#live_${r.id}`).innerHTML = goalRatingHtml(g);
  }
});

// Beim Antippen eines Zeitkästchens Inhalt markieren → direkt überschreibbar
document.addEventListener('focusin', e => { if (e.target.dataset?.part) e.target.select(); });

document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modalEl.hidden) closeModal(); });

let toastTimer;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = Object.assign(document.createElement('div'), { id: 'toast' }); document.body.append(el); }
  el.textContent = msg;
  el.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2200);
}

window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo(0, 0); });
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
