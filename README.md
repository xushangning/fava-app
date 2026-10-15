# Fava app

[Fava](https://github.com/beancount/fava), the web interface for
[Beancount](https://github.com/beancount/beancount), packaged as a standalone
macOS app (Apple silicon) with Electron.

Like Preview, launching the app asks for a Beancount file and shows Fava for it;
**File > Open…** (⌘O) switches to another file. The next launch reopens the
last opened file, and a file given as the last command-line argument is opened
directly. The Fava server is bundled with PyInstaller, so no Python
installation is needed.

## Updating Fava

The bundled versions of Fava and its dependencies are pinned in
`requirements.txt`. To update, change the versions in `requirements.in` and run:

```sh
uv pip compile --universal --python-version 3.13 requirements.in -o requirements.txt
```

## Building locally

```sh
npm ci
npm run build:fava       # PyInstaller bundle in build/dist/fava
npm start                # run from source
npx electron-builder     # package into build/app (zipped app on macOS)
```

## Tests

`npx playwright test` drives the app with Playwright, with the native dialogs
replaced by `test/stub-dialogs.js`. Set `APP_EXECUTABLE` to the binary of a
packaged app (e.g. `Fava.app/Contents/MacOS/Fava`) to test that instead. On
Linux without a display, run the tests under `xvfb-run`.

## License

The packaging code is licensed under the GPL v3 (see `LICENSE`). Fava, the app
icon (`resources/Fava.icon`, made from `contrib/icon.svg` in the Fava
repository) and the test ledgers in `test/data` come from the Fava project and
are under its MIT license (`test/data/LICENSE-fava`).
