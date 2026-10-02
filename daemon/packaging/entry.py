"""PyInstaller entry point for the `oversight-daemon` sidecar (see build.sh)."""

from oversight.cli import main

if __name__ == "__main__":
    main()
