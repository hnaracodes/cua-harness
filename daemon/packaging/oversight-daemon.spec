# PyInstaller spec for the oversight-daemon sidecar. Run through packaging/build.sh.
# One-file console binary: Tauri's externalBin ships exactly one executable per target.
import os

from PyInstaller.utils.hooks import collect_submodules

daemon_dir = os.path.abspath(os.path.join(SPECPATH, ".."))

hiddenimports = (
    collect_submodules("oversight")
    # uvicorn picks its loop/protocol/lifespan implementations by import string.
    + collect_submodules("uvicorn")
    # keyring discovers its OS backends through entry points, which PyInstaller cannot see.
    + collect_submodules("keyring.backends")
)

a = Analysis(
    [os.path.join(SPECPATH, "entry.py")],
    pathex=[daemon_dir],
    datas=[(os.path.join(daemon_dir, "oversight", "dimensions.yaml"), "oversight")],
    hiddenimports=hiddenimports,
    # peripheral is testing/'s package, imported only by the testing/ adapter. The rest
    # are its heavy dependencies, which the daemon itself never needs.
    excludes=["peripheral", "numpy", "pandas", "pyarrow", "tkinter", "pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="oversight-daemon",
    console=True,
    upx=False,
)
