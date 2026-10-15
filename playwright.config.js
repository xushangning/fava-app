const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "test",
  timeout: 120_000,
});
