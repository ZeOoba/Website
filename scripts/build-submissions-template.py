#!/usr/bin/env python3
"""Builds netlify/functions/_shared/submissions-template.xlsx from submissions-schema.json.

One worksheet + one Excel Table per form type (plus "Other Forms"), leading with
Received (ET) / Submission ID / Status and trailing with Other Fields (JSON) /
Notes. Each table carries ONE blank placeholder body row (Excel requires a body
row); submissions-ledger.js fills it in place on the first submission.

Run: python3 scripts/build-submissions-template.py   (needs openpyxl)
Re-run whenever submissions-schema.json changes, commit the regenerated xlsx.
"""
import json, pathlib
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "netlify/functions/_shared/submissions-schema.json").read_text())
OUT = ROOT / "netlify/functions/_shared/submissions-template.xlsx"

NAVY, GOLD, PARCH = "1B2A4A", "C9A96E", "F5F3EF"
LEAD = ["Received (ET)", "Submission ID", "Status"]
TAIL = ["Other Fields (JSON)", "Notes"]
WIDE = {"Message", "Details", "Transcript", "Business Requirements", "Reason for Selling", "Detail", "Score Breakdown", "Other Fields (JSON)", "Notes"}
STATUSES = '"New,Reviewed,In Progress,Converted,Declined,Spam,Archived"'

wb = Workbook()
readme = wb.active
readme.title = "README"
lines = [
    ("ORA Website Submissions", True),
    ("Every Netlify form submission from oxfordra.net is appended here by the submissions-ledger function.", False),
    ("", False),
    ("Rules", True),
    ("1. One tab per form; each tab is an Excel Table. Add columns or reorder freely: rows are written by header name.", False),
    ("2. Do NOT rename a table, rename the Submission ID / Received (ET) / Status headers, or delete a tab; the function addresses them by name.", False),
    ("3. Work the Status and Notes columns; leave the submitted columns as received. Netlify holds the raw submission as the system of record.", False),
    ("4. Contains applicant PII. Keep this file in its restricted SharePoint folder; do not email or copy it elsewhere.", False),
    ("5. A duplicate Submission ID means a webhook redelivery slipped past the dedupe check; delete the extra row.", False),
    ("6. Unlisted fields land in Other Fields (JSON). Unlisted forms land in the Other Forms tab.", False),
]
for i, (text, bold) in enumerate(lines, start=1):
    c = readme.cell(row=i, column=1, value=text)
    c.font = Font(name="Arial", bold=bold, size=14 if i == 1 else 11, color=NAVY)
readme.column_dimensions["A"].width = 140

def add_sheet(sheet, table, fields):
    ws = wb.create_sheet(sheet[:31])
    headers = LEAD + fields + TAIL
    for col, h in enumerate(headers, start=1):
        c = ws.cell(row=1, column=col, value=h)
        c.font = Font(name="Arial", bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=NAVY)
        c.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(col)].width = 60 if h in WIDE else (20 if h in LEAD else 24)
    ref = f"A1:{get_column_letter(len(headers))}2"  # header + one blank placeholder row
    t = Table(displayName=table, ref=ref)
    t.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
    ws.add_table(t)
    ws.freeze_panes = "D2"
    ws.sheet_properties.tabColor = GOLD
    dv = DataValidation(type="list", formula1=STATUSES, allow_blank=True)
    ws.add_data_validation(dv)
    dv.add("C2:C5000")
    for row in ws.iter_rows(min_row=2, max_row=2, min_col=1, max_col=len(headers)):
        for c in row:
            c.font = Font(name="Arial", color="2D2D2D")

for form, d in SCHEMA["forms"].items():
    add_sheet(d["sheet"], d["table"], [h for _, h in d["fields"]])
add_sheet(SCHEMA["fallback"]["sheet"], SCHEMA["fallback"]["table"], ["Form"])

wb.save(OUT)
print(f"wrote {OUT} ({len(SCHEMA['forms']) + 1} tables)")
