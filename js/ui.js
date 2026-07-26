// ui.js — interface DOM, orchestration des tours et des interactions (pilote les générateurs du moteur)
(function () {
  const Engine = window.CatastropheEngine;
  const AI = window.CatastropheAI;
  const SECRETS = window.CatastropheData.SECRETS;

  const CARD_DESC = {
    renfort: '+1 résistance',
    provisions: '+2 résistance',
    entraide: '+1 résistance à un autre joueur (jamais à soi-même)',
    ravitaillement: 'Piocher 2 cartes',
    provisions_urgence: 'Piocher 3 cartes',
    digue: 'Annule les dégâts d\'un Tsunami',
    abri: 'Annule les dégâts d\'un Séisme',
    plan_evacuation: 'Annule les dégâts d\'un Volcan',
    reserve_eau: 'Annule les dégâts d\'une Sécheresse',
    kit_secours: 'Réduit les dégâts de 1 (sauf Amputation)',
    pillage: 'Vole 1 carte au hasard à un adversaire',
    panique: 'Force un adversaire à défausser une carte de son choix',
    coupure: 'L\'adversaire ne pioche pas au prochain tour',
    detournement: 'Force un adversaire à défausser une carte de son choix',
    machette: '1 dégât direct',
    pioche_secours: '1 dégât + vole 1 carte Ressource',
    contamination: 'Vole 1 résistance (vous la gagnez)',
    amputation: '2 dégâts, ignore le Kit de secours',
    rechauffement: 'Tous les autres joueurs perdent 1 résistance',
    volcan: 'Catastrophe : 3 dégâts à tous les autres + cicatrice',
    tsunami: 'Catastrophe : 3 dégâts à tous les autres + blocage Défensif',
    seisme: 'Catastrophe : 3 dégâts à tous les autres + perte de carte',
    secheresse: 'Catastrophe : 3 dégâts à tous les autres + blocage Ressource',
    colere: 'Verrouille votre Catastrophe, vous devrez la jouer au tour suivant',
  };

  let STATE = null;
  let screenOwnerId = null; // qui est actuellement affiché à l'écran (pour gérer le pass-and-play)

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
      const pct = Math.round((p.resistance / p.maxResistance) * 100);
      const barClass = pct <= 30 ? 'low' : (pct <= 60 ? 'mid' : '');
      const cibleClass = p.cible === 'premiere' ? 'premiere' : (p.cible === 'seconde' ? 'seconde' : '');
      tile.innerHTML = `
        <div class="name">
          <span>${p.name}${p.isAI ? ' <span class="ai-tag">(IA)</span>' : ''}</span>
          <span class="cible-badge ${cibleClass}">${Engine.cibleLabel(p.cible)}</span>
        </div>
        <div class="hp-bar-track"><div class="hp-bar-fill ${barClass}" style="width:${pct}%"></div></div>
        <div class="hp-text">${p.resistance} / ${p.maxResistance} résistance${p.eliminated ? ' — éliminé' : ''}</div>
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

  function cardHtml(card, extra) {
    return `
      <div class="card cat-${card.category} ${extra && extra.disabled ? 'disabled' : ''}" data-card-id="${card.id}">
        <div class="cat-tag">${card.category}</div>
        <div class="card-label">${card.label}</div>
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
      const kindLabel = inter.context.kind === 'catastrophe' ? CatastropheData.CATASTROPHE_LABELS[inter.context.catastropheKind] : inter.context.offensifKind;
      openModal(`
        <h2>Réaction défensive</h2>
        <p>${player.name}, vous êtes touché par : <strong>${kindLabel}</strong>. Jouer une carte Défensif ?</p>
        <div class="option-list">
          ${cards.map((c) => `<div class="option-item" data-id="${c.id}"><strong>${c.label}</strong><br><small>${CARD_DESC[c.kind]}</small></div>`).join('')}
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
          <div class="hand-row">${player.hand.map((c) => cardHtml(c)).join('')}</div>
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
        <h2>Défausse forcée</h2>
        <p>${target.name}, choisissez la carte à défausser.</p>
        <div class="hand-row">${target.hand.map((c) => cardHtml(c)).join('')}</div>
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

  // ---------- Turn panel: human ----------

  function budgetSummary() {
    const b = STATE.turnBudget;
    return `Cartes jouées ce tour : ${b.totalPlays} / ${Engine.TURN_BUDGET} — Types utilisés : ${Array.from(b.usedTypes).join(', ') || 'aucun'}${b.sabotageTargets.size ? ' — Sabotage visé : ' + b.sabotageTargets.size : ''}`;
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
        player.hand.forEach((card) => {
          const playable = isPlayableNow(card);
          const wrapper = document.createElement('div');
          wrapper.innerHTML = cardHtml(card, { disabled: !playable.ok });
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

        const colereRow = document.createElement('div');
        const catCard = player.hand.find((c) => c.category === 'Catastrophe');
        const colereCard = player.hand.find((c) => c.category === 'Colere');
        if (catCard && colereCard && !STATE.turnBudget.colerePlayed) {
          const btn = document.createElement('button');
          btn.className = 'btn btn-secondary';
          btn.textContent = `Jouer Colère (verrouille ${catCard.label})`;
          btn.addEventListener('click', async () => {
            const r = Engine.playColereCard(STATE, player.id, colereCard.id, catCard.id);
            if (!r.ok) alert(r.reason);
            render();
            draw();
          });
          panel.appendChild(btn);
        }

        const endBtn = document.createElement('button');
        endBtn.className = 'btn btn-primary btn-block';
        endBtn.textContent = 'Terminer le tour';
        endBtn.addEventListener('click', finishTurn);
        panel.appendChild(endBtn);
      };

      function isPlayableNow(card) {
        if (card.category === 'Defensif' || card.category === 'Catastrophe' || card.category === 'Colere') {
          return { ok: false, reason: 'Non jouable depuis la main sur votre propre tour.' };
        }
        if (card.category === 'Ressource' && player.blockRessourceNextTurn) {
          return { ok: false, reason: 'Sécheresse : Ressource interdite ce tour.' };
        }
        if (card.category === 'Ressource' && card.kind === 'entraide' && Engine.activePlayers(STATE).filter((p) => p.id !== player.id).length === 0) {
          return { ok: false, reason: 'Aucun autre joueur actif à qui venir en aide.' };
        }
        return Engine.canPlayCategory(STATE, card.category);
      }

      function onCardClick(card) {
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
    if (plan.offensive) {
      await driveGen(Engine.playOffensiveCard(STATE, player.id, plan.offensive.cardId, plan.offensive.targetId));
    }
    for (const sab of plan.sabotages) {
      const r = Engine.playSabotageCard(STATE, player.id, sab.cardId, sab.targetId);
      if (r && r.needsDiscardChoice) {
        const discId = await handleForcedDiscardChoice(r.target);
        if (discId) Engine.resolveForcedDiscard(STATE, r.target.id, discId);
      }
    }
    if (plan.colere) {
      Engine.playColereCard(STATE, player.id, plan.colere.cardId, plan.colere.catastropheCardId);
    }
    render();

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

      if (Engine.isForcedTurn(player)) {
        const panel = el('turn-panel');
        panel.innerHTML = `<h2>Tour spécial : Catastrophe obligatoire</h2><p>${player.name} doit jouer sa Catastrophe verrouillée.</p>`;
        await driveGen(Engine.forcedTurn(STATE, player.id));
      } else {
        if (player.isAI) {
          await runAITurn(player);
        } else {
          await runHumanTurn(player);
        }
        if (STATE.phase === 'ended') break;
        await driveGen(Engine.normalEndOfTurn(STATE, player.id));
      }

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
          <td>${isWinner ? '🏆 ' : ''}${s.name}</td>
          <td>${Engine.secretLabel(player.secret)}${player.secretCancelled ? ' (annulé)' : ''}</td>
          <td>${s.aliveBonus}</td>
          <td>${s.resistanceBonus}</td>
          <td>${s.secretBonus} ${s.secretDone ? '✓' : ''}</td>
          <td>${s.resourceCards}</td>
          <td>${s.verdictBonus}</td>
          <td><strong>${s.total}</strong></td>
        </tr>
      `;
    }).join('');

    el('end-content').innerHTML = `
      <p>${STATE.winners.length > 1 ? 'Victoire partagée !' : 'Victoire !'}</p>
      <table>
        <thead>
          <tr><th>Joueur</th><th>Secret</th><th>Vivant</th><th>Résistance</th><th>Secret rempli</th><th>Ressources en main</th><th>Verdict</th><th>Total</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <button id="btn-restart" class="btn btn-primary btn-block">Nouvelle partie</button>
    `;
    el('btn-restart').addEventListener('click', () => {
      showScreen('screen-setup');
    });
  }

  // ---------- Bootstrap ----------

  function init() {
    renderPlayerConfigRows();
    el('player-count').addEventListener('change', renderPlayerConfigRows);
    el('btn-start-game').addEventListener('click', () => {
      const configs = collectPlayerConfigs();
      STATE = Engine.initGame(configs);
      screenOwnerId = null;
      showScreen('screen-game');
      render();
      runTurnLoop();
    });
    showScreen('screen-setup');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
