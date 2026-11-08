# Frozen-hash report

Pre-edit verification was performed directly against the downloaded Drive archive before source edits. The requested archive size and SHA-256 matched, and both frozen files matched their expected hashes. The same archive was downloaded again and its file hashes were rechecked against the release tree.

- Drive file ID: `1Ff4OHfoGJGIHJp1NkvJcitEwhj2cEfQM`
- Certified archive size: 79,028 bytes (expected 79,028)
- Certified archive SHA-256: `4f7f364ab08cf88293b1217186c722e816963ccb8ac32c560257d9d3bda491b0` (expected `4f7f364ab08cf88293b1217186c722e816963ccb8ac32c560257d9d3bda491b0`)
- Archive result: **PASS**

| Frozen file | Bytes | Expected SHA-256 | Certified archive SHA-256 | Release tree SHA-256 | Result |
|---|---:|---|---|---|---|
| `ROOM-CONTRACT.md` | 16,069 | `f2944f94d951af8242df27663048f3cd126b92bf963a69b67e204952318bab1e` | `f2944f94d951af8242df27663048f3cd126b92bf963a69b67e204952318bab1e` | `f2944f94d951af8242df27663048f3cd126b92bf963a69b67e204952318bab1e` | **PASS** |
| `verify.ts` | 32,707 | `888152785e0cc958dc927718f1a56a3aaf276fea423fc8b4d4211845f66503ff` | `888152785e0cc958dc927718f1a56a3aaf276fea423fc8b4d4211845f66503ff` | `888152785e0cc958dc927718f1a56a3aaf276fea423fc8b4d4211845f66503ff` | **PASS** |

No contract, verifier, canonical-format, or event-body edits were made.
