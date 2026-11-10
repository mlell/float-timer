// Build pipeline: bundles src/main.ts with esbuild and copies the static shell into dist/.
// --standalone additionally inlines CSS and JS into dist/timer.html so the app runs from a
// single file (e.g. opened from disk or attached to an email) without a web server.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const STANDALONE = process.argv.includes("--standalone");

// These exact strings must match index.html; the standalone step fails loudly if they drift.
const CSS_LINK = '<link rel="stylesheet" href="./styles.css">';
const JS_SCRIPT = '<script type="module" src="./main.js"></script>';

await mkdir("dist", { recursive: true });

const result = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: false,
  target: "es2022",
  outfile: "dist/main.js",
  write: !STANDALONE,
  metafile: false,
});

if (STANDALONE) {
  // The bundle is kept in memory so it can be inlined; it is not written to dist/main.js.
  const js = result.outputFiles?.[0]?.text;
  if (js === undefined) {
    throw new Error("esbuild produced no output in standalone mode");
  }
  const html = await readFile("index.html", "utf8");
  const css = await readFile("src/styles.css", "utf8");
  const withCss = replaceExactlyOnce(html, CSS_LINK, `<style>\n${css}</style>`);
  // Escaping "</script" prevents the inlined bundle from closing its own tag early.
  const safeJs = js.replaceAll("</script", "<\\/script");
  const standalone = replaceExactlyOnce(
    withCss,
    JS_SCRIPT,
    `<script type="module">\n${safeJs}</script>`,
  );
  await writeFile("dist/timer.html", standalone);
} else {
  await copyFile("index.html", "dist/index.html");
  await copyFile("src/styles.css", "dist/styles.css");
}

function replaceExactlyOnce(source, needle, replacement) {
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected exactly one occurrence of ${needle}, found ${String(occurrences)}`,
    );
  }
  return source.replace(needle, () => replacement);
}
