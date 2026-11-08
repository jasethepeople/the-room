# Failure log

## Interrupted baseline command

- Observation: the initial chained baseline invocation returned exit status `137` while the test output was incomplete; no failing assertion appeared in the partial output.
- Cause: the command runner interrupted the execution before it delivered a complete test report.
- Resolution and disproof: a direct baseline `npm test` rerun completed successfully with all baseline cases passing and no assertion failures. Its full unedited output is retained as `delivery/BASELINE-TEST-OUTPUT.log`.

## Typecheck failure in the concurrent-budget test

- Observation: `tests/live-member.test.ts(239,89)` failed with TS2339 because `Property 'text' does not exist on type 'EventBody'`.
- Cause: TypeScript could not preserve narrowing across separate calls to `events.at(-1)`.
- Fix: store the last event once and narrow that value before reading its turn text. The test was retained; no assertion was weakened. The corrected final typecheck and test output are retained as `delivery/TYPECHECK-OUTPUT.log` and `delivery/TEST-OUTPUT.log`.
