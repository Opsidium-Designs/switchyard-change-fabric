# Reference solutions

Proof that an example app's planted gaps are solvable, kept OUTSIDE the app
directory on purpose: a run copies only the app directory into its repos, so
no agent ever sees these files. They are for the maintainers of the example,
not hints for a run.

## cityhall

`cityhall/` holds full-file replacements for `examples/apps/cityhall`: every
route module and the three shared contracts that change (money, time,
validate), plus the two developer tests under `tests/` with the contract change
accepted. Files not listed here are unchanged.

`check-cityhall.mjs` copies the app to a temp directory, runs its gate on the
baseline (expected to FAIL), overlays these files, and runs the gate again
(expected to PASS), printing the acceptance counts for both:

```bash
make cityhall-reference-check
```

It is offline and leaves the app directory untouched. Keep the reference in
step with the app: a change to the app's gate, contracts, or routes should be
followed by a passing reference check.
