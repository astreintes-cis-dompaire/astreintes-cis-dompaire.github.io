// Programme de rappel : lancé automatiquement par GitHub toutes les 10 minutes en journée (voir .github/workflows/rappels.yml).
// Il lit la base, décide quelles notifications envoyer, les envoie et note ce qu'il a fait dans chef/journal.
//
// Variables d'environnement :
//   FIREBASE_SERVICE_ACCOUNT  contenu du fichier JSON du compte de service (secret GitHub)
//   SITE_URL                  adresse de l'appli, ex. https://pseudo.github.io/astreintes/
//   ESSAI=1                   affiche ce qui serait envoyé, sans rien envoyer

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { astreintesGroupees, semainesDe, libellePeriode, texteNotifPlanning, parseYmd, ymd, fmtJour, resumePlanning, addDays, libelleGarde, texteRemplacement, dateHeure } from './dates.js';

const ESSAI = process.env.ESSAI === '1';
const SITE = (process.env.SITE_URL || '').trim().replace(/\/?$/, '/');
const RAPPELS_DEFAUT = { saisie: true, joursAvant: [7, 3, 1], heure: 18, publication: true, debut: true, garde: true };
const HEURE_DEBUT_ASTREINTE = 9; // le rappel « astreinte aujourd'hui » part le matin

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Pas d'échec (sinon GitHub envoie un courriel toutes les 10 minutes) : l'espace chef signale que rien ne tourne.
  console.log('SECRET MANQUANT : FIREBASE_SERVICE_ACCOUNT n’est pas dans les secrets GitHub. Aucune notification envoyée.');
  process.exit(0);
}
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const fcm = getMessaging();

function maintenantParis() {
  const morceaux = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { jour: `${morceaux.year}-${morceaux.month}-${morceaux.day}`, heure: Number(morceaux.hour), minute: Number(morceaux.minute) };
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
  const { jour, heure, minute } = maintenantParis();
  // Heure de Paris au même format que les dates des remplacements (« AAAA-MM-JJTHH:MM »), pour les comparer.
  const maintenant = dateHeure(`${jour}T${String(heure).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
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

  // 1 ter. Notification de test demandée par le chef (onglet Équipe), à toute heure.
  const test = cfg.testNotif;
  const cleTest = test?.le?.toMillis ? `test-${test.le.toMillis()}` : '';
  let bilanTest = '';
  if (cleTest && !envois[cleTest]) {
    const p = pompiers.find((x) => x.id === test.id);
    if (!p) bilanTest = 'Test : pompier introuvable.';
    else if (!(p.notifs || []).some((t) => t !== 'demo')) bilanTest = `Test : ${nom(p)} n’a pas activé les rappels sur son téléphone.`;
    else {
      aEnvoyer.push({ pompier: p, title: 'Test des notifications', body: 'Si tu lis ce message, les rappels d’astreinte marchent sur ce téléphone.', tag: 'test', test: true });
    }
    envois[cleTest] = new Date().toISOString();
    faits.push('test');
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
      if (cfg.publieNotif?.[per] === false) { envois[cle] = 'sans notification'; continue; }
      const mot = String(cfg.messagePlanning?.[per] || '').trim().slice(0, 200);
      // Le planning général voyage avec la notification : le téléphone le garde et l'appli l'affiche.
      // Une notification web est limitée à 4 Ko : au-delà, on ne joint pas le planning général.
      const general = JSON.stringify(resumePlanning(per, pompiers, semainesDe(cfg, per)));
      const joint = general.length <= 3000 ? general : '';
      for (const p of pompiers) {
        const blocs = p.affectations?.[per] || [];
        if (!blocs.length) continue;
        aEnvoyer.push({
          pompier: p, title: 'Planning d’astreinte publié', tag: `publication-${per}`, planning: joint,
          body: `${texteNotifPlanning(per, cfg.heures, blocs)}${mot ? ` ${mot}` : ''}${joint ? ' Touche pour voir aussi le planning général.' : ''}`,
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
        // Week-end + semaine de la même semaine : un seul rappel, le vendredi, pour toute la semaine.
        for (const c of astreintesGroupees(per, cfg.heures, blocs, semainesDe(cfg, per))) {
          if (ymd(c.debut) === jour) {
            aEnvoyer.push({
              pompier: p,
              title: 'Astreinte aujourd’hui',
              body: c.type === 'TOUT'
                ? 'Ta semaine complète d’astreinte commence ce soir et finit vendredi prochain.'
                : `Ton astreinte ${c.label.toLowerCase()} commence ce soir et finit ${c.type === 'WE' ? 'lundi' : 'vendredi'} matin.`,
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

  // 4. Garde postée du samedi : le lundi à partir de 8h, chacun est invité à dire s'il est dispo.
  // Si le programme n'a pas pu tourner le lundi, la question part le mardi ou le mercredi.
  const jourSemaine = parseYmd(jour).getDay();
  if (rap.garde && jourSemaine >= 1 && jourSemaine <= 3 && heure >= 8 && heure <= 21) {
    const samedi = ymd(addDays(parseYmd(jour), 6 - jourSemaine));
    const cle = `garde-${samedi}`;
    if (!envois[cle]) {
      for (const p of pompiers) {
        if (p.gardeSamedi?.[samedi] !== undefined) continue;
        aEnvoyer.push({
          pompier: p,
          title: 'Garde postée de samedi',
          body: `Garde postée ${libelleGarde(samedi)} : si tu es dispo, touche ici pour le signaler au chef (facultatif).`,
          tag: cle,
          ancre: 'garde',
        });
      }
      envois[cle] = new Date().toISOString();
      faits.push(`garde du samedi ${samedi}`);
    }
  }

  // Téléphones du chef (bouton « Recevoir les alertes » de l'onglet Remplacements).
  const chefTel = { id: 'chef', prenom: 'Chef', nom: '', notifs: (await db.doc('chef/notifs').get()).data()?.tokens || [] };

  // 4 bis. Garde du samedi : le chef est prévenu de chaque volontaire ; les retenus, quand le chef envoie la garde.
  {
    for (const p of pompiers) {
      for (const [s, oui] of Object.entries(p.gardeSamedi || {})) {
        const cle = `garde-dispo-${s}-${p.id}`;
        if (oui !== true || s < jour || envois[cle]) continue;
        aEnvoyer.push({ pompier: chefTel, url: `${SITE}#chef-garde`, tag: `garde-dispo-${s}`, title: 'Dispo pour la garde du samedi', body: `${nom(p)} est dispo ${libelleGarde(s)}.` });
        envois[cle] = new Date().toISOString();
      }
    }
    const ge = cfg.gardeEnvoi;
    const cleGe = ge?.le?.toMillis ? `garde-envoi-${ge.le.toMillis()}` : '';
    if (cleGe && !envois[cleGe] && ge.notif === false) envois[cleGe] = 'sans notification';
    else if (cleGe && !envois[cleGe] && ge.samedi >= jour) {
      const mot = String(ge.message || '').trim().slice(0, 200);
      for (const id of ge.ids || []) {
        const p = pompiers.find((x) => x.id === id);
        if (!p || envois[`garde-retenu-${ge.samedi}-${id}`]) continue;
        aEnvoyer.push({ pompier: p, tag: `garde-${ge.samedi}`, ancre: 'garde', title: 'Garde postée : tu es retenu', body: `Tu es retenu pour la garde postée du ${libelleGarde(ge.samedi)}, à la caserne.${mot ? ` ${mot}` : ''}` });
        envois[`garde-retenu-${ge.samedi}-${id}`] = new Date().toISOString();
      }
      envois[cleGe] = new Date().toISOString();
      faits.push(`garde composée ${ge.samedi}`);
    }
  }

  // 5. Demandes de remplacement : le chef est prévenu de chaque nouvelle demande,
  //    le pompier de la réponse, et le remplaçant quand la demande est acceptée puis 30 minutes avant le début.
  //    Chaque envoi est noté dans la demande elle-même (notifChef, notifReponse, notifRappel).
  const marques = []; // [id du pompier, chemin du champ, valeur]
  const limiteGarde = new Date(Date.now() - 60 * 86400000);
  let nRemp = 0;
  for (const p of pompiers) {
    for (const [rid, r] of Object.entries(p.remplacements || {})) {
      if (!r || typeof r !== 'object') continue;
      if (r.au && dateHeure(r.au) < limiteGarde) { marques.push([p.id, `remplacements.${rid}`, FieldValue.delete()]); continue; }
      const quoi = texteRemplacement(r, cfg.heures);
      if (r.statut === 'attente' && !r.notifChef) {
        aEnvoyer.push({
          pompier: chefTel, url: `${SITE}#chef-remplacements`, tag: `remplacement-${rid}`,
          title: 'Demande de remplacement',
          body: `${nom(p)} demande à être remplacé : ${quoi}${r.remplacantNom ? `, par ${r.remplacantNom}` : ', remplaçant à trouver'}.`,
        });
        marques.push([p.id, `remplacements.${rid}.notifChef`, true]);
        nRemp++;
      }
      if ((r.statut === 'accepte' || r.statut === 'refuse') && !r.notifReponse) {
        const ok = r.statut === 'accepte';
        aEnvoyer.push({
          pompier: p, tag: `remplacement-${rid}`, ancre: 'remplacement',
          title: ok ? 'Remplacement accepté' : 'Remplacement refusé',
          body: `${quoi} : ${ok ? 'le chef a accepté ta demande' : 'le chef a refusé ta demande'}${r.reponse ? `. « ${r.reponse} »` : '.'}`,
        });
        const q = ok && r.remplacant ? pompiers.find((x) => x.id === r.remplacant) : null;
        if (q) aEnvoyer.push({ pompier: q, tag: `remplace-${rid}`, ancre: 'remplacement', title: 'Tu remplaces un collègue', body: `Tu remplaces ${nom(p)} : ${quoi}.` });
        // Acceptée moins de 30 minutes avant le début : ce message sert aussi de rappel.
        if (q && r.du && maintenant >= new Date(dateHeure(r.du) - 30 * 60000)) marques.push([p.id, `remplacements.${rid}.notifRappel`, true]);
        marques.push([p.id, `remplacements.${rid}.notifReponse`, true]);
        nRemp++;
      } else if (r.statut === 'accepte' && r.remplacant && r.du && r.au && !r.notifRappel) {
        // Rappel au remplaçant, au plus 30 minutes avant le début de ce qu'il remplace (envoyé tant que ce n'est pas fini,
        // au cas où le programme a tourné en retard).
        const debut = dateHeure(r.du);
        const q = pompiers.find((x) => x.id === r.remplacant);
        if (q && maintenant >= new Date(debut - 30 * 60000) && maintenant < dateHeure(r.au)) {
          const hh = r.du.split('T')[1] || '';
          aEnvoyer.push({
            pompier: q, tag: `remplace-rappel-${rid}`, ancre: 'remplacement', title: 'Ton remplacement commence bientôt',
            body: `${maintenant < debut ? `À ${hh.replace(':', 'h')}` : 'Maintenant'} : tu remplaces ${nom(p)}, ${quoi}.`,
          });
          marques.push([p.id, `remplacements.${rid}.notifRappel`, true]);
          nRemp++;
        }
      }
    }
    for (const [rid, r] of Object.entries(p.remplacementsRecus || {})) {
      if (r?.au && dateHeure(r.au) < limiteGarde) marques.push([p.id, `remplacementsRecus.${rid}`, FieldValue.delete()]);
    }
  }
  if (nRemp) faits.push(`remplacements (${nRemp})`);

  // Envoi : un message par téléphone enregistré.
  const messages = [];
  const cibles = [];
  for (const m of aEnvoyer) {
    for (const token of m.pompier.notifs || []) {
      if (token === 'demo') continue;
      messages.push({
        token,
        data: { title: m.title, body: m.body, url: `${m.url || lienDe(m.pompier.id)}${m.ancre ? `#${m.ancre}` : ''}`, tag: m.tag, ...(m.planning ? { planning: m.planning } : {}) },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
      });
      cibles.push({ id: m.pompier.id, token, test: !!m.test });
    }
  }

  let reussis = 0;
  const testRes = [];
  const morts = new Map();
  if (ESSAI) {
    for (const m of aEnvoyer) console.log(`[essai] ${nom(m.pompier)} (${(m.pompier.notifs || []).length} tél.) : ${m.title} — ${m.body}`);
  } else {
    for (let i = 0; i < messages.length; i += 500) {
      const rep = await fcm.sendEach(messages.slice(i, i + 500));
      rep.responses.forEach((r, k) => {
        const c = cibles[i + k];
        if (c.test) testRes.push(r.success ? 'ok' : (r.error?.code || 'erreur'));
        if (r.success) { reussis++; return; }
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
          if (!morts.has(c.id)) morts.set(c.id, []);
          morts.get(c.id).push(c.token);
        } else console.warn(`Échec pour ${c.id} : ${code}`);
      });
    }
    // Téléphones désinstallés ou notifications retirées : on les oublie.
    for (const [id, tokens] of morts) {
      if (id === 'chef') await db.doc('chef/notifs').update({ tokens: FieldValue.arrayRemove(...tokens) });
      else await db.doc(`pompiers/${id}`).update({ notifs: FieldValue.arrayRemove(...tokens) });
    }
    // Demandes de remplacement : notées comme prévenues (ou effacées, 60 jours après la fin).
    const parPompier = new Map();
    for (const [id, champ, v] of marques) parPompier.set(id, { ...(parPompier.get(id) || {}), [champ]: v });
    for (const [id, champs] of parPompier) await db.doc(`pompiers/${id}`).update(champs);
  }

  const sansTelephone = new Set(aEnvoyer.filter((m) => m.pompier.id !== 'chef' && !(m.pompier.notifs || []).some((t) => t !== 'demo')).map((m) => m.pompier.id)).size;
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
    if (cleTest && !bilanTest) {
      const ok = testRes.filter((x) => x === 'ok').length;
      const p = pompiers.find((x) => x.id === test.id);
      bilanTest = ok ? `Test : notification envoyée à ${nom(p)} (${ok} téléphone${ok > 1 ? 's' : ''}).`
        : `Test : échec de l’envoi à ${nom(p)} (${testRes.join(', ') || 'aucun téléphone valide'}). Il doit réactiver les rappels.`;
    }
    if (bilanTest) champs.dernierTest = { le: FieldValue.serverTimestamp(), bilan: bilanTest };
    await refJournal.set(champs, { mergeFields: Object.keys(champs) });
  }
}

principal().catch((e) => { console.error(e); process.exit(1); });
