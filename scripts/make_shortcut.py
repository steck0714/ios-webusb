#!/usr/bin/env python3
"""Generate the (unsigned) .shortcut file that holds the Shortcuts build.

usage: make_shortcut.py <ios-webusb.js> <out.shortcut>

The file is an XML property list with a single action, "Run JavaScript on Web Page"
(identifier `is.workflow.actions.runjavascriptonwebpage`, parameter `WFJavaScript`),
offered in the share sheet for Safari web pages. Since iOS 15 a shortcut has to be signed
before it can be imported from a file; on a Mac run

    shortcuts sign --mode anyone --input ios-webusb.unsigned.shortcut --output ios-webusb.shortcut
"""
import plistlib
import sys
import uuid
from pathlib import Path

ACTION_ID = "is.workflow.actions.runjavascriptonwebpage"


def build_workflow(js: str) -> dict:
    return {
        "WFWorkflowActions": [
            {
                "WFWorkflowActionIdentifier": ACTION_ID,
                "WFWorkflowActionParameters": {
                    "UUID": str(uuid.uuid4()).upper(),
                    "WFJavaScript": js,
                },
            }
        ],
        "WFWorkflowClientVersion": "900",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": False,
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": 61440,
            "WFWorkflowIconStartColor": 3031607807,
        },
        "WFWorkflowImportQuestions": [],
        "WFWorkflowInputContentItemClasses": ["WFSafariWebPageContentItem"],
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowTypes": ["ActionExtension"],
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    js = Path(argv[1]).read_text(encoding="utf-8")
    out = Path(argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        plistlib.dump(build_workflow(js), f, fmt=plistlib.FMT_XML, sort_keys=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
