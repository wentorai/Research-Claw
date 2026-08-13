# Experimental Workflow for GeTe

## Contents

1. Service target and baseline
2. Composition/process design
3. Phase, defect, and transport metrology
4. Mechanism tests
5. Down-selection and computation

## 1. Service target and baseline

Specify hot/cold temperatures, atmosphere, gradients, dwell/cycles, desired average performance, n-leg/segment, element policy, scale, yield, and lifetime. Reproduce at least independent baseline batches using the intended route. Measure recovered/final composition, spatial uniformity, density, phase/transition on heating and cooling, microstructure, Hall response, `S/sigma/D/Cp/kappa` through the full window, and cycle repeatability.

If baseline or mass/phase balance does not close, repair process control before interpreting dopants.

## 2. Composition/process design

Separate axes where possible: Ge excess/deficiency; compensating dopant; band/phase modifier; phonon-scattering addition; and thermal history/densification. Use coarse screen, local response surface, matched-carrier mechanistic pairs, then independent confirmation. Bracket predicted solubility and include a process-only control.

For melting routes, record ampoule/coating, vacuum/inert state, free volume, melt/agitation/dwell, cooling/quench/anneal, recovered mass, ingot-position sampling, milling contamination, and densification temperature/pressure/displacement/atmosphere. Plot mechanisms against measured composition.

## 3. Phase, defect, and transport metrology

Use XRD/refinement plus temperature-resolved diffraction/calorimetry when transition behavior matters. Add SEM/BSE with WDS/EPMA, density/porosity, texture, TEM/STEM, positron annihilation, XAS/XPS, or total scattering only as dictated by the claim. No single method yields a universal vacancy concentration.

Measure heating and cooling. For Hall data, use field sweeps and report Hall coefficient where one-band interpretation fails. For `kappa = D rho_m Cp`, measure or sensitivity-test `Cp` through anomalies. Use phase-appropriate Lorenz/multiband ranges. Report peak and average metrics separately.

## 4. Mechanism tests

- **Vacancy/carrier control:** final composition + Hall trend + phase exclusion + defect-sensitive/calculation link; compare mobility at matched carrier concentration.
- **Band convergence:** energy-offset prediction/spectroscopy + phase awareness + transport not explained by doping; test interband scattering.
- **Phonon scattering:** quantified defect/precipitate population + density-matched samples + robust `L/Cp` sensitivity.
- **Phase engineering:** diffraction/calorimetry + transport + dimensional change + cycling; shifting transition is useful only if service outcome improves.

## 5. Down-selection and computation

Advance only reproducible compositions meeting average-performance, cycle stability, machinability, barrier/bond compatibility, element-policy, yield, and scale thresholds. Archive failed compositions.

Use spin–orbit-aware, converged DFT for phase energetics, defect formation versus chemical potential/Fermi level, site preference, and band evolution. Declare Boltzmann relaxation/scattering assumptions and phonon convergence. Validate against measured lattice, phase, composition, carrier sign/range, and trends. Computation does not prove solubility or stability.
