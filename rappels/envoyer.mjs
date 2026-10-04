// Programme de rappel : lancé automatiquement par GitHub toutes les 2 heures (voir .github/workflows/rappels.yml).
// Il lit la base, décide quelles notifications envoyer, les envoie et note ce qu'il a fait dans chef/journal.
//
// Variables d'environnement :
//   FIREBASE_SERVICE_ACCOUNT  contenu du fichier JSON du compte de service (secret GitHub)
//   SITE_URL                  adresse de l'appli, ex. https://pseudo.github.io/astreintes/
//   ESSAI=1                   affiche ce qui serait envoyé, sans rien envoyer

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { creneaux, semainesDe, libellePeriode, texteNotifPlanning, parseYmd, ymd, fmtJour, resumePlanning } from './dates.js';

const ESSAI = process.env.ESSAI === '1';
const SITE = (process.env.SITE_URL || '').trim().replace(/\/?$/, '/');
const RAPPELS_DEFAUT = { saisie: true, joursAvant: [7, 3, 1], heure: 18, publication: true, debut: true };
const HEURE_DEBUT_ASTREINTE = 9; // le rappel « astreinte aujourd'hui » part le matin

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Secret FIREBASE_SERVICE_ACCOUNT manquant : voir l’étape « rappels » du guide.');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const fcm = getMessaging();

function maintenantParis() {
  const morceaux = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { jour: `${morceaux.year}-${morceaux.month}-${morceaux.day}`, heure: Number(morceaux.hour) };
}

function joursEntre(de, a) {
  return Math.round((parseYmd(a) - parseYmd(de)) / 86400000);
}

const lienDe = (id) => (SITE !== '/' ? `${SITE}?p=${encodeURIComponent(id)}` : './');
const nom = (p) => `${p.prenom || ''} ${p.nom || ''}`.trim();

async function principal() {
  const cfg = (await db.doc('config/general').get()).data();
  if (!cfg) { console.log('Pas encore de configuration.'); return; }
  const rap = { ...RAPPELS_DEFAUT, ...(cfg.rappels || {}) };
  const refJournal = db.doc('chef/journal');
  const journal = (await refJournal.get()).data() || {};
  const envois = { ...(journal.envois || {}) };
  const { jour, heure } = maintenantParis();
  const pompiers = (await db.collection('pompiers').get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => p.actif !== false);

  const aEnvoyer = []; // { pompier, title, body, tag }
  const faits = [];

  // 1. Relance des pompiers sans réponse, les jours choisis avant la date limite.
  if (rap.saisie && !cfg.verrouille && cfg.dateLimite && heure >= rap.heure) {
    const j = joursEntre(jour, cfg.dateLimite);
    const cle = `saisie-${cfg.periode}-${jour}`;
    if (rap.joursAvant.includes(j) && !envois[cle]) {
      const limite = fmtJour(parseYmd(cfg.dateLimite));
      for (const p of pompiers) {
        if (p.rythme === 'aucun' || p.dispos?.[cfg.periode]) continue;
        aEnvoyer.push({
          pompier: p,
          title: 'Tes dispos d’astreinte',
          body: j === 0
            ? `Dernier jour pour donner tes dispos (période ${libellePeriode(cfg.periode)}).`
            : `Il te reste ${j} jour${j > 1 ? 's' : ''} pour donner tes dispos, avant le ${limite}.`,
          tag: `saisie-${cfg.periode}`,
        });
      }
      envois[cle] = new Date().toISOString();
      faits.push(`relance J-${j}`);
    }
  }

  // 1 bis. Rappel demandé par le chef avec le bouton « Envoyer un rappel » (en journée).
  const rel = cfg.relance;
  const cleRel = rel?.le?.toMillis ? `rappel-chef-${rel.le.toMillis()}` : '';
  if (cleRel && !envois[cleRel] && rel.periode === cfg.periode && !cfg.verrouille && heure >= 8 && heure <= 21) {
    const limite = cfg.dateLimite ? `, avant le ${fmtJour(parseYmd(cfg.dateLimite))}` : '';
    for (const p of pompiers) {
      if (p.rythme === 'aucun' || p.dispos?.[cfg.periode]) continue;
      aEnvoyer.push({
        pompier: p,
        title: 'Tes dispos d’astreinte',
        body: `Le chef attend encore tes dispos pour la période ${libellePeriode(cfg.periode)}${limite}. Touche ici pour les donner.`,
        tag: `saisie-${cfg.periode}`,
      });
    }
    envois[cleRel] = new Date().toISOString();
    faits.push('rappel demandé par le chef');
  }

  // 2. Planning publié (ou republié) : chacun reçoit ses astreintes, en journée.
  if (rap.publication && heure >= 8 && heure <= 21) {
    for (const [per, ok] of Object.entries(cfg.publie || {})) {
      if (!ok) continue;
      const quand = cfg.publieLe?.[per];
      const cle = `publication-${per}-${quand?.toMillis ? quand.toMillis() : ''}`;
      if (envois[cle]) continue;
      const fin = parseYmd(per); fin.setDate(fin.getDate() + 7 * semainesDe(cfg, per));
      if (fin < parseYmd(jour)) { envois[cle] = 'periode passee'; continue; }
      // Le planning général voyage avec la notification : le téléphone le garde et l'appli l'affiche.
      // Une notification web est limitée à 4 Ko : au-delà, on ne joint pas le planning général.
      const general = JSON.stringify(resumePlanning(per, pompiers, semainesDe(cfg, per)));
      const joint = general.length <= 3000 ? general : '';
      for (const p of pompiers) {
        const blocs = p.affectations?.[per] || [];
        if (!blocs.length) continue;
        aEnvoyer.push({
          pompier: p, title: 'Planning d’astreinte publié', tag: `publication-${per}`, planning: joint,
          body: `${texteNotifPlanning(per, cfg.heures, blocs)}${joint ? ' Touche pour voir aussi le planning général.' : ''}`,
        });
      }
      envois[cle] = new Date().toISOString();
      faits.push(`publication ${per}`);
    }
  }

  // 3. Le jour où une astreinte commence.
  if (rap.debut && heure >= HEURE_DEBUT_ASTREINTE && !envois[`debut-${jour}`]) {
    let n = 0;
    for (const p of pompiers) {
      for (const [per, blocs] of Object.entries(p.affectations || {})) {
        if (!cfg.publie?.[per] || !Array.isArray(blocs)) continue;
        for (const c of creneaux(per, cfg.heures, semainesDe(cfg, per))) {
          if (blocs.includes(c.id) && ymd(c.debut) === jour) {
            aEnvoyer.push({
              pompier: p,
              title: 'Astreinte aujourd’hui',
              body: `Ton astreinte ${c.label.toLowerCase()} commence ce soir et finit ${c.type === 'WE' ? 'lundi' : 'vendredi'} matin.`,
              tag: `debut-${per}-${c.id}`,
            });
            n++;
          }
        }
      }
    }
    envois[`debut-${jour}`] = new Date().toISOString();
    if (n) faits.push(`début d’astreinte (${n})`);
  }

  // Envoi : un message par téléphone enregistré.
  const messages = [];
  const cibles = [];
  for (const m of aEnvoyer) {
    for (const token of m.pompier.notifs || []) {
      if (token === 'demo') continue;
      messages.push({
        token,
        data: { title: m.title, body: m.body, url: lienDe(m.pompier.id), tag: m.tag, ...(m.planning ? { planning: m.planning } : {}) },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
      });
      cibles.push({ id: m.pompier.id, token });
    }
  }

  let reussis = 0;
  const morts = new Map();
  if (ESSAI) {
    for (const m of aEnvoyer) console.log(`[essai] ${nom(m.pompier)} (${(m.pompier.notifs || []).length} tél.) : ${m.title} — ${m.body}`);
  } else {
    for (let i = 0; i < messages.length; i += 500) {
      const rep = await fcm.sendEach(messages.slice(i, i + 500));
      rep.responses.forEach((r, k) => {
        if (r.success) { reussis++; return; }
        const code = r.error?.code || '';
        const c = cibles[i + k];
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
          if (!morts.has(c.id)) morts.set(c.id, []);
          morts.get(c.id).push(c.token);
        } else console.warn(`Échec pour ${c.id} : ${code}`);
      });
    }
    // Téléphones désinstallés ou notifications retirées : on les oublie.
    for (const [id, tokens] of morts) await db.doc(`pompiers/${id}`).update({ notifs: FieldValue.arrayRemove(...tokens) });
  }

  const sansTelephone = new Set(aEnvoyer.filter((m) => !(m.pompier.notifs || []).some((t) => t !== 'demo')).map((m) => m.pompier.id)).size;
  const bilan = aEnvoyer.length
    ? `${faits.join(', ')} : ${reussis} notification${reussis > 1 ? 's' : ''} envoyée${reussis > 1 ? 's' : ''}${sansTelephone ? `, ${sansTelephone} pompier${sansTelephone > 1 ? 's' : ''} sans rappels activés` : ''}.`
    : 'Rien à envoyer à ce passage.';
  console.log(bilan);

  if (!ESSAI) {
    // On ne garde que les 200 dernières traces d'envoi.
    const cles = Object.keys(envois).sort((a, b) => String(envois[a]).localeCompare(String(envois[b])));
    for (const k of cles.slice(0, Math.max(0, cles.length - 200))) delete envois[k];
    const champs = { envois, derniereExecution: FieldValue.serverTimestamp(), dernierBilan: bilan };
    if (aEnvoyer.length) Object.assign(champs, { dernierEnvoi: bilan, dernierEnvoiLe: FieldValue.serverTimestamp() });
    await refJournal.set(champs, { mergeFields: Object.keys(champs) });
  }
}

principal().catch((e) => { console.error(e); process.exit(1); });
