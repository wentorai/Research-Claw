* Stata table template: iv_2sls.do for econ-tables-cn
clear
set more off
version 17
* Replace this toy setup with your cleaned research dataset.
set obs 100
gen firm_id = ceil(_n/5)
gen year = 2000 + mod(_n, 10)
gen y = rnormal()
gen x = rnormal()
gen control = rnormal()
* Recommended packages: estout, reghdfe, ivreg2 where licensed/available.
capture which esttab
if _rc di as txt "Install estout if needed: ssc install estout"
reg y x control, vce(cluster firm_id)
estimates store m1
reg y x control i.year, vce(cluster firm_id)
estimates store m2
* Export with booktabs in real projects.
estimates table m1 m2, b(%9.3f) se stats(N r2)
* Quality gates:
* 1. Report N.
* 2. State cluster level.
* 3. State fixed effects.
* 4. Keep row order consistent.
* 5. Add data source in table note.
