"""Run the reversible authenticated synthetic directly against Render only."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from deployment.authenticated_smoke import (
    DEFAULT_RENDER_URL,
    EMAIL_ENV,
    PASSWORD_ENV,
    TOKEN_ENV,
    SmokeFailure,
    _login,
    _validate_target,
    run_authenticated_smoke,
)


async def run_render_synthetic(render_url: str, token: str) -> dict:
    report = await run_authenticated_smoke(render_url, render_url, token)
    report.pop("cloudflare_url", None)
    report["target_url"] = render_url
    report["mode"] = "direct-render"
    report["checks"] = [
        check.replace("cloudflare_", "render_repeat_")
        for check in report["checks"]
    ]
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--render-url", default=DEFAULT_RENDER_URL)
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--json-output")
    args = parser.parse_args()

    try:
        render_url = _validate_target(args.render_url, args.allow_remote)
    except ValueError as exc:
        parser.error(str(exc))

    token = os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        email = os.environ.get(EMAIL_ENV, "").strip()
        password = os.environ.get(PASSWORD_ENV, "")
        if not email or not password:
            parser.error(
                f"Set {EMAIL_ENV} and {PASSWORD_ENV}; credentials are not accepted as command arguments"
            )
        try:
            token = _login(render_url, email, password)
        except SmokeFailure as exc:
            parser.error(str(exc))

    report = asyncio.run(run_render_synthetic(render_url, token))
    output = json.dumps(report, indent=2)
    print(output)
    if args.json_output:
        with open(args.json_output, "w", encoding="utf-8") as handle:
            handle.write(output + "\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())