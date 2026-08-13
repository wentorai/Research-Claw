# Research Methodology for Thermoelectrics

## Contents

1. Claim decomposition
2. Experimental design
3. Metrology and uncertainty
4. Mechanism tests
5. Failure-driven iteration

## 1. Claim decomposition

Translate a headline into claims at separate evidence levels:

1. **Observation:** a measured property changed.
2. **Association:** structure/composition and property co-vary.
3. **Mechanism:** an intervention-specific causal path survives discriminating tests.
4. **Material proof:** independent batches retain full-window performance.
5. **Device proof:** junction/leg/module closes against a physical model.
6. **Service proof:** output and integrity survive specified combined stress.

Never promote a result beyond the highest completed level.

## 2. Experimental design

Write a hypothesis matrix with intervention, predicted intermediate state, primary endpoint, independent discriminator, counter-hypothesis, control, sample count, and stop/go threshold. Use compositionally verified baselines. Randomize run/order when drift is plausible; block by batch/furnace/deposition run; repeat the winning condition in independent batches.

Use one-factor designs for a clean single lever. Use factorial/response-surface designs when anneal, composition, thickness, pressure, or binder interactions are expected. Avoid many simultaneous additives that make attribution impossible. Predefine exclusion rules and retain negative samples.

## 3. Metrology and uncertainty

Build a measurement budget before synthesis. Include specimen consumption and sequence so heat treatment or polishing does not silently alter later specimens. Calibrate thermocouples, voltage offsets, dimensions, thickness, density, standards, radiation corrections, and contact geometry.

For a derived quantity `y = f(x_i)`, propagate covariance where inputs share specimens/calibrations. Report raw observables and uncertainty before PF, `kappa_L`, or `zT`. Perform sensitivity analysis for Lorenz number, heat capacity model, emissivity, thickness, density, and temperature errors. Do not combine the best `S`, `sigma`, and `kappa` from different specimens.

## 4. Mechanism tests

Prefer orthogonal evidence:

- carrier tuning: composition + Hall field sweep + mobility at matched carrier concentration;
- band changes: phase-aware calculation/spectroscopy + transport signature beyond doping;
- phonon scattering: quantified defect length scale + density-matched thermal data + robust `L/Cp` sensitivity;
- texture: pole figure/EBSD + direction-matched transport;
- contacts: transfer-length/four-wire contact measurement + cross-section chemistry + aging kinetics;
- flexibility: strain model + in-cycle electrical response + damage imaging.

Calculation predicts; it does not establish experimental solubility, defect concentration, phase purity, or lifetime.

## 5. Failure-driven iteration

When a target fails, rank competing explanations by likelihood and decision value. Run the cheapest discriminating test that can reverse the next decision. Examples: remeasure geometry before resynthesizing; map actual device temperatures before changing material; cross-section a failed interface before averaging bulk chemistry.

Predefine stopping rules for irreproducible baselines, unclosed composition, physically implausible derived values, unsafe synthesis, unavailable n-leg/contact compatibility, or performance gains smaller than combined uncertainty and manufacturing variance.
