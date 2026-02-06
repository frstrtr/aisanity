const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').Plugin} */
const esbuildProblemMatcherPlugin = {
    name: "esbuild-problem-matcher",
    setup(build) {
        build.onStart(() => {
            console.log("[watch] build started");
        });
        build.onEnd((result) => {
            for (const { text, location } of result.errors) {
                console.error(`✘ [ERROR] ${text}`);
                if (location) {
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                }
            }
            console.log("[watch] build finished");
        });
    },
};

async function main() {
    /** Build the VS Code extension (imports guardian.ts, excluded from vscode) */
    const extCtx = await esbuild.context({
        entryPoints: ["src/extension.ts"],
        bundle: true,
        format: "cjs",
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: "node",
        outfile: "dist/extension.js",
        external: ["vscode"],
        logLevel: "silent",
        plugins: [esbuildProblemMatcherPlugin],
    });

    /** Build the standalone MCP server (no vscode dependency, runs via node) */
    const mcpCtx = await esbuild.context({
        entryPoints: ["src/mcpServer.ts"],
        bundle: true,
        format: "cjs",
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: "node",
        outfile: "dist/mcpServer.js",
        external: [],
        logLevel: "silent",
    });

    if (watch) {
        await Promise.all([extCtx.watch(), mcpCtx.watch()]);
    } else {
        await Promise.all([extCtx.rebuild(), mcpCtx.rebuild()]);
        await Promise.all([extCtx.dispose(), mcpCtx.dispose()]);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
