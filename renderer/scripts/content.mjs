import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import MarkdownIt from "markdown-it";
import { selectCoverRatio } from "../gallery.js";
import { installFormatting } from './formatting.mjs';

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
export const encodePath = (value) =>
  value.split("/").map(encodeURIComponent).join("/");
export const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: false,
  typographer: false,
});
installFormatting(markdown);
// A small, portable Markdown extension for standalone audio/video blocks.
markdown.block.ruler.before('paragraph', 'portfolio_media', (state, startLine, endLine, silent) => {
  const line = state.getLines(startLine, startLine + 1, state.blkIndent, false).trim();
  const match = line.match(/^@\[(video|audio)\]\(([^)\r\n]+)\)$/);
  if (!match) return false;
  if (silent) return true;
  const token = state.push('portfolio_media', '', 0);
  token.block = true; token.meta = { kind: match[1], source: match[2] }; token.map = [startLine, startLine + 1];
  state.line = startLine + 1; return true;
}, { alt: ['paragraph'] });

export function applyTemplate(source, values) {
  return source.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unknown template field: ${key}`);
    return values[key];
  });
}

export function imageDimensions(buffer) {
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    for (let position = 12; position + 8 <= buffer.length; ) {
      const type = buffer.toString("ascii", position, position + 4);
      const length = buffer.readUInt32LE(position + 4);
      const data = position + 8;
      if (type === "VP8X")
        return {
          width: buffer.readUIntLE(data + 4, 3) + 1,
          height: buffer.readUIntLE(data + 7, 3) + 1,
        };
      if (type === "VP8 ")
        return {
          width: buffer.readUInt16LE(data + 6) & 0x3fff,
          height: buffer.readUInt16LE(data + 8) & 0x3fff,
        };
      if (type === "VP8L") {
        const bits = buffer.readUInt32LE(data + 1);
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
        };
      }
      position = data + length + (length % 2);
    }
  }
  if (buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.toString("ascii", 0, 3) === "GIF")
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset++] !== 0xff) continue;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const size = buffer.readUInt16BE(offset);
      if (size < 2) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        return {
          width: buffer.readUInt16BE(offset + 5),
          height: buffer.readUInt16BE(offset + 3),
        };
      }
      offset += size;
    }
  }
  throw new Error("Cannot read image dimensions. Use WebP, PNG, JPEG or GIF.");
}

export async function projectAsset(project, reference, kind = 'image') {
  if (!reference || /^[a-z][a-z\d+.-]*:|^[\/\\]|[?#]/i.test(reference)) {
    throw new Error(
      `${project.title}: asset must be a local path inside its project folder: ${reference}`,
    );
  }
  const decoded = decodeURIComponent(reference);
  const resolved = path.resolve(project.directory, decoded);
  const actual = await realpath(resolved);
  const relative = path.relative(project.directory, actual);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `${project.title}: asset escapes project folder: ${reference}`,
    );
  }
  const bytes = await readFile(actual);
  if (kind !== 'image' && !(kind === 'video' ? /\.(mp4|webm)$/i : /\.(mp3|wav|ogg|m4a|webm)$/i).test(actual)) throw new Error('Unsupported media extension.');
  return {
    source: actual,
    bytes,
    destination: `Portfolio/${project.folder}/${relative.split(path.sep).join("/")}`,
    ...(kind === 'image' ? imageDimensions(bytes) : { width: 0, height: 0 }),
  };
}

export async function loadContent(contentRoot = root) {
  contentRoot = await realpath(contentRoot);
  const site = JSON.parse(
    await readFile(path.join(contentRoot, "site.json"), "utf8"),
  );
  const entries = await readdir(path.join(contentRoot, "Portfolio"), {
    withFileTypes: true,
  });
  const projects = [];
  const ids = new Set();
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const directory = await realpath(
      path.join(contentRoot, "Portfolio", entry.name),
    );
    const parent = path.relative(
      path.join(contentRoot, "Portfolio"),
      directory,
    );
    if (parent.startsWith("..") || path.isAbsolute(parent))
      throw new Error("Project directory must stay inside Portfolio.");
    const document = await readFile(path.join(directory, "index.md"), "utf8");
    const match = document.match(
      /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
    );
    if (!match)
      throw new Error(
        `${entry.name}/index.md needs YAML metadata between --- lines.`,
      );
    const metadata = parse(match[1]);
    for (const field of ["id", "title", "category", "english", "description"]) {
      if (typeof metadata[field] !== "string" || !metadata[field].trim())
        throw new Error(`${entry.name}: missing ${field}`);
    }
    if (!/^[a-z][a-z0-9-]*$/.test(metadata.id) || ids.has(metadata.id))
      throw new Error(`Invalid or duplicate project ID: ${metadata.id}`);
    if (
      !Array.isArray(metadata.tags) ||
      metadata.tags.some((tag) => typeof tag !== "string")
    )
      throw new Error(`${entry.name}: tags must be a list of text.`);
    if (metadata.labels != null && (!Array.isArray(metadata.labels) || metadata.labels.some(label => typeof label !== 'string'))) throw new Error(`${entry.name}: labels must be a list of text.`);
    if (!Number.isFinite(metadata.order))
      throw new Error(`${entry.name}: order must be a number.`);
    ids.add(metadata.id);
    const project = {
      ...metadata,
      folder: entry.name,
      directory,
      body: match[2],
    };
    project.tokens = markdown.parse(project.body, {});
    project.images = [];
    project.media = [];
    for (const token of project.tokens) {
      if (token.type === 'portfolio_media') project.media.push({ ...await projectAsset(project, token.meta.source, token.meta.kind), kind: token.meta.kind, token });
      for (const child of token.children ?? []) {
        if (child.type === "image") {
          const asset = await projectAsset(project, child.attrGet("src"));
          project.images.push({
            ...asset,
            alt: child.content || project.title,
            token: child,
          });
        }
        if (child.type === "link_open") {
          const href = child.attrGet("href");
          if (!/^(?:https?:|mailto:|tel:|#)/i.test(href)) {
            throw new Error(
              `${entry.name}: use an https:// link or #anchor for text links: ${href}`,
            );
          }
        }
      }
    }
    if (metadata.cover != null && typeof metadata.cover !== "string")
      throw new Error(`${entry.name}: cover must be a local path or empty.`);
    project.coverAsset = metadata.useFirstImage === true ? project.images[0] || null : metadata.cover?.trim()
      ? await projectAsset(project, metadata.cover.trim())
      : metadata.useFirstImage === false ? null : project.images[0] || null;
    project.coverSource = !project.coverAsset ? 'body-text' : metadata.useFirstImage === true || !metadata.cover?.trim() ? 'body-image' : 'custom';
    project.coverRatio = selectCoverRatio(
      project.coverAsset?.width,
      project.coverAsset?.height,
      metadata.cover?.trim() || metadata.useFirstImage === true ? metadata.coverRatio || "auto" : "auto",
    );
    if (project.coverCrop != null && (!project.coverAsset || !['x', 'y', 'zoom'].every(key => typeof project.coverCrop[key] === 'number' && Number.isFinite(project.coverCrop[key])) || project.coverCrop.x < 0 || project.coverCrop.x > 1 || project.coverCrop.y < 0 || project.coverCrop.y > 1 || project.coverCrop.zoom < 1 || project.coverCrop.zoom > 4)) throw new Error('Invalid cover crop.');
    project.coverText =
      project.tokens
        .filter((token) => token.type === "inline")
        .map(
          (token) =>
            token.children
              ?.filter((child) => child.type === "text")
              .map((child) => child.content)
              .join("") || "",
        )
        .filter(Boolean)
        .join(" ")
        .slice(0, 220) || project.description;
    projects.push(project);
  }
  projects.sort(
    (left, right) =>
      left.order - right.order || left.id.localeCompare(right.id),
  );
  return { site, projects };
}

export function renderBody(project, prefix) {
  let imageIndex = 0;
  const renderer = new MarkdownIt({ html: false, breaks: true });
  let mediaIndex = 0;
  renderer.renderer.rules.portfolio_media = () => {
    const media = project.media[mediaIndex++], tag = media.kind;
    return `<figure class="project-media"><${tag} controls ${tag === 'video' ? 'playsinline' : ''} preload="metadata" src="${prefix}${encodePath(media.destination)}" aria-label="${escapeHtml(project.title)}${tag === 'video' ? '视频' : '音频'}"></${tag}></figure>\n`;
  };
  renderer.renderer.rules.image = () => {
    const image = project.images[imageIndex++];
    const label = `放大查看 ${project.title}，第 ${imageIndex} 部分`;
    return `<button type="button" class="gallery-image" data-image="${imageIndex - 1}" aria-label="${escapeHtml(label)}"><img src="${prefix}${encodePath(image.destination)}" width="${image.width}" height="${image.height}" loading="${imageIndex === 1 ? "eager" : "lazy"}" decoding="async" alt="${escapeHtml(image.alt)}"></button>`;
  };
  for (let index = 0; index < project.tokens.length - 2; index++) {
    const token = project.tokens[index];
    const inline = project.tokens[index + 1];
    if (
      token.type === "paragraph_open" &&
      inline.type === "inline" &&
      inline.children?.some((child) => child.type === "image") &&
      inline.children.every((child) =>
        ["image", "softbreak"].includes(child.type),
      )
    ) {
      token.hidden = true;
      project.tokens[index + 2].hidden = true;
      inline.children = inline.children.filter(
        (child) => child.type !== "softbreak",
      );
    }
  }
  return renderer.renderer.render(project.tokens, renderer.options, {});
}
