# GeTe Devices, Contacts, and Reliability

## Contents

1. Junction screening
2. Leg/module design
3. Performance measurement
4. Aging and failure analysis
5. Source anchors

## 1. Junction screening

Prepare GeTe with the exact device composition/process and finish. Measure specific contact resistivity with a geometry that separates bulk and interface resistance. Screen electrode/barrier/bond stacks across joining temperature, pressure, time, atmosphere, surface preparation, and maximum service temperature.

Age coupons isothermally and under gradients/current. Track reaction-layer thickness/chemistry, contact resistance, bond strength, cracks/voids, diffusion, oxidation, and Te/Ge redistribution. A published barrier is a candidate, not validation for a different GeTe chemistry.

## 2. Leg/module design

Select an n-leg and optional segments by temperature-dependent compatibility, CTE, mechanics, chemical/bond compatibility, and stability. Include added interface loss for segmentation. Model temperature-dependent `S/rho/kappa`, contacts, Thomson heat where needed, radiation, source/sink, and mechanical stress through heating/cooling and structural evolution.

Optimize leg area/length, p/n ratio, segment length, couple count, electrodes, and electrical load together. State model mesh, properties, boundaries, contact assumptions, and sensitivity.

## 3. Performance measurement

Measure actual junction temperatures, heat input, voltage/current/load, and calibrated heat losses. Report full I–V/P–I curves, `Voc`, `Rint`, `Pmax`, area basis, efficiency from corrected heat input, uncertainty, and repeat builds.

Close `Voc` against the integral of p/n Seebeck coefficients and resistance against legs + contacts + electrodes. Distinguish full p/n module, segmented single leg, and one-leg demonstrator. Keep theoretical efficiency separate from measured efficiency and name excluded losses.

## 4. Aging and failure analysis

Design stress from service: isothermal reaction kinetics; full gradient/current; cycles crossing structural evolution; atmosphere/oxidation; mechanical constraint; and vibration if relevant. Define failure thresholds first. Track contact resistance, module resistance, `Voc` at controlled actual `DeltaT`, `Pmax`, heat leakage, efficiency, and strength.

| Signature | Candidate cause | Post-mortem |
|---|---|---|
| hot-end resistance rise | barrier reaction/diffusion | interface cross-section, WDS/EDS, phase map |
| cycle-correlated jumps/cracks | phase/CTE stress | fracture location, diffraction/calorimetry, mechanics |
| intermittent/open circuit | bond/electrode fatigue | void/crack tomography or section |
| composition/transport drift | oxidation or volatilization | mass/composition gradient, oxide/Te-loss analysis |
| low efficiency, normal electrical curve | heat leak or p/n mismatch | thermal map and calibrated parasitic model |

Preserve failed modules and section interfaces before destructive bulk averaging.

## 5. Source anchors

- Jiang et al., Science 377, 208–213 (2022), DOI: https://doi.org/10.1126/science.abq5815 — a lead-containing multicomponent GeTe-based material and segmented-module study; authors report peak `zT = 2.7` at 750 K and measured `13.3%` conversion efficiency at `DeltaT = 506 K`. Do not generalize to pristine/lead-free GeTe, average `zT`, or lifetime.
- Pei et al., *Design and Fabrication of Segmented GeTe/(Bi,Sb)2Te3 Thermoelectric Module with Enhanced Conversion Efficiency*, Advanced Functional Materials (2023), DOI: https://doi.org/10.1002/adfm.202214771 — segmented one-leg evidence; separate measured performance from idealized modeling.
- Jiang et al., Nature Communications 13, 6087 (2022), DOI: https://doi.org/10.1038/s41467-022-33774-z — authors report peak `zT > 2.3` at 648 K, average `zT = 1.56` over 300–798 K, and `11%` single-leg efficiency at `DeltaT = 498 K`; these are three different evidence levels.
- Yu et al., *Germanium-telluride-based thermoelectrics*, Nature Reviews Electrical Engineering (2024), DOI: https://doi.org/10.1038/s44287-023-00013-6 — review map; trace records to primary experiments.

Recheck exact sample, apparatus, uncertainty, and supplementary definitions before reusing any source-anchor number.
