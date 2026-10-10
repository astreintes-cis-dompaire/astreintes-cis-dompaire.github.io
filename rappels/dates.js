// Périodes et créneaux d'astreinte.
// Une période = 4 semaines qui démarrent un vendredi.
// Chaque semaine = 2 créneaux : week-end (ven → lun) et semaine (lun → ven suivant).
// Les jours sont fixes, les heures se règlent dans config.heures.

export const JOURS = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
export const MOIS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];

export const HEURES_DEFAUT = { weDebut: '18:00', weFin: '05:00', seDebut: '20:00', seFin: '07:00' };
// Une période fait 4 semaines, ou 5 si le chef l'a choisi (config.semaines[periode] = 5).
export const blocIds = (n = 4) => Array.from({ length: n }, (_, k) => [`${k + 1}WE`, `${k + 1}SE`]).flat();
export const BLOC_IDS = blocIds(4);
export const semainesDe = (config, periodeId) => (config?.semaines?.[periodeId] === 5 ? 5 : 4);
export const numerosSemaines = (n = 4) => Array.from({ length: n }, (_, k) => k + 1);

export function parseYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function avecHeure(d, hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0);
}

export function estVendredi(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '') && parseYmd(s).getDay() === 5;
}

export function fmtJour(d) {
  return `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`;
}

export function fmtJourCourt(d) {
  return `${d.getDate()} ${MOIS[d.getMonth()]}`;
}

export function fmtHeure(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// Les créneaux d'une période (8, ou 10 sur 5 semaines), dans l'ordre chronologique.
export function creneaux(periodeId, heures, n = 4) {
  const h = { ...HEURES_DEFAUT, ...(heures || {}) };
  const f = parseYmd(periodeId);
  const out = [];
  for (let k = 0; k < n; k++) {
    const ven = addDays(f, 7 * k);
    const lun = addDays(f, 7 * k + 3);
    const venSuiv = addDays(f, 7 * k + 7);
    out.push({
      id: `${k + 1}WE`, semaine: k + 1, type: 'WE', label: 'Week-end',
      debut: avecHeure(ven, h.weDebut), fin: avecHeure(lun, h.weFin), hDebut: h.weDebut, hFin: h.weFin,
    });
    out.push({
      id: `${k + 1}SE`, semaine: k + 1, type: 'SE', label: 'Semaine',
      debut: avecHeure(lun, h.seDebut), fin: avecHeure(venSuiv, h.seFin), hDebut: h.seDebut, hFin: h.seFin,
    });
  }
  return out;
}

// « Week-end du 13 nov », « Semaine du 16 nov », « Semaine complète du 13 nov »
export function libelleCreneau(c) {
  return `${c.type === 'WE' ? 'Week-end' : c.type === 'TOUT' ? 'Semaine complète' : 'Semaine'} du ${fmtJourCourt(c.debut)}`;
}

// Horaires affichés aux pompiers et au chef, sans heure précise.
export function plageCreneau(c) {
  return c.type === 'WE' ? 'du vendredi soir au lundi matin' : c.type === 'TOUT' ? 'du vendredi soir au vendredi suivant' : 'du lundi soir au vendredi matin';
}

// Astreintes d'un pompier sur une période, regroupées : week-end + semaine de la même semaine
// forment un seul bloc « semaine complète » (du vendredi au vendredi suivant).
export function astreintesGroupees(periodeId, heures, blocs, n = 5) {
  const cr = creneaux(periodeId, heures, n);
  const l = blocs || [];
  const out = [];
  for (let k = 1; k <= n; k++) {
    const we = cr.find((c) => c.id === `${k}WE`), se = cr.find((c) => c.id === `${k}SE`);
    if (l.includes(we.id) && l.includes(se.id)) {
      out.push({
        id: `${k}TOUT`, ids: [we.id, se.id], semaine: k, type: 'TOUT', label: 'Semaine complète',
        debut: we.debut, fin: se.fin, hDebut: we.hDebut, hFin: se.hFin,
      });
    } else {
      if (l.includes(we.id)) out.push({ ...we, ids: [we.id] });
      if (l.includes(se.id)) out.push({ ...se, ids: [se.id] });
    }
  }
  return out;
}

// Texte de la notification envoyée à la publication du planning (partagé avec les rappels).
export function texteNotifPlanning(periodeId, heures, blocs) {
  const texte = astreintesGroupees(periodeId, heures, blocs, 5)
    .map((c) => (c.type === 'TOUT'
      ? `toute la semaine, du ${fmtJour(c.debut)} soir au ${fmtJour(addDays(c.debut, 7))}`
      : `${c.label.toLowerCase()} du ${fmtJour(c.debut)} (${plageCreneau(c).replace(/^du /, '')})`))
    .join(', puis ');
  return `Tu es d’astreinte : ${texte}.`;
}

export function fmtCreneau(c) {
  return `${fmtJour(c.debut)} ${fmtHeure(c.hDebut)} → ${fmtJour(c.fin)} ${fmtHeure(c.hFin)}`;
}

export function debutPeriode(periodeId) {
  return parseYmd(periodeId);
}

export function finPeriode(periodeId, n = 4) {
  return addDays(parseYmd(periodeId), 7 * n);
}

export function libellePeriode(periodeId, n = 4) {
  return `du ${fmtJour(debutPeriode(periodeId))} au ${fmtJour(finPeriode(periodeId, n))}`;
}

// Période suivante ou précédente, en tenant compte des périodes de 5 semaines.
export function periodeSuivante(config, periodeId) {
  return ymd(addDays(parseYmd(periodeId), 7 * semainesDe(config, periodeId)));
}
export function periodePrecedente(config, periodeId) {
  const longue = ymd(addDays(parseYmd(periodeId), -35));
  return semainesDe(config, longue) === 5 ? longue : ymd(addDays(parseYmd(periodeId), -28));
}

export function periodeDecalee(periodeId, nbPeriodes) {
  return ymd(addDays(parseYmd(periodeId), 28 * nbPeriodes));
}

// Proposition par défaut : premier vendredi du mois suivant.
export function periodeParDefaut(aujourdhui = new Date()) {
  const d = new Date(aujourdhui.getFullYear(), aujourdhui.getMonth() + 1, 1);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return ymd(d);
}

// Date limite par défaut : 12 jours avant le début de la période.
export function dateLimiteParDefaut(periodeId) {
  return ymd(addDays(parseYmd(periodeId), -12));
}

// Planning général d'une période, en version courte pour la notification :
// pour chaque semaine, les noms « toute la semaine » (t), « en semaine » (s) et « week-end » (w).
export function resumePlanning(periodeId, pompiers, n = 4) {
  const sem = numerosSemaines(n).map(() => ({ t: [], s: [], w: [] }));
  const tries = [...pompiers].sort((a, b) => `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr'));
  for (const p of tries) {
    const blocs = p.affectations?.[periodeId] || [];
    const nom = `${p.prenom || ''} ${p.nom || ''}`.trim();
    sem.forEach((g, i) => {
      const we = blocs.includes(`${i + 1}WE`), se = blocs.includes(`${i + 1}SE`);
      if (we && se) g.t.push(nom); else if (se) g.s.push(nom); else if (we) g.w.push(nom);
    });
  }
  return { per: periodeId, sem };
}
