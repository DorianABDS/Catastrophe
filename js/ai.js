// ai.js — décisions automatiques pour les joueurs "ordinateur"
(function (root) {
  const Engine = (typeof module !== 'undefined') ? require('./engine.js') : root.CatastropheEngine;

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // Choisit une carte défensive à jouer (ou null) face à un contexte de dégâts
  function aiChooseDefense(state, player, options, context) {
    if (options.length === 0) return null;
    const cards = options.map((id) => player.hand.find((c) => c.id === id)).filter(Boolean);
    // Priorité à la défensive spécifique (annule mieux), sinon Kit de secours
    const specific = cards.find((c) => c.kind !== 'kit_secours');
    if (specific) return specific.id;
    const kit = cards.find((c) => c.kind === 'kit_secours');
    if (kit) return kit.id;
    return null;
  }

  // Choisit quelle carte récupérer dans la main d'une victime (butin de kill)
  // (priorité aux cartes les plus utiles à récupérer / à retirer à l'adversaire)
  function aiChooseSteal(target) {
    const priority = ['Catastrophe', 'Ressource', 'Offensif', 'Sabotage', 'Defensif'];
    const sorted = target.hand.slice().sort((a, b) => priority.indexOf(a.category) - priority.indexOf(b.category));
    return sorted.length ? sorted[0].id : null;
  }

  // Choisit les cartes à défausser en excédent de main (fin de tour)
  // Catastrophe est protégée en priorité (elle fait avancer la partie), puis Ressource
  // (utile pour soigner et pour le score final), puis Sabotage/Offensif, le Défensif
  // au-delà de 2 exemplaires est le moins utile à conserver.
  function aiChooseExcessDiscard(player, count) {
    const defensif = player.hand.filter((c) => c.category === 'Defensif');
    const excessDefensif = defensif.slice(Math.min(2, defensif.length));
    const offensif = player.hand.filter((c) => c.category === 'Offensif');
    const sabotage = player.hand.filter((c) => c.category === 'Sabotage');
    const ressource = player.hand.filter((c) => c.category === 'Ressource');
    const keptDefensif = defensif.slice(0, Math.min(2, defensif.length));
    const catastrophe = player.hand.filter((c) => c.category === 'Catastrophe');
    const order = [...excessDefensif, ...offensif, ...sabotage, ...ressource, ...keptDefensif, ...catastrophe];
    return order.slice(0, count).map((c) => c.id);
  }

  // Construit la liste des actions jouées par l'IA pour un tour normal.
  // Retourne un plan : {resource, offensive, sabotages, catastrophe}
  function aiPlanTurn(state, player) {
    const others = Engine.activePlayers(state).filter((p) => p.id !== player.id);
    const plan = { resource: null, offensive: null, sabotages: [], catastrophe: null };
    let plays = 0;

    const hasCategory = (cat) => player.hand.filter((c) => c.category === cat);

    // 0. Catastrophe : décision précoce, car la jouer verrouille Sabotage et Offensif
    // pour le reste du tour (seule Ressource reste autorisée en plus). Préférence pour
    // la catastrophe désignée Force par le Présage (dégâts maximaux aux adversaires).
    const catCards = hasCategory('Catastrophe');
    let catastrophePlayed = false;
    if (catCards.length > 0) {
      const urgency = player.hand.length >= 4 ? 0.9 : 0.6;
      if (Math.random() < urgency) {
        const chosen = catCards.find((c) => c.kind === state.presage.force) || pick(catCards);
        plan.catastrophe = { cardId: chosen.id };
        catastrophePlayed = true;
      }
    }

    // 1. Ressource : soigner si bas, sinon piocher/valoriser (reste autorisée même si
    // une Catastrophe est jouée ce tour). Entraide ne peut plus jamais cibler soi-même
    // (règle) : elle ne sert donc à rien pour se soigner, seulement pour aider un
    // adversaire. Un joueur Le Bienfaiteur la recherche activement tant que son
    // objectif n'est pas rempli ; sinon elle reste un dernier recours.
    if (!player.blockRessourceNextTurn) {
      const resCards = hasCategory('Ressource');
      // Sursis n'est jouable qu'en dessous du seuil imprimé sur la carte (règle du
      // moteur) : on l'exclut des options tant que ce n'est pas le cas, pour ne jamais
      // tenter un coup invalide.
      const selfHealCards = resCards.filter((c) => {
        if (c.kind === 'entraide') return false;
        if (c.kind === 'sursis') return player.pv <= c.requiresLowPv;
        if (c.kind === 'renfort' || c.kind === 'provisions') return player.pv < player.maxPv;
        return true;
      });
      const entraideCard = resCards.find((c) => c.kind === 'entraide');
      const healableOthers = others.filter((o) => o.pv < o.maxPv);
      const weakestOther = healableOthers.length > 0 ? healableOthers.slice().sort((a, b) => a.pv - b.pv)[0] : null;

      if (
        entraideCard && weakestOther
        && player.secret === 'bienfaiteur'
        && player.stats.entraideOnOthers < 2
        && (player.pv > 4 || selfHealCards.length === 0)
      ) {
        plan.resource = { cardId: entraideCard.id, opts: { targetId: weakestOther.id } };
        plays += 1;
      } else if (selfHealCards.length > 0) {
        const chosen = player.pv <= 5
          ? (selfHealCards.find((c) => c.kind === 'sursis') || selfHealCards.find((c) => c.kind === 'provisions') || selfHealCards.find((c) => c.kind === 'renfort') || selfHealCards[0])
          : (selfHealCards.find((c) => c.kind === 'sursis') || selfHealCards.find((c) => c.kind === 'provisions_urgence') || selfHealCards.find((c) => c.kind === 'ravitaillement') || selfHealCards[0]);
        plan.resource = { cardId: chosen.id };
        plays += 1;
      } else if (entraideCard && weakestOther) {
        // Rien d'autre à jouer que Entraide : autant en faire profiter un adversaire.
        plan.resource = { cardId: entraideCard.id, opts: { targetId: weakestOther.id } };
        plays += 1;
      }
    }

    // 2. Offensif : viser l'adversaire le plus faible (égalités départagées au hasard).
    // Indisponible si une Catastrophe est jouée ce tour, ou sous Quarantaine.
    const offCards = hasCategory('Offensif');
    if (!catastrophePlayed && !player.blockOffensifNextTurn && offCards.length > 0 && plays < 4 && others.length > 0) {
      const minPv = Math.min(...others.map((o) => o.pv));
      const weakestPool = others.filter((o) => o.pv === minPv);
      const weakest = pick(weakestPool);
      const chosen = offCards.find((c) => c.kind === 'amputation' && weakest.pv <= 2)
        || offCards.find((c) => c.kind === 'machette')
        || offCards[0];
      plan.offensive = { cardId: chosen.id, targetId: weakest.id };
      plays += 1;
    }

    // 3. Sabotage : viser des adversaires différents tant que le budget le permet
    // (ordre de ciblage mélangé pour ne pas toujours viser le même siège en premier).
    // Indisponible si une Catastrophe est jouée ce tour.
    const saboCards = hasCategory('Sabotage');
    if (!catastrophePlayed) {
      const targeted = new Set();
      const shuffledOthers = others
        .map((o) => ({ o, r: Math.random() }))
        .sort((a, b) => a.r - b.r)
        .map((x) => x.o);
      for (const card of saboCards) {
        if (plays >= 4) break;
        const target = shuffledOthers.find((o) => !targeted.has(o.id));
        if (!target) break;
        targeted.add(target.id);
        plan.sabotages.push({ cardId: card.id, targetId: target.id });
        plays += 1;
      }
    }

    return plan;
  }

  const AI = { aiChooseDefense, aiChooseSteal, aiChooseExcessDiscard, aiPlanTurn };

  if (typeof module !== 'undefined') module.exports = AI;
  else root.CatastropheAI = AI;
})(typeof window !== 'undefined' ? window : global);
