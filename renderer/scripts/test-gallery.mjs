import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  coverRatios,
  ratioValue,
  selectCoverRatio,
  adjacentProjects,
  masonryLayout,
} from "../gallery.js";
import { loadContent, root } from "./content.mjs";

for (const ratio of coverRatios) {
  const [w, h] = ratio.split(":").map(Number);
  assert.equal(selectCoverRatio(w * 100, h * 100), ratio);
}
assert.equal(selectCoverRatio(1920, 1800), "1:1");
assert.equal(selectCoverRatio(1920, 1120), "16:9");
assert.equal(selectCoverRatio(100, 300), "9:16");
assert.equal(selectCoverRatio(300, 100), "16:9");
assert.equal(selectCoverRatio(960, 720, "3:4"), "3:4");
assert.throws(() => selectCoverRatio(960, 720, "5:7"));
const projects = Array.from({ length: 15 }, (_, i) => ({ id: String(i) }));
assert.deepEqual(
  adjacentProjects(projects, "0").map((p) => p.id),
  ["13", "14", "1", "2"],
);
assert.deepEqual(
  adjacentProjects(projects, "14").map((p) => p.id),
  ["12", "13", "0", "1"],
);
assert.equal(adjacentProjects(projects.slice(0, 3), "0").length, 2);
assert.equal(adjacentProjects(projects.slice(0, 1), "0").length, 0);
for (const width of [280, 339, 760, 1000, 1440]) {
  const cols = width >= 1200 ? 4 : width >= 820 ? 3 : width >= 300 ? 2 : 1;
  const { positions, height } = masonryLayout(
    [...coverRatios, ...coverRatios],
    width,
    cols,
    12,
  );
  assert.ok(height > 0);
  positions.forEach((a, i) => {
    assert.ok(a.x >= 0 && a.x + a.width <= width + 0.001);
    assert.ok(a.y + a.height <= height + 0.001);
    assert.ok(
      Math.abs(a.width / a.height - ratioValue(coverRatios[i % 7])) < 0.001,
    );
    positions
      .slice(i + 1)
      .forEach((b) =>
        assert.ok(
          a.x + a.width <= b.x + 0.001 ||
            b.x + b.width <= a.x + 0.001 ||
            a.y + a.height <= b.y + 0.001 ||
            b.y + b.height <= a.y + 0.001,
          "Masonry cards overlap",
        ),
      );
  });
}
assert.equal(masonryLayout([], 1000, 3, 20).height, 0);

// Fixtures verify actual metadata loading, not just the ratio helper.
const parent = path.join(root, ".preview");
await mkdir(parent, { recursive: true });
const fixture = await mkdtemp(path.join(parent, "content-test-"));
try {
  await writeFile(path.join(fixture, "site.json"), "{}");
  const dir = path.join(fixture, "Portfolio", "测试作品");
  await mkdir(dir, { recursive: true });
  const { projects: real } = await loadContent();
  await writeFile(path.join(dir, "body.webp"), real[0].images[0].bytes);
  await writeFile(path.join(dir, "custom.webp"), real[0].coverAsset.bytes);
  const metadata =
    "---\nid: sample\ntitle: 测试作品\ncategory: 测试\nenglish: SAMPLE\ndescription: 测试说明\ntags: []\norder: 1\n";
  const save = (extra, body = "![正文](body.webp)") =>
    writeFile(path.join(dir, "index.md"), metadata + extra + "---\n\n" + body);
  await save("");
  let result = (await loadContent(fixture)).projects[0];
  assert.equal(result.coverSource, "body-image");
  assert.equal(result.coverRatio, selectCoverRatio(real[0].images[0].width,real[0].images[0].height));
  assert.equal(result.coverAsset.source, result.images[0].source);
  await save("cover: custom.webp\ncoverRatio: 3:4\n");
  result = (await loadContent(fixture)).projects[0];
  assert.equal(result.coverSource, "custom");
  assert.equal(result.coverRatio, "3:4");
  await save('cover: ""\ncoverRatio: 3:4\n');
  assert.equal((await loadContent(fixture)).projects[0].coverRatio, selectCoverRatio(real[0].images[0].width,real[0].images[0].height));
  await save("", "## 只有文字的作品\n\n这是一段文字正文。");
  result = (await loadContent(fixture)).projects[0];
  assert.equal(result.coverSource, "body-text");
  assert.equal(result.coverRatio, "1:1");
  assert.equal(result.coverAsset, null);
  assert.ok(result.coverText.includes("文字正文"));
  await save("cover: missing.webp\n");
  await assert.rejects(() => loadContent(fixture));
} finally {
  if (path.dirname(fixture) !== parent)
    throw new Error("Unsafe fixture cleanup");
  await rm(fixture, { recursive: true, force: true });
}
console.log(
  "PASS: seven ratios, nearest-match selection, explicit overrides, image/text fallback, adjacent works, responsive non-overlapping masonry.",
);
