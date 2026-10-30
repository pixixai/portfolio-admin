import { masonryLayout } from "./gallery.js";
import { initHeroVideo } from "./hero-video.js";

const $ = (selector) => document.querySelector(selector);
const script = document.querySelector("script[data-site-root]");
const siteRoot = new URL(script.dataset.siteRoot, location.href);
const baseTitle = document.title;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const grid = $("#grid");
const cards = [...grid.querySelectorAll(".project-card")];
const originalCardOrder=new Map(cards.map((card,i)=>[card,i]));
const cardLabelOrders=new Map(cards.map(card=>[card,JSON.parse(card.dataset.labelOrders||'{}')]));
const filters = $("#filters");
const works = $("#works");
const tools = works.querySelector(".work-tools");
const storageKey = `portfolio:${siteRoot.pathname}:category`;
const modal = $("#project-modal");
const sheet = $("#project-sheet");
const modalScroll = $("#project-modal-scroll");
const closeButton = $("#project-close");
const viewer = $("#viewer");
const viewerImage = $("#viewer-img");
const viewerCanvas = $("#viewer-canvas");
let activeId = null,
  request = null,
  returnFocus = null,
  backgroundScroll = 0;
let gallery = [],
  activeImage = 0,
  zoom = 1,
  imageReturnFocus = null;
let panX = 0,
  panY = 0,
  imageDrag = null;
let viewerBlankDown = false,
  viewerDragged = false;
let sheetTween;
const cache = new Map();

// Old /works/id/ entry points also render the collection behind the dialog.
// Resolve image and link URLs before normalizing those entries with replaceState.
document.querySelectorAll("img[src], a[href]").forEach((element) => {
  const attribute = element.tagName === "IMG" ? "src" : "href";
  const value = element.getAttribute(attribute);
  if (!value.startsWith("#"))
    element.setAttribute(attribute, new URL(value, location.href).href);
});

let layoutFrame = 0,
  lastWidth = -1,
  pendingAnimate = false,
  pendingFilterAnchor = null;
function queueLayout(animate = false) {
  pendingAnimate ||= animate;
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    const width = grid.clientWidth;
    if (!width) return;
    if (width === lastWidth && !pendingAnimate) return;
    lastWidth = width;
    const visible = cards.filter((card) => !card.hidden);
    const columns = width >= 1200 ? 4 : width >= 820 ? 3 : width >= 300 ? 2 : 1;
    const gap = width >= 820 ? 20 : 12;
    const layout = masonryLayout(
      visible.map((card) => card.dataset.ratio),
      width,
      columns,
      gap,
    );
    visible.forEach((card, index) => {
      const position = layout.positions[index];
      card.style.width = `${position.width}px`;
      card.style.transform = `translate(${position.x}px, ${position.y}px)`;
    });
    grid.dataset.masonry = "ready";
    grid.style.height = `${layout.height}px`;
    if (pendingFilterAnchor && !modal.open) {
      // Start the new category at its first row, keeping the toolbar at its
      // previous viewport position when the real document has enough scroll
      // range. Never add empty space to force a short category to stay pinned.
      const top = window.scrollY + works.getBoundingClientRect().top - pendingFilterAnchor.top;
      const page = document.scrollingElement || document.documentElement;
      const maxScroll = Math.max(0, page.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(maxScroll, Math.max(0, top)), behavior: "instant" });
    }
    pendingFilterAnchor = null;
    window.dispatchEvent(
      new CustomEvent("portfolio:layout", {
        detail: { animate: pendingAnimate },
      }),
    );
    pendingAnimate = false;
  });
}
new ResizeObserver(() => queueLayout()).observe(grid);
function filterProjects(category, preserveToolbar = false) {
  const buttons = [...filters.querySelectorAll("button")];
  if (!buttons.some((button) => button.dataset.category === category))
    category = "全部作品";
  if (preserveToolbar) {
    if (buttons.some(button => button.dataset.category === category && button.getAttribute("aria-pressed") === "true")) return;
    pendingFilterAnchor = { top: Math.max(0, tools.getBoundingClientRect().top) };
  }
  cards.sort((a,b)=>category==='全部作品'?originalCardOrder.get(a)-originalCardOrder.get(b):(cardLabelOrders.get(a)[category]??Infinity)-(cardLabelOrders.get(b)[category]??Infinity)||originalCardOrder.get(a)-originalCardOrder.get(b));
  cards.forEach(card=>grid.append(card));
  cards.forEach((card) => {
    const labels = card.dataset.labels ? JSON.parse(card.dataset.labels) : [card.dataset.category];
    card.hidden = category !== "全部作品" && !labels.includes(category);
  });
  buttons.forEach((button) =>
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.category === category),
    ),
  );
  $("#result-count").textContent =
    `${cards.filter((card) => !card.hidden).length} 件作品`;
  try {
    sessionStorage.setItem(storageKey, category);
  } catch {
    /* Optional state only. */
  }
  queueLayout(true);
}
let savedCategory = "全部作品";
try {
  savedCategory = sessionStorage.getItem(storageKey) || savedCategory;
} catch {
  /* Optional state only. */
}
filterProjects(savedCategory);
filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-category]");
  if (button) filterProjects(button.dataset.category, true);
});

function projectUrl(id) {
  const url = new URL(siteRoot);
  url.searchParams.set("work", id);
  return url;
}
function routeId() {
  return (
    new URL(location.href).searchParams.get("work") ||
    location.hash.match(/^#\/work\/([a-z][a-z0-9-]*)$/)?.[1] ||
    null
  );
}
function loadingState() {
  sheet.replaceChildren();
  const status = document.createElement("div");
  status.className = "project-message";
  status.setAttribute("role", "status");
  status.textContent = "正在打开作品…";
  sheet.append(status);
  sheet.setAttribute("aria-busy", "true");
}
function normalizeFragmentLinks() {
  sheet.querySelectorAll("img[src], video[src], audio[src], a[href]").forEach((element) => {
    const attribute = element.tagName === "A" ? "href" : "src";
    const value = element.getAttribute(attribute);
    if (!value.startsWith("#"))
      element.setAttribute(attribute, new URL(value, siteRoot).href);
  });
}
async function openProject(
  id,
  opener = null,
  pushHistory = false,
  retry = false,
) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return;
  if (id === activeId && modal.open && !retry) return;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  if (!modal.open) {
    returnFocus =
      opener ||
      cards.find((card) => card.dataset.projectId === id) ||
      filters.querySelector("button");
    backgroundScroll = window.scrollY;
    document.documentElement.classList.add("project-open");
    modal.showModal();
    window.dispatchEvent(new Event("portfolio:overlaychange"));
    closeButton.focus({ preventScroll: true });
  }
  if (viewer.open) viewer.close();
  if (pushHistory) {
    const state = { portfolioModal: siteRoot.pathname };
    if (activeId) {
      // A direct link has no collection entry behind it. Keep that distinction
      // when switching neighbors, so closing cannot go back to an external page.
      const owned = history.state?.portfolioModal === siteRoot.pathname;
      history.replaceState(owned ? state : null, "", projectUrl(id));
    } else history.pushState(state, "", projectUrl(id));
  }
  activeId = id;
  gallery = [];
  sheetTween?.kill();
  window.gsap?.set(sheet, { clearProps: "transform,opacity,visibility" });
  $("#project-modal-title").textContent =
    opener?.querySelector(".card-title")?.textContent || "作品详情";
  loadingState();
  modalScroll.scrollTo({ top: 0, behavior: "instant" });
  try {
    let data = cache.get(id);
    if (!data || retry) {
      const response = await fetch(
        new URL(`data/projects/${id}.json`, siteRoot),
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error("Project unavailable");
      data = await response.json();
      if (
        data.id !== id ||
        typeof data.html !== "string" ||
        typeof data.title !== "string"
      )
        throw new Error("Invalid project");
      cache.set(id, data);
    }
    if (controller.signal.aborted || activeId !== id || !modal.open) return;
    // HTML is generated locally from trusted Markdown with raw HTML disabled.
    sheet.innerHTML = data.html;
    normalizeFragmentLinks();
    sheet.setAttribute("aria-busy", "false");
    $("#project-modal-title").textContent = data.title;
    document.title = `${data.title} — ${baseTitle}`;
    gallery = [...sheet.querySelectorAll(".gallery-image")];
    if (window.gsap && !reducedMotion.matches) {
      sheetTween = window.gsap.fromTo(
        sheet,
        { y: 18, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.4,
          ease: "power3.out",
          clearProps: "transform,opacity",
        },
      );
    }
  } catch (error) {
    if (controller.signal.aborted || activeId !== id) return;
    sheet.setAttribute("aria-busy", "false");
    const message = document.createElement("div");
    message.className = "project-message";
    const title = document.createElement("p");
    title.textContent = "作品暂时未能加载，请重试。";
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.dataset.retry = "true";
    retryButton.textContent = "重新加载";
    message.append(title, retryButton);
    sheet.replaceChildren(message);
  }
}
function hideProject() {
  sheet.querySelectorAll('video,audio').forEach(media => media.pause());
  if (!modal.open) return;
  request?.abort();
  sheetTween?.kill();
  if (viewer.open) viewer.close();
  modal.close();
  window.dispatchEvent(new Event("portfolio:overlaychange"));
  document.documentElement.classList.remove("project-open");
  activeId = null;
  gallery = [];
  sheet.replaceChildren();
  document.title = baseTitle;
  window.scrollTo({ top: backgroundScroll, behavior: "instant" });
  const focusTarget =
    returnFocus?.isConnected && !returnFocus.hidden
      ? returnFocus
      : filters.querySelector('[aria-pressed="true"]');
  focusTarget?.focus({ preventScroll: true });
}
function requestClose() {
  if (history.state?.portfolioModal === siteRoot.pathname) history.back();
  else {
    history.replaceState(null, "", siteRoot);
    hideProject();
  }
}
closeButton.addEventListener("click", requestClose);
modal.addEventListener("cancel", (event) => {
  event.preventDefault();
  requestClose();
});
let backdropDown = false;
modal.addEventListener("pointerdown", (event) => {
  backdropDown = !event.target.closest(".project-sheet, .project-close");
});
modal.addEventListener("click", (event) => {
  if (backdropDown && !event.target.closest(".project-sheet, .project-close"))
    requestClose();
  backdropDown = false;
});
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-project-id]");
  if (
    !link ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  openProject(link.dataset.projectId, link, true);
});
sheet.addEventListener("click", (event) => {
  if (event.target.closest("[data-retry]"))
    openProject(activeId, null, false, true);
  const imageButton = event.target.closest(".gallery-image");
  if (!imageButton) return;
  activeImage = gallery.indexOf(imageButton);
  if (activeImage < 0) return;
  imageReturnFocus = imageButton;
  zoom = 1;
  viewer.showModal();
  $("#viewer-close").focus({ preventScroll: true });
  updateImage();
});
function syncRoute() {
  const id = routeId();
  if (id) openProject(id);
  else hideProject();
}
window.addEventListener("popstate", syncRoute);
window.addEventListener("hashchange", syncRoute);
const initialId = routeId() || document.body.dataset.initialProject;
if (initialId && /^[a-z][a-z0-9-]*$/.test(initialId)) {
  history.replaceState(null, "", projectUrl(initialId));
  openProject(initialId);
}

function updateZoom() {
  const source = gallery[activeImage]?.querySelector("img");
  if (!source) return;
  const width = viewerCanvas.clientWidth || innerWidth;
  const height = viewerCanvas.clientHeight || innerHeight;
  const originalWidth = Number(source.getAttribute("width"));
  const originalHeight = Number(source.getAttribute("height"));
  const fittedWidth = Math.min(
    originalWidth,
    Math.max(80, width - (innerWidth < 600 ? 32 : 96)),
    (Math.max(80, height - 128) * originalWidth) / originalHeight,
  );
  const maxX = Math.max(0, (fittedWidth * zoom - width) / 2);
  const maxY = Math.max(
    0,
    (((fittedWidth * originalHeight) / originalWidth) * zoom - height) / 2,
  );
  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));
  viewerImage.style.width = `${fittedWidth}px`;
  viewerImage.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${zoom})`;
  viewerCanvas.classList.toggle("can-pan", maxX > 0 || maxY > 0);
}
function updateImage() {
  const image = gallery[activeImage]?.querySelector("img");
  if (!image) return;
  viewerImage.src = image.currentSrc || image.src;
  viewerImage.alt = image.alt;
  $("#viewer-label").textContent =
    `${$("#project-modal-title").textContent} · ${activeImage + 1} / ${gallery.length}`;
  panX = panY = 0;
  imageDrag = null;
  viewerCanvas.classList.remove("is-dragging");
  updateZoom();
  viewerCanvas.scrollTo({ top: 0, left: 0, behavior: "instant" });
}
function changeImage(direction) {
  const next = activeImage + direction;
  if (next < 0 || next >= gallery.length) return;
  activeImage = next;
  zoom = 1;
  updateImage();
}
$("#viewer-close").addEventListener("click", () => viewer.close());
viewer.addEventListener("close", () => {
  imageDrag = null;
  viewerCanvas.classList.remove("is-dragging");
  if (imageReturnFocus?.isConnected)
    imageReturnFocus.focus({ preventScroll: true });
});
viewer.addEventListener("cancel", (event) => {
  event.preventDefault();
  viewer.close();
});
viewerCanvas.addEventListener(
  "wheel",
  (event) => {
    if (!viewer.open) return;
    event.preventDefault();
    const delta =
      event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? viewerCanvas.clientHeight || innerHeight
          : 1);
    const nextZoom = Math.max(
      0.25,
      Math.min(
        8,
        zoom * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.0015),
      ),
    );
    const bounds = viewerCanvas.getBoundingClientRect();
    const x =
      event.clientX -
      bounds.left -
      (viewerCanvas.clientWidth || innerWidth) / 2;
    const y =
      event.clientY -
      bounds.top -
      (viewerCanvas.clientHeight || innerHeight) / 2;
    const ratio = nextZoom / zoom;
    panX = x - (x - panX) * ratio;
    panY = y - (y - panY) * ratio;
    zoom = nextZoom;
    updateZoom();
  },
  { passive: false },
);
viewer.addEventListener("pointerdown", (event) => {
  viewerBlankDown = !event.target.closest("#viewer-img, #viewer-close");
  viewerDragged = false;
});
viewerCanvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  imageDrag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX,
    panY,
  };
  viewerCanvas.setPointerCapture?.(event.pointerId);
});
viewerCanvas.addEventListener("pointermove", (event) => {
  if (!imageDrag || event.pointerId !== imageDrag.pointerId) return;
  const dx = event.clientX - imageDrag.x,
    dy = event.clientY - imageDrag.y;
  if (Math.hypot(dx, dy) > 4) viewerDragged = true;
  if (!viewerDragged || !viewerCanvas.classList.contains("can-pan")) return;
  panX = imageDrag.panX + dx;
  panY = imageDrag.panY + dy;
  viewerCanvas.classList.add("is-dragging");
  updateZoom();
});
function endImageDrag(event) {
  if (imageDrag?.pointerId !== event.pointerId) return;
  if (viewerCanvas.hasPointerCapture?.(event.pointerId))
    viewerCanvas.releasePointerCapture(event.pointerId);
  imageDrag = null;
  viewerCanvas.classList.remove("is-dragging");
}
viewerCanvas.addEventListener("pointerup", endImageDrag);
viewerCanvas.addEventListener("pointercancel", (event) => {
  viewerDragged = true;
  endImageDrag(event);
});
viewer.addEventListener("click", (event) => {
  if (
    viewerBlankDown &&
    !viewerDragged &&
    !event.target.closest("#viewer-img, #viewer-close")
  )
    viewer.close();
  viewerBlankDown = false;
});
viewer.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
    event.preventDefault();
    changeImage(["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1);
  }
});
window.addEventListener("resize", () => {
  if (viewer.open) updateZoom();
});
const backTop = $("#back-top");
function updateBackTop() {
  backTop.hidden = window.scrollY < 180;
}
window.addEventListener("scroll", updateBackTop, { passive: true });
updateBackTop();
backTop.addEventListener("click", () =>
  window.scrollTo({
    top: 0,
    behavior: reducedMotion.matches ? "instant" : "smooth",
  }),
);
document.querySelectorAll("[data-copy-value]").forEach((button) => {
  const label = button.querySelector(".contact-label");
  const initialLabel = label.textContent;
  let feedbackTimer;
  button.addEventListener("click", async () => {
    const { copyValue, copyLabel } = button.dataset;
    clearTimeout(feedbackTimer);
    try {
      await navigator.clipboard.writeText(copyValue);
      label.textContent = "已复制";
      $("#contact-status").textContent = `${copyLabel}已复制：${copyValue}`;
    } catch {
      label.textContent = "请手动复制";
      $("#contact-status").textContent = `${copyLabel}：${copyValue}`;
    }
    feedbackTimer = setTimeout(() => {
      label.textContent = initialLabel;
    }, 1800);
  });
});
document.addEventListener(
  "error",
  (event) => {
    if (event.target.tagName === "IMG") {
      event.target.classList.add("image-failed");
      event.target.title = "图片未加载成功，请刷新后重试";
    }
  },
  true,
);

initHeroVideo({ reducedMotion, isBlocked: () => modal.open });

// Resolve anchors after the first masonry layout, including shared projects.
let initialHomeTarget = ["#works", "#contact"].includes(location.hash)
  ? location.hash
  : new URL(location.href).searchParams.has("work") ? "#works" : null;
window.addEventListener("portfolio:layout", () => {
  if (!initialHomeTarget) return;
  const target = document.querySelector(initialHomeTarget);
  initialHomeTarget = null;
  if (!target) return;
  const top = target.getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top, behavior: "instant" });
  if (modal.open) backgroundScroll = top;
});

if (window.gsap) {
  const gsap = window.gsap;
  const media = gsap.matchMedia();
  media.add("(prefers-reduced-motion: no-preference)", () => {
    let cardsTween;
    const animate = (event) => {
      if (!event.detail.animate) return;
      cardsTween?.kill();
      gsap.set(".project-card .card-image", {
        clearProps: "transform,opacity",
      });
      cardsTween = gsap.fromTo(
        cards
          .filter((card) => !card.hidden)
          .map((card) => card.firstElementChild),
        { y: 14, opacity: 0 },
        {
          y: 0,
          opacity: 1,
          duration: 0.55,
          stagger: 0.025,
          ease: "power3.out",
          clearProps: "transform,opacity",
        },
      );
    };
    window.addEventListener("portfolio:layout", animate);
    return () => {
      window.removeEventListener("portfolio:layout", animate);
      cardsTween?.kill();
      gsap.set(".project-card .card-image", {
        clearProps: "transform,opacity",
      });
    };
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) {
      sheetTween?.kill();
      gsap.set(sheet, { clearProps: "transform,opacity,visibility" });
    }
  });
}
