import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  cp,
  rm,
  rename,
  mkdtemp,
  access,
} from "node:fs/promises";
import path from "node:path";
import {createRequire} from 'node:module';
import { adjacentProjects } from "../gallery.js";
import {
  root,
  escapeHtml as e,
  encodePath,
  applyTemplate,
  loadContent,
  renderBody,
} from "./content.mjs";

// Validate all content before replacing the previous successful deployment output.
const { site, projects } = await loadContent();
const [layout, home, detail] = await Promise.all([
  readFile(path.join(root, "templates/layout.html"), "utf8"),
  readFile(path.join(root, "index.html"), "utf8"),
  readFile(path.join(root, "templates/project.html"), "utf8"),
]);
const previewRoot = path.join(root, ".preview");
await mkdir(previewRoot, { recursive: true });
const stage = await mkdtemp(path.join(previewRoot, "build-"));
const output = path.join(root, "dist");
const previous = `${stage}-previous`;

function ownedGeneratedPath(target) {
  const resolved = path.resolve(target);
  if (resolved !== output && !resolved.startsWith(previewRoot + path.sep)) {
    throw new Error(
      `Refusing to replace a path outside generated output: ${resolved}`,
    );
  }
  return resolved;
}
async function write(relative, content) {
  const target = path.join(stage, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
function page(content, prefix, title, description, initialProject = "") {
  return applyTemplate(layout, {
    root: prefix,
    projectCount: projects.length,
    title: e(title),
    description: e(description),
    initialProject,
    content,
  });
}
function assetUrl(asset, prefix = "") {
  return prefix + encodePath(asset.destination);
}
function projectUrl(project, prefix = "") {
  return `${prefix}?work=${project.id}`;
}
const labelsFor = project => [...new Set((project.labels || [project.category, ...project.tags]).filter(label => label && label !== '未分类'))];

function card(project, prefix = "", related = false) {
  const crop = project.coverCrop;
  const cropStyle = crop ? ` style="object-position:${crop.x * 100}% ${crop.y * 100}%;transform:scale(${crop.zoom});transform-origin:${crop.x * 100}% ${crop.y * 100}%"` : '';
  const image = project.coverAsset
    ? `<img src="${assetUrl(project.coverAsset, prefix)}" width="${project.coverAsset.width}" height="${project.coverAsset.height}" loading="lazy" decoding="async"${cropStyle} alt="${e(project.title)}作品封面">`
    : `<div class="cover-text"><p>${e(project.english)}</p><strong>${e(project.title)}</strong><p>${e(project.coverText)}</p></div>`;
  return `<a class="${related ? "related-card" : "project-card"}" href="${projectUrl(project, prefix)}" data-project-id="${project.id}" data-ratio="${project.coverRatio}" data-cover-source="${project.coverSource}" data-labels="${e(JSON.stringify(labelsFor(project)))}" aria-label="查看 ${e(project.title)}"><div class="card-image">${image}<div class="card-overlay"><p class="card-category">${e(labelsFor(project).join(' · '))}</p><${related ? "h4" : "h2"} class="card-title">${e(project.title)}</${related ? "h4" : "h2"}></div></div></a>`;
}

try {
  const footerText = e(site.footer?.text ?? `© ${site.year} ${site.owner} · 作品集`).replaceAll("{", "&#123;").replaceAll("}", "&#125;");
  const footerCopyright = footerText ? `<p class="footer-copyright">${footerText}</p>` : "";
  const registrationText = e(site.footer?.registrationText || "").replaceAll("{", "&#123;").replaceAll("}", "&#125;");
  const registrationUrl = site.footer?.registrationUrl || "";
  if (registrationUrl && new URL(registrationUrl).protocol !== "https:") throw new Error("Registration link must use HTTPS.");
  const footerRegistration = registrationText ? `<p class="footer-registration">${registrationUrl ? `<a href="${e(registrationUrl)}" target="_blank" rel="noopener">${registrationText}</a>` : registrationText}</p>` : "";
  await write("data/home-background.json", JSON.stringify({ ...(site.homeBackground ?? { videos: [{ src: "assets/home/home-background.mp4", playbackRate: 1 }], finalFrame: null }), shadeOpacity: site.homeBackground?.shadeOpacity ?? 80, loop: site.homeBackground?.loop !== false }, null, 2));
  const categories = [
    ...new Set([
      ...(site.categories ?? []),
      ...projects.flatMap(labelsFor),
    ]),
  ].filter((category) =>
    projects.some((project) => labelsFor(project).includes(category)),
  );
  const filters = ["全部作品", ...categories]
    .map(
      (category, index) =>
        `<button type="button" aria-pressed="${index === 0}" data-category="${e(category)}">${e(category)}</button>`,
    )
    .join("\n");
  const homeContent = (prefix = "") =>
    applyTemplate(home, {
      root: prefix,
      owner: e(site.owner),
      footerCopyright,
      footerRegistration,
      bilibiliName: e(site.contact.bilibiliName),
      emailPrimary: e(site.contact.emails[0]),
      emailSecondary: e(site.contact.emails[1]),
      wechat: e(site.contact.wechat),
      projectCount: projects.length,
      filters,
      cards: projects
        .map((project) =>
          card(project, prefix).replace(
            "data-project-id=",
            `data-category="${e(project.category)}" data-project-id=`,
          ),
        )
        .join("\n"),
    });
  await write(
    "index.html",
    page(homeContent(), "./", site.title, site.description),
  );

  for (const [index, project] of projects.entries()) {
    const prefix = "../../";
    const content = applyTemplate(detail, {
      id: project.id,
      projectCount: projects.length,
      number: String(index + 1).padStart(2, "0"),
      english: e(project.english),
      projectTitle: e(project.title),
      projectDescription: e(project.description),
      tags: project.tags.map((tag) => `<span>${e(tag)}</span>`).join(""),
      body: renderBody(project, ""),
      related: adjacentProjects(projects, project.id)
        .map((item) => card(item, "", true))
        .join("\n"),
    });
    await write(
      `data/projects/${project.id}.json`,
      JSON.stringify({ id: project.id, title: project.title, html: content }) +
        "\n",
    );
    await write(
      `works/${project.id}/index.html`,
      page(
        homeContent(prefix),
        prefix,
        site.title,
        project.description,
        project.id,
      ),
    );
    const assets = new Map(
      [project.coverAsset, ...project.images, ...project.media]
        .filter(Boolean)
        .map((asset) => [asset.destination, asset]),
    );
    for (const asset of assets.values())
      await write(asset.destination, asset.bytes);
  }
  await write(
    "data/projects.json",
    JSON.stringify(
      projects.map((project) => ({
        id: project.id,
        title: project.title,
        category: project.category,
        tags: project.tags,
        labels: labelsFor(project),
        order: project.order,
        url: projectUrl(project),
        cover: project.coverAsset ? assetUrl(project.coverAsset) : null,
        coverRatio: project.coverRatio,
        coverSource: project.coverSource,
        coverCrop: project.coverCrop || null,
        imageCount: project.images.length,
      })),
      null,
      2,
    ) + "\n",
  );
  await copyFile(path.join(root, "style.css"), path.join(stage, "style.css"));
  await copyFile(
    path.join(root, "contact.css"),
    path.join(stage, "contact.css"),
  );
  await copyFile(path.join(root, "app.js"), path.join(stage, "app.js"));
  await copyFile(path.join(root, "gallery.js"), path.join(stage, "gallery.js"));
  await copyFile(path.join(root, "origami-hero.js"), path.join(stage, "origami-hero.js"));
  await copyFile(path.join(root, "origami-hero.css"), path.join(stage, "origami-hero.css"));
  await copyFile(path.join(root, "home-image.css"), path.join(stage, "home-image.css"));
  await copyFile(path.join(root, "hero-video.js"), path.join(stage, "hero-video.js"));
  await mkdir(path.join(stage, "assets"), { recursive: true });
  await cp(path.join(root, "assets/home"), path.join(stage, "assets/home"), { recursive: true });
  await copyFile(
    path.join(root, "assets/favicon.svg"),
    path.join(stage, "assets/favicon.svg"),
  );
  // Ship the pinned npm runtime locally; no CDN is required by deployed pages.
  const vendor = path.join(stage, "assets/vendor");
  const gsapDirectory=path.dirname(createRequire(import.meta.url).resolve('gsap/package.json'));
  await mkdir(vendor, { recursive: true });
  for (const filename of ["gsap.min.js", "ScrollTrigger.min.js"]) {
    await copyFile(
      path.join(gsapDirectory, 'dist', filename),
      path.join(vendor, filename),
    );
  }
  const gsapPackage = JSON.parse(
    await readFile(path.join(gsapDirectory, 'package.json'), "utf8"),
  );
  await write(
    "assets/vendor/GSAP-NOTICE.txt",
    `GSAP ${gsapPackage.version}\nCopyright GreenSock. All rights reserved.\n${gsapPackage.license}\nOfficial source: https://github.com/greensock/GSAP\n`,
  );

  let hadPrevious = false;
  try {
    await access(output);
    hadPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (hadPrevious)
    await rename(ownedGeneratedPath(output), ownedGeneratedPath(previous));
  try {
    await rename(ownedGeneratedPath(stage), ownedGeneratedPath(output));
  } catch (error) {
    if (hadPrevious)
      await rename(ownedGeneratedPath(previous), ownedGeneratedPath(output));
    throw error;
  }
  if (hadPrevious)
    await rm(ownedGeneratedPath(previous), { recursive: true, force: true });
  console.log(
    `Built dist/: ${projects.length} projects, ${projects.reduce((total, project) => total + project.images.length, 0)} detail images. No Markdown, PDF, original HTML or development documents copied to deployment.`,
  );
} finally {
  await rm(ownedGeneratedPath(stage), { recursive: true, force: true });
}
