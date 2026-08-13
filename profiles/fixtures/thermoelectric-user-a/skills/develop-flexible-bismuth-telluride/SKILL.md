---
name: develop-flexible-bismuth-telluride
description: Develop and audit Bi2Te3-family flexible thermoelectric films and devices, including deposition or printing, composition and texture, substrate and interface mechanics, p/n integration, wearable thermal boundaries, bending reliability, metrology, and device benchmarking; use when Bi2Te3, Sb2Te3, flexible thin films, conformal generators, cooling patches, fibers, textiles, or bend-cycle failures are central.
---

# Develop Flexible Bismuth Telluride

Treat flexible Bi2Te3 as a coupled material–film–interface–thermal–device problem. Distinguish an intrinsically flexible active film, a flexible composite, and rigid legs mounted on a flexible assembly.

## Load evidence by task

- Read [knowledge-base.md](references/knowledge-base.md) for material physics, architectures, and device translation.
- Read [experimental-workflow.md](references/experimental-workflow.md) before proposing fabrication or characterization.
- Read [benchmarking-and-reliability.md](references/benchmarking-and-reliability.md) before comparing devices or bending claims.
- Activate `research-thermoelectric-semiconductors` when general transport metrology or module theory dominates.

## Define architecture before optimizing

Choose one: thin inorganic film; inorganic–organic composite; rigid islands/legs; patterned/wavy/kirigami film; or fiber/textile. State use temperature, curvature/strain, stack thickness, heat-flow direction, source/sink interface, target output/cooling, and manufacturing limits.

Use the causal chain:

`chemistry + process + substrate → stoichiometry/phase/texture/defects → directional transport → crack/interface evolution → retained device DeltaT and output`

Predict a thermoelectric and a mechanical signature for every intervention. Thinning or neutral-plane placement reduces strain but does not prove intrinsic ductility. A binder changes percolation, porosity, adhesion, thermal transport, and aging—not only flexibility.

## Execute stage gates

1. Include a rigid-substrate material control and flexible-substrate process control where feasible.
2. Measure substrate thermal limit, shrinkage, roughness, surface energy, barrier behavior, and adhesion.
3. Design composition, thickness, texture, porosity, binder fraction, and anneal as separable axes.
4. Verify composition, phase, texture, thickness, residual stress, adhesion, and crack density.
5. Measure direction-matched `S`, sheet resistance/conductivity, Hall response where valid, thermal transport, and mechanical response on the same material state.
6. Engineer p/n legs, electrodes, barriers, interconnects, encapsulation, geometry, and heat path.
7. Measure actual junction temperatures, complete I–V/P–I curves, area basis, curvature state, and repeatability.
8. Combine bending, thermal cycling, humidity/oxidation, and electrical loading; perform interface post-mortems.

## Report paired performance

Report composition, process, substrate, active thickness/direction, replicates, `S`, `sigma`, PF, and only defensible `kappa/zT`. For bending, report radius, full stack/neutral-axis model, calculated active-layer strain when defensible, cycles, frequency, mandrel, tension/compression side, environment, in-cycle response, and crack/delamination evidence. For devices, report actual hot/cold temperatures, `Voc`, `Rint`, full load curves, `Pmax`, normalization area, and source/sink.

If coupon properties are good but output is weak, audit retained `DeltaT`, contact resistance, substrate heat spreading, fill factor, and load matching before changing composition.
