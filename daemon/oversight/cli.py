"""`oversight-daemon` entry point."""

from __future__ import annotations

import argparse
import logging


def main() -> None:
    p = argparse.ArgumentParser(prog="oversight-daemon",
                                description="Sketch Oversight daemon (FastAPI + SSE).")
    p.add_argument("--fixtures", action="store_true",
                   help="docs/00 tennis-racket plan with fixed scores, no API calls; "
                        "simulated executor unless --exec live")
    p.add_argument("--exec", dest="exec_mode", choices=["live", "simulated"], default=None,
                   help="executor mode (default: live, or simulated with --fixtures)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="127.0.0.1")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

    import uvicorn

    from .api import create_app
    from .settings import load_settings

    settings = load_settings(fixtures=args.fixtures, exec_mode=args.exec_mode, port=args.port)
    settings.host = args.host
    log = logging.getLogger("oversight")
    log.info("provider=%s model=%s fixtures=%s exec=%s env=%s db=%s",
             settings.display_provider, settings.display_model, settings.fixtures,
             settings.exec_mode, settings.env_file, settings.db_path)
    app = create_app(settings)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
