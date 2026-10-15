# vim: set ft=python:
"""PyInstaller spec file for the Fava server bundled in the app.

Based on contrib/pyinstaller_spec.spec in the Fava repository, as a one-folder
bundle, which avoids unpacking the whole executable on every start.
"""

from __future__ import annotations

from PyInstaller.utils.hooks import collect_data_files
from PyInstaller.utils.hooks import collect_submodules
from PyInstaller.utils.hooks import copy_metadata

# Data files and version info for Fava:
datas = collect_data_files("fava") + copy_metadata("fava")

# Add all Beancount code (for plugins) and the version file:
hiddenimports = collect_submodules("beancount")
datas += collect_data_files("beancount")

# beanquery loads its table sources dynamically:
hiddenimports += collect_submodules("beanquery")

a = Analysis(
    ["fava_main.py"],
    datas=datas,
    hiddenimports=hiddenimports,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="fava",
)

coll = COLLECT(exe, a.binaries, a.zipfiles, a.datas, name="fava")
