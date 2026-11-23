# mend-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/willysaputra0505/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/willysaputra0505/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats — unified diff, SEARCH/REPLACE blocks, V4A patches and text-editor tool calls as JSON — to a tree of text files. It finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none. SPEC.md is the whole contract.

## Run it

```sh
node main.ts fix.patch
```

`node main.ts [options] [PATCH]` reads the patch from the file or from standard input when PATCH is absent or `-`. `--format=unified|search-replace|v4a|json|auto` picks the format, `--check` reports what would change without writing, and `--strict` matches lines exactly. A patch that changes nothing prints `ok: 0 files`; a failed edit prints its error and nothing is written.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env and runs `main.ts` on each one.
- `check.ts`: the practice set on your own machine: `node check.ts ../program/generator/practice.json`. It passes 100 of 100 practice checks (practice score 1000).
- `SPEC.md`: the specification.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
