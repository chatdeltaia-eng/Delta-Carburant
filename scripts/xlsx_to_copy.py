#!/usr/bin/env python3
"""Convertit la feuille NAJIB en lignes COPY TSV, sans dépendance externe."""
import sys
from zipfile import ZipFile
from xml.etree import ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

def column_index(reference):
    letters = "".join(c for c in reference if c.isalpha()).upper()
    value = 0
    for letter in letters:
        value = value * 26 + ord(letter) - 64
    return value - 1

def clean(value):
    value = (value or "").strip()
    if not value:
        return r"\N"
    return value.replace("\\", "\\\\").replace("\t", " ").replace("\r", " ").replace("\n", " ")

def rows(path):
    with ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in item.iter(f"{{{MAIN}}}t"))
                      for item in root.findall(f"{{{MAIN}}}si")]
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        excel_rows = root.findall(f".//{{{MAIN}}}sheetData/{{{MAIN}}}row")
        for excel_row in excel_rows[1:]:
            values = [""] * 11
            for cell in excel_row.findall(f"{{{MAIN}}}c"):
                idx = column_index(cell.attrib.get("r", "A1"))
                value_node = cell.find(f"{{{MAIN}}}v")
                inline = cell.find(f"{{{MAIN}}}is")
                value = ""
                if value_node is not None:
                    value = value_node.text or ""
                    if cell.attrib.get("t") == "s":
                        value = shared[int(value)]
                elif inline is not None:
                    value = "".join(t.text or "" for t in inline.iter(f"{{{MAIN}}}t"))
                if idx < len(values):
                    values[idx] = value
            yield int(excel_row.attrib["r"]), values

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: xlsx_to_copy.py NAJIB.xlsx")
    for row_number, values in rows(sys.argv[1]):
        print("\t".join([str(row_number)] + [clean(v) for v in values]))

