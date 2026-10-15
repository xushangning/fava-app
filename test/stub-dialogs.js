// Loaded into the app's main process by the tests (preloaded with -r, or
// required after launch) to replace the native dialogs. The open dialog
// returns the files queued in STUB_OPEN_FILES (a JSON list) or pushed to
// globalThis.stubDialogs.files, and is cancelled once the queue is empty.

const { dialog } = require("electron");

const state = {
  files: JSON.parse(process.env.STUB_OPEN_FILES || "[]"),
  opened: 0,
  errors: [],
};
globalThis.stubDialogs = state;

dialog.showOpenDialog = async () => {
  state.opened += 1;
  const file = state.files.shift();
  return file
    ? { canceled: false, filePaths: [file] }
    : { canceled: true, filePaths: [] };
};
dialog.showErrorBox = (title, content) => {
  state.errors.push({ title, content });
};
