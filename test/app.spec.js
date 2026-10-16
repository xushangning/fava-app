// End-to-end tests for the Electron app.
//
// By default this runs the app from source (using the Fava bundle in
// build/dist). Set APP_EXECUTABLE to the binary of a packaged app to test that
// instead. The native dialogs are replaced by test/stub-dialogs.js.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { test, expect, _electron: electron } = require("@playwright/test");

const DATA = path.join(__dirname, "data");
const STUB = path.join(__dirname, "stub-dialogs.js");
const isMac = process.platform === "darwin";

function sandboxArgs() {
  return process.platform === "linux" && process.getuid?.() === 0
    ? ["--no-sandbox"]
    : [];
}

/** A fresh data folder for the app (where it remembers the last file). */
function userDataDir() {
  return test.info().outputPath("user-data");
}

/**
 * Launch the app (packaged if APP_EXECUTABLE is set) with the given data
 * folder and arguments (e.g. a file to open). From source, the dialogs are
 * stubbed from startup and the file picker returns the given files in turn;
 * packaged apps ignore -r, so their stub is loaded after launch.
 */
async function launch(userData, args = [], files = []) {
  const common = [...sandboxArgs(), `--user-data-dir=${userData}`];
  if (!process.env.APP_EXECUTABLE) {
    return electron.launch({
      args: [...common, "-r", STUB, path.resolve(__dirname, ".."), ...args],
      env: { ...process.env, STUB_OPEN_FILES: JSON.stringify(files) },
    });
  }
  const app = await electron.launch({
    executablePath: process.env.APP_EXECUTABLE,
    args: [...common, ...args],
  });
  await app.evaluate((_electron, stub) => {
    process.mainModule.require(stub);
  }, STUB);
  return app;
}

const fromSource = process.env.APP_EXECUTABLE ? test.skip : test;

function dialogs(app) {
  return app.evaluate(() => globalThis.stubDialogs);
}

function windowCount(app) {
  return app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );
}

/** Queue a file (or nothing, to cancel) for the next picker; File > Open. */
function menuOpen(app, file) {
  return app.evaluate(({ Menu }, filePath) => {
    if (filePath) {
      globalThis.stubDialogs.files.push(filePath);
    }
    Menu.getApplicationMenu().getMenuItemById("open").click();
  }, file);
}

/** Resolve when the process exits (get it with app.process() beforehand). */
function exited(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => proc.once("exit", resolve));
}

/**
 * Whether a server accepts connections at the URL's host and port.
 *
 * This uses a plain TCP connection: Node's fetch can throw an uncatchable
 * "setTypeOfService EINVAL" on macOS when the server is just shutting down.
 */
function isServing(url) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), hostname);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

fromSource("launching asks for a file and opens it", async () => {
  const app = await launch(userDataDir(), [], [
    path.join(DATA, "example.beancount"),
  ]);
  const page = await app.firstWindow();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/example\//);
  await expect(
    page.getByRole("link", { name: "Food", exact: true }),
  ).toBeVisible();
  expect((await dialogs(app)).opened).toBe(1);
  expect(await windowCount(app)).toBe(1);
  await app.close();
});

fromSource("cancelling the picker at launch", async () => {
  const app = await launch(userDataDir());
  const proc = app.process();
  if (isMac) {
    // Like Preview, the app stays open without a window and asks again when
    // its Dock icon is clicked.
    await expect.poll(async () => (await dialogs(app)).opened).toBe(1);
    expect(await windowCount(app)).toBe(0);
    await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
    await expect.poll(async () => (await dialogs(app)).opened).toBe(2);
    await app.close();
  } else {
    await exited(proc);
  }
});

fromSource(
  "a file Fava cannot open at launch shows an error and asks again",
  async () => {
    const app = await launch(userDataDir(), [], [
      path.join(DATA, "does-not-exist.beancount"),
      path.join(DATA, "example.beancount"),
    ]);
    const page = await app.firstWindow();
    await expect(page).toHaveURL(/\/example\//);
    const { errors, opened } = await dialogs(app);
    expect(opened).toBe(2);
    expect(errors).toHaveLength(1);
    expect(errors[0].title).toBe("Could not open file with Fava");
    expect(errors[0].content).toContain("does-not-exist.beancount");
    await app.close();
  },
);

test("show a file and switch to another with File > Open", async () => {
  const app = await launch(userDataDir(), [
    path.join(DATA, "example.beancount"),
  ]);
  const page = await app.firstWindow();
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/example\//);
  await expect(
    page.getByRole("heading", { name: "Example›Income Statement" }),
  ).toBeVisible();

  // A query exercises beanquery, whose modules are loaded dynamically.
  const firstServer = new URL(page.url()).origin;
  await page.goto(
    `${firstServer}/example/query/?query_string=` +
      encodeURIComponent("SELECT account, sum(position) GROUP BY account"),
  );
  await expect(
    page.getByRole("cell", { name: "Expenses:Food" }).first(),
  ).toBeVisible();

  await menuOpen(app, path.join(DATA, "errors.beancount"));
  await expect(page.getByRole("heading", { name: /^errors›/ })).toBeVisible();
  // Still one window, and the server for the previous file has been stopped.
  expect(await windowCount(app)).toBe(1);
  await expect.poll(() => isServing(firstServer)).toBe(false);

  // Cancelling File > Open keeps the current file.
  await menuOpen(app, null);
  await expect.poll(async () => (await dialogs(app)).opened).toBe(2);

  // A file Fava cannot open shows an error and keeps the current file.
  await menuOpen(app, path.join(DATA, "does-not-exist.beancount"));
  await expect.poll(async () => (await dialogs(app)).errors.length).toBe(1);
  expect((await dialogs(app)).errors[0].content).toContain(
    "does-not-exist.beancount",
  );
  await expect(page.getByRole("heading", { name: /^errors›/ })).toBeVisible();

  // Closing the window stops Fava.
  const secondServer = new URL(page.url()).origin;
  const proc = app.process();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await expect.poll(() => isServing(secondServer)).toBe(false);
  if (isMac) {
    await app.close();
  } else {
    await exited(proc);
  }
});

test("the last opened file is opened again on the next launch", async () => {
  const userData = userDataDir();
  let app = await launch(userData, [path.join(DATA, "example.beancount")]);
  let page = await app.firstWindow();
  await expect(page).toHaveURL(/\/example\//);
  await menuOpen(app, path.join(DATA, "errors.beancount"));
  await expect(page).toHaveURL(/\/errors\//);
  await app.close();

  app = await launch(userData);
  page = await app.firstWindow();
  await expect(page).toHaveURL(/\/errors\//);
  expect((await dialogs(app)).opened).toBe(0);
  await app.close();
});

fromSource("a last opened file that is gone is forgotten", async () => {
  const userData = userDataDir();
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    path.join(userData, "last-file"),
    path.join(DATA, "deleted.beancount"),
  );
  const app = await launch(userData, [], [path.join(DATA, "example.beancount")]);
  const page = await app.firstWindow();
  await expect(page).toHaveURL(/\/example\//);
  const { errors, opened } = await dialogs(app);
  expect(opened).toBe(1);
  expect(errors).toHaveLength(0);
  await app.close();
});

test("the history shortcuts go back and forward within a file", async () => {
  const app = await launch(userDataDir(), [
    path.join(DATA, "example.beancount"),
  ]);
  const page = await app.firstWindow();
  await expect(page).toHaveURL(/\/example\/income_statement\//);
  await page.getByRole("link", { name: "Balance Sheet" }).click();
  await expect(page).toHaveURL(/\/example\/balance_sheet\//);

  // Playwright's key presses go straight to the page and bypass the menu, so
  // check the shortcuts of the menu items and click them instead.
  const history = (id) =>
    app.evaluate(({ Menu }, itemId) => {
      const item = Menu.getApplicationMenu().getMenuItemById(itemId);
      item.click();
      return item.accelerator;
    }, id);
  expect(await history("back")).toBe("CmdOrCtrl+[");
  await expect(page).toHaveURL(/\/example\/income_statement\//);
  await expect(
    page.getByRole("heading", { name: "Example›Income Statement" }),
  ).toBeVisible();
  expect(await history("forward")).toBe("CmdOrCtrl+]");
  await expect(page).toHaveURL(/\/example\/balance_sheet\//);

  // Opening another file starts a new history: the previous file's Fava
  // server is gone.
  await menuOpen(app, path.join(DATA, "errors.beancount"));
  await expect(page).toHaveURL(/\/errors\//);
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.navigationHistory.canGoBack(),
      ),
    )
    .toBe(false);
  await app.close();
});
