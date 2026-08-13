---
name: engineer-gete-thermoelectrics
description: Engineer and audit GeTe-based thermoelectric materials and devices across defect chemistry, carrier concentration, band and phase engineering, phonon scattering, synthesis, temperature-dependent transport, contacts, diffusion barriers, legs, modules, and reliability; use when GeTe composition, Ge vacancies, rhombohedral-cubic transition, band convergence, average zT, junctions, or mid-temperature module performance is central.
---

# Engineer GeTe Thermoelectrics

Optimize operating-window performance and reliability, not an isolated peak `zT`.

## Load evidence by task

- Read [knowledge-base.md](references/knowledge-base.md) for GeTe phase, native defects, bands, phonons, and composition families.
- Read [experimental-workflow.md](references/experimental-workflow.md) before synthesis, computation, characterization, or optimization.
- Read [devices-and-reliability.md](references/devices-and-reliability.md) before contact, barrier, leg, or module design.
- Activate `research-thermoelectric-semiconductors` for general metrology and module theory.

## Start from coupled constraints

Account for: acceptor-like Ge vacancies and typically excessive p-type carriers; composition-dependent rhombohedral-to-cubic evolution in the service range; multiple valence-band extrema coupled to distortion; and phase-dependent expansion, diffusion, Te-rich reactivity, and contact resistance.

Classify each intervention by its intended lever: vacancy/carrier control; Fermi-level tuning; band convergence; phase/distortion control; phonon scattering; mechanical/interface stability; or device compatibility. Predict final composition, phase/transition, Hall response, `S/sigma/kappa`, mechanics, and junction behavior. Include porosity, second phases, Lorenz-number choice, Te loss, and contact reaction as counter-hypotheses.

## Execute stage gates

1. Define hot/cold temperatures, atmosphere, cycles, target average performance, n-leg, and element constraints.
2. Reproduce final composition, density, phase, carrier response, and full-window transport in independent baseline batches.
3. Separate vacancy compensation, band/phase engineering, phonon scattering, and thermal history where possible.
4. Close Ge/Te mass and phase balance; map segregation, precipitates, and phase fractions.
5. Measure heating/cooling `S(T)`, `sigma(T)`, field-dependent Hall response, diffusivity, heat capacity, density, and `kappa(T)` with uncertainty through transition anomalies.
6. Test mechanisms using independent defect, band, structural, or phonon evidence and matched-carrier/density controls.
7. Screen barrier/electrode/bond coupons for reaction, contact resistivity, strength, CTE, and aging.
8. Validate legs/modules with temperature-dependent models, actual junction temperatures, heat input, full load curves, repeat builds, and post-mortem analysis.

Treat DFT as prediction or mechanistic support, not proof of experimental defect population, solubility, phase purity, or service stability. Treat one-band Hall and constant heat-capacity/Lorenz approximations with sensitivity analysis near multiband and phase-transition regimes.

## Diagnose coupled signatures

- Larger `|S|` with sharply lower mobility: test overcompensation, ionized-impurity scattering, precipitates, and porosity.
- Lower inferred lattice `kappa` without structural evidence: vary Lorenz model, heat capacity, density, radiation, and bipolar assumptions.
- Thermal hysteresis or irreversible transport: pair calorimetry/in-situ diffraction with composition and cycling.
- Strong coupon performance but weak module: separate bulk, contact, electrode, bond, thermal spreading, and p/n mismatch losses.
- Resistance growth near hot side: section the junction before bulk averaging hides the reaction layer.
