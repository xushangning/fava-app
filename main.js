// Electron shell for Fava, modelled on macOS Preview: launching the app asks
// for a Beancount file, runs the bundled Fava server for it on a free local
// port and shows its web interface. File > Open switches to another file.
// A file given on the command line, or else the last opened file, is opened
// instead of asking for one.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { app, BrowserWindow, dialog, Menu, shell } = require("electron");

const STARTUP_TIMEOUT_MS = 120_000;
const isMac = process.platform === "darwin";

/** @type {BrowserWindow | null} */
let win = null;
/** @type {import("node:child_process").ChildProcess | null} */
let fava = null;
let picking = false;

/** Path of the Fava executable built with PyInstaller (see fava.spec). */
function favaBinary() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "fava", "fava")
    : path.join(__dirname, "build", "dist", "fava", "fava");
}

/** Get a free TCP port on localhost. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Resolve once the server answers an HTTP request. */
function waitForServer(url, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error("Fava exited during startup."));
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error("Timed out waiting for Fava to start."));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

function stopFava() {
  if (fava && fava.exitCode === null && fava.signalCode === null) {
    fava.kill();
  }
  fava = null;
}

/** Start Fava for the given file and resolve with its URL once it is up. */
async function startFava(file) {
  const port = await freePort();
  const child = spawn(
    favaBinary(),
    ["--host", "127.0.0.1", "--port", String(port), file],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (chunk) => {
    output = (output + chunk.toString()).slice(-4000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const spawnError = new Promise((_resolve, reject) => {
    child.on("error", reject);
  });

  const url = `http://127.0.0.1:${port}/`;
  try {
    await Promise.race([waitForServer(url, child), spawnError]);
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n\n${output}`.trim());
  }
  return { child, url };
}

/** Show Fava for the given file, replacing the currently open one. */
async function openLedger(file) {
  const { child, url } = await startFava(file);
  // Keep the previous Fava server running until the new page has loaded:
  // without its server, the previous page reloads itself, and loading the new
  // page aborts that reload, which makes loadURL() fail.
  const previous = fava;
  fava = child;
  fs.writeFileSync(lastFileRecord(), file);
  if (!win) {
    win = new BrowserWindow({ width: 1280, height: 860, show: false });
    // Links that Fava opens in a new tab go to the system browser.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith("http:") || target.startsWith("https:")) {
        shell.openExternal(target);
      }
      return { action: "deny" };
    });
    win.on("closed", () => {
      win = null;
      stopFava();
    });
  }
  try {
    await win.loadURL(url);
  } finally {
    previous?.kill();
  }
  win.show();
}

/** Open the file; if that fails, show the error and ask for another file. */
async function open(file) {
  try {
    await openLedger(file);
  } catch (error) {
    dialog.showErrorBox("Could not open file with Fava", error.message);
    if (!win) {
      await chooseAndOpen();
    }
  }
}

/** Ask for a Beancount file and open it. */
async function chooseAndOpen() {
  if (picking) {
    return;
  }
  picking = true;
  let result;
  try {
    const options = {
      title: "Open Beancount File",
      properties: ["openFile"],
      filters: [
        { name: "Beancount", extensions: ["beancount", "bean"] },
        { name: "All Files", extensions: ["*"] },
      ],
    };
    result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
  } finally {
    picking = false;
  }

  if (result.canceled || result.filePaths.length === 0) {
    // Like Preview, an app without a document stays open on macOS.
    if (!win && !isMac) {
      app.quit();
    }
    return;
  }
  await open(result.filePaths[0]);
}

/** The absolute path of the given file if it exists, otherwise null. */
function existingFile(file) {
  return file && fs.statSync(file, { throwIfNoEntry: false })?.isFile()
    ? path.resolve(file)
    : null;
}

/** Where the path of the last opened file is remembered. */
function lastFileRecord() {
  return path.join(app.getPath("userData"), "last-file");
}

/** The last opened file, if it still exists. */
function lastFile() {
  try {
    return existingFile(fs.readFileSync(lastFileRecord(), "utf8"));
  } catch {
    return null;
  }
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          {
            id: "open",
            label: "Open…",
            accelerator: "CmdOrCtrl+O",
            click: () => chooseAndOpen(),
          },
          { type: "separator" },
          isMac ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.whenReady().then(() => {
  buildMenu();
  // A file given on the command line, else the last opened one.
  const file = existingFile(process.argv.slice(1).at(-1)) ?? lastFile();
  return file ? open(file) : chooseAndOpen();
});

// Clicking the Dock icon without an open file asks for one again.
app.on("activate", () => {
  if (!win) {
    chooseAndOpen();
  }
});

app.on("window-all-closed", () => {
  if (!isMac) {
    app.quit();
  }
});
app.on("will-quit", stopFava);
