# Evidence and Reporting Rules

## Contents

1. Evidence grades
2. Literature extraction
3. Comparability
4. Minimum reporting tables

## 1. Evidence grades

- **E0 — proposal/inference:** plausible but untested.
- **E1 — single observation:** one batch/specimen or abstract-only evidence.
- **E2 — controlled material evidence:** controls, full methods, uncertainty, and relevant structure/transport.
- **E3 — replicated mechanism:** independent batches plus orthogonal discriminator and counter-hypothesis tests.
- **E4 — device evidence:** actual boundary temperatures, complete load/heat-flow data, contacts and geometry reported.
- **E5 — service evidence:** repeat devices and predefined retention under combined application stress.

State source access level: metadata, abstract, full text, supplementary information, or independently reproduced data. Citation count and journal prestige are not evidence grades.

## 2. Literature extraction

For every numerical claim, extract DOI/stable URL, sample identity, composition method, process, phase/density, direction, temperature, specimen equivalence, raw properties, derived metric, uncertainty/replicates, and whether the number is peak, average, modeled, or measured device output.

For mechanisms, capture the authors' exact evidence and plausible alternatives. Use review papers to map the field; cite primary papers for record values and mechanisms. If supplementary methods are unavailable, downgrade confidence rather than reconstructing details from memory.

## 3. Comparability

Only rank records after aligning:

- carrier type and material family;
- temperature range and peak versus average metric;
- in-plane/cross-plane direction, substrate, film thickness, and density;
- measurement method and Lorenz/heat-capacity assumptions;
- device topology, actual junction `DeltaT`, active/footprint area, source/sink, load, and heat input;
- bend radius/strain, stack thickness, cycle protocol, and in-cycle versus recovered response.

Use “not comparable” as a valid outcome. Never silently convert heater temperature difference into device junction difference.

## 4. Minimum reporting tables

Use a claim–evidence table: claim; sample; method; primary observation; derived result; uncertainty; evidence grade; confounder; verdict.

Use a material-to-device loss ledger: ideal material prediction; contact loss; electrode/interconnect loss; thermal spreading/parasitics; mechanics/aging drift; measured device result; unexplained residual.

End every review with verified facts, bounded inferences, contradictions, missing measurements, and a decisive next test.

## Method sources

- Borup et al., *Measuring thermoelectric transport properties of materials*, Energy & Environmental Science 8 (2015), DOI: https://doi.org/10.1039/C4EE01320D — field measurement guide; use for method and cross-laboratory comparability questions.
- Heremans & Martin, Nature Materials (2023), DOI: https://doi.org/10.1038/s41563-023-01726-7 — short metrology perspective highlighting that uncertainty in derived `zT` is material; do not use this brief feature alone as a complete experimental SOP.
