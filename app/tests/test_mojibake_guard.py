from pathlib import Path


MOJIBAKE_MARKERS = (
    "ï¿½",
    "ðŸ",
    "â€”",
    "â€“",
    "â€",
    "â†",
    "fï",
    "Ã©",
    "Ã¨",
    "Ã±",
)


def test_user_facing_assets_have_no_mojibake_markers():
    root = Path(__file__).resolve().parents[1]
    targets = [root / "static", root / "templates"]

    offenders = []
    for target in targets:
        for path in target.rglob("*"):
            if not path.is_file():
                continue
            if path.suffix.lower() not in {".js", ".css", ".html"}:
                continue

            text = path.read_text(encoding="utf-8", errors="ignore")
            for marker in MOJIBAKE_MARKERS:
                if marker in text:
                    offenders.append(f"{path.relative_to(root)} contains '{marker}'")

    assert not offenders, "Mojibake markers detected:\n" + "\n".join(offenders)
