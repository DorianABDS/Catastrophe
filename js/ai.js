// ai.js — décisions automatiques pour les joueurs "ordinateur"
(function (root) {
  const Engine = (typeof module !== 'undefined') ? require('./engine.js') : root.CatastropheEngine;
  const Data = (typeof module !== 'undefined') ? require('./data.js') : root.CatastropheData;

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

  // Choisit une carte à défausser suite à Panique/Détournement
  // (le Défensif ne sert qu'en réaction : les doublons excédentaires sont les moins utiles à garder)
  function aiChooseDiscard(player, reason) {
    const priority = ['Defensif', 'Offensif', 'Sabotage', 'Ressource', 'Colere', 'Catastrophe'];
    const sorted = player.hand.slice().sort((a, b) => priority.indexOf(a.category) - priority.indexOf(b.category));
    return sorted.length ? sorted[0].id : null;
  }

  // Choisit les cartes à défausser en excédent de main (fin de tour)
  // Colère/Catastrophe sont protégées en priorité (elles font avancer la partie),
  // puis Ressource (utile pour soigner et pour le score final), puis Sabotage/Offensif,
  // le Défensif au-delà de 2 exemplaires est le moins utile à conserver.
  function aiChooseExcessDiscard(player, count) {
    const defensif = player.hand.filter((c) => c.category === 'Defensif');
    const excessDefensif = defensif.slice(Math.min(2, defensif.length));
    const offensif = player.hand.filter((c) => c.category === 'Offensif');
    const sabotage = player.hand.filter((c) => c.category === 'Sabotage');
    const ressource = player.hand.filter((c) => c.category === 'Ressource');
    const keptDefensif = defensif.slice(0, Math.min(2, defensif.length));
    const colere = player.hand.filter((c) => c.category === 'Colere');
    const catastrophe = player.hand.filter((c) => c.category === 'Catastrophe');
    const order = [...excessDefensif, ...offensif, ...sabotage, ...ressource, ...keptDefensif, ...colere, ...catastrophe];
    return order.slice(0, count).map((c) => c.id);
  }

  // Tentative de Verdict : deviner le secret d'une victime.
  // Un joueur attentif exclut son propre secret (unique parmi les 9 cartes) et les
  // secrets déjà révélés publiquement lors de Verdicts précédents — la seule déduction
  // réellement disponible sans lire dans le jeu d'autrui. Plus le bassin restant est
  // petit, plus la tentative est rentable (gain +10 / perte -10).
  function aiVerdictGuess(state, victimId, guesserId) {
    const guesser = guesserId ? Engine.getPlayer(state, guesserId) : null;
    const revealed = new Set(state.players.filter((p) => p.secretRevealed).map((p) => p.secret));
    if (guesser) revealed.add(guesser.secret);
    const pool = Data.SECRETS.map((s) => s.id).filter((id) => !revealed.has(id));
    const candidates = pool.length ? pool : Data.SECRETS.map((s) => s.id);
    // Reste aussi joueur que l'ancien réglage (tentative ~45% en moyenne, pour que
    // le Verdict continue d'arriver en jeu) mais mieux informé : la probabilité monte
    // quand le bassin de secrets restants est petit (déduction fiable) et descend
    // légèrement sinon, au lieu d'un simple tirage à l'aveugle sur les 9 secrets.
    const n = candidates.length;
    let attemptChance;
    if (n <= 1) attemptChance = 0.8;
    else if (n === 2) attemptChance = 0.65;
    else if (n === 3) attemptChance = 0.55;
    else if (n === 4) attemptChance = 0.5;
    else if (n === 5) attemptChance = 0.45;
    else if (n === 6) attemptChance = 0.4;
    else attemptChance = 0.35;
    if (Math.random() < attemptChance) return pick(candidates);
    return null;
  }

  // Construit la liste des actions jouées par l'IA pour un tour normal.
  // Retourne un plan : {resource:{cardId,opts}|null, offensive:{cardId,targetId}|null, sabotages:[{cardId,targetId}], colere:{cardId,catastropheCardId}|null}
  function aiPlanTurn(state, player) {
    const others = Engine.activePlayers(state).filter((p) => p.id !== player.id);
    const plan = { resource: null, offensive: null, sabotages: [], colere: null };
    let plays = 0;

    const hasCategory = (cat) => player.hand.filter((c) => c.category === cat);

    // 1. Ressource : soigner si bas, sinon piocher/valoriser
    if (!player.blockRessourceNextTurn) {
      const resCards = hasCategory('Ressource');
      if (resCards.length > 0) {
        let chosen;
        if (player.resistance <= 5) {
          chosen = resCards.find((c) => c.kind === 'provisions') || resCards.find((c) => c.kind === 'renfort') || resCards.find((c) => c.kind === 'entraide') || resCards[0];
        } else {
          chosen = resCards.find((c) => c.kind === 'provisions_urgence') || resCards.find((c) => c.kind === 'ravitaillement') || resCards[0];
        }
        const opts = chosen.kind === 'entraide' ? { targetId: player.id } : undefined;
        plan.resource = { cardId: chosen.id, opts };
        plays += 1;
      }
    }

    // 2. Offensif : viser l'adversaire le plus faible (égalités départagées au hasard,
    // sinon le même siège reste systématiquement la cible prioritaire à chaque tour)
    const offCards = hasCategory('Offensif');
    if (offCards.length > 0 && plays < 4 && others.length > 0) {
      const minResistance = Math.min(...others.map((o) => o.resistance));
      const weakestPool = others.filter((o) => o.resistance === minResistance);
      const weakest = pick(weakestPool);
      const chosen = offCards.find((c) => c.kind === 'amputation' && weakest.resistance <= 2)
        || offCards.find((c) => c.kind === 'machette')
        || offCards[0];
      plan.offensive = { cardId: chosen.id, targetId: weakest.id };
      plays += 1;
    }

    // 3. Sabotage : viser des adversaires différents tant que le budget le permet
    // (ordre de ciblage mélangé pour ne pas toujours viser le même siège en premier)
    const saboCards = hasCategory('Sabotage');
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

    // 4. Colère : si une Catastrophe est en main, forte probabilité de la déclencher.
    // Plus la main se remplit (risque de défausse forcée), plus l'IA se presse de
    // la jouer — évite qu'une paire Catastrophe+Colère traîne indéfiniment et
    // retarde la fin de partie (observé en simulation sur de rares parties très longues).
    const catCard = player.hand.find((c) => c.category === 'Catastrophe');
    const colereCard = player.hand.find((c) => c.category === 'Colere');
    if (catCard && colereCard) {
      const urgency = player.hand.length >= 4 ? 0.97 : 0.85;
      if (Math.random() < urgency) {
        plan.colere = { cardId: colereCard.id, catastropheCardId: catCard.id };
      }
    }

    return plan;
  }

  const AI = { aiChooseDefense, aiChooseDiscard, aiChooseExcessDiscard, aiVerdictGuess, aiPlanTurn };

  if (typeof module !== 'undefined') module.exports = AI;
  else root.CatastropheAI = AI;
})(typeof window !== 'undefined' ? window : global);
