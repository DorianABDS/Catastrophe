// ui.js — interface DOM, orchestration des tours et des interactions (pilote les générateurs du moteur)
(function () {
  const Engine = window.CatastropheEngine;
  const AI = window.CatastropheAI;
  const SECRETS = window.CatastropheData.SECRETS;

  const CARD_DESC = {
    renfort: '+1 PV',
    provisions: '+2 PV',
    entraide: '+1 PV à un autre joueur (jamais à soi-même)',
    ravitaillement: 'Piocher 2 cartes',
    provisions_urgence: 'Piocher 3 cartes',
    digue: 'Annule les dégâts d\'un Tsunami',
    abri: 'Annule les dégâts d\'un Séisme',
    plan_evacuation: 'Annule les dégâts d\'un Volcan',
    reserve_eau: 'Annule les dégâts d\'une Sécheresse',
    kit_secours: 'Réduit les dégâts de 1 (sauf Amputation)',
    pillage: 'Vole 1 carte au hasard à un adversaire',
    panique: 'La cible choisit et défausse une carte de sa main (perdue)',
    coupure: 'L\'adversaire ne pioche pas au prochain tour',
    detournement: 'Vous choisissez et volez une carte dans la main de la cible',
    machette: '1 dégât direct',
    pioche_secours: '1 dégât + vole 1 carte Ressource',
    contamination: 'Vole 1 PV (vous le gagnez)',
    amputation: '2 dégâts, ignore le Kit de secours',
    rechauffement: 'Tous les autres joueurs perdent 1 PV',
    volcan: 'Catastrophe : dégâts à tous les autres + cicatrice — bloque Sabotage/Offensif ce tour',
    tsunami: 'Catastrophe : dégâts à tous les autres + blocage Défensif — bloque Sabotage/Offensif ce tour',
    seisme: 'Catastrophe : dégâts à tous les autres + perte de carte — bloque Sabotage/Offensif ce tour',
    secheresse: 'Catastrophe : dégâts à tous les autres + blocage Ressource — bloque Sabotage/Offensif ce tour',
  };

  let STATE = null;
  let screenOwnerId = null; // qui est actuellement affiché à l'écran (pour gérer le pass-and-play)

  // ---------- Mode session (plusieurs parties, score cumulé) ----------

  const SESSION_TARGET_BY_COUNT = { 2: 40, 3: 35, 4: 35, 5: 30, 6: 30, 7: 25, 8: 25 };
  let SESSION = null; // { active, target, round, configs, cumulative: [{name, isAI, total}] }

  const el = (id) => document.getElementById(id);

  // ---------- Setup screen ----------

  function renderPlayerConfigRows() {
    const count = parseInt(el('player-count').value, 10);
    const container = el('player-config-list');
    const existing = container.querySelectorAll('.player-config-row');
    const prevValues = Array.from(existing).map((row) => ({
      name: row.querySelector('input').value,
      isAI: row.querySelector('select').value === 'ai',
    }));
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const prev = prevValues[i];
      const row = document.createElement('div');
      row.className = 'player-config-row';
      row.innerHTML = `
        <input type="text" value="${prev ? prev.name : 'Joueur ' + (i + 1)}" placeholder="Nom">
        <select>
          <option value="human" ${!prev || !prev.isAI ? 'selected' : ''}>Humain</option>
          <option value="ai" ${prev && prev.isAI ? 'selected' : ''}>IA</option>
        </select>
      `;
      container.appendChild(row);
    }
  }

  function collectPlayerConfigs() {
    const rows = document.querySelectorAll('.player-config-row');
    return Array.from(rows).map((row, i) => ({
      name: row.querySelector('input').value.trim() || ('Joueur ' + (i + 1)),
      isAI: row.querySelector('select').value === 'ai',
    }));
  }

  function showScreen(id) {
    ['screen-setup', 'screen-gate', 'screen-game', 'screen-end'].forEach((s) => {
      el(s).classList.toggle('hidden', s !== id);
    });
  }

  // ---------- Gate (pass device) ----------

  function gate(player, subtitle) {
    return new Promise((resolve) => {
      if (!player.isAI && screenOwnerId === player.id) { resolve(); return; }
      if (player.isAI) { screenOwnerId = player.id; resolve(); return; }
      el('gate-title').textContent = `Passez l'appareil à ${player.name}`;
      el('gate-subtitle').textContent = subtitle || 'Cliquez quand vous êtes prêt à voir votre main.';
      showScreen('screen-gate');
      const btn = el('btn-gate-continue');
      const handler = () => {
        btn.removeEventListener('click', handler);
        screenOwnerId = player.id;
        showScreen('screen-game');
        resolve();
      };
      btn.addEventListener('click', handler);
    });
  }

  // ---------- Modal helper ----------

  function closeModal() {
    el('modal-overlay').classList.add('hidden');
    el('modal-box').innerHTML = '';
  }

  function openModal(html) {
    el('modal-box').innerHTML = html;
    el('modal-overlay').classList.remove('hidden');
  }

  // ---------- Rendering: top bar & player strip ----------

  function render() {
    if (!STATE) return;
    renderTopbar();
    renderPlayersStrip();
    renderLog();
  }

  function renderTopbar() {
    const presage = el('presage-box');
    presage.innerHTML = `<strong>Le Présage</strong><br>
      Force : ${Engine.getPlayer ? '' : ''}${CatastropheData.CATASTROPHE_LABELS[STATE.presage.force]} (4 dégâts, jamais annulée à 100%)<br>
      Faiblesse : ${CatastropheData.CATASTROPHE_LABELS[STATE.presage.weakness]} (2 dégâts, annulable + bonus)`;

    const counter = el('counter-box');
    let dots = '';
    for (let i = 0; i < Engine.MAX_END_COUNTER; i++) {
      dots += `<div class="counter-dot ${i < STATE.endCounter ? 'filled' : ''}"></div>`;
    }
    counter.innerHTML = `<strong>Compteur de fin de partie : ${STATE.endCounter} / ${Engine.MAX_END_COUNTER}</strong>
      <div class="counter-track">${dots}</div>`;
  }

  function renderPlayersStrip() {
    const strip = el('players-strip');
    strip.innerHTML = '';
    STATE.players.forEach((p) => {
      const tile = document.createElement('div');
      tile.className = 'player-tile' + (p.eliminated ? ' eliminated' : '') + (p.id === STATE.players[STATE.currentPlayerIndex].id ? ' active' : '');
      const pct = Math.round((p.pv / p.maxPv) * 100);
      const barClass = pct <= 30 ? 'low' : (pct <= 60 ? 'mid' : '');
      tile.innerHTML = `
        <div class="name">
          <span>${p.name}${p.isAI ? ' <span class="ai-tag">(IA)</span>' : ''}</span>
        </div>
        <div class="hp-bar-track"><div class="hp-bar-fill ${barClass}" style="width:${pct}%"></div></div>
        <div class="hp-text">${p.pv} / ${p.maxPv} PV${p.eliminated ? ' — éliminé' : ''}</div>
        <div class="hand-count">🂠 ${p.hand.length} carte${p.hand.length > 1 ? 's' : ''} en main</div>
      `;
      strip.appendChild(tile);
    });
  }

  function renderLog() {
    const list = el('log-list');
    list.innerHTML = '';
    STATE.log.slice(-40).reverse().forEach((entry) => {
      const li = document.createElement('li');
      li.textContent = `[T${entry.turn}] ${entry.message}`;
      if (entry.turn === STATE.turnNumber) li.classList.add('log-current-turn');
      list.appendChild(li);
    });
  }

  // Compte les exemplaires de chaque sorte de carte dans une liste (pour le badge de doublon)
  function countByKind(cards) {
    const counts = {};
    cards.forEach((c) => { counts[c.kind] = (counts[c.kind] || 0) + 1; });
    return counts;
  }

  function cardHtml(card, extra) {
    const count = extra && extra.count;
    const dupBadge = count > 1 ? `<span class="dup-badge">×${count}</span>` : '';
    return `
      <div class="card cat-${card.category} ${extra && extra.disabled ? 'disabled' : ''}" data-card-id="${card.id}">
        <div class="cat-tag">${card.category}</div>
        <div class="card-label">${card.label} ${dupBadge}</div>
        <div class="card-desc">${CARD_DESC[card.kind] || ''}</div>
      </div>
    `;
  }

  // ---------- Generator driver ----------

  async function driveGen(gen) {
    let res = gen.next();
    while (!res.done) {
      const inter = res.value;
      let response;
      if (inter.type === 'chooseDefense') {
        response = await handleChooseDefense(inter);
      } else if (inter.type === 'verdict') {
        response = await handleVerdict(inter);
      } else if (inter.type === 'discardExcess') {
        response = await handleDiscardExcess(inter);
      } else if (inter.type === 'chooseKillLoot') {
        response = await handleKillLoot(inter);
      } else if (inter.type === 'log') {
        render();
      }
      res = gen.next(response);
    }
    render();
    return res.value;
  }

  async function handleChooseDefense(inter) {
    const player = Engine.getPlayer(STATE, inter.playerId);
    if (player.isAI) {
      return { cardId: AI.aiChooseDefense(STATE, player, inter.options, inter.context) };
    }
    await gate(player, 'Vous êtes visé par une attaque ou une catastrophe : venez décider de votre défense.');
    render();
    return new Promise((resolve) => {
      const cards = inter.options.map((id) => player.hand.find((c) => c.id === id));
      const cardCounts = countByKind(cards);
      const kindLabel = inter.context.kind === 'catastrophe' ? CatastropheData.CATASTROPHE_LABELS[inter.context.catastropheKind] : inter.context.offensifKind;
      openModal(`
        <h2>Réaction défensive</h2>
        <p>${player.name}, vous êtes touché par : <strong>${kindLabel}</strong>. Jouer une carte Défensif ?</p>
        <div class="option-list">
          ${cards.map((c) => `<div class="option-item" data-id="${c.id}"><strong>${c.label}</strong>${cardCounts[c.kind] > 1 ? ` <span class="dup-badge">×${cardCounts[c.kind]}</span>` : ''}<br><small>${CARD_DESC[c.kind]}</small></div>`).join('')}
          <div class="option-item" data-id="">Ne pas se défendre</div>
        </div>
      `);
      el('modal-box').querySelectorAll('.option-item').forEach((item) => {
        item.addEventListener('click', () => {
          const id = item.getAttribute('data-id');
          closeModal();
          resolve({ cardId: id || null });
        });
      });
    });
  }

  async function handleVerdict(inter) {
    const guesser = Engine.getPlayer(STATE, inter.catastropherId);
    const victim = Engine.getPlayer(STATE, inter.victimId);
    if (guesser.isAI) {
      return { guess: AI.aiVerdictGuess(STATE, victim.id, guesser.id) };
    }
    await gate(guesser, `${victim.name} a été éliminé par votre Catastrophe : tentez de deviner son secret.`);
    render();
    return new Promise((resolve) => {
      const revealed = new Set(STATE.players.filter((p) => p.secretRevealed).map((p) => p.secret));
      revealed.add(guesser.secret);
      openModal(`
        <h2>Le Verdict</h2>
        <p>${guesser.name}, ${victim.name} a été éliminé. Deviner son secret rapporte +10 points (bonne réponse) ou -5 (mauvaise). Vous pouvez aussi ne rien tenter.</p>
        <p style="font-size:12px; color: var(--text-dim, #9aa5b3);">Les secrets déjà révélés ou identiques au vôtre sont grisés : ce ne peut pas être celui de ${victim.name} (chaque secret n'existe qu'en un seul exemplaire).</p>
        <div class="option-list">
          ${SECRETS.map((s) => `<div class="option-item${revealed.has(s.id) ? ' disabled' : ''}" data-id="${s.id}"><strong>${s.label}</strong><br><small>${s.desc}</small></div>`).join('')}
          <div class="option-item" data-id="">Ne rien tenter</div>
        </div>
      `);
      el('modal-box').querySelectorAll('.option-item').forEach((item) => {
        if (item.classList.contains('disabled')) return;
        item.addEventListener('click', () => {
          const id = item.getAttribute('data-id');
          closeModal();
          resolve({ guess: id || null });
        });
      });
    });
  }

  async function handleDiscardExcess(inter) {
    const player = Engine.getPlayer(STATE, inter.playerId);
    if (player.isAI) {
      return { cardIds: AI.aiChooseExcessDiscard(player, inter.count) };
    }
    await gate(player, `Votre main dépasse 5 cartes : défaussez au moins ${inter.count} carte(s).`);
    render();
    return new Promise((resolve) => {
      const selected = new Set();
      const renderModal = () => {
        openModal(`
          <h2>Défausse d'excédent</h2>
          <p>Choisissez au moins ${inter.count} carte(s) à défausser (${selected.size}/${player.hand.length} sélectionnée(s)). Vous pouvez en défausser plus si vous le souhaitez.</p>
          <div class="hand-row">${(() => { const counts = countByKind(player.hand); return player.hand.map((c) => cardHtml(c, { count: counts[c.kind] })).join(''); })()}</div>
          <button id="btn-confirm-discard" class="btn btn-primary" ${selected.size >= inter.count ? '' : 'disabled'}>Confirmer</button>
        `);
        el('modal-box').querySelectorAll('.card').forEach((cardEl) => {
          const id = cardEl.getAttribute('data-card-id');
          if (selected.has(id)) cardEl.style.outline = '3px solid var(--accent)';
          cardEl.addEventListener('click', () => {
            if (selected.has(id)) selected.delete(id);
            else selected.add(id);
            renderModal();
          });
        });
        const btn = document.getElementById('btn-confirm-discard');
        if (btn) {
          btn.addEventListener('click', () => {
            closeModal();
            resolve({ cardIds: Array.from(selected) });
          });
        }
      };
      renderModal();
    });
  }

  async function handleForcedDiscardChoice(target) {
    if (target.isAI) {
      return AI.aiChooseDiscard(target);
    }
    await gate(target, 'On vous force à défausser une carte de votre choix.');
    render();
    return new Promise((resolve) => {
      openModal(`
        <h2>Défausse forcée (Panique)</h2>
        <p>${target.name}, choisissez la carte à défausser.</p>
        <div class="hand-row">${(() => { const counts = countByKind(target.hand); return target.hand.map((c) => cardHtml(c, { count: counts[c.kind] })).join(''); })()}</div>
      `);
      el('modal-box').querySelectorAll('.card').forEach((cardEl) => {
        cardEl.addEventListener('click', () => {
          const id = cardEl.getAttribute('data-card-id');
          closeModal();
          resolve(id);
        });
      });
    });
  }

  // Détournement : c'est l'ACTEUR (celui qui a joué la carte), pas la cible, qui choisit
  // quelle carte voler dans la main de la cible — il faut donc la lui montrer.
  async function handleDetournementSteal(actor, target) {
    if (actor.isAI) {
      return AI.aiChooseSteal(target);
    }
    // Pas de gate() : c'est déjà le tour de l'acteur, l'écran lui appartient.
    render();
    return new Promise((resolve) => {
      openModal(`
        <h2>Détournement</h2>
        <p>${actor.name}, choisissez la carte à voler dans la main de ${target.name}.</p>
        <div class="hand-row">${(() => { const counts = countByKind(target.hand); return target.hand.map((c) => cardHtml(c, { count: counts[c.kind] })).join(''); })()}</div>
      `);
      el('modal-box').querySelectorAll('.card').forEach((cardEl) => {
        cardEl.addEventListener('click', () => {
          const id = cardEl.getAttribute('data-card-id');
          closeModal();
          resolve(id);
        });
      });
    });
  }

  // Kill loot : quand une élimination est causée par Offensif ou Catastrophe, l'auteur du
  // coup fatal choisit une carte à récupérer dans la main de la victime (s'il en reste).
  async function handleKillLoot(inter) {
    const actor = Engine.getPlayer(STATE, inter.actorId);
    const victim = Engine.getPlayer(STATE, inter.victimId);
    if (actor.isAI) {
      return { cardId: AI.aiChooseSteal(victim) };
    }
    render();
    return new Promise((resolve) => {
      openModal(`
        <h2>Butin</h2>
        <p>${actor.name}, vous avez éliminé ${victim.name}. Choisissez une carte à récupérer sur sa dépouille.</p>
        <div class="hand-row">${(() => { const counts = countByKind(victim.hand); return victim.hand.map((c) => cardHtml(c, { count: counts[c.kind] })).join(''); })()}</div>
      `);
      el('modal-box').querySelectorAll('.card').forEach((cardEl) => {
        cardEl.addEventListener('click', () => {
          const id = cardEl.getAttribute('data-card-id');
          closeModal();
          resolve({ cardId: id });
        });
      });
    });
  }

  // ---------- Turn panel: human ----------

  function budgetSummary() {
    const b = STATE.turnBudget;
    return `Cartes jouées ce tour : ${b.totalPlays} / ${Engine.TURN_BUDGET} — Types utilisés : ${Array.from(b.usedTypes).join(', ') || 'aucun'}${b.sabotageTargets.size ? ' — Sabotage visé : ' + b.sabotageTargets.size : ''}${b.catastrophePlayed ? ' — Catastrophe jouée : Sabotage et Offensif indisponibles ce tour' : ''}`;
  }

  function runHumanTurn(player) {
    return new Promise((resolve) => {
      let pendingTargetCard = null; // card awaiting target selection

      const finishTurn = () => {
        panel.querySelectorAll('button, .card, .target-chip').forEach((n) => n.replaceWith(n.cloneNode(true)));
        resolve();
      };

      const panel = el('turn-panel');

      const draw = () => {
        panel.innerHTML = '';
        const budgetLine = document.createElement('div');
        budgetLine.className = 'budget-line';
        budgetLine.textContent = budgetSummary();
        panel.appendChild(budgetLine);

        const title = document.createElement('h2');
        title.textContent = `Tour de ${player.name}`;
        panel.appendChild(title);

        const secretBox = document.createElement('div');
        secretBox.className = 'own-secret-box';
        const secretInfo = CatastropheData.SECRETS.find((s) => s.id === player.secret);
        secretBox.innerHTML = `Votre secret : <strong>${secretInfo.label}</strong><br><span class="own-secret-desc">${secretInfo.desc}</span>`;
        panel.appendChild(secretBox);

        if (pendingTargetCard) {
          renderTargetPicker();
          return;
        }

        const handTitle = document.createElement('div');
        handTitle.className = 'section-title';
        handTitle.textContent = 'Votre main (cliquez pour jouer)';
        panel.appendChild(handTitle);

        const handRow = document.createElement('div');
        handRow.className = 'hand-row';
        const handKindCounts = countByKind(player.hand);
        player.hand.forEach((card) => {
          const playable = isPlayableNow(card);
          const wrapper = document.createElement('div');
          wrapper.innerHTML = cardHtml(card, { disabled: !playable.ok, count: handKindCounts[card.kind] });
          const cardEl = wrapper.firstElementChild;
          if (playable.ok) {
            cardEl.title = 'Jouer cette carte';
            cardEl.addEventListener('click', () => onCardClick(card));
          } else {
            cardEl.title = playable.reason;
          }
          handRow.appendChild(cardEl);
        });
        panel.appendChild(handRow);

        const endBtn = document.createElement('button');
        endBtn.className = 'btn btn-primary btn-block';
        endBtn.textContent = 'Terminer le tour';
        endBtn.addEventListener('click', finishTurn);
        panel.appendChild(endBtn);
      };

      function isPlayableNow(card) {
        if (card.category === 'Defensif') {
          return { ok: false, reason: 'Non jouable depuis la main : uniquement en réaction à une attaque.' };
        }
        if (card.category === 'Ressource' && player.blockRessourceNextTurn) {
          return { ok: false, reason: 'Sécheresse : Ressource interdite ce tour.' };
        }
        if (card.category === 'Ressource' && card.kind === 'entraide' && Engine.activePlayers(STATE).filter((p) => p.id !== player.id).length === 0) {
          return { ok: false, reason: 'Aucun autre joueur actif à qui venir en aide.' };
        }
        return Engine.canPlayCategory(STATE, card.category);
      }

      async function onCardClick(card) {
        if (card.category === 'Ressource' && card.kind === 'entraide') {
          pendingTargetCard = card;
          draw();
          return;
        }
        if (card.category === 'Ressource') {
          const r = Engine.playResourceCard(STATE, player.id, card.id);
          if (!r.ok) alert(r.reason);
          render();
          draw();
          return;
        }
        if (card.category === 'Catastrophe') {
          await driveGen(Engine.playCatastropheCard(STATE, player.id, card.id));
          if (STATE.phase === 'ended') { resolve(); return; }
          render();
          draw();
          return;
        }
        if (card.category === 'Offensif' || card.category === 'Sabotage') {
          pendingTargetCard = card;
          draw();
          return;
        }
      }

      function renderTargetPicker() {
        const card = pendingTargetCard;
        const title = document.createElement('div');
        title.className = 'section-title';
        title.textContent = `Choisissez une cible pour ${card.label}`;
        panel.appendChild(title);

        const row = document.createElement('div');
        row.className = 'target-row';
        const candidates = Engine.activePlayers(STATE).filter((p) => p.id !== player.id);
        candidates.forEach((p) => {
          const chip = document.createElement('div');
          chip.className = 'target-chip';
          chip.textContent = p.name;
          chip.addEventListener('click', async () => {
            pendingTargetCard = null;
            await onTargetChosen(card, p.id);
            if (STATE.phase === 'ended') { resolve(); return; }
            draw();
          });
          row.appendChild(chip);
        });
        panel.appendChild(row);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'Annuler';
        cancelBtn.addEventListener('click', () => { pendingTargetCard = null; draw(); });
        panel.appendChild(cancelBtn);
      }

      async function onTargetChosen(card, targetId) {
        if (card.category === 'Ressource') {
          const r = Engine.playResourceCard(STATE, player.id, card.id, { targetId });
          if (!r.ok) alert(r.reason);
        } else if (card.category === 'Offensif') {
          await driveGen(Engine.playOffensiveCard(STATE, player.id, card.id, targetId));
        } else if (card.category === 'Sabotage') {
          const r = Engine.playSabotageCard(STATE, player.id, card.id, targetId);
          if (r && r.needsDiscardChoice) {
            const discId = await handleForcedDiscardChoice(r.target);
            if (discId) Engine.resolveForcedDiscard(STATE, r.target.id, discId);
          } else if (r && r.needsStealChoice) {
            const stealId = await handleDetournementSteal(r.actor, r.target);
            if (stealId) Engine.resolveDetournementSteal(STATE, r.actor.id, r.target.id, stealId);
          } else if (!r.ok) {
            alert(r.reason);
          }
        }
        render();
      }

      draw();
    });
  }

  // ---------- Turn panel: AI ----------

  async function runAITurn(player) {
    const panel = el('turn-panel');
    panel.innerHTML = `<h2>Tour de ${player.name} (IA)</h2><p>L'IA réfléchit…</p>`;
    render();

    const plan = AI.aiPlanTurn(STATE, player);

    if (plan.resource) {
      Engine.playResourceCard(STATE, player.id, plan.resource.cardId, plan.resource.opts);
    }
    if (plan.catastrophe && STATE.phase !== 'ended') {
      await driveGen(Engine.playCatastropheCard(STATE, player.id, plan.catastrophe.cardId));
    }
    if (plan.offensive && STATE.phase !== 'ended') {
      await driveGen(Engine.playOffensiveCard(STATE, player.id, plan.offensive.cardId, plan.offensive.targetId));
    }
    for (const sab of plan.sabotages) {
      if (STATE.phase === 'ended') break;
      const r = Engine.playSabotageCard(STATE, player.id, sab.cardId, sab.targetId);
      if (r && r.needsDiscardChoice) {
        const discId = await handleForcedDiscardChoice(r.target);
        if (discId) Engine.resolveForcedDiscard(STATE, r.target.id, discId);
      } else if (r && r.needsStealChoice) {
        const stealId = await handleDetournementSteal(r.actor, r.target);
        if (stealId) Engine.resolveDetournementSteal(STATE, r.actor.id, r.target.id, stealId);
      }
    }
    render();

    if (STATE.phase === 'ended') return;

    panel.innerHTML += `<div class="section-title">Tour terminé</div>`;
    await new Promise((resolve) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = 'Continuer';
      btn.addEventListener('click', () => resolve());
      panel.appendChild(btn);
    });
  }

  // ---------- Main loop ----------

  async function runTurnLoop() {
    while (STATE.phase !== 'ended') {
      const player = STATE.players[STATE.currentPlayerIndex];
      if (player.eliminated) {
        Engine.advanceToNextPlayer(STATE);
        continue;
      }

      await gate(player, 'C\'est à votre tour de jouer.');
      render();

      if (player.isAI) {
        await runAITurn(player);
      } else {
        await runHumanTurn(player);
      }
      if (STATE.phase === 'ended') break;
      await driveGen(Engine.normalEndOfTurn(STATE, player.id));

      if (STATE.phase === 'ended') break;
      Engine.advanceToNextPlayer(STATE);
      render();
    }
    renderEndGame();
  }

  function renderEndGame() {
    showScreen('screen-end');
    const scores = STATE.finalScores.slice().sort((a, b) => b.total - a.total);
    const rows = scores.map((s) => {
      const player = Engine.getPlayer(STATE, s.playerId);
      const isWinner = STATE.winners.includes(s.playerId);
      return `
        <tr class="${isWinner ? 'winner' : ''}">
          <td>${isWinner ? '🏆 ' : ''}${s.name}${s.alive ? '' : ' (éliminé)'}</td>
          <td>${Engine.secretLabel(player.secret)}${player.secretCancelled ? ' (annulé)' : ''}</td>
          <td>${s.pvBonus}</td>
          <td>${s.secretBonus} ${s.secretDone ? '✓' : ''}</td>
          <td>${s.verdictBonus}</td>
          <td><strong>${s.total}</strong></td>
        </tr>
      `;
    }).join('');

    let extraHtml = `<button id="btn-restart" class="btn btn-primary btn-block">Nouvelle partie</button>`;

    if (SESSION && SESSION.active) {
      SESSION.cumulative.forEach((entry) => {
        const s = scores.find((x) => x.name === entry.name);
        if (s) entry.total += s.total;
      });
      const ranked = SESSION.cumulative.slice().sort((a, b) => b.total - a.total);
      const sessionOver = ranked[0].total >= SESSION.target;
      const topScore = ranked[0].total;
      const recapRows = ranked.map((entry) => {
        const isTop = entry.total === topScore;
        return `
          <tr class="${sessionOver && isTop ? 'session-winner' : (isTop ? 'session-leader' : '')}">
            <td>${sessionOver && isTop ? '🏆 ' : ''}${entry.name}${entry.isAI ? ' <span class="ai-tag">(IA)</span>' : ''}</td>
            <td><strong>${entry.total}</strong> / ${SESSION.target}</td>
          </tr>
        `;
      }).join('');

      const recapSection = `
        <div class="session-recap">
          <h3>${sessionOver ? 'Session terminée !' : `Session en cours — manche ${SESSION.round}`}</h3>
          <p class="subtitle">Objectif : ${SESSION.target} points cumulés.</p>
          <table>
            <thead><tr><th>Joueur</th><th>Score cumulé</th></tr></thead>
            <tbody>${recapRows}</tbody>
          </table>
        </div>
      `;

      extraHtml = sessionOver
        ? recapSection + `<button id="btn-new-session" class="btn btn-primary btn-block">Nouvelle session</button>`
        : recapSection + `<button id="btn-next-round" class="btn btn-primary btn-block">Manche suivante</button>`;
    }

    el('end-content').innerHTML = `
      <p>${STATE.winners.length > 1 ? 'Victoire partagée !' : 'Victoire !'}</p>
      <p style="font-size:13px; color: var(--text-dim, #9aa5b3);">Seul un survivant peut remporter la partie (sauf si personne n'a survécu).</p>
      <table>
        <thead>
          <tr><th>Joueur</th><th>Secret</th><th>PV</th><th>Secret rempli</th><th>Verdict + Kills</th><th>Total</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${extraHtml}
    `;

    if (SESSION && SESSION.active) {
      const ranked = SESSION.cumulative.slice().sort((a, b) => b.total - a.total);
      const sessionOver = ranked[0].total >= SESSION.target;
      if (sessionOver) {
        el('btn-new-session').addEventListener('click', () => {
          SESSION = null;
          showScreen('screen-setup');
        });
      } else {
        el('btn-next-round').addEventListener('click', () => {
          SESSION.round += 1;
          SESSION.configs.push(SESSION.configs.shift());
          startRound(SESSION.configs);
        });
      }
    } else {
      el('btn-restart').addEventListener('click', () => {
        showScreen('screen-setup');
      });
    }
  }

  // ---------- Erreurs visibles ----------
  // Sans ceci, une exception JS pendant le rendu du tour fige l'écran sans aucun
  // message : le joueur voit juste une main vide/figée sans savoir pourquoi.

  function showFatalError(message) {
    let banner = document.getElementById('fatal-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fatal-error-banner';
      banner.className = 'fatal-error-banner';
      document.body.appendChild(banner);
    }
    banner.textContent = `Erreur : ${message} — rechargez la page (l'état de la partie n'est pas sauvegardé). Si ça se reproduit, notez ce message exact.`;
  }

  window.addEventListener('error', (e) => showFatalError(e.message));
  window.addEventListener('unhandledrejection', (e) => {
    showFatalError((e.reason && e.reason.message) || String(e.reason));
  });

  // ---------- Bootstrap ----------

  function updateSessionTargetDefault() {
    const count = parseInt(el('player-count').value, 10);
    el('session-target').value = SESSION_TARGET_BY_COUNT[count] || 30;
  }

  function startRound(configs) {
    STATE = Engine.initGame(configs);
    screenOwnerId = null;
    showScreen('screen-game');
    render();
    runTurnLoop();
  }

  function init() {
    renderPlayerConfigRows();
    updateSessionTargetDefault();
    el('player-count').addEventListener('change', () => {
      renderPlayerConfigRows();
      updateSessionTargetDefault();
    });
    el('session-mode-toggle').addEventListener('change', (e) => {
      el('session-target-label').classList.toggle('hidden', !e.target.checked);
    });
    el('btn-start-game').addEventListener('click', () => {
      const configs = collectPlayerConfigs();
      const sessionActive = el('session-mode-toggle').checked;
      if (sessionActive) {
        const target = parseInt(el('session-target').value, 10) || SESSION_TARGET_BY_COUNT[configs.length] || 30;
        SESSION = {
          active: true,
          target,
          round: 1,
          configs,
          cumulative: configs.map((c) => ({ name: c.name, isAI: c.isAI, total: 0 })),
        };
      } else {
        SESSION = null;
      }
      startRound(configs);
    });
    showScreen('screen-setup');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
