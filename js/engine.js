// engine.js — moteur de règles, sans dépendance DOM.
// Les flux de jeu complexes (réactions défensives, verdict) sont des fonctions génératrices :
// elles `yield` une description d'interaction requise et reprennent avec la réponse fournie
// via gen.next(response). L'UI pilote la boucle (voir ui.js / runFlow).

(function (root) {
  const D = (typeof module !== 'undefined') ? require('./data.js') : root.CatastropheData;
  const {
    CATASTROPHE_KINDS, SPECIFIC_DEFENSE, ARCHETYPE_BY_CATASTROPHE, SECRETS,
    buildMainDeck, buildPresageDeck, buildCibleDeck, buildSecretDeck, shuffle,
  } = D;

  const MAX_END_COUNTER = 8;
  const MAX_HAND = 5;
  const TURN_BUDGET = 4;

  function log(state, message, extra) {
    state.log.push(Object.assign({ turn: state.turnNumber, message }, extra || {}));
  }

  function activePlayers(state) {
    return state.players.filter((p) => !p.eliminated);
  }

  function getPlayer(state, id) {
    return state.players.find((p) => p.id === id);
  }

  // ---------- Mise en place ----------

  function initGame(playerConfigs, rng) {
    const rand = rng || Math.random;
    const mainDeck = shuffle(buildMainDeck(), rand);
    const presageDeck = shuffle(buildPresageDeck(), rand);
    const cibleDeck = shuffle(buildCibleDeck(playerConfigs.length), rand);
    const secretDeck = shuffle(buildSecretDeck(), rand);

    const state = {
      players: [],
      mainDeck,
      discardPile: [],
      presage: { force: null, weakness: null },
      cibleHolders: { premiere: null, seconde: null },
      endCounter: 0,
      currentPlayerIndex: 0,
      turnNumber: 1,
      phase: 'playing',
      log: [],
      turnBudget: null,
      winners: null,
      finalScores: null,
    };

    // Le Présage : 2 cartes tirées, la 1ère = Force, la 2ème = Faiblesse
    const drawnPresage = [presageDeck[0], presageDeck[1]];
    state.presage.force = drawnPresage[0].kind;
    state.presage.weakness = drawnPresage[1].kind;
    log(state, `Le Présage révèle : Force = ${drawnPresage[0].label}, Faiblesse = ${drawnPresage[1].label}.`);

    playerConfigs.forEach((cfg, idx) => {
      const cible = cibleDeck[idx];
      const secret = secretDeck[idx];
      const player = {
        id: 'p' + idx,
        name: cfg.name,
        isAI: !!cfg.isAI,
        pv: 15,
        maxPv: 15,
        hand: [],
        cible: cible.kind,
        secret: secret.kind,
        secretRevealed: false,
        secretCancelled: false,
        eliminated: false,
        eliminatedTurn: null,
        bonusScore: 0,
        skipNextDraw: false,
        blockDefensifThisTurn: false,
        blockRessourceNextTurn: false,
        stats: {
          catastrophesPlayed: 0,
          sabotageTargets: new Set(),
          entraideOnOthers: 0,
          minPvEver: 15,
          sabotagedEver: false,
          sabotagedCount: 0,
          vautour: null,
          collectionneurAchieved: false,
        },
      };
      if (cible.kind === 'premiere') state.cibleHolders.premiere = player.id;
      if (cible.kind === 'seconde') state.cibleHolders.seconde = player.id;
      state.players.push(player);
    });

    // Cibles révélées publiquement (déjà en clair dans player.cible)
    state.players.forEach((p) => {
      log(state, `${p.name} révèle sa carte Cible : ${cibleLabel(p.cible)}.`);
    });

    // Initialise le suivi Vautour maintenant que les cibleHolders sont connus
    state.players.forEach((p) => {
      if (p.secret === 'vautour') {
        p.stats.vautour = { target: vautourPrimaryTarget(state, p), achieved: new Set(), switched: false };
      }
    });

    // Main de départ : 3 cartes
    state.players.forEach((p) => {
      for (let i = 0; i < 3; i++) drawOne(state, p);
    });

    resetTurnBudget(state);
    return state;
  }

  function cibleLabel(kind) {
    if (kind === 'premiere') return 'Première Cible';
    if (kind === 'seconde') return 'Seconde Cible';
    return 'Cible neutre';
  }

  function vautourPrimaryTarget(state, player) {
    if (player.cible === 'premiere') return state.cibleHolders.seconde;
    if (player.cible === 'seconde') return state.cibleHolders.premiere;
    return state.cibleHolders.premiere;
  }

  // ---------- Pioche / défausse ----------

  function reshuffleIfNeeded(state) {
    if (state.mainDeck.length === 0 && state.discardPile.length > 0) {
      state.mainDeck = shuffle(state.discardPile, Math.random);
      state.discardPile = [];
      log(state, 'Le paquet principal est repioché depuis la défausse.');
    }
  }

  // Le Collectionneur ne se vérifie plus seulement à l'état final : dès que le trio
  // Renfort + Provisions + Entraide est réuni en main à un moment de la partie,
  // l'objectif reste acquis même si ces cartes sont ensuite jouées.
  function noteCollectionneurProgress(player) {
    if (player.secret !== 'collectionneur' || player.stats.collectionneurAchieved) return;
    const has = (kind) => player.hand.some((c) => c.kind === kind);
    if (has('renfort') && has('provisions') && has('entraide')) {
      player.stats.collectionneurAchieved = true;
    }
  }

  function drawOne(state, player) {
    reshuffleIfNeeded(state);
    if (state.mainDeck.length === 0) return null;
    const card = state.mainDeck.pop();
    player.hand.push(card);
    noteCollectionneurProgress(player);
    return card;
  }

  function drawN(state, player, n) {
    const drawn = [];
    for (let i = 0; i < n; i++) {
      const c = drawOne(state, player);
      if (c) drawn.push(c);
    }
    return drawn;
  }

  function discardCard(state, player, cardId) {
    const idx = player.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return null;
    const [card] = player.hand.splice(idx, 1);
    state.discardPile.push(card);
    return card;
  }

  function updateMinPv(player) {
    if (player.pv < player.stats.minPvEver) {
      player.stats.minPvEver = player.pv;
    }
  }

  function changePv(state, player, delta) {
    player.pv = Math.max(0, Math.min(player.maxPv, player.pv + delta));
    updateMinPv(player);
    checkElimination(state, player);
  }

  function checkElimination(state, player) {
    if (!player.eliminated && player.pv <= 0) {
      player.eliminated = true;
      player.eliminatedTurn = state.turnNumber;
      log(state, `${player.name} est éliminé !`);
    }
  }

  // ---------- Budget de tour ----------

  function resetTurnBudget(state) {
    state.turnBudget = {
      usedTypes: new Set(),
      sabotageTargets: new Set(),
      totalPlays: 0,
      catastrophePlayed: false,
    };
  }

  function canPlayCategory(state, category, targetId) {
    const b = state.turnBudget;
    if (b.totalPlays >= TURN_BUDGET) return { ok: false, reason: 'Budget de 4 cartes atteint ce tour.' };
    if ((category === 'Sabotage' || category === 'Offensif') && b.catastrophePlayed) {
      return { ok: false, reason: 'Une Catastrophe a été jouée ce tour-ci : Sabotage et Offensif sont indisponibles jusqu\'au tour suivant.' };
    }
    if (category === 'Sabotage') {
      if (targetId && b.sabotageTargets.has(targetId)) {
        return { ok: false, reason: 'Cet adversaire a déjà été visé par un Sabotage ce tour-ci.' };
      }
      return { ok: true };
    }
    if (b.usedTypes.has(category)) {
      return { ok: false, reason: `Une carte ${category} a déjà été jouée ce tour-ci.` };
    }
    return { ok: true };
  }

  function registerPlay(state, category, targetId) {
    const b = state.turnBudget;
    b.totalPlays += 1;
    if (category === 'Sabotage') {
      b.sabotageTargets.add(targetId);
    } else {
      b.usedTypes.add(category);
    }
  }

  // ---------- Cartes Ressource ----------

  function playResourceCard(state, actorId, cardId, opts) {
    const player = getPlayer(state, actorId);
    const card = player.hand.find((c) => c.id === cardId);
    if (!card || card.category !== 'Ressource') return { ok: false, reason: 'Carte invalide.' };
    if (player.blockRessourceNextTurn) return { ok: false, reason: 'Sécheresse : Ressource interdite ce tour.' };
    const check = canPlayCategory(state, 'Ressource');
    if (!check.ok) return check;

    if (card.kind === 'entraide') {
      const targetId = opts && opts.targetId;
      if (!targetId || targetId === actorId) {
        return { ok: false, reason: 'Entraide ne peut être jouée que sur un autre joueur.' };
      }
      const target = getPlayer(state, targetId);
      if (!target || target.eliminated) {
        return { ok: false, reason: 'Cible invalide pour Entraide.' };
      }
    }

    discardCard(state, player, cardId);
    registerPlay(state, 'Ressource');

    switch (card.kind) {
      case 'renfort':
        changePv(state, player, 1);
        log(state, `${player.name} joue Renfort (+1 PV).`);
        break;
      case 'provisions':
        changePv(state, player, 2);
        log(state, `${player.name} joue Provisions (+2 PV).`);
        break;
      case 'entraide': {
        const targetId = opts.targetId;
        const target = getPlayer(state, targetId);
        changePv(state, target, 1);
        player.stats.entraideOnOthers += 1;
        log(state, `${player.name} joue Entraide sur ${target.name} (+1 PV).`);
        break;
      }
      case 'ravitaillement':
        drawN(state, player, 2);
        log(state, `${player.name} joue Ravitaillement (pioche 2 cartes).`);
        break;
      case 'provisions_urgence':
        drawN(state, player, 3);
        log(state, `${player.name} joue Provisions d'urgence (pioche 3 cartes).`);
        break;
      default:
        break;
    }
    return { ok: true };
  }

  // ---------- Défense réactive (générateur) ----------

  function usableDefenseCards(player, context) {
    // context: {kind:'catastrophe'|'offensif', catastropheKind, offensifKind}
    if (player.blockDefensifThisTurn) return [];
    return player.hand.filter((c) => {
      if (c.category !== 'Defensif') return false;
      if (context.kind === 'offensif' && context.offensifKind === 'amputation') return false; // rien ne bloque Amputation
      if (c.kind === 'kit_secours') return true;
      if (context.kind === 'catastrophe') return c.counters === context.catastropheKind;
      return false; // pas de défensif spécifique contre l'Offensif
    });
  }

  // yields {type:'chooseDefense', playerId, options, context} -> attend {cardId: id|null}
  function* reactToDamage(state, targetId, context) {
    const target = getPlayer(state, targetId);
    if (target.eliminated) return { defenseUsed: null };
    const options = usableDefenseCards(target, context);
    let chosenId = null;
    if (options.length > 0) {
      const response = yield { type: 'chooseDefense', playerId: targetId, options: options.map((c) => c.id), context };
      chosenId = response && response.cardId ? response.cardId : null;
    }
    let defenseCard = null;
    if (chosenId) {
      defenseCard = target.hand.find((c) => c.id === chosenId) || null;
      if (defenseCard) discardCard(state, target, chosenId);
    }
    return { defenseUsed: defenseCard };
  }

  // ---------- Cartes Offensif (générateur) ----------

  function* playOffensiveCard(state, actorId, cardId, targetId) {
    const actor = getPlayer(state, actorId);
    const target = getPlayer(state, targetId);
    const card = actor.hand.find((c) => c.id === cardId);
    if (!card || card.category !== 'Offensif') { yield { type: 'log', message: 'Carte invalide.' }; return; }
    const check = canPlayCategory(state, 'Offensif');
    if (!check.ok) { yield { type: 'log', message: check.reason }; return; }

    discardCard(state, actor, cardId);
    registerPlay(state, 'Offensif');
    log(state, `${actor.name} joue ${card.label} sur ${target.name}.`);

    if (card.kind === 'rechauffement') {
      for (const p of activePlayers(state)) {
        if (p.id === actorId) continue;
        const { defenseUsed } = yield* reactToDamage(state, p.id, { kind: 'offensif', offensifKind: 'rechauffement' });
        const dmg = defenseUsed ? 0 : 1;
        changePv(state, p, -dmg);
        log(state, `${p.name} ${defenseUsed ? 'bloque avec ' + defenseUsed.label : `perd ${dmg} PV`} (Réchauffement).`);
      }
      checkEndConditions(state);
      return;
    }

    const { defenseUsed } = yield* reactToDamage(state, targetId, { kind: 'offensif', offensifKind: card.kind });

    if (card.kind === 'machette') {
      const dmg = defenseUsed ? 0 : 1;
      changePv(state, target, -dmg);
      log(state, `${target.name} ${defenseUsed ? 'bloque avec ' + defenseUsed.label : `perd ${dmg} PV`}.`);
    } else if (card.kind === 'pioche_secours') {
      const dmg = defenseUsed ? 0 : 1;
      changePv(state, target, -dmg);
      const resCards = target.hand.filter((c) => c.category === 'Ressource');
      let stolen = null;
      if (resCards.length > 0) {
        stolen = resCards[Math.floor(Math.random() * resCards.length)];
        target.hand = target.hand.filter((c) => c.id !== stolen.id);
        actor.hand.push(stolen);
        noteCollectionneurProgress(actor);
      }
      log(state, `${target.name} ${defenseUsed ? 'bloque les dégâts avec ' + defenseUsed.label : `perd ${dmg} PV`}${stolen ? ` et se fait voler ${stolen.label}` : ''}.`);
    } else if (card.kind === 'contamination') {
      const stolen = defenseUsed ? 0 : 1;
      if (stolen > 0) {
        changePv(state, target, -stolen);
        changePv(state, actor, stolen);
      }
      log(state, `${target.name} ${defenseUsed ? 'bloque la Contamination' : `perd 1 PV, volé par ${actor.name}`}.`);
    } else if (card.kind === 'amputation') {
      changePv(state, target, -2);
      log(state, `${target.name} subit 2 dégâts d'Amputation (non bloquables).`);
    }
    checkEndConditions(state);
  }

  // ---------- Cartes Sabotage ----------

  function playSabotageCard(state, actorId, cardId, targetId) {
    const actor = getPlayer(state, actorId);
    const target = getPlayer(state, targetId);
    const card = actor.hand.find((c) => c.id === cardId);
    if (!card || card.category !== 'Sabotage') return { ok: false, reason: 'Carte invalide.' };
    const check = canPlayCategory(state, 'Sabotage', targetId);
    if (!check.ok) return check;

    discardCard(state, actor, cardId);
    registerPlay(state, 'Sabotage', targetId);
    actor.stats.sabotageTargets.add(targetId);
    target.stats.sabotagedEver = true;
    target.stats.sabotagedCount += 1;

    switch (card.kind) {
      case 'pillage': {
        if (target.hand.length > 0) {
          const stolen = target.hand[Math.floor(Math.random() * target.hand.length)];
          target.hand = target.hand.filter((c) => c.id !== stolen.id);
          actor.hand.push(stolen);
          noteCollectionneurProgress(actor);
          log(state, `${actor.name} joue Pillage sur ${target.name} et vole ${stolen.label}.`);
        } else {
          log(state, `${actor.name} joue Pillage sur ${target.name} mais rien à voler.`);
        }
        break;
      }
      case 'coupure':
        target.skipNextDraw = true;
        log(state, `${actor.name} joue Coupure : ${target.name} ne pioche pas au prochain tour.`);
        break;
      case 'panique':
        return { ok: true, needsDiscardChoice: true, card, actor, target };
      case 'detournement':
        return { ok: true, needsStealChoice: true, card, actor, target };
      default:
        break;
    }
    return { ok: true };
  }

  // Panique : la cible choisit elle-même une carte de sa main et la défausse (disparaît du jeu).
  function resolveForcedDiscard(state, targetId, cardId) {
    const target = getPlayer(state, targetId);
    const discarded = discardCard(state, target, cardId);
    if (discarded) log(state, `${target.name} défausse ${discarded.label} (Panique).`);
    return discarded;
  }

  // Détournement : l'acteur choisit lui-même une carte dans la main de la cible et la vole
  // (elle rejoint sa propre main, elle n'est pas défaussée).
  function resolveDetournementSteal(state, actorId, targetId, cardId) {
    const actor = getPlayer(state, actorId);
    const target = getPlayer(state, targetId);
    const idx = target.hand.findIndex((c) => c.id === cardId);
    if (idx === -1) return null;
    const [card] = target.hand.splice(idx, 1);
    actor.hand.push(card);
    noteCollectionneurProgress(actor);
    log(state, `${actor.name} vole ${card.label} à ${target.name} (Détournement).`);
    return card;
  }

  // ---------- Résolution d'une Catastrophe (générateur) ----------

  // Une Catastrophe se joue directement pendant le tour normal d'un joueur (plus de
  // verrouillage préalable). Elle consomme le "slot" Catastrophe du budget de tour et
  // interdit Sabotage/Offensif pour le reste de ce tour (Ressource reste autorisée).
  function* playCatastropheCard(state, actorId, cardId) {
    const actor = getPlayer(state, actorId);
    const card = actor.hand.find((c) => c.id === cardId);
    if (!card || card.category !== 'Catastrophe') { yield { type: 'log', message: 'Carte Catastrophe invalide.' }; return; }
    const check = canPlayCategory(state, 'Catastrophe');
    if (!check.ok) { yield { type: 'log', message: check.reason }; return; }

    registerPlay(state, 'Catastrophe');
    state.turnBudget.catastrophePlayed = true;
    yield* resolveCatastrophe(state, actorId, cardId);
  }

  function* resolveCatastrophe(state, actorId, catastropheCardId) {
    const actor = getPlayer(state, actorId);
    const card = actor.hand.find((c) => c.id === catastropheCardId);
    if (!card || card.category !== 'Catastrophe') { yield { type: 'log', message: 'Carte Catastrophe invalide.' }; return; }

    discardCard(state, actor, catastropheCardId);
    actor.stats.catastrophesPlayed += 1;

    const kind = card.kind;
    const isForce = kind === state.presage.force;
    const isWeakness = kind === state.presage.weakness;
    const baseDamage = isForce ? 4 : (isWeakness ? 2 : 3);
    const specificKind = SPECIFIC_DEFENSE[kind];
    const archetype = ARCHETYPE_BY_CATASTROPHE[kind];

    log(state, `${actor.name} déclenche ${card.label} ! (dégâts de base : ${baseDamage}${isForce ? ', catastrophe FORCE' : ''}${isWeakness ? ', catastrophe FAIBLESSE' : ''})`);

    const victims = activePlayers(state).filter((p) => p.id !== actorId);
    const eliminatedThisResolution = [];

    for (const victim of victims) {
      const { defenseUsed } = yield* reactToDamage(state, victim.id, { kind: 'catastrophe', catastropheKind: kind });
      let finalDamage;
      let bonus = 0;
      let fullyCancelled = false;

      if (defenseUsed && defenseUsed.kind === specificKind) {
        if (isForce) {
          finalDamage = 1;
        } else {
          finalDamage = 0;
          fullyCancelled = true;
          if (isWeakness) bonus = 1;
        }
      } else if (defenseUsed && defenseUsed.kind === 'kit_secours') {
        finalDamage = Math.max(0, baseDamage - 1);
        fullyCancelled = finalDamage === 0;
      } else {
        finalDamage = baseDamage;
      }

      changePv(state, victim, -finalDamage);
      if (bonus > 0) changePv(state, victim, bonus);

      log(state, `${victim.name} ${defenseUsed ? `se défend avec ${defenseUsed.label} — ` : ''}subit ${finalDamage} dégât(s)${bonus ? ` et regagne ${bonus} PV` : ''}.`);

      if (!fullyCancelled) {
        applyArchetype(state, victim, archetype);
      }

      if (victim.eliminated && victim.eliminatedTurn === state.turnNumber) {
        eliminatedThisResolution.push(victim);
      }
    }

    state.endCounter = Math.min(MAX_END_COUNTER, state.endCounter + 1);
    log(state, `Compteur de fin de partie : ${state.endCounter}/${MAX_END_COUNTER}.`);

    // Le Verdict
    for (const victim of eliminatedThisResolution) {
      const response = yield { type: 'verdict', catastropherId: actorId, victimId: victim.id };
      if (response && response.guess) {
        const correct = victim.secret === response.guess;
        if (correct) {
          actor.bonusScore += 10;
          victim.secretCancelled = true;
          victim.secretRevealed = true;
          log(state, `${actor.name} devine juste le secret de ${victim.name} (${secretLabel(victim.secret)}) : +10, secret annulé.`);
        } else {
          actor.bonusScore -= 5;
          log(state, `${actor.name} se trompe sur le secret de ${victim.name} : -5.`);
        }
      } else {
        log(state, `${actor.name} ne tente rien sur le secret de ${victim.name}.`);
      }
    }

    checkEndConditions(state);
  }

  // La partie se termine soit au 8e Catastrophe résolue, soit dès qu'il ne reste
  // plus qu'un seul survivant actif (sans quoi, en fin de partie, ce dernier
  // survivant devrait poser toutes les Catastrophes restantes tout seul pour
  // que le compteur atteigne 8 — absurde puisqu'il n'y a plus personne à toucher).
  function checkEndConditions(state) {
    if (state.phase === 'ended') return;
    if (state.endCounter >= MAX_END_COUNTER) {
      endGame(state);
      return;
    }
    const active = activePlayers(state);
    if (active.length <= 1) {
      log(state, active.length === 1
        ? `${active[0].name} est l'unique survivant : la partie se termine immédiatement.`
        : 'Plus aucun survivant : la partie se termine.');
      endGame(state);
    }
  }

  function secretLabel(kind) {
    const s = SECRETS.find((x) => x.id === kind);
    return s ? s.label : kind;
  }

  function applyArchetype(state, victim, archetype) {
    let applied = false;
    switch (archetype) {
      case 'perte_carte':
        if (victim.hand.length > 0) {
          const idx = Math.floor(Math.random() * victim.hand.length);
          const [lost] = victim.hand.splice(idx, 1);
          state.discardPile.push(lost);
          log(state, `${victim.name} perd ${lost.label} (Séisme).`);
          applied = true;
        }
        break;
      case 'blocage_defensif':
        victim.blockDefensifThisTurn = true;
        log(state, `${victim.name} ne pourra jouer aucun Défensif ce tour-ci (Tsunami).`);
        applied = true;
        break;
      case 'blocage_ressource':
        victim.blockRessourceNextTurn = true;
        log(state, `${victim.name} ne pourra jouer de Ressource à son prochain tour (Sécheresse).`);
        applied = true;
        break;
      case 'cicatrice':
        victim.maxPv = Math.max(0, victim.maxPv - 1);
        victim.pv = Math.min(victim.pv, victim.maxPv);
        updateMinPv(victim);
        checkElimination(state, victim);
        log(state, `${victim.name} subit une cicatrice permanente : PV max = ${victim.maxPv} (Volcan).`);
        applied = true;
        break;
      default:
        break;
    }
    if (!applied) {
      changePv(state, victim, -1);
      log(state, `${victim.name} ne peut pas subir l'archétype secondaire : -1 PV supplémentaire.`);
    } else {
      registerArchetypeEvent(state, victim.id, archetype);
    }
  }

  function registerArchetypeEvent(state, victimId, archetype) {
    state.players.forEach((p) => {
      if (p.secret === 'vautour' && p.stats.vautour && !p.eliminated) {
        const v = p.stats.vautour;
        if (v.target === victimId) {
          v.achieved.add(archetype);
        }
      }
    });
  }

  // Appelé quand un joueur est éliminé, pour gérer le repli du Vautour sur l'autre cible
  function handleVautourFallback(state) {
    state.players.forEach((p) => {
      if (p.secret === 'vautour' && p.stats.vautour && !p.switchedResolved) {
        const v = p.stats.vautour;
        const targetPlayer = getPlayer(state, v.target);
        if (targetPlayer && targetPlayer.eliminated && v.achieved.size < 4 && !v.switched) {
          const fallback = v.target === state.cibleHolders.premiere ? state.cibleHolders.seconde : state.cibleHolders.premiere;
          if (fallback && fallback !== v.target) {
            v.target = fallback;
            v.achieved = new Set();
            v.switched = true;
            log(state, `${p.name} (Vautour) reporte sa cible réelle, compteur d'archétypes remis à 0.`);
          }
        }
      }
    });
  }

  // ---------- Fin de tour (générateur) ----------

  function* normalEndOfTurn(state, playerId) {
    const player = getPlayer(state, playerId);
    handleVautourFallback(state);
    if (player.skipNextDraw) {
      player.skipNextDraw = false;
      yield { type: 'log', message: `${player.name} ne pioche pas (Coupure).` };
    } else {
      drawN(state, player, 2);
      yield { type: 'log', message: `${player.name} pioche 2 cartes.` };
    }
    player.blockRessourceNextTurn = false;
    if (player.hand.length > MAX_HAND) {
      const excess = player.hand.length - MAX_HAND;
      const response = yield { type: 'discardExcess', playerId, hand: player.hand.map((c) => c.id), count: excess };
      // Le joueur peut défausser plus que le minimum requis s'il le souhaite (jamais moins).
      const ids = (response && response.cardIds) || [];
      ids.forEach((id) => {
        const c = discardCard(state, player, id);
        if (c) log(state, `${player.name} défausse ${c.label} (excédent de main).`);
      });
      while (player.hand.length > MAX_HAND) {
        const c = discardCard(state, player, player.hand[0].id);
        if (c) log(state, `${player.name} défausse ${c.label} (excédent de main, auto).`);
      }
    }
  }

  function advanceToNextPlayer(state) {
    player_loop:
    for (let i = 1; i <= state.players.length; i++) {
      const idx = (state.currentPlayerIndex + i) % state.players.length;
      if (!state.players[idx].eliminated) {
        state.currentPlayerIndex = idx;
        break player_loop;
      }
    }
    state.turnNumber += 1;
    const player = getPlayer(state, state.players[state.currentPlayerIndex].id);
    player.blockDefensifThisTurn = false;
    resetTurnBudget(state);
  }

  function endGame(state) {
    state.phase = 'ended';
    state.finalScores = computeFinalScores(state);
    const max = Math.max(...state.finalScores.map((s) => s.total));
    state.winners = state.finalScores.filter((s) => s.total === max).map((s) => s.playerId);
    log(state, `Partie terminée ! Score maximum : ${max}.`);
  }

  function evaluateSecret(state, player) {
    switch (player.secret) {
      case 'survivant':
        return !player.eliminated;
      case 'bastion':
        return !player.eliminated && state.players.every((o) => o.id === player.id || player.pv > o.pv);
      case 'semeur':
        return player.stats.catastrophesPlayed >= 3;
      case 'traqueur':
        return player.stats.sabotageTargets.size >= 3;
      case 'vautour':
        return !!(player.stats.vautour && player.stats.vautour.achieved.size >= 4);
      case 'bienfaiteur':
        return player.stats.entraideOnOthers >= 3;
      case 'collectionneur':
        return player.stats.collectionneurAchieved;
      case 'resilient':
        return player.stats.minPvEver >= 5;
      case 'insaisissable':
        // Tolère jusqu'à 2 Sabotages subis : avec un paquet Sabotage conséquent cyclant
        // sur ~70-120 tours, "jamais aucune fois" s'est avéré presque toujours impossible
        // en simulation, surtout à 2-3 joueurs où toute la pression se concentre sur un
        // seul adversaire.
        return player.stats.sabotagedCount <= 2;
      default:
        return false;
    }
  }

  function computeFinalScores(state) {
    return state.players.map((player) => {
      const aliveBonus = player.eliminated ? 0 : 5;
      const pvBonus = player.eliminated ? 0 : player.pv;
      const secretDone = !player.secretCancelled && evaluateSecret(state, player);
      const secretBonus = secretDone ? 5 : 0;
      const resourceCards = player.hand.filter((c) => c.category === 'Ressource').length;
      const total = aliveBonus + pvBonus + secretBonus + resourceCards + player.bonusScore;
      return {
        playerId: player.id,
        name: player.name,
        aliveBonus,
        pvBonus,
        secretBonus,
        secretDone,
        resourceCards,
        verdictBonus: player.bonusScore,
        total,
      };
    });
  }

  const Engine = {
    MAX_END_COUNTER, MAX_HAND, TURN_BUDGET,
    initGame, activePlayers, getPlayer, cibleLabel, secretLabel,
    canPlayCategory, playResourceCard, playOffensiveCard, playSabotageCard,
    resolveForcedDiscard, resolveDetournementSteal, playCatastropheCard, usableDefenseCards,
    normalEndOfTurn, advanceToNextPlayer,
    evaluateSecret, computeFinalScores, endGame, log, drawOne, drawN,
  };

  if (typeof module !== 'undefined') {
    module.exports = Engine;
  } else {
    root.CatastropheEngine = Engine;
  }
})(typeof window !== 'undefined' ? window : global);
