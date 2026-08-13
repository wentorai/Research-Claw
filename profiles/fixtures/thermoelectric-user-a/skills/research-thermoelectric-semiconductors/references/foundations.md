# Thermoelectric Foundations and Device Translation

## Contents

1. Quantities and units
2. Coupled transport
3. From properties to a device
4. Measurement closure
5. Source anchors

## 1. Quantities and units

- Seebeck coefficient: `S = -Delta V / Delta T`, normally `V K^-1` or `uV K^-1`; preserve sign convention and contact-wire correction.
- Electrical conductivity: `sigma = 1/rho`, `S m^-1`; for films, convert sheet resistance only with a measured active thickness.
- Power factor: `PF = S^2 sigma`, `W m^-1 K^-2`. It omits thermal transport and device heat leakage.
- Thermal conductivity: `kappa = kappa_e + kappa_L (+ kappa_bipolar)`, `W m^-1 K^-1`.
- Material figure of merit: `zT = S^2 sigma T / kappa`, dimensionless. State temperature and direction.
- Peltier coefficient: `Pi = S T` under Kelvin relations. Thomson coefficient depends on `T dS/dT`.

For a generator with internal resistance `Rint`, an idealized load receives maximum power near `Rload = Rint`; then `Pmax = Voc^2/(4 Rint)`. This electrical identity does not establish efficiency because heat input and parasitic paths remain unknown.

## 2. Coupled transport

Carrier concentration, mobility, band structure, and scattering jointly control `S`, `sigma`, and electronic `kappa`. Do not optimize them independently. A measured reduction in total `kappa` may come from lower electronic conduction, porosity, radiation correction, heat-capacity assumptions, phase change, or bipolar transport rather than a new phonon mechanism.

When estimating `kappa_e = L sigma T`, justify Lorenz number `L` from carrier statistics and scattering. Propagate a plausible `L` interval through `kappa_L` and `zT`. Near narrow-gap bipolar conduction or multiband/phase-transition regions, a single parabolic band estimate may be inadequate.

## 3. From properties to a device

Integrate temperature-dependent `S`, `rho`, and `kappa`; do not insert peak `zT` into a constant-property efficiency formula. Include:

- actual hot/cold junction temperatures rather than heater/set-point temperatures;
- p/n compatibility, geometry, fill factor, electrode and interconnect resistance;
- electrical and thermal contact resistance;
- ceramic/substrate, encapsulant, radiation, convection, and heat spreading;
- temperature-dependent properties, Thomson heat when material variation warrants it;
- mechanical stress from CTE mismatch, phase change, bonding, and constraints.

For cooling, report cold-side heat lift, electrical input, coefficient of performance, hot-side rejection, maximum temperature difference, and load curve under a defined heat sink. A no-load `DeltaTmax` is not cooling capacity.

## 4. Measurement closure

Use same specimens or equivalently processed specimens; record direction, thermal history, density, geometry, calibration, and uncertainty. For laser-flash inference `kappa = D rho_m Cp`, state diffusivity `D`, mass density `rho_m`, heat capacity `Cp`, radiation/model corrections, and their provenance.

Close a device model against independent measurements:

- compare `Voc` with `integral(S_p - S_n) dT`;
- compare measured resistance with legs + contacts + electrodes;
- compare measured heat flow with conduction + Peltier/Joule/Thomson + parasitics;
- investigate residuals rather than absorbing them into fitted properties.

## 5. Source anchors

- Snyder & Toberer, *Complex thermoelectric materials*, Nature Materials 7 (2008), DOI: https://doi.org/10.1038/nmat2090 — transport coupling and material-selection framework.
- He & Tritt, *Advances in thermoelectric materials research: Looking back and moving forward*, Science 357 (2017), DOI: https://doi.org/10.1126/science.aak9997 — field-level transport and materials review.
- Goldsmid, *Introduction to Thermoelectricity*, Springer (2010), DOI: https://doi.org/10.1007/978-3-642-00716-3 — equations and generator/cooler fundamentals.
- NIST Thermoelectric Database project: https://www.nist.gov/programs-projects/thermoelectric-database — official measurement-data context.

Use these as anchors, then verify any material-specific number against the primary paper and its supplementary methods.
