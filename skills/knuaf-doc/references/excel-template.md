# Reusable XLSX template workflow

Source identity, author/authority separation, physical sheet ranges, and task
records follow [source-contract.md](source-contract.md). This page documents
only the reusable CLI contract.

`scripts/gg_excel_template.py` creates a local, source-bound blank copy of an
existing school workbook. It does not generate a new 17-sheet model and does
not correct legacy formulas.

```text
python3 scripts/gg_excel_template.py inspect \
  --source "/path/to/source.xlsx" \
  --out-map build/template-review/source-map.json \
  --report build/template-review/inspect-report.json

python3 scripts/gg_excel_template.py clear \
  --source "/path/to/source.xlsx" \
  --map build/template-review/source-map.json \
  --out build/template-review/blank-v1.xlsx \
  --receipt build/template-review/receipt-v1.json
```

`inspect` records the source SHA-256, all observed cells/formulas, sheet order,
and an explicit per-sheet map. The map records `semanticField`, `reason`, and
`action` (`clear` or `preserve`). `clear` refuses a source whose SHA-256 no
longer matches the map and refuses to overwrite an existing output or receipt.

The copy operation removes values only from mapped non-formula cells. Formula
expressions, cell styles, merged ranges, sheet names/order, print settings,
drawings, images and links remain in the copied archive. Formula cached values
are invalidated and the workbook is marked for recalculation when opened, so a
blank template does not show stale financial results. Existing formulas are
never repaired or rewritten.

The receipt reports cleared cells, mapped formulas protected, merged-cell
protection, formula caches invalidated, and hard-coded numeric cells left
outside the map as `ambiguousCount`. A `partial` status is expected when such
legacy constants remain; it is not a clean financial model or a submission
approval. The reference model-farm sheet is explicitly preserved as an
example-only reference. Shared-string entries and other private sample data
are not anonymized or publication-ready by this utility.

Choose a new output directory or versioned filenames for each run. Counts and
status must come from that run's source-bound map and receipt. A previous
developer's template, receipt, school workbook or private sample is not a
dependency of the installed plugin. Register the workbook supplied for the
current project and retain its hash and source role. The source workbook is
never written. An NFD filename is resolved when an NFC path is supplied.

## Input-sheet roles in the supplied school template

User-confirmed on 2026-09-15: in the current numbered 17-sheet school workbook,
excluding the contents sheet, red input sheets are 1, 3, 4, 5, 6, 7, 8, 9 and 10.
They cover initial finances, investment, loan repayment, sales, production,
materials, labor, expenses and depreciation. Yellow and green sheets contain
linked calculations. Confirm the actual sheet names, tab colors and source hash
when applying this mapping; a different template needs its own role map.

Write plan values only to reviewed input cells on those red sheets. A red tab
does not make every cell editable: preserve formulas, merges and labels unless
a separately documented correction is required. Do not type desired totals into
yellow/green calculation cells. Recalculate them and reconcile them to the inputs
and manuscript. An input quantity may legitimately be a numeric constant whose
calculation is explained in the manuscript or evidence; do not demand that every
student input become an Excel formula.

An inherited formula defect is separate from missing student input. Compare it
with the supplied original, record whether it was inherited or introduced, and
use the reviewed formula-correction workflow below on a copy. Do not treat tab
color as approval for arbitrary formula changes. Investment analysis absent from
the prescribed workbook can be verified in a separate calculation artifact;
do not add sheets to the submission form merely to satisfy a preferred model.

## Saved-file compatibility verification

The generator preserves original XML namespace prefixes and declarations with
DOM edits. Markup Compatibility attribute values (including unqualified
`mc:Choice/@Requires`) must resolve in their original namespace scope. Invalid
references fail before publication. ZIP integrity and generic XML parsing alone
do not establish that Excel can open a workbook.

Before recommending a generated copy as usable, open an isolated read-only copy
in the target spreadsheet application with repair alerts enabled, confirm the
expected worksheets, and inspect a native preview/render. Bind that evidence to
the delivered file hash. Record application/OS scope; unavailable native checks
remain unverified. A successful open is separate from financial recalculation
and submission approval.

## Fill the reviewed copy with current inputs

Blanking and filling are separate operations. A cell preserved during blanking
may contain an exemplar year, price or ratio. It becomes a student input only
after its role, period and source are reviewed. Never silently reuse it.

Run `python3 scripts/gg_excel_fill.py --template blank.xlsx --map write-map.json
--values current-values.json --out filled-v1.xlsx --receipt filled-v1-receipt.json`
with real paths. Always retain the receipt for the project workflow.

The write-map schema is `gg-xlsx-fill-map/v1`. Its `template.sha256` must match
the actual input copy. Each `entries` item names an exact `sheet`, `cell` or
`range`, semantic `role`, applicable `period`, `source_note`, and explicit
`editable: true`. This is not the `inspect|clear` map schema.

The values schema is `gg-xlsx-fill-values/v1`. Each item in `values` names an
exact `sheet` and `cell`, `value`, `value_type` (`string`, `integer`, `number`,
`boolean`, or `blank` with null), and `evidence_ref` containing `source_id`,
`revision`, `locator`, and `origin` (`factual`, `assumption`, or `synthetic`).
Register those source IDs/revisions in the project and read the actual source;
the utility checks the supplied structure, not whether a citation is true.
Synthetic inputs belong only to clearly labeled development fixtures.

Unknown values stay unresolved in the project. An explicit blank removes the
cell value; the spreadsheet may calculate a zero, partial sum or error. None
of these proves that the unknown equals zero. Keep affected conclusions
blocked and explain the limit in the manuscript. Omitted mapped cells remain
unchanged and are counted in the receipt.

The utility refuses stale hashes, duplicate/overlapping targets, unknown
sheets/cells, formula writes and merged non-anchor writes. It preserves
formulas/formatting and invalidates formula caches. The receipt binds template,
map, values and output hashes and records each old/new value with its evidence.
It may contain private inputs and is not a public artifact.

After filling, recalculate in the spreadsheet application and compare the
saved 17-sheet values with the manuscript. Check inherited formulas, including
channel/grade ratios and period offsets. `filled` means mapped values were
written; it is not calculation or content approval. Formula corrections need
a separate reviewed change and dependent checks; this utility never rewrites
formulas. Corrections create a new input/output revision and invalidate old
review claims through the project ledger.

## Declare display rounding where the manuscript shows rounded numbers

When the recalculated workbook is compared with the manuscript, every figure
is checked digit for digit: the printed number must equal the stored workbook
value exactly. If a passage deliberately prints a rounded figure, the rounding
has to be declared right next to that figure; without a declaration the
comparison stays exact and reports a mismatch.

Write the declaration in the same clause as the claim, or in the owning
table's own caption or note, naming the unit and the number of decimal places
kept:

- `… 당기순이익은 4,289.7 천원(소수 1자리까지 반올림하여 표시)이다.`
- `표 1. 농장A 손익 (단위: 천원, 소수 1자리까지 반올림하여 표시)`
- `주) 천원은 소수 3자리까지 반올림하여 표시한다.` — a table note works too
- `소수 0자리까지` or `정수로 반올림하여 표시` for whole-number display

반올림 here is the everyday rule: at the cut position a discarded digit of 5
or more raises the last kept digit, so `14532.549` becomes `14532.5` and
`14532.550` becomes `14532.6`. Negative amounts round away from zero in the
same manner (`-14532.55 → -14532.6`).

The declaration is local and is applied strictly:

- It governs only its own claim clause or its own table. A neighbouring
  sentence, clause or table cannot borrow it.
- The unit tied to the declaration must be the unit of the figure being
  compared; a declaration written about `원` does not apply to a `천원`
  figure.
- The number of places must be explicit. A bare `반올림하여 표시` with no
  place count, two different place counts for the same unit, or an
  unreasonable count is not a usable declaration: the figure is reported as
  a mismatch instead of being quietly compared exactly.
- With a valid declaration, the workbook value is rounded to the declared
  places for comparison only — the printed figure itself is never
  re-rounded. Printing the full-precision value (`14,532.549`) or a
  differently rounded one (`14,532.4`) under a one-place declaration still
  fails.

The stored workbook values and every formula keep full precision at all
times. A rounded display figure is presentation only; never reuse it as an
input to another calculation.

Accounting-style negatives are read only inside table cells: a cell whose
whole value is `(N)` — one matched ASCII parenthesis pair around an
unsigned integer or decimal, e.g. `(121,246.7)` — is compared as `-N`,
and `(N) 천원`-style trailing units follow the same unit rules as plain
cells. Signed forms inside or before the parentheses (`(-N)`, `(+N)`,
`-(N)`), nested or unbalanced parentheses, malformed commas, letters or
units inside the parentheses, and trailing junk are rejected rather than
interpreted. Sentence claims and workbook prose comparisons do not read
parenthesized negatives — there they still need an explicit `-` sign.
Fullwidth parentheses and other notations are unsupported.


## Correct a verified formula defect in a copy

Preserving formulas during blanking/filling does not certify the example's
arithmetic. If a formula uses the wrong area, period or loan condition, record
the evidence and exact old/new expression before modifying a new copy. Never
silently alter the student's plan to fit an example formula.

`gg_excel_formula_patch.py --source copy.xlsx --map formula-map.json --out
patched.xlsx --receipt patch-receipt.json` accepts `gg-xlsx-formula-patch-map/v1`
with `source.sha256` and `patches`: exact `sheet`, `cell`, `expected_formula`,
`new_formula`, `reason`, and `evidence_ref` (`source_id`, `revision`, `locator`).
Ordinary existing formulas use `expected_formula`. An explicitly reviewed numeric constant can instead use `expected_value` (finite number, exact decimal match) to restore a missing calculation; this must never be an implicit conversion. The receipt records the original numeric text and `value_to_formula` operation. For a shared-formula target, the utility materializes only its complete rectangular shared group using the unique anchor and relative/absolute reference translation, then checks the exact effective `expected_formula`. The receipt lists every materialized member in `expanded_shared_formulas`; unrequested members must retain their effective formulas. Missing or ambiguous anchors/ranges, incomplete groups, array formulas and unsafe translations are refused. Materialization is not permission to alter unrequested formulas. The source is preserved and mismatched formulas,
external formulas, duplicate targets and overwrite attempts are refused.
Both old/new formulas are recorded and caches are invalidated. A patch receipt
is an execution record; independent arithmetic and native checks still apply.
Update the fill map hash to the patched copy before filling it.

For native output from a supplied template, use `gg_office.py excel filled.xlsx
--template-receipt filled-receipt.json --out-dir native-v1`. This checks the fill
receipt's input binding and compares saved sheet order, visibility, merges,
print ranges, formulas and values against this copy. It does not apply the
legacy generator's fixed cell contract. Native number-format changes are listed
for visual review; fonts, row/column layout and full pages still require render
inspection. `financial_content_validation: not_run` remains explicit until the
separate current-input financial/body comparison is recorded. Do not combine
this option with a legacy generated-workbook `--spec`.

### Print-layout copy

Native PDF inspection may reveal orphaned columns or split table blocks even when all cells and formulas are correct. Prepare a `gg-xlsx-print-map/v1` map bound to `source.sha256`, with explicit sheet names, `fit_width` (positive integer), `fit_height` (0 for unlimited or positive), optional orientation and existing print-area rectangle, optional `row_breaks` (unique positive row numbers; `fit_height: 0`) to keep complete table blocks together, and a reason for each change. Run `python3 scripts/gg_excel_print.py --source copy.xlsx --map print-map.json --out print-copy.xlsx --receipt print-receipt.json` before typed input filling. It changes only print settings in a new copy and records the change; render every final PDF page to judge readability. Do not shrink a long table to an unreadable page merely to reduce page count. An original exemplar footer, year, crop, source attribution or percentage is editable case data when it describes the previous author's case: explicitly replace it from current evidence and record provenance, instead of retaining a misleading example claim.

A plan may also provide explicit `row_heights` and `wrap_cells` entries when a native preview exposes a local readability defect. `row_heights` is a list of `{ "row": <existing row number>, "height": <finite number> }`; heights must be greater than 0 and at most Excel's 409.5-point limit. `wrap_cells` is a list of exact existing cell references (for example `B6`). The utility rejects missing rows/cells, duplicate targets, out-of-range values, and merged non-anchor cells. Wrapping clones the selected cell's `xf`, appends a unique style record, and sets `alignment wrapText="1"`; it never mutates a shared style or cell value/formula. Receipts list row-height and style changes separately while `cell_changes` remains zero. No global row or column formatting is inferred. If `cellXfs` uses an `AlternateContent` with more than one effective `xf` branch (for example both `Choice` and `Fallback`), wrapping is refused because branch selection is application-dependent; no style is guessed.

### Meaning and yearly references

For a verified rate displayed as zero by an integer format, an explicit
`number_formats` entry can use `0.00%`. The stored fraction and its dependent
formulas remain unchanged; verify the displayed rate in the native PDF.
Fractional labor days can use an explicit `#,##0.00` override without rounding
the stored days or changing the labor-cost formula.

A zero error-cell count is not a financial review. Check first-year ratios and subtotals against the remaining years; trace each yearly rent, tools, other expense, subsidy and investment row to that same year, including subtotal-to-detail links and cumulative balances. Compare written rate/period notes with formulas. Use a separate nonzero, different-per-year probe or inspect every corresponding reference: all-zero sample costs can hide copied first-year references. Keep probe values out of the student plan. A hidden reference/helper cell must never influence a printed result without a labeled input and source. Record the tested assumptions and applicability of each correction; do not force a student's loan, depreciation, rent or grant-accounting conditions to match the exemplar. Explicit no-expense answers in a synthetic fixture may be zero; missing real answers remain unknown.


### Registering a verified supplied-template output

After the native Excel conversion, copy its manifest into the project workspace.
Register the current XLSX output with `layout_kind: "provided_template"` and
`native_manifest: {"path": "<workspace-relative manifest>", "sha256": "<actual hash>"}`.
The manifest must bind the current workbook hash, a successful Microsoft Excel
run, `validation.excel.valid: true`, and `school_validation:
"source_template_preservation_only"`, with no structure/school issues. The
runtime also scans the 17-sheet workbook for formula and cached error cells.
This route preserves the supplied form's coordinates; it does not certify
financial interpretation or replace independent content and print review.
Do not label an unverified workbook or an old output with this tag to bypass
checks. Native Excel is the verified adapter currently implemented for this
route; another application requires its own tested adapter and evidence.

### Verify the complete operation lineage

After all filling, formula/layout changes and native saves, check the ordered
receipt chain rather than refreshing an old receipt's output hash:

```text
python3 scripts/gg_office.py verify-template-lineage final.xlsx \
  --receipts clear-receipt.json fill-receipt.json layout-receipt.json \
  native/final.office.manifest.json --json
```

List every intervening operation in execution order, including intermediate
native manifests. The chain must begin with a clear or fill receipt. Every
declared input, map, values file, output and native PDF must still match its
recorded hash; each operation's source must match the preceding output.
Native manifests must bind the preceding operation receipt. Relative artifact
paths resolve beside their receipt. Missing paths, omitted transformations,
wrong ordering and a different final workbook are refused.

The result's `authority: operation_lineage_only` proves file linkage, not
independent truth, arithmetic, privacy, readability or professor approval.
Receipts are local records from the selected project. The CLI may resolve an
absolute artifact path when a source and its receipt live in different
folders; that path is checked for existence and exact hash, not certified as
an approved source merely because it was named. Do not adopt receipts found
in an unrelated reference folder as the current project's records. Inspect
the selected source role and operation chain before using the result. This
local trust model does not prevent a user with equal filesystem write access
from forging all records; it is not a signature or professor identity service.
A clear operation's `partial` status remains visible in the result and is
not promoted. Hash-only legacy receipts can support the older single-operation
binding but cannot establish complete lineage. Do not manufacture a missing
native receipt after manual recovery; preserve the gap and re-execute that
stage through the observed adapter before claiming an unbroken chain.
