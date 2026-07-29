// data.js — définitions statiques des cartes et paquets (aucune dépendance DOM)

(function (root) {
  const CATASTROPHE_KINDS = ['volcan', 'tsunami', 'seisme', 'secheresse'];

  const CATASTROPHE_LABELS = {
    volcan: 'Volcan',
    tsunami: 'Tsunami',
    seisme: 'Séisme',
    secheresse: 'Sécheresse',
  };

  // Défensif spécifique qui contre chaque catastrophe
  const SPECIFIC_DEFENSE = {
    tsunami: 'digue',
    seisme: 'abri',
    volcan: 'plan_evacuation',
    secheresse: 'reserve_eau',
  };

  // Archétype secondaire déclenché par chaque catastrophe
  const ARCHETYPE_BY_CATASTROPHE = {
    seisme: 'perte_carte',
    tsunami: 'blocage_defensif',
    secheresse: 'blocage_ressource',
    volcan: 'cicatrice',
  };

  const ARCHETYPE_LABELS = {
    perte_carte: 'Perte de carte (Séisme)',
    blocage_defensif: 'Blocage Défensif (Tsunami)',
    blocage_ressource: 'Blocage Ressource (Sécheresse)',
    cicatrice: 'Cicatrice (Volcan)',
  };

  const SECRETS = [
    { id: 'survivant', label: 'Le Survivant', desc: 'Être en vie quand le compteur atteint 8.' },
    { id: 'bastion', label: 'Le Bastion', desc: 'Avoir strictement plus de PV que tous les autres à la fin.' },
    { id: 'semeur', label: 'Le Semeur', desc: 'Avoir joué au moins 3 cartes Catastrophe personnellement.' },
    { id: 'traqueur', label: 'Le Traqueur', desc: "Avoir joué au moins 3 cartes Sabotage au total, en touchant autant d'adversaires différents que possible (jusqu'à 3)." },
    { id: 'fossoyeur', label: 'Le Fossoyeur', desc: "Avoir personnellement causé l'élimination d'au moins 2 joueurs (via une carte Offensif ou une Catastrophe), ou 1 seul à 2 joueurs." },
    { id: 'bienfaiteur', label: 'Le Bienfaiteur', desc: "Avoir joué Entraide sur un autre joueur au moins 2 fois." },
    { id: 'collectionneur', label: 'Le Collectionneur', desc: 'Avoir eu simultanément 1 Provisions + 1 Entraide non joués en main, à un moment de la partie.' },
    { id: 'bouclier', label: 'Le Bouclier', desc: "Avoir annulé ou réduit des dégâts de Catastrophe avec une carte Défensif au moins 3 fois." },
    { id: 'insaisissable', label: "L'Insaisissable", desc: "Avoir été touché par une carte Sabotage au plus (6 - nombre de joueurs, minimum 1) fois pendant toute la partie." },
  ];

  function buildCardId(counterRef, prefix) {
    counterRef.n += 1;
    return `${prefix}_${counterRef.n}`;
  }

  // Construit le paquet principal de 128 cartes (objets {id, category, kind, label, ...meta})
  function buildMainDeck() {
    const counter = { n: 0 };
    const deck = [];

    const push = (category, kind, label, count, extra) => {
      for (let i = 0; i < count; i++) {
        deck.push(Object.assign({
          id: buildCardId(counter, kind),
          category,
          kind,
          label,
        }, extra || {}));
      }
    };

    // Ressource (40)
    push('Ressource', 'pansement', 'Pansement', 8, { amount: 1 });
    push('Ressource', 'provisions', 'Provisions', 8, { amount: 2 });
    push('Ressource', 'entraide', 'Entraide', 8, { amount: 1, choosable: true });
    push('Ressource', 'renfort', 'Renfort', 4, { draw: 2 });
    push('Ressource', 'ravitaillement', 'Ravitaillement', 2, { draw: 3 });
    push('Ressource', 'sursis', 'Sursis', 10, { amount: 4, requiresLowPv: 3 });

    // Défensif (24)
    push('Defensif', 'digue', 'Digue', 4, { counters: 'tsunami' });
    push('Defensif', 'abri', 'Abri renforcé', 4, { counters: 'seisme' });
    push('Defensif', 'plan_evacuation', "Voie d'évacuation", 4, { counters: 'volcan' });
    push('Defensif', 'reserve_eau', 'Citerne', 4, { counters: 'secheresse' });
    push('Defensif', 'kit_secours', 'Kit de secours', 8, { generic: true });

    // Sabotage (18)
    push('Sabotage', 'pillage', 'Pillage', 6, {});
    push('Sabotage', 'coupure', 'Éboulement', 6, {});
    push('Sabotage', 'quarantaine', 'Quarantaine', 6, {});

    // Offensif (30)
    push('Offensif', 'machette', 'Machette', 10, { damage: 2 });
    push('Offensif', 'pioche_secours', 'Charognard', 7, { damage: 1, stealResource: true });
    push('Offensif', 'contamination', 'Contamination', 6, { stealResistance: 1 });
    push('Offensif', 'amputation', 'Amputation', 4, { damage: 2, ignoresKit: true });
    push('Offensif', 'chaos', 'Chaos', 3, { damageAll: 2 });

    // Catastrophe (16) — jouable directement en tour normal, plus de carte Colère
    CATASTROPHE_KINDS.forEach((k) => {
      push('Catastrophe', k, CATASTROPHE_LABELS[k], 4, {});
    });

    return deck;
  }

  function buildPresageDeck() {
    const counter = { n: 0 };
    return CATASTROPHE_KINDS.map((k) => ({
      id: buildCardId(counter, 'presage_' + k),
      category: 'Catastrophe',
      kind: k,
      label: CATASTROPHE_LABELS[k],
    }));
  }

  function buildSecretDeck() {
    return SECRETS.map((s) => ({ id: 'secret_' + s.id, kind: s.id, label: s.label }));
  }

  function shuffle(arr, rng) {
    const random = rng || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const CatastropheDataExports = {
    CATASTROPHE_KINDS, CATASTROPHE_LABELS, SPECIFIC_DEFENSE, ARCHETYPE_BY_CATASTROPHE,
    ARCHETYPE_LABELS, SECRETS, buildMainDeck, buildPresageDeck, buildSecretDeck, shuffle,
  };

  if (typeof module !== 'undefined') {
    module.exports = CatastropheDataExports;
  } else {
    root.CatastropheData = CatastropheDataExports;
  }
})(typeof window !== 'undefined' ? window : global);
