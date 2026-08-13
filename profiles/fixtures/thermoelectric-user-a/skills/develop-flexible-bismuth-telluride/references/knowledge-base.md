# Flexible Bi2Te3 Knowledge Base

## Contents

1. Material and film physics
2. Architecture choices
3. Thermal translation
4. Research gaps
5. Source anchors

## 1. Material and film physics

Bi2Te3-family compounds are layered, anisotropic, narrow-gap thermoelectrics used near ambient temperature. Real films may be Bi/Te off-stoichiometric, oxidized, textured, porous, multiphase, or substrate-constrained. Measure final composition and phase; do not infer carrier type or transport from target composition alone.

Texture changes in-plane/cross-plane electrical and thermal transport and crack paths. Thin films also add grain boundaries, surface/interface scattering, residual stress, substrate thermal expansion, and thickness uncertainty. Report direction and substrate for every value.

Common p-type families include Sb2Te3-rich `(Bi,Sb)2Te3`; n-type families are Bi2Te3-rich with composition/doping control. A flexible device requires compatible p/n processes and contacts, not merely one good film.

## 2. Architecture choices

- **Thin inorganic film:** preserves dense inorganic transport but faces brittle cracking, Te loss, limited substrate anneal, and adhesion.
- **Composite/ink:** gains low-temperature printing and strain accommodation but introduces binder, porosity, percolation, and thermal/contact penalties.
- **Rigid islands/legs:** preserves bulk properties while substrate/interconnects supply flexibility; audit bulk, contact fatigue, and heat leakage.
- **Wavy/kirigami/origami:** geometry reduces active strain and can redirect heat flow; normalize to honest footprint/active areas.
- **Fiber/textile:** distributes curvature and improves wearability; audit junction count, contact resistance, encapsulation, wash/humidity, and source/sink coupling.

Separate material flexibility from structural flexibility. Compute beam strain only when geometry and neutral axis justify the model. For a thin layer far from the neutral plane, a first estimate scales with thickness/radius, but multilayer modulus/thickness and slip require laminate analysis.

## 3. Thermal translation

Most coupon films are measured in-plane while wearable heat flows largely through the stack. Model anisotropic film/substrate conduction, contact area, convection, skin/source impedance, heat sink, fill factor, and thermal spreading. The imposed hot-plate difference is not the active junction `DeltaT`.

For generators, verify `Voc`, internal resistance, full load curve, maximum power, active/footprint area, actual junction temperatures, and steady/transient conditions. For coolers, report heat lift and COP under a defined hot-side sink; flexibility can worsen heat rejection.

## 4. Research gaps

- direction-matched `S/sigma/kappa` on the same bent material state;
- paired thermoelectric/mechanical optimization rather than separate best specimens;
- stable low-resistance flexible contacts and p/n co-processing;
- credible cross-plane architectures with retained active `DeltaT`;
- standardized bending/strain, humidity, wash, thermal-cycle, and in-cycle reporting;
- yield, uniformity, Te/material utilization, throughput, and encapsulation evidence at useful area.

## 5. Source anchors

- Vieira et al., *Enhanced thermoelectric properties of Sb2Te3 and Bi2Te3 films for flexible thermal sensors*, Journal of Alloys and Compounds 774 (2019), DOI: https://doi.org/10.1016/j.jallcom.2018.09.324 — primary film/sensor case with substrate and device details.
- Zheng et al., primary Ag-doped supported-film/device study, Nature Sustainability 6, 180–191, DOI: https://doi.org/10.1038/s41893-022-01003-6 — authors report room-temperature film `zT` around 1.2, 2000 bends at 8 mm radius, and a distinct 40-pair device output density of 2.1 mW cm^-2 at `DeltaT = 64 K`; do not merge these into a bulk, efficiency, or universal reliability record.
- Lu et al., primary single-crystal-exfoliated p/n film/device study, Nature Nanotechnology, DOI: https://doi.org/10.1038/s41565-023-01457-5 — authors report p/n PF of 4.2/4.6 mW m^-1 K^-2 and 1000 bends; its reported normalized power density uses a study-specific length/temperature normalization and is not directly rankable against ordinary footprint power density.
- Norimasa et al., *Improvement of thermoelectric properties of flexible Bi2Te3 thin films in bent states during sputtering deposition and post-thermal annealing*, Journal of Alloys and Compounds 898 (2022), DOI: https://doi.org/10.1016/j.jallcom.2021.162889 — primary supported-film processing case; authors attribute PF improvement to curvature/process effects, which still requires independent stress/shrinkage evidence for causal transfer.
- You et al., primary rigid-leg/flexible-interconnect assembly study, Applied Thermal Engineering 202, 117818, DOI: https://doi.org/10.1016/j.applthermaleng.2021.117818 — authors report an 18-pair device using 0.38 mm rigid Bi2Te3-family legs; treat its output and bending endurance as structural-flexibility evidence, not a flexible-film record.
- Zhang et al., *High-performance flexible wavy-structure thermoelectric generator based on (Bi,Sb)2Te3 films for energy harvesting*, Journal of Power Sources 600 (2024), DOI: https://doi.org/10.1016/j.jpowsour.2024.234260 — primary structural-flexibility/device case.
- Huang et al., *Bi2Te3-based flexible thermoelectrics*, Materials Today Energy 44 (2024), DOI: https://doi.org/10.1016/j.mtener.2024.101643 — open review for route discovery; trace numerical claims to primary sources.
