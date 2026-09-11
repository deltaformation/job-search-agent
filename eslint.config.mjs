import nextConfig from "eslint-config-next";

const config = [
  ...nextConfig,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      ".next-e2e/**",
      ".e2e-data/**",
      "coverage/**",
      ".venv/**",
    ],
  },
];

export default config;
