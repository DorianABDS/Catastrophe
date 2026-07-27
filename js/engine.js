// engine.js — moteur de règles, sans dépendance DOM.
// Les flux de jeu complexes (réactions défensives, butin de kill) sont des fonctions génératrices :
// elles `yield` une description d'interaction requise et reprennent avec la réponse fournie
// via gen.next(response). L'UI pilote la boucle (voir ui.js / runFlow).

(function (root) {
  const D = (typeof module !== 'undefined') ? require('./data.js') : root.CatastropheData;
  const {
    CATASTROPHE_KINDS, SPECIFIC_DEFENSE, ARCHETYPE_BY_CATASTROPHE, SECRETS,
    buildMainDeck, buildPresageDeck, buildSecretDeck, shuffle,
  } = D;

  const MAX_END_COUNTER = 8;
  const MAX_HAND = 5;
  const TURN_BUDGET = 4;
  const KILL_BONUS = 3;
  // Podium de survie : le score ne dépend plus des PV en continu (un survivant à 14 PV
  // n'écrase plus un survivant à 2 PV), mais une bonne santé finale reste récompensée
  // par palier plutôt qu'à l'unité de PV près.
  const SURVIVAL_TIERS = [
    { max: 5, bonus: 2 },   // in extremis
    { max: 10, bonus: 4 },  // stable
    { max: Infinity, bonus: 6 }, // en pleine forme
  ];

  function survivalTierBonus(pv) {
    return SURVIVAL_TIERS.find((t) => pv <= t.max).bonus;
  }

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
    const secretDeck = shuffle(buildSecretDeck(), rand);

    const state = {
      players: [],
      mainDeck,
      discardPile: [],
      presage: { force: null, weakness: null },
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
      const secret = secretDeck[idx];
      const player = {
        id: 'p' + idx,
        name: cfg.name,
        isAI: !!cfg.isAI,
        pv: 15,
        maxPv: 15,
        hand: [],
        secret: secret.kind,
        eliminated: false,
        eliminatedTurn: null,
        bonusScore: 0,
        skipNextDraw: false,
        blockDefensifThisTurn: false,
        blockRessourceNextTurn: false,
        autoShieldPending: false,
        autoShieldUsed: false,
        stats: {
          catastrophesPlayed: 0,
          sabotageTargets: new Set(),
          sabotagePlaysTotal: 0,
          entraideOnOthers: 0,
          sabotagedEver: false,
          sabotagedCount: 0,
          collectionneurAchieved: false,
          defensifBlocks: 0,
          eliminationsCaused: 0,
        },
      };
      state.players.push(player);
    });

    // Main de départ : 3 cartes
    state.players.forEach((p) => {
      for (let i = 0; i < 3; i++) drawOne(state, p);
    });

    resetTurnBudget(state);
    return state;
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
    // Assoupli du trio complet (Renfort+Provisions+Entraide, ~7% de réussite en simulation,
    // beaucoup trop rare) à la paire Provisions+Entraide : les 2 types de Ressource les
    // moins nombreux dans le paquet (8 chacun contre 12 pour Renfort), ce qui garde une
    // vraie difficulté tout en ramenant le taux de réussite dans la même fourchette que
    // les autres secrets (~20% tous effectifs confondus, vérifié en simulation).
    if (has('provisions') && has('entraide')) {
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

  // Bouclier de détresse : gratuit, sans carte, une seule fois par partie. La 1ère fois
  // qu'un joueur passe à 5 PV ou moins, il bloque automatiquement la prochaine attaque
  // qu'il subit (le coup qui l'a fait passer sous ce seuil n'est PAS concerné — seulement
  // le suivant). `opts.unblockable` permet à Amputation de rester la seule attaque
  // totalement imparable. Retourne false si les dégâts ont été bloqués par le bouclier.
  function changePv(state, player, delta, opts) {
    const unblockable = opts && opts.unblockable;
    if (!unblockable && delta < 0 && player.autoShieldPending) {
      player.autoShieldPending = false;
      player.autoShieldUsed = true;
      return false;
    }
    player.pv = Math.max(0, Math.min(player.maxPv, player.pv + delta));
    checkElimination(state, player);
    if (!player.autoShieldUsed && !player.autoShieldPending && player.pv > 0 && player.pv <= 5) {
      player.autoShieldPending = true;
    }
    return true;
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

    if (card.kind === 'sursis' && player.pv > card.requiresLowPv) {
      return { ok: false, reason: `Sursis n'est jouable qu'à ${card.requiresLowPv} PV ou moins.` };
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
      case 'sursis':
        changePv(state, player, card.amount);
        log(state, `${player.name} joue Sursis (+${card.amount} PV).`);
        break;
      default:
        break;
    }
    return { ok: true };
  }

  // ---------- Défense réactive (générateur) ----------

  // Kit de secours annule totalement les dégâts de ces 3 cartes Offensif (jamais les
  // Catastrophes, ni Amputation, ni Réchauffement) : ça lui donne un rôle propre et
  // distinct des contres Défensif spécifiques (qui ne visent que les Catastrophes).
  const KIT_SECOURS_BLOCKS = ['machette', 'pioche_secours', 'contamination'];

  function usableDefenseCards(player, context) {
    // context: {kind:'catastrophe'|'offensif', catastropheKind, offensifKind}
    if (player.blockDefensifThisTurn) return [];
    return player.hand.filter((c) => {
      if (c.category !== 'Defensif') return false;
      if (c.kind === 'kit_secours') {
        return context.kind === 'offensif' && KIT_SECOURS_BLOCKS.includes(context.offensifKind);
      }
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
        const applied = dmg > 0 ? changePv(state, p, -dmg) : true;
        const blockedAuto = !defenseUsed && !applied;
        log(state, `${p.name} ${defenseUsed ? 'bloque avec ' + defenseUsed.label : (blockedAuto ? 'bloque automatiquement l\'attaque' : `perd ${dmg} PV`)} (Réchauffement).`);
        if (p.eliminated && p.eliminatedTurn === state.turnNumber) {
          yield* handleKill(state, actorId, p.id);
        }
      }
      checkEndConditions(state);
      return;
    }

    const { defenseUsed } = yield* reactToDamage(state, targetId, { kind: 'offensif', offensifKind: card.kind });

    if (card.kind === 'machette') {
      const dmg = defenseUsed ? 0 : 2;
      const applied = dmg > 0 ? changePv(state, target, -dmg) : true;
      const blockedAuto = !defenseUsed && !applied;
      log(state, `${target.name} ${defenseUsed ? 'bloque avec ' + defenseUsed.label : (blockedAuto ? 'bloque automatiquement l\'attaque' : `perd ${dmg} PV`)}.`);
    } else if (card.kind === 'pioche_secours') {
      const dmg = defenseUsed ? 0 : 1;
      const applied = dmg > 0 ? changePv(state, target, -dmg) : true;
      const blockedAuto = !defenseUsed && !applied;
      const resCards = target.hand.filter((c) => c.category === 'Ressource');
      let stolen = null;
      if (resCards.length > 0) {
        stolen = resCards[Math.floor(Math.random() * resCards.length)];
        target.hand = target.hand.filter((c) => c.id !== stolen.id);
        actor.hand.push(stolen);
        noteCollectionneurProgress(actor);
      }
      log(state, `${target.name} ${defenseUsed ? 'bloque les dégâts avec ' + defenseUsed.label : (blockedAuto ? 'bloque automatiquement l\'attaque' : `perd ${dmg} PV`)}${stolen ? ` et se fait voler ${stolen.label}` : ''}.`);
    } else if (card.kind === 'contamination') {
      const stolen = defenseUsed ? 0 : 1;
      let applied = true;
      if (stolen > 0) {
        applied = changePv(state, target, -stolen);
        if (applied) changePv(state, actor, stolen);
      }
      const blockedAuto = !defenseUsed && stolen > 0 && !applied;
      log(state, `${target.name} ${defenseUsed ? 'bloque la Contamination' : (blockedAuto ? 'bloque automatiquement la Contamination' : `perd 1 PV, volé par ${actor.name}`)}.`);
    } else if (card.kind === 'amputation') {
      changePv(state, target, -2, { unblockable: true });
      log(state, `${target.name} subit 2 dégâts d'Amputation (non bloquables).`);
    }
    if (target.eliminated && target.eliminatedTurn === state.turnNumber) {
      yield* handleKill(state, actorId, target.id);
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
    actor.stats.sabotagePlaysTotal += 1;
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
      case 'detournement':
        return { ok: true, needsStealChoice: true, card, actor, target };
      default:
        break;
    }
    return { ok: true };
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

  // Éliminer un adversaire (Offensif ou Catastrophe) rapporte un bonus de points et permet
  // de récupérer une carte de son choix dans la main de la victime (générateur : yield
  // 'chooseKillLoot' si la victime a encore des cartes en main).
  function* handleKill(state, actorId, victimId) {
    const actor = getPlayer(state, actorId);
    const victim = getPlayer(state, victimId);
    actor.stats.eliminationsCaused += 1;
    actor.bonusScore += KILL_BONUS;
    log(state, `${actor.name} a éliminé ${victim.name} : +${KILL_BONUS} points.`);
    if (victim.hand.length > 0) {
      const response = yield { type: 'chooseKillLoot', actorId, victimId, options: victim.hand.map((c) => c.id) };
      const cardId = response && response.cardId;
      const idx = cardId ? victim.hand.findIndex((c) => c.id === cardId) : -1;
      if (idx !== -1) {
        const [card] = victim.hand.splice(idx, 1);
        actor.hand.push(card);
        noteCollectionneurProgress(actor);
        log(state, `${actor.name} récupère ${card.label} sur la dépouille de ${victim.name}.`);
      }
    }
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
      if (defenseUsed) victim.stats.defensifBlocks += 1;
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
      } else {
        finalDamage = baseDamage;
      }

      let blockedAuto = false;
      if (finalDamage > 0) {
        const applied = changePv(state, victim, -finalDamage);
        if (!applied) {
          blockedAuto = true;
          fullyCancelled = true;
          finalDamage = 0;
        }
      }
      if (bonus > 0) changePv(state, victim, bonus);

      const defenseNote = defenseUsed ? `se défend avec ${defenseUsed.label} — ` : (blockedAuto ? 'bloque automatiquement l\'attaque (instinct de survie) — ' : '');
      log(state, `${victim.name} ${defenseNote}subit ${finalDamage} dégât(s)${bonus ? ` et regagne ${bonus} PV` : ''}.`);

      if (!fullyCancelled) {
        applyArchetype(state, victim, archetype);
      }

      if (victim.eliminated && victim.eliminatedTurn === state.turnNumber) {
        eliminatedThisResolution.push(victim);
      }
    }

    state.endCounter = Math.min(MAX_END_COUNTER, state.endCounter + 1);
    log(state, `Compteur de fin de partie : ${state.endCounter}/${MAX_END_COUNTER}.`);

    // Butin + bonus de kill
    for (const victim of eliminatedThisResolution) {
      yield* handleKill(state, actorId, victim.id);
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
        checkElimination(state, victim);
        log(state, `${victim.name} subit une cicatrice permanente : PV max = ${victim.maxPv} (Volcan).`);
        applied = true;
        break;
      default:
        break;
    }
    if (!applied) {
      const dmgApplied = changePv(state, victim, -1);
      log(state, dmgApplied
        ? `${victim.name} ne peut pas subir l'archétype secondaire : -1 PV supplémentaire.`
        : `${victim.name} bloque automatiquement ce dégât supplémentaire (instinct de survie).`);
    }
  }

  // ---------- Fin de tour (générateur) ----------

  function* normalEndOfTurn(state, playerId) {
    const player = getPlayer(state, playerId);
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
    // Un joueur éliminé ne peut plus remporter la partie : seuls les survivants sont
    // éligibles à la victoire (sauf si, cas limite, plus personne n'est vivant).
    const aliveScores = state.finalScores.filter((s) => s.alive);
    const pool = aliveScores.length > 0 ? aliveScores : state.finalScores;
    const max = Math.max(...pool.map((s) => s.total));
    state.winners = pool.filter((s) => s.total === max).map((s) => s.playerId);
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
      case 'traqueur': {
        // Le nombre d'adversaires distincts requis s'adapte à l'effectif : "3 adversaires
        // différents" était mathématiquement impossible à 2-3 joueurs (moins de 3 rivaux
        // en jeu). On exige aussi un minimum de Sabotage joués pour garder une vraie
        // difficulté à faible effectif plutôt qu'une réussite triviale au 1er Sabotage.
        const requiredTargets = Math.min(3, state.players.length - 1);
        return player.stats.sabotageTargets.size >= requiredTargets && player.stats.sabotagePlaysTotal >= 3;
      }
      case 'fossoyeur': {
        // À 2 joueurs, "causer 2 éliminations" est impossible (un seul adversaire à
        // éliminer, et la partie s'arrête dès qu'il ne reste qu'un survivant) : le
        // nombre requis s'adapte donc à l'effectif, comme pour Le Traqueur.
        const requiredKills = Math.min(2, state.players.length - 1);
        return player.stats.eliminationsCaused >= requiredKills;
      }
      case 'bienfaiteur':
        return player.stats.entraideOnOthers >= 2;
      case 'collectionneur':
        return player.stats.collectionneurAchieved;
      case 'bouclier':
        return player.stats.defensifBlocks >= 3;
      case 'insaisissable': {
        // Tolérance qui décroît avec le nombre de joueurs : à faible effectif, toute la
        // pression Sabotage se concentre sur un seul adversaire (un seuil fixe rendait le
        // secret quasi impossible à 2 joueurs et quasi automatique à 8).
        const tolerance = Math.max(1, 6 - state.players.length);
        return player.stats.sabotagedCount <= tolerance;
      }
      default:
        return false;
    }
  }

  // Score final = PV restants (0 si éliminé) + secret rempli + bonus de kill.
  // Ni le simple fait d'être vivant, ni les cartes Ressource non jouées, ne rapportent
  // de points en soi : les PV restants reflètent déjà combien on a survécu.
  function computeFinalScores(state) {
    return state.players.map((player) => {
      const survivalBonus = player.eliminated ? 0 : survivalTierBonus(player.pv);
      const secretDone = evaluateSecret(state, player);
      const secretBonus = secretDone ? 5 : 0;
      const total = survivalBonus + secretBonus + player.bonusScore;
      return {
        playerId: player.id,
        name: player.name,
        alive: !player.eliminated,
        survivalBonus,
        secretBonus,
        secretDone,
        killBonus: player.bonusScore,
        total,
      };
    });
  }

  const Engine = {
    MAX_END_COUNTER, MAX_HAND, TURN_BUDGET,
    initGame, activePlayers, getPlayer, secretLabel,
    canPlayCategory, playResourceCard, playOffensiveCard, playSabotageCard,
    resolveDetournementSteal, playCatastropheCard, usableDefenseCards,
    normalEndOfTurn, advanceToNextPlayer,
    evaluateSecret, computeFinalScores, endGame, log, drawOne, drawN,
  };

  if (typeof module !== 'undefined') {
    module.exports = Engine;
  } else {
    root.CatastropheEngine = Engine;
  }
})(typeof window !== 'undefined' ? window : global);
