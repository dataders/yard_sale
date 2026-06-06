const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    files: ["app.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        // Browser
        window: "readonly", document: "readonly", navigator: "readonly",
        fetch: "readonly", alert: "readonly", console: "readonly",
        CSS: "readonly", setTimeout: "readonly",
        // Leaflet (loaded via <script src>) and our data global
        L: "readonly", SALES_DATA: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "warn",
    },
  },
];
