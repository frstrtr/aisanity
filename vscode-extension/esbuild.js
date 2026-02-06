const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

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

/** Copy Python files into the extension output */
function copyPythonFiles() {
    const pythonDir = path.join(__dirname, "python");
    if (!fs.existsSync(pythonDir)) {
        fs.mkdirSync(pythonDir, { recursive: true });
    }

    const sourceDir = path.join(__dirname, "..");
    const filesToCopy = ["guardian.py", "mcp_server.py"];
    for (const file of filesToCopy) {
        const src = path.join(sourceDir, file);
        const dst = path.join(pythonDir, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dst);
            console.log(`Copied ${file} → python/${file}`);
        } else {
            console.warn(`Warning: ${src} not found`);
        }
    }
}

/** @type {import('esbuild').Plugin} */
const copyPythonPlugin = {
    name: "copy-python-files",
    setup(build) {
        build.onStart(() => {
            copyPythonFiles();
        });
    },
};

async function main() {
    const ctx = await esbuild.context({
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
        plugins: [copyPythonPlugin, esbuildProblemMatcherPlugin],
    });

    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
