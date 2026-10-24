// Game economy: pure functions + tunable constants. No DOM access.
(function (root) {
  'use strict';

  const CONFIG = {
    HE_PER_METER: 1,                       // HE Modifier
    PLANT_COST_HE: 250,
    FIRST_TREE_FREE: true,
    START_HYDRATION: 100,                  // new trees start in Canopy Bloom
    WATER_COST_HE_PER_PCT: 2,
    BLOOM_HOLD_MS: 60 * 60 * 1000,         // how long 100% lasts before draining starts
    DRAIN_FULL_MS: 24 * 60 * 60 * 1000,    // time to drain 100% -> 0%
    FERTILIZER_BOOST: 20.0,
    AD_BOOST_MS: 30 * 60 * 1000,
    AD_LENGTH_S: 15,
  };

  const HYDRATION_MULTIPLIER = { withered: 0.1, optimal: 1.0, bloom: 2.5 };

  const SPECIES = [
    { id: 'ironwood', name: 'Ironwood Oak',    rarity: 'Common',   aesthetic: 'Metallic Silver',          min: 1,   max: 50,  rate: 10,  color: '#c9d1d9', glow: null,      shape: 'oak' },
    { id: 'redwood',  name: 'Biolume Redwood', rarity: 'Uncommon', aesthetic: 'Glowing Neon Red',         min: 51,  max: 85,  rate: 25,  color: '#ff3355', glow: '#ff1744', shape: 'conifer' },
    { id: 'willow',   name: 'Amber Willow',    rarity: 'Rare',     aesthetic: 'Glowing Radiant Gold',     min: 86,  max: 99,  rate: 65,  color: '#ffc23a', glow: '#ffb300', shape: 'willow' },
    { id: 'cypress',  name: 'Dew Cypress',     rarity: 'Mythic',   aesthetic: 'Glowing Greenish-Blue',    min: 100, max: 100, rate: 250, color: '#3fe0c0', glow: '#1de9b6', shape: 'cypress' },
  ];

  const DRAIN_PER_MS = 100 / CONFIG.DRAIN_FULL_MS;

  const rollD100 = (rng = Math.random) => Math.floor(rng() * 100) + 1;
  const speciesForRoll = (roll) => SPECIES.findIndex((s) => roll >= s.min && roll <= s.max);

  // A tree's hydration is described by h0 (hydration % right after its last watering) and tw (that time).
  const drainStart = (tree) => (tree.h0 >= 100 ? tree.tw + CONFIG.BLOOM_HOLD_MS : tree.tw);
  const dryAt = (tree) => drainStart(tree) + tree.h0 / DRAIN_PER_MS;

  function hydrationAt(tree, now) {
    const ds = drainStart(tree);
    if (now <= ds) return tree.h0;
    return Math.max(0, tree.h0 - (now - ds) * DRAIN_PER_MS);
  }

  function hydrationState(tree, now) {
    if (tree.h0 >= 100 && now < drainStart(tree)) return 'bloom';
    return now < dryAt(tree) ? 'optimal' : 'withered';
  }

  // Whole-number % for display: 100 only while blooming, never shows 0 while still hydrated.
  function displayHydration(tree, now) {
    const st = hydrationState(tree, now);
    if (st === 'bloom') return 100;
    if (st === 'withered') return 0;
    return Math.min(99, Math.max(1, Math.ceil(hydrationAt(tree, now))));
  }

  const fertilizerBoost = (boostUntil, now) => (boostUntil - now > 0 ? CONFIG.FERTILIZER_BOOST : 1.0);

  // Passive Sap Production Rate = Base Tree Sap Rate x Hydration Multiplier x Fertilizer Boost  (Sap / minute)
  function sapRate(tree, boostUntil, now) {
    return SPECIES[tree.s].rate * HYDRATION_MULTIPLIER[hydrationState(tree, now)] * fertilizerBoost(boostUntil, now);
  }

  // Exact Sap produced in [t0, t1]: the rate is piecewise constant, so split at every state change.
  function sapBetween(tree, boostUntil, t0, t1) {
    if (t1 <= t0) return 0;
    const cuts = [drainStart(tree), dryAt(tree), boostUntil].filter((x) => x > t0 && x < t1).sort((a, b) => a - b);
    const pts = [t0, ...cuts, t1];
    let sap = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      sap += sapRate(tree, boostUntil, (a + b) / 2) * ((b - a) / 60000);
    }
    return sap;
  }

  // Water with up to `he` energy. Returns { tree, cost, added } (tree is a new object).
  function water(tree, now, he) {
    const h = hydrationAt(tree, now);
    const need = 100 - h;
    if (hydrationState(tree, now) === 'bloom' || need <= 0) return { tree, cost: 0, added: 0 };
    const added = Math.min(need, he / CONFIG.WATER_COST_HE_PER_PCT);
    const full = added >= need - 1e-9;
    return {
      tree: { ...tree, h0: full ? 100 : h + added, tw: now },
      cost: (full ? need : added) * CONFIG.WATER_COST_HE_PER_PCT,
      added,
    };
  }

  const waterCostToFull = (tree, now) =>
    hydrationState(tree, now) === 'bloom' ? 0 : (100 - hydrationAt(tree, now)) * CONFIG.WATER_COST_HE_PER_PCT;

  const plantCost = (plantedSoFar) => (CONFIG.FIRST_TREE_FREE && plantedSoFar === 0 ? 0 : CONFIG.PLANT_COST_HE);

  root.Economy = {
    CONFIG, SPECIES, HYDRATION_MULTIPLIER,
    rollD100, speciesForRoll, drainStart, dryAt, hydrationAt, hydrationState, displayHydration,
    fertilizerBoost, sapRate, sapBetween, water, waterCostToFull, plantCost,
  };
})(typeof window !== 'undefined' ? window : globalThis);
