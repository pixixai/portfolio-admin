import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {createRequire} from 'node:module';
import { createHash } from "node:crypto";
import { root, loadContent, escapeHtml } from "./content.mjs";

const { projects } = await loadContent();
const output = path.join(root, "dist");
const manifest = JSON.parse(
  await readFile(path.join(output, "data/projects.json"), "utf8"),
);
assert.deepEqual(
  manifest.map((project) => project.id),
  projects.map((project) => project.id),
  "Published order does not match Markdown order.",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let imageCount = 0;
for (const project of projects) {
  const fragment = JSON.parse(
    await readFile(
      path.join(output, "data/projects", project.id + ".json"),
      "utf8",
    ),
  );
  const html = fragment.html;
  assert.ok(
    html.includes(`<h2>${escapeHtml(project.title)}</h2>`),
    `${project.id}: wrong title`,
  );
  assert.ok(
    !html.includes("以下是作品正文"),
    `${project.id}: authoring instructions leaked into the page`,
  );
  const renderedImages = [
    ...html.matchAll(
      /<button type="button" class="gallery-image"[^>]*><img src="([^"]+)" width="(\d+)" height="(\d+)"/g,
    ),
  ];
  assert.equal(
    renderedImages.length,
    project.images.length,
    `${project.id}: wrong image count`,
  );
  for (const [index, image] of project.images.entries()) {
    const rendered = renderedImages[index];
    assert.equal(
      decodeURIComponent(rendered[1]),
      image.destination,
      `${project.id}: wrong image order`,
    );
    assert.equal(Number(rendered[2]), image.width);
    assert.equal(Number(rendered[3]), image.height);
    assert.equal(
      hash(await readFile(path.join(output, image.destination))),
      hash(image.bytes),
      "Image changed during generation.",
    );
  }
  if (project.coverAsset)
    assert.equal(
      hash(await readFile(path.join(output, project.coverAsset.destination))),
      hash(project.coverAsset.bytes),
    );
  const neighbors = [
    ...html.matchAll(/class="related-card"[^>]*data-project-id="([^"]+)"/g),
  ].map((match) => match[1]);
  assert.equal(neighbors.length, Math.min(4, projects.length - 1));
  assert.equal(new Set(neighbors).size, neighbors.length);
  assert.ok(!neighbors.includes(project.id));
  assert.equal(
    manifest.find((item) => item.id === project.id).coverRatio,
    project.coverRatio,
  );
  imageCount += project.images.length;
}
const home = await readFile(path.join(output, "index.html"), "utf8");
for (const file of ["app.js", "origami-hero.js", "origami-hero.css", "style.css", "contact.css"]) {
  assert.equal(hash(await readFile(path.join(output, file))), hash(await readFile(path.join(root, file))), `${file}: deployment is stale`);
}
assert.ok(!/wind-curtain|wind-stage|has-wind-reveal/.test(home), "The retired overlapping curtain was published");
assert.ok(
  !/hero\.webp|home-portrait|href="tel:/.test(home),
  "Old hero or phone contact was published.",
);
const gsapDirectory=path.dirname(createRequire(import.meta.url).resolve('gsap/package.json'));
for (const filename of ["gsap.min.js", "ScrollTrigger.min.js"]) {
  assert.equal(
    hash(await readFile(path.join(output, "assets/vendor", filename))),
    hash(await readFile(path.join(gsapDirectory, 'dist', filename))),
    `${filename}: bundled animation runtime differs from installed package.`,
  );
}
assert.equal(
  [...home.matchAll(/class="project-card"/g)].length,
  projects.length,
  "Homepage is missing cards.",
);
const files = [];
assert.ok(
  !/id="profile"|content-tabs|profile-facts/.test(home),
  "Personal information leaked into the collection.",
);
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(filename);
    else files.push(filename);
  }
}
await visit(output);
let localReferences = 0;
for (const file of files) {
  assert.ok(
    !/\.(?:md|pdf|map)$/i.test(file),
    `Authoring/source file was published: ${file}`,
  );
  assert.ok(
    !file.includes(path.join("assets", "tools")),
    "Personal assets were published.",
  );
  const fragmentFile =
    path.dirname(file) === path.join(output, "data/projects") &&
    file.endsWith(".json");
  if (!file.endsWith(".html") && !fragmentFile) continue;
  const raw = await readFile(file, "utf8");
  const html = fragmentFile ? JSON.parse(raw).html : raw;
  if (!fragmentFile) {
    const scripts = [
      ...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g),
    ].map((match) => path.posix.basename(match[1]));
    assert.deepEqual(
      scripts,
      ["gsap.min.js", "ScrollTrigger.min.js", "app.js"],
      `Wrong script order: ${file}`,
    );
    assert.ok(
      /<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="[^"]*app\.js")[^>]*>/.test(
        html,
      ),
    );
  }
  assert.ok(
    !/data:image\/|window\.PORTFOLIO_PROJECTS|<style[\s>]|<script>/.test(html),
    "Page still contains embedded assets or application scripts.",
  );
  assert.ok(
    !/\{\{\w+\}\}/.test(html),
    `Unresolved template placeholder: ${file}`,
  );
  const pageUrl = new URL(
    fragmentFile
      ? "index.html"
      : path.relative(output, file).split(path.sep).join("/"),
    "https://portfolio.test/",
  );
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    if (/^(?:https?:|mailto:|tel:|#)/i.test(match[1])) continue;
    const url = new URL(match[1].replaceAll("&amp;", "&"), pageUrl);
    let target = path.join(output, decodeURIComponent(url.pathname));
    const info = await stat(target).catch(() => {
      throw new Error(`Broken reference in ${file}: ${match[1]}`);
    });
    if (info.isDirectory()) target = path.join(target, "index.html");
    await stat(target);
    localReferences++;
  }
}
console.log(
  `Verified ${projects.length} projects, ${imageCount} detail images, exact image bytes, generated metadata and ${localReferences} local references. Deployment contains no Markdown or PDF sources.`,
);
