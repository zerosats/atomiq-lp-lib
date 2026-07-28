// Plain config object (no `vitest/config` import) so the config loads even when
// vitest is resolved from the npx cache rather than the project node_modules.
//
// The lp-lib unit tests are offline: they never touch wasm or the SE. Alias
// @zerosats/ml-core to a tiny stub so importing the wallet code does not pull the
// real SDK (and its wasm) into the test process. The only runtime symbols the
// wallet imports from it are SERejected and createMercuryClient.
export default {
    test: {
        environment: "node",
        include: ["test/**/*.test.ts"]
    },
    resolve: {
        alias: [
            {
                find: "@zerosats/ml-core",
                replacement: new URL("./test/stubs/ml-core.ts", import.meta.url).pathname
            }
        ]
    }
};
