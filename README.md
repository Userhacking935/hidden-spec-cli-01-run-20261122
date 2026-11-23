# mend

One patch tool for every AI edit format.

`mend` applies edits that AI models write, in four formats, to a tree of
text files: unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and text-editor tool calls as JSON. It reads them to one
written specification, finds the lines an edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`)
followed by `ok: N files`. Exit 1 lists every failed edit and a
`failed: K of N edits` line, and writes nothing. Exit 2 reports a usage,
missing-patch, format or parse error on one line.

## Requirements

Node 22 and its standard library alone: nothing is installed before the
program runs. The program is deterministic: the same check gives the same
exit code, stdout and files every run.

`runner.ts` beside `main.ts` is the kit's trial runner: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands a trial over to it.

## License

MIT. See `LICENSE`.
