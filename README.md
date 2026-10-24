# Canopy Claims

A GPS map game prototype in the style of Terramine. The real world is split into a grid of plots (~28 m). Walking earns Hydro-Kinetic Energy (HE), which you spend to plant and water glowing trees. The trees produce Sap passively.

## Run

Plain static files with no build step:

```sh
python3 -m http.server 8080
# open http://localhost:8080   (add ?lat=..&lng=.. to start somewhere specific in Sim mode)
```

Phones only allow GPS on **HTTPS**, so to play outdoors, host the folder on any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages).

## Files

- `economy.js`: all formulas and tunable constants (`CONFIG`, `SPECIES`). No DOM access.
- `game.js`: map, GPS, rendering, UI.
- `test.html`: economy unit tests. Open it in a browser, or run `google-chrome --headless=new --dump-dom file://$PWD/test.html`.

## Formulas

- HE generated = meters walked × `HE_PER_METER`. GPS jitter (<8 m), poor fixes (>30 m accuracy) and vehicle speeds (>7 m/s) earn nothing.
- Sap rate (per min) = species base rate × hydration multiplier (Withered 0.1, Optimal 1.0, Canopy Bloom 2.5) × fertilizer boost (20 while an ad boost is active, else 1).
- Offline production is integrated exactly across bloom/withered/boost boundaries (`Economy.sapBetween`).

## Dev console helpers

`canopy.addHE(1000)` adds HE, and `canopy.skip(3600e3)` fast-forwards the game clock by 1 hour.

## Art direction
Tilted 3D map (MapLibre GL, pitch 68°) with a custom sunset low-poly style defined in `buildStyle()` in `game.js`
(olive ground, dark roads, cream plot grid, warm extruded buildings, sunset sky). Trees are flat-shaded
low-poly three.js models in `trees3d.js`, rendered through a MapLibre custom layer; Bloom adds a stronger glow + sparkles,
Withered turns the canopy brown. Each plot shows a ground hydration bar.
