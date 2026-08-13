# Flexible Device Benchmarking and Reliability

## Contents

1. Comparability checklist
2. Mechanical protocol
3. Device protocol
4. Failure signatures

## 1. Comparability checklist

Build a row per device containing architecture, p/n materials, process, active thickness, substrate/encapsulant, heat-flow direction, footprint and active area, actual junction `DeltaT`, source/sink, curvature state, `Voc`, `Rint`, full load curve, `Pmax`, normalization equation, replicates, and uncertainty.

Do not rank `uW cm^-2`, `uW cm^-2 K^-2`, or `uW m^-2 K^-2` without checking unit conversion, area basis, and whether `DeltaT` is imposed or active. Recalculate from raw voltage/resistance/area when possible.

## 2. Mechanical protocol

Report mandrel/radius, bending mode, tension/compression side, total stack, layer thickness/modulus or neutral-axis model, frequency, dwell, cycles, environment, and electrical sampling state. Include monotonic minimum-radius testing and cyclic fatigue. Distinguish:

- resistance during bending versus after flattening;
- active-film damage versus electrode/contact/interconnect damage;
- elastic recovery versus stable performance;
- one local coupon versus full-device curvature.

Image/map cracks and delamination before and after. Define failure threshold before testing, such as irreversible resistance/output change plus structural evidence.

## 3. Device protocol

Attach temperature sensors near actual junctions with calibrated contact correction. Wait for defined steady state or report transient response explicitly. Sweep enough loads to locate maximum power and repeat sweeps to reveal drift. Report both output and retained temperature gradient during curvature/cycling.

For wearable/body-heat claims, report ambient, airflow, skin/source simulator, contact pressure, contact area, heat sink/garment, motion, and subject/safety protocol. A brief on-body `Voc` demonstration is evidence of response, not continuous usable energy or service reliability.

## 4. Failure signatures

| Signature | Competing causes | Discriminators |
|---|---|---|
| `R` rises, `S` stable | film cracks, contact/interconnect fatigue | in-cycle mapping, four-wire segmentation, microscopy |
| `R` and `S` drift | oxidation, stoichiometry/dopant redistribution, phase change | composition depth map, XRD, atmosphere control |
| good flat output, poor bent output | contact opening, active `DeltaT` loss, neutral-axis error | thermal map, segmented resistance, strain model |
| good coupons, weak device | thermal spreading, fill factor, p/n/contact mismatch | junction thermometry and loss ledger |
| good dry cycling, humidity failure | electrode corrosion, polymer swelling, interfacial hydrolysis | controlled RH controls and cross-sections |

Choose the next experiment by ability to distinguish causes, not by convenience.
